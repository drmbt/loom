import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import { BackendDiagnosticCode, backendDiagnostic } from "./diagnostics.ts";
import type {
  BufferRegionValues,
  BufferWord,
  BufferWritePassDescriptor,
  PassDescriptor,
  ResourceDescriptor,
} from "./plan.ts";

/**
 * T1623b slice 2 — VALUES FOR A REGION OF A BUFFER: reading, checking and encoding.
 *
 * The descriptor is in `plan.ts` (`BufferWritePassDescriptor`), where every pass kind is.
 * What is here is everything about it that is not a type: the reader the plan reader calls,
 * the one check of values against a region (used when a plan is read AND when a value is
 * pushed, so the two cannot disagree about what fits), the plan-level checks of a region
 * against its buffer and its neighbours, and the bytes.
 */

const WORDS: ReadonlySet<string> = new Set<BufferWord>(["f32", "u32", "i32"]);

const isIndex = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Narrows a raw `write` pass, or `undefined` when its SHAPE is wrong. What it names is checked against the plan later. */
export function readBufferWritePass(id: string, value: Readonly<Record<string, unknown>>): BufferWritePassDescriptor | undefined {
  const { resourceId, offset, row, capacity, countOffset, values, nodeId } = value;
  if (typeof resourceId !== "string" || resourceId.length === 0) return undefined;
  if (!isIndex(offset) || offset % 4 !== 0) return undefined;
  if (!Array.isArray(row) || row.length === 0 || !row.every((word) => typeof word === "string" && WORDS.has(word))) return undefined;
  if (!isIndex(capacity) || capacity === 0) return undefined;
  if (countOffset !== undefined && (!isIndex(countOffset) || countOffset % 4 !== 0)) return undefined;
  if (typeof values !== "object" || values === null) return undefined;
  const { rows, count } = values as Record<string, unknown>;
  if (!Array.isArray(rows) || !rows.every((entry) => typeof entry === "number") || !isIndex(count)) return undefined;
  return {
    kind: "write",
    id,
    ...(typeof nodeId === "string" ? { nodeId } : {}),
    resourceId,
    offset,
    row: row as BufferWord[],
    capacity,
    ...(countOffset === undefined ? {} : { countOffset }),
    values: { rows: rows as number[], count },
  };
}

/** Bytes of one row, and of the whole region. */
export const bufferRowBytes = (pass: BufferWritePassDescriptor): number => pass.row.length * 4;
export const bufferRegionBytes = (pass: BufferWritePassDescriptor): number => bufferRowBytes(pass) * pass.capacity;

/**
 * Why these values do not fit the region, as a sentence that names the count and the
 * capacity; `undefined` when they fit. ONE check for both entrances: a plan being read and a
 * value being pushed on a values-only frame.
 */
export function bufferRegionProblem(pass: BufferWritePassDescriptor, values: Readonly<Record<string, unknown>>): string | undefined {
  const { rows, count } = values;
  if (!Array.isArray(rows) || !isIndex(count)) return "its values must be `rows` (numbers, row after row) and `count` (a whole number of rows)";
  if (count > pass.capacity) return `${count} rows do not fit its capacity of ${pass.capacity}`;
  if (rows.length !== count * pass.row.length) {
    return `${rows.length} numbers are not ${count} rows of ${pass.row.length} (${pass.row.join(", ")})`;
  }
  for (let index = 0; index < rows.length; index += 1) {
    const word = pass.row[index % pass.row.length] as BufferWord;
    const entry = rows[index] as unknown;
    const at = `row ${Math.floor(index / pass.row.length)}, word ${index % pass.row.length}`;
    if (typeof entry !== "number" || Number.isNaN(entry)) return `${at} is not a number`;
    if (word === "u32" && !(Number.isInteger(entry) && entry >= 0 && entry <= 0xffffffff)) return `${at} is ${entry}, which is not a u32`;
    if (word === "i32" && !(Number.isInteger(entry) && entry >= -0x80000000 && entry <= 0x7fffffff)) return `${at} is ${entry}, which is not an i32`;
  }
  return undefined;
}

