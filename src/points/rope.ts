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
 *   anchor     the first point of a strand is pulled to its target by its weight
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
 * SLICE 1 holds one anchor, the strand's first point. The pull is written in its general
 * form for it (a weight between 0 and 1), with the strength and damping the anchor
 * parameters of slice 2 will default to.
 */

/** A segment is at its length when within this share of it: 1/8192, 7 µm on a 60 mm segment. */
export const ROPE_TOLERANCE = 1 / 8192;

/** Metres added to that, so a segment of no rest length has a tolerance at all. */
export const ROPE_TOLERANCE_FLOOR = 1e-7;

/** The most Newton steps one solver step may take. */
export const ROPE_MAX_ITERATIONS = 8;

/** The longest strand one walk covers (the design's R1): the curve family's block. */
export const ROPE_MAX_STRAND_POINTS = 1024;

/** How fast a partly weighted anchor draws its point in, in Hz, and its damping ratio. Slice 2 makes both parameters. */
export const ROPE_ANCHOR_STRENGTH_HZ = 2;
export const ROPE_ANCHOR_DAMPING_RATIO = 1;

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
  /** Multiplies every measured rest length. */
  readonly restLengthScale: number;
  /** Compliance: the fraction a segment lengthens per newton of tension. 0 does not stretch. */
  readonly stretch: number;
  /** The most a segment may be longer or shorter than its rest length at the end of a step, as a fraction. */
  readonly maxStretch: number;
  /** How firmly each strand's first point is held to its incoming point, 0 to 1. */
  readonly anchorFirst: number;
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
  restLengthScale: 1,
  stretch: 0,
  maxStretch: 0.02,
  anchorFirst: 1,
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

