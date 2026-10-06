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
 *    stored for it is the target, to the bit. Below 1 it is a spring of stiffness
 *    `M·(2π·strength)²·a ÷ (1 − a)`, which stiffens without bound as the weight nears 1.
 *    SOFT, the stiffness is `M·(2π·strength)²·a` and a weight of 1 is still a spring.
 *  - `M` IS THE MASS THE ANCHOR CARRIES (the design's D19): the strand's, for a station, and
 *    the point's own for a pin attribute, where every point is held and carries only itself.
 *    Sized by one point's mass, a strand of 55 hangs 3.4 m below a half-weighted anchor.
 *  - THE EARLIER PIN WINS (the design's 4.6). A target further from the nearest earlier
 *    hard pin than the rope between them, times `1 + Max Stretch`, is drawn in to that reach
 *    along the line to it: length is kept and the target is not.
 *  - Between two anchors a taut, straight strand makes the chain system singular, so with
 *    two or more anchored stations (or a pin attribute) each pivot carries `ROPE_PIN_SOFTENING`.
 *    With one anchor or none it is zero, and a hanging strand is an exact fixed point.
 */

/** A segment is at its length when within this share of it: 1/8192, 7 µm on a 60 mm segment. */
export const ROPE_TOLERANCE = 1 / 8192;

/** Metres added to that, so a segment of no rest length has a tolerance at all. */
export const ROPE_TOLERANCE_FLOOR = 1e-7;

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
function segment(lower: Vec3, upper: Vec3, rest: number): { readonly direction: Vec3; readonly error: number } {
  const span = sub(upper, lower);
  const squared = dot(span, span);
  if (!(squared > ZERO_SEGMENT_SQUARED)) return { direction: [0, 0, 0], error: 0 };
  const size = f(Math.sqrt(squared));
  return { direction: divide(span, size), error: f(size - rest) };
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
  const held = (raw: number): number => f(Math.min(1, Math.max(0, raw)));
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
        if (hasPin) {
          // The earlier pin wins: a target out of its reach is drawn in along the line to it.
          const span = sub(goal, pinAt);
          const squared = dot(span, span);
          if (squared > f(reach * reach)) {
            goal = add(pinAt, scale(span, f(reach / f(Math.sqrt(squared)))));
            drawnIn = true;
          }
        }
        if (hard && weight >= 1) {
          placed = goal;
          weighs = 0;
          put(next.position, slot, drawnIn ? add(goal, origin) : here);
          put(next.velocity, slot, divide(sub(goal, start), h));
          pinAt = goal;
          hasPin = true;
          reach = 0;
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

  // ── Stretch: Newton steps on the tridiagonal system ──
  const iterations = Math.min(ROPE_MAX_ITERATIONS, Math.max(1, Math.round(parameters.iterations)));
  let exceeded = false;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
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
  let settled = work[0] as Vec3;
  for (let i = 1; i < cols; i += 1) {
    const solved = work[i] as Vec3;
    let placed = solved;
    if ((inverse[i] as number) > 0) {
      const rest = restOf(i - 1);
      const span = sub(solved, settled);
      const squared = dot(span, span);
      if (squared > ZERO_SEGMENT_SQUARED) {
        const size = f(Math.sqrt(squared));
        const most = f(rest * f(1 + limit));
        const least = f(rest * shortest);
        if (size > most) placed = add(settled, scale(span, f(most / size)));
        else if (size < least) placed = add(settled, scale(span, f(least / size)));
      }
    }
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
