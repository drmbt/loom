import { describe, expect, it, vi } from "vitest";

import { createUniformAnimator } from "../../../app/animate-parameters.ts";
import type { CompiledGraph } from "../../../compiler/index.ts";
import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { planStructureSignature, readExecutionPlan } from "../plan.ts";
import { wgsl } from "../wgsl.ts";
import { countBuildsAndWrites, type DeviceBuilds } from "./device-calls.test-support.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T1623b slice 2 — WHAT A TABLE OF ROWS ASKS OF THE DEVICE, and what it never asks.
 *
 * The seam exists so that a row is a value: a named Light's place and colour, a Ramp's stops.
 * A value that changes must cost a write and nothing else, or the table has only moved the
 * recompile it was meant to remove (§B260: 37 lights were a second of pipeline creation).
 * So this counts what the backend asks of the device, on the mock host, across everything
 * that can change a row:
 *
 *  - the first frame writes the rows and their count, at the region's own bytes;
 *  - a pushed value, a values-only compile and the uniform animator each write again and
 *    create no shader module and no pipeline;
 *  - more rows within the capacity are a write; rows over it are refused by name, write
 *    nothing and leave the rows that were there;
 *  - a frame in which nothing changed writes nothing;
 *  - and the two things that empty the buffer behind the plan's back, a boundary clear and a
 *    lost device, each put the rows back.
 *
 * The values a shader reads from the region are `buffer-write.gpu.test.ts`'s, on Dawn.
 */

const input = (frameIndex: number): FrameInputs => ({
  frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [8, 8],
});

const READER = wgsl`@group(0) @binding(0) var<storage, read> table: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let at = 4u + id.x * 4u;
  out[id.x] = vec4f(bitcast<f32>(table[at]), bitcast<f32>(table[at + 1u]), bitcast<f32>(table[at + 2u]), f32(table[0]));
}`;

/** A table of up to eight vec4f rows from byte 16, its count at byte 0, and a kernel that reads it. */
function plan(rows: readonly number[], count = rows.length / 4): LogicalExecutionPlan {
  return {
    resources: [
      { kind: "buffer", id: "table", stride: 4, capacity: 36, usage: "storage-read" },
      { kind: "buffer", id: "out", stride: 16, capacity: 8, usage: "storage" },
    ],
    passes: [
      { kind: "write", id: "table:rows", resourceId: "table", offset: 16, row: ["f32", "f32", "f32", "f32"], capacity: 8, countOffset: 0, values: { rows, count } },
      { kind: "dispatch", id: "reader", entryPoint: "main", workgroups: [8, 1, 1], shader: READER, buffers: [{ binding: "table", resourceId: "table" }, { binding: "out", resourceId: "out" }] },
    ],
    diagnostics: [],
  };
}

/** Counts what is asked of the device from here on (`device-calls.test-support.ts`). */
const watch = countBuildsAndWrites;

/** The writes into the table's rows (byte 16) and its count word (byte 0) since the last call. */
function regionWrites(asked: DeviceBuilds): { rows: number[][]; counts: number[] } {
  const rows = asked.writes.filter((entry) => entry.offset === 16).map((entry) => entry.floats);
  const counts = asked.writes.filter((entry) => entry.offset === 0 && entry.words.length === 1).map((entry) => entry.words[0] as number);
  asked.writes.length = 0;
  return { rows, counts };
}

const TWO = [1, 2, 3, 4, 5, 6, 7, 8];
const THREE = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0.5, 0.25, 0.125];

