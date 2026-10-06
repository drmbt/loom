import { describe, expect, it, vi } from "vitest";
import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { MediaSourceFrame } from "../backend-types.ts";
import { wgsl } from "../wgsl.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

const input: FrameInputs = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 30, frameIndex: 0, mode: "offline", randomSeed: 1 },
  pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64],
};
function plan(outputSize: readonly [number, number] = [64, 64]): LogicalExecutionPlan {
  return {
    resources: [
      { kind: "externalTexture", id: "media", sourceId: "video", size: outputSize, format: "rgba8unorm" },
      { kind: "sampler", id: "sampler", filter: "nearest" },
      { kind: "target", id: "out", size: outputSize, format: "rgba8unorm" },
    ],
    passes: [{
      kind: "effect", id: "copy", target: "out",
      shader: wgsl`@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return textureSampleLevel(image, s, uv, 0.0); }`,
      samplers: [{ binding: "s", resourceId: "sampler" }],
      textures: [{ binding: "image", resourceId: "media" }],
    }], diagnostics: [],
  };
}

async function setup() {
  const host = mockGpuHost();
  const wrappers = new Map<GPUTexture, { destroy(): void }>();
  const createSession = host.create.bind(host);
  vi.spyOn(host, "create").mockImplementation(async options => {
    const session = await createSession(options);
    const create = session.gpu.device.createTexture.bind(session.gpu.device);
    vi.spyOn(session.gpu.device, "createTexture").mockImplementation(descriptor => {
      const texture = create(descriptor);
      vi.spyOn(texture, "destroy");
      wrappers.set(texture.gpu, texture);
      return texture;
    });
    return session;
  });
  const backend = createVgpuBackend({ host });
  await backend.initialize({});
  const device = host.device;
  if (device === undefined) throw new Error("Mock device not initialized");
  const copy = vi.fn<GPUQueue["copyExternalImageToTexture"]>();
  Object.defineProperty(device.queue, "copyExternalImageToTexture", { configurable: true, value: copy });
  const allocations = vi.spyOn(device, "createTexture");
  const bindings = vi.spyOn(device, "createBindGroup");
  let current: MediaSourceFrame | undefined;
  const source = { currentFrame: () => current };
  backend.registerMediaSource("video", source);
  return { backend, device, copy, allocations, bindings, wrappers, source, set(frame: MediaSourceFrame) { current = frame; } };
}

