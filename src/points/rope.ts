import { ZERO_SEGMENT_SQUARED } from "./curve.ts";

/**
 * T1585b — A ROPE ON THE CPU: the reference the Rope node is tested against.
 *
 * A rope is a STRAND: one strip of a pointset (`topology.ts`, `stripsOf`), its points joined
 * by segments that keep their length. This file advances strands by one solver step, by the
 * same operations in the same order as `nodes/shaders/rope.wgsl.ts`, in single precision
 * (every result is rounded with `Math.fround`, as the device rounds it), and the Dawn tests
 * hold the two together. It is headless: no GPU, no node types, no clock.
 *
 * The method and the reasons for it are `docs/rope-solver-design-2026-10-05.md` (section 2).
 * In short:
 *
 * 1. THE STRETCH CONSTRAINTS OF A STRAND ARE SOLVED TOGETHER. Position-based dynamics
 *    relaxes one constraint at a time, and a correction then travels one segment per pass:
 *    1,182 sweeps to shrink a 54-link strand's error by a factor of e. But the linear system
 *    it is relaxing (Macklin, Müller, Chentanez 2016, eq. 16) is TRIDIAGONAL on a chain —
 *    segment i shares a point only with segments i − 1 and i + 1 — so forward elimination
 *    and back substitution solve it exactly, in one pass each along the strand. That is one
 *    Newton step of "every segment has its length"; it is repeated until they do.
 * 2. THE ORDER IS ALONG THE STRAND. One walk per strand, root to tip and back, the same
 *    loop here and on the GPU, where strands run side by side.
 * 3. AN ANCHOR IS A PULL, NOT A CONSTRAINT. A spring to a target, stepped implicitly, is
 *    the predicted point moved part of the way to the target and made that much heavier. A
 *    free point is no pull and a pinned point is all of it, so the system stays tridiagonal
 *    whatever is anchored.
 *
 * ## What one step does (the design's section 2.5)
 *
 *   predict    x̂ = x + h·v ÷ (1 + damping·h) + h²·gravity
 *   anchor     each anchored point is pulled to its target by its weight; a target out of
 *              reach of an earlier pin is drawn in to the rope's length
 *   stretch    Newton steps on the chain system, until every segment is within
 *              `ROPE_TOLERANCE` of its length or `iterations` have run
 *   velocity   v = (x̂ − x) ÷ h
 *   guard      a segment beyond Max Stretch is set to that limit; positions only
 *
 * The drag is the IMPLICIT one, a division, and not `exp(−damping·h)`: it is as stable, it
 * agrees to second order, and a division is rounded the same on the device and here where
 * an exponential is not.
 *
 * ## The step is TWO walks, and that is its cost
 *
 * Measured on Dawn before this was written (the design's D11): a walk's cost is its depth
 * times the loops it makes, about 0.7 µs a point a loop as built, and the first version
 * of this step made four (predict, eliminate, substitute, finish). So the predict is folded
 * into the elimination — a point is predicted as the forward sweep reaches it — and the
 * finish into the substitution, which writes each point's stored position and velocity as
 * it moves the point. A step that converges in one Newton step and breaks no stretch limit,
 * which is nearly every step, is then exactly two loops along the strand. More Newton steps
 * are two loops each, and the guard is a third loop only on a step that needs it.
 *
 * ## The bend limit (the design's 15.2 and section 17, slice 4)
 *
 * With Bend Limit on, no joint turns tighter than a circle of Min Bend Radius: a limit, and
 * not a spring. It is a constraint IN the solve, because the case it is for is a rope at
 * rest — a loop hanging between two pins closes under its own weight in every step, and a
 * correction the velocity never hears of is a rope still falling into its limit.
 *
 *  - THE ROW IS THE TURN ITSELF. The joint at point j turns by the angle between the two
 *    segments that meet there, and a circle of radius R through its three points turns it
 *    by `2·asin((a + b) ÷ 4R)`, `a` and `b` their rest lengths. So the row is
 *    `turn ≤ 2·asin((a + b) ÷ 4R)`, one-sided. Its gradient turns each of the two segments
 *    about the joint: on the point before, a unit vector square to the first segment over
 *    that segment's length; on the point after, the same for the second; on the joint, minus
 *    their sum.
 *  - WHY THE ANGLE, AND NOT A LENGTH THAT STANDS FOR IT. Two lengths were tried first, and
 *    each fails at one end of the range, in single precision. The distance between second
 *    neighbours is `2l·cos(turn ÷ 2)`: it moves with the SQUARE of a small turn, so on a
 *    strand cut into a thousand pieces, where the limit is a turn of a degree, the whole of
 *    it is less than a stored position's last place. The length of the curvature vector is
 *    `2·sin(turn ÷ 2)`: it stops moving as a fold nears 180°, and its gradient there points
 *    along the fold and not across it, so a sharp fold is rolled into a coil and not opened
 *    (seen: the consumer's loop, seeded as a V, came to rest with a full turn in it). The
 *    angle moves evenly from 0 to 180°.
 *  - A STEP OF THE SOLVE TURNS A JOINT BY AT MOST `ROPE_BEND_STEP`. A fold far past its
 *    limit is a long way from where the rows were linearised.
 *  - ONE SYSTEM. Rows in strand order — the joint at point k, then the segment after it —
 *    each share a point with at most four rows either side, so the matrix is symmetric,
 *    positive definite and banded, and an LDLᵀ elimination without pivoting solves it in one
 *    walk out and one walk back, as the chain alone is solved. A joint's row is in the
 *    system while it is past its limit, or while it has pushed the strand straighter earlier
 *    in the same step; out of it, it is a row of the identity.
 *  - THE ROWS ARE COMPLIANT (the design's D30). A joint gives by `ROPE_BEND_SOFTENING` of the
 *    diagonal its rest lengths give its row, times what it has pushed: on the diagonal, and
 *    with its multiplier on the right-hand side, as a segment with Stretch has. So a step has
 *    a fixed point whatever the rows ask, and it converges as the chain alone does. What it
 *    costs is exactness: a resting joint stands past its limit by its compliance times the
 *    moment it carries, 1.0001 of the limit on a loop of 55 points and 1.03 on one of 250.
 *  - LENGTH BEFORE BEND (D36). Between two held ends with less rope than a turn of that
 *    radius takes, the limit cannot be met and its rows push the strand against its own pins.
 *    A step that ends with a segment beyond Max Stretch is solved again from where its points
 *    were placed with no joint in the system; where that cannot be finished either, a third
 *    time as it was the first. What is NOT closed: short of that, a strand in such a pose
 *    does not come to rest (the design's 17.8).
 *  - It is another program, behind a switch: with Bend Limit off a step is the tridiagonal
 *    one below, with none of this in it.
 *
 * ## Anchors (the design's section 4, as built in slice 2)
 *
 * Three STATIONS of a strand may be anchored — its first point, its second and its last —
 * each by a weight from 0 to 1 that is a number or, mapped, an attribute read at that
 * strand's own station: a weight per strand. A PIN ATTRIBUTE is a weight on every point. A
 * point takes the larger of the two.
 *
 *  - The TARGET of an anchored point is the incoming point of its own slot, walked in a
 *    straight line across a frame's steps. Its history is kept for the three stations (and
 *    for every point under a pin attribute) whether or not the weight is above zero, so a
 *    weight that rises from nothing finds a target that was already being followed.
 *  - HARD, a weight of 1 is the target itself: the point has no inverse mass, and what is
 *    stored for it is the target, to the bit, ALWAYS (the design's D31): a held point that
 *    directly follows a held point is where it is told to be, however far apart the two are
 *    told to be, because the segment between them has nothing it can move. That is so wherever the weight comes from, a
 *    station's number, its map or the pin attribute, and for a weight within a millionth
 *    of 1 (`ROPE_HELD_FROM`). Below that it is a spring of stiffness
 *    `M·(2π·strength)²·a ÷ (1 − a)`, which stiffens without bound as the weight nears 1.
 *    SOFT, the stiffness is `M·(2π·strength)²·a` and a weight of 1 is still a spring.
 *  - `M` IS THE MASS THE ANCHOR CARRIES (the design's D19): the strand's, for a station, and
 *    the point's own for a pin attribute, where every point is held and carries only itself.
 *    Sized by one point's mass, a strand of 55 hangs 3.4 m below a half-weighted anchor.
 *  - THE EARLIER PIN WINS (the design's 4.6), across points the solve can move. A target
 *    further from the nearest earlier hard pin than the rope between them, times
 *    `1 + Max Stretch`, is drawn in to that reach along the line to it: length is kept and
 *    the target is not. The rope keeps its length where it is free to have one.
 *  - Between two anchors a taut, straight strand makes the chain system singular, so with
 *    two or more anchored stations (or a pin attribute) each pivot carries `ROPE_PIN_SOFTENING`.
 *    With one anchor or none it is zero, and a hanging strand is an exact fixed point.
 */

