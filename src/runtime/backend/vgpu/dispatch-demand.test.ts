import { describe, expect, it, vi } from "vitest";
import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { wgsl } from "../wgsl.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

const input: FrameInputs = {
  frame: { timeSeconds: 3, deltaSeconds: 1 / 60, frameIndex: 12, mode: "realtime", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64],
};

function plan(indirect: boolean, repeated = false): LogicalExecutionPlan {
  const dispatch = (id: string) => ({
    kind: "dispatch", id, entryPoint: "main",
    workgroups: indirect ? { indirect: "counts" } : [1, 1, 1],
    shader: wgsl`@compute @workgroup_size(1) fn main() {}`,
  });
  return {
    resources: indirect ? [{ kind: "buffer", id: "counts", usage: "indirect", stride: 4, capacity: 3 }] : [],
    passes: repeated ? [
      { kind: "loop", id: "begin", loopId: "repeat", edge: "begin", count: 3 },
      dispatch("input"),
      { kind: "loop", id: "end", loopId: "repeat", edge: "end" },
    ] : [dispatch("input"), dispatch("neighbor")],
    diagnostics: [],
  };
}

describe("CPU consumer dispatch demand", () => {
  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])("skips only unused work, indirect=%s open frame=%s", async (indirect, open) => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan(indirect));
      if (host.device === undefined) throw new Error("No mock device");
      let dispatches = 0;
      const createEncoder = host.device.createCommandEncoder.bind(host.device);
      vi.spyOn(host.device, "createCommandEncoder").mockImplementation((descriptor) => {
        const encoder = createEncoder(descriptor);
        const begin = encoder.beginComputePass.bind(encoder);
        vi.spyOn(encoder, "beginComputePass").mockImplementation((passDescriptor) => {
          dispatches += 1;
          return begin(passDescriptor);
        });
        return encoder;
      });
      const spans: string[] = [];
      backend.onCpuTimings((values) => spans.push(...Object.keys(values)));
      const gate = vi.fn<(frame: FrameInputs["frame"]) => boolean>(() => false);
      const unregister = backend.registerDispatchGate("input", gate);
      const render = () => backend.render(compiled, input);
      if (open) {
        vi.useFakeTimers();
        const loop = backend.loop(render, { scheduler: "timer", fps: 60 });
        vi.advanceTimersByTime(17);
        loop.stop();
      } else render();
      expect(gate).toHaveBeenCalledOnce();
      expect(gate.mock.calls[0]?.[0]).toBe(input.frame);
      expect(dispatches).toBe(1);
      expect(spans).toEqual(["neighbor"]);

      gate.mockReturnValue(true);
      render();
      expect(dispatches).toBe(3);
      expect(spans.slice(1)).toEqual(["input", "neighbor"]);
      unregister();
      render();
      expect(dispatches).toBe(5);
      expect(gate).toHaveBeenCalledTimes(2);
    } finally {
      backend.dispose();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("retains replacement owners across compile and device recovery, including loop occurrences", async () => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    try {
      // Registration before compile is supported, just as media registration is.
      const old = backend.registerDispatchGate("input", () => true);
      const gate = vi.fn(() => false);
      const current = backend.registerDispatchGate("input", gate);
      old();
      await backend.initialize({});
      const compiled = await backend.compile(plan(false, true));
      const spans: string[] = [];
      backend.onCpuTimings((values) => spans.push(...Object.keys(values)));
      backend.render(compiled, input);
      expect(gate).toHaveBeenCalledTimes(3);
      expect(spans).toEqual([]);
      await backend.compile(plan(false, true));
      host.loseDevice();
      await Promise.resolve();
      await backend.whenSettled();
      backend.render(compiled, input);
      expect(gate).toHaveBeenCalledTimes(6);
      current();
      backend.render(compiled, input);
      expect(spans).toEqual(["input", "input~1", "input~2"]);
    } finally {
      backend.dispose();
    }
  });
});

