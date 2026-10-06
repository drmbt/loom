import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { CURVE_FRAMES_WALK } from "./curve-frames-blocked.wgsl.ts";
import { FRAME_MATH_WGSL } from "./curve-frames.wgsl.ts";

/**
 * T1587b C13 — Curve Frames, Extrapolate Ends: THE TWO ENDS OF AN OPEN STRIP, RE-AIMED.
 *
 * The walk gives an end point its end segment's direction, the only one it has. On points
 * taken from a smooth curve that is the curve's direction half a segment further on, off the
 * end's own by half the turn across the segment — where an interior point's bisector is off
 * by the square of it. On the sentinel tunnel's bore that was the largest error in the whole
 * comparison: 2.7 mm at the first ring, 0.11 mm everywhere inside
 * (`docs/sweep-design-2026-10-05.md`, section 11.2). Here an end's tangent is taken from its
 * two nearest segments instead (`endTangent` in `src/points/curve.ts`): the slope, at the
 * end, of the parabola through their three points. Houdini's Orientation Along Curve has the
 * same switch, Extrapolate End Tangents.
 *
 * ⚑ THEY ARE PASSES OF THEIR OWN, AFTER THE WALK, AND THAT IS THE POINT. Two shader programs
 * can round one expression differently (a fused multiply-add is the compiler's choice), so
 * the only way to change the ends and leave every other value to the bit is to leave the
 * walk's program alone. These read what the walk wrote at an end run, turn it, and write it
 * back. They touch a strip's first run of coincident points and its last, and no other
 * slot. The walk's passes are the text they were; `point-curve-frames.test.ts` holds their
 * fingerprints.
 *
 * What is done to a frame is the walk's own answer re-aimed, not a second walk:
 *
 *  - Minimise Twist: the frame is turned by the smallest rotation that takes the end
 *    segment's direction onto the new tangent, so whatever roll and twist the walk put on it
 *    comes with it;
 *  - Fixed Up: the normal leans toward Up about the new tangent as it did about the old one,
 *    at the angle the walk left it. Where Up runs along the end it cannot say which way to
 *    lean, and that point keeps its chord's frame.
 *
 * A strip with fewer than two segments of any length keeps its chord: two points say nothing
 * about how a curve turns. Two segments that run the same way to the bit are left alone, so
 * a straight end is exactly what it was.
 *
 * ## Two passes, because an end is a RUN
 *
 * A strip shorter than its slots repeats its end point (§V788), so an "end" can be hundreds
 * of slots, or whole blocks of them. One thread that searched past them and then rewrote
 * them all would cost what the walk costs. So:
 *
 *   FIND    one invocation per strip. It looks for the two nearest segments with a length at
 *           each end and leaves four vectors a strip: each end's new tangent, its chord, and
 *           the slot its run reaches. On a strip of one block it scans the points; on a
 *           longer one it reads the walk's block summaries and opens two blocks, whatever
 *           the padding.
 *   WRITE   one invocation per 64 slots. Each rewrites the slots of its own that lie in a
 *           run, so a run of any length is written by many threads at once.
 *
 * ## What they cost, measured
 *
 * Dawn/Metal, best of 9 runs of 200 frames, the same graph with Extrapolate Ends on less the
 * same graph with it off; ms a frame, Minimise Twist then Fixed Up. "Repeats" are the slots
 * of each strip after its last point of curve, all in one end run:
 *
 *   strips × slots     repeats a strip    quaternion only    and the three vectors
 *   40 × 54            none               0.04, 0.04         0.05, 0.04
 *   976 × 1,024        none               0.05, 0.02         0.03, 0.04
 *   976 × 1,024        624                0.18, 0.21         0.36, 0.42
 *   61 × 16,384        none                                  0.02, 0.04
 *   61 × 16,384        12,384             0.14, 0.12         0.41, 0.43
 *   1 × 1,000,000      900,000            0.43, 0.41         0.77, 0.83
 *
 * ⚑ WITHOUT REPEATS THE TWO PASSES ARE THEIR OWN SUBMISSION: 0.02 to 0.05 ms, whatever the
 * strip. WITH REPEATS THE COST IS THE REPEATS: every slot of a run is rewritten, at about
 * 0.3 ms a million for the quaternion and 0.6 with tangent, normal and binormal as well —
 * a plain kernel pass over as many points, which is what WRITE is. The walk beside it costs
 * 1.1 to 3.4 ms in the same rows. A run has to be rewritten whole: a sweep reads the frame
 * at every slot, and repeats aimed another way than the point they repeat would be rings
 * tilted against it, with area.
 */

