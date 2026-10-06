import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { ZERO_SEGMENT_SQUARED } from "../../points/curve.ts";
import {
  ROPE_BEND_BAND,
  ROPE_BEND_CLOSE,
  ROPE_BEND_FLOOR,
  ROPE_BEND_GAP,
  ROPE_BEND_OPEN_AGAIN,
  ROPE_BEND_OPEN_MOST,
  ROPE_BEND_SOFTENING,
  ROPE_BEND_STEP,
  ROPE_BEND_TOLERANCE,
  ROPE_BEND_YIELD,
  ROPE_BEND_YIELD_WAIT,
  ROPE_HELD_FROM,
  ROPE_MAX_ITERATIONS,
  ROPE_PIN_SOFTENING,
  ROPE_PIVOT_FLOOR,
  ROPE_REACH_SHARE,
  ROPE_REACH_SLACK,
  ROPE_TOLERANCE,
  ROPE_TOLERANCE_FLOOR,
} from "../../points/rope.ts";

/**
 * T1585b — the Rope's solver step: ONE INVOCATION PER STRAND WALKS ITS STRAND.
 *
 * This file is `src/points/rope.ts`'s `stepStrand` in WGSL, operation for operation, and
 * the Dawn tests hold the two together. Read the head of that file first. What follows from
 * it here:
 *
 *  - a strand's segments are solved together, which is serial along the strand (forward
 *    elimination, then back substitution), so the unit of work is the strand and not the
 *    point. Strands share no slot, so invocations never write the same word: no atomics, no
 *    barriers, one answer on every device (§V74's argument). Ten tentacles are ten threads;
 *    two thousand hairs are two thousand;
 *  - the step is ONE dispatch, run once per solver step inside the kernel-steps loop region
 *    (§T1583b). Each run reads the read half of the node's state pair and writes the write
 *    half, and the encoder swaps them between runs. So a run writes EVERY word of the pair
 *    for its strand, on every path through it — a word it skipped would be read by the next
 *    run as whatever the run before last left there;
 *  - what the solver keeps for itself and writes rarely — each segment's measured length,
 *    where each anchor's target stood when the last frame ended, and how fast it was moving
 *    then — is therefore NOT in the pair. It lives in `kept`, one buffer of two vec4f a
 *    point, written when a strand is seeded and once a frame for each of its three stations
 *    (for every point, under a pin attribute). In the pair it would be copied across by
 *    every run;
 *  - `scratch` is the working copy of a step, eight floats a point: the point's
 *    strand-relative position while the Newton steps move it, its inverse mass, and for the
 *    segment after it the elimination's two coefficients and the multiplier summed over
 *    the Newton steps;
 *  - a segment's direction is needed by both sweeps. The back sweep works it out again
 *    from the two points as they were (it moves a segment's later point only after it has
 *    read it), which is one more square root a segment and no more memory;
 *  - every direction is `span / sqrt(dot(span, span))`, never `normalize`: a fast
 *    reciprocal square root may miss 1.0 by a unit in the last place, and the exact tests
 *    (a hanging strand is a fixed point, to the bit) need the division.
 *
 * ## Two loops a step, and why (the design's D11, measured)
 *
 * A walk's cost on a GPU is its depth times the loops it makes. The first version of this
 * step made four loops and copied the kept values across in each run, and measured three to
 * four times Curve Frames' two walks at every strand length. So the predict is folded into
 * the elimination and the stored result into the substitution: a step that converges in
 * one Newton step and breaks no stretch limit, which is every step inside the step limit,
 * is two loops. Each further Newton step is two more, and the Max Stretch guard is a third
 * loop only on a step that left a segment beyond it.
 *
 * Measured as built, on Dawn/Metal (the design doc's section 14.3): a loop costs about
 * 0.7 µs a point of strand length, against 0.45 for Curve Frames' walk. A two-loop step is
 * 1.43 ms for 98 strands of 1,024 points, 0.38 ms for 400 of 250, and at the GPU timer's
 * quantum for 55; a step that needs all four Newton steps costs four times that. A million
 * points as 18,181 strands of 55 are 1.4 to 1.5 ms a step: bound by throughput, three
 * times a plain per-point kernel, because `scratch` is read and written per point per loop.
 *
 * Taken again with a fixed reference pass timed beside every frame (section 16.3; the GPU
 * clock here follows its recent load, §B260): one 55-point strand's calm step is 0.83 of
 * Curve Frames' two walks, anchors at the three stations cost nothing that can be measured,
 * and a pin attribute doubles a step, because every point then follows its target.
 *
 * The uniform block's first four members are the backend's, written for every run of a
 * stepped dispatch (`dispatchStepUniforms`): the frame's step divided by the substep count,
 * which substep this is and of how many, and `firstRun` on run 0 of a frame whose storage
 * is fresh.
 *
 * ## What it reads from upstream (slice 2)
 *
 * The incoming points and every attribute a parameter in Map mode names may come from
 * several producers (a kernel's position, a weight gathered on after it). Each producer's
 * buffer is bound WHOLE, once, as `pk_N`, and a region is read by its word offset (T1076) —
 * so a weight in the same buffer as the positions costs no binding. `place` is the one
 * place a point meets its anchor: it is called for the first point before the walk and for
 * each later point as the forward sweep reaches it, and a hard pin is stored there.
 *
 * ## Bend Limit is another program (slice 4)
 *
 * With `bend` off the text is the tridiagonal step above, to the byte: a definition test
 * pins it by fingerprint. With it on, the Newton step is the reference's banded one: the
 * joint at each point and the segment after it are two rows, eliminated in that order by an
 * LDLᵀ whose window is the last four rows, and substituted back the other way. `scratch`
 * is then twenty floats a point: the working position, the inverse mass, the segment's
 * multiplier, the joint's, five floats for each of the point's two rows (the solved
 * right-hand side and four multipliers to the rows before it), where the point was placed,
 * and the joint's clock.
 *
 * ## What a step leaves for the next (slice 4b)
 *
 * Two things, and neither is in the state pair. A point's INVERSE MASS stays in `scratch`
 * from one step to the next, and `place` reads it before the step writes it: a point whose
 * inverse mass was nothing was a hard pin at the last step, which is all the speedless
 * take-up (the reference's D38) has to know. And with Bend Limit on each joint keeps its
 * OPENING, in the fourth float of its point's second `kept` vector, and its CLOCK, in the
 * twentieth float of its point's scratch (the reference's D41). The strand's first point has
 * no joint: its clock's float says whether any joint of the strand has an opening or a
 * clock, so a strand with neither, in a step no joint is in trouble in, does not walk its
 * joints a third time.
 */

/** A scalar attribute upstream: which bound buffer, the word its region starts at, a point's stride in words, and the component read. */
export interface RopeScalarRegion {
  readonly group: number;
  readonly word: number;
  readonly strideWords: number;
  readonly component: number;
}

export interface RopeShaderOptions {
  /** Load functions over `state_in`: `loadPosition`, `loadVelocity`, and `loadTension` when it is stored. */
  readonly loadFunctions: string;
  /** Store functions over `state_out`: `storePosition`, `storeVelocity`, and `storeTension`. */
  readonly storeFunctions: string;
  /** The node publishes `tension`, so the state carries it. */
  readonly tension: boolean;
  /** The uniform block's members, in order: the one list the struct and the pass's values are both made from. */
  readonly members: ReadonlyArray<{ readonly name: string; readonly type: "f32" | "u32" }>;
  /** How many upstream buffers are bound, as `pk_0` to `pk_{groups − 1}`. */
  readonly groups: number;
  /** The incoming `position` (vec3f, four words a point). */
  readonly position: { readonly group: number; readonly word: number };
  /** The attribute each station's weight is mapped to; absent, the weight is the parameter. */
  readonly anchorFirst?: RopeScalarRegion;
  readonly anchorSecond?: RopeScalarRegion;
  readonly anchorLast?: RopeScalarRegion;
  /** The pin attribute: a weight on every point. */
  readonly pin?: RopeScalarRegion;
  /** Bend Limit is on: the banded step, and twenty floats of scratch a point. */
  readonly bend?: boolean;
}

