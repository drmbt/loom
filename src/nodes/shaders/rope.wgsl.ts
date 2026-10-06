import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { ZERO_SEGMENT_SQUARED } from "../../points/curve.ts";
import { ROPE_MAX_ITERATIONS, ROPE_PIN_SOFTENING, ROPE_TOLERANCE, ROPE_TOLERANCE_FLOOR } from "../../points/rope.ts";

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
}

const scalarAt = (region: RopeScalarRegion, slot: string): string =>
  `bitcast<f32>(pk_${region.group}[${region.word}u + ${slot} * ${region.strideWords}u + ${region.component}u])`;

const literal = (value: number): string => {
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
};

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
/* A pin attribute is named: every point may be anchored, and keeps its target's history. */
const PINNED: bool = ${pinned ? "true" : "false"};
const TAU: f32 = 6.283185307179586;

/* The incoming point of a slot: the pose a strand is seeded on, and its anchors' target. */
fn incomingAt(slot: u32) -> vec3f {
  let o = ${position.word}u + slot * 4u;
  return bitcast<vec3f>(vec3u(pk_${position.group}[o], pk_${position.group}[o + 1u], pk_${position.group}[o + 2u]));
}

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
var<private> s_reach: f32;

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

    let pin = ${pinned ? `clamp(${scalarAt(options.pin as RopeScalarRegion, "slot")}, 0.0, 1.0)` : "0.0"};
    let weight = max(station, pin);
    if (weight > 0.0) {
      let hereLocal = here - s_origin;
      var goal = hereLocal;
      var drawnIn = false;
      if (s_hasPin) {
        /* The earlier pin wins: a target out of its reach is drawn in along the line to it. */
        let span = goal - s_pinAt;
        let squared = dot(span, span);
        if (squared > s_reach * s_reach) {
          goal = s_pinAt + span * (s_reach / sqrt(squared));
          drawnIn = true;
        }
      }
      if (s_hard && weight >= 1.0) {
        placed = goal;
        weighs = 0.0;
        var stored = here;
        if (drawnIn) {
          stored = goal + s_origin;
        }
        storePosition(slot, stored);
        storeVelocity(slot, (goal - start) / s_h);
        s_pinAt = goal;
        s_hasPin = true;
        s_reach = 0.0;
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
  return vec4f(placed, weighs);
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

  /* The strand's three stations: how firmly each is held, as a number or by its map. */
  let firstWeight = clamp(${station("anchorFirst", "base")}, 0.0, 1.0);
  var secondWeight = 0.0;
  var lastWeight = 0.0;
  if (segments > 0u) {
    secondWeight = clamp(${station("anchorSecond", "(base + 1u)")}, 0.0, 1.0);
    lastWeight = clamp(${station("anchorLast", "(base + segments)")}, 0.0, 1.0);
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
  s_reach = 0.0;

  /* The first point: predicted, then pulled by its anchor. */
  let firstStart = loadPosition(base) - originWas;
  let first = place(0u);
  storeWork(base, first.xyz);
  scratch[base * 8u + INVERSE] = first.w;
${tension("  storeTension(base + segments, 0.0);\n")}
  if (segments == 0u) {
    if (first.w > 0.0) {
      storePosition(base, first.xyz + origin);
      storeVelocity(base, (first.xyz - firstStart) / h);
    }
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
      let rest = restOf(slot);
      var higher = vec3f(0.0);
      var higherInverse = 0.0;
      var gathered = 0.0;
      if (iteration == 0u) {
        s_reach = s_reach + rest * (1.0 + limit);
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
        storeVelocity(slot + 1u, (moved - (loadPosition(slot + 1u) - originWas)) / h);
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
      let rest = restOf(slot - 1u);
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
    /* A pinned point keeps the target it was stored at. */
    if (scratch[slot * 8u + INVERSE] > 0.0) {
      storePosition(slot, placed + origin);
    }
  }
}`;
}
