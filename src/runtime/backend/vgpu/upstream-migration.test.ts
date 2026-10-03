import { describe, expect, it, vi } from "vitest";
import { compute, frame, storage } from "vgpu";

import { mockGpuHost } from "./mock-gpu-host.ts";

const KERNEL = `@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(1) fn main() { values[0] += 1u; }`;

describe("vgpu 0.5.0 patch migration", () => {
  it("evicts compute bind groups using upstream's compute owner key", async () => {
    const host = mockGpuHost();
    const session = await host.create({});
    try {
      const values = storage(session.gpu, 4, "read-write");
      const kernel = compute(session.gpu, KERNEL, { set: { values } });
      const createBindGroup = vi.spyOn(session.gpu.gpu, "createBindGroup");
      const created = () => createBindGroup.mock.calls.length;
      kernel.dispatch(1);
      const first = created();
      expect(first).toBeGreaterThan(0);
      kernel.dispatch(1);
      expect(created()).toBe(first);
      (kernel as typeof kernel & { evictBindGroups(): void }).evictBindGroups();
      kernel.dispatch(1);
      expect(created()).toBe(first + 1);
    } finally {
      session.dispose();
    }
  });

  it("rejects a destroyed binding before reserving an external timing query", async () => {
    const session = await mockGpuHost().create({});
    try {
      const values = storage(session.gpu, 4, "read-write");
      const kernel = compute(session.gpu, KERNEL, { set: { values } });
      const currentFrame = frame(session.gpu);
      const attach = vi.spyOn(currentFrame, "attachExternalSpan");
      (values as typeof values & { destroy(): void }).destroy();
      expect(() => kernel.dispatch(1, 1, 1, { frame: currentFrame, timer: {} as never }))
        .toThrow(/destroyed/i);
      expect(attach).not.toHaveBeenCalled();
      currentFrame.cancel();
    } finally {
      session.dispose();
    }
  });
});