/** Floats of `scratch` a point: eight for the tridiagonal step, twenty with Bend Limit on. */
export const ropeScratchFloats = (bend: boolean): number => (bend ? 20 : 8);

const scalarAt = (region: RopeScalarRegion, slot: string): string =>
  `bitcast<f32>(pk_${region.group}[${region.word}u + ${slot} * ${region.strideWords}u + ${region.component}u])`;

const literal = (value: number): string => {
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
};

/** What `scratch` holds per point for the tridiagonal step: the text the program has always had. */
const TRIDIAGONAL_LAYOUT = `/* The eight floats scratch holds per point: its strand-relative position while a step
   solves (three), its inverse mass, and for the segment AFTER it the elimination's upper
   coefficient, its reduced right-hand side and the multiplier summed over the Newton steps. */
const INVERSE: u32 = 3u;
const UPPER: u32 = 4u;
const REDUCED: u32 = 5u;
const MULTIPLIER: u32 = 6u;`;

/** …and with Bend Limit on. */
const BEND_LAYOUT = `/* The twenty floats scratch holds per point with Bend Limit on: its strand-relative
   position while a step solves (three), its inverse mass, the multiplier of the segment
   AFTER it and of the joint AT it, each summed over the Newton steps, and five floats for
   each of its two rows — the joint's, then the segment's: the solved right-hand side and
   the four multipliers to the rows before it; where the point was placed (three); and the
   joint's clock, which the step after this one reads. */
const INVERSE: u32 = 3u;
const MULTIPLIER: u32 = 4u;
const TURNED: u32 = 5u;
const JOINT_ROW: u32 = 6u;
const SEGMENT_ROW: u32 = 11u;
const PLACED: u32 = 16u;
const YIELDING: u32 = 19u;`;

const BEND_FUNCTIONS = `/* What a joint's row is raised by, as a share of its pivot; how near its limit a joint
   counts as on it; how far inside it a joint is still held; metres of a stored position's
   own spacing in a second difference; the least a pivot may be, as a share of its
   diagonal; and the most one Newton step turns a joint back by, in radians. */
const BEND_SOFTENING: f32 = ${literal(ROPE_BEND_SOFTENING)};
const BEND_TOLERANCE: f32 = ${literal(ROPE_BEND_TOLERANCE)};
const BEND_BAND: f32 = ${literal(ROPE_BEND_BAND)};
const BEND_FLOOR: f32 = ${ROPE_BEND_FLOOR};
const PIVOT_FLOOR: f32 = ${literal(ROPE_PIVOT_FLOOR)};
const BEND_STEP: f32 = ${literal(ROPE_BEND_STEP)};
/* The hinge: radians a joint may give before it is in trouble; seconds of trouble before its
   limit moves; the most it opens by a step, and by a step solved without the limit; how far
   beyond its joint an open limit is left; what it closes by a step. */
const BEND_YIELD: f32 = ${literal(ROPE_BEND_YIELD)};
const BEND_YIELD_WAIT: f32 = ${literal(ROPE_BEND_YIELD_WAIT)};
const BEND_OPEN_MOST: f32 = ${literal(ROPE_BEND_OPEN_MOST)};
const BEND_OPEN_AGAIN: f32 = ${literal(ROPE_BEND_OPEN_AGAIN)};
const BEND_GAP: f32 = ${literal(ROPE_BEND_GAP)};
const BEND_CLOSE: f32 = ${literal(ROPE_BEND_CLOSE)};
/* In a joint's clock: its limit was put where the joint stands, and is left alone until the joint comes in. */
const LEFT_ALONE: f32 = -1.0;
const PI: f32 = 3.141592653589793;

struct Measured {
  direction: vec3f,
  error: f32,
  size: f32,
};

/* A segment's unit direction, how far it is from its length, and its length; none of them when it has no extent. */
fn measure(lower: vec3f, upper: vec3f, rest: f32) -> Measured {
  let span = upper - lower;
  let squared = dot(span, span);
  if (!(squared > ZERO_SEGMENT_SQUARED)) {
    return Measured(vec3f(0.0), 0.0, 0.0);
  }
  let size = sqrt(squared);
  return Measured(span / size, size - rest, size);
}

struct Hinge {
  low: vec3f,
  middle: vec3f,
  high: vec3f,
  turn: f32,
  ok: bool,
};

/* A joint's turn and its gradient, from the unit directions and lengths of the two segments
   that meet at it: on the point before the joint, on the joint, and on the point after. Not
   ok where the turn has no side to open to: no turn at all, or a fold of exactly 180 degrees. */
fn hinge(first: vec3f, firstSize: f32, second: vec3f, secondSize: f32) -> Hinge {
  var out = Hinge(vec3f(0.0), vec3f(0.0), vec3f(0.0), 0.0, false);
  if (!(firstSize > 0.0 && secondSize > 0.0)) {
    return out;
  }
  let cosine = dot(first, second);
  /* Each square to its own segment, in the plane of the two: where turning that segment
     about the joint moves its far end. */
  let acrossFirst = second - first * cosine;
  let acrossSecond = first - second * cosine;
  let sineSquared = dot(acrossFirst, acrossFirst);
  if (!(sineSquared > ZERO_SEGMENT_SQUARED)) {
    return out;
  }
  let sine = sqrt(sineSquared);
  out.low = (acrossFirst / sine) * (1.0 / firstSize);
  out.high = (acrossSecond / sine) * (-1.0 / secondSize);
  out.middle = (out.low + out.high) * -1.0;
  let apart = second - first;
  let together = second + first;
  out.turn = 2.0 * atan2(sqrt(dot(apart, apart)), sqrt(dot(together, together)));
  out.ok = true;
  return out;
}

/* Where a point was placed, for a step that has to be solved again. */
fn storePlaced(slot: u32, value: vec3f) {
  let o = slot * 20u + PLACED;
  scratch[o] = value.x;
  scratch[o + 1u] = value.y;
  scratch[o + 2u] = value.z;
}

fn loadPlaced(slot: u32) -> vec3f {
  let o = slot * 20u + PLACED;
  return vec3f(scratch[o], scratch[o + 1u], scratch[o + 2u]);
}

/* The most a joint between segments of these rest lengths may turn, as twice the sine of half of it. */
fn mostOf(a: f32, b: f32) -> f32 {
  return min(2.0, (a + b) / (2.0 * max(params.minBendRadius, 0.000001)));
}

/* Whether any joint of the strand being walked has an opening or a clock: its first point's clock float, read once a step. */
var<private> h_open: bool;

/* The limit of the joint at a slot with its opening, as twice the sine of half of it. On a
   strand none of whose joints has one, the plain limit and nothing read. */
fn limitOf(slot: u32, a: f32, b: f32) -> f32 {
  let plain = mostOf(a, b);
  if (!h_open) {
    return plain;
  }
  let opening = kept[slot * 2u + 1u].w;
  if (!(opening > 0.0)) {
    return plain;
  }
  return min(2.0, 2.0 * sin(min(PI, 2.0 * asin(plain / 2.0) + opening) / 2.0));
}

/* What a joint gives by, per unit it has pushed: the softening's share of the diagonal its
   REST lengths give its row, from the inverse masses of its three points. */
fn giveOf(before: f32, here: f32, after: f32, a: f32, b: f32) -> f32 {
  let near = 1.0 / a;
  let far = 1.0 / b;
  let both = near + far;
  return BEND_SOFTENING * (((before * (near * near)) + (here * (both * both))) + (after * (far * far)));
}

/* The elimination's window: the last four rows' pivots, right-hand sides, and the multipliers between them. */
var<private> e_d1: f32;
var<private> e_d2: f32;
var<private> e_d3: f32;
var<private> e_d4: f32;
var<private> e_z1: f32;
var<private> e_z2: f32;
var<private> e_z3: f32;
var<private> e_z4: f32;
var<private> e_m12: f32;
var<private> e_m13: f32;
var<private> e_m14: f32;
var<private> e_m23: f32;
var<private> e_m24: f32;
var<private> e_m34: f32;
/* The substitution's: what the rows already solved leave for the next four down. */
var<private> e_p1: f32;
var<private> e_p2: f32;
var<private> e_p3: f32;
var<private> e_p4: f32;

/* One row of LDL-transpose, written at its five floats: its couplings to the four rows
   before it, its diagonal, its right-hand side. */
fn eliminate(at: u32, a1: f32, a2: f32, a3: f32, a4: f32, diagonal: f32, right: f32) {
  let u4 = a4;
  let u3 = a3 - e_m34 * u4;
  let u2 = (a2 - e_m23 * u3) - e_m24 * u4;
  let u1 = ((a1 - e_m12 * u2) - e_m13 * u3) - e_m14 * u4;
  let l1 = u1 / e_d1;
  let l2 = u2 / e_d2;
  let l3 = u3 / e_d3;
  let l4 = u4 / e_d4;
  let pivot = max(diagonal - (((l1 * u1 + l2 * u2) + l3 * u3) + l4 * u4), diagonal * PIVOT_FLOOR);
  let z = right - (((l1 * e_z1 + l2 * e_z2) + l3 * e_z3) + l4 * e_z4);
  scratch[at] = z / pivot;
  scratch[at + 1u] = l1;
  scratch[at + 2u] = l2;
  scratch[at + 3u] = l3;
  scratch[at + 4u] = l4;
  e_d4 = e_d3;
  e_d3 = e_d2;
  e_d2 = e_d1;
  e_d1 = pivot;
  e_z4 = e_z3;
  e_z3 = e_z2;
  e_z2 = e_z1;
  e_z1 = z;
  e_m34 = e_m23;
  e_m24 = e_m13;
  e_m23 = e_m12;
  e_m14 = l3;
  e_m13 = l2;
  e_m12 = l1;
}

/* The next row down's multiplier: what its solved right-hand side leaves once the rows after it have had theirs. */
fn substitute(at: u32) -> f32 {
  let lambda = scratch[at] - e_p1;
  e_p1 = e_p2 + scratch[at + 1u] * lambda;
  e_p2 = e_p3 + scratch[at + 2u] * lambda;
  e_p3 = e_p4 + scratch[at + 3u] * lambda;
  e_p4 = scratch[at + 4u] * lambda;
  return lambda;
}

/* Is segment k between these two points beyond Max Stretch by more than the solve's own
   tolerance of its length (B277)? Asked only of a segment the guard's exact test has already
   found beyond it: this is what asks for a step to be solved again, and at a Max Stretch of
   nothing a rounding fails the exact test in every step. */
fn past(base: u32, k: u32, low: vec3f, high: vec3f) -> bool {
  let rest = restOf(base + k);
  let span = high - low;
  let squared = dot(span, span);
  let slack = TOLERANCE * rest + TOLERANCE_FLOOR;
  let longest = rest * (1.0 + params.maxStretch) + slack;
  let shorter = max(0.0, rest * max(0.0, 1.0 - params.maxStretch) - slack);
  return squared > longest * longest || squared < shorter * shorter;
}

/* Is the joint at point j, between these three points, still beyond its tolerance of its limit? */
fn lookAt(base: u32, j: u32, low: vec3f, middle: vec3f, high: vec3f) -> bool {
  let at = (base + j) * 20u;
  if (!((scratch[at - 20u + INVERSE] + scratch[at + INVERSE]) + scratch[at + 20u + INVERSE] > 0.0)) {
    return false;
  }
  let a = restOf(base + j - 1u);
  let b = restOf(base + j);
  if (!(a > 0.0 && b > 0.0)) {
    return false;
  }
  let near = 1.0 / a;
  let far = 1.0 / b;
  let kappa = (high - middle) * far - (middle - low) * near;
  /* Its limit, its tolerance, and what it gives by for what it has pushed. */
  let give = giveOf(scratch[at - 20u + INVERSE], scratch[at + INVERSE], scratch[at + 20u + INVERSE], a, b);
  let allowed = (limitOf(base + j, a, b) * (1.0 + BEND_TOLERANCE) + BEND_FLOOR * (near + far)) + give * max(-scratch[at + TURNED], 0.0);
  return dot(kappa, kappa) > allowed * allowed;
}

`;

