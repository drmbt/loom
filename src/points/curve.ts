/**
 * T1586b — CURVES ON THE CPU: the reference the curve nodes are tested against, and the
 * definition a CPU reader (the path follower, §T1590b) evaluates.
 *
 * A curve is a STRIP: a run of consecutive slots of a pointset, joined by straight
 * segments (`topology.ts`, `stripsOf`). Everything here takes one strip as an array of
 * points and answers what the GPU passes answer, by the same steps in the same order —
 * `nodes/shaders/curve.wgsl.ts`, `curve-resample.wgsl.ts`, `curve-frames.wgsl.ts` and
 * `curve-frames-blocked.wgsl.ts` are this file in WGSL, and the Dawn tests hold the two
 * together. It is headless: no GPU, no node types, no clock.
 *
 * ## The three rules everything below follows
 *
 * 1. A SEGMENT OF NO LENGTH IS SKIPPED. It adds no distance and turns no frame. That is
 *    what makes padding harmless (§V788): a strip shorter than its slots repeats its
 *    nearest live point, and every walk here passes over the repeats as if they were not
 *    there. The points of such a run share one frame and one distance.
 * 2. THE ORDER IS LEFT TO RIGHT. Distance is the running sum of segment lengths from the
 *    strip's first point, and a frame is carried from one segment to the next. One order,
 *    the same on every device, and the same loop here and on the GPU. A strip longer than
 *    `STRIP_WALK_BLOCK` points is taken a block at a time, in ONE blocked order that is
 *    just as fixed (`stripLengths`, `frameStripBlocked`).
 * 3. A FRAME IS TWO VECTORS, NOT A QUATERNION, WHILE IT IS CARRIED. The walk carries the
 *    segment's direction and its normal and re-squares them at every point; the quaternion
 *    is made once per point at the end. A straight continuation then turns nothing at all,
 *    exactly, and a planar curve keeps its normal exactly — which is what lets the tests
 *    assert equality instead of a band (§V147).
 *
 * The frame convention is the mesh-instancing design's (§T1581b): `orient` carries a
 * shape's +Z onto the tangent and its +Y onto the normal, so +X lands on normal × tangent
 * and `binormal = tangent × normal`.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/**
 * The longest strip one serial walk covers. A longer strip is cut into blocks of this many
 * points (the design's section 4.3), and because a block's local result is added to its
 * block's start, the rounding of a long strip depends on this number — so it is fixed here,
 * once, and a strip of at most this many points is walked whole.
 */
export const STRIP_WALK_BLOCK = 1024;

/**
 * A segment whose squared length is at or below this has no length (rule 1). 1e-7 metres:
 * exact copies always qualify, and so does anything below what f32 resolves at unit scale,
 * whose direction would be rounding noise.
 */
export const ZERO_SEGMENT_SQUARED = 1e-14;

/** A station within this share of one spacing past an end of the range counts as the end. */
export const RESAMPLE_END_TOLERANCE = 1 / 1024;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.sqrt(dot(a, a));
const unit = (a: Vec3): Vec3 => scale(a, 1 / length(a));

/** Rotate `v` by the unit quaternion `q` (x, y, z, w): right-handed and active (§T723). */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const axis: Vec3 = [q[0], q[1], q[2]];
  return add(v, scale(cross(axis, add(cross(axis, v), scale(v, q[3]))), 2));
}

/** The smallest rotation carrying unit `a` onto unit `b`; they must not be opposite. */
function rotationBetween(a: Vec3, b: Vec3): Quat {
  const axis = cross(a, b);
  const w = 1 + dot(a, b);
  const norm = Math.sqrt(dot(axis, axis) + w * w);
  return [axis[0] / norm, axis[1] / norm, axis[2] / norm, w / norm];
}

/** `v` with its part along the unit `axis` removed. */
const perpendicular = (v: Vec3, axis: Vec3): Vec3 => sub(v, scale(axis, dot(v, axis)));

/** The world axis least aligned with `z`; X before Y before Z on a tie. */
function leastAligned(z: Vec3): Vec3 {
  const ax = Math.abs(z[0]);
  const ay = Math.abs(z[1]);
  const az = Math.abs(z[2]);
  if (ax <= ay && ax <= az) return [1, 0, 0];
  if (ay <= az) return [0, 1, 0];
  return [0, 0, 1];
}

/** A unit normal for the direction `z`, leaning toward `wanted`; a world axis when `wanted` runs along `z`. */
function seedNormal(z: Vec3, wanted: Vec3): Vec3 {
  let normal = perpendicular(wanted, z);
  if (dot(normal, normal) < 1e-12) normal = perpendicular(leastAligned(z), z);
  return unit(normal);
}

interface Turn {
  /** The point's tangent: the bisector of the two segments. */
  readonly tangent: Vec3;
  /** The point's normal: the incoming segment's, carried half way. */
  readonly normal: Vec3;
  /** The outgoing segment's normal: carried all the way. */
  readonly next: Vec3;
}

/**
 * Carry a segment's normal across a point, from the direction `from` to the direction `to`
 * (rule 3). The frame turns by the smallest rotation taking one direction to the other; the
 * point itself gets half of it. An exact reversal has no smallest rotation, so the frame
 * turns about its own normal: the tangent swings round and the normal stays.
 */
function turn(from: Vec3, to: Vec3, normal: Vec3): Turn {
  if (dot(from, to) < -0.999999) return { tangent: cross(normal, from), normal, next: normal };
  const mid = unit(add(from, to));
  return {
    tangent: mid,
    normal: unit(perpendicular(rotateByQuat(rotationBetween(from, mid), normal), mid)),
    next: unit(perpendicular(rotateByQuat(rotationBetween(from, to), normal), to)),
  };
}

/** The unit quaternion whose rotation has the columns x, y, z (orthonormal, right-handed). */
export function quatFromFrame(x: Vec3, y: Vec3, z: Vec3): Quat {
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, 0.25 * s];
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    return [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  }
  if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    return [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  }
  const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
  return [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s];
}

/** The curvature of the circle through a point and its two neighbours, from the two segments that meet there. */
function turningCurvature(a: Vec3, b: Vec3): number {
  const denominator = length(a) * length(b) * length(add(a, b));
  return denominator < 1e-20 ? 0 : (2 * length(cross(a, b))) / denominator;
}

/** Segment `k` of a strip: from point `k` to the next one, wrapping on a closed strip. */
function segmentOf(points: ReadonlyArray<Vec3>, k: number): Vec3 {
  return sub(points[(k + 1) % points.length] as Vec3, points[k] as Vec3);
}

const segmentCount = (cols: number, closed: boolean): number => (closed ? cols : Math.max(cols - 1, 0));