it.each([false, true])("reports sampled texture provenance, open frame=%s", async open => {
  const backend = createVgpuBackend({ host: mockGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile({
      resources: [{ kind: "target", id: "picture", size: [4, 4], format: "rgba8unorm" }],
      passes: [
        { kind: "effect", id: "source", target: "picture", shader: wgsl`
          @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }` },
        { kind: "dispatch", id: "preprocess", entryPoint: "main", workgroups: [1, 1, 1],
          textures: [{ binding: "inputTexture", resourceId: "picture" }], shader: wgsl`
          @group(0) @binding(0) var inputTexture: texture_2d<f32>;
          @compute @workgroup_size(1) fn main() {}` },
      ], diagnostics: [],
    });
    const gate = vi.fn(() => false);
    backend.registerDispatchGate("preprocess", gate);
    const frames = [
      { ...input, frame: { ...input.frame, frameIndex: 20, absTimeSeconds: 10 } },
      { ...input, frame: { ...input.frame, frameIndex: 1, absTimeSeconds: 10.1 } },
      { ...input, frame: { ...input.frame, frameIndex: 4, absTimeSeconds: 10.2 } },
      { ...input, frame: { ...input.frame, frameIndex: 0, absTimeSeconds: 10.3 } },
    ];
    let next = 0;
    const render = () => backend.render(compiled, frames[next++]!);
    if (open) {
      vi.useFakeTimers();
      const loop = backend.loop(render, { scheduler: "timer", fps: 60 });
      vi.advanceTimersByTime(34);
      loop.stop();
    } else { render(); render(); }
    expect(gate).toHaveBeenCalledTimes(2);
    const timings = gate.mock.calls as unknown as Array<[unknown, { renderIndex: number; source: unknown }]>;
    expect(timings[0]?.[1]).toEqual({ renderIndex: 1, source: open ? undefined :
      { renderIndex: 1, frameIndex: 20, timeSeconds: 10 } });
    expect(timings[1]?.[1]).toEqual({ renderIndex: 2, source: open ?
      { renderIndex: 1, frameIndex: 20, timeSeconds: 10 } :
      { renderIndex: 2, frameIndex: 1, timeSeconds: 10.1 } });
    for (const invalidate of [() => backend.resize("picture", [4, 4]),
      () => backend.resetTemporalHistory(undefined, { buffers: true })]) {
      invalidate();
      if (open) {
        const loop = backend.loop(render, { scheduler: "timer", fps: 60 });
        vi.advanceTimersByTime(17);
        loop.stop();
      } else render();
      const timing = timings.at(-1)?.[1];
      expect(timing?.source).toEqual(open ? undefined : {
        renderIndex: next, frameIndex: frames[next - 1]!.frame.frameIndex,
        timeSeconds: frames[next - 1]!.frame.absTimeSeconds,
      });
    }
  } finally {
    backend.dispose();
    vi.useRealTimers();
  }
});


it("stamps an immediately submitted indirect draw before demanded preprocessing", async () => {
  const backend = createVgpuBackend({ host: mockGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile({ resources: [
      { kind: "target", id: "picture", size: [4, 4], format: "rgba8unorm" },
      { kind: "buffer", id: "counts", usage: "indirect", stride: 4, capacity: 4 },
    ], passes: [
      { kind: "draw", id: "draw", target: "picture", topology: "triangle-list", vertexCount: 3,
        instances: { indirect: "counts" }, shader: wgsl`
          @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
          @fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }` },
      { kind: "dispatch", id: "preprocess", entryPoint: "main", workgroups: [1, 1, 1],
        textures: [{ binding: "inputTexture", resourceId: "picture" }], shader: wgsl`
          @group(0) @binding(0) var inputTexture: texture_2d<f32>;
          @compute @workgroup_size(1) fn main() {}` },
    ], diagnostics: [] });
    const gate = vi.fn(() => false);
    backend.registerDispatchGate("preprocess", gate);
    vi.useFakeTimers();
    const loop = backend.loop(() => backend.render(compiled, input), { scheduler: "timer", fps: 60 });
    vi.advanceTimersByTime(17);
    loop.stop();
    expect(gate).toHaveBeenCalledWith(input.frame, { renderIndex: 1,
      source: { renderIndex: 1, frameIndex: 12, timeSeconds: 3 } });
  } finally { backend.dispose(); vi.useRealTimers(); }
});
