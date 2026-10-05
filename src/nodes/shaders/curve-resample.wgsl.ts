import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { RESAMPLE_END_TOLERANCE, STRIP_WALK_BLOCK, ZERO_SEGMENT_SQUARED } from "../../points/curve.ts";

/**
 * T1586b — Resample: a LENGTH WALK, then ONE THREAD PER OUTPUT POINT that finds its place.
 *
 * This file is `src/points/curve.ts`'s `stripLengths` and `resampleStations` in WGSL, step
 * for step; the Dawn tests hold the two together.
 *
 * ## The two passes
 *
 * 1. LENGTHS — one invocation per strip walks its strip in order and writes each point's
 *    distance from the strip's first point, and the strip's total. It is the same running
 *    sum Curve Frames publishes as `distance`, by the same expression in the same order, so
 *    "how far along is this point" has one answer in the family. Even Parameter spacing
 *    needs no lengths, and the pass is then not emitted at all. A strip longer than one
 *    block has its lengths taken by three lighter passes instead (`resampleBlockLengthsWgsl`
 *    below), which leave the same two buffers.
 * 2. EMIT — every output slot computes its OWN station from its slot number (a
 *    multiplication, never a running sum, so slot k does not depend on the slots before
 *    it), binary-searches its strip's cumulative lengths for the segment that holds it, and
 *    interpolates every attribute between that segment's two points. This is Laser Path's
 *    emit (`laser-path.wgsl.ts`) with a strip's range as the search bounds: no scatter and
 *    no compaction, because a slot knows its strip and its station by division.
 *
 * ## Padding (§V788)
 *
 * A strip shorter than its slots is padded with copies of its nearest live point, and
 * `live` says which slots are padding. A padding slot is not a special case here: its
 * station is CLAMPED to the nearest live station's, so it reads the same segment at the
 * same blend and writes the same bytes, every attribute included.
 *
 * ## Attributes
 *
 * The node owns every attribute of its output (slots move, so nothing can pass by
 * reference). Float attributes are blended word by word between the two input points;
 * integer attributes take the earlier point's, since a blend of two ids is not an id. A
 * station that lands exactly on an input point copies its words untouched, so a resample
 * that keeps a point keeps it to the bit.
 *
 * ## What it costs, measured
 *
 * Dawn/Metal, best of 9 runs of 200 frames, isolated by rendering the same graph without
 * the node; a position-only strip resampled to its own point count, ms per frame:
 *
 *   points      strips × points per strip     Even Length (walk + emit)     Even Parameter (emit)
 *   2,160       40 × 54                       0.03                          0.01
 *   100,352     98 × 1,024                    0.08                          0.01
 *   100,000     400 × 250                     0.05                          0.01
 *   999,424     976 × 1,024                   0.35                          0.14
 *   1,000,000   4,000 × 250                   0.23                          0.16
 *
 * The length walk is one square root and one add a step, so even a whole block of 1,024
 * costs under a tenth of a millisecond: the walk is not what makes Curve Frames' cost.
 */

/** One attribute carried from the input to the output, as the emit pass addresses it. */
export interface ResampleCarriedAttribute {
  /** Which bound upstream buffer (`pk_<group>`) holds it. */
  readonly group: number;
  /** Word offset of its region inside that buffer, and inside this node's own. */
  readonly inWord: number;
  readonly outWord: number;
  /** Words between consecutive points (a vec3f strides four). */
  readonly strideWords: number;
  /** Components actually stored. */
  readonly components: number;
  /** Float attributes blend; integer attributes copy the earlier point. */
  readonly blend: boolean;
}

export function resampleLengthsWgsl(): EmittedWgsl {
  return wgsl`struct ResampleLengthParams {
  cols: u32,
  rows: u32,
  closed: u32,
};

@group(0) @binding(0) var<uniform> params: ResampleLengthParams;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(2) var<storage, read_write> cumulative: array<f32>;
@group(0) @binding(3) var<storage, read_write> totals: array<f32>;

/* A segment at or below this squared length has none and adds no distance. */
const ZERO_SEGMENT_SQUARED: f32 = ${ZERO_SEGMENT_SQUARED};

/* One invocation per STRIP, walking it left to right: the running sum has one order. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let strip = gid.x;
  if (strip >= params.rows) {
    return;
  }
  let cols = params.cols;
  let base = strip * cols;
  var segments = cols - 1u;
  if (params.closed == 1u) { segments = cols; }
  var travelled = 0.0;
  for (var k = 0u; k < cols; k = k + 1u) {
    cumulative[base + k] = travelled;
    if (k < segments) {
      let seg = in_position[base + (k + 1u) % cols] - in_position[base + k];
      let squared = dot(seg, seg);
      if (squared > ZERO_SEGMENT_SQUARED) { travelled = travelled + sqrt(squared); }
    }
  }
  totals[strip] = travelled;
}`;
}

