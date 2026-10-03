import { describe, expect, it, vi } from "vitest";
import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { wgsl } from "../wgsl.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

function plan(optional: boolean): LogicalExecutionPlan {
  return {
    resources: [{ kind: "buffer", id: "data", usage: "storage", stride: 4, capacity: 4 }],
    passes: [{
      kind: "dispatch", id: "kernel", entryPoint: "main", workgroups: [1, 1, 1],
      shader: wgsl`struct Params {
  timeSeconds: f32, deltaSeconds: f32, frameIndex: u32,
  ${optional ? "pointer: vec4f, absTimeSeconds: f32, absFrameIndex: u32, firstRun: u32," : ""}
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(1) fn main() { data[0] = params.timeSeconds; }`,
      buffers: [{ binding: "data", resourceId: "data" }],
      uniformBinding: "params",
      uniforms: {
        timeSeconds: 0, deltaSeconds: 0, frameIndex: 0,
        ...(optional ? { pointer: [0, 0, 0, 0], absTimeSeconds: 0, absFrameIndex: 0, firstRun: 0 } : {}),
      },
    }],
    diagnostics: [],
  };
}

const inputs: FrameInputs = {
  frame: {
    timeSeconds: 3, deltaSeconds: 0.25, frameIndex: 7, mode: "offline", randomSeed: 7,
    absTimeSeconds: 11, absFrameIndex: 25,
  },
  pointer: { x: 0.25, y: 0.5, buttons: 1 },
  resolution: [64, 64],
};

describe("dispatch frame uniform contract", () => {
  it.each([false, true])("writes declared frame fields with optional members=%s", async (optional) => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan(optional));
      if (host.device === undefined) throw new Error("No mock device");
      const writes = vi.spyOn(host.device.queue, "writeBuffer");
      backend.render(compiled, inputs);
      const payload = writes.mock.calls[0]?.[2];
      if (payload === undefined) throw new Error("No uniform write");
      const bytes = ArrayBuffer.isView(payload)
        ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        : new DataView(payload);
      expect(bytes.getFloat32(0, true)).toBe(3);
      expect(bytes.getFloat32(4, true)).toBe(0.25);
      expect(bytes.getUint32(8, true)).toBe(7);
      if (optional) {
        expect(bytes.getFloat32(16, true)).toBe(0.25);
        expect(bytes.getFloat32(20, true)).toBe(0.5);
        expect(bytes.getFloat32(24, true)).toBe(1);
        expect(bytes.getFloat32(32, true)).toBe(11);
        expect(bytes.getUint32(36, true)).toBe(25);
        expect(bytes.getUint32(40, true)).toBe(1);
        backend.render(compiled, { ...inputs, frame: { ...inputs.frame, frameIndex: 8 } });
        const nextPayload = writes.mock.calls[1]?.[2];
        if (nextPayload === undefined) throw new Error("No second uniform write");
        const nextBytes = ArrayBuffer.isView(nextPayload)
          ? new DataView(nextPayload.buffer, nextPayload.byteOffset, nextPayload.byteLength)
          : new DataView(nextPayload);
        expect(nextBytes.getUint32(40, true)).toBe(0);
      }
      // Authored unknown keys still reject. Only backend-generated frame values are selected.
      expect(() => backend.updateUniforms({ passId: "kernel", values: { misspelled: 1 } }))
        .toThrow(/misspelled.*not declared/);
      expect(() => backend.render(compiled, inputs)).not.toThrow();
    } finally {
      backend.dispose();
    }
  });
});
