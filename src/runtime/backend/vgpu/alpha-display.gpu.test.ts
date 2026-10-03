import { expect, it } from "vitest";
import { compileGraph } from "../../../compiler/compile.ts";
import { DEFAULT_PROJECT_SETTINGS, type GraphDocument } from "../../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { buildPreviewProgram } from "../../previews/program.ts";
import { createTileAtlas } from "../../previews/tile-atlas.ts";
import { DEFAULT_PREVIEW_VIEW, type PreviewRequest } from "../../previews/types.ts";
import { decodeHalf } from "../../export/pixel-format.ts";
import { wgsl } from "../wgsl.ts";
import type { GpuSession } from "./gpu-host.ts";
import { nodeGpuHost } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

interface StubCanvas {
  width: number;
  height: number;
  getContext(kind: string): unknown;
  readonly texture: () => GPUTexture | undefined;
  readonly format: () => string;
  readonly alphaMode: () => string;
}

/** A canvas the way vgpu's `surface()` uses one — same shape as present-parity's. */
function stubCanvas(device: GPUDevice, width: number, height: number): StubCanvas {
  let texture: GPUTexture | undefined;
  let format = "bgra8unorm";
  let alphaMode = "";
  const canvas: StubCanvas = {
    width,
    height,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(config: { format: string; alphaMode: string }) {
          alphaMode = config.alphaMode;
          format = config.format;
          texture?.destroy();
          texture = device.createTexture({
            size: [canvas.width, canvas.height],
            format: format as GPUTextureFormat,
            usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC,
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          return texture;
        },
      };
    },
    texture: () => texture,
    format: () => format,
    alphaMode: () => alphaMode,
  };
  return canvas;
}

async function readTexture(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_MODE_READ);
  const mapped = new Uint8Array(buffer.getMappedRange()).slice();
  buffer.unmap();
  buffer.destroy();
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  }
  return out;
}