/** A segment is at its length when within this share of it: 1/8192, 7 µm on a 60 mm segment. */
export const ROPE_TOLERANCE = 1 / 8192;

/** Metres added to that, so a segment of no rest length has a tolerance at all. */
export const ROPE_TOLERANCE_FLOOR = 1e-7;

/**
 * A weight this near 1, or nearer, IS 1: within a millionth (2⁻²⁰). A weight that is
 * computed — `mix(a, 1.0, s)` at `s = 1` — can land one rounding short of 1 in single
 * precision, and under Hard that is a very stiff pull where a hold was meant.
 */
export const ROPE_HELD_FROM = 1 - 2 ** -20;

/** The most Newton steps one solver step may take. */
export const ROPE_MAX_ITERATIONS = 8;

/** The longest strand one walk covers (the design's R1): the curve family's block. */
export const ROPE_MAX_STRAND_POINTS = 1024;

/**
 * What each pivot of the chain system is raised by, as a share of it, on a strand with two
 * or more anchors: 2⁻¹². A taut, straight strand between two pins has a tension the
 * constraints do not determine, and the system is then singular without it.
 */
export const ROPE_PIN_SOFTENING = 2 ** -12;

/**
 * A bend row's COMPLIANCE, as a share of the diagonal its rest lengths give it: 2⁻¹⁰. A
 * joint at its limit gives by this times what it has pushed, as a segment with Stretch
 * gives by its tension. So the system has an answer where the limit cannot be met, and it
 * says who gives: length and pins hold, and the bend gives.
 *
 * It is a compliance and not a raised pivot (the design's D30). Raised alone, with nothing
 * on the right-hand side, the limit was exact where it could be met, but a step had no
 * fixed point where it could not, and the multiplier grew at every Newton step: measured,
 * a point thrown 0.78 m in a frame with the far pin at 8 m/s. And a resting bend of thirty
 * joints never converged, eight Newton steps in every step.
 */
export const ROPE_BEND_SOFTENING = 2 ** -10;

/**
 * A joint is at its limit when its turn is within this share of it: 1/8192, as a segment is
 * at its length. A turn levers the rope beyond it, so a looser one shows: at a thousandth,
 * a loop a metre and a half deep shimmered by a millimetre a frame.
 */
export const ROPE_BEND_TOLERANCE = 1 / 8192;

/**
 * A joint within this share BELOW its limit is taken into the system too, asked for no
 * change: 2⁻¹⁰. Without it a joint the solve has set a hair inside its limit is free until
 * gravity brings it back, each joint of a resting bend on a step of its own, and the bend
 * chatters. A joint so held that would rather open is let go within the same step.
 */
export const ROPE_BEND_BAND = 2 ** -10;

/**
 * Metres added to that on each of a joint's three points: what a stored position's own
 * spacing can put into a second difference, two to four metres along a strand.
 */
export const ROPE_BEND_FLOOR = 2 ** -21;

/** A pivot of the banded system is kept at least this share of its row's own diagonal. */
export const ROPE_PIVOT_FLOOR = 2 ** -12;

/** Radians: the most one Newton step asks a joint to turn back by. */
export const ROPE_BEND_STEP = 0.5;

const f = Math.fround;
const TAU = f(6.283185307179586);