describe("T1623b: a row is a value — a write, never a rebuild", () => {
  it("writes the rows and their count ahead of the first frame, and nothing on a frame where nothing changed", async () => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    try {
      await backend.initialize({});
      const asked = watch(host);
      const compiled = await backend.compile(plan(TWO));
      backend.render(compiled, input(0));
      expect(regionWrites(asked)).toEqual({ rows: [TWO], counts: [2] });
      backend.render(compiled, input(1));
      backend.render(compiled, input(2));
      expect(regionWrites(asked)).toEqual({ rows: [], counts: [] });
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("is no command buffer of its own: a frame with a table submits what the same frame submits without one", async () => {
    /* A pass that encodes nothing must not split the frame ahead of the dispatch behind it. */
    const submitsOf = async (logical: LogicalExecutionPlan): Promise<number> => {
      const host = mockGpuHost();
      const backend = createVgpuBackend({ host });
      try {
        await backend.initialize({});
        const compiled = await backend.compile(logical);
        backend.render(compiled, input(0));
        const asked = watch(host);
        backend.render(compiled, input(1));
        return asked.submits;
      } finally {
        backend.dispose();
        vi.restoreAllMocks();
      }
    };
    const withTable = plan(TWO);
    const without: LogicalExecutionPlan = { ...withTable, passes: withTable.passes.filter((pass) => (pass as { kind: string }).kind !== "write") };
    const bare = await submitsOf(without);
    expect(bare).toBeGreaterThan(0);
    expect(await submitsOf(withTable)).toBe(bare);
  });

  it("takes a pushed value, a values-only compile and the animator as writes, with no module and no pipeline", async () => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    const problems: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => problems.push(diagnostic));
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan(TWO));
      backend.render(compiled, input(0));
      const asked = watch(host);

      /* A pushed value: other numbers, and one row more. Within the capacity it is a write. */
      backend.updateUniforms({ passId: "table:rows", values: { rows: THREE, count: 3 } });
      backend.render(compiled, input(1));
      expect(regionWrites(asked)).toEqual({ rows: [THREE], counts: [3] });

      /* The same plan compiled again with other values: the values-only road of §V5. */
      const again = await backend.compile(plan(TWO));
      backend.render(again, input(2));
      expect(regionWrites(asked)).toEqual({ rows: [TWO], counts: [2] });

      /* The uniform animator, as the frame loop drives it: it diffs the block and pushes it. */
      const graph = (logical: LogicalExecutionPlan): CompiledGraph => {
        const read = readExecutionPlan(logical);
        return { ...logical, passes: read.passes, signature: planStructureSignature(read.resources, read.passes) } as never;
      };
      const animator = createUniformAnimator();
      expect(animator.push(backend, graph(plan(TWO)), graph(plan(TWO)))).toBe(0);
      backend.render(again, input(3));
      expect(regionWrites(asked)).toEqual({ rows: [], counts: [] });
      expect(animator.push(backend, graph(plan(TWO)), graph(plan(THREE)))).toBe(1);
      backend.render(again, input(4));
      expect(regionWrites(asked)).toEqual({ rows: [THREE], counts: [3] });

      /* No rows at all is a count of zero and nothing else. */
      backend.updateUniforms({ passId: "table:rows", values: { rows: [], count: 0 } });
      backend.render(again, input(5));
      expect(regionWrites(asked)).toEqual({ rows: [], counts: [0] });

      expect({ modules: asked.modules, pipelines: asked.pipelines }).toEqual({ modules: 0, pipelines: 0 });
      expect(problems.filter((diagnostic) => diagnostic.severity !== "info")).toEqual([]);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("refuses rows over the capacity by name, writes nothing, and keeps the rows that were there", async () => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    const problems: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => problems.push(diagnostic));
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan(TWO));
      backend.render(compiled, input(0));
      const asked = watch(host);

      const nine = Array.from({ length: 36 }, (_, index) => index);
      backend.updateUniforms({ passId: "table:rows", values: { rows: nine, count: 9 } });
      backend.render(compiled, input(1));
      expect(regionWrites(asked)).toEqual({ rows: [], counts: [] });
      expect(problems.filter((diagnostic) => diagnostic.severity !== "info").map((diagnostic) => [diagnostic.severity, diagnostic.code, diagnostic.message])).toEqual([
        ["error", "backend/plan-invalid", 'Buffer values "table:rows" for "table": 9 rows do not fit its capacity of 8. Not written; the rows already there stay.'],
      ]);

      /* The capacity itself is a write, and what a boundary clear puts back is the last rows that fitted. */
      const eight = nine.slice(0, 32);
      backend.updateUniforms({ passId: "table:rows", values: { rows: eight, count: 8 } });
      backend.render(compiled, input(2));
      expect(regionWrites(asked)).toEqual({ rows: [eight], counts: [8] });
      backend.updateUniforms({ passId: "table:rows", values: { rows: nine, count: 9 } });
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      backend.render(compiled, input(3));
      expect(regionWrites(asked)).toEqual({ rows: [eight], counts: [8] });
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("puts the rows back after a lost device", async () => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan(TWO));
      backend.render(compiled, input(0));
      backend.updateUniforms({ passId: "table:rows", values: { rows: THREE, count: 3 } });
      backend.render(compiled, input(1));

      host.loseDevice();
      await Promise.resolve();
      await backend.whenSettled();
      const asked = watch(host);
      backend.render(compiled, input(2));
      /* The new device's buffer is empty; the rows it gets are the LIVE ones, not the plan's. */
      expect(regionWrites(asked)).toEqual({ rows: [THREE], counts: [3] });
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });
});