/**
 * T1586b slice 6 — THE LENGTHS OF A STRIP LONGER THAN ONE BLOCK, in three passes.
 *
 * A walk's cost is its depth, so a strip of more than `STRIP_WALK_BLOCK` points is not
 * walked by one invocation. It is `stripLengths`' blocked order (`src/points/curve.ts`):
 *
 *   1. BLOCK   one invocation per block sums its own segments from zero, and leaves each
 *              point its distance INSIDE the block and the block its sum;
 *   2. FOLD    one invocation per strip adds the blocks' sums left to right: each block's
 *              start, and the strip's total;
 *   3. ADD     one thread per point adds its block's start to its distance inside it.
 *
 * What the emit pass then reads is what it reads for a short strip — one distance per
 * point and one total per strip — so that pass does not know a strip was long. The sums
 * are taken in the order Curve Frames' blocked walk takes them, so "how far along is this
 * point" still has one answer in the family.
 *
 * A strip that fits one block never comes here: its one walk (`resampleLengthsWgsl`) is the
 * program it always was.
 *
 * Measured by the method above, a position-only strip resampled to its own point count by
 * Even Length: 0.08 ms for one strip of 1,024 points (the one walk), 0.14 for one of 4,096,
 * 0.15 for one of 16,384; at a million points 0.44 as 976 strips of 1,024, 0.56 as 61 of
 * 16,384 and 0.66 as one strip.
 */
export function resampleBlockLengthsWgsl(): EmittedWgsl {
  return wgsl`struct ResampleBlockParams {
  cols: u32,
  rows: u32,
  closed: u32,
  blocks: u32,
};

@group(0) @binding(0) var<uniform> params: ResampleBlockParams;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(2) var<storage, read_write> cumulative: array<f32>;
@group(0) @binding(3) var<storage, read_write> blockStarts: array<f32>;

/* A segment at or below this squared length has none and adds no distance. */
const ZERO_SEGMENT_SQUARED: f32 = ${ZERO_SEGMENT_SQUARED};
/* A strip is cut into blocks of this many points; the last may be shorter. */
const BLOCK: u32 = ${STRIP_WALK_BLOCK}u;

/* One invocation per BLOCK, summing from zero: nothing here depends on the blocks before. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.rows * params.blocks) {
    return;
  }
  let strip = gid.x / params.blocks;
  let blockIndex = gid.x % params.blocks;
  let cols = params.cols;
  let base = strip * cols;
  var segments = cols - 1u;
  if (params.closed == 1u) { segments = cols; }
  let first = blockIndex * BLOCK;
  let last = min(first + BLOCK, cols);
  var travelled = 0.0;
  for (var k = first; k < last; k = k + 1u) {
    cumulative[base + k] = travelled;
    if (k < segments) {
      let seg = in_position[base + (k + 1u) % cols] - in_position[base + k];
      let squared = dot(seg, seg);
      if (squared > ZERO_SEGMENT_SQUARED) { travelled = travelled + sqrt(squared); }
    }
  }
  /* The block's sum, until the fold replaces it with the block's start. */
  blockStarts[gid.x] = travelled;
}`;
}

export function resampleBlockFoldWgsl(): EmittedWgsl {
  return wgsl`struct ResampleFoldParams {
  rows: u32,
  blocks: u32,
};

@group(0) @binding(0) var<uniform> params: ResampleFoldParams;
@group(0) @binding(1) var<storage, read_write> blockStarts: array<f32>;
@group(0) @binding(2) var<storage, read_write> totals: array<f32>;

/* One invocation per STRIP, over its blocks: each block's sum becomes its start. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let strip = gid.x;
  if (strip >= params.rows) {
    return;
  }
  var running = 0.0;
  for (var b = 0u; b < params.blocks; b = b + 1u) {
    let at = strip * params.blocks + b;
    let span = blockStarts[at];
    blockStarts[at] = running;
    running = running + span;
  }
  totals[strip] = running;
}`;
}