/** What a step reads besides the state: the node's parameters, as the shader's uniform block holds them. */
export interface RopeParameters {
  /** The most Newton steps a step takes, 1 to `ROPE_MAX_ITERATIONS`. */
  readonly iterations: number;
  /** Scales the time a step advances. 0 holds the rope still. */
  readonly speed: number;
  /** m/s², toward −Y. */
  readonly gravity: number;
  /** Per second: how fast a point's velocity falls away. */
  readonly damping: number;
  /** Kilograms per point. */
  readonly mass: number;
  /** Metres between a point and the next. 0 takes each segment's length as measured when the strand was seeded. */
  readonly segmentLength: number;
  /** Multiplies every rest length. */
  readonly restLengthScale: number;
  /** Compliance: the fraction a segment lengthens per newton of tension. 0 does not stretch. */
  readonly stretch: number;
  /** The most a segment may be longer or shorter than its rest length at the end of a step, as a fraction. */
  readonly maxStretch: number;
  /** The rope does not bend tighter than `minBendRadius`. Structure: with it on, a step is another solve. */
  readonly bendLimit: boolean;
  /** Metres: the radius of the tightest curve the rope makes while `bendLimit` is on. */
  readonly minBendRadius: number;
  /** How firmly each strand's first point is held to its incoming point, 0 to 1. */
  readonly anchorFirst: number;
  /** The same for its second point: with the first, the direction the strand leaves in. */
  readonly anchorSecond: number;
  /** The same for its last point. */
  readonly anchorLast: number;
  /** Hard: a weight of 1 is the target itself. Soft: a weight of 1 is a spring of `anchorStrength`. */
  readonly anchorMode: "hard" | "soft";
  /** How fast a soft or partly weighted anchor draws its strand in, in Hz. */
  readonly anchorStrength: number;
  /** The damping ratio of that pull; 1 arrives without springing. */
  readonly anchorDamping: number;
  /** Holds the rope on its incoming points, at rest, for as long as it is on. */
  readonly reset: boolean;
  /** Metres an anchored first point's target may move in one frame before the strand is teleported. 0 is never. */
  readonly teleportDistance: number;
  /** What a teleport does: move the strand's whole state by the jump, or put it on its incoming points. */
  readonly teleportMode: "carry" | "reset";
}

export const ROPE_DEFAULTS: RopeParameters = {
  iterations: 4,
  speed: 1,
  gravity: 9.81,
  damping: 0.5,
  mass: 1,
  segmentLength: 0,
  restLengthScale: 1,
  stretch: 0,
  maxStretch: 0.02,
  bendLimit: false,
  minBendRadius: 0.15,
  anchorFirst: 1,
  anchorSecond: 0,
  anchorLast: 0,
  anchorMode: "hard",
  anchorStrength: 2,
  anchorDamping: 1,
  reset: false,
  teleportDistance: 0,
  teleportMode: "carry",
};

/**
 * The state of `rows` strands of `cols` points. Vectors are four floats a point, as the
 * packed point buffer lays a vec3f out, so a region read back from the device compares
 * word for word.
 */
export interface RopeState {
  readonly cols: number;
  readonly rows: number;
  position: Float32Array;
  velocity: Float32Array;
  /** Newtons in the segment after each point; 0 on a strand's last point. */
  tension: Float32Array;
  /**
   * What the solver keeps for itself, eight floats a point: the target the point's anchor had
   * at the end of the last frame (x, y, z); the length of the segment AFTER the point as
   * measured when the strand was seeded; and how fast that target was moving then, in metres
   * a second (x, y, z, and a spare). Written when a strand is seeded and, for an anchored
   * point, once a frame; not part of what a step carries from run to run.
   */
  readonly kept: Float32Array;
}

export function createRopeState(cols: number, rows: number): RopeState {
  const points = cols * rows;
  return {
    cols,
    rows,
    position: new Float32Array(points * 4),
    velocity: new Float32Array(points * 4),
    tension: new Float32Array(points),
    kept: new Float32Array(points * 8),
  };
}

/**
 * What a step reads per point besides the incoming position: the attributes a parameter in
 * Map mode names, one float a point as the device reads them (a station's map is read at
 * that strand's own station), and the pin attribute, a weight on every point.
 */
export interface RopeMaps {
  readonly anchorFirst?: Float32Array;
  readonly anchorSecond?: Float32Array;
  readonly anchorLast?: Float32Array;
  readonly pin?: Float32Array;
}

/** One run of the step: the backend's numbers for one dispatch of a stepped pass. */
export interface RopeRun {
  /** The frame's step divided by its substep count. */
  readonly deltaSeconds: number;
  /** Which substep of the frame this is, and of how many. */
  readonly substep: number;
  readonly substeps: number;
  /** The state was just created or cleared: this run seeds. */
  readonly firstRun: boolean;
}

/** What a run writes: the three regions of the node's packed pair, for every strand. */
interface RopeWrite {
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  readonly tension: Float32Array;
}

type Vec3 = [number, number, number];

const at = (values: Float32Array, point: number): Vec3 => [values[point * 4] as number, values[point * 4 + 1] as number, values[point * 4 + 2] as number];
const put = (values: Float32Array, point: number, value: Vec3): void => {
  values[point * 4] = value[0];
  values[point * 4 + 1] = value[1];
  values[point * 4 + 2] = value[2];
};
const sub = (a: Vec3, b: Vec3): Vec3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const add = (a: Vec3, b: Vec3): Vec3 => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
const scale = (a: Vec3, s: number): Vec3 => [f(a[0] * s), f(a[1] * s), f(a[2] * s)];
const divide = (a: Vec3, s: number): Vec3 => [f(a[0] / s), f(a[1] / s), f(a[2] / s)];
const dot = (a: Vec3, b: Vec3): number => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));

/** Puts a strand on its incoming points, at rest, and measures its segments. */
function seedStrand(state: RopeState, next: RopeWrite, incoming: Float32Array, base: number): void {
  const cols = state.cols;
  for (let i = 0; i < cols; i += 1) {
    const slot = base + i;
    const here = at(incoming, slot);
    put(next.position, slot, here);
    put(next.velocity, slot, [0, 0, 0]);
    next.tension[slot] = 0;
    let rest = 0;
    if (i + 1 < cols) {
      const span = sub(at(incoming, slot + 1), here);
      rest = f(Math.sqrt(dot(span, span)));
    }
    put(state.kept, slot * 2, here);
    state.kept[slot * 8 + 3] = rest;
    put(state.kept, slot * 2 + 1, [0, 0, 0]);
  }
}

/** A step of no length: every word a run writes is carried over as it is. */
function holdStrand(state: RopeState, next: RopeWrite, base: number): void {
  for (let i = 0; i < state.cols; i += 1) {
    const slot = base + i;
    put(next.position, slot, at(state.position, slot));
    put(next.velocity, slot, at(state.velocity, slot));
    next.tension[slot] = state.tension[slot] as number;
  }
}

/** A segment's unit direction and how far it is from its length; none of either when it has no extent. */
function segment(lower: Vec3, upper: Vec3, rest: number): { readonly direction: Vec3; readonly error: number; readonly size: number } {
  const span = sub(upper, lower);
  const squared = dot(span, span);
  if (!(squared > ZERO_SEGMENT_SQUARED)) return { direction: [0, 0, 0], error: 0, size: 0 };
  const size = f(Math.sqrt(squared));
  return { direction: divide(span, size), error: f(size - rest), size };
}

/**
 * A joint's turn and its gradient, from the unit directions and lengths of the two segments
 * that meet at it: on the point before the joint, on the joint, and on the point after.
 * `null` where the turn has no side to open to: no turn at all, or a fold of exactly 180°.
 */