export interface StripLengths {
  /** Distance from the strip's first point to each point, along its segments. */
  readonly cumulative: number[];
  /** The strip's length; a closed strip includes its closing segment. */
  readonly total: number;
}

/**
 * Rule 2: the running sum of segment lengths, left to right, zero-length segments skipped.
 *
 * THE BLOCKED ORDER (the design's section 4.3). A strip longer than one block is summed a
 * block at a time: each block sums its own segments from zero, the blocks' sums are added
 * left to right to give each block its start, and a point's distance is its block's start
 * plus its distance inside the block. That is what lets many walks measure one long strip
 * at once on the GPU, and it is why a long strip rounds differently from the same points
 * walked whole. A strip of one block is the case of one block: its start is zero, and zero
 * plus a number is that number, so nothing about a short strip changes.
 */
export function stripLengths(points: ReadonlyArray<Vec3>, closed: boolean, block = STRIP_WALK_BLOCK): StripLengths {
  const cols = points.length;
  const segments = segmentCount(cols, closed);
  const cumulative = new Array<number>(cols);
  let start = 0;
  for (let first = 0; first < cols; first += block) {
    const last = Math.min(first + block, cols);
    let inside = 0;
    for (let k = first; k < last; k += 1) {
      cumulative[k] = start + inside;
      if (k >= segments) continue;
      const segment = segmentOf(points, k);
      const squared = dot(segment, segment);
      if (squared > ZERO_SEGMENT_SQUARED) inside += Math.sqrt(squared);
    }
    start += inside;
  }
  return { cumulative, total: start };
}

export interface StripFrameOptions {
  readonly closed: boolean;
  /** Minimise Twist carries the frame along the strip; Fixed Up leans every normal toward `up`. */
  readonly method: "minimiseTwist" | "fixedUp";
  /** One direction, or one per point (a mapped attribute). Minimise Twist reads the first point's. */
  readonly up: Vec3 | ReadonlyArray<Vec3>;
  /** Minimise Twist only: seed the first frame from this quaternion's +Y instead of `up`. */
  readonly seedOrient?: Quat;
  /** A turn about the tangent at every point, radians. */
  readonly roll?: number;
  /** One more turn about the tangent per point, radians (a mapped attribute, already converted). */
  readonly rollPerPoint?: ReadonlyArray<number>;
  /** A turn about the tangent growing from 0 at the start to this at the end, by distance; radians. */
  readonly twist?: number;
  /** Closed strips under Minimise Twist: spread the mismatch after one lap along the strip. */
  readonly closeTwist?: boolean;
}

export interface StripFrames {
  readonly tangent: Vec3[];
  readonly normal: Vec3[];
  readonly binormal: Vec3[];
  readonly orient: Quat[];
  readonly distance: number[];
  readonly curveU: number[];
  readonly curveLength: number;
  readonly curvature: number[];
  /** How far the carried frame has turned about the tangent after one lap of a closed strip; radians. */
  readonly closingAngle: number;
}

const isPerPoint = (up: Vec3 | ReadonlyArray<Vec3>): up is ReadonlyArray<Vec3> => Array.isArray(up[0]);

const directionOf = (segment: Vec3): Vec3 => scale(segment, 1 / Math.sqrt(dot(segment, segment)));

/** Fixed Up: the normal one point hands the next, for where the next cannot decide its own. */
interface Handed {
  normal: Vec3 | undefined;
}

/**
 * The per-point half of a walk: what a RUN of coincident points is written with. Shared by
 * the whole walk and the blocked one, so a point's frame is one expression however its
 * strip was walked.
 */
function frameSink(cols: number, options: StripFrameOptions, total: number, closing: number) {
  const carried = options.method === "minimiseTwist";
  const upAt = (index: number): Vec3 => (isPerPoint(options.up) ? (options.up[index] as Vec3) : options.up);
  const roll = options.roll ?? 0;
  const twist = options.twist ?? 0;
  const tangent: Vec3[] = new Array<Vec3>(cols);
  const normal: Vec3[] = new Array<Vec3>(cols);
  const binormal: Vec3[] = new Array<Vec3>(cols);
  const orient: Quat[] = new Array<Quat>(cols);
  const distance: number[] = new Array<number>(cols);
  const curveU: number[] = new Array<number>(cols);
  const curvature: number[] = new Array<number>(cols);

  /** `emit` false walks the run for what it hands on and writes nothing (the blocked form's catch-up). */
  const write = (from: number, to: number, runTangent: Vec3, runNormal: Vec3, at: number, bend: number, handed: Handed, emit = true): void => {
    for (let index = from; index <= to; index += 1) {
      let own = runNormal;
      if (!carried) {
        // Fixed Up: up made square to the tangent; where the tangent runs along up, the
        // point before it decides, and a world axis if there was none.
        let leaning = perpendicular(upAt(index), runTangent);
        if (dot(leaning, leaning) < 1e-12 && handed.normal !== undefined) leaning = perpendicular(handed.normal, runTangent);
        if (dot(leaning, leaning) < 1e-12) leaning = perpendicular(leastAligned(runTangent), runTangent);
        own = unit(leaning);
        handed.normal = own;
      }
      if (!emit) continue;
      const u = total > 0 ? at / total : 0;
      const angle = roll + (options.rollPerPoint?.[index] ?? 0) + (twist - closing) * u;
      const across = cross(runTangent, own);
      // A right-handed turn about the tangent: the normal swings toward the binormal.
      const turned: Vec3 = angle === 0 ? own : add(scale(own, Math.cos(angle)), scale(across, Math.sin(angle)));
      tangent[index] = runTangent;
      normal[index] = turned;
      binormal[index] = cross(runTangent, turned);
      orient[index] = quatFromFrame(cross(turned, runTangent), turned, runTangent);
      distance[index] = at;
      curveU[index] = u;
      curvature[index] = bend;
    }
  };
  return { tangent, normal, binormal, orient, distance, curveU, curvature, write, upAt };
}

/**
 * What Curve Frames publishes for one strip: distance, curvature and a frame per point.
 *
 * A strip of at most one block is walked WHOLE, by `frameStripWhole`. A longer one is cut
 * into blocks and walked by `frameStripBlocked` — the same answer up to rounding, in the
 * order the GPU's blocked passes use. `block` is a parameter so the tests can cut a strip
 * of eleven points into blocks of four; a node always uses `STRIP_WALK_BLOCK`.
 */
export function frameStrip(points: ReadonlyArray<Vec3>, options: StripFrameOptions, block = STRIP_WALK_BLOCK): StripFrames {
  return points.length > block ? frameStripBlocked(points, options, block) : frameStripWhole(points, options);
}

