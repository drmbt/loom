import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { encodeBufferRows } from "./buffer-write.ts";
import { planStructureSignature, planUniformValues, readExecutionPlan, type BufferWritePassDescriptor } from "./plan.ts";

/**
 * T1623b slice 2 — VALUES FOR A REGION OF A BUFFER, as the plan reader sees them.
 *
 * Why this seam exists: a table of rows could reach a shader only as numbered uniform members,
 * so its length was in the shader's text, and the Render's lights paid for that (§B260). A
 * `write` pass is the table as values. What this file holds is the half of that promise the
 * plan can keep without a device:
 *
 *  - the rows and their count are VALUES: two plans that differ only in them are one
 *    structure, so a change is never a rebuild;
 *  - where the rows go IS structure;
 *  - and everything that would be a plausible wrong picture is refused by name before
 *    anything is built: rows past the capacity, a region past its buffer, a region laid over
 *    another, a count written into the rows, a word that is not of its type.
 */

const TABLE = { kind: "buffer", id: "table", stride: 4, capacity: 36, usage: "storage-read" } as const; // 144 bytes
const ROW = ["f32", "f32", "f32", "f32"] as const;

/** A table of up to eight vec4f rows from byte 16, its count at byte 0. */
function write(over: Partial<Record<keyof BufferWritePassDescriptor, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "write",
    id: "table:rows",
    resourceId: "table",
    offset: 16,
    row: [...ROW],
    capacity: 8,
    countOffset: 0,
    values: { rows: [1, 2, 3, 4, 5, 6, 7, 8], count: 2 },
    ...over,
  };
}

function plan(passes: unknown[], resources: unknown[] = [TABLE]): LogicalExecutionPlan {
  return { resources, passes, diagnostics: [] };
}

const errorsOf = (logical: LogicalExecutionPlan): string[] =>
  readExecutionPlan(logical).diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.message);