export function resampleBlockAddWgsl(): EmittedWgsl {
  return wgsl`struct ResampleAddParams {
  cols: u32,
  rows: u32,
  blocks: u32,
};

@group(0) @binding(0) var<uniform> params: ResampleAddParams;
@group(0) @binding(1) var<storage, read> blockStarts: array<f32>;
@group(0) @binding(2) var<storage, read_write> cumulative: array<f32>;

const BLOCK: u32 = ${STRIP_WALK_BLOCK}u;

/* One thread per POINT: its block's start plus its distance inside the block. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.cols * params.rows) {
    return;
  }
  let strip = slot / params.cols;
  let k = slot % params.cols;
  cumulative[slot] = blockStarts[strip * params.blocks + k / BLOCK] + cumulative[slot];
}`;
}

export interface ResampleEmitOptions {
  readonly method: "count" | "distance";
  /** Count only: even in length, or even in the input's point index. */
  readonly spacing: "length" | "parameter";
  /** Distance only: which end the stations are measured from. */
  readonly anchor: "start" | "end";
  /** How many upstream buffers are bound (`pk_0` …). */
  readonly groups: number;
  readonly attributes: ReadonlyArray<ResampleCarriedAttribute>;
  /** Word offset of the `live` region in this node's buffer, when it publishes one. */
  readonly liveWord?: number;
}