/**
 * The whole walk: two passes over the strip, as on the GPU. The first finds what every
 * point needs before it can be written: the strip's length, its first and last real
 * segments, and (closed, Minimise Twist) how far the frame has turned after one lap. The
 * second writes the points, one RUN of coincident points at a time.
 */
function frameStripWhole(points: ReadonlyArray<Vec3>, options: StripFrameOptions): StripFrames {
  const cols = points.length;
  const { closed, method } = options;
  const segments = segmentCount(cols, closed);
  const carried = method === "minimiseTwist";
  const firstUp: Vec3 = isPerPoint(options.up) ? (options.up[0] as Vec3) : options.up;
  const seedWanted: Vec3 = carried && options.seedOrient !== undefined ? rotateByQuat(options.seedOrient, [0, 1, 0]) : firstUp;

  // ── Walk 1: the totals ──
  let total = 0;
  let firstDirection: Vec3 | undefined;
  let firstSegment: Vec3 = [0, 0, 0];
  let lastDirection: Vec3 = [0, 0, 1];
  let lastSegment: Vec3 = [0, 0, 0];
  let lapNormal: Vec3 = [0, 1, 0];
  let seed: Vec3 = [0, 1, 0];
  for (let k = 0; k < segments; k += 1) {
    const segment = segmentOf(points, k);
    const squared = dot(segment, segment);
    if (squared <= ZERO_SEGMENT_SQUARED) continue;
    const size = Math.sqrt(squared);
    const direction = scale(segment, 1 / size);
    total += size;
    if (firstDirection === undefined) {
      firstDirection = direction;
      firstSegment = segment;
      seed = seedNormal(direction, seedWanted);
      lapNormal = seed;
    } else if (carried) {
      lapNormal = turn(lastDirection, direction, lapNormal).next;
    }
    lastDirection = direction;
    lastSegment = segment;
  }

  let closingAngle = 0;
  if (firstDirection !== undefined && closed && carried) {
    const lapped = turn(lastDirection, firstDirection, lapNormal).next;
    closingAngle = Math.atan2(dot(cross(seed, lapped), firstDirection), dot(seed, lapped));
  }
  const sink = frameSink(cols, options, total, options.closeTwist === false ? 0 : closingAngle);
  const handed: Handed = { normal: undefined };
  const { tangent, normal, binormal, orient, distance, curveU, curvature } = sink;

  if (firstDirection === undefined) {
    // A strip of no length has no direction: its frame is the seed's and its metrics are zero.
    const z: Vec3 = carried && options.seedOrient !== undefined ? rotateByQuat(options.seedOrient, [0, 0, 1]) : [0, 0, 1];
    sink.write(0, cols - 1, z, seedNormal(z, seedWanted), 0, 0, handed);
    return { tangent, normal, binormal, orient, distance, curveU, curveLength: 0, curvature, closingAngle: 0 };
  }

  // ── Walk 2: the points, a run at a time ──
  let started = closed;
  let previousDirection: Vec3 = lastDirection;
  let previousSegment: Vec3 = lastSegment;
  // A closed strip starts from the last segment's frame as it was BEFORE the lap: the one
  // that the turn into the first segment carries onto the seed.
  let carriedNormal: Vec3 = closed && carried ? turn(firstDirection, lastDirection, seed).next : seed;
  let runStart = 0;
  let travelled = 0;
  for (let k = 0; k < segments; k += 1) {
    const segment = segmentOf(points, k);
    const squared = dot(segment, segment);
    if (squared <= ZERO_SEGMENT_SQUARED) continue;
    const size = Math.sqrt(squared);
    const direction = scale(segment, 1 / size);
    if (!started) {
      sink.write(runStart, k, direction, seed, travelled, 0, handed);
      carriedNormal = seed;
      started = true;
    } else {
      const crossing = turn(previousDirection, direction, carriedNormal);
      sink.write(runStart, k, crossing.tangent, crossing.normal, travelled, turningCurvature(previousSegment, segment), handed);
      carriedNormal = crossing.next;
    }
    travelled += size;
    previousDirection = direction;
    previousSegment = segment;
    runStart = k + 1;
  }
  if (runStart < cols) {
    if (closed) {
      // The closing segment had no length: these points sit on the first one, a lap later.
      const crossing = turn(previousDirection, firstDirection, carriedNormal);
      sink.write(runStart, cols - 1, crossing.tangent, crossing.normal, travelled, turningCurvature(previousSegment, firstSegment), handed);
    } else {
      sink.write(runStart, cols - 1, previousDirection, carriedNormal, travelled, 0, handed);
    }
  }
  return { tangent, normal, binormal, orient, distance, curveU, curveLength: total, curvature, closingAngle };
}

/** Pass 1: what one block is on its own — nothing here depends on the blocks before it. */
interface BlockSummary {
  /** The sum of its segments' lengths, from zero. */
  readonly length: number;
  /** Whether it has a segment with a length at all. A block of padding has none. */
  readonly has: boolean;
  readonly firstSegment: Vec3;
  readonly lastSegment: Vec3;
  /** A reference normal, seeded on its first segment and carried to its last. */
  readonly reference: Vec3;
  /** An odd number of exact reversals inside it: the carried side of the reference is mirrored. */
  readonly flipped: boolean;
}

/** Fold 1: the walk's state where a block begins, and what the points after its last segment are written with. */
interface BlockEntry {
  readonly started: boolean;
  readonly previousSegment: Vec3;
  readonly carried: Vec3;
  readonly travelled: number;
  tail: { readonly tangent: Vec3; readonly normal: Vec3; readonly bend: number; readonly travelled: number };
}