/** Slots one WRITE invocation covers. */
const CHUNK = 64;

/** Workgroups of 64 invocations the WRITE pass needs for `capacity` slots. */
export const curveFramesEndsWriteGroups = (capacity: number): number => Math.ceil(Math.ceil(capacity / CHUNK) / 64);

export interface CurveFramesEndsOptions {
  readonly method: "minimiseTwist" | "fixedUp";
  /** Fixed Up: Up arrives per point from a vec3f attribute (`in_up`) rather than from the uniform. */
  readonly upMapped: boolean;
  /** `fn oldNormal(slot: u32) -> vec3f`: the normal the walk wrote, read back from this node's buffer. */
  readonly loadNormal: string;
  /** The store functions for the frame regions this node owns (`regionStoreWgsl`), as text. */
  readonly storeFunctions: string;
  /** The statements that store one point's frame: calls to the functions above. */
  readonly storeStatements: string;
}

const UNIFORM_TYPES = { up: "vec3f", cols: "u32", rows: "u32", blocks: "u32" } as const;
export type CurveFramesEndsUniform = keyof typeof UNIFORM_TYPES;

/** One pass: its text, and the uniforms its struct declares — the node builds the record from the same list (§V288). */
export interface CurveFramesEndsPass {
  readonly shader: EmittedWgsl;
  readonly uniforms: ReadonlyArray<CurveFramesEndsUniform>;
}

const paramsStruct = (members: ReadonlyArray<CurveFramesEndsUniform>): string =>
  `struct CurveFramesEndsParams {\n${members.map((member) => `  ${member}: ${UNIFORM_TYPES[member]},`).join("\n")}\n};`;

/** Bindings 1…: read-only inputs first, then the buffers the pass writes. */
const bindings = (inputs: ReadonlyArray<string>, written: ReadonlyArray<string>): string =>
  [
    "@group(0) @binding(0) var<uniform> params: CurveFramesEndsParams;",
    ...inputs.map((input, index) => `@group(0) @binding(${index + 1}) var<storage, read> ${input};`),
    ...written.map((buffer, index) => `@group(0) @binding(${inputs.length + index + 1}) var<storage, read_write> ${buffer};`),
  ].join("\n");

const POSITION = "in_position: array<vec3f>";
const UP = "in_up: array<vec3f>";
const OUT = "out_points: array<u32>";
/** A strip's ends, four vectors: the first end's tangent and chord, the last end's tangent and chord. */
const ENDS = "ends: array<vec4f>";
export const CURVE_FRAMES_ENDS_VECTORS = 4;

/** `endTangent`: the tangent at an end from its own segment and the one next to it. */
const END_TANGENT_WGSL = `/* The tangent at an end of an open strip, from the end's own segment and the one next to it,
   both pointing the way the strip runs: the slope, at the end, of the parabola through
   their three points. w is 0 where the two run the same way to the bit: nothing to
   extrapolate, and the end keeps its segment's frame exactly. */
fn endTangent(near: vec3f, far: vec3f) -> vec4f {
  let nearSize = sqrt(dot(near, near));
  let nearDir = near / nearSize;
  let lean = (nearDir - far / sqrt(dot(far, far))) * (nearSize / (nearSize + sqrt(dot(far, far))));
  if (dot(lean, lean) == 0.0) { return vec4f(nearDir, 0.0); }
  let tangent = nearDir + lean;
  return vec4f(tangent / sqrt(dot(tangent, tangent)), 1.0);
}`;