export function resampleEmitWgsl(options: ResampleEmitOptions): EmittedWgsl {
  const byLength = !(options.method === "count" && options.spacing === "parameter");
  let binding = 1;
  const declarations: string[] = [];
  for (let group = 0; group < options.groups; group += 1) {
    declarations.push(`@group(0) @binding(${binding}) var<storage, read> pk_${group}: array<u32>;`);
    binding += 1;
  }
  if (byLength) {
    declarations.push(`@group(0) @binding(${binding}) var<storage, read> cumulative: array<f32>;`);
    declarations.push(`@group(0) @binding(${binding + 1}) var<storage, read> totals: array<f32>;`);
    binding += 2;
  }
  declarations.push(`@group(0) @binding(${binding}) var<storage, read_write> out_points: array<u32>;`);

  const stores = options.attributes
    .flatMap((attribute) =>
      Array.from({ length: attribute.components }, (_, component) => {
        const tail = component === 0 ? "" : ` + ${component}u`;
        const source = (point: string): string =>
          `pk_${attribute.group}[${attribute.inWord}u + (baseIn + ${point}) * ${attribute.strideWords}u${tail}]`;
        const target = `out_points[${attribute.outWord}u + slot * ${attribute.strideWords}u${tail}]`;
        return attribute.blend
          ? `  ${target} = blend(${source("station.index")}, ${source("station.next")}, station.t);`
          : `  ${target} = ${source("station.index")};`;
      }),
    )
    .join("\n");
  const liveStore =
    options.liveWord === undefined ? "" : `  out_points[${options.liveWord}u + slot] = bitcast<u32>(live);`;

  /* Where on its strip this slot's station is, as a distance d; `live` says whether the
     slot is a point of the strip or padding. One block per method, and each is the
     reference's block of the same name. */
  const stationByCount = `  if (wholeLoop) {
    d = (f32(k) / slots) * total;
    if (params.offset != 0.0) { d = wrapped(d + params.offset, total); }
  } else {
    var share = 0.0;
    if (params.colsOut > 1u) { share = f32(k) / (slots - 1.0); }
    d = clamp(a + share * range + params.offset, a, b);
  }`;
  const stationByDistance = `  let wanted = max(params.distance, 1.0e-6);
  if (wholeLoop) {
    let needed = floor(total / wanted + END_TOLERANCE);
    let count = max(min(needed, slots), 1.0);
    var spacing = wanted;
    if (needed > slots) { spacing = total / slots; }
    d = wrapped(min(f32(k), count - 1.0) * spacing + params.offset, total);
    if (f32(k) >= count) { live = 0.0; }
  } else {
    let needed = floor(range / wanted + END_TOLERANCE) + 1.0;
    var spacing = wanted;
    if (needed > slots) { spacing = range / max(slots - 1.0, 1.0); }
    let tolerance = spacing * END_TOLERANCE;
    let origin = ${options.anchor === "end" ? "b" : "a"} + params.offset;
    let m = ${options.anchor === "end" ? "f32(k) - (slots - 1.0)" : "f32(k)"};
    let lowest = ceil((a - tolerance - origin) / spacing);
    let highest = floor((b + tolerance - origin) / spacing);
    if (lowest <= highest) {
      if (m < lowest || m > highest) { live = 0.0; }
      d = clamp(origin + clamp(m, lowest, highest) * spacing, a, b);
    } else {
      live = 0.0;
      d = clamp(origin, a, b);
    }
  }`;
  const station = byLength
    ? `  let total = totals[strip];
  let a = params.rangeStart * total;
  let b = params.rangeEnd * total;
  let range = max(b - a, 0.0);
  var d = 0.0;
${options.method === "count" ? stationByCount : stationByDistance}
  let station = stationAtDistance(baseIn, total, d);`
    : `  var span = f32(cols) - 1.0;
  if (closed) { span = f32(cols); }
  var x = 0.0;
  if (wholeLoop) {
    x = (f32(k) / slots) * span;
  } else {
    var share = 0.0;
    if (params.colsOut > 1u) { share = f32(k) / (slots - 1.0); }
    x = params.rangeStart * span + share * (params.rangeEnd * span - params.rangeStart * span);
  }
  var station = Station(cols - 1u, cols - 1u, 0.0);
  if (closed || x < span) {
    var limit = cols - 1u;
    if (!closed) { limit = max(cols, 2u) - 2u; }
    let index = min(u32(max(floor(x), 0.0)), limit);
    station = Station(index, (index + 1u) % cols, clamp(x - f32(index), 0.0, 1.0));
  }`;
  const search = byLength
    ? `
/* The input segment that holds the distance d: the LARGEST point whose cumulative length is
   at or below it, so a run of coincident points resolves to its last one, where the next
   real segment starts. The loop halves its interval whatever it reads: its length is a
   function of cols alone. */
fn stationAtDistance(baseIn: u32, total: f32, d: f32) -> Station {
  let cols = params.colsIn;
  var low = 0u;
  var high = cols - 1u;
  while (low < high) {
    let mid = (low + high + 1u) / 2u;
    if (cumulative[baseIn + mid] <= d) {
      low = mid;
    } else {
      high = mid - 1u;
    }
  }
  let index = low;
  if (params.closed == 0u && index >= cols - 1u) {
    return Station(index, index, 0.0);
  }
  var end = total;
  if (index < cols - 1u) { end = cumulative[baseIn + index + 1u]; }
  let size = end - cumulative[baseIn + index];
  var t = 0.0;
  if (size > 0.0) { t = clamp((d - cumulative[baseIn + index]) / size, 0.0, 1.0); }
  return Station(index, (index + 1u) % cols, t);
}

fn wrapped(d: f32, total: f32) -> f32 {
  if (total <= 0.0) { return 0.0; }
  return d - floor(d / total) * total;
}
`
    : "";

  return wgsl`struct ResampleParams {
  colsIn: u32,
  rows: u32,
  closed: u32,
  colsOut: u32,
  distance: f32,
  offset: f32,
  rangeStart: f32,
  rangeEnd: f32,
};

@group(0) @binding(0) var<uniform> params: ResampleParams;
${declarations.join("\n")}

/* A station within this share of one spacing past an end of the range counts as the end. */
const END_TOLERANCE: f32 = ${RESAMPLE_END_TOLERANCE};

/* Where one output slot reads its strip: between two input points, t of the way. */
struct Station {
  index: u32,
  next: u32,
  t: f32,
};

/* One float component between two input points. A station exactly ON a point copies its
   word untouched, so a kept point is kept to the bit. */
fn blend(a: u32, b: u32, t: f32) -> u32 {
  if (t == 0.0) { return a; }
  let x = bitcast<f32>(a);
  let y = bitcast<f32>(b);
  return bitcast<u32>(x + (y - x) * t);
}
${search}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.colsOut * params.rows) {
    return;
  }
  let strip = slot / params.colsOut;
  let k = slot % params.colsOut;
  let cols = params.colsIn;
  let baseIn = strip * cols;
  let closed = params.closed == 1u;
  let wholeLoop = closed && params.rangeStart <= 0.0 && params.rangeEnd >= 1.0;
  let slots = f32(params.colsOut);
  var live = 1.0;
${station}
${stores}
${liveStore}
}`;
}