/**
 * THE BLOCKED WALK (the design's section 4.3): a strip longer than one block, in the order
 * the GPU's passes take it. The answer is `frameStripWhole`'s up to rounding; the tests
 * hold the two together on strips cut into blocks of a few points.
 *
 * A frame depends on everything before it, and so does a distance. But what a BLOCK does to
 * them does not depend on what came before the block: it adds its own length, and it turns
 * whatever normal it is handed by its own rotation. So:
 *
 *  1. every block is summarised on its own (many walks at once): its length, its first and
 *     last real segments, and a reference normal carried from the first to the last;
 *  2. ONE pass per strip walks the summaries in order — a few steps, not thousands — and
 *     writes, per block, the state the whole walk would have had on arriving there. It
 *     also finds the strip's length and its closing angle;
 *  3. every block is walked again from that state and writes its points (many walks at
 *     once). This is `frameStripWhole`'s second walk, started in the middle.
 *
 * ⚑ A BLOCK'S TURN IS ONE ANGLE. Carrying a normal across a point is a rotation, so two
 * normals carried through the same block keep the angle between them. The block carries a
 * reference of its own choosing; the normal it is handed sits at some angle to that
 * reference about the first segment, and leaves at the same angle to the carried reference
 * about the last. An exact reversal keeps the normal and turns the direction round, which
 * mirrors that angle — hence `flipped`.
 *
 * ⚑ A RUN OF COINCIDENT POINTS CAN CROSS A BLOCK'S EDGE, and padding can fill whole blocks.
 * A run is written with the turn at the segment that ENDS it, which may be blocks away. So
 * step 2 also walks the blocks backward and hands each one the turn that ends its trailing
 * run (`tail`), and every block writes only its own points: a strip that is mostly padding
 * is still written by all its blocks at once, and the points of one run still share one
 * frame to the bit.
 *
 * ⚑ FIXED UP HAS A SECOND THING HANDED ALONG: where a tangent runs along Up the point takes
 * the normal of the point before it. That chain is cut at every point that CAN decide its
 * own normal, so a block that holds such a point hands on a normal that owes nothing to the
 * blocks before it. A block with none (a straight run along Up, longer than a block) hands
 * on what it was handed, pressed square to each of its tangents in turn — a linear map,
 * which is summarised as the three vectors it sends the axes to (pass 2b) and applied in a
 * second fold. The one thing a linear map cannot say is the chain collapsing inside such a
 * block (the handed normal landing along a tangent, which restarts it from a world axis):
 * the fold sees that it MAY have happened, because the mapped normal has all but vanished,
 * marks what follows as not known, and the write pass walks forward from the last block
 * whose handed normal is known. Never on a real curve; exact when it happens.
 */