describe("decoded source extent is separate from media output extent", () => {
  it("adopts a delayed first frame at the realtime prelude without allocating during encode", async () => {
    vi.useFakeTimers();
    const f = await setup();
    try {
      const compiled = await f.backend.compile(plan());
      const loop = f.backend.loop(() => f.backend.render(compiled, input), { scheduler: "timer", fps: 30 });
      await vi.advanceTimersByTimeAsync(34);
      expect(f.copy).not.toHaveBeenCalled();
      f.set({ frameId: 1, image: { videoWidth: 512, videoHeight: 288 } });
      await vi.advanceTimersByTimeAsync(34);
      loop.stop();
      expect(f.copy.mock.calls[0]?.[2]).toEqual({ width: 512, height: 288 });
      expect(f.backend.status.framesSubmitted).toBe(2);
    } finally { f.backend.dispose(); vi.useRealTimers(); }
  });

  it("VNB13: a bottom-first frame (a Syphon surface) is flipped on the copy itself; a top-first one is not", async () => {
    const f = await setup();
    try {
      const compiled = await f.backend.compile(plan());
      const image = { videoWidth: 64, videoHeight: 64 };
      f.set({ frameId: 1, image, flipY: true });
      f.backend.render(compiled, input);
      expect(f.copy.mock.calls[0]?.[0]).toEqual({ source: image, flipY: true });
      f.set({ frameId: 2, image });
      f.backend.render(compiled, input);
      expect(f.copy.mock.calls[1]?.[0]).toEqual({ source: image, flipY: false });
    } finally { f.backend.dispose(); }
  });

  it("copies the full 5184×2880 video instead of cropping to a smaller output, and reuses it", async () => {
    const f = await setup();
    try {
      const compiled = await f.backend.compile(plan([1920, 1080]));
      f.set({ frameId: 1, image: { videoWidth: 5184, videoHeight: 2880, width: 1920, height: 1080 } });
      f.backend.render(compiled, input);
      expect(f.copy.mock.calls[0]?.[2]).toEqual({ width: 5184, height: 2880 });
      const sourceTexture = f.copy.mock.calls[0]?.[1].texture;
      expect(sourceTexture).toMatchObject({ width: 5184, height: 2880 });
      expect(f.allocations.mock.results.some(result => result.value.width === 1920 && result.value.height === 1080)).toBe(true);
      expect(f.backend.status.estimatedResourceBytes).toBe((1920 * 1080 + 5184 * 2880) * 4);
      const allocations = f.allocations.mock.calls.length;
      const bindGroups = f.bindings.mock.calls.length;
      f.backend.render(compiled, input);
      expect(f.copy).toHaveBeenCalledTimes(1);
      f.set({ frameId: 2, image: { videoWidth: 5184, videoHeight: 2880 } });
      f.backend.render(compiled, input);
      expect(f.copy).toHaveBeenCalledTimes(2);
      expect(f.copy.mock.calls[1]?.[1].texture).toBe(sourceTexture);
      expect(f.allocations).toHaveBeenCalledTimes(allocations);
      expect(f.bindings).toHaveBeenCalledTimes(bindGroups);
    } finally { f.backend.dispose(); }
  });

  it("destroys and rebinds source storage on intrinsic resize or replacement with a reset frame id", async () => {
    const f = await setup();
    try {
      const compiled = await f.backend.compile(plan());
      f.set({ frameId: 1, image: { width: 128, height: 72 } });
      f.backend.render(compiled, input);
      const first = f.copy.mock.calls[0]![1].texture;
      // Core deliberately suppresses raw GPUTexture.destroy on mocks; assert its wrapper lifecycle.
      const destroy = f.wrappers.get(first)?.destroy;
      const binds = f.bindings.mock.calls.length;
      f.backend.registerMediaSource("video", { currentFrame: () => ({ frameId: 1, image: { displayWidth: 256, displayHeight: 144, codedWidth: 300, codedHeight: 200 } }) });
      f.backend.render(compiled, input);
      expect(destroy).toHaveBeenCalledOnce();
      expect(f.copy.mock.calls[1]?.[2]).toEqual({ width: 256, height: 144 });
      expect(f.copy.mock.calls[1]?.[1].texture).not.toBe(first);
      expect(f.bindings.mock.calls.length).toBeGreaterThan(binds);
      const allocations = f.allocations.mock.calls.length;
      f.backend.registerMediaSource("video", { currentFrame: () => ({ frameId: 1, image: { width: 256, height: 144 } }) });
      f.backend.render(compiled, input);
      expect(f.copy).toHaveBeenCalledTimes(3);
      expect(f.copy.mock.calls[2]?.[1].texture).toBe(f.copy.mock.calls[1]?.[1].texture);
      expect(f.allocations).toHaveBeenCalledTimes(allocations);
    } finally { f.backend.dispose(); }
  });

  it("keeps full source pixels when Common recompiles a different output resolution", async () => {
    const f = await setup();
    try {
      f.set({ frameId: 1, image: { naturalWidth: 512, naturalHeight: 288, width: 20, height: 20 } });
      const first = await f.backend.compile(plan());
      f.backend.render(first, input);
      const second = await f.backend.compile(plan([32, 18]));
      f.backend.render(second, input);
      expect(f.copy.mock.calls.map(call => call[2])).toEqual([
        { width: 512, height: 288 }, { width: 512, height: 288 },
      ]);
      expect(f.backend.status.estimatedResourceBytes).toBe((512 * 288 + 32 * 18) * 4);
    } finally { f.backend.dispose(); }
  });

  it("keeps byte payloads on their authored extent when replacing an image source", async () => {
    const f = await setup();
    try {
      const compiled = await f.backend.compile(plan());
      f.set({ frameId: 1, image: { width: 128, height: 72 } });
      f.backend.render(compiled, input);
      const write = vi.spyOn(f.device.queue, "writeTexture");
      f.backend.registerMediaSource("video", { currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(64 * 64 * 4) }) });
      f.backend.render(compiled, input);
      expect(write.mock.calls[0]?.[3]).toEqual({ width: 64, height: 64 });
      expect(f.backend.status.estimatedResourceBytes).toBe(2 * 64 * 64 * 4);
    } finally { f.backend.dispose(); }
  });

  it("reports hardware oversize once and never copies a cropped substitute", async () => {
    const f = await setup();
    try {
      const notices: string[] = [];
      f.backend.onDiagnostic(diagnostic => { notices.push(diagnostic.message); });
      const compiled = await f.backend.compile(plan());
      const width = f.device.limits.maxTextureDimension2D + 1;
      f.set({ frameId: 1, image: { width, height: 64 } });
      const allocations = f.allocations.mock.calls.length;
      f.backend.render(compiled, input);
      f.backend.render(compiled, input);
      expect(f.copy).not.toHaveBeenCalled();
      expect(f.allocations).toHaveBeenCalledTimes(allocations);
      expect(notices.filter(message => message.includes("above this device's"))).toHaveLength(1);
      f.set({ frameId: 1, image: { width: 128, height: 72 } });
      f.backend.render(compiled, input);
      expect(f.copy).toHaveBeenCalledOnce();
    } finally { f.backend.dispose(); }
  });
});
