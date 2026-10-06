import { describe, expect, it } from "vitest";

import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { wgsl } from "../wgsl.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T1623b slice 2 on a REAL device: what a shader reads from a region written as values.
 *
 * One buffer holds two tables, as the Render's light table will hold several: four rows of
 * four floats, and four rows of mixed words (a u32, an i32, two floats), each with its live
 * count in a header word. A kernel reads both through an ordinary binding and writes what it
 * saw into a second buffer, which is read back. Every number is chosen to be exact in an f32,
 * so the claims are equalities.
 *
 * What would fail it: a row at the wrong bytes (the two regions would read each other's
 * rows), a word written in the wrong type (the u32 2^24 and the i32 -5 are not the same bits
 * as those floats), a count that does not follow its rows, or a pushed value that never
 * reaches the device.
 */

const input = (frameIndex: number): FrameInputs => ({
  frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [8, 8],
});

/* Words 0 and 1: the two counts. Floats from word 4 (byte 16), mixed rows from word 20 (byte 80).
   out[0..3]: a float row where it is live, -1 where it is not. out[4..7]: the same for a mixed
   row, its integers as floats. out[8]: the two counts. */
const READER = wgsl`@group(0) @binding(0) var<storage, read> table: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f>;

fn word(at: u32) -> f32 { return bitcast<f32>(table[at]); }

@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let floats = table[0];
  let mixed = table[1];
  let i = id.x;
  if (i < 4u) {
    let at = 4u + i * 4u;
    out[i] = select(vec4f(-1.0), vec4f(word(at), word(at + 1u), word(at + 2u), word(at + 3u)), i < floats);
  } else if (i < 8u) {
    let at = 20u + (i - 4u) * 4u;
    out[i] = select(vec4f(-1.0), vec4f(f32(table[at]), f32(bitcast<i32>(table[at + 1u])), word(at + 2u), word(at + 3u)), i - 4u < mixed);
  } else {
    out[i] = vec4f(f32(floats), f32(mixed), 0.0, 0.0);
  }
}`;

const FLOATS = [0.5, -2, 1024, 0.125, 3, 4, 5, 6];
const MIXED = [16777216, -5, 0.25, 8, 7, 2147483647, -0.5, 1, 4294967040, -2147483648, 2, 3];

function plan(): LogicalExecutionPlan {
  return {
    resources: [
      { kind: "buffer", id: "table", stride: 4, capacity: 36, usage: "storage-read" },
      { kind: "buffer", id: "out", stride: 16, capacity: 9, usage: "storage" },
    ],
    passes: [
      { kind: "write", id: "table:floats", resourceId: "table", offset: 16, row: ["f32", "f32", "f32", "f32"], capacity: 4, countOffset: 0, values: { rows: FLOATS, count: 2 } },
      { kind: "write", id: "table:mixed", resourceId: "table", offset: 80, row: ["u32", "i32", "f32", "f32"], capacity: 4, countOffset: 4, values: { rows: MIXED, count: 3 } },
      { kind: "dispatch", id: "reader", entryPoint: "main", workgroups: [9, 1, 1], shader: READER, buffers: [{ binding: "table", resourceId: "table" }, { binding: "out", resourceId: "out" }] },
    ],
    diagnostics: [],
  };
}

const NOT_LIVE = [-1, -1, -1, -1];

describe("T1623b: a kernel reads the rows the plan carries as values", () => {
  it("reads each word in its type at its own bytes, follows the count, and sees a pushed row on the next frame", async () => {
    // Required, never skipped: without a GPU nothing here reads a buffer.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const problems: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => problems.push(diagnostic));
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan());
      const rows = async (frameIndex: number): Promise<number[][]> => {
        backend.render(compiled, input(frameIndex));
        const floats = new Float32Array(await backend.readBuffer("out"));
        return Array.from({ length: 9 }, (_, index) => [...floats.slice(index * 4, index * 4 + 4)]);
      };

      /* As compiled: two float rows of four, three mixed rows of four. */
      expect(await rows(0)).toEqual([
        [0.5, -2, 1024, 0.125],
        [3, 4, 5, 6],
        NOT_LIVE,
        NOT_LIVE,
        [16777216, -5, 0.25, 8],
        [7, 2147483648, -0.5, 1], // 2^31 - 1 as an f32
        [4294967040, -2147483648, 2, 3],
        NOT_LIVE,
        [2, 3, 0, 0],
      ]);

      /* A PUSHED VALUE, no compile: one more float row, and the mixed table cut to one row. */
      backend.updateUniforms({ passId: "table:floats", values: { rows: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1, -2], count: 3 } });
      backend.updateUniforms({ passId: "table:mixed", values: { rows: [1, 1, 1, 1], count: 1 } });
      expect(await rows(1)).toEqual([
        [9, 8, 7, 6],
        [5, 4, 3, 2],
        [1, 0, -1, -2],
        NOT_LIVE,
        [1, 1, 1, 1],
        NOT_LIVE,
        NOT_LIVE,
        NOT_LIVE,
        [3, 1, 0, 0],
      ]);

      /* OVER THE CAPACITY: refused by name, and the kernel still reads the rows that were there. */
      backend.updateUniforms({ passId: "table:floats", values: { rows: Array.from({ length: 20 }, () => 7), count: 5 } });
      expect((await rows(2)).slice(0, 4)).toEqual([[9, 8, 7, 6], [5, 4, 3, 2], [1, 0, -1, -2], NOT_LIVE]);
      expect(problems.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.message)).toEqual([
        'Buffer values "table:floats" for "table": 5 rows do not fit its capacity of 4. Not written; the rows already there stay.',
      ]);

      /* A BOUNDARY CLEAR zeroes every buffer; the rows are values and are back for the next frame. */
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      const after = await rows(3);
      expect(after.slice(0, 4)).toEqual([[9, 8, 7, 6], [5, 4, 3, 2], [1, 0, -1, -2], NOT_LIVE]);
      expect(after[8]).toEqual([3, 1, 0, 0]);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
