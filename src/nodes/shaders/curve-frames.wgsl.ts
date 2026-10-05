import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { ZERO_SEGMENT_SQUARED } from "../../points/curve.ts";

/**
 * T1586b — Curve Frames: ONE INVOCATION PER STRIP WALKS ITS STRIP IN ORDER.
 *
 * Distance along a curve is a running sum and a carried frame is a running product of
 * rotations, so both depend on everything before a point. The walk does that in the one
 * order there is — left to right — inside a single invocation, and strips do not share
 * slots, so the invocations never write the same word: no atomics, no barriers, and the
 * same answer on every device (§V74's argument). It is parallel ACROSS strips: ten
 * tentacles are ten threads, four thousand hairs are four thousand.
 *
 * This file is `src/points/curve.ts`'s `frameStrip` in WGSL, step for step, and the Dawn
 * tests hold the two together. Read the three rules at the top of that file first; what
 * follows from them here:
 *
 *  - the walk runs TWICE in the invocation. The first pass finds what every point needs
 *    before it can be written (the strip's length, for the normalised distance and the
 *    twist; the turn after one lap of a closed strip). The second writes the points, one
 *    run of coincident points at a time;
 *  - the frame is carried as two VECTORS and re-squared at every point, and the quaternion
 *    is made once per point at the end. A straight continuation then turns nothing,
 *    exactly, which is why the tests can assert equality (§V147);
 *  - every direction is `segment / sqrt(dot(segment, segment))`, never `normalize`, for
 *    the same reason: a fast reciprocal square root is allowed to miss 1.0 by an ulp.
 *
 * The node owns ONE packed buffer and writes its regions by offset through one binding
 * (`out_points`), the way a kernel does (T1076): eight published attributes would otherwise
 * be eight storage bindings, which is the whole baseline budget (§V588).
 *
 * ## What the walk costs, measured (the design's D5)
 *
 * Dawn/Metal, best of 9 runs of 200 frames, isolated by rendering the same graph without
 * the node. All eight attributes on (80 bytes a point written), ms per frame:
 *
 *   points      strips × points per strip     walk      metrics only (16 B a point)
 *   2,160       40 × 54                       0.06      (the submission floor)
 *   100,032     1,563 × 64                    0.03
 *   100,000     400 × 250                     0.21      0.03
 *   100,352     98 × 1,024                    1.21      0.45
 *   1,000,000   4,000 × 250                   0.84      0.20
 *   999,424     976 × 1,024                   1.26      0.57
 *
 * A plain per-point kernel over the same points measured 0.05 ms at 100k and 0.16 ms at 1M.
 *
 * ⚑ THE COST FOLLOWS THE STRIP'S LENGTH, NOT THE NUMBER OF STRIPS. Ninety-eight strips of
 * 1,024 points cost what 976 of them do, because the strips run in parallel and the price
 * is the depth of one walk: about 0.6 µs a point, twice over. So a thousand hairs are free
 * and one long curve is what costs — at most about 1.2 ms for a strip of one whole block.
 * That is the measurement that kept the walk: the alternative (a scan in workgroup memory)
 * buys depth, which only long strips need, and cannot hold a strip over 256 points at all.
 */

export interface CurveFramesShaderOptions {
  /** Minimise Twist carries the frame along the strip; Fixed Up leans every normal toward up. */
  readonly method: "minimiseTwist" | "fixedUp";
  /** Up arrives per point from a vec3f attribute (`in_up`) rather than from the uniform. */
  readonly upMapped: boolean;
  /** Minimise Twist: the first frame comes from a quaternion attribute (`in_seed`) at each strip's first point. */
  readonly seedOrient: boolean;
  /** A per-point roll attribute (`in_roll`), in degrees: its element type and the component read. */
  readonly rollMap?: { readonly type: string; readonly component: string };
  /** The store functions for the regions this node owns (`regionStoreWgsl`), as text. */
  readonly storeFunctions: string;
  /** The statements that store one point: calls to the functions above, for the attributes that are on. */
  readonly storeStatements: string;
}