/** The live rows as the bytes the region takes: each word in its declared type, little-endian as WebGPU reads it. */
export function encodeBufferRows(pass: BufferWritePassDescriptor, values: BufferRegionValues): ArrayBuffer {
  const bytes = new ArrayBuffer(values.rows.length * 4);
  const view = new DataView(bytes);
  values.rows.forEach((entry, index) => {
    const word = pass.row[index % pass.row.length];
    if (word === "u32") view.setUint32(index * 4, entry, true);
    else if (word === "i32") view.setInt32(index * 4, entry, true);
    else view.setFloat32(index * 4, entry, true);
  });
  return bytes;
}

/**
 * A region against the plan it sits in. Each of these would otherwise be a plausible wrong
 * picture: rows written past the buffer's end are dropped by the device, a region laid over
 * another's is whichever was written last, and a count word inside the rows is a row of
 * garbage. All are refused by name before anything is built.
 */
export function bufferWriteDiagnostics(
  passes: ReadonlyArray<PassDescriptor>,
  resources: ReadonlyArray<ResourceDescriptor>,
): RuntimeDiagnostic[] {
  const out: RuntimeDiagnostic[] = [];
  const refuse = (pass: BufferWritePassDescriptor, message: string): void => {
    out.push(
      backendDiagnostic("error", BackendDiagnosticCode.planInvalid, `Buffer values "${pass.id}" for "${pass.resourceId}": ${message}.`, pass.nodeId === undefined ? {} : { nodeId: pass.nodeId as never }),
    );
  };
  const writes = passes.filter((pass): pass is BufferWritePassDescriptor => pass.kind === "write");
  const taken = new Map<string, Array<{ from: number; to: number; id: string }>>();
  for (const pass of writes) {
    const resource = resources.find((entry) => entry.id === pass.resourceId);
    // An unknown id is the reference check's to report; nothing more can be said of it here.
    if (resource === undefined) continue;
    if (resource.kind !== "buffer" || (resource.usage !== "storage" && resource.usage !== "storage-read")) {
      refuse(pass, `values can be written into a storage buffer only, and this is ${resource.kind === "buffer" ? `a buffer of usage "${resource.usage}"` : `a ${resource.kind}`}`);
      continue;
    }
    if (resource.sourceId !== undefined) {
      refuse(pass, `the buffer is fed whole by the source "${resource.sourceId}", which would overwrite them`);
      continue;
    }
    const size = resource.stride * resource.capacity;
    const end = pass.offset + bufferRegionBytes(pass);
    if (end > size) {
      refuse(pass, `the region of ${pass.capacity} rows of ${bufferRowBytes(pass)} bytes from byte ${pass.offset} ends at byte ${end}, past the buffer's ${size}`);
      continue;
    }
    const spans = [{ from: pass.offset, to: end, id: pass.id }];
    if (pass.countOffset !== undefined) {
      if (pass.countOffset + 4 > size) {
        refuse(pass, `its count would be written at byte ${pass.countOffset}, past the buffer's ${size}`);
        continue;
      }
      spans.push({ from: pass.countOffset, to: pass.countOffset + 4, id: pass.id });
    }
    const others = taken.get(pass.resourceId) ?? [];
    const clash = [...others, ...(spans.length === 2 ? [spans[0] as (typeof spans)[number]] : [])].find((other) =>
      spans.some((span) => span !== other && span.from < other.to && other.from < span.to),
    );
    if (clash !== undefined) {
      refuse(pass, clash.id === pass.id ? "its count would be written inside its own rows" : `it overlaps the bytes "${clash.id}" writes`);
      continue;
    }
    taken.set(pass.resourceId, [...others, ...spans]);
    const problem = bufferRegionProblem(pass, pass.values);
    if (problem !== undefined) refuse(pass, problem);
  }
  return out;
}