// One16x16 source frame, four viewer surfaces and four tiny preview submissions.
// Negative/overflow alpha is arithmetic data. Only [0,1] denotes display coverage.
it("shows coverage on actual viewer and preview surfaces without changing exported alpha", async () => {
  const size = 16;
  const graph: GraphDocument = { revision: 1, groups: {}, nodes: {
    solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [1, 0, 0, 1] } },
    out: { id: "out", type: "output", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
  }, edges: { e: { id: "e", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "out", portId: "input" } } } };
  const capabilities: BackendCapabilities = { tier: "B", features: [], formats: ["rgba8unorm", "rgba16float"],
    timestampQuery: false, limits: { maxTextureDimension2D: 8192 } };
  const basePlan = compileGraph({ graph, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities,
    settings: { ...DEFAULT_PROJECT_SETTINGS, workingFormat: "rgba16float", outputResolution: { width: size, height: size } } });
  const plan = { ...basePlan, passes: basePlan.passes.map(pass => pass.kind === "effect" && pass.nodeId === "solid"
    ? { ...pass, shader: wgsl`struct Params { color: vec4f }; @group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs(@builtin(position) fragment: vec4f) -> @location(0) vec4f {
  let band = min(u32(fragment.x) / 3u, 4u);
  let alpha = array<f32, 5>(-1.0, 0.0, 0.5, 1.0, 2.0);
  return vec4f(params.color.rgb, alpha[band]);
}` } : pass) };
  expect(plan.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  let session: GpuSession | undefined;
  const host = nodeGpuHost();
  const backend = createVgpuBackend({ host: { label: host.label, async create(options) {
    session = await host.create(options); return session;
  } } });
  const errors: string[] = [];
  backend.onDiagnostic(d => { if (d.severity === "error") errors.push(d.message); });
  const canvases: StubCanvas[] = [];
  try {
    await backend.initialize({});
    if (session === undefined) throw new Error("No GPU session");
    const device = session.gpu.gpu as GPUDevice;
    const compiled = await backend.compile(plan);
    const output = plan.outputs.find(row => row.nodeId === "out");
    const source = plan.outputs.find(row => row.nodeId === "solid");
    if (output === undefined || source === undefined) throw new Error("Fixture missing output");
    const makeCanvas = () => { const canvas = stubCanvas(device, size, size); canvases.push(canvas); return canvas; };
    const coverage = makeCanvas(), raw = makeCanvas(), implicitRaw = makeCanvas(), arithmetic = makeCanvas();
    backend.present(coverage as never, { outputId: output.resourceId, alphaDisplay: "rgba" });
    backend.present(raw as never, { outputId: output.resourceId, alphaDisplay: "rgb" });
    backend.present(implicitRaw as never, { outputId: output.resourceId });
    backend.present(arithmetic as never, { outputId: source.resourceId, alphaDisplay: "rgba" });
    backend.render(compiled, { frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 }, resolution: [size, size] });
    const read = async (canvas: StubCanvas) => {
      await device.queue.onSubmittedWorkDone();
      const texture = canvas.texture();
      if (texture === undefined) throw new Error("Surface unconfigured");
      expect(canvas.format()).toBe("bgra8unorm");
      return readTexture(device, texture, size, size);
    };
    const at = (bytes: Uint8Array, x: number, y = 2) => [...bytes.slice((y * size + x) * 4, (y * size + x + 1) * 4)];
    const encode = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    const expected = (x: number, clampAlpha: boolean) => {
      const sourceAlpha = [-1, 0, 0.5, 1, 2][Math.min(Math.floor(x / 3), 4)]!;
      // The existing Output node bounds coverage; the producer preserves arithmetic alpha.
      const a = clampAlpha ? Math.min(1, Math.max(0, sourceAlpha)) : sourceAlpha;
      if (a < 0 || a >= 1) return [0, 0, 255, 255];
      const ground = Math.floor(x / 8) % 2 ? 0.32 : 0.18;
      return [encode(ground * (1 - a)), encode(ground * (1 - a)), encode(ground * (1 - a) + a), 255];
    };
    const pixels = await read(coverage);
    for (const x of [1, 4, 7, 8, 10, 13]) expect(at(pixels, x)).toEqual(expected(x, true));
    const arithmeticPixels = await read(arithmetic);
    for (const x of [1, 4, 7, 8, 10, 13]) expect(at(arithmeticPixels, x)).toEqual(expected(x, false));
    for (const canvas of [coverage, raw, implicitRaw, arithmetic]) expect(canvas.alphaMode()).toBe("opaque");
    for (const canvas of [raw, implicitRaw]) {
      const bytes = await read(canvas);
      // The stub exposes the GPU attachment, before a browser compositor applies alphaMode.
      // Raw presentation retains payload alpha; explicit opaque configuration is checked above.
      for (const x of [1, 4, 7, 10, 13]) {
        const alpha = [0, 0, 0.5, 1, 1][Math.floor(x / 3)]!;
        expect(at(bytes, x)).toEqual([0, 0, 255, Math.round(alpha * 255)]);
      }
    }
    for (const row of [source, output]) {
      const exported = await backend.readOutput(row.resourceId);
      const data = new DataView(exported.bytes.buffer, exported.bytes.byteOffset, exported.bytes.byteLength);
      for (const x of [1, 4, 7, 10, 13]) {
        const alpha = [-1, 0, 0.5, 1, 2][Math.floor(x / 3)]!;
        expect(decodeHalf(data.getUint16((2 * size + x) * 8 + 6, true)))
          .toBe(row === output ? Math.min(1, Math.max(0, alpha)) : alpha);
      }
    }
    // Both declared source spaces run through the real previewHost and atlas compositor.
    for (const row of [source, output]) for (const mode of ["color", "rgb"] as const) {
      const canvas = makeCanvas();
      const handle = backend.previewHost(canvas as never);
      const request: PreviewRequest = { ref: { nodeId: row.nodeId, portId: row.portId },
        source: { resourceId: row.resourceId, size: row.size, format: row.format, space: row.space },
        rect: { x: 0, y: 0, width: size, height: size }, area: { width: size, height: size },
        view: { ...DEFAULT_PREVIEW_VIEW, mode }, visible: true, collapsed: false, occluded: false, pinned: false };
      const program = buildPreviewProgram([{ ref: request.ref, request, tileSize: [size, size] }], createTileAtlas({ capacity: 1 }));
      handle.setPreviewProgram(program);
      const pass = program.passes[0];
      if (pass === undefined) throw new Error("Preview missing pass");
      handle.presentPreviews({ refresh: [pass.id], composite: [{ ref: request.ref, resourceId: pass.target,
        dest: { x: 0, y: 0, width: size, height: size } }], surface: { size: [size, size], dpr: 1 } });
      const bytes = await read(canvas);
      for (const x of [1, 4, 7, 8, 10, 13]) expect(at(bytes, x)).toEqual(mode === "color" ? expected(x, row === output) : [0, 0, 255, 255]);
      handle.dispose();
    }
    expect(errors).toEqual([]);
  } finally {
    backend.dispose();
    for (const canvas of canvases) canvas.texture()?.destroy();
  }
}, 60_000);