export function curveFramesWgsl(options: CurveFramesShaderOptions): EmittedWgsl {
  const carried = options.method === "minimiseTwist";
  let binding = 2;
  const declarations: string[] = [];
  if (options.upMapped) {
    declarations.push(`@group(0) @binding(${binding}) var<storage, read> in_up: array<vec3f>;`);
    binding += 1;
  }
  if (carried && options.seedOrient) {
    declarations.push(`@group(0) @binding(${binding}) var<storage, read> in_seed: array<vec4f>;`);
    binding += 1;
  }
  if (options.rollMap !== undefined) {
    declarations.push(`@group(0) @binding(${binding}) var<storage, read> in_roll: array<${options.rollMap.type}>;`);
    binding += 1;
  }
  declarations.push(`@group(0) @binding(${binding}) var<storage, read_write> out_points: array<u32>;`);

  const upAt = options.upMapped ? "in_up[slot]" : "params.up";
  const wanted = carried && options.seedOrient ? "qrot(in_seed[base], vec3f(0.0, 1.0, 0.0))" : options.upMapped ? "in_up[base]" : "params.up";
  const restDirection = carried && options.seedOrient ? "qrot(in_seed[base], vec3f(0.0, 0.0, 1.0))" : "vec3f(0.0, 0.0, 1.0)";
  const rollTerm = options.rollMap === undefined ? "" : ` + in_roll[slot]${options.rollMap.component} * 0.017453292519943295`;
  /* Fixed Up decides each point's normal on its own; Minimise Twist hands the run's down. */
  const ownNormal = carried
    ? "    let own = runNormal;"
    : `    var leaning = perpendicular(${upAt}, tangent);
    if (dot(leaning, leaning) < 1.0e-12 && (*seen)) { leaning = perpendicular(*previous, tangent); }
    if (dot(leaning, leaning) < 1.0e-12) { leaning = perpendicular(leastAligned(tangent), tangent); }
    let own = leaning / sqrt(dot(leaning, leaning));
    *previous = own;
    *seen = true;`;
  const lapStep = carried ? "      lapNormal = turn(lastDir, dir, lapNormal).next;" : "";
  const lapClose = carried
    ? `  if (closed && params.closeTwist == 1u) {
    let lapped = turn(lastDir, firstDir, lapNormal).next;
    closing = atan2(dot(cross(seed, lapped), firstDir), dot(seed, lapped));
  }`
    : "";
  const closedStart = carried ? "  if (closed) { carriedNormal = turn(firstDir, lastDir, seed).next; }" : "";

  return wgsl`struct CurveFramesParams {
  up: vec3f,
  cols: u32,
  rows: u32,
  closed: u32,
  closeTwist: u32,
  roll: f32,
  twist: f32,
};

@group(0) @binding(0) var<uniform> params: CurveFramesParams;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
${declarations.join("\n")}

${options.storeFunctions}

/* A segment at or below this squared length has none: it adds no distance and turns no
   frame, which is what makes a strip's padding harmless. */
const ZERO_SEGMENT_SQUARED: f32 = ${ZERO_SEGMENT_SQUARED};

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

/* The smallest rotation carrying unit a onto unit b. Never called on opposite vectors. */
fn rotationBetween(a: vec3f, b: vec3f) -> vec4f {
  let q = vec4f(cross(a, b), 1.0 + dot(a, b));
  return q / sqrt(dot(q, q));
}

fn perpendicular(v: vec3f, axis: vec3f) -> vec3f {
  return v - axis * dot(v, axis);
}

/* The world axis least aligned with z: X before Y before Z on a tie. */
fn leastAligned(z: vec3f) -> vec3f {
  let a = abs(z);
  if (a.x <= a.y && a.x <= a.z) { return vec3f(1.0, 0.0, 0.0); }
  if (a.y <= a.z) { return vec3f(0.0, 1.0, 0.0); }
  return vec3f(0.0, 0.0, 1.0);
}

/* A unit normal for the direction z, leaning toward wanted. */
fn seedNormal(z: vec3f, wanted: vec3f) -> vec3f {
  var normal = perpendicular(wanted, z);
  if (dot(normal, normal) < 1.0e-12) { normal = perpendicular(leastAligned(z), z); }
  return normal / sqrt(dot(normal, normal));
}

struct Turn {
  tangent: vec3f,
  normal: vec3f,
  next: vec3f,
};

/* Carry a segment's normal across a point. The frame turns by the smallest rotation taking
   the incoming direction to the outgoing one, and the point itself gets half of it, so its
   tangent is the bisector. An exact reversal has no smallest rotation: the frame turns
   about its own normal instead. */
fn turn(incoming: vec3f, outgoing: vec3f, normal: vec3f) -> Turn {
  if (dot(incoming, outgoing) < -0.999999) {
    return Turn(cross(normal, incoming), normal, normal);
  }
  let sum = incoming + outgoing;
  let mid = sum / sqrt(dot(sum, sum));
  let half = perpendicular(qrot(rotationBetween(incoming, mid), normal), mid);
  let full = perpendicular(qrot(rotationBetween(incoming, outgoing), normal), outgoing);
  return Turn(mid, half / sqrt(dot(half, half)), full / sqrt(dot(full, full)));
}

/* The unit quaternion whose rotation has the columns x, y, z. */
fn quatFromFrame(x: vec3f, y: vec3f, z: vec3f) -> vec4f {
  let trace = x.x + y.y + z.z;
  if (trace > 0.0) {
    let s = sqrt(trace + 1.0) * 2.0;
    return vec4f((y.z - z.y) / s, (z.x - x.z) / s, (x.y - y.x) / s, 0.25 * s);
  }
  if (x.x > y.y && x.x > z.z) {
    let s = sqrt(1.0 + x.x - y.y - z.z) * 2.0;
    return vec4f(0.25 * s, (y.x + x.y) / s, (z.x + x.z) / s, (y.z - z.y) / s);
  }
  if (y.y > z.z) {
    let s = sqrt(1.0 + y.y - x.x - z.z) * 2.0;
    return vec4f((y.x + x.y) / s, 0.25 * s, (z.y + y.z) / s, (z.x - x.z) / s);
  }
  let s = sqrt(1.0 + z.z - x.x - y.y) * 2.0;
  return vec4f((z.x + x.z) / s, (z.y + y.z) / s, 0.25 * s, (x.y - y.x) / s);
}

/* The curvature of the circle through a point and its two neighbours. */
fn turningCurvature(a: vec3f, b: vec3f) -> f32 {
  let sum = a + b;
  let denominator = sqrt(dot(a, a)) * sqrt(dot(b, b)) * sqrt(dot(sum, sum));
  if (denominator < 1.0e-20) { return 0.0; }
  let twice = cross(a, b);
  return 2.0 * sqrt(dot(twice, twice)) / denominator;
}

/* One run of coincident points: stations first..last of the strip share a tangent, a
   distance and a curvature. Roll, twist and the closing correction turn each normal about
   the tangent last, right-handed, so a positive angle swings the normal toward the binormal. */
fn writeRun(
  base: u32,
  first: u32,
  last: u32,
  tangent: vec3f,
  runNormal: vec3f,
  travelled: f32,
  total: f32,
  closing: f32,
  bend: f32,
  previous: ptr<function, vec3f>,
  seen: ptr<function, bool>,
) {
  var u = 0.0;
  if (total > 0.0) { u = travelled / total; }
  for (var i = first; i <= last; i = i + 1u) {
    let slot = base + i;
${ownNormal}
    let angle = params.roll${rollTerm} + (params.twist - closing) * u;
    var normal = own;
    if (angle != 0.0) { normal = own * cos(angle) + cross(tangent, own) * sin(angle); }
    let binormal = cross(tangent, normal);
    let orient = quatFromFrame(cross(normal, tangent), normal, tangent);
${options.storeStatements}
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let strip = gid.x;
  if (strip >= params.rows) {
    return;
  }
  let cols = params.cols;
  let base = strip * cols;
  let closed = params.closed == 1u;
  var segments = cols - 1u;
  if (closed) { segments = cols; }
  let wanted = ${wanted};
  var previous = vec3f(0.0);
  var seen = false;

  /* Walk 1: the totals. */
  var total = 0.0;
  var found = false;
  var firstDir = vec3f(0.0, 0.0, 1.0);
  var firstSeg = vec3f(0.0);
  var lastDir = vec3f(0.0, 0.0, 1.0);
  var lastSeg = vec3f(0.0);
  var seed = vec3f(0.0, 1.0, 0.0);
  var lapNormal = vec3f(0.0, 1.0, 0.0);
  for (var k = 0u; k < segments; k = k + 1u) {
    let seg = in_position[base + (k + 1u) % cols] - in_position[base + k];
    let squared = dot(seg, seg);
    if (squared <= ZERO_SEGMENT_SQUARED) { continue; }
    let size = sqrt(squared);
    let dir = seg / size;
    total = total + size;
    if (!found) {
      found = true;
      firstDir = dir;
      firstSeg = seg;
      seed = seedNormal(dir, wanted);
      lapNormal = seed;
    } else {
${lapStep}
    }
    lastDir = dir;
    lastSeg = seg;
  }

  if (!found) {
    /* A strip of no length has no direction: its frame is the seed's, its metrics zero. */
    let rest = ${restDirection};
    writeRun(base, 0u, cols - 1u, rest, seedNormal(rest, wanted), 0.0, 0.0, 0.0, 0.0, &previous, &seen);
    return;
  }

  var closing = 0.0;
${lapClose}

  /* Walk 2: the points, a run at a time. A closed strip starts from the last segment's
     frame as it was BEFORE the lap: the one the turn into the first segment carries onto
     the seed. */
  var started = closed;
  var prevDir = lastDir;
  var prevSeg = lastSeg;
  var carriedNormal = seed;
${closedStart}
  var runStart = 0u;
  var travelled = 0.0;
  for (var k = 0u; k < segments; k = k + 1u) {
    let seg = in_position[base + (k + 1u) % cols] - in_position[base + k];
    let squared = dot(seg, seg);
    if (squared <= ZERO_SEGMENT_SQUARED) { continue; }
    let size = sqrt(squared);
    let dir = seg / size;
    if (!started) {
      writeRun(base, runStart, k, dir, seed, travelled, total, closing, 0.0, &previous, &seen);
      carriedNormal = seed;
      started = true;
    } else {
      let crossing = turn(prevDir, dir, carriedNormal);
      writeRun(base, runStart, k, crossing.tangent, crossing.normal, travelled, total, closing, turningCurvature(prevSeg, seg), &previous, &seen);
      carriedNormal = crossing.next;
    }
    travelled = travelled + size;
    prevDir = dir;
    prevSeg = seg;
    runStart = k + 1u;
  }
  if (runStart < cols) {
    if (closed) {
      /* The closing segment had no length: these points sit on the first one, a lap later. */
      let crossing = turn(prevDir, firstDir, carriedNormal);
      writeRun(base, runStart, cols - 1u, crossing.tangent, crossing.normal, travelled, total, closing, turningCurvature(prevSeg, firstSeg), &previous, &seen);
    } else {
      writeRun(base, runStart, cols - 1u, prevDir, carriedNormal, travelled, total, closing, 0.0, &previous, &seen);
    }
  }
}`;
}