function frameStripBlocked(points: ReadonlyArray<Vec3>, options: StripFrameOptions, block: number): StripFrames {
  const cols = points.length;
  const { closed, method } = options;
  const segments = segmentCount(cols, closed);
  const carried = method === "minimiseTwist";
  const firstUp: Vec3 = isPerPoint(options.up) ? (options.up[0] as Vec3) : options.up;
  const seedWanted: Vec3 = carried && options.seedOrient !== undefined ? rotateByQuat(options.seedOrient, [0, 1, 0]) : firstUp;
  const blocks = Math.ceil(cols / block);
  const firstOf = (b: number): number => b * block;
  const endOf = (b: number): number => Math.min((b + 1) * block, cols);

  // ── Pass 1: every block on its own ──
  const summaries: BlockSummary[] = [];
  for (let b = 0; b < blocks; b += 1) {
    let length = 0;
    let has = false;
    let firstSegment: Vec3 = [0, 0, 0];
    let lastSegment: Vec3 = [0, 0, 0];
    let lastDirection: Vec3 = [0, 0, 1];
    let reference: Vec3 = [0, 1, 0];
    let flipped = false;
    for (let k = firstOf(b); k < endOf(b) && k < segments; k += 1) {
      const segment = segmentOf(points, k);
      const squared = dot(segment, segment);
      if (squared <= ZERO_SEGMENT_SQUARED) continue;
      const size = Math.sqrt(squared);
      const direction = scale(segment, 1 / size);
      length += size;
      if (!has) {
        has = true;
        firstSegment = segment;
        reference = seedNormal(direction, seedWanted);
      } else {
        if (dot(lastDirection, direction) < -0.999999) flipped = !flipped;
        reference = turn(lastDirection, direction, reference).next;
      }
      lastDirection = direction;
      lastSegment = segment;
    }
    summaries.push({ length, has, firstSegment, lastSegment, reference, flipped });
  }

  /** A block's own turn, applied to the normal `onFirst` of its first segment: the normal of its last. */
  const through = (summary: BlockSummary, onFirst: Vec3): Vec3 => {
    const incoming = directionOf(summary.firstSegment);
    const outgoing = directionOf(summary.lastSegment);
    const start = seedNormal(incoming, seedWanted);
    const along = dot(onFirst, start);
    const across = dot(onFirst, cross(incoming, start)) * (summary.flipped ? -1 : 1);
    return unit(perpendicular(add(scale(summary.reference, along), scale(cross(outgoing, summary.reference), across)), outgoing));
  };

  // ── Fold 1: the strip's totals, then the state each block is entered with ──
  let total = 0;
  const starts: number[] = [];
  let firstReal: BlockSummary | undefined;
  let lastReal: BlockSummary | undefined;
  for (const summary of summaries) {
    starts.push(total);
    total += summary.length;
    if (summary.has) {
      firstReal ??= summary;
      lastReal = summary;
    }
  }

  const entries: BlockEntry[] = [];
  let closingAngle = 0;
  if (firstReal === undefined || lastReal === undefined) {
    // A strip of no length has no direction: its frame is the seed's and its metrics are zero.
    const z: Vec3 = carried && options.seedOrient !== undefined ? rotateByQuat(options.seedOrient, [0, 0, 1]) : [0, 0, 1];
    const tail = { tangent: z, normal: seedNormal(z, seedWanted), bend: 0, travelled: 0 };
    for (let b = 0; b < blocks; b += 1) entries.push({ started: false, previousSegment: [0, 0, 0], carried: tail.normal, travelled: 0, tail });
  } else {
    const firstDirection = directionOf(firstReal.firstSegment);
    const lastDirection = directionOf(lastReal.lastSegment);
    const seed = seedNormal(firstDirection, seedWanted);
    if (closed && carried) {
      // One lap from the seed: how far the carried frame has turned on coming back.
      let lap = seed;
      let lapDirection = firstDirection;
      let entered = false;
      for (const summary of summaries) {
        if (!summary.has) continue;
        lap = through(summary, entered ? turn(lapDirection, directionOf(summary.firstSegment), lap).next : seed);
        lapDirection = directionOf(summary.lastSegment);
        entered = true;
      }
      const lapped = turn(lastDirection, firstDirection, lap).next;
      closingAngle = Math.atan2(dot(cross(seed, lapped), firstDirection), dot(seed, lapped));
    }

    let started = closed;
    let previousSegment: Vec3 = lastReal.lastSegment;
    let normal: Vec3 = closed && carried ? turn(firstDirection, lastDirection, seed).next : seed;
    for (let b = 0; b < blocks; b += 1) {
      const summary = summaries[b] as BlockSummary;
      entries.push({ started, previousSegment, carried: normal, travelled: starts[b] as number, tail: { tangent: firstDirection, normal: seed, bend: 0, travelled: 0 } });
      if (!summary.has) continue;
      normal = through(summary, started ? turn(directionOf(previousSegment), directionOf(summary.firstSegment), normal).next : seed);
      previousSegment = summary.lastSegment;
      started = true;
    }

    // Backward: the turn that ends each block's trailing run is the one that opens the next
    // block with a real segment — or the strip's own end.
    const endDirection = directionOf(previousSegment);
    let tail: BlockEntry["tail"];
    if (closed) {
      const crossing = turn(endDirection, firstDirection, normal);
      tail = { tangent: crossing.tangent, normal: crossing.normal, bend: turningCurvature(previousSegment, firstReal.firstSegment), travelled: total };
    } else {
      tail = { tangent: endDirection, normal, bend: 0, travelled: total };
    }
    for (let b = blocks - 1; b >= 0; b -= 1) {
      const summary = summaries[b] as BlockSummary;
      const entry = entries[b] as BlockEntry;
      entry.tail = tail;
      if (!summary.has) continue;
      const opening = directionOf(summary.firstSegment);
      if (entry.started) {
        const crossing = turn(directionOf(entry.previousSegment), opening, entry.carried);
        tail = { tangent: crossing.tangent, normal: crossing.normal, bend: turningCurvature(entry.previousSegment, summary.firstSegment), travelled: entry.travelled };
      } else {
        tail = { tangent: opening, normal: seed, bend: 0, travelled: entry.travelled };
      }
    }
  }

  /** One block's runs, in order: `frameStripWhole`'s second walk, started from the block's entry. */
  const walkBlock = (b: number, run: (from: number, to: number, runTangent: Vec3, runNormal: Vec3, at: number, bend: number) => void): void => {
    const entry = entries[b] as BlockEntry;
    let started = entry.started;
    let previousSegment = entry.previousSegment;
    let previousDirection: Vec3 = started ? directionOf(previousSegment) : [0, 0, 1];
    let carriedNormal = entry.carried;
    let runStart = firstOf(b);
    let inside = 0;
    for (let k = firstOf(b); k < endOf(b) && k < segments; k += 1) {
      const segment = segmentOf(points, k);
      const squared = dot(segment, segment);
      if (squared <= ZERO_SEGMENT_SQUARED) continue;
      const size = Math.sqrt(squared);
      const direction = scale(segment, 1 / size);
      if (!started) {
        const seed = seedNormal(direction, seedWanted);
        run(runStart, k, direction, seed, entry.travelled + inside, 0);
        carriedNormal = seed;
        started = true;
      } else {
        const crossing = turn(previousDirection, direction, carriedNormal);
        run(runStart, k, crossing.tangent, crossing.normal, entry.travelled + inside, turningCurvature(previousSegment, segment));
        carriedNormal = crossing.next;
      }
      inside += size;
      previousDirection = direction;
      previousSegment = segment;
      runStart = k + 1;
    }
    if (runStart < endOf(b)) run(runStart, endOf(b) - 1, entry.tail.tangent, entry.tail.normal, entry.tail.travelled, entry.tail.bend);
  };

  const sink = frameSink(cols, options, total, options.closeTwist === false ? 0 : closingAngle);
  const { tangent, normal, binormal, orient, distance, curveU, curvature } = sink;

  // ── Fixed Up only. Pass 2b: what each block does to the handed normal; fold 2: what each is handed ──
  const handedIn: Array<{ normal: Vec3 | undefined; known: boolean }> = [];
  if (!carried) {
    let handed: Vec3 | undefined;
    let known = true;
    for (let b = 0; b < blocks; b += 1) {
      handedIn.push({ normal: handed, known });
      // The chain inside the block: its own normal once a point has decided one, and until
      // then the map it applies to whatever it was handed.
      let seen = b > 0;
      let decided = false;
      let own: Vec3 = [0, 0, 0];
      const axes: [Vec3, Vec3, Vec3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      walkBlock(b, (from, to, runTangent) => {
        for (let index = from; index <= to; index += 1) {
          let leaning = perpendicular(sink.upAt(index), runTangent);
          if (dot(leaning, leaning) < 1e-12) {
            if (decided) {
              leaning = perpendicular(own, runTangent);
            } else if (seen) {
              for (let axis = 0; axis < 3; axis += 1) axes[axis] = perpendicular(axes[axis] as Vec3, runTangent);
              continue;
            }
          }
          if (dot(leaning, leaning) < 1e-12) leaning = perpendicular(leastAligned(runTangent), runTangent);
          own = unit(leaning);
          decided = true;
          seen = true;
        }
      });
      if (decided) {
        handed = own;
        known = true;
      } else if (known && handed !== undefined) {
        const mapped = add(add(scale(axes[0], handed[0]), scale(axes[1], handed[1])), scale(axes[2], handed[2]));
        // Every pressing can only shorten it. Still a millionth of its length: no single
        // pressing can have collapsed it, so the chain inside ran unbroken and this is it.
        if (dot(mapped, mapped) >= 1e-12) handed = unit(mapped);
        else known = false;
      }
    }
  }

  // ── Pass 3: every block writes its own points ──
  for (let b = 0; b < blocks; b += 1) {
    let from = b;
    if (!carried) while (!(handedIn[from] as { known: boolean }).known) from -= 1;
    const handed: Handed = { normal: carried ? undefined : (handedIn[from] as { normal: Vec3 | undefined }).normal };
    for (let c = from; c <= b; c += 1) {
      walkBlock(c, (first, last, runTangent, runNormal, at, bend) => sink.write(first, last, runTangent, runNormal, at, bend, handed, c === b));
    }
  }
  return { tangent, normal, binormal, orient, distance, curveU, curveLength: total, curvature, closingAngle };
}

export interface ResampleOptions {
  readonly closed: boolean;
  readonly method: "count" | "distance";
  /** Count: even in length along the strip, or even in the input's point index. */
  readonly spacing?: "length" | "parameter";
  /** Count: points per strip. Distance: the slots allocated per strip. */
  readonly slots: number;
  /** Distance: metres between points. */
  readonly distance?: number;
  /** Distance: which end the stations are measured from. */
  readonly anchor?: "start" | "end";
  /** Metres to slide every station along the strip. */
  readonly offset?: number;
  readonly rangeStart?: number;
  readonly rangeEnd?: number;
}

/** Where one output slot reads the input strip: between `index` and `next`, `t` of the way; padding when not live. */
export interface ResampleStation {
  readonly live: boolean;
  readonly index: number;
  readonly next: number;
  readonly t: number;
}

/** The input segment that holds the distance `d`: the largest point whose cumulative length is at or below it. */
function stationAtDistance(lengths: StripLengths, closed: boolean, d: number): Omit<ResampleStation, "live"> {
  const cols = lengths.cumulative.length;
  let low = 0;
  let high = cols - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lengths.cumulative[mid] as number) <= d) low = mid;
    else high = mid - 1;
  }
  const index = low;
  if (!closed && index >= cols - 1) return { index, next: index, t: 0 };
  const next = (index + 1) % cols;
  const end = index === cols - 1 ? lengths.total : (lengths.cumulative[index + 1] as number);
  const size = end - (lengths.cumulative[index] as number);
  const t = size > 0 ? Math.min(Math.max((d - (lengths.cumulative[index] as number)) / size, 0), 1) : 0;
  return { index, next, t };
}