/** The two nearest segments with a length, searched over a stretch of one strip's segments. */
const SCAN_WGSL = `/* What a search of one stretch of a strip found: how many segments with a length (it stops
   at two), where the first of them is, and the two themselves. */
struct EndScan {
  found: u32,
  at: u32,
  near: vec3f,
  far: vec3f,
};

/* Segments first..(last − 1) of a strip, forward: the first two with a length. */
fn scanForward(base: u32, first: u32, last: u32) -> EndScan {
  var scan = EndScan(0u, 0u, vec3f(0.0), vec3f(0.0));
  for (var k = first; k < last; k = k + 1u) {
    let seg = in_position[base + k + 1u] - in_position[base + k];
    if (dot(seg, seg) <= ZERO_SEGMENT_SQUARED) { continue; }
    if (scan.found == 0u) {
      scan.at = k;
      scan.near = seg;
      scan.found = 1u;
    } else {
      scan.far = seg;
      scan.found = 2u;
      break;
    }
  }
  return scan;
}

/* The same stretch, backward: the last two with a length. */
fn scanBackward(base: u32, first: u32, last: u32) -> EndScan {
  var scan = EndScan(0u, 0u, vec3f(0.0), vec3f(0.0));
  for (var n = last; n > first; n = n - 1u) {
    let k = n - 1u;
    let seg = in_position[base + k + 1u] - in_position[base + k];
    if (dot(seg, seg) <= ZERO_SEGMENT_SQUARED) { continue; }
    if (scan.found == 0u) {
      scan.at = k;
      scan.near = seg;
      scan.found = 1u;
    } else {
      scan.far = seg;
      scan.found = 2u;
      break;
    }
  }
  return scan;
}`;

/** The record FIND leaves a strip, written from the two scans. */
const RECORD_WGSL = `  /* Each end: its new tangent (w says whether there is one), and its chord with the slot
     its run reaches to — the first run's last slot, the last run's first. */
  ends[record] = endTangent(head.near, head.far);
  ends[record + 1u] = vec4f(head.near / sqrt(dot(head.near, head.near)), f32(head.at));
  ends[record + 2u] = endTangent(tail.near, tail.far);
  ends[record + 3u] = vec4f(tail.near / sqrt(dot(tail.near, tail.near)), f32(tail.at + 1u));`;

const RECORD_START_WGSL = `  let record = strip * ${CURVE_FRAMES_ENDS_VECTORS}u;
  /* Until both ends are found the record says "leave them": every w is 0. */
  ends[record] = vec4f(0.0);
  ends[record + 1u] = vec4f(0.0);
  ends[record + 2u] = vec4f(0.0);
  ends[record + 3u] = vec4f(0.0);`;

/**
 * FIND: one invocation per strip leaves the strip's two ends. `blocked` is a strip longer
 * than one block: the walk's block summaries say which blocks hold a segment with a length
 * at all, so the search opens two blocks and no more, however much of the strip is padding.
 */
export function curveFramesEndsFindWgsl(blocked: boolean): CurveFramesEndsPass {
  const uniforms: CurveFramesEndsUniform[] = blocked ? ["cols", "rows", "blocks"] : ["cols", "rows"];
  const { HAS, FIRST, LAST } = CURVE_FRAMES_WALK;
  const search = blocked
    ? `  /* The loops here run over blocks, and over the points of two of them: the first block
     with a segment of any length, and its first two. A block's segments are those that
     START in it; the strip's last point starts none. */
  var opening = params.blocks;
  for (var b = 0u; b < params.blocks; b = b + 1u) {
    if (walk[blockAt(strip, b) + ${HAS}u] == 1.0) {
      opening = b;
      break;
    }
  }
  if (opening == params.blocks) {
    return;
  }
  var head = scanForward(base, opening * BLOCK, min((opening + 1u) * BLOCK, cols - 1u));
  if (head.found == 1u) {
    /* Its only one: the second is the first of the next block that has any. */
    for (var b = opening + 1u; b < params.blocks; b = b + 1u) {
      let at = blockAt(strip, b);
      if (walk[at + ${HAS}u] == 1.0) {
        head.far = loadVec(at + ${FIRST}u);
        head.found = 2u;
        break;
      }
    }
  }
  /* Fewer than two segments with a length: the strip keeps its chord. */
  if (head.found < 2u) {
    return;
  }

  /* The last block with one, and its last two. */
  var closing = 0u;
  for (var n = params.blocks; n > 0u; n = n - 1u) {
    if (walk[blockAt(strip, n - 1u) + ${HAS}u] == 1.0) {
      closing = n - 1u;
      break;
    }
  }
  var tail = scanBackward(base, closing * BLOCK, min((closing + 1u) * BLOCK, cols - 1u));
  if (tail.found == 1u) {
    for (var n = closing; n > 0u; n = n - 1u) {
      let at = blockAt(strip, n - 1u);
      if (walk[at + ${HAS}u] == 1.0) {
        tail.far = loadVec(at + ${LAST}u);
        tail.found = 2u;
        break;
      }
    }
  }`
    : `  let head = scanForward(base, 0u, cols - 1u);
  /* Fewer than two segments with a length: the strip keeps its chord. */
  if (head.found < 2u) {
    return;
  }
  let tail = scanBackward(base, 0u, cols - 1u);`;
  return {
    uniforms,
    shader: wgsl`${paramsStruct(uniforms)}

${bindings(blocked ? [POSITION, CURVE_FRAMES_WALK.binding] : [POSITION], [ENDS])}

${FRAME_MATH_WGSL}
${blocked ? `\n${CURVE_FRAMES_WALK.access}\n` : ""}
${END_TANGENT_WGSL}

${SCAN_WGSL}

/* One invocation per STRIP. It writes four vectors and no point's frame. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let strip = gid.x;
  if (strip >= params.rows) {
    return;
  }
  let cols = params.cols;
  let base = strip * cols;
${RECORD_START_WGSL}

${search}

${RECORD_WGSL}
}`,
  };
}