export function ropeStepWgsl(options: RopeShaderOptions): EmittedWgsl {
  const tension = (statement: string): string => (options.tension ? statement : "");
  const struct = options.members.map((member) => `  ${member.name}: ${member.type},`).join("\n");
  const upstream = Array.from({ length: options.groups }, (_unused, group) => `@group(0) @binding(${group + 1}) var<storage, read> pk_${group}: array<u32>;`).join("\n");
  const own = options.groups + 1;
  const position = options.position;
  /** A station's weight at a slot: its mapped attribute, or the parameter. */
  const station = (key: "anchorFirst" | "anchorSecond" | "anchorLast", slot: string): string => {
    const region = options[key];
    return region === undefined ? `params.${key}` : scalarAt(region, slot);
  };
  const pinned = options.pin !== undefined;
  const bend = options.bend === true;
  /** Floats of scratch a point. A literal in the text, so the program without the limit is the text it was. */
  const stride = ropeScratchFloats(bend);
  const tridiagonalLoop = `  /* Stretch: Newton steps on the tridiagonal system. */
  let iterations = clamp(params.solves, 1u, MAX_ITERATIONS);
  var exceeded = false;
  for (var iteration = 0u; iteration < iterations; iteration = iteration + 1u) {
    /* Forward: eliminate. The first time through, each point is predicted as the sweep
       reaches it. Segment k's upper coefficient is known when segment k + 1's direction is,
       so it is written one step late. */
    var previousDirection = vec3f(0.0);
    var previousActive = false;
    var pivot = 1.0;
    var carried = 0.0;
    var lower = loadWork(base);
    var lowerInverse = scratch[base * 8u + INVERSE];
    for (var k = 0u; k < segments; k = k + 1u) {
      let slot = base + k;
      let at = slot * 8u;
      let rest = restOf(slot);
      var higher = vec3f(0.0);
      var higherInverse = 0.0;
      var gathered = 0.0;
      if (iteration == 0u) {
        s_reach = s_reach + rest * (1.0 + min(limit, max(REACH_SLACK, (REACH_SHARE * ((params.stretch * rest) / hh)) / params.inverseMass)));
        let placed = place(k + 1u);
        higher = placed.xyz;
        higherInverse = placed.w;
        storeWork(slot + 1u, higher);
        scratch[at + 8u + INVERSE] = higherInverse;
        scratch[at + MULTIPLIER] = 0.0;
      } else {
        higher = loadWork(slot + 1u);
        higherInverse = scratch[at + 8u + INVERSE];
        gathered = scratch[at + MULTIPLIER];
      }
      let here = segmentOf(lower, higher, rest);
      let sum = lowerInverse + higherInverse;
      if (sum > 0.0) {
        let alpha = (params.stretch * rest) / hh;
        var coupling = 0.0;
        var above = 0.0;
        if (previousActive) {
          coupling = -lowerInverse * dot(previousDirection, here.direction);
          above = coupling / pivot;
          scratch[at - 8u + UPPER] = above;
        }
        pivot = (sum * (1.0 + softening) + alpha) - coupling * above;
        carried = ((-here.error - alpha * gathered) - coupling * carried) / pivot;
        scratch[at + REDUCED] = carried;
        previousActive = true;
      } else {
        /* Both ends are held: nothing can move this segment, and nothing couples through it. */
        if (previousActive) {
          scratch[at - 8u + UPPER] = 0.0;
        }
        scratch[at + REDUCED] = 0.0;
        previousActive = false;
      }
      scratch[at + UPPER] = 0.0;
      previousDirection = here.direction;
      lower = higher;
      lowerInverse = higherInverse;
    }

    /* Back: substitute, move each point, store it, and look at what is left. A segment's
       later point is moved only after it was read, so its direction here is the forward
       sweep's. */
    var converged = true;
    exceeded = false;
    var nextMultiplier = 0.0;
    var nextDirection = vec3f(0.0);
    var higherWas = loadWork(base + segments);
    var aboveNow = vec3f(0.0);
    for (var back = 0u; back < segments; back = back + 1u) {
      let k = segments - 1u - back;
      let slot = base + k;
      let at = slot * 8u;
      let lowerWas = loadWork(slot);
      let here = segmentOf(lowerWas, higherWas, restOf(slot));
      let lambda = scratch[at + REDUCED] - scratch[at + UPPER] * nextMultiplier;
      let moved = higherWas + (here.direction * lambda - nextDirection * nextMultiplier) * scratch[at + 8u + INVERSE];
      storeWork(slot + 1u, moved);
      let total = scratch[at + MULTIPLIER] + lambda;
      scratch[at + MULTIPLIER] = total;
      if (scratch[at + 8u + INVERSE] > 0.0) {
        storePosition(slot + 1u, moved + origin);
        storeVelocity(slot + 1u, speedOf(k + 1u, moved));
      }
${tension("      storeTension(slot, (-total) / hh);\n")}      if (k + 1u < segments) {
        let left = look(base, k + 1u, moved, aboveNow, hh);
        if (left.x == 1u) {
          exceeded = true;
        }
        if (left.y == 1u) {
          converged = false;
        }
      }
      aboveNow = moved;
      higherWas = lowerWas;
      nextDirection = here.direction;
      nextMultiplier = lambda;
    }
    let solved = higherWas + (nextDirection * (-nextMultiplier)) * scratch[base * 8u + INVERSE];
    storeWork(base, solved);
    if (scratch[base * 8u + INVERSE] > 0.0) {
      storePosition(base, solved + origin);
      storeVelocity(base, (solved - firstStart) / h);
    }
    let left = look(base, 0u, solved, aboveNow, hh);
    if (left.x == 1u) {
      exceeded = true;
    }
    if (left.y == 1u) {
      converged = false;
    }
    if (converged) {
      break;
    }
  }

`;
  const bandedLoop = `  /* Bend Limit on: the stretch rows and the limit's active rows, one banded system. Rows
     run in strand order — the joint at point k, then the segment after it. */
  let iterations = clamp(params.solves, 1u, MAX_ITERATIONS);
  var exceeded = false;
  /* LENGTH BEFORE BEND. A step that ends with a segment beyond Max Stretch is one the solve
     could not finish with the limit in it: a limit that cannot be met pushes the strand
     against its own pins. It is solved again from where its points were placed, with no
     joint in the system: the rope keeps its length and its pins, and the bend gives.
     Where that step cannot be finished either (a step too coarse for the strand, limit or
     no limit) the first answer is the better one to hand the guard, and it is solved a
     third time as it was the first. "Beyond" here is beyond by more than the solve's own
     tolerance of a length (B277); the guard's test stays exact. */
  storePlaced(base, loadWork(base));
  /* What the hinge is told of the last Newton step run: whether the limit was in it, whether
     it left a segment out of its tolerance, whether it left anything out of its own, whether
     the step was solved more than once, whether a joint pushed, and whether one gave more
     than the yield. */
  var withLimit = true;
  /* With the limit on, what asks for another solve AND what calls the guard: a segment beyond
     Max Stretch by more than the solve's own tolerance (B277). The exact test fails on a
     rounding in every step at a Max Stretch of nothing. */
  var beyond = false;
  var lengthsOpen = false;
  var finished = true;
  var again = false;
  var pushing = false;
  var over = false;
  h_open = scratch[base * 20u + YIELDING] != 0.0;
  for (var attempt = 0u; attempt < 3u; attempt = attempt + 1u) {
    let limited = attempt != 1u;
    withLimit = limited;
    again = attempt > 0u;
    if (attempt > 0u) {
      storeWork(base, loadPlaced(base));
    }
    for (var iteration = 0u; iteration < iterations; iteration = iteration + 1u) {
      /* Before the first row the elimination's window is four rows of the identity. */
      e_d1 = 1.0;
      e_d2 = 1.0;
      e_d3 = 1.0;
      e_d4 = 1.0;
      e_z1 = 0.0;
      e_z2 = 0.0;
      e_z3 = 0.0;
      e_z4 = 0.0;
      e_m12 = 0.0;
      e_m13 = 0.0;
      e_m14 = 0.0;
      e_m23 = 0.0;
      e_m24 = 0.0;
      e_m34 = 0.0;

      /* Forward: each point is placed as the sweep reaches it (the first time through), then
         the joint at point k and the segment after it are eliminated, in that order. */
      var lower = loadWork(base);
      var beforeInverse = 0.0;
      var lowerInverse = scratch[base * 20u + INVERSE];
      var directionWas = vec3f(0.0);
      var directionBefore = vec3f(0.0);
      var sizeWas = 0.0;
      var restWas = 0.0;
      /* The gradient of the joint before this one on its own point and on the point after
         it, and of the one before that on the point after it. */
      var middleWas = vec3f(0.0);
      var highWas = vec3f(0.0);
      var highBefore = vec3f(0.0);
      for (var k = 0u; k < segments; k = k + 1u) {
        let slot = base + k;
        let at = slot * 20u;
        let rest = restOf(slot);
        var higher = vec3f(0.0);
        var higherInverse = 0.0;
        var gathered = 0.0;
        var pushed = 0.0;
        if (iteration == 0u) {
          if (attempt == 0u) {
            s_reach = s_reach + rest * (1.0 + min(limit, max(REACH_SLACK, (REACH_SHARE * ((params.stretch * rest) / hh)) / params.inverseMass)));
            let placed = place(k + 1u);
            higher = placed.xyz;
            higherInverse = placed.w;
            storePlaced(slot + 1u, higher);
            scratch[at + 20u + INVERSE] = higherInverse;
          } else {
            higher = loadPlaced(slot + 1u);
            higherInverse = scratch[at + 20u + INVERSE];
          }
          storeWork(slot + 1u, higher);
          scratch[at + MULTIPLIER] = 0.0;
          scratch[at + TURNED] = 0.0;
        } else {
          higher = loadWork(slot + 1u);
          higherInverse = scratch[at + 20u + INVERSE];
          gathered = scratch[at + MULTIPLIER];
          pushed = scratch[at + TURNED];
        }
        let here = measure(lower, higher, rest);

        /* The joint at point k: in the system while it is past its limit, has pushed in this
           step, or is within the band of its limit and has not yet been let go. */
        var low = vec3f(0.0);
        var middle = vec3f(0.0);
        var high = vec3f(0.0);
        var b1 = 0.0;
        var b2 = 0.0;
        var b3 = 0.0;
        var b4 = 0.0;
        var bDiagonal = 1.0;
        var bRight = 0.0;
        if (limited && k > 0u && restWas > 0.0 && rest > 0.0 && (beforeInverse + lowerInverse) + higherInverse > 0.0) {
          let apart = here.direction - directionWas;
          let gap = dot(apart, apart);
          let most = limitOf(slot, restWas, rest);
          let nearly = most * (1.0 - BEND_BAND);
          if (gap > most * most || pushed < 0.0 || (pushed == 0.0 && gap > nearly * nearly)) {
            let joint = hinge(directionWas, sizeWas, here.direction, here.size);
            if (joint.ok) {
              low = joint.low;
              middle = joint.middle;
              high = joint.high;
              let give = giveOf(beforeInverse, lowerInverse, higherInverse, restWas, rest);
              bDiagonal = (((beforeInverse * dot(low, low)) + (lowerInverse * dot(middle, middle))) + (higherInverse * dot(high, high))) + give;
              /* Back to its limit and no further, a part of the way at a time; a joint inside it is
                 asked for nothing. And it gives by what it has pushed so far. */
              bRight = max(min(2.0 * asin(most / 2.0) - joint.turn, 0.0), -BEND_STEP) - give * min(pushed, 0.0);
              /* With the segment before it, the joint before it, and the segment and joint before those. */
              b1 = lowerInverse * dot(middle, directionWas) - beforeInverse * dot(low, directionWas);
              b2 = beforeInverse * dot(low, middleWas) + lowerInverse * dot(middle, highWas);
              b3 = beforeInverse * dot(low, directionBefore);
              b4 = beforeInverse * dot(low, highBefore);
            }
          }
        }
        eliminate(at + JOINT_ROW, b1, b2, b3, b4, bDiagonal, bRight);

        /* The segment after point k. */
        let sum = lowerInverse + higherInverse;
        var s1 = 0.0;
        var s2 = 0.0;
        var s3 = 0.0;
        var sDiagonal = 1.0;
        var sRight = 0.0;
        if (sum > 0.0) {
          let alpha = (params.stretch * rest) / hh;
          /* With its own joint, the segment before it, and the joint before that. */
          s1 = higherInverse * dot(here.direction, high) - lowerInverse * dot(here.direction, middle);
          s2 = -lowerInverse * dot(directionWas, here.direction);
          s3 = -lowerInverse * dot(here.direction, highWas);
          sDiagonal = sum * (1.0 + softening) + alpha;
          sRight = -here.error - alpha * gathered;
        }
        eliminate(at + SEGMENT_ROW, s1, s2, s3, 0.0, sDiagonal, sRight);

        directionBefore = directionWas;
        directionWas = here.direction;
        sizeWas = here.size;
        restWas = rest;
        highBefore = highWas;
        middleWas = middle;
        highWas = high;
        beforeInverse = lowerInverse;
        lowerInverse = higherInverse;
        lower = higher;
      }

      /* Back: substitute row by row, move each point, store it, and look at what is left. */
      var converged = true;
      exceeded = false;
      beyond = false;
      lengthsOpen = false;
      pushing = false;
      over = false;
      e_p1 = 0.0;
      e_p2 = 0.0;
      e_p3 = 0.0;
      e_p4 = 0.0;
      /* Of the segment after this one: its direction and multiplier. Of the joint at its far
         end: its gradient on the point before it and on itself. Of the joint after that: on
         the point before it. */
      var directionNext = vec3f(0.0);
      var stretchNext = 0.0;
      var lowNext = vec3f(0.0);
      var middleNext = vec3f(0.0);
      var turnNext = 0.0;
      var lowAfter = vec3f(0.0);
      var turnAfter = 0.0;
      var aboveNow = vec3f(0.0);
      var aboveNext = vec3f(0.0);
      for (var back = 0u; back < segments; back = back + 1u) {
        let k = segments - 1u - back;
        let slot = base + k;
        let at = slot * 20u;
        let stretchHere = substitute(at + SEGMENT_ROW);
        let turnHere = substitute(at + JOINT_ROW);
        let lowerWas = loadWork(slot);
        let higherWas = loadWork(slot + 1u);
        let restHere = restOf(slot);
        let here = measure(lowerWas, higherWas, restHere);
        /* The joint's gradient, from the three points as they were: only a joint that was in
           the system has a multiplier. */
        var low = vec3f(0.0);
        var middle = vec3f(0.0);
        var high = vec3f(0.0);
        if (turnHere != 0.0) {
          let first = measure(loadWork(slot - 1u), lowerWas, restOf(slot - 1u));
          let joint = hinge(first.direction, first.size, here.direction, here.size);
          if (joint.ok) {
            low = joint.low;
            middle = joint.middle;
            high = joint.high;
          }
        }
        /* Point k + 1: the segment before it and after it, the joint before it, its own, and the one after. */
        var push = here.direction * stretchHere - directionNext * stretchNext;
        push = push + high * turnHere;
        push = push + middleNext * turnNext;
        push = push + lowAfter * turnAfter;
        let moved = higherWas + push * scratch[at + 20u + INVERSE];
        storeWork(slot + 1u, moved);
        let total = scratch[at + MULTIPLIER] + stretchHere;
        scratch[at + MULTIPLIER] = total;
        let turnedNow = scratch[at + TURNED] + turnHere;
        scratch[at + TURNED] = turnedNow;
        /* A joint in the system that ends up holding the strand BENT has to be let go: the limit is one-sided. */
        if (turnHere != 0.0 && turnedNow > 0.0) {
          converged = false;
        }
        if (limited && k > 0u && turnedNow < 0.0) {
          pushing = true;
          if (giveOf(scratch[at - 20u + INVERSE], scratch[at + INVERSE], scratch[at + 20u + INVERSE], restOf(slot - 1u), restHere) * (-turnedNow) > BEND_YIELD) {
            over = true;
          }
        }
        if (scratch[at + 20u + INVERSE] > 0.0) {
          storePosition(slot + 1u, moved + origin);
          storeVelocity(slot + 1u, speedOf(k + 1u, moved));
        }
  ${tension("      storeTension(slot, (-total) / hh);\n")}      if (k + 1u < segments) {
          let left = look(base, k + 1u, moved, aboveNow, hh);
          if (left.x == 1u) {
            exceeded = true;
            if (past(base, k + 1u, moved, aboveNow)) {
              beyond = true;
            }
          }
          if (left.y == 1u) {
            converged = false;
            lengthsOpen = true;
          }
        }
        if (k + 2u < segments) {
          if (lookAt(base, k + 2u, moved, aboveNow, aboveNext)) {
            converged = false;
          }
        }
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
      /* The first point: the segment after it, and the joint at the second point. */
      let pushFirst = directionNext * (-stretchNext) + lowAfter * turnAfter;
      let solved = loadWork(base) + pushFirst * scratch[base * 20u + INVERSE];
      storeWork(base, solved);
      if (scratch[base * 20u + INVERSE] > 0.0) {
        storePosition(base, solved + origin);
        storeVelocity(base, (solved - firstStart) / h);
      }
      let left = look(base, 0u, solved, aboveNow, hh);
      if (left.x == 1u) {
        exceeded = true;
        if (past(base, 0u, solved, aboveNow)) {
          beyond = true;
        }
      }
      if (left.y == 1u) {
        converged = false;
        lengthsOpen = true;
      }
      if (segments > 1u) {
        if (lookAt(base, 1u, solved, aboveNow, aboveNext)) {
          converged = false;
        }
      }
      finished = converged;
      if (converged) {
        break;
      }
    }
    if (!beyond) {
      break;
    }
  }

  /* THE HINGE (the reference's D41): a limit that cannot be met is opened; one whose joint
     has straightened follows it in. A strand none of whose joints has an opening or a clock,
     after a step solved with the limit in which none is in trouble, has nothing to do here. */
  if (!withLimit || over || (pushing && lengthsOpen) || h_open) {
    var kept_any = 0.0;
    for (var j = 1u; j < segments; j = j + 1u) {
      let slot = base + j;
      let at = slot * 20u;
      let beforeInverse = scratch[at - 20u + INVERSE];
      let hereInverse = scratch[at + INVERSE];
      let afterInverse = scratch[at + 20u + INVERSE];
      if (!((beforeInverse + hereInverse) + afterInverse > 0.0)) {
        continue;
      }
      let a = restOf(slot - 1u);
      let b = restOf(slot);
      if (!(a > 0.0 && b > 0.0)) {
        continue;
      }
      var opening = kept[slot * 2u + 1u].w;
      var yielding = scratch[at + YIELDING];
      var gave = 0.0;
      if (withLimit) {
        gave = giveOf(beforeInverse, hereInverse, afterInverse, a, b) * max(-scratch[at + TURNED], 0.0);
      }
      let troubled = gave > BEND_YIELD || (gave > 0.0 && lengthsOpen);
      if (withLimit && !troubled && !(opening > 0.0) && yielding == 0.0) {
        continue;
      }
      /* How far past its limit, as it is with nothing open, the joint stands. */
      let middle = loadWork(slot);
      let first = measure(loadWork(slot - 1u), middle, a);
      let second = measure(middle, loadWork(slot + 1u), b);
      let apart = second.direction - first.direction;
      let together = second.direction + first.direction;
      let turn = 2.0 * atan2(sqrt(dot(apart, apart)), sqrt(dot(together, together)));
      let excess = turn - 2.0 * asin(mostOf(a, b) / 2.0);
      if (!withLimit) {
        /* The step was solved without the limit: toward where that left the joint. */
        yielding = 0.0;
        if (excess > opening) {
          opening = min(excess, opening + BEND_OPEN_AGAIN);
        }
      } else if (troubled) {
        /* In trouble: it gives more than the yield, or it pushes on a strand that could not keep its lengths. */
        yielding = max(yielding, 0.0) + h;
        if (yielding > BEND_YIELD_WAIT) {
          if (gave > BEND_YIELD) {
            opening = opening + min((gave - BEND_YIELD / 2.0) / 2.0, BEND_OPEN_MOST);
          } else {
            /* To where the joint stands, with a gap, and left alone: it asks nothing more of the strand. */
            opening = max(opening, excess + BEND_GAP);
            yielding = LEFT_ALONE;
          }
        }
      } else if (!(yielding < 0.0)) {
        yielding = 0.0;
        /* An open limit closes onto a joint that gives less than half the yield, a step at a time, while the solve finishes. */
        if (opening > 0.0 && gave < BEND_YIELD / 2.0 && finished && !again) {
          opening = max(0.0, opening - BEND_CLOSE);
        }
      }
      if (yielding < 0.0) {
        /* Left alone: its limit follows the joint in only once the joint has come in by more
           than the gap, and is then left alone no longer. */
        if (excess + 2.0 * BEND_GAP < opening) {
          opening = max(0.0, excess + BEND_GAP);
          yielding = 0.0;
        }
      } else if (opening > 0.0 && excess + BEND_GAP < opening) {
        /* ...and at once behind a joint that has straightened. */
        opening = max(0.0, excess + BEND_GAP);
      }
      if (!(excess > 0.0)) {
        opening = 0.0;
        if (yielding < 0.0) {
          yielding = 0.0;
        }
      }
      kept[slot * 2u + 1u].w = opening;
      scratch[at + YIELDING] = yielding;
      if (opening > 0.0 || yielding != 0.0) {
        kept_any = 1.0;
      }
    }
    scratch[base * 20u + YIELDING] = kept_any;
  }

`;
  return wgsl`struct RopeParams {
${struct}
};

@group(0) @binding(0) var<uniform> params: RopeParams;
${upstream}
@group(0) @binding(${own}) var<storage, read> state_in: array<u32>;
@group(0) @binding(${own + 1}) var<storage, read_write> state_out: array<u32>;
@group(0) @binding(${own + 2}) var<storage, read_write> kept: array<vec4f>;
@group(0) @binding(${own + 3}) var<storage, read_write> scratch: array<f32>;

/* A segment at or below this squared length has no direction. */
const ZERO_SEGMENT_SQUARED: f32 = ${ZERO_SEGMENT_SQUARED};
/* A segment is at its length when within this share of it, plus a floor in metres. */
const TOLERANCE: f32 = ${literal(ROPE_TOLERANCE)};
const TOLERANCE_FLOOR: f32 = ${ROPE_TOLERANCE_FLOOR};
const MAX_ITERATIONS: u32 = ${ROPE_MAX_ITERATIONS}u;
/* What each pivot is raised by, as a share of it, on a strand with two or more anchors. */
const PIN_SOFTENING: f32 = ${literal(ROPE_PIN_SOFTENING)};
/* How far past its rest length a pin may ask a segment to be, as a share of Stretch x length x mass / step squared (B276). */
const REACH_SHARE: f32 = ${literal(ROPE_REACH_SHARE)};
/* ...and the least it reaches past it where Max Stretch allows any: an eighth of the solve's tolerance of a length. */
const REACH_SLACK: f32 = ${literal(ROPE_REACH_SLACK)};
/* A pin attribute is named: every point may be anchored, and keeps its target's history. */
const PINNED: bool = ${pinned ? "true" : "false"};
const TAU: f32 = 6.283185307179586;
/* A weight this near 1, or nearer, is 1: one that was computed can land a rounding short of it. */
const HELD_FROM: f32 = ${ROPE_HELD_FROM};

/* A weight as the step reads it: 0 to 1, and 1 from HELD_FROM up. */
fn held(raw: f32) -> f32 {
  if (raw >= HELD_FROM) {
    return 1.0;
  }
  return clamp(raw, 0.0, 1.0);
}

/* The incoming point of a slot: the pose a strand is seeded on, and its anchors' target. */
fn incomingAt(slot: u32) -> vec3f {
  let o = ${position.word}u + slot * 4u;
  return bitcast<vec3f>(vec3u(pk_${position.group}[o], pk_${position.group}[o + 1u], pk_${position.group}[o + 2u]));
}

${options.loadFunctions}

${options.storeFunctions}

${bend ? BEND_LAYOUT : TRIDIAGONAL_LAYOUT}

fn loadWork(slot: u32) -> vec3f {
  let o = slot * ${stride}u;
  return vec3f(scratch[o], scratch[o + 1u], scratch[o + 2u]);
}

fn storeWork(slot: u32, value: vec3f) {
  let o = slot * ${stride}u;
  scratch[o] = value.x;
  scratch[o + 1u] = value.y;
  scratch[o + 2u] = value.z;
}

struct Segment {
  direction: vec3f,
  error: f32,
};

/* A segment's unit direction and how far it is from its length; neither when it has no extent. */
fn segmentOf(lower: vec3f, upper: vec3f, rest: f32) -> Segment {
  let span = upper - lower;
  let squared = dot(span, span);
  if (!(squared > ZERO_SEGMENT_SQUARED)) {
    return Segment(vec3f(0.0), 0.0);
  }
  let size = sqrt(squared);
  return Segment(span / size, size - rest);
}

/* The rest length of the segment after a slot: the Segment Length when one is given, else
   the length measured when the strand was seeded; times the Rest Length Scale. */
fn restOf(slot: u32) -> f32 {
  var rest = kept[slot * 2u].w;
  if (params.segmentLength > 0.0) {
    rest = params.segmentLength;
  }
  return rest * params.restLengthScale;
}

/* A strand on its incoming points, at rest, its segments measured. */
fn seedStrand(base: u32, cols: u32) {
  for (var i = 0u; i < cols; i = i + 1u) {
    let slot = base + i;
    let here = incomingAt(slot);
    storePosition(slot, here);
    storeVelocity(slot, vec3f(0.0));
${tension("    storeTension(slot, 0.0);\n")}    var rest = 0.0;
    if (i + 1u < cols) {
      let span = incomingAt(slot + 1u) - here;
      rest = sqrt(dot(span, span));
    }
    kept[slot * 2u] = vec4f(here, rest);
    kept[slot * 2u + 1u] = vec4f(0.0);
    /* No point was held at a step before this one. */
    scratch[slot * ${stride}u + INVERSE] = 1.0;
${bend ? "    /* ...and no joint has a clock. */\n    scratch[slot * 20u + YIELDING] = 0.0;\n" : ""}  }
}

/* A step of no length: every word a run writes, carried over as it is. */
fn holdStrand(base: u32, cols: u32) {
  for (var i = 0u; i < cols; i = i + 1u) {
    let slot = base + i;
    storePosition(slot, loadPosition(slot));
    storeVelocity(slot, loadVelocity(slot));
${tension("    storeTension(slot, loadTension(slot));\n")}  }
}

/* What is left of segment k between these two points after a Newton step: x is 1 when it
   is beyond Max Stretch, y is 1 when it is not yet within tolerance of its length. */
fn look(base: u32, k: u32, low: vec3f, high: vec3f, hh: f32) -> vec2u {
  let at = (base + k) * ${stride}u;
  if (!(scratch[at + INVERSE] + scratch[at + ${stride}u + INVERSE] > 0.0)) {
    return vec2u(0u, 0u);
  }
  let rest = restOf(base + k);
  let span = high - low;
  let squared = dot(span, span);
  let most = rest * (1.0 + params.maxStretch);
  /* A segment cannot be shorter than nothing: past a Max Stretch of 1 only the long side limits. */
  let least = rest * max(0.0, 1.0 - params.maxStretch);
  var beyond = 0u;
  if (squared > most * most || squared < least * least) {
    beyond = 1u;
  }
  /* How far off its length, to first order: no square root where a yes or no is wanted. */
  var off = sqrt(squared);
  if (rest > 0.0) {
    off = (squared - rest * rest) / (2.0 * rest);
  }
  let residual = abs(off + ((params.stretch * rest) / hh) * scratch[at + MULTIPLIER]);
  var open = 1u;
  if (residual <= TOLERANCE * rest + TOLERANCE_FLOOR) {
    open = 0u;
  }
  return vec2u(beyond, open);
}

/* A point set no nearer and no further from another than its segment may be: Max Stretch,
   on both sides of the rest length. A segment let go in this step (the reference's D38) is
   taken up to its own length: what it was held over-long by is no stretch the rope earned. */
fn within(solved: vec3f, other: vec3f, rest: f32, letGo: bool) -> vec3f {
  let span = solved - other;
  let squared = dot(span, span);
  if (!(squared > ZERO_SEGMENT_SQUARED)) {
    return solved;
  }
  let size = sqrt(squared);
  var most = rest * (1.0 + params.maxStretch);
  if (letGo) {
    most = rest;
  }
  let least = rest * max(0.0, 1.0 - params.maxStretch);
  if (size > most) {
    return other + span * (most / size);
  }
  if (size < least) {
    return other + span * (least / size);
  }
  return solved;
}

/* What place() needs of the strand it is walking, set once by main(). */
var<private> s_base: u32;
var<private> s_cols: u32;
var<private> s_segments: u32;
var<private> s_h: f32;
var<private> s_keep: f32;
var<private> s_drop: f32;
var<private> s_turn: f32;
var<private> s_ratio: f32;
var<private> s_frameSeconds: f32;
var<private> s_lastSubstep: bool;
var<private> s_hard: bool;
var<private> s_firstWeight: f32;
var<private> s_secondWeight: f32;
var<private> s_lastWeight: f32;
var<private> s_originWas: vec3f;
var<private> s_origin: vec3f;
var<private> s_beforeFirst: vec3f;
var<private> s_jump: vec3f;
var<private> s_jumped: bool;
/* The nearest hard pin the walk has passed, and how much rope there is from it to here. */
var<private> s_pinAt: vec3f;
var<private> s_hasPin: bool;
/* Whether a point the solve can move has been placed since that pin. */
var<private> s_free: bool;
var<private> s_reach: f32;
/* The last hard pin on the strand, by point; -1 when it has none. */
var<private> s_lastPin: i32;
/* THE SPEEDLESS TAKE-UP (the reference's D38). Two held points that are neighbours hold the
   segment between them at whatever length they are told. In the step one of them comes free,
   that segment is the rope's again and takes its own length back, in POSITIONS ONLY.
   s_released is the first point after such a segment, or the strand's point count: from it
   on, a point is stored with the speed it was predicted with. The other two: whether the
   point before the one being placed was a hard pin at the last step, and is one in this. */
var<private> s_released: u32;
var<private> s_heldBefore: bool;
var<private> s_heldBehind: bool;

/* Predict point i, pull it by its anchor, and hand the solve its working position (xyz) and
   its inverse mass (w). A hard pin is STORED here, as its target, and the solve does not
   move it. */
fn place(i: u32) -> vec4f {
  let slot = s_base + i;
  let start = loadPosition(slot) - s_originWas;
  let v = loadVelocity(slot) * s_keep;
  var placed = vec3f(start.x + v.x * s_h, (start.y + v.y * s_h) - s_drop, start.z + v.z * s_h);
  var weighs = params.inverseMass;
  var station = 0.0;
  if (i == 0u) {
    station = s_firstWeight;
  } else {
    if (i == 1u) {
      station = s_secondWeight;
    }
    if (i == s_segments) {
      station = max(station, s_lastWeight);
    }
  }
  if (PINNED || i <= 1u || i == s_segments) {
    /* The target's history is kept whatever the weight is, so one that rises from nothing
       finds a target that was already being followed. */
    let now = incomingAt(slot);
    let keptHere = kept[slot * 2u];
    var before = keptHere.xyz;
    if (i == 0u) {
      before = s_beforeFirst;
    } else if (s_jumped) {
      before = keptHere.xyz + s_jump;
    }
    let travelled = now - before;
    var here = now;
    if (!s_lastSubstep) {
      here = before + travelled * (f32(params.substep + 1u) / f32(params.substeps));
    }
    let was = before + travelled * (f32(params.substep) / f32(params.substeps));
    if (s_lastSubstep) {
      kept[slot * 2u] = vec4f(now, keptHere.w);
    } else if (s_jumped || i == 0u) {
      kept[slot * 2u] = vec4f(before, keptHere.w);
    }
    if (i == 0u && s_lastSubstep) {
      kept[slot * 2u + 1u] = vec4f(travelled / s_frameSeconds, 0.0);
    }

    let pin = ${pinned ? `held(${scalarAt(options.pin as RopeScalarRegion, "slot")})` : "0.0"};
    let weight = max(station, pin);
    if (weight > 0.0) {
      let hereLocal = here - s_origin;
      var goal = hereLocal;
      var drawnIn = false;
      let pins = s_hard && weight >= 1.0;
      /* The earlier pin wins: a target out of its reach is drawn in along the line to it.
         Not a hard pin that follows a hard pin with nothing movable between them: no segment
         there has anything to solve, and a held point is where it is told to be. */
      if (s_hasPin && (s_free || !pins)) {
        let span = goal - s_pinAt;
        let squared = dot(span, span);
        if (squared > s_reach * s_reach) {
          goal = s_pinAt + span * (s_reach / sqrt(squared));
          drawnIn = true;
        }
      }
      if (pins) {
        placed = goal;
        weighs = 0.0;
        s_free = false;
        var stored = here;
        if (drawnIn) {
          stored = goal + s_origin;
        }
        storePosition(slot, stored);
        storeVelocity(slot, (goal - start) / s_h);
        s_pinAt = goal;
        s_hasPin = true;
        s_reach = 0.0;
        s_lastPin = i32(i);
      } else {
        /* A spring to the target, stepped implicitly: part of the way there, and heavier.
           Sized for the mass it carries: the strand's for a station, the point's for a pin. */
        var gain = weight;
        if (s_hard) {
          gain = weight / (1.0 - weight);
        }
        var carried = 1.0;
        if (station > 0.0 && station >= pin) {
          carried = f32(s_cols);
        }
        let pull = ((s_turn * s_turn) * gain) * carried;
        let drag = ((s_ratio * s_turn) * sqrt(gain)) * carried;
        let total = (1.0 + pull) + drag;
        let damper = start + (hereLocal - (was - s_origin));
        placed = ((placed + goal * pull) + damper * drag) / total;
        weighs = weighs / total;
      }
    }
  }
  if (weighs > 0.0) {
    s_free = true;
  }
  /* The point's inverse mass at the last step is still in scratch: the caller writes this step's after this. */
  let wasHeld = !(scratch[slot * ${stride}u + INVERSE] > 0.0);
  let isHeld = !(weighs > 0.0);
  if (i > 0u && s_released == s_cols && s_heldBefore && wasHeld && !(s_heldBehind && isHeld)) {
    s_released = i;
  }
  s_heldBefore = wasHeld;
  s_heldBehind = isHeld;
  return vec4f(placed, weighs);
}

/* The speed point i is stored with, moved to here by the step: what moved it, or from the
   first released point on what it was predicted with. */
fn speedOf(i: u32, moved: vec3f) -> vec3f {
  let slot = s_base + i;
  if (i < s_released) {
    return (moved - (loadPosition(slot) - s_originWas)) / s_h;
  }
  let v = loadVelocity(slot) * s_keep;
  return vec3f(v.x, v.y - s_drop / s_h, v.z);
}

${bend ? BEND_FUNCTIONS : ""}@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let strand = gid.x;
  if (strand >= params.rows) {
    return;
  }
  let cols = params.cols;
  let base = strand * cols;
  let segments = cols - 1u;
  let h = params.deltaSeconds * params.speed;
  if (params.firstRun == 1u || params.reset == 1u) {
    seedStrand(base, cols);
    return;
  }
  if (!(h > 0.0)) {
    holdStrand(base, cols);
    return;
  }

  /* The strand's three stations: how firmly each is held, as a number or by its map. */
  let firstWeight = held(${station("anchorFirst", "base")});
  var secondWeight = 0.0;
  var lastWeight = 0.0;
  if (segments > 0u) {
    secondWeight = held(${station("anchorSecond", "(base + 1u)")});
    lastWeight = held(${station("anchorLast", "(base + segments)")});
  }
  var stations = 0u;
  if (firstWeight > 0.0) {
    stations = stations + 1u;
  }
  if (secondWeight > 0.0) {
    stations = stations + 1u;
  }
  if (lastWeight > 0.0) {
    stations = stations + 1u;
  }
  let anchored = stations > 0u || PINNED;
  /* Two anchors can hold a taut strand between them, whose tension the constraints leave open. */
  var softening = 0.0;
  if (stations > 1u || PINNED) {
    softening = PIN_SOFTENING;
  }

  /* A teleport is judged on the first point's target: where it is now, and a frame ago. */
  let targetFirst = incomingAt(base);
  let rateWas = kept[base * 2u + 1u].xyz;
  var beforeFirst = kept[base * 2u].xyz;
  var jump = vec3f(0.0);
  var jumped = false;
  let teleport = params.teleportDistance;
  /* The frame's whole step: an anchor's target moves in frame time, whatever Simulation Speed is. */
  let frameSeconds = params.deltaSeconds * f32(params.substeps);
  if (anchored && params.substep == 0u && teleport > 0.0) {
    let moved = targetFirst - beforeFirst;
    if (dot(moved, moved) > teleport * teleport) {
      if (params.teleportMode == 1u) {
        seedStrand(base, cols);
        return;
      }
      /* Carry: the strand goes with the jump, and its anchors are not dragged across it.
         What the first target travels in this frame at the speed it had is NOT part of the
         jump: it is taken to have come from where that speed puts it, so a body that wraps
         its world while moving keeps moving through the wrap. Every other target's history
         goes with the strand, by the same jump. */
      let start = targetFirst - rateWas * frameSeconds;
      jump = start - beforeFirst;
      beforeFirst = start;
      jumped = true;
    }
  }

  /* The walk works relative to the strand's first point, so a strand far from the origin
     does the arithmetic of one at it. */
  let originWas = loadPosition(base);
  let origin = originWas + jump;
  let hh = h * h;
  let limit = params.maxStretch;

  s_base = base;
  s_cols = cols;
  s_segments = segments;
  s_h = h;
  s_keep = 1.0 / (1.0 + params.damping * h);
  s_drop = (params.gravity * h) * h;
  s_turn = (TAU * params.anchorStrength) * h;
  s_ratio = 2.0 * params.anchorDamping;
  s_frameSeconds = frameSeconds;
  s_lastSubstep = params.substep + 1u == params.substeps;
  s_hard = params.anchorMode == 0u;
  s_firstWeight = firstWeight;
  s_secondWeight = secondWeight;
  s_lastWeight = lastWeight;
  s_originWas = originWas;
  s_origin = origin;
  s_beforeFirst = beforeFirst;
  s_jump = jump;
  s_jumped = jumped;
  s_pinAt = vec3f(0.0);
  s_hasPin = false;
  s_free = false;
  s_reach = 0.0;
  s_lastPin = -1;
  s_released = cols;
  s_heldBefore = false;
  s_heldBehind = false;

  /* The first point: predicted, then pulled by its anchor. */
  let firstStart = loadPosition(base) - originWas;
  let first = place(0u);
  storeWork(base, first.xyz);
  scratch[base * ${stride}u + INVERSE] = first.w;
${tension("  storeTension(base + segments, 0.0);\n")}
  if (segments == 0u) {
    if (first.w > 0.0) {
      storePosition(base, first.xyz + origin);
      storeVelocity(base, (first.xyz - firstStart) / h);
    }
    return;
  }

${bend ? bandedLoop : tridiagonalLoop}  /* The guard: only on a step that left a segment beyond Max Stretch, or let one go. Positions only. */
  if (!${bend ? "beyond" : "exceeded"} && s_released == cols) {
    return;
  }
  /* BACK FROM THE LAST PIN FIRST (the design's D24). The walk out from the first point
     moves each segment's later point and leaves a pinned one, so on a strand held further
     along, whatever the solve did not close used to land on the one segment before that
     pin. So the points before the last hard pin are first drawn in toward it, each to its
     segment's length from the point after it, and the walk out then finds them nearly in
     place. A strand with no pin past its first point has nothing to walk back from. */
  if (s_lastPin > 0) {
    let last = u32(s_lastPin);
    var ahead = loadWork(base + last);
    for (var back = 0u; back < last; back = back + 1u) {
      let slot = base + last - 1u - back;
      var placed = loadWork(slot);
      if (scratch[slot * ${stride}u + INVERSE] > 0.0) {
        placed = within(placed, ahead, restOf(slot), last - back >= s_released);
        storeWork(slot, placed);
      }
      ahead = placed;
    }
    if (scratch[base * ${stride}u + INVERSE] > 0.0) {
      storePosition(base, loadWork(base) + origin);
    }
  }
  var resting = loadWork(base);
  for (var i = 1u; i < cols; i = i + 1u) {
    let slot = base + i;
    var placed = loadWork(slot);
    if (scratch[slot * ${stride}u + INVERSE] > 0.0) {
      placed = within(placed, resting, restOf(slot - 1u), i >= s_released);
    }
    resting = placed;
    /* A pinned point keeps the target it was stored at. */
    if (scratch[slot * ${stride}u + INVERSE] > 0.0) {
      storePosition(slot, placed + origin);
    }
  }
}`;
}
