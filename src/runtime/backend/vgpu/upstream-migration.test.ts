import { describe, expect, it } from "vitest";
import { compute, storage } from "vgpu";

import { mockGpuHost } from "./mock-gpu-host.ts";
import { preparedShader } from "./prepared-shader.ts";

describe("vgpu patch migration", () => {
  /**
   * T1076, carried onto 0.6.0 (T1705b): packed point storage binds several attributes of ONE
   * buffer to one kernel, each as its own range. Upstream refuses every second binding of an
   * allocation a kernel writes; the patch lets through exactly the case WebGPU allows.
   */
  it("lets a kernel write disjoint regions of one buffer, and still refuses the aliases", async () => {
    const session = await mockGpuHost().create({});
    try {
      const packed = (storage(session.gpu, 1024, "read-write") as unknown as { gpu: GPUBuffer }).gpu;
      const region = (offset: number) => ({ buffer: packed, offset, size: 256 });
      const kernel = (first: string) =>
        compute(
          session.gpu,
          preparedShader(
            `@group(0) @binding(0) var<storage, ${first}> a: array<u32>;
@group(0) @binding(1) var<storage, read_write> b: array<u32>;
@compute @workgroup_size(1) fn main() { b[0] = a[0]; }`,
            "packed",
          ),
        );

      /** The code vgpu refuses the dispatch with, or undefined when it runs. */
      const refusal = (first: string, a: number, b: number): unknown => {
        try {
          kernel(first).set({ a: region(a), b: region(b) }).dispatch(1);
          return undefined;
        } catch (error) {
          return (error as { code?: unknown }).code;
        }
      };

      expect(refusal("read_write", 0, 256)).toBeUndefined();
      // The same two writable bindings on ONE range are the alias the preflight exists for.
      expect(refusal("read_write", 0, 0)).toBe("VGPU-R1-STORAGE-ALIASING");
      // Reading one region while writing another is a whole-buffer usage conflict on a device.
      expect(refusal("read", 0, 256)).toBe("VGPU-R1-STORAGE-ALIASING");
    } finally {
      session.dispose();
    }
  });
});