/** WRITE: one invocation per `CHUNK` slots rewrites the slots of its own that lie in an end run. */
export function curveFramesEndsWriteWgsl(options: CurveFramesEndsOptions): CurveFramesEndsPass {
  const fixedUp = options.method === "fixedUp";
  const upAt = options.upMapped ? "in_up[slot]" : "params.up";
  const uniforms: CurveFramesEndsUniform[] = fixedUp && !options.upMapped ? ["up", "cols", "rows"] : ["cols", "rows"];
  const normal = fixedUp
    ? `  let was = perpendicular(${upAt}, chord);
  let now = perpendicular(${upAt}, tangent);
  /* Up runs along this end: it cannot say which way to lean, and the point keeps its chord's frame. */
  if (dot(was, was) < 1.0e-12 || dot(now, now) < 1.0e-12) { return; }
  let wasUnit = was / sqrt(dot(was, was));
  let nowUnit = now / sqrt(dot(now, now));
  /* The angle the normal stood at about the old tangent (its roll and twist), kept about the new. */
  let leaned = nowUnit * dot(old, wasUnit) + cross(tangent, nowUnit) * dot(old, cross(chord, wasUnit));
  let normal = leaned / sqrt(dot(leaned, leaned));`
    : `  /* The walk's frame, turned by the smallest rotation that takes the chord onto the tangent. */
  let turned = perpendicular(qrot(rotationBetween(chord, tangent), old), tangent);
  let normal = turned / sqrt(dot(turned, turned));`;
  return {
    uniforms,
    shader: wgsl`${paramsStruct(uniforms)}

${bindings([...(fixedUp && options.upMapped ? [UP] : []), ENDS], [OUT])}

${FRAME_MATH_WGSL}

/* Slots one invocation covers. */
const CHUNK: u32 = ${CHUNK}u;

${options.loadNormal}

${options.storeFunctions}

/* One point of an end run: its frame re-aimed from the chord to the new tangent. */
fn rewriteEnd(slot: u32, chord: vec3f, tangent: vec3f) {
  let old = oldNormal(slot);
${normal}
  let binormal = cross(tangent, normal);
  let orient = quatFromFrame(cross(normal, tangent), normal, tangent);
${options.storeStatements}
}

/* One invocation per CHUNK slots, writing those of its own that lie in their strip's first
   run or its last, and no others. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let cols = params.cols;
  let count = cols * params.rows;
  let first = gid.x * CHUNK;
  if (first >= count) {
    return;
  }
  let last = min(first + CHUNK, count);
  for (var slot = first; slot < last; slot = slot + 1u) {
    let record = (slot / cols) * ${CURVE_FRAMES_ENDS_VECTORS}u;
    let i = slot % cols;
    /* The first run is slots 0 to head.w; the last is slots tail.w to the strip's end. */
    let headTangent = ends[record];
    let head = ends[record + 1u];
    if (headTangent.w == 1.0 && i <= u32(head.w)) {
      rewriteEnd(slot, head.xyz, headTangent.xyz);
      continue;
    }
    let tailTangent = ends[record + 2u];
    let tail = ends[record + 3u];
    if (tailTangent.w == 1.0 && i >= u32(tail.w)) {
      rewriteEnd(slot, tail.xyz, tailTangent.xyz);
    }
  }
}`,
  };
}