function stepStrand(state: RopeState, next: RopeWrite, incoming: Float32Array, parameters: RopeParameters, run: RopeRun, strand: number): void {
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

  // ── The first point's anchor: its target now, and where the target was a frame ago ──
  const weight = f(Math.min(1, Math.max(0, parameters.anchorFirst)));
  const targetNow = at(incoming, base);
  let before = at(state.kept, base * 2);
  const rateWas = at(state.kept, base * 2 + 1);
  let jump: Vec3 = [0, 0, 0];
  const reach = f(parameters.teleportDistance);
  // The frame's whole step: an anchor's target moves in frame time, whatever Simulation Speed is.
  const frameSeconds = f(f(run.deltaSeconds) * run.substeps);
  if (weight > 0 && run.substep === 0 && reach > 0) {
    const moved = sub(targetNow, before);
    if (dot(moved, moved) > f(reach * reach)) {
      if (parameters.teleportMode === "reset") {
        seedStrand(state, next, incoming, base);
        return;
      }
      // Carry: the strand goes with the jump, and its anchor is not dragged across it. What
      // the anchor travels in this frame at the speed it had is NOT part of the jump: the
      // target is taken to have come from where that speed puts it, so a body that wraps
      // its world while moving keeps moving through the wrap.
      const start = sub(targetNow, scale(rateWas, frameSeconds));
      jump = sub(start, before);
      before = start;
    }
  }
  const lastSubstep = run.substep + 1 === run.substeps;
  const travelled = sub(targetNow, before);
  const targetHere = lastSubstep ? targetNow : add(before, scale(travelled, f((run.substep + 1) / run.substeps)));
  const targetWas = add(before, scale(travelled, f(run.substep / run.substeps)));
  // Kept for the next frame's steps: where the target stood when this frame ended, and
  // how fast it had moved to get there.
  put(state.kept, base * 2, lastSubstep ? targetNow : before);
  if (lastSubstep) put(state.kept, base * 2 + 1, divide(travelled, frameSeconds));

  // The walk works relative to the strand's first point, so a strand far from the origin
  // does the arithmetic of one at it.
  const originWas = at(state.position, base);
  const origin = add(originWas, jump);
  const targetLocal = sub(targetHere, origin);
  const targetWasLocal = sub(targetWas, origin);

  const inverseMass = f(1 / parameters.mass);
  const keep = f(1 / f(1 + f(f(parameters.damping) * h)));
  const drop = f(f(f(parameters.gravity) * h) * h);
  const restScale = f(parameters.restLengthScale);
  const stretch = f(parameters.stretch);
  const hh = f(h * h);
  const limit = f(parameters.maxStretch);
  // A segment cannot be shorter than nothing: past a Max Stretch of 1 only the long side limits.
  const shortest = f(Math.max(0, f(1 - limit)));

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
  const restOf = (k: number): number => f((state.kept[(base + k) * 8 + 3] as number) * restScale);
  const softness = (rest: number): number => f(f(stretch * rest) / hh);

  // ── The first point: predicted, then pulled by its anchor ──
  let first = predict(0);
  let firstInverse = inverseMass;
  let pinned = false;
  if (weight > 0) {
    if (weight >= 1) {
      first = targetLocal;
      firstInverse = 0;
      pinned = true;
    } else {
      // A spring to the target, stepped implicitly: part of the way there, and heavier.
      const gain = f(weight / f(1 - weight));
      const turn = f(f(TAU * f(ROPE_ANCHOR_STRENGTH_HZ)) * h);
      const pull = f(f(turn * turn) * gain);
      const drag = f(f(f(2 * f(ROPE_ANCHOR_DAMPING_RATIO)) * turn) * f(Math.sqrt(gain)));
      const total = f(f(1 + pull) + drag);
      const damper = add(startOf(0), sub(targetLocal, targetWasLocal));
      first = divide(add(add(first, scale(targetLocal, pull)), scale(damper, drag)), total);
      firstInverse = f(firstInverse / total);
    }
  }
  work[0] = first;
  inverse[0] = firstInverse;
  next.tension[base + segments] = 0;

  const storeFirst = (solved: Vec3): void => {
    put(next.position, base, pinned ? targetHere : add(solved, origin));
    put(next.velocity, base, divide(sub(solved, startOf(0)), h));
  };
  if (segments === 0) {
    storeFirst(first);
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
      if (iteration === 0) {
        work[k + 1] = predict(k + 1);
        inverse[k + 1] = inverseMass;
        multiplier[k] = 0;
      }
      const higher = work[k + 1] as Vec3;
      const rest = restOf(k);
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
        pivot = f(f(sum + alpha) - f(coupling * above));
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
      put(next.position, base + k + 1, add(moved, origin));
      put(next.velocity, base + k + 1, divide(sub(moved, startOf(k + 1)), h));
      next.tension[base + k] = f(f(-total) / hh);
      if (k + 1 < segments) look(k + 1, moved, aboveNow);
      aboveNow = moved;
      higherWas = lowerWas;
      nextDirection = direction;
      nextMultiplier = lambda;
    }
    const solved = add(higherWas, scale(scale(nextDirection, f(-nextMultiplier)), inverse[0] as number));
    work[0] = solved;
    storeFirst(solved);
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
    put(next.position, base + i, add(placed, origin));
  }
}

/**
 * One run of the solver step over every strand: what one dispatch of the Rope's pass does.
 * `incoming` is the upstream pointset's `position` region (four floats a point).
 */
export function stepRope(state: RopeState, incoming: Float32Array, parameters: RopeParameters, run: RopeRun): void {
  const points = state.cols * state.rows;
  const next: RopeWrite = { position: new Float32Array(points * 4), velocity: new Float32Array(points * 4), tension: new Float32Array(points) };
  for (let strand = 0; strand < state.rows; strand += 1) stepStrand(state, next, incoming, parameters, run, strand);
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
): void {
  const substeps = Math.max(1, Math.round(frame.substeps));
  for (let substep = 0; substep < substeps; substep += 1) {
    stepRope(state, incoming, parameters, {
      deltaSeconds: frame.deltaSeconds / substeps,
      substep,
      substeps,
      firstRun: frame.firstRun === true && substep === 0,
    });
  }
}