/**
 * Where each output slot of one strip reads its input (the design's section 3.3).
 *
 * Every station is computed on its own from its slot number — a multiplication, never a
 * running sum — so slot k's place does not depend on the slots before it.
 */
export function resampleStations(lengths: StripLengths, options: ResampleOptions): ResampleStation[] {
  const cols = lengths.cumulative.length;
  const { closed, slots } = options;
  const rangeStart = options.rangeStart ?? 0;
  const rangeEnd = options.rangeEnd ?? 1;
  const offset = options.offset ?? 0;
  const loop = closed && rangeStart <= 0 && rangeEnd >= 1;
  const stations: ResampleStation[] = [];

  if (options.method === "count" && options.spacing === "parameter") {
    const span = closed ? cols : cols - 1;
    const from = rangeStart * span;
    const to = rangeEnd * span;
    for (let k = 0; k < slots; k += 1) {
      const x = loop ? (k / slots) * span : from + (slots > 1 ? k / (slots - 1) : 0) * (to - from);
      if (!closed && x >= span) {
        stations.push({ live: true, index: cols - 1, next: cols - 1, t: 0 });
        continue;
      }
      const index = Math.min(Math.max(Math.floor(x), 0), closed ? cols - 1 : Math.max(cols - 2, 0));
      stations.push({ live: true, index, next: (index + 1) % cols, t: Math.min(Math.max(x - index, 0), 1) });
    }
    return stations;
  }

  const total = lengths.total;
  const a = rangeStart * total;
  const b = rangeEnd * total;
  const range = Math.max(b - a, 0);
  const wrap = (d: number): number => (total > 0 ? d - Math.floor(d / total) * total : 0);

  if (options.method === "count") {
    for (let k = 0; k < slots; k += 1) {
      const d = loop
        ? offset === 0
          ? (k / slots) * total
          : wrap((k / slots) * total + offset)
        : Math.min(Math.max(a + (slots > 1 ? k / (slots - 1) : 0) * range + offset, a), b);
      stations.push({ live: true, ...stationAtDistance(lengths, closed, d) });
    }
    return stations;
  }

  const wanted = Math.max(options.distance ?? 0.1, 1e-6);
  if (loop) {
    const needed = Math.floor(total / wanted + RESAMPLE_END_TOLERANCE);
    const count = Math.max(Math.min(needed, slots), 1);
    const spacing = needed > slots ? total / slots : wanted;
    for (let k = 0; k < slots; k += 1) {
      const d = wrap(Math.min(k, count - 1) * spacing + offset);
      stations.push({ live: k < count, ...stationAtDistance(lengths, closed, d) });
    }
    return stations;
  }
  const needed = Math.floor(range / wanted + RESAMPLE_END_TOLERANCE) + 1;
  const spacing = needed > slots ? range / Math.max(slots - 1, 1) : wanted;
  const tolerance = spacing * RESAMPLE_END_TOLERANCE;
  const fromEnd = options.anchor === "end";
  const base = (fromEnd ? b : a) + offset;
  const lowest = Math.ceil((a - tolerance - base) / spacing);
  const highest = Math.floor((b + tolerance - base) / spacing);
  for (let k = 0; k < slots; k += 1) {
    const m = fromEnd ? k - (slots - 1) : k;
    const any = lowest <= highest;
    const live = any && m >= lowest && m <= highest;
    const d = any ? Math.min(Math.max(base + Math.min(Math.max(m, lowest), highest) * spacing, a), b) : Math.min(Math.max(base, a), b);
    stations.push({ live, ...stationAtDistance(lengths, closed, d) });
  }
  return stations;
}