function hinge(
  first: Vec3,
  firstSize: number,
  second: Vec3,
  secondSize: number,
): { readonly low: Vec3; readonly middle: Vec3; readonly high: Vec3; readonly turn: number } | null {
  if (!(firstSize > 0 && secondSize > 0)) return null;
  const cosine = dot(first, second);
  // Each square to its own segment, in the plane of the two: where turning that segment about the joint moves its far end.
  const acrossFirst = sub(second, scale(first, cosine));
  const acrossSecond = sub(first, scale(second, cosine));
  const sineSquared = dot(acrossFirst, acrossFirst);
  if (!(sineSquared > ZERO_SEGMENT_SQUARED)) return null;
  const sine = f(Math.sqrt(sineSquared));
  const low = scale(divide(acrossFirst, sine), f(1 / firstSize));
  const high = scale(divide(acrossSecond, sine), f(-1 / secondSize));
  const apart = sub(second, first);
  const together = add(second, first);
  const turn = f(2 * f(Math.atan2(f(Math.sqrt(dot(apart, apart))), f(Math.sqrt(dot(together, together))))));
  return { low, middle: scale(add(low, high), -1), high, turn };
}

function stepStrand(
  state: RopeState,
  next: RopeWrite,
  incoming: Float32Array,
  parameters: RopeParameters,
  run: RopeRun,
  strand: number,
  maps: RopeMaps,
): void {
  const cols = state.cols;
  const base = strand * cols;
  const segments = cols - 1;
  const h = f(f(run.deltaSeconds) * f(parameters.speed));
  if (run.firstRun || parameters.reset) {
    seedStrand(state, next, incoming, base);
    return;
  }
  if (!(h > 0)) {
    holdStrand(state, next, base);
    return;
  }

  // ── The strand's three stations: how firmly each is held, as a number or by its map ──
  /** A weight as the step reads it: 0 to 1, and 1 from `ROPE_HELD_FROM` up. */
  const held = (raw: number): number => (f(raw) >= ROPE_HELD_FROM ? 1 : f(Math.min(1, Math.max(0, raw))));
  const firstWeight = held(maps.anchorFirst === undefined ? parameters.anchorFirst : (maps.anchorFirst[base] as number));
  const secondWeight = segments > 0 ? held(maps.anchorSecond === undefined ? parameters.anchorSecond : (maps.anchorSecond[base + 1] as number)) : 0;
  const lastWeight = segments > 0 ? held(maps.anchorLast === undefined ? parameters.anchorLast : (maps.anchorLast[base + segments] as number)) : 0;
  const pinned = maps.pin !== undefined;
  const hard = parameters.anchorMode !== "soft";
  let stations = 0;
  if (firstWeight > 0) stations += 1;
  if (secondWeight > 0) stations += 1;
  if (lastWeight > 0) stations += 1;
  const anchored = stations > 0 || pinned;
  // Two anchors can hold a taut strand between them, whose tension the constraints leave open.
  const softening = stations > 1 || pinned ? f(ROPE_PIN_SOFTENING) : 0;

  // ── A teleport is judged on the first point's target: where it is now, and a frame ago ──
  const targetFirst = at(incoming, base);
  let beforeFirst = at(state.kept, base * 2);
  const rateWas = at(state.kept, base * 2 + 1);
  let jump: Vec3 = [0, 0, 0];
  let jumped = false;
  const teleport = f(parameters.teleportDistance);
  // The frame's whole step: an anchor's target moves in frame time, whatever Simulation Speed is.
  const frameSeconds = f(f(run.deltaSeconds) * run.substeps);
  if (anchored && run.substep === 0 && teleport > 0) {
    const moved = sub(targetFirst, beforeFirst);
    if (dot(moved, moved) > f(teleport * teleport)) {
      if (parameters.teleportMode === "reset") {
        seedStrand(state, next, incoming, base);
        return;
      }
      // Carry: the strand goes with the jump, and its anchors are not dragged across it. What
      // the first target travels in this frame at the speed it had is NOT part of the jump:
      // it is taken to have come from where that speed puts it, so a body that wraps its
      // world while moving keeps moving through the wrap. Every other target's history goes
      // with the strand, by the same jump.
      const start = sub(targetFirst, scale(rateWas, frameSeconds));
      jump = sub(start, beforeFirst);
      beforeFirst = start;
      jumped = true;
    }
  }
  const lastSubstep = run.substep + 1 === run.substeps;

  // The walk works relative to the strand's first point, so a strand far from the origin
  // does the arithmetic of one at it.
  const originWas = at(state.position, base);
  const origin = add(originWas, jump);

  const inverseMass = f(1 / parameters.mass);
  const keep = f(1 / f(1 + f(f(parameters.damping) * h)));
  const drop = f(f(f(parameters.gravity) * h) * h);
  const restScale = f(parameters.restLengthScale);
  const stretch = f(parameters.stretch);
  const hh = f(h * h);
  const limit = f(parameters.maxStretch);
  // A segment cannot be shorter than nothing: past a Max Stretch of 1 only the long side limits.
  const shortest = f(Math.max(0, f(1 - limit)));
  const turn = f(f(TAU * f(parameters.anchorStrength)) * h);
  const ratio = f(2 * f(parameters.anchorDamping));

  // The device's scratch: the working copy, each point's inverse mass, and per segment the
  // elimination's two coefficients and the multiplier summed over the Newton steps.
  const work: Vec3[] = new Array<Vec3>(cols);
  const inverse = new Float32Array(cols);
  const upper = new Float32Array(Math.max(1, segments));
  const reduced = new Float32Array(Math.max(1, segments));
  const multiplier = new Float32Array(Math.max(1, segments));

  const startOf = (i: number): Vec3 => sub(at(state.position, base + i), originWas);
  /** Where a point would be after this step with nothing holding it. */
  const predict = (i: number): Vec3 => {
    const x = startOf(i);
    const v = scale(at(state.velocity, base + i), keep);
    return [f(x[0] + f(v[0] * h)), f(f(x[1] + f(v[1] * h)) - drop), f(x[2] + f(v[2] * h))];
  };
  const given = f(parameters.segmentLength);
  const restOf = (k: number): number => f((given > 0 ? given : (state.kept[(base + k) * 8 + 3] as number)) * restScale);
  const softness = (rest: number): number => f(f(stretch * rest) / hh);

  /** The nearest hard pin the walk has passed, and how much rope there is from it to here. */
  let pinAt: Vec3 = [0, 0, 0];
  let hasPin = false;
  let reach = 0;
  /** Whether a point the solve can move has been placed since that pin. */
  let free = false;
  /** The last hard pin on the strand, by point; −1 when it has none. */
  let lastPin = -1;

  /**
   * Predict point `i`, pull it by its anchor, and hand the solve its working position and its
   * inverse mass. A hard pin is STORED here, as its target, and the solve does not move it.
   */
  const place = (i: number): void => {
    const slot = base + i;
    const start = startOf(i);
    let placed = predict(i);
    let weighs = inverseMass;
    const station = i === 0 ? firstWeight : Math.max(i === 1 ? secondWeight : 0, i === segments ? lastWeight : 0);
    const isStation = i <= 1 || i === segments;
    if (isStation || pinned) {
      // The target's history is kept whatever the weight is, so one that rises from nothing
      // finds a target that was already being followed.
      const now = at(incoming, slot);
      const before = i === 0 ? beforeFirst : jumped ? add(at(state.kept, slot * 2), jump) : at(state.kept, slot * 2);
      const travelled = sub(now, before);
      const here = lastSubstep ? now : add(before, scale(travelled, f((run.substep + 1) / run.substeps)));
      const was = add(before, scale(travelled, f(run.substep / run.substeps)));
      if (lastSubstep) put(state.kept, slot * 2, now);
      else if (jumped || i === 0) put(state.kept, slot * 2, before);
      if (i === 0 && lastSubstep) put(state.kept, slot * 2 + 1, divide(travelled, frameSeconds));

      const pin = pinned ? held((maps.pin as Float32Array)[slot] as number) : 0;
      const weight = Math.max(station, pin);
      if (weight > 0) {
        const hereLocal = sub(here, origin);
        let goal = hereLocal;
        let drawnIn = false;
        const pins = hard && weight >= 1;
        // The earlier pin wins: a target out of its reach is drawn in along the line to it.
        // Not a hard pin that follows a hard pin with nothing movable between them: no
        // segment there has anything to solve, and a held point is where it is told to be.
        if (hasPin && (free || !pins)) {
          const span = sub(goal, pinAt);
          const squared = dot(span, span);
          if (squared > f(reach * reach)) {
            goal = add(pinAt, scale(span, f(reach / f(Math.sqrt(squared)))));
            drawnIn = true;
          }
        }
        if (pins) {
          placed = goal;
          weighs = 0;
          free = false;
          put(next.position, slot, drawnIn ? add(goal, origin) : here);
          put(next.velocity, slot, divide(sub(goal, start), h));
          pinAt = goal;
          hasPin = true;
          reach = 0;
          lastPin = i;
        } else {
          // A spring to the target, stepped implicitly: part of the way there, and heavier.
          // Sized for the mass it carries: the strand's for a station, the point's for a pin.
          const gain = hard ? f(weight / f(1 - weight)) : weight;
          const carried = station > 0 && station >= pin ? f(cols) : 1;
          const pull = f(f(f(turn * turn) * gain) * carried);
          const drag = f(f(f(ratio * turn) * f(Math.sqrt(gain))) * carried);
          const total = f(f(1 + pull) + drag);
          const damper = add(start, sub(hereLocal, sub(was, origin)));
          placed = divide(add(add(placed, scale(goal, pull)), scale(damper, drag)), total);
          weighs = f(weighs / total);
        }
      }
    }
    if (weighs > 0) free = true;
    work[i] = placed;
    inverse[i] = weighs;
  };

  place(0);
  next.tension[base + segments] = 0;
  if (segments === 0) {
    if ((inverse[0] as number) > 0) {
      put(next.position, base, add(work[0] as Vec3, origin));
      put(next.velocity, base, divide(sub(work[0] as Vec3, startOf(0)), h));
    }
    return;
  }

  const iterations = Math.min(ROPE_MAX_ITERATIONS, Math.max(1, Math.round(parameters.iterations)));
  let exceeded = false;

  // ── Bend Limit on: the stretch rows and the limit's active rows, one banded system ──
  const bend = parameters.bendLimit === true;
  if (bend) {
    const radius = f(Math.max(parameters.minBendRadius, 1e-6));
    /** The most |κ| a joint between segments of rest lengths `a` and `b` may have. */
    const mostOf = (a: number, b: number): number => f(Math.min(2, f(f(a + b) / f(2 * radius))));
    /**
     * What the joint at point j gives by, per unit it has pushed: the softening's share of
     * the diagonal its REST lengths give its row, so the sweep back can ask for it as well.
     */
    const giveOf = (j: number, a: number, b: number): number => {
      const near = f(1 / a);
      const far = f(1 / b);
      const both = f(near + far);
      return f(
        ROPE_BEND_SOFTENING *
          f(f(f((inverse[j - 1] as number) * f(near * near)) + f((inverse[j] as number) * f(both * both))) + f((inverse[j + 1] as number) * f(far * far))),
      );
    };
    /** λ of the joint at each point, summed over the Newton steps: below zero, it has pushed the strand straighter. */
    const turned = new Float32Array(cols);
    /** Per row — the joint at point k is row 2k, the segment after it row 2k + 1 — the solved right-hand side and four multipliers. */
    const rowZ = new Float32Array(2 * cols);
    const rowL = new Float32Array(8 * cols);
    /** Where each point was placed, for a step that has to be solved again. */
    const placedAt: Vec3[] = new Array<Vec3>(cols);
    placedAt[0] = work[0] as Vec3;
    // LENGTH BEFORE BEND. A step that ends with a segment beyond Max Stretch is one the solve
    // could not finish with the limit in it: a limit that cannot be met pushes the strand
    // against its own pins. It is solved again from where its points were placed, with no
    // joint in the system: the rope keeps its length and its pins, and the bend gives.
    // Where that step cannot be finished either — a step too coarse for the strand, limit or
    // no limit — the first answer is the better one to hand the guard, and it is solved a
    // third time as it was the first.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const limited = attempt !== 1;
      if (attempt > 0) work[0] = placedAt[0] as Vec3;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        // The elimination's window: the last four rows' pivots, right-hand sides, and the
        // multipliers between them. Before the first row it is four rows of the identity.
        let d1 = 1;
        let d2 = 1;
        let d3 = 1;
        let d4 = 1;
        let z1 = 0;
        let z2 = 0;
        let z3 = 0;
        let z4 = 0;
        let m12 = 0;
        let m13 = 0;
        let m14 = 0;
        let m23 = 0;
        let m24 = 0;
        let m34 = 0;
        /** One row of LDLᵀ: its couplings to the four rows before it, its diagonal, its right-hand side. */
        const eliminate = (row: number, a1: number, a2: number, a3: number, a4: number, diagonal: number, right: number): void => {
          const u4 = a4;
          const u3 = f(a3 - f(m34 * u4));
          const u2 = f(f(a2 - f(m23 * u3)) - f(m24 * u4));
          const u1 = f(f(f(a1 - f(m12 * u2)) - f(m13 * u3)) - f(m14 * u4));
          const l1 = f(u1 / d1);
          const l2 = f(u2 / d2);
          const l3 = f(u3 / d3);
          const l4 = f(u4 / d4);
          const pivot = f(Math.max(f(diagonal - f(f(f(f(l1 * u1) + f(l2 * u2)) + f(l3 * u3)) + f(l4 * u4))), f(diagonal * ROPE_PIVOT_FLOOR)));
          const z = f(right - f(f(f(f(l1 * z1) + f(l2 * z2)) + f(l3 * z3)) + f(l4 * z4)));
          rowL[row * 4] = l1;
          rowL[row * 4 + 1] = l2;
          rowL[row * 4 + 2] = l3;
          rowL[row * 4 + 3] = l4;
          rowZ[row] = f(z / pivot);
          d4 = d3;
          d3 = d2;
          d2 = d1;
          d1 = pivot;
          z4 = z3;
          z3 = z2;
          z2 = z1;
          z1 = z;
          m34 = m23;
          m24 = m13;
          m23 = m12;
          m14 = l3;
          m13 = l2;
          m12 = l1;
        };

        // Forward: each point is placed as the sweep reaches it (the first time through), then
        // the joint at point k and the segment after it are eliminated, in that order.
        let lower = work[0] as Vec3;
        let directionWas: Vec3 = [0, 0, 0];
        let directionBefore: Vec3 = [0, 0, 0];
        let sizeWas = 0;
        let restWas = 0;
        // The gradient of the joint before this one on its own point and on the point after it, and of the one before that on the point after it.
        let middleWas: Vec3 = [0, 0, 0];
        let highWas: Vec3 = [0, 0, 0];
        let highBefore: Vec3 = [0, 0, 0];
        for (let k = 0; k < segments; k += 1) {
          const rest = restOf(k);
          if (iteration === 0) {
            if (attempt === 0) {
              reach = f(reach + f(rest * f(1 + limit)));
              place(k + 1);
              placedAt[k + 1] = work[k + 1] as Vec3;
            } else {
              work[k + 1] = placedAt[k + 1] as Vec3;
            }
            multiplier[k] = 0;
            turned[k] = 0;
          }
          const higher = work[k + 1] as Vec3;
          const wBefore = k > 0 ? (inverse[k - 1] as number) : 0;
          const wLow = inverse[k] as number;
          const wHigh = inverse[k + 1] as number;
          const { direction, error, size } = segment(lower, higher, rest);

          // The joint at point k: in the system while it is past its limit, or has pushed.
          let middle: Vec3 = [0, 0, 0];
          let high: Vec3 = [0, 0, 0];
          let b1 = 0;
          let b2 = 0;
          let b3 = 0;
          let b4 = 0;
          let bDiagonal = 1;
          let bRight = 0;
          if (limited && k > 0 && restWas > 0 && rest > 0 && f(f(wBefore + wLow) + wHigh) > 0) {
            const apart = sub(direction, directionWas);
            const gap = dot(apart, apart);
            const most = mostOf(restWas, rest);
            const nearly = f(most * f(1 - ROPE_BEND_BAND));
            const pushed = turned[k] as number;
            // Past its limit; or it has pushed in this step; or it is within the band and has not yet been let go.
            if (gap > f(most * most) || pushed < 0 || (pushed === 0 && gap > f(nearly * nearly))) {
              const joint = hinge(directionWas, sizeWas, direction, size);
              if (joint !== null) {
                const low = joint.low;
                middle = joint.middle;
                high = joint.high;
                const give = giveOf(k, restWas, rest);
                bDiagonal = f(f(f(f(wBefore * dot(low, low)) + f(wLow * dot(middle, middle))) + f(wHigh * dot(high, high))) + give);
                // Back to its limit and no further, a part of the way at a time; a joint inside it is
                // asked for nothing. And it gives by what it has pushed so far.
                bRight = f(f(Math.max(f(Math.min(f(f(2 * f(Math.asin(f(most / 2)))) - joint.turn), 0)), -ROPE_BEND_STEP)) - f(give * f(Math.min(pushed, 0))));
                // With the segment before it, the joint before it, and the segment and joint before those.
                b1 = f(f(wLow * dot(middle, directionWas)) - f(wBefore * dot(low, directionWas)));
                b2 = f(f(wBefore * dot(low, middleWas)) + f(wLow * dot(middle, highWas)));
                b3 = f(wBefore * dot(low, directionBefore));
                b4 = f(wBefore * dot(low, highBefore));
              }
            }
          }
          eliminate(2 * k, b1, b2, b3, b4, bDiagonal, bRight);

          // The segment after point k.
          const sum = f(wLow + wHigh);
          let s1 = 0;
          let s2 = 0;
          let s3 = 0;
          let sDiagonal = 1;
          let sRight = 0;
          if (sum > 0) {
            const alpha = softness(rest);
            // With its own joint, the segment before it, and the joint before that.
            s1 = f(f(wHigh * dot(direction, high)) - f(wLow * dot(direction, middle)));
            s2 = f(f(-wLow) * dot(directionWas, direction));
            s3 = f(f(-wLow) * dot(direction, highWas));
            sDiagonal = f(f(sum * f(1 + softening)) + alpha);
            sRight = f(f(-error) - f(alpha * (multiplier[k] as number)));
          }
          eliminate(2 * k + 1, s1, s2, s3, 0, sDiagonal, sRight);

          directionBefore = directionWas;
          directionWas = direction;
          sizeWas = size;
          restWas = rest;
          highBefore = highWas;
          middleWas = middle;
          highWas = high;
          lower = higher;
        }

        // Back: substitute row by row, move each point, store it, and look at what is left.
        let converged = true;
        exceeded = false;
        const look = (k: number, low: Vec3, high: Vec3): void => {
          if (!(f((inverse[k] as number) + (inverse[k + 1] as number)) > 0)) return;
          const rest = restOf(k);
          const span = sub(high, low);
          const squared = dot(span, span);
          const most = f(rest * f(1 + limit));
          const least = f(rest * shortest);
          if (squared > f(most * most) || squared < f(least * least)) exceeded = true;
          const off = rest > 0 ? f(f(squared - f(rest * rest)) / f(2 * rest)) : f(Math.sqrt(squared));
          const residual = Math.abs(f(off + f(softness(rest) * (multiplier[k] as number))));
          if (!(residual <= f(f(ROPE_TOLERANCE * rest) + ROPE_TOLERANCE_FLOOR))) converged = false;
        };
        /** Is the joint at point j, between these three points, within its tolerance of its limit? */
        const lookAt = (j: number, low: Vec3, middle: Vec3, high: Vec3): void => {
          if (!(f(f((inverse[j - 1] as number) + (inverse[j] as number)) + (inverse[j + 1] as number)) > 0)) return;
          const a = restOf(j - 1);
          const b = restOf(j);
          if (!(a > 0 && b > 0)) return;
          const near = f(1 / a);
          const far = f(1 / b);
          const kappa = sub(scale(sub(high, middle), far), scale(sub(middle, low), near));
          // Its limit, its tolerance, and what it gives by for what it has pushed.
          const allowed = f(f(f(mostOf(a, b) * f(1 + ROPE_BEND_TOLERANCE)) + f(ROPE_BEND_FLOOR * f(near + far))) + f(giveOf(j, a, b) * f(Math.max(f(-(turned[j] as number)), 0))));
          if (dot(kappa, kappa) > f(allowed * allowed)) converged = false;
        };
        let p1 = 0;
        let p2 = 0;
        let p3 = 0;
        let p4 = 0;
        /** The next row down's multiplier: what its solved right-hand side leaves once the rows after it have had theirs. */
        const substitute = (row: number): number => {
          const lambda = f((rowZ[row] as number) - p1);
          p1 = f(p2 + f((rowL[row * 4] as number) * lambda));
          p2 = f(p3 + f((rowL[row * 4 + 1] as number) * lambda));
          p3 = f(p4 + f((rowL[row * 4 + 2] as number) * lambda));
          p4 = f((rowL[row * 4 + 3] as number) * lambda);
          return lambda;
        };
        // Of the segment after this one: its direction and multiplier. Of the joint at its far
        // end: its gradient on the point before it and on itself. Of the joint after that: on the point before it.
        let directionNext: Vec3 = [0, 0, 0];
        let stretchNext = 0;
        let lowNext: Vec3 = [0, 0, 0];
        let middleNext: Vec3 = [0, 0, 0];
        let turnNext = 0;
        let lowAfter: Vec3 = [0, 0, 0];
        let turnAfter = 0;
        let aboveNow: Vec3 = [0, 0, 0];
        let aboveNext: Vec3 = [0, 0, 0];
        for (let k = segments - 1; k >= 0; k -= 1) {
          const stretchHere = substitute(2 * k + 1);
          const turnHere = substitute(2 * k);
          const lowerWas = work[k] as Vec3;
          const higherWas = work[k + 1] as Vec3;
          const here = segment(lowerWas, higherWas, restOf(k));
          // The joint's gradient, from the three points as they were: only a joint that was in the system has a multiplier.
          let low: Vec3 = [0, 0, 0];
          let middle: Vec3 = [0, 0, 0];
          let high: Vec3 = [0, 0, 0];
          if (turnHere !== 0) {
            const first = segment(work[k - 1] as Vec3, lowerWas, restOf(k - 1));
            const joint = hinge(first.direction, first.size, here.direction, here.size);
            if (joint !== null) {
              low = joint.low;
              middle = joint.middle;
              high = joint.high;
            }
          }
          // Point k + 1: the segment before it and after it, the joint before it, its own, and the one after.
          let push = sub(scale(here.direction, stretchHere), scale(directionNext, stretchNext));
          push = add(push, scale(high, turnHere));
          push = add(push, scale(middleNext, turnNext));
          push = add(push, scale(lowAfter, turnAfter));
          const moved = add(higherWas, scale(push, inverse[k + 1] as number));
          work[k + 1] = moved;
          const total = f((multiplier[k] as number) + stretchHere);
          multiplier[k] = total;
          const pushed = f((turned[k] as number) + turnHere);
          turned[k] = pushed;
          // A joint in the system that ends up holding the strand BENT has to be let go: the limit is one-sided.
          if (turnHere !== 0 && pushed > 0) converged = false;
          if ((inverse[k + 1] as number) > 0) {
            put(next.position, base + k + 1, add(moved, origin));
            put(next.velocity, base + k + 1, divide(sub(moved, startOf(k + 1)), h));
          }
          next.tension[base + k] = f(f(-total) / hh);
          if (k + 1 < segments) look(k + 1, moved, aboveNow);
          if (k + 2 < segments) lookAt(k + 2, moved, aboveNow, aboveNext);
          aboveNext = aboveNow;
          aboveNow = moved;
          directionNext = here.direction;
          stretchNext = stretchHere;
          lowAfter = lowNext;
          turnAfter = turnNext;
          lowNext = low;
          middleNext = middle;
          turnNext = turnHere;
        }
        // The first point: the segment after it, and the joint at the second point.
        const push = add(scale(directionNext, f(-stretchNext)), scale(lowAfter, turnAfter));
        const solved = add(work[0] as Vec3, scale(push, inverse[0] as number));
        work[0] = solved;
        if ((inverse[0] as number) > 0) {
          put(next.position, base, add(solved, origin));
          put(next.velocity, base, divide(sub(solved, startOf(0)), h));
        }
        look(0, solved, aboveNow);
        if (segments > 1) lookAt(1, solved, aboveNow, aboveNext);
        if (converged) break;
      }
      if (!exceeded) break;
    }
  }

  // ── Stretch: Newton steps on the tridiagonal system ──
  for (let iteration = 0; iteration < (bend ? 0 : iterations); iteration += 1) {
    // Forward: eliminate. The first time through, each point is predicted as the sweep
    // reaches it. Segment k's upper coefficient is known when segment k + 1's direction is.
    let previousDirection: Vec3 = [0, 0, 0];
    let previousActive = false;
    let pivot = 1;
    let carried = 0;
    let lower = work[0] as Vec3;
    for (let k = 0; k < segments; k += 1) {
      const rest = restOf(k);
      if (iteration === 0) {
        reach = f(reach + f(rest * f(1 + limit)));
        place(k + 1);
        multiplier[k] = 0;
      }
      const higher = work[k + 1] as Vec3;
      const { direction, error } = segment(lower, higher, rest);
      const sum = f((inverse[k] as number) + (inverse[k + 1] as number));
      if (sum > 0) {
        const alpha = softness(rest);
        let coupling = 0;
        let above = 0;
        if (previousActive) {
          coupling = f(-(inverse[k] as number) * dot(previousDirection, direction));
          above = f(coupling / pivot);
          upper[k - 1] = above;
        }
        pivot = f(f(f(sum * f(1 + softening)) + alpha) - f(coupling * above));
        carried = f(f(f(f(-error) - f(alpha * (multiplier[k] as number))) - f(coupling * carried)) / pivot);
        reduced[k] = carried;
        previousActive = true;
      } else {
        // Both ends are held: nothing can move this segment, and nothing couples through it.
        if (previousActive) upper[k - 1] = 0;
        reduced[k] = 0;
        previousActive = false;
      }
      upper[k] = 0;
      previousDirection = direction;
      lower = higher;
    }

    // Back: substitute, move each point, store it, and look at what is left.
    let converged = true;
    exceeded = false;
    const look = (k: number, low: Vec3, high: Vec3): void => {
      if (!(f((inverse[k] as number) + (inverse[k + 1] as number)) > 0)) return;
      const rest = restOf(k);
      const span = sub(high, low);
      const squared = dot(span, span);
      const most = f(rest * f(1 + limit));
      const least = f(rest * shortest);
      if (squared > f(most * most) || squared < f(least * least)) exceeded = true;
      // How far off its length, to first order: no square root where a yes or no is wanted.
      const off = rest > 0 ? f(f(squared - f(rest * rest)) / f(2 * rest)) : f(Math.sqrt(squared));
      const residual = Math.abs(f(off + f(softness(rest) * (multiplier[k] as number))));
      if (!(residual <= f(f(ROPE_TOLERANCE * rest) + ROPE_TOLERANCE_FLOOR))) converged = false;
    };
    let nextMultiplier = 0;
    let nextDirection: Vec3 = [0, 0, 0];
    let higherWas = work[segments] as Vec3;
    let aboveNow: Vec3 = [0, 0, 0];
    for (let k = segments - 1; k >= 0; k -= 1) {
      const lowerWas = work[k] as Vec3;
      const { direction } = segment(lowerWas, higherWas, restOf(k));
      const lambda = f((reduced[k] as number) - f((upper[k] as number) * nextMultiplier));
      const moved = add(higherWas, scale(sub(scale(direction, lambda), scale(nextDirection, nextMultiplier)), inverse[k + 1] as number));
      work[k + 1] = moved;
      const total = f((multiplier[k] as number) + lambda);
      multiplier[k] = total;
      if ((inverse[k + 1] as number) > 0) {
        put(next.position, base + k + 1, add(moved, origin));
        put(next.velocity, base + k + 1, divide(sub(moved, startOf(k + 1)), h));
      }
      next.tension[base + k] = f(f(-total) / hh);
      if (k + 1 < segments) look(k + 1, moved, aboveNow);
      aboveNow = moved;
      higherWas = lowerWas;
      nextDirection = direction;
      nextMultiplier = lambda;
    }
    const solved = add(higherWas, scale(scale(nextDirection, f(-nextMultiplier)), inverse[0] as number));
    work[0] = solved;
    if ((inverse[0] as number) > 0) {
      put(next.position, base, add(solved, origin));
      put(next.velocity, base, divide(sub(solved, startOf(0)), h));
    }
    look(0, solved, aboveNow);
    if (converged) break;
  }

  // ── The guard: only on a step that left a segment beyond Max Stretch. Positions only. ──
  if (!exceeded) return;
  /** A point set no nearer and no further from `from` than its segment may be. */
  const within = (solved: Vec3, from: Vec3, rest: number): Vec3 => {
    const span = sub(solved, from);
    const squared = dot(span, span);
    if (!(squared > ZERO_SEGMENT_SQUARED)) return solved;
    const size = f(Math.sqrt(squared));
    const most = f(rest * f(1 + limit));
    const least = f(rest * shortest);
    if (size > most) return add(from, scale(span, f(most / size)));
    if (size < least) return add(from, scale(span, f(least / size)));
    return solved;
  };
  /* BACK FROM THE LAST PIN FIRST (the design's D24). The walk out from the first point
     moves each segment's later point and leaves a pinned one, so on a strand held further
     along, whatever the solve did not close used to land on the one segment before that
     pin: 177% of it at a claw crossing at 8 m/s in one step. So the points before the last
     hard pin are first drawn in toward it, each to its segment's length from the point
     after it, and the walk out then finds them nearly in place. A strand with no pin past
     its first point has nothing to walk back from, and is untouched by this. */
  if (lastPin > 0) {
    let ahead = work[lastPin] as Vec3;
    for (let i = lastPin - 1; i >= 0; i -= 1) {
      let placed = work[i] as Vec3;
      if ((inverse[i] as number) > 0) {
        placed = within(placed, ahead, restOf(i));
        work[i] = placed;
      }
      ahead = placed;
    }
    if ((inverse[0] as number) > 0) put(next.position, base, add(work[0] as Vec3, origin));
  }
  let settled = work[0] as Vec3;
  for (let i = 1; i < cols; i += 1) {
    let placed = work[i] as Vec3;
    if ((inverse[i] as number) > 0) placed = within(placed, settled, restOf(i - 1));
    settled = placed;
    // A pinned point keeps the target it was stored at.
    if ((inverse[i] as number) > 0) put(next.position, base + i, add(placed, origin));
  }
}

