import { wgsl } from "./wgsl.ts";
import { browserGpuHost } from "./vgpu/gpu-host.ts";

export interface DepthRefinementSettings {
  readonly radius: number;
  readonly spatialSigma: number;
  readonly colorSigma: number;
}

interface Size { readonly width: number; readonly height: number }

interface RefinementOptions {
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: number, total: number, width: number, height: number) => void;
}

const COPY_SRC = 0x01;
const COPY_DST = 0x02;
const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;
const MAP_READ = 0x01;
const BUFFER_COPY_DST = 0x08;
const UNIFORM = 0x40;

const REFINEMENT_SHADER = wgsl`
struct Params {
  size: vec2u,
  radius: i32,
  spatialSigma: f32,
  colorSigma: f32,
  magnitude: f32,
  padding0: f32,
  padding1: f32,
};
@group(0) @binding(0) var inputDepth: texture_2d<f32>;
@group(0) @binding(1) var guidance: texture_2d<f32>;
@group(0) @binding(2) var outputDepth: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var<uniform> params: Params;

fn depthAt(uv: vec2f) -> f32 {
  let size = vec2i(textureDimensions(inputDepth));
  let position = uv * vec2f(size) - vec2f(0.5);
  let base = vec2i(floor(position));
  let blend = fract(position);
  let maximum = size - vec2i(1);
  // Arithmetic scaling prevents large signed finite samples overflowing the weighted sum.
  let a = textureLoad(inputDepth, clamp(base, vec2i(0), maximum), 0).r / params.magnitude;
  let b = textureLoad(inputDepth, clamp(base + vec2i(1, 0), vec2i(0), maximum), 0).r / params.magnitude;
  let c = textureLoad(inputDepth, clamp(base + vec2i(0, 1), vec2i(0), maximum), 0).r / params.magnitude;
  let d = textureLoad(inputDepth, clamp(base + vec2i(1), vec2i(0), maximum), 0).r / params.magnitude;
  return mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
}

fn colorAt(uv: vec2f) -> vec3f {
  let size = vec2i(textureDimensions(guidance));
  let position = uv * vec2f(size) - vec2f(0.5);
  let base = vec2i(floor(position));
  let blend = fract(position);
  let maximum = size - vec2i(1);
  let a = textureLoad(guidance, clamp(base, vec2i(0), maximum), 0).rgb;
  let b = textureLoad(guidance, clamp(base + vec2i(1, 0), vec2i(0), maximum), 0).rgb;
  let c = textureLoad(guidance, clamp(base + vec2i(0, 1), vec2i(0), maximum), 0).rgb;
  let d = textureLoad(guidance, clamp(base + vec2i(1), vec2i(0), maximum), 0).rgb;
  return mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= params.size)) { return; }
  let position = vec2i(invocation.xy);
  let centerUV = (vec2f(position) + vec2f(0.5)) / vec2f(params.size);
  let centerColor = colorAt(centerUV);
  var sumDepth = 0.0;
  var sumWeight = 0.0;
  for (var y = -params.radius; y <= params.radius; y += 1) {
    for (var x = -params.radius; x <= params.radius; x += 1) {
      let neighbor = position + vec2i(x, y);
      if (any(neighbor < vec2i(0)) || any(neighbor >= vec2i(params.size))) { continue; }
      let uv = (vec2f(neighbor) + vec2f(0.5)) / vec2f(params.size);
      let spaceDelta = vec2f(f32(x), f32(y)) / params.spatialSigma;
      let colorDelta = (centerColor - colorAt(uv)) / params.colorSigma;
      let weight = exp(-0.5 * dot(spaceDelta, spaceDelta)) * exp(-0.5 * dot(colorDelta, colorDelta));
      sumDepth += depthAt(uv) * weight;
      sumWeight += weight;
    }
  }
  // The center sample has weight one; the denominator is always strictly positive.
  textureStore(outputDepth, position, vec4f(sumDepth / sumWeight * params.magnitude, 0.0, 0.0, 0.0));
}
`;