describe("T1623b: a table of rows is values for a region of a buffer", () => {
  it("is read whole, and its rows travel with the uniform blocks under its own pass id", () => {
    const read = readExecutionPlan(plan([write()]));
    expect(read.diagnostics).toEqual([]);
    expect(read.ok).toBe(true);
    expect(read.passes).toEqual([
      { kind: "write", id: "table:rows", resourceId: "table", offset: 16, row: ROW, capacity: 8, countOffset: 0, values: { rows: [1, 2, 3, 4, 5, 6, 7, 8], count: 2 } },
    ]);
    expect([...planUniformValues(read.passes)]).toEqual([["table:rows", { rows: [1, 2, 3, 4, 5, 6, 7, 8], count: 2 }]]);
  });

  it("keeps the rows and their count out of the structure, and everything about where they go in it", () => {
    const signature = (pass: Record<string, unknown>): string => {
      /* A buffer with a word to spare, so the region can move by one without leaving it. */
      const read = readExecutionPlan(plan([pass], [{ ...TABLE, capacity: 37 }]));
      expect(read.ok, JSON.stringify(read.diagnostics)).toBe(true);
      return planStructureSignature(read.resources, read.passes);
    };
    const base = signature(write());
    /* VALUES: other numbers, more rows, fewer rows, none. A slider and a list that grows. */
    expect(signature(write({ values: { rows: [9, 9, 9, 9, 9, 9, 9, 9], count: 2 } }))).toBe(base);
    expect(signature(write({ values: { rows: Array.from({ length: 32 }, (_, index) => index), count: 8 } }))).toBe(base);
    expect(signature(write({ values: { rows: [], count: 0 } }))).toBe(base);
    /* STRUCTURE: each of these is another region. */
    const moved = [
      write({ offset: 20 }),
      write({ capacity: 4 }),
      write({ countOffset: 4 }),
      write({ countOffset: undefined }),
      write({ row: ["f32", "f32", "f32", "u32"], values: { rows: [1, 2, 3, 4, 5, 6, 7, 8], count: 2 } }),
      write({ id: "table:other" }),
    ].map(signature);
    expect(new Set([base, ...moved]).size).toBe(moved.length + 1);
  });

  it("refuses rows over the capacity by name, and a count that is not the rows given", () => {
    const nine = Array.from({ length: 36 }, () => 0);
    expect(errorsOf(plan([write({ values: { rows: nine, count: 9 } })]))).toEqual([
      'Buffer values "table:rows" for "table": 9 rows do not fit its capacity of 8.',
    ]);
    /* The capacity itself is not over: eight rows are a write. */
    expect(errorsOf(plan([write({ values: { rows: nine.slice(0, 32), count: 8 } })]))).toEqual([]);
    expect(errorsOf(plan([write({ values: { rows: [1, 2, 3, 4, 5, 6], count: 2 } })]))).toEqual([
      'Buffer values "table:rows" for "table": 6 numbers are not 2 rows of 4 (f32, f32, f32, f32).',
    ]);
  });

  it("refuses a word that is not of the type its row declares", () => {
    const typed = (rows: number[]): string[] => errorsOf(plan([write({ row: ["f32", "u32", "i32", "f32"], values: { rows, count: 1 } })]));
    expect(typed([0.5, 4294967295, -2147483648, 1e30])).toEqual([]);
    expect(typed([0.5, 1.5, 0, 0])).toEqual(['Buffer values "table:rows" for "table": row 0, word 1 is 1.5, which is not a u32.']);
    expect(typed([0.5, -1, 0, 0])).toEqual(['Buffer values "table:rows" for "table": row 0, word 1 is -1, which is not a u32.']);
    expect(typed([0.5, 0, 2147483648, 0])).toEqual(['Buffer values "table:rows" for "table": row 0, word 2 is 2147483648, which is not an i32.']);
    expect(typed([Number.NaN, 0, 0, 0])).toEqual(['Buffer values "table:rows" for "table": row 0, word 0 is not a number.']);
  });

  it("refuses a region that leaves its buffer, lies over another, or holds its own count", () => {
    expect(errorsOf(plan([write({ capacity: 9, values: { rows: [], count: 0 } })]))).toEqual([
      'Buffer values "table:rows" for "table": the region of 9 rows of 16 bytes from byte 16 ends at byte 160, past the buffer\'s 144.',
    ]);
    expect(errorsOf(plan([write({ countOffset: 144 })]))).toEqual([
      'Buffer values "table:rows" for "table": its count would be written at byte 144, past the buffer\'s 144.',
    ]);
    expect(errorsOf(plan([write({ countOffset: 32 })]))).toEqual([
      'Buffer values "table:rows" for "table": its count would be written inside its own rows.',
    ]);
    /* Two regions of one buffer are legal side by side, and refused where they share a byte. */
    const first = write({ capacity: 4 }); // bytes 16..80, count at 0
    const beside = write({ id: "table:more", offset: 80, capacity: 4, countOffset: 4 }); // bytes 80..144, count at 4
    expect(errorsOf(plan([first, beside]))).toEqual([]);
    expect(errorsOf(plan([first, write({ id: "table:more", offset: 64, capacity: 4, countOffset: 4 })]))).toEqual([
      'Buffer values "table:more" for "table": it overlaps the bytes "table:rows" writes.',
    ]);
    expect(errorsOf(plan([first, write({ id: "table:more", offset: 80, capacity: 4, countOffset: 0 })]))).toEqual([
      'Buffer values "table:more" for "table": it overlaps the bytes "table:rows" writes.',
    ]);
  });

  it("refuses anything that is not a plain storage buffer", () => {
    const into = (resource: Record<string, unknown>): string[] => errorsOf(plan([write()], [resource]));
    expect(into({ kind: "buffer", id: "table", stride: 4, capacity: 36, usage: "storage" })).toEqual([]);
    expect(into({ kind: "buffer", id: "table", stride: 4, capacity: 36, usage: "indirect" })).toEqual([
      'Buffer values "table:rows" for "table": values can be written into a storage buffer only, and this is a buffer of usage "indirect".',
    ]);
    expect(into({ kind: "bufferPair", id: "table", stride: 4, capacity: 36 })).toEqual([
      'Buffer values "table:rows" for "table": values can be written into a storage buffer only, and this is a bufferPair.',
    ]);
    expect(into({ kind: "buffer", id: "table", stride: 4, capacity: 36, usage: "storage-read", sourceId: "mesh:points" })).toEqual([
      'Buffer values "table:rows" for "table": the buffer is fed whole by the source "mesh:points", which would overwrite them.',
    ]);
    expect(errorsOf(plan([write({ resourceId: "nowhere" })]))).toEqual(['Pass "table:rows" references unknown resource "nowhere".']);
  });

  it("refuses a malformed pass as it refuses any other", () => {
    for (const broken of [write({ offset: 18 }), write({ row: [] }), write({ row: ["f64"] }), write({ capacity: 0 }), write({ countOffset: 2 }), write({ values: { rows: [1, 2, 3, 4] } }), write({ values: undefined })]) {
      expect(errorsOf(plan([broken]))).toEqual(["Pass #0 is not a valid backend pass descriptor."]);
    }
  });

  it("encodes each word in the type its row declares", () => {
    const pass = readExecutionPlan(plan([write({ row: ["f32", "u32", "i32", "f32"], values: { rows: [0.5, 4294967295, -5, 2, 1.25, 7, 2147483647, -0], count: 2 } })])).passes[0] as BufferWritePassDescriptor;
    const bytes = encodeBufferRows(pass, pass.values);
    expect(bytes.byteLength).toBe(32);
    expect([...new Float32Array(bytes, 0, 1)]).toEqual([0.5]);
    expect([...new Uint32Array(bytes, 4, 1)]).toEqual([4294967295]);
    expect([...new Int32Array(bytes, 8, 1)]).toEqual([-5]);
    expect([...new Float32Array(bytes, 12, 2)]).toEqual([2, 1.25]);
    expect([...new Uint32Array(bytes, 20, 1)]).toEqual([7]);
    expect([...new Int32Array(bytes, 24, 1)]).toEqual([2147483647]);
    expect(Object.is(new Float32Array(bytes, 28, 1)[0], -0)).toBe(true);
  });
});