/**
 * One run of the solver step over every strand: what one dispatch of the Rope's pass does.
 * `incoming` is the upstream pointset's `position` region (four floats a point); `maps`
 * holds the attribute of every parameter in Map mode, and the pin attribute.
 */
export function stepRope(state: RopeState, incoming: Float32Array, parameters: RopeParameters, run: RopeRun, maps: RopeMaps = {}): void {
  const points = state.cols * state.rows;
  const next: RopeWrite = { position: new Float32Array(points * 4), velocity: new Float32Array(points * 4), tension: new Float32Array(points) };
  for (let strand = 0; strand < state.rows; strand += 1) stepStrand(state, next, incoming, parameters, run, strand, maps);
  state.position = next.position;
  state.velocity = next.velocity;
  state.tension = next.tension;
}

/**
 * One displayed frame: `substeps` runs, each of the frame's step divided by that count, the
 * first of them seeding when the state is fresh — exactly how the backend steps the pass.
 */
export function advanceRope(
  state: RopeState,
  incoming: Float32Array,
  parameters: RopeParameters,
  frame: { readonly deltaSeconds: number; readonly substeps: number; readonly firstRun?: boolean },
  maps: RopeMaps = {},
): void {
  const substeps = Math.max(1, Math.round(frame.substeps));
  for (let substep = 0; substep < substeps; substep += 1) {
    stepRope(
      state,
      incoming,
      parameters,
      { deltaSeconds: frame.deltaSeconds / substeps, substep, substeps, firstRun: frame.firstRun === true && substep === 0 },
      maps,
    );
  }
}
