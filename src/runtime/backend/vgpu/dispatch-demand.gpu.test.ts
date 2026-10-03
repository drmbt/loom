import { expect, it, vi } from "vitest";
import type { FrameInputs } from "../../../domain/types/backend.ts";
import { nodeGpuHost } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

it.each([false, true])("keeps skipped input intact while neighboring GPU work advances, open=%s", async (open) => {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((diagnostic) => {
    if (diagnostic.severity === "error") errors.push(diagnostic.message);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile({
      resources: ["input", "neighbor"].map((id) => ({
        kind: "buffer", id, usage: "storage", stride: 4, capacity: 1,
      })),
      passes: ["input", "neighbor"].map((id) => ({
        kind: "dispatch", id, entryPoint: "main", workgroups: [1, 1, 1],
        buffers: [{ binding: "value", resourceId: id }],
        uniformBinding: "params", uniforms: { frameIndex: 0 },
        shader: `struct Params { frameIndex: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> value: array<u32>;
@compute @workgroup_size(1) fn main() { value[0] = params.frameIndex; }`,
      })),
      diagnostics: [],
    });
    const inputFor = (frameIndex: number): FrameInputs => ({
      frame: { frameIndex, timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, mode: "realtime", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 }, resolution: [8, 8],
    });
    const off = backend.registerDispatchGate("input", (frame) => frame.frameIndex !== 2);
    let index = 0;
    let control: { stop(): void } | undefined;
    if (open) {
      // Drive only the scheduler; Dawn readback polling must keep its real timers.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      control = backend.loop(() => backend.render(compiled, inputFor(++index)), { scheduler: "timer", fps: 60 });
    }
    const step = async () => {
      if (open) vi.advanceTimersByTime(1000 / 60 + 0.001);
      else backend.render(compiled, inputFor(++index));
      return [
        new Uint32Array(await backend.readBuffer("input"))[0],
        new Uint32Array(await backend.readBuffer("neighbor"))[0],
      ];
    };
    expect(await step()).toEqual([1, 1]);
    expect(await step()).toEqual([1, 2]);
    expect(await step()).toEqual([3, 3]);
    off();
    expect(await step()).toEqual([4, 4]);
    control?.stop();
    expect(errors).toEqual([]);
  } finally {
    backend.dispose();
    vi.useRealTimers();
  }
}, 30_000);