/** Resample one strip's positions: the stations, read back as points and a `live` flag per slot. */
export function resampleStrip(points: ReadonlyArray<Vec3>, options: ResampleOptions): { positions: Vec3[]; live: number[] } {
  const stations = resampleStations(stripLengths(points, options.closed), options);
  return {
    positions: stations.map((station) => {
      const from = points[station.index] as Vec3;
      if (station.t === 0) return from;
      const to = points[station.next] as Vec3;
      return add(from, scale(sub(to, from), station.t));
    }),
    live: stations.map((station) => (station.live ? 1 : 0)),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────
 * Curve — control points to a strip (T1586b slice 2).
 *
 * A control strip of N points becomes a strip of `segments` points per SPAN. A span runs
 * from one control point to the next (the closing span of a closed strip included), and
 * every output point is computed on its own from at most four control points, so there is
 * no order to keep and no scan: point k of a strip does not depend on point k − 1.
 *
 * Which curves keep their length is the reason the Arc exists (the design's section 3.5):
 * a spline's length is whatever its control points make it, and it changes as they move;
 * an Arc's length is an INPUT, and Linear's is the sum of its chords.
 * ───────────────────────────────────────────────────────────────────────────────────── */

export const CURVE_BASES = ["linear", "catmullRom", "cardinal", "bspline", "bezier", "arc"] as const;
export type CurveBasis = (typeof CURVE_BASES)[number];

/**
 * The most control points a Curve node holds in its own table. A uniform-table limit: the
 * table reaches the shader as one vec4 a point, the way Ramp's stops do, and a longer
 * curve is wired from a pointset instead.
 */
export const CURVE_TABLE_LIMIT = 64;

/**
 * Bisection steps of the arc solve. Each halves an interval that starts π wide, so after
 * 24 it is 2e-7 wide: f32's resolution of an angle near 1, and the same count on the GPU.
 */
export const ARC_SOLVE_STEPS = 24;

export interface CurveOptions {
  readonly closed: boolean;
  readonly basis: CurveBasis;
  /** Output points per span. */
  readonly segments: number;
  /** Cardinal: 0 is Catmull-Rom's tangent, 1 flattens every tangent to nothing. */
  readonly tension?: number;
  /** B-Spline on an open strip: mirror the ends so the curve reaches its end control points. Default on. */
  readonly clamped?: boolean;
  /** Bezier: each control point's handles, relative to the point. */
  readonly handlesIn?: ReadonlyArray<Vec3>;
  readonly handlesOut?: ReadonlyArray<Vec3>;
  /** Arc: each span's length — one for all, or one per control point, read at the span's first. */
  readonly arcLength?: number | ReadonlyArray<number>;
  /** Arc: the length is in metres, or in chords (1 is straight, 1.2 has a fifth of slack). */
  readonly arcLengthUnit?: "metres" | "chords";
  /** Arc: the side each arc bulges to — one for all, or one per control point, read at the span's first. */
  readonly bow?: Vec3 | ReadonlyArray<Vec3>;
  /** Arc: the most an arc may turn, radians. Slack beyond it is not deployed. Default a full turn. */
  readonly maxTurn?: number;
}

type SpanShape = Pick<CurveOptions, "closed" | "basis" | "clamped">;

/** An unclamped B-Spline on an open strip is the one curve that does not reach its ends. */
const isUnclamped = (options: SpanShape): boolean => options.basis === "bspline" && options.clamped === false && !options.closed;

/** Spans a control strip of `controls` points makes. A closed strip needs two points to close. */
export function curveSpans(controls: number, options: SpanShape): number {
  if (controls < 2) return 0;
  if (options.closed) return controls;
  if (isUnclamped(options)) return Math.max(controls - 3, 0);
  return controls - 1;
}

/** Points per output strip: `segments` per span, and one more to end an open strip on. */
export function curvePointCount(controls: number, options: SpanShape & Pick<CurveOptions, "segments">): number {
  const spans = curveSpans(controls, options);
  if (spans === 0) return 1;
  return options.closed ? spans * options.segments : spans * options.segments + 1;
}

/** Where one output point sits: `u` of the way along `span`, between the control points `index` and `next`. */
export interface CurveStation {
  readonly span: number;
  readonly u: number;
  readonly index: number;
  readonly next: number;
}

/**
 * Where each output point of one strip sits. `index` and `next` are the two control points
 * every attribute other than position is blended between, linearly, so a radius or a
 * colour never overshoots the way a position's basis can. The last point of an open strip
 * is the END of the last span (`u` exactly 1), not the start of a span that does not exist.
 */
export function curveStations(controls: number, options: SpanShape & Pick<CurveOptions, "segments">): CurveStation[] {
  const spans = curveSpans(controls, options);
  if (spans === 0) return [{ span: 0, u: 0, index: 0, next: 0 }];
  const count = curvePointCount(controls, options);
  const shift = isUnclamped(options) ? 1 : 0;
  const stations: CurveStation[] = [];
  for (let k = 0; k < count; k += 1) {
    let span = Math.floor(k / options.segments);
    let u = (k % options.segments) / options.segments;
    if (span >= spans) {
      span = spans - 1;
      u = 1;
    }
    const index = span + shift;
    stations.push({ span, u, index, next: options.closed ? (index + 1) % controls : index + 1 });
  }
  return stations;
}

/** sin(x) / x, with its series where the quotient loses its digits. */
function sinc(x: number): number {
  return Math.abs(x) < 1e-3 ? 1 - (x * x) / 6 : Math.sin(x) / x;
}

/** One constant-curvature arc, solved: where it starts, which way it leaves and which way it bends. */
export interface SolvedArc {
  readonly start: Vec3;
  /** The length actually laid out: the length asked for, less any slack `maxTurn` would not let it bow. */
  readonly length: number;
  /** Half of the angle the arc turns through. 0 is a straight line. */
  readonly halfTurn: number;
  /** 1 / radius. */
  readonly curvature: number;
  /** The unit tangent at the start, and the unit direction from the start toward the centre. */
  readonly tangent: Vec3;
  readonly inward: Vec3;
}

/**
 * THE ARC: the one arc of constant curvature and a given length from `a` to `b`.
 *
 * For a length L and a chord c there is exactly one such arc up to which side it bows to:
 * its half turn φ solves sinc(φ) = c / L, and sinc only falls on [0, π], so φ is unique —
 * no branch to jump between, which is what a pop is (the consumer's finding, §T1561b).
 * `bow` picks the side, by its part SQUARE TO THE CHORD: a bow that sweeps through the
 * chord therefore flips the arc to the other side at once, and a bow kept off the chord
 * moves the arc continuously with its ends.
 *
 *  - taut or out of reach (L ≤ c): a straight line of length L from `a` toward `b`. The
 *    length is kept; the far end is not reached.
 *  - `maxTurn` caps the turn: slack that would bow the arc further is not laid out, so the
 *    arc is shorter than asked and still ends on `b`.
 *  - no chord (a = b): a circle through `a`, leaving square to `bow`.
 */
export function solveArc(a: Vec3, b: Vec3, wanted: number, bow: Vec3, maxTurn = 2 * Math.PI): SolvedArc {
  const chordVector = sub(b, a);
  const chordSquared = dot(chordVector, chordVector);
  let chord = 0;
  let along: Vec3;
  let side: Vec3;
  if (chordSquared > ZERO_SEGMENT_SQUARED) {
    chord = Math.sqrt(chordSquared);
    along = scale(chordVector, 1 / chord);
    side = seedNormal(along, bow);
  } else {
    side = dot(bow, bow) > 1e-12 ? unit(bow) : [0, -1, 0];
    along = seedNormal(side, leastAligned(side));
  }
  const maxHalf = Math.min(Math.max(maxTurn / 2, 0), Math.PI);
  let laid = Math.max(wanted, 0);
  // A full turn is no cap at all: sinc(π) is zero, and a chord divided by it is not a length.
  if (maxHalf < Math.PI - 1e-6) laid = Math.min(laid, chord / sinc(maxHalf));
  let halfTurn = 0;
  if (laid > 0 && chord < laid) {
    const share = chord / laid;
    let low = 0;
    let high = Math.PI;
    for (let step = 0; step < ARC_SOLVE_STEPS; step += 1) {
      const mid = (low + high) * 0.5;
      if (sinc(mid) > share) low = mid;
      else high = mid;
    }
    halfTurn = (low + high) * 0.5;
  }
  const cos = Math.cos(halfTurn);
  const sin = Math.sin(halfTurn);
  return {
    start: a,
    length: laid,
    halfTurn,
    curvature: laid > 0 ? (2 * halfTurn) / laid : 0,
    tangent: add(scale(along, cos), scale(side, sin)),
    inward: sub(scale(along, sin), scale(side, cos)),
  };
}

/** The point `s` metres along a solved arc. */
export function arcPoint(arc: SolvedArc, s: number): Vec3 {
  const angle = arc.curvature * s;
  // sin(κs)/κ and (1 − cos(κs))/κ, written so a straight arc (κ = 0) is exact.
  const forward = s * sinc(angle);
  const across = s * Math.sin(angle * 0.5) * sinc(angle * 0.5);
  return add(arc.start, add(scale(arc.tangent, forward), scale(arc.inward, across)));
}

/**
 * One strip of control points to one strip of curve points (positions only; every other
 * attribute is a linear blend at `curveStations`).
 *
 * The interpolating bases return a control point TO THE BIT where a span starts on one,
 * and every blend is written "point + share × difference", so repeated control points
 * cancel nothing and a straight, evenly spaced control strip gives exactly the line.
 */
export function evaluateCurve(controls: ReadonlyArray<Vec3>, options: CurveOptions): Vec3[] {
  const count = controls.length;
  const { closed, basis } = options;
  const spans = curveSpans(count, options);
  const at = (i: number): Vec3 => {
    if (closed) return controls[((i % count) + count) % count] as Vec3;
    // Past an open end: the neighbour mirrored through the end point.
    if (i < 0) return count < 2 ? (controls[0] as Vec3) : sub(scale(controls[0] as Vec3, 2), controls[1] as Vec3);
    if (i >= count) return count < 2 ? (controls[count - 1] as Vec3) : sub(scale(controls[count - 1] as Vec3, 2), controls[count - 2] as Vec3);
    return controls[i] as Vec3;
  };
  const tension = options.tension ?? 0;
  const arcLength = options.arcLength ?? 1;
  const bow = options.bow ?? ([0, -1, 0] as Vec3);
  const arcLengthAt = (i: number): number => (typeof arcLength === "number" ? arcLength : (arcLength[i] as number));
  const bowAt = (i: number): Vec3 => (typeof bow[0] === "number" ? (bow as Vec3) : ((bow as ReadonlyArray<Vec3>)[i] as Vec3));

  return curveStations(count, options).map(({ u, index, next }) => {
    const p1 = at(index);
    if (spans === 0) return p1;
    const p2 = at(next);
    if (basis === "arc") {
      const wanted = arcLengthAt(index) * (options.arcLengthUnit === "chords" ? length(sub(p2, p1)) : 1);
      const arc = solveArc(p1, p2, wanted, bowAt(index), options.maxTurn);
      return arcPoint(arc, u * arc.length);
    }
    if (basis === "bspline") {
      const p0 = at(index - 1);
      const p3 = at(index + 2);
      const v = 1 - u;
      const w0 = v * v * v;
      const w1 = 3 * u * u * u - 6 * u * u + 4;
      const w2 = -3 * u * u * u + 3 * u * u + 3 * u + 1;
      const w3 = u * u * u;
      return scale(add(add(scale(p0, w0), scale(p1, w1)), add(scale(p2, w2), scale(p3, w3))), 1 / 6);
    }
    if (u === 0) return p1;
    if (u === 1) return p2;
    if (basis === "linear") return add(p1, scale(sub(p2, p1), u));
    if (basis === "bezier") {
      const b1 = add(p1, options.handlesOut?.[index] ?? [0, 0, 0]);
      const b2 = add(p2, options.handlesIn?.[next] ?? [0, 0, 0]);
      const v = 1 - u;
      return add(add(scale(p1, v * v * v), scale(b1, 3 * v * v * u)), add(scale(b2, 3 * v * u * u), scale(p2, u * u * u)));
    }
    const p0 = at(index - 1);
    const p3 = at(index + 2);
    if (basis === "cardinal") {
      const m1 = scale(sub(p2, p0), (1 - tension) * 0.5);
      const m2 = scale(sub(p3, p1), (1 - tension) * 0.5);
      const h10 = u * u * u - 2 * u * u + u;
      const h01 = 3 * u * u - 2 * u * u * u;
      const h11 = u * u * u - u * u;
      return add(add(p1, scale(m1, h10)), add(scale(sub(p2, p1), h01), scale(m2, h11)));
    }
    // Catmull-Rom with centripetal knots (Barry and Goldman's pyramid): a knot gap is the
    // square root of the distance it spans, so unevenly spaced control points do not loop.
    const gap = (from: Vec3, to: Vec3): number => Math.max(Math.sqrt(length(sub(to, from))), 1e-12);
    const g01 = gap(p0, p1);
    const g12 = gap(p1, p2);
    const g23 = gap(p2, p3);
    const t = u * g12; // measured from the span's own start
    const a1 = add(p1, scale(sub(p1, p0), t / g01));
    const a2 = add(p1, scale(sub(p2, p1), t / g12));
    const a3 = add(p2, scale(sub(p3, p2), (t - g12) / g23));
    const b1 = add(a1, scale(sub(a2, a1), (t + g01) / (g01 + g12)));
    const b2 = add(a2, scale(sub(a3, a2), t / (g12 + g23)));
    return add(b1, scale(sub(b2, b1), t / g12));
  });
}

/** One row of a Curve node's own table: a control point, and what a sweep or a frame reads off it. */
export interface CurveTablePoint {
  readonly position: Vec3;
  /** Published as the `scale` attribute. Default 1. */
  readonly scale: number;
  /** Published as the `roll` attribute, in degrees. Default 0. */
  readonly roll: number;
}

/**
 * A Curve node's authored table, from its stored form: a JSON list with one entry per
 * control point — `[x, y, z]`, `[x, y, z, scale]` or `[x, y, z, scale, roll]`.
 *
 * Here and not in the node, because a CPU reader (the path follower, §T1590b) parses the
 * same parameter and must read the same points. A table it cannot read is refused with the
 * entry named; one over the limit is refused with the limit and the way round it, never
 * truncated — a curve that stops at its 64th point is a plausible wrong curve.
 */
export function parseCurveTable(raw: unknown): { readonly points: ReadonlyArray<CurveTablePoint> } | { readonly error: string } {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw.trim() === "" ? "[]" : raw);
    } catch (failure) {
      return { error: `the control points are not valid JSON (${failure instanceof Error ? failure.message : String(failure)})` };
    }
  }
  if (!Array.isArray(parsed)) return { error: "the control points must be a JSON list, one entry per point: [[x, y, z], …]" };
  if (parsed.length === 0) return { error: "the control point list is empty; a curve needs at least one point" };
  if (parsed.length > CURVE_TABLE_LIMIT) {
    return {
      error: `the table holds ${parsed.length} control points and the node carries ${CURVE_TABLE_LIMIT}; wire a longer control set in as a pointset instead`,
    };
  }
  const points: CurveTablePoint[] = [];
  for (const [at, entry] of parsed.entries()) {
    const numbers = Array.isArray(entry) ? (entry as unknown[]) : [];
    if (numbers.length < 3 || numbers.length > 5 || !numbers.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { error: `control point ${at} must be [x, y, z], [x, y, z, scale] or [x, y, z, scale, roll] with finite numbers` };
    }
    const [x, y, z, pointScale, roll] = numbers as number[];
    points.push({ position: [x as number, y as number, z as number], scale: pointScale ?? 1, roll: roll ?? 0 });
  }
  return { points };
}