function validateSize(size: Size, label: string, maximum: number): void {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1) {
    throw new Error(`${label} dimensions must be positive integers.`);
  }
  if (size.width > maximum || size.height > maximum) throw new Error(`${label} exceeds the device texture dimension limit.`);
  if (size.width * size.height > 64_000_000) throw new Error(`${label} exceeds 64 million pixels.`);
}

function validateSigma(value: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > maximum || Math.fround(value) <= 0) {
    throw new Error(`${label} must be positive, finite and representable in float32, at most ${maximum}.`);
  }
}

function stagesFor(input: Size, target: Size): readonly Size[] {
  const stages = [target];
  let next = target;
  while (next.width > input.width * 2 || next.height > input.height * 2) {
    next = { width: Math.ceil(next.width / 2), height: Math.ceil(next.height / 2) };
    stages.unshift(next);
  }
  return stages;
}

async function validated<T>(device: GPUDevice, action: () => T | Promise<T>): Promise<T> {
  device.pushErrorScope("validation");
  let result!: T;
  let failed = false;
  let cause: unknown;
  try { result = await action(); }
  catch (error) { failed = true; cause = error; }
  const error = await device.popErrorScope();
  if (error !== null) throw new Error(`Depth refinement WebGPU validation failed: ${error.message}`, { cause });
  if (failed) throw cause;
  return result;
}

