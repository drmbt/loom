import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { ZERO_SEGMENT_SQUARED } from "../../points/curve.ts";
import {
  ROPE_ANCHOR_DAMPING_RATIO,
  ROPE_ANCHOR_STRENGTH_HZ,
  ROPE_MAX_ITERATIONS,
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
 *    point, written when a strand is seeded and once a frame for an anchored point. In the
 *    pair it would be copied across by every run;
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
 * The uniform block's first four members are the backend's, written for every run of a
 * stepped dispatch (`dispatchStepUniforms`): the frame's step divided by the substep count,
 * which substep this is and of how many, and `firstRun` on run 0 of a frame whose storage
 * is fresh.
 */

export interface RopeShaderOptions {
  /** Load functions over `state_in`: `loadPosition`, `loadVelocity`, and `loadTension` when it is stored. */
  readonly loadFunctions: string;
  /** Store functions over `state_out`: `storePosition`, `storeVelocity`, and `storeTension`. */
  readonly storeFunctions: string;
  /** The node publishes `tension`, so the state carries it. */
  readonly tension: boolean;
}

const literal = (value: number): string => {
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
};

export function ropeStepWgsl(options: RopeShaderOptions): EmittedWgsl {
  const tension = (statement: string): string => (options.tension ? statement : "");
  return wgsl`struct RopeParams {
  deltaSeconds: f32,
  substep: u32,
  substeps: u32,
  firstRun: u32,
  cols: u32,
  rows: u32,
  solves: u32,
  reset: u32,
  teleportMode: u32,
  speed: f32,
  gravity: f32,
  damping: f32,
  inverseMass: f32,
  restLengthScale: f32,
  stretch: f32,
  maxStretch: f32,
  anchorFirst: f32,
  teleportDistance: f32,
};

@group(0) @binding(0) var<uniform> params: RopeParams;
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(2) var<storage, read> state_in: array<u32>;
@group(0) @binding(3) var<storage, read_write> state_out: array<u32>;
@group(0) @binding(4) var<storage, read_write> kept: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> scratch: array<f32>;

/* A segment at or below this squared length has no direction. */
const ZERO_SEGMENT_SQUARED: f32 = ${ZERO_SEGMENT_SQUARED};
/* A segment is at its length when within this share of it, plus a floor in metres. */
const TOLERANCE: f32 = ${literal(ROPE_TOLERANCE)};
const TOLERANCE_FLOOR: f32 = ${ROPE_TOLERANCE_FLOOR};
const MAX_ITERATIONS: u32 = ${ROPE_MAX_ITERATIONS}u;
/* A partly weighted anchor's pull: its natural frequency in turns a second, and its damping ratio. */
const ANCHOR_TURNS: f32 = ${literal(ROPE_ANCHOR_STRENGTH_HZ)};
const ANCHOR_RATIO: f32 = ${literal(ROPE_ANCHOR_DAMPING_RATIO)};
const TAU: f32 = 6.283185307179586;

${options.loadFunctions}

${options.storeFunctions}

/* The eight floats scratch holds per point: its strand-relative position while a step
   solves (three), its inverse mass, and for the segment AFTER it the elimination's upper
   coefficient, its reduced right-hand side and the multiplier summed over the Newton steps. */
const INVERSE: u32 = 3u;
const UPPER: u32 = 4u;
const REDUCED: u32 = 5u;
const MULTIPLIER: u32 = 6u;

fn loadWork(slot: u32) -> vec3f {
  let o = slot * 8u;
  return vec3f(scratch[o], scratch[o + 1u], scratch[o + 2u]);
}

fn storeWork(slot: u32, value: vec3f) {
  let o = slot * 8u;
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

/* A strand on its incoming points, at rest, its segments measured. */
fn seedStrand(base: u32, cols: u32) {
  for (var i = 0u; i < cols; i = i + 1u) {
    let slot = base + i;
    let here = in_position[slot];
    storePosition(slot, here);
    storeVelocity(slot, vec3f(0.0));
${tension("    storeTension(slot, 0.0);\n")}    var rest = 0.0;
    if (i + 1u < cols) {
      let span = in_position[slot + 1u] - here;
      rest = sqrt(dot(span, span));
    }
    kept[slot * 2u] = vec4f(here, rest);
    kept[slot * 2u + 1u] = vec4f(0.0);
  }
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
  let at = (base + k) * 8u;
  if (!(scratch[at + INVERSE] + scratch[at + 8u + INVERSE] > 0.0)) {
    return vec2u(0u, 0u);
  }
  let rest = kept[(base + k) * 2u].w * params.restLengthScale;
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

@compute @workgroup_size(64)
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

  /* The first point's anchor: its target now, and where the target was a frame ago. */
  let weight = clamp(params.anchorFirst, 0.0, 1.0);
  let targetNow = in_position[base];
  let keptFirst = kept[base * 2u];
  let rateWas = kept[base * 2u + 1u].xyz;
  var before = keptFirst.xyz;
  var jump = vec3f(0.0);
  let reach = params.teleportDistance;
  /* The frame's whole step: an anchor's target moves in frame time, whatever Simulation Speed is. */
  let frameSeconds = params.deltaSeconds * f32(params.substeps);
  if (weight > 0.0 && params.substep == 0u && reach > 0.0) {
    let moved = targetNow - before;
    if (dot(moved, moved) > reach * reach) {
      if (params.teleportMode == 1u) {
        seedStrand(base, cols);
        return;
      }
      /* Carry: the strand goes with the jump, and its anchor is not dragged across it. What
         the anchor travels in this frame at the speed it had is NOT part of the jump: the
         target is taken to have come from where that speed puts it, so a body that wraps
         its world while moving keeps moving through the wrap. */
      let start = targetNow - rateWas * frameSeconds;
      jump = start - before;
      before = start;
    }
  }
  let lastSubstep = params.substep + 1u == params.substeps;
  let travelled = targetNow - before;
  var targetHere = targetNow;
  if (!lastSubstep) {
    targetHere = before + travelled * (f32(params.substep + 1u) / f32(params.substeps));
  }
  let targetWas = before + travelled * (f32(params.substep) / f32(params.substeps));
  /* Kept for the next frame's steps: where the target stood when this frame ended, and
     how fast it had moved to get there. */
  kept[base * 2u] = vec4f(before, keptFirst.w);
  if (lastSubstep) {
    kept[base * 2u] = vec4f(targetNow, keptFirst.w);
    kept[base * 2u + 1u] = vec4f(travelled / frameSeconds, 0.0);
  }

  /* The walk works relative to the strand's first point, so a strand far from the origin
     does the arithmetic of one at it. */
  let originWas = loadPosition(base);
  let origin = originWas + jump;
  let targetLocal = targetHere - origin;
  let targetWasLocal = targetWas - origin;

  let keep = 1.0 / (1.0 + params.damping * h);
  let drop = (params.gravity * h) * h;
  let restScale = params.restLengthScale;
  let hh = h * h;
  let limit = params.maxStretch;

  /* The first point: predicted, then pulled by its anchor. */
  let firstStart = loadPosition(base) - originWas;
  let firstVelocity = loadVelocity(base) * keep;
  var first = vec3f(firstStart.x + firstVelocity.x * h, (firstStart.y + firstVelocity.y * h) - drop, firstStart.z + firstVelocity.z * h);
  var firstInverse = params.inverseMass;
  var pinned = false;
  if (weight > 0.0) {
    if (weight >= 1.0) {
      first = targetLocal;
      firstInverse = 0.0;
      pinned = true;
    } else {
      /* A spring to the target, stepped implicitly: part of the way there, and heavier. */
      let gain = weight / (1.0 - weight);
      let turn = (TAU * ANCHOR_TURNS) * h;
      let pull = (turn * turn) * gain;
      let drag = ((2.0 * ANCHOR_RATIO) * turn) * sqrt(gain);
      let total = (1.0 + pull) + drag;
      let damper = firstStart + (targetLocal - targetWasLocal);
      first = ((first + targetLocal * pull) + damper * drag) / total;
      firstInverse = firstInverse / total;
    }
  }
  storeWork(base, first);
  scratch[base * 8u + INVERSE] = firstInverse;
${tension("  storeTension(base + segments, 0.0);\n")}
  if (segments == 0u) {
    var alone = first + origin;
    if (pinned) {
      alone = targetHere;
    }
    storePosition(base, alone);
    storeVelocity(base, (first - firstStart) / h);
    return;
  }

  /* Stretch: Newton steps on the tridiagonal system. */
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
      var higher = vec3f(0.0);
      var higherInverse = params.inverseMass;
      var gathered = 0.0;
      if (iteration == 0u) {
        let x = loadPosition(slot + 1u) - originWas;
        let v = loadVelocity(slot + 1u) * keep;
        higher = vec3f(x.x + v.x * h, (x.y + v.y * h) - drop, x.z + v.z * h);
        storeWork(slot + 1u, higher);
        scratch[at + 8u + INVERSE] = higherInverse;
        scratch[at + MULTIPLIER] = 0.0;
      } else {
        higher = loadWork(slot + 1u);
        higherInverse = scratch[at + 8u + INVERSE];
        gathered = scratch[at + MULTIPLIER];
      }
      let rest = kept[slot * 2u].w * restScale;
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
        pivot = (sum + alpha) - coupling * above;
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
      let here = segmentOf(lowerWas, higherWas, kept[slot * 2u].w * restScale);
      let lambda = scratch[at + REDUCED] - scratch[at + UPPER] * nextMultiplier;
      let moved = higherWas + (here.direction * lambda - nextDirection * nextMultiplier) * scratch[at + 8u + INVERSE];
      storeWork(slot + 1u, moved);
      let total = scratch[at + MULTIPLIER] + lambda;
      scratch[at + MULTIPLIER] = total;
      storePosition(slot + 1u, moved + origin);
      storeVelocity(slot + 1u, (moved - (loadPosition(slot + 1u) - originWas)) / h);
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
    var placedFirst = solved + origin;
    if (pinned) {
      placedFirst = targetHere;
    }
    storePosition(base, placedFirst);
    storeVelocity(base, (solved - firstStart) / h);
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

  /* The guard: only on a step that left a segment beyond Max Stretch. Positions only. */
  if (!exceeded) {
    return;
  }
  var resting = loadWork(base);
  for (var i = 1u; i < cols; i = i + 1u) {
    let slot = base + i;
    let solved = loadWork(slot);
    var placed = solved;
    if (scratch[slot * 8u + INVERSE] > 0.0) {
      let rest = kept[(slot - 1u) * 2u].w * restScale;
      let span = solved - resting;
      let squared = dot(span, span);
      if (squared > ZERO_SEGMENT_SQUARED) {
        let size = sqrt(squared);
        let most = rest * (1.0 + limit);
        let least = rest * max(0.0, 1.0 - limit);
        if (size > most) {
          placed = resting + span * (most / size);
        } else if (size < least) {
          placed = resting + span * (least / size);
        }
      }
    }
    resting = placed;
    storePosition(slot, placed + origin);
  }
}`;
}
