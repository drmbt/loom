/**
 * T1586b — CURVES ON THE CPU: the reference the curve nodes are tested against, and the
 * definition a CPU reader (the path follower, §T1590b) evaluates.
 *
 * A curve is a STRIP: a run of consecutive slots of a pointset, joined by straight
 * segments (`topology.ts`, `stripsOf`). Everything here takes one strip as an array of
 * points and answers what the GPU passes answer, by the same steps in the same order —
 * `nodes/shaders/curve.wgsl.ts` is this file in WGSL, and the Dawn tests hold the two
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
 *    the same on every device, and the same loop here and on the GPU.
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

/** Rule 2: the running sum of segment lengths, left to right, zero-length segments skipped. */
export function stripLengths(points: ReadonlyArray<Vec3>, closed: boolean): StripLengths {
  const cumulative: number[] = [];
  let distance = 0;
  const segments = segmentCount(points.length, closed);
  for (let k = 0; k < points.length; k += 1) {
    cumulative.push(distance);
    if (k >= segments) continue;
    const segment = segmentOf(points, k);
    const squared = dot(segment, segment);
    if (squared > ZERO_SEGMENT_SQUARED) distance += Math.sqrt(squared);
  }
  return { cumulative, total: distance };
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

/**
 * What Curve Frames publishes for one strip: distance, curvature and a frame per point.
 *
 * Two walks, as on the GPU. The first finds what every point needs before it can be
 * written: the strip's length, its first and last real segments, and (closed, Minimise
 * Twist) how far the frame has turned after one lap. The second writes the points, one RUN
 * of coincident points at a time.
 */
export function frameStrip(points: ReadonlyArray<Vec3>, options: StripFrameOptions): StripFrames {
  const cols = points.length;
  const { closed, method } = options;
  const segments = segmentCount(cols, closed);
  const upAt = (index: number): Vec3 => (isPerPoint(options.up) ? (options.up[index] as Vec3) : options.up);
  const carried = method === "minimiseTwist";
  const seedWanted: Vec3 = carried && options.seedOrient !== undefined ? rotateByQuat(options.seedOrient, [0, 1, 0]) : upAt(0);

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

  const tangent: Vec3[] = new Array<Vec3>(cols);
  const normal: Vec3[] = new Array<Vec3>(cols);
  const binormal: Vec3[] = new Array<Vec3>(cols);
  const orient: Quat[] = new Array<Quat>(cols);
  const distance: number[] = new Array<number>(cols);
  const curveU: number[] = new Array<number>(cols);
  const curvature: number[] = new Array<number>(cols);

  let closingAngle = 0;
  if (firstDirection !== undefined && closed && carried) {
    const lapped = turn(lastDirection, firstDirection, lapNormal).next;
    closingAngle = Math.atan2(dot(cross(seed, lapped), firstDirection), dot(seed, lapped));
  }
  const closing = options.closeTwist === false ? 0 : closingAngle;
  const roll = options.roll ?? 0;
  const twist = options.twist ?? 0;

  let previousNormal: Vec3 | undefined;
  const write = (from: number, to: number, runTangent: Vec3, runNormal: Vec3, at: number, bend: number): void => {
    for (let index = from; index <= to; index += 1) {
      let own = runNormal;
      if (!carried) {
        // Fixed Up: up made square to the tangent; where the tangent runs along up, the
        // point before it decides, and a world axis if there was none.
        let leaning = perpendicular(upAt(index), runTangent);
        if (dot(leaning, leaning) < 1e-12 && previousNormal !== undefined) leaning = perpendicular(previousNormal, runTangent);
        if (dot(leaning, leaning) < 1e-12) leaning = perpendicular(leastAligned(runTangent), runTangent);
        own = unit(leaning);
        previousNormal = own;
      }
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

  if (firstDirection === undefined) {
    // A strip of no length has no direction: its frame is the seed's and its metrics are zero.
    const z: Vec3 = carried && options.seedOrient !== undefined ? rotateByQuat(options.seedOrient, [0, 0, 1]) : [0, 0, 1];
    write(0, cols - 1, z, seedNormal(z, seedWanted), 0, 0);
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
      write(runStart, k, direction, seed, travelled, 0);
      carriedNormal = seed;
      started = true;
    } else {
      const crossing = turn(previousDirection, direction, carriedNormal);
      write(runStart, k, crossing.tangent, crossing.normal, travelled, turningCurvature(previousSegment, segment));
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
      write(runStart, cols - 1, crossing.tangent, crossing.normal, travelled, turningCurvature(previousSegment, firstSegment));
    } else {
      write(runStart, cols - 1, previousDirection, carriedNormal, travelled, 0);
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