/** One-shot local refinement. The caller owns the device, registration and all input arrays. */
export async function refinePhotoDepth(device: GPUDevice, input: Size & { readonly values: Float32Array },
  guidance: Size & { readonly rgba: Uint8Array }, target: Size, settings: DepthRefinementSettings,
  options: RefinementOptions = {},
): Promise<Float32Array> {
  const checkAbort = () => options.signal?.throwIfAborted();
  checkAbort();
  validateSize(input, "Native depth", device.limits.maxTextureDimension2D);
  validateSize(guidance, "Photo guidance", device.limits.maxTextureDimension2D);
  validateSize(target, "Refinement output", device.limits.maxTextureDimension2D);
  if (guidance.width !== target.width || guidance.height !== target.height) throw new Error("Photo guidance must match the refinement output dimensions.");
  if (!(input.values instanceof Float32Array) || input.values.length !== input.width * input.height) throw new Error("Native depth sample count must match its dimensions.");
  if (!(guidance.rgba instanceof Uint8Array) || guidance.rgba.length !== guidance.width * guidance.height * 4) throw new Error("Photo guidance must contain one RGBA byte pixel per sample.");
  if (!(input.values.buffer instanceof ArrayBuffer) || !(guidance.rgba.buffer instanceof ArrayBuffer)) throw new Error("Photo refinement requires ordinary ArrayBuffer inputs.");
  if (!Number.isInteger(settings.radius) || settings.radius < 1 || settings.radius > 4) throw new Error("Depth refinement radius must be an integer from 1 to 4.");
  validateSigma(settings.spatialSigma, 8, "Spatial sigma");
  validateSigma(settings.colorSigma, 1, "Color sigma");
  let magnitude = 1;
  for (const sample of input.values) {
    if (!Number.isFinite(sample)) throw new Error("Native depth samples must be finite.");
    magnitude = Math.max(magnitude, Math.abs(sample));
  }
  const bytesPerRow = Math.ceil(target.width * 4 / 256) * 256;
  if (bytesPerRow * target.height > device.limits.maxBufferSize) throw new Error("Depth refinement readback exceeds the device buffer size limit.");
  const textures = new Set<GPUTexture>();
  const buffers = new Set<GPUBuffer>();
  let mapped: GPUBuffer | undefined;
  const createTexture = (size: Size, format: GPUTextureFormat, usage: number) => {
    const texture = device.createTexture({ label: "Photo depth refinement", size: [size.width, size.height], format, usage });
    textures.add(texture);
    return texture;
  };
  try {
    const pipeline = await validated(device, () => device.createComputePipelineAsync({
      label: "Photo depth joint bilateral refinement", layout: "auto",
      compute: { module: device.createShaderModule({ label: "Photo depth refinement", code: REFINEMENT_SHADER }), entryPoint: "main" },
    }));
    checkAbort();
    let current: GPUTexture;
    let photo: GPUTexture;
    await validated(device, () => {
      current = createTexture(input, "r32float", TEXTURE_BINDING | COPY_DST);
      photo = createTexture(guidance, "rgba8unorm", TEXTURE_BINDING | COPY_DST);
      device.queue.writeTexture({ texture: current }, new Uint8Array(input.values.buffer as ArrayBuffer, input.values.byteOffset, input.values.byteLength),
        { bytesPerRow: input.width * 4 }, [input.width, input.height]);
      device.queue.writeTexture({ texture: photo }, new Uint8Array(guidance.rgba.buffer as ArrayBuffer, guidance.rgba.byteOffset, guidance.rgba.byteLength), { bytesPerRow: guidance.width * 4 }, [guidance.width, guidance.height]);
    });
    const stages = stagesFor(input, target);
    for (const [index, size] of stages.entries()) {
      checkAbort();
      options.onStage?.(index + 1, stages.length, size.width, size.height);
      checkAbort();
      const previous = current!;
      let output: GPUTexture;
      let uniform: GPUBuffer;
      await validated(device, async () => {
        output = createTexture(size, "r32float", STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC);
        uniform = device.createBuffer({ label: "Photo depth refinement parameters", size: 32, usage: UNIFORM | BUFFER_COPY_DST });
        buffers.add(uniform);
        const parameters = new ArrayBuffer(32);
        const view = new DataView(parameters);
        view.setUint32(0, size.width, true); view.setUint32(4, size.height, true); view.setInt32(8, settings.radius, true);
        view.setFloat32(12, settings.spatialSigma, true); view.setFloat32(16, settings.colorSigma, true); view.setFloat32(20, magnitude, true);
        device.queue.writeBuffer(uniform, 0, parameters);
        const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: previous.createView() }, { binding: 1, resource: photo!.createView() },
          { binding: 2, resource: output.createView() }, { binding: 3, resource: { buffer: uniform } },
        ] });
        const encoder = device.createCommandEncoder({ label: "Photo depth refinement stage" });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8)); pass.end();
        checkAbort();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
      });
      checkAbort();
      previous.destroy(); textures.delete(previous);
      uniform!.destroy(); buffers.delete(uniform!);
      current = output!;
    }
    checkAbort();
    let readback!: GPUBuffer;
    await validated(device, async () => {
      readback = device.createBuffer({ label: "Photo depth refinement readback", size: bytesPerRow * target.height, usage: MAP_READ | BUFFER_COPY_DST });
      buffers.add(readback);
      const encoder = device.createCommandEncoder({ label: "Photo depth refinement readback" });
      encoder.copyTextureToBuffer({ texture: current! }, { buffer: readback, bytesPerRow }, [target.width, target.height]);
      checkAbort();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    });
    checkAbort();
    await readback.mapAsync(MAP_READ);
    mapped = readback;
    checkAbort();
    const source = new Float32Array(readback.getMappedRange());
    const result = new Float32Array(target.width * target.height);
    for (let y = 0; y < target.height; y++) result.set(source.subarray(y * bytesPerRow / 4, y * bytesPerRow / 4 + target.width), y * target.width);
    for (const sample of result) if (!Number.isFinite(sample)) throw new Error("Depth refinement produced a non-finite output sample.");
    checkAbort();
    return result;
  } finally {
    mapped?.unmap();
    for (const buffer of buffers) buffer.destroy();
    for (const texture of textures) texture.destroy();
  }
}

/** Browser acquisition stays inside the backend; each preparation job releases its session. */
export async function refineBrowserPhotoDepth(input: Size & { readonly values: Float32Array },
  guidance: Size & { readonly rgba: Uint8Array }, target: Size, settings: DepthRefinementSettings,
  options: RefinementOptions = {}): Promise<Float32Array> {
  options.signal?.throwIfAborted();
  const session = await browserGpuHost().create({});
  try {
    options.signal?.throwIfAborted();
    const device = session.gpu.gpu as GPUDevice | undefined;
    if (device === undefined || typeof device.createComputePipelineAsync !== "function") {
      throw new Error("Photo depth refinement requires a native WebGPU device.");
    }
    return await refinePhotoDepth(device, input, guidance, target, settings, options);
  } finally { session.dispose(); }
}
