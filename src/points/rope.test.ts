import { describe, expect, it } from "vitest";

import {
  ROPE_BEND_FLOOR,
  ROPE_BEND_SOFTENING,
  ROPE_BEND_TOLERANCE,
  ROPE_DEFAULTS,
  ROPE_HELD_FROM,
  ROPE_TOLERANCE,
  ROPE_TOLERANCE_FLOOR,
  advanceRope,
  createRopeState,
  stepRope,
  type RopeMaps,
  type RopeParameters,
  type RopeState,
} from "./rope.ts";

/**
 * T1585b — the rope's CPU reference against CLOSED FORMS. `rope.ts` is the oracle the Dawn
 * tests hold the device to (`nodes/definitions/point-rope.gpu.test.ts`), so it is held here
 * to something that is not itself: statics and kinematics worked out by hand.
 *
 * The fixtures are dyadic — sixteen segments of 2⁻¹⁰ m, gravity 8, a frame of 1/64 s — so
 * that a closed form is a float and the assertion is `toBe`. Where it is not (a square root
 * that is irrational, a compliance), the bound is derived from the solver's exit tolerance
 * and says so.
 */

const LINKS = 16;
const POINTS = LINKS + 1;
const REST = 2 ** -10;
const GRAVITY = 8;
const FRAME = 1 / 64;

type Vec3 = readonly [number, number, number];

const strand = (cols: number, at: (i: number) => Vec3): Float32Array => {
  const out = new Float32Array(cols * 4);
  for (let i = 0; i < cols; i += 1) out.set(at(i), i * 4);
  return out;
};
const hangingAt = (shift: Vec3 = [0, 0, 0], rest = REST): Float32Array =>
  strand(POINTS, (i) => [shift[0], shift[1] - i * rest, shift[2]]);
const levelAt = (rest: number, shift: Vec3 = [0, 0, 0]): Float32Array => strand(POINTS, (i) => [shift[0] + i * rest, shift[1], shift[2]]);

const rope = (more: Partial<RopeParameters> = {}): RopeParameters => ({ ...ROPE_DEFAULTS, gravity: GRAVITY, damping: 0, ...more });

/** A state seeded on `incoming`, as the backend's first run of a fresh state seeds it. */
const seeded = (incoming: Float32Array, parameters: RopeParameters, rows = 1, maps: RopeMaps = {}): RopeState => {
  const state = createRopeState(incoming.length / 4 / rows, rows);
  advanceRope(state, incoming, parameters, { deltaSeconds: 0, substeps: 1, firstRun: true }, maps);
  return state;
};
const run = (state: RopeState, incoming: Float32Array, parameters: RopeParameters, frames: number, substeps: number): void => {
  for (let frame = 0; frame < frames; frame += 1) advanceRope(state, incoming, parameters, { deltaSeconds: FRAME, substeps });
};

const axis = (region: Float32Array, component: 0 | 1 | 2, cols = POINTS): number[] =>
  Array.from({ length: cols }, (_unused, point) => region[point * 4 + component] as number);
const every = (value: number, cols = POINTS): number[] => Array<number>(cols).fill(value);
const hung = (point: number): number => (point === 0 ? 0 : -point * REST);
const lengthOf = (position: Float32Array, k: number): number =>
  Math.hypot(
    (position[k * 4 + 4] as number) - (position[k * 4] as number),
    (position[k * 4 + 5] as number) - (position[k * 4 + 1] as number),
    (position[k * 4 + 6] as number) - (position[k * 4 + 2] as number),
  );

describe("rope reference: seeding (T1585b)", () => {
  it("puts every strand on its incoming points at rest and measures the segment after each point", () => {
    // Two strands of three points: one with segments of 3 and 4 (a 3-4-5 corner), one of 1 and 2.
    const incoming = new Float32Array([0, 0, 0, 0, 3, 0, 0, 0, 3, 4, 0, 0, /**/ 8, 0, 0, 0, 8, 1, 0, 0, 8, 3, 0, 0]);
    const state = seeded(incoming, rope(), 2);
    expect(Array.from(state.position)).toEqual(Array.from(incoming));
    expect(Array.from(state.velocity)).toEqual(Array<number>(24).fill(0));
    // The measured lengths, per strand, and none after a strand's last point: a strand does
    // not reach into the next one's first slot.
    expect([0, 1, 2, 3, 4, 5].map((slot) => state.kept[slot * 8 + 3])).toEqual([3, 4, 0, 1, 2, 0]);
    // Where each anchor's target stood: the incoming first point of ITS strand.
    expect(Array.from(state.kept.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(state.kept.subarray(24, 27))).toEqual([8, 0, 0]);
  });
});

/*
 * THE SEED HAS NO HAND (the first consumer's flip, measured on its rig). A held arc built in
 * closed form bowed its slack toward a direction projected at right angles to the chord, and
 * when the chord swung through that direction the bow changed sides: 1.29 m of tentacle in
 * one step, however fine the step.
 *
 * A rope that is running cannot do that — inertia holds the side it is on. A rope that is
 * SEEDED could, if the node built its pose. It does not: every seed (a fresh state, Reset,
 * Teleport with Reset) is the incoming points as they are, slot for slot, so the node holds
 * no reference axis and makes no choice. The side a slack strand bows to is whatever the
 * incoming strip gave it.
 *
 * So: a slack arc between two ends half a metre apart, turned rigidly so that its chord
 * sweeps a whole great circle — in three families, one through each world axis with the bow
 * in the plane of the sweep, across it, and along gravity — and seeded at each of 256
 * directions, four of which are exactly an axis. The seed is the incoming arc to the bit,
 * and so between neighbouring directions no point moves further than the turn itself moves
 * it: its distance from the axis times the chord of the angle.
 */
describe("rope reference: a seed is the incoming points, whichever way the strand lies (T1585b)", () => {
  const DIRECTIONS = 256;
  const CHORD = 0.5;
  const BOW = 0.25;
  /** cos and sin of `step` 256ths of a turn, exact on the four axes. */
  const turn = (step: number): readonly [number, number] => {
    const quarter = DIRECTIONS / 4;
    const exact: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const wrapped = ((step % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
    if (wrapped % quarter === 0) return exact[wrapped / quarter] as readonly [number, number];
    const angle = (2 * Math.PI * wrapped) / DIRECTIONS;
    return [Math.cos(angle), Math.sin(angle)];
  };
  /** The arc for one direction: `along` the chord, `aside` the way the slack bows. */
  const arc = (along: Vec3, aside: Vec3, shift: Vec3 = [0, 0, 0]): Float32Array =>
    strand(POINTS, (i) => {
      const t = i / LINKS;
      const a = CHORD * t;
      const b = BOW * 4 * t * (1 - t);
      return [shift[0] + along[0] * a + aside[0] * b, shift[1] + along[1] * a + aside[1] * b, shift[2] + along[2] * a + aside[2] * b];
    });
  const families: ReadonlyArray<readonly [string, (step: number, shift?: Vec3) => Float32Array]> = [
    // The chord sweeps the XY circle, through gravity's axis, the bow turning with it in that plane.
    ["in the plane of the sweep, through ±X and ±Y", (step, shift) => arc([turn(step)[0], turn(step)[1], 0], [-turn(step)[1], turn(step)[0], 0], shift)],
    // The chord sweeps the YZ circle, the bow held across it along X.
    ["across the sweep, through ±Y and ±Z", (step, shift) => arc([0, turn(step)[0], turn(step)[1]], [1, 0, 0], shift)],
    // The chord sweeps the XZ circle, the bow hanging along gravity.
    ["along gravity, through ±X and ±Z", (step, shift) => arc([turn(step)[0], 0, turn(step)[1]], [0, -1, 0], shift)],
  ];
  /** The furthest a point is from any axis of turn, and the chord of one step of the sweep. */
  const reach = Math.hypot(CHORD, BOW);
  const bound = reach * 2 * Math.sin(Math.PI / DIRECTIONS) + 2 ** -22;

  const seeds: ReadonlyArray<readonly [string, (incoming: Float32Array, was: Float32Array) => RopeState]> = [
    ["a fresh state", (incoming) => seeded(incoming, rope())],
    [
      "Reset",
      (incoming, was) => {
        // A strand that has been swinging somewhere else, then held.
        const state = seeded(was, rope());
        run(state, was, rope(), 3, 4);
        run(state, incoming, rope({ reset: true }), 1, 4);
        return state;
      },
    ],
    [
      "Teleport with Reset",
      (incoming, was) => {
        const parameters = rope({ teleportDistance: 8, teleportMode: "reset" });
        const state = seeded(was, parameters);
        run(state, was, parameters, 3, 1);
        run(state, incoming, parameters, 1, 1);
        return state;
      },
    ],
  ];

  describe.each(families)("the slack %s", (_name, pose) => {
    it.each(seeds)("seeded by %s", (kind, seed) => {
      // A teleport is a jump: the strand it lands on is 64 m off.
      const shift: Vec3 = kind === "Teleport with Reset" ? [0, 0, 64] : [0, 0, 0];
      let before: Float32Array | undefined;
      let furthest = 0;
      for (let step = 0; step <= DIRECTIONS; step += 1) {
        const incoming = pose(step, shift);
        const state = seed(incoming, pose(step - 1));
        expect(Array.from(state.position), `direction ${step}`).toEqual(Array.from(incoming));
        expect(Math.max(...Array.from(state.velocity, Math.abs)), `direction ${step}`).toBe(0);
        if (before !== undefined) {
          for (let point = 0; point < POINTS; point += 1) {
            const moved = Math.hypot(
              (state.position[point * 4] as number) - (before[point * 4] as number),
              (state.position[point * 4 + 1] as number) - (before[point * 4 + 1] as number),
              (state.position[point * 4 + 2] as number) - (before[point * 4 + 2] as number),
            );
            furthest = Math.max(furthest, moved);
          }
        }
        before = state.position;
      }
      expect(furthest).toBeLessThanOrEqual(bound);
      // The sweep did turn the strand: its far points moved nearly that much at every step.
      expect(furthest).toBeGreaterThan(bound / 2);
    });
  });
});

describe("rope reference: a strand hung from its first point is a fixed point of the step (T1585b)", () => {
  /*
   * Pinned at the top and at rest, a step drops every free point by δ = g·h², which
   * stretches the top segment by δ and no other. The chain system's solution is then
   * λₖ = −(16 − k)·δ·m: every point moves back up by exactly δ, and segment k carries
   * −λₖ ÷ h² = (16 − k)·m·g — the weight of the points below it.
   */
  it.each([1, 4, 8])("sag 0 to the bit at %i steps a frame, and each segment carries the weight below it", (steps) => {
    const incoming = hangingAt();
    const state = seeded(incoming, rope());
    run(state, incoming, rope(), 64, steps);
    expect(axis(state.position, 1)).toEqual(Array.from({ length: POINTS }, (_unused, point) => hung(point)));
    expect(axis(state.position, 0)).toEqual(every(0));
    expect(axis(state.velocity, 1)).toEqual(every(0));
    expect(Array.from(state.tension)).toEqual(Array.from({ length: POINTS }, (_unused, point) => (point < LINKS ? (LINKS - point) * GRAVITY : 0)));
  });

  it("Mass scales the tension and moves nothing: two kilograms a point hang where one does, at twice the newtons", () => {
    const incoming = hangingAt();
    const heavy = rope({ mass: 2 });
    const state = seeded(incoming, heavy);
    run(state, incoming, heavy, 16, 4);
    expect(axis(state.position, 1)).toEqual(Array.from({ length: POINTS }, (_unused, point) => hung(point)));
    expect(state.tension[0]).toBe(LINKS * GRAVITY * 2);
    expect(state.tension[LINKS - 1]).toBe(GRAVITY * 2);
  });

  /*
   * A COMPLIANCE is the fraction a segment lengthens per newton, so segment k gives
   * stretch × rest × Tₖ with Tₖ = (16 − k)·m·g, whatever the step: XPBD's claim, and the
   * reason the parameter is a compliance and not a stiffness per iteration. At Stretch 2⁻¹⁰
   * that is 2⁻¹⁷·(16 − k) m. The bound is what a step may leave on a segment.
   */
  it.each([1, 4, 8])("with a Stretch it rests at stretch × rest × tension a segment, the same at %i steps a frame", (steps) => {
    const incoming = hangingAt();
    const soft = rope({ damping: 8, stretch: 2 ** -10, maxStretch: 1 });
    const state = seeded(incoming, soft);
    run(state, incoming, soft, 384, steps);
    const bound = ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR;
    for (let k = 0; k < LINKS; k += 1) {
      expect(Math.abs(lengthOf(state.position, k) - REST - 2 ** -17 * (LINKS - k)), `segment ${k}`).toBeLessThanOrEqual(bound);
    }
    // Twice the mass is twice the tension, so twice the give: the top segment, 2⁻¹² longer.
    const heavy = rope({ damping: 8, stretch: 2 ** -10, maxStretch: 1, mass: 2 });
    const doubled = seeded(incoming, heavy);
    run(doubled, incoming, heavy, 384, steps);
    expect(Math.abs(lengthOf(doubled.position, 0) - REST - 2 ** -12)).toBeLessThanOrEqual(bound);
  });
});

describe("rope reference: free, a strand is a body (T1585b)", () => {
  it("falls g·h²·k(k+1)/2 at g·h·k, every point alike, with nothing for the solve to do", () => {
    const incoming = hangingAt();
    const free = rope({ anchorFirst: 0 });
    const state = seeded(incoming, free);
    // Eight steps a frame: h = 1/512, g·h² = 2⁻¹⁵. 64 steps: 2,080·2⁻¹⁵ m at 1 m/s.
    run(state, incoming, free, 8, 8);
    expect(axis(state.position, 1)).toEqual(Array.from({ length: POINTS }, (_unused, point) => hung(point) - 0.0634765625));
    expect(axis(state.velocity, 1)).toEqual(every(-1));
    // No segment carries anything (a zero of either sign).
    expect(Math.max(...Array.from(state.tension, Math.abs))).toBe(0);
  });

  /*
   * MOMENTUM. A segment's correction moves its two points by equal and opposite amounts
   * (they weigh the same), so nothing the solve does can move a free strand's centre. A
   * strand laid along X and thrown so that it whirls — point i at i/16 m/s along Y, the
   * far end fastest — keeps its centre on a straight line at the mean of those speeds,
   * 0.5 m/s, while every segment is turned through more than a right angle.
   *
   * The bound is rounding, counted: a stored position is half a last place of a number
   * under 1 (2⁻²⁵ m) off, on 17 points, once a step for 128 steps, if every one of them
   * erred the same way.
   */
  it("a free strand's centre moves in a straight line however its points whirl", () => {
    const rest = 1 / 16;
    const incoming = levelAt(rest);
    const adrift = rope({ gravity: 0, anchorFirst: 0, maxStretch: 1, iterations: 8 });
    const state = seeded(incoming, adrift);
    for (let point = 0; point < POINTS; point += 1) state.velocity[point * 4 + 1] = point / 16;
    run(state, incoming, adrift, 32, 4);
    const centre = (component: 0 | 1 | 2): number => axis(state.position, component).reduce((sum, value) => sum + value, 0) / POINTS;
    const bound = 2 ** -25 * 128;
    expect(Math.abs(centre(0) - 0.5)).toBeLessThanOrEqual(bound);
    expect(Math.abs(centre(1) - 0.5 * 32 * FRAME)).toBeLessThanOrEqual(bound);
    expect(centre(2)).toBe(0);
    // Not a strand that drifted sideways untouched: it has turned, and kept its length.
    const tipAhead = (state.position[LINKS * 4] as number) - (state.position[0] as number);
    expect(tipAhead).toBeLessThan(0.9);
    for (let k = 0; k < LINKS; k += 1) expect(Math.abs(lengthOf(state.position, k) - rest), `segment ${k}`).toBeLessThanOrEqual(ROPE_TOLERANCE * rest + ROPE_TOLERANCE_FLOOR + 2 ** -23);
  });
});

describe("rope reference: the anchor (T1585b, the design's section 4)", () => {
  it("a pinned point walks to its target in equal shares across a frame's steps, and the strand is towed at that speed", () => {
    const rest = REST;
    const towed = rope({ gravity: 0 });
    const state = seeded(levelAt(rest), towed);
    // The target moves 2⁻⁶ m along −X in this frame: 1 m/s. Four steps of 2⁻⁸ m each.
    const moved = levelAt(rest, [-(2 ** -6), 0, 0]);
    for (let substep = 0; substep < 4; substep += 1) {
      stepRope(state, moved, towed, { deltaSeconds: FRAME / 4, substep, substeps: 4, firstRun: false });
      // A target snapped to its end in the frame's first step reads −2⁻⁶ here from substep 0
      // and a velocity of 0 from substep 1: the 60 Hz jolt the interpolation exists to remove.
      expect(state.position[0], `substep ${substep}`).toBe(-(2 ** -8) * (substep + 1));
      expect(axis(state.velocity, 0), `substep ${substep}`).toEqual(every(-1));
    }
    expect(axis(state.position, 0)).toEqual(Array.from({ length: POINTS }, (_unused, point) => point * rest - 2 ** -6));
  });

  /*
   * A WEIGHT BETWEEN 0 AND 1 IS A SPRING, of stiffness M·(2π·strength)²·a ÷ (1 − a), stepped
   * implicitly, and M IS THE STRAND'S MASS (the design's D19). Implicit stepping changes
   * how a spring gets to rest and not where: the whole strand hangs from it, N points of
   * weight m·g, on a spring sized for N points, so it rests g ÷ ((2π·strength)²·gain) below
   * its target whatever its length — 50.7 mm at weight 0.5 and 16.9 mm at 0.75 with g = 8,
   * at any step count.
   *
   * The bound is the exit tolerance carried through: a top segment left τ off its length is
   * a tension off by τ·m ÷ 2h², and the spring turns that into τ ÷ (2h²·ω²·gain·N) metres.
   */
  const omegaSquared = (2 * Math.PI * ROPE_DEFAULTS.anchorStrength) ** 2;
  it.each([
    [0.5, 1],
    [0.5, 8],
    [0.75, 4],
  ])("a weight of %f rests the strand g ÷ (ω²·gain) below its target, at %i steps a frame", (weight, steps) => {
    const incoming = hangingAt();
    const held = rope({ damping: 8, anchorFirst: weight });
    const state = seeded(incoming, held);
    run(state, incoming, held, 64 * 12, steps);
    const gain = weight / (1 - weight);
    const closed = GRAVITY / (omegaSquared * gain);
    const h = FRAME / steps;
    const bound = (ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR) / (2 * h * h * omegaSquared * gain * POINTS) + 2 ** -22;
    expect(Math.abs(-(state.position[1] as number) - closed)).toBeLessThanOrEqual(bound);
    // The bound is not the claim: it is a thousandth of the sag at most.
    expect(bound).toBeLessThan(closed / 1000);
    // The strand below it hangs straight, at its length.
    expect(Math.abs((state.position[1] as number) - (state.position[LINKS * 4 + 1] as number) - LINKS * REST)).toBeLessThanOrEqual(LINKS * (ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR));
  });

  /*
   * THE FIRST CONSUMER'S NUMBERS (sentinel-bot): 55 points 60 mm apart, gravity 9.81, Anchor
   * Strength 2 Hz. 62 mm at weight 0.5 and 145 mm at 0.3 — where a spring sized for one
   * point's mass would hang the same strand 3.4 m and 8.0 m low.
   */
  it.each([
    [0.5, 0.06212, 1],
    [0.5, 0.06212, 4],
    [0.3, 0.14495, 4],
    [0.3, 0.14495, 8],
  ])("the consumer's 55 points at weight %f rest %f m below the target, at %i steps of a 60 fps frame", (weight, metres, steps) => {
    const cols = 55;
    const pitch = 0.06;
    const incoming = strand(cols, (i) => [0, -i * pitch, 0]);
    const held: RopeParameters = { ...ROPE_DEFAULTS, damping: 4, anchorFirst: weight };
    const state = seeded(incoming, held);
    for (let frame = 0; frame < 60 * 20; frame += 1) advanceRope(state, incoming, held, { deltaSeconds: 1 / 60, substeps: steps });
    const gain = weight / (1 - weight);
    const closed = ROPE_DEFAULTS.gravity / (omegaSquared * gain);
    expect(closed).toBeCloseTo(metres, 5);
    const h = 1 / 60 / steps;
    const bound = (ROPE_TOLERANCE * pitch + ROPE_TOLERANCE_FLOOR) / (2 * h * h * omegaSquared * gain * cols) + 2 ** -21;
    expect(Math.abs(-(state.position[1] as number) - closed)).toBeLessThanOrEqual(bound);
    expect(bound).toBeLessThan(closed / 500);
  });

  it("a pull from a PIN ATTRIBUTE is sized for the point's own mass: the same strand hangs N times lower from it", () => {
    const incoming = hangingAt();
    const pin = new Float32Array(POINTS);
    pin[0] = 0.5;
    const held = rope({ damping: 8, anchorFirst: 0 });
    const state = seeded(incoming, held, 1, { pin });
    for (let frame = 0; frame < 64 * 12; frame += 1) advanceRope(state, incoming, held, { deltaSeconds: FRAME, substeps: 4 }, { pin });
    // 17 points of weight on a spring sized for one: 17·g ÷ ω², 0.861 m, on a strand 16 mm long.
    const closed = (POINTS * GRAVITY) / omegaSquared;
    const h = FRAME / 4;
    expect(Math.abs(-(state.position[1] as number) - closed)).toBeLessThanOrEqual((ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR) / (2 * h * h * omegaSquared) + 2 ** -22);
  });

  it("weight 0 is no anchor at all: the strand falls exactly as one with nothing wired to hold it", () => {
    const incoming = hangingAt();
    const state = seeded(incoming, rope({ anchorFirst: 0 }));
    // The incoming strip then moves, and a free strand does not know: no word differs.
    const elsewhere = hangingAt([3, 5, -2]);
    const other = seeded(incoming, rope({ anchorFirst: 0 }));
    run(state, incoming, rope({ anchorFirst: 0 }), 4, 4);
    run(other, elsewhere, rope({ anchorFirst: 0 }), 4, 4);
    expect(Array.from(other.position)).toEqual(Array.from(state.position));
    expect(Array.from(other.velocity)).toEqual(Array.from(state.velocity));
  });
});

describe("rope reference: the guard (T1585b, Notch's Max Stretch)", () => {
  const thrown = (maxStretch: number): RopeState => {
    const rest = 1 / 16;
    const parameters = rope({ maxStretch, iterations: 1 });
    const state = seeded(hangingAt([0, 0, 0], rest), parameters);
    run(state, hangingAt([0, 0, 0], rest), parameters, 2, 4);
    // A hundred strand-lengths in ONE STEP: far past any step limit. One step, so that the
    // two strands below differ by the guard's one act and by nothing that followed from it.
    run(state, hangingAt([100, 0, 0], rest), parameters, 1, 1);
    return state;
  };

  it("holds every segment to Max Stretch on a step the solve could not finish, and adds no speed", () => {
    const rest = 1 / 16;
    const guarded = thrown(0.02);
    const unguarded = thrown(10);
    const longest = (state: RopeState): number => Math.max(...Array.from({ length: LINKS }, (_unused, k) => lengthOf(state.position, k)));
    // To the float spacing at 100 m, 2⁻¹⁷ m, on the two ends and the limit.
    expect(longest(guarded)).toBeLessThanOrEqual(rest * 1.02 + 3 * 2 ** -17);
    // The control: without it the same throw leaves a segment several times its length.
    expect(longest(unguarded)).toBeGreaterThan(rest * 2);
    // POSITIONS ONLY. The velocities are the solve's, to the bit, guard or no guard: a
    // guard that fed its correction into the velocity would be the finishing sweep the
    // design rejected for the energy it adds.
    expect(Array.from(guarded.velocity)).toEqual(Array.from(unguarded.velocity));
  });
});

/*
 * D24 — BETWEEN TWO PINS THE GUARD WALKS BACK FIRST. The walk out from the first point moves
 * each segment's later point and leaves a pinned one, so on a strand held at its far end too,
 * whatever the solve did not close landed on the one segment before that pin. The points
 * before the last hard pin are now drawn in toward it first, and the walk out finds them
 * nearly in place.
 */
describe("rope reference: the guard on a strand held at both ends (T1585b, the design's D24)", () => {
  it("a far pin thrown past the step limit: every segment within Max Stretch, the one before the pin too", () => {
    /* The first consumer's attack in one step a frame: 54 segments, the first two points on
       a socket at 1.6 m/s, the last on a claw that crosses 2 m in 30% of a step — 8 m/s. */
    const cols = 55;
    const pitch = 2 ** -4;
    const claw = (t: number): Vec3 => {
      const cycle = t / 1.25;
      const swing = Math.min(1, Math.max(0, (cycle - Math.floor(cycle) - 0.7) / 0.3));
      return [1.5, 0, 0.7 + (Math.floor(cycle) + swing * swing * (3 - 2 * swing)) * 2];
    };
    const at = (t: number): Float32Array => strand(cols, (i) => (i === cols - 1 && t > 0 ? claw(t) : [0, 0, 1.6 * t - i * pitch]));
    const held = (t: number): RopeParameters => ({ ...ROPE_DEFAULTS, damping: 1.5, anchorSecond: 1, anchorLast: Math.min(1, t / 1.5) ** 2 * (3 - 2 * Math.min(1, t / 1.5)) });
    const state = seeded(at(0), held(0));
    let longest = 0;
    let unfinished = 0;
    for (let frame = 1; frame <= 600; frame += 1) {
      const t = frame / 60;
      advanceRope(state, at(t), held(t), { deltaSeconds: 1 / 60, substeps: 1 });
      if (frame < 240) continue;
      for (let k = 0; k < cols - 1; k += 1) {
        const off = Math.abs(lengthOf(state.position, k) - pitch);
        longest = Math.max(longest, off);
        if (off > 100 * (ROPE_TOLERANCE * pitch + ROPE_TOLERANCE_FLOOR)) unfinished += 1;
      }
    }
    // 2%, to the stored positions' spacing 16 m down the tunnel (2⁻¹⁹ m, on each end).
    expect(longest).toBeLessThanOrEqual(0.02 * pitch + 2 * 2 ** -19);
    // It is the guard holding it: the solve left segments a hundred tolerances out.
    expect(unfinished).toBeGreaterThan(0);
  });

  it("a strand hung from its last point only is walked from that pin, and its first point is where the walk puts it", () => {
    const rest = 1 / 16;
    const upside = rope({ anchorFirst: 0, anchorLast: 1, iterations: 1 });
    const hang = (x: number): Float32Array => strand(POINTS, (i) => [x, (i - LINKS) * rest, 0]);
    const state = seeded(hang(0), upside);
    run(state, hang(0), upside, 2, 4);
    // The pin thrown a hundred lengths in one step: the solve cannot finish.
    run(state, hang(100), upside, 1, 1);
    for (let k = 0; k < LINKS; k += 1) expect(lengthOf(state.position, k), `segment ${k}`).toBeLessThanOrEqual(rest * 1.02 + 3 * 2 ** -17);
    expect(pointOf(state.position, LINKS)).toEqual([100, 0, 0]);
  });

  /*
   * A strand with NO hard pin past its first point has nothing to walk back from, and is the
   * words it was. These are hashes of its positions and velocities taken from the reference
   * as it stood before D24, after the same throw: held at its first point, held there softly,
   * held nowhere, and held softly at both ends.
   */
  it.each([
    ["held at its first point", {}, "dc74f236", "f6e32e8c"],
    ["held softly at its first point", { anchorFirst: 0.5 }, "d5fd921c", "e2221601"],
    ["held nowhere", { anchorFirst: 0 }, "e64f3204", "4bfcffbc"],
    ["held softly at both ends", { anchorFirst: 0.5, anchorLast: 0.5 }, "80cb756b", "ea31cb74"],
  ] as const)("a strand %s is unchanged to the bit", (_label, more, positions, velocities) => {
    const rest = 1 / 16;
    const parameters = rope({ damping: 0.5, iterations: 1, ...more });
    const state = seeded(hangingAt([0, 0, 0], rest), parameters);
    run(state, hangingAt([0, 0, 0], rest), parameters, 2, 4);
    run(state, hangingAt([100, 0, 0], rest), parameters, 9, 4);
    const hash = (words: Float32Array): string => {
      let low = 0x811c9dc5;
      for (const byte of new Uint8Array(words.buffer, words.byteOffset, words.byteLength)) low = Math.imul(low ^ byte, 0x01000193);
      return (low >>> 0).toString(16).padStart(8, "0");
    };
    expect(hash(state.position)).toBe(positions);
    expect(hash(state.velocity)).toBe(velocities);
  });
});

describe("rope reference: time, reset and teleport (T1585b, the design's sections 4.7, 4.8 and 6)", () => {
  const swinging = (more: Partial<RopeParameters> = {}): RopeParameters => rope({ damping: 0.5, ...more });
  const copy = (state: RopeState): number[] => [...state.position, ...state.velocity, ...state.tension, ...state.kept];

  it("a step of no length, and a Simulation Speed of 0, leave every word as it was", () => {
    const incoming = levelAt(1 / 16);
    const state = seeded(incoming, swinging());
    run(state, incoming, swinging(), 5, 4);
    const before = copy(state);
    advanceRope(state, incoming, swinging(), { deltaSeconds: 0, substeps: 1 });
    expect(copy(state)).toEqual(before);
    run(state, incoming, swinging({ speed: 0 }), 2, 4);
    expect(copy(state)).toEqual(before);
    // The control: with time running the strand moves on.
    run(state, incoming, swinging(), 1, 4);
    expect(copy(state)).not.toEqual(before);
  });

  it("Reset holds the strand on its incoming points at rest, and measures its segments again", () => {
    const state = seeded(levelAt(1 / 16), swinging());
    run(state, levelAt(1 / 16), swinging(), 12, 4);
    expect(state.position[LINKS * 4 + 1] as number).toBeLessThan(-0.05);
    // Held on a strip that is somewhere else and TWICE as long.
    const longer = levelAt(1 / 8, [0.5, 0.25, 0]);
    run(state, longer, swinging({ reset: true }), 3, 4);
    expect(Array.from(state.position)).toEqual(Array.from(longer));
    expect(Array.from(state.velocity)).toEqual(Array<number>(POINTS * 4).fill(0));
    expect(state.kept[3]).toBe(1 / 8);
  });

  it("Teleport, Reset: a jump past the distance puts the strand on its incoming points; under it, the strand is dragged", () => {
    const parameters = swinging({ teleportDistance: 8, teleportMode: "reset" });
    const state = seeded(levelAt(1 / 16), parameters);
    run(state, levelAt(1 / 16), parameters, 12, 1);
    const far = levelAt(1 / 16, [0, 0, 64]);
    run(state, far, parameters, 1, 1);
    expect(Array.from(state.position)).toEqual(Array.from(far));
    expect(Array.from(state.velocity)).toEqual(Array<number>(POINTS * 4).fill(0));
    // Seven metres is under the distance: an ordinary, violent, move. The pinned point takes
    // it at 7 m in 1/64 s, and the point behind it is dragged after it.
    run(state, levelAt(1 / 16, [0, 0, 71]), parameters, 1, 1);
    expect(state.velocity[2]).toBe(7 * 64);
    expect(Math.abs(state.velocity[4 + 2] as number)).toBeGreaterThan(1);
  });

  /*
   * CARRY THROUGH A WRAP, the first consumer's case in small: a strand of four segments
   * towed along +Z at 2⁻³ m a frame (8 m/s), whose world wraps by −960 m. On the frame of
   * the wrap the target goes from 959.875 to 0: the jump AND the eighth of a metre the
   * socket travels in any frame. Carry takes the target to have come from where its speed
   * puts it (dead reckoning on the kept rate), so the strand is moved by exactly −960 and
   * towed on. With no gravity and no drag every number is a float, also at 960 m.
   */
  it("Teleport, Carry: a towed strand goes through a 960 m wrap one pitch behind the last, at the speed it had", () => {
    const cols = 5;
    const pitch = 2 ** -4;
    const perFrame = 2 ** -3;
    const trailing = (socket: number): Float32Array => strand(cols, (i) => [0, 0, socket - i * pitch]);
    const carried = rope({ gravity: 0, teleportDistance: 100, teleportMode: "carry" });
    const state = seeded(trailing(958), carried);
    for (let frame = 1; frame < 40; frame += 1) {
      const travelled = 958 + perFrame * frame;
      const socket = travelled >= 960 ? travelled - 960 : travelled;
      advanceRope(state, trailing(socket), carried, { deltaSeconds: FRAME, substeps: 8 });
      expect(axis(state.position, 2, cols), `frame ${frame}`).toEqual(Array.from({ length: cols }, (_unused, point) => socket - point * pitch));
      expect(axis(state.velocity, 2, cols), `frame ${frame}`).toEqual(every(perFrame * 64, cols));
    }
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * SLICE 2 — three stations, a pin attribute, and the rule for two anchors (the design's
 * section 4, D19 and D20).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

const TAU_SEGMENT = ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR;
const pointOf = (region: Float32Array, point: number): Vec3 => [region[point * 4] as number, region[point * 4 + 1] as number, region[point * 4 + 2] as number];

describe("rope reference: Hard and Soft (T1585b slice 2, D20)", () => {
  it("Hard at a weight of 0.5 is Soft at 1, word for word: one formula, two readings of the weight", () => {
    const incoming = hangingAt();
    const moved = hangingAt([0.25, 0.125, 0]);
    const play = (parameters: RopeParameters): RopeState => {
      const state = seeded(incoming, parameters);
      run(state, moved, parameters, 24, 4);
      return state;
    };
    const hard = play(rope({ damping: 1, anchorFirst: 0.5, anchorMode: "hard" }));
    const soft = play(rope({ damping: 1, anchorFirst: 1, anchorMode: "soft" }));
    expect(Array.from(soft.position)).toEqual(Array.from(hard.position));
    expect(Array.from(soft.velocity)).toEqual(Array.from(hard.velocity));
    // …and neither is a pin: the first point is on its way to the target, and not on it.
    expect(Math.hypot((hard.position[0] as number) - 0.25, (hard.position[1] as number) - 0.125)).toBeGreaterThan(0.01);
  });

  it("Hard at 1 is the target to the bit; Soft at 1 hangs below it by g ÷ ω², a spring that never pins", () => {
    const incoming = hangingAt([0.5, 0.25, 0.125]);
    const hard = seeded(incoming, rope({ damping: 8 }));
    run(hard, incoming, rope({ damping: 8 }), 64 * 6, 4);
    expect(pointOf(hard.position, 0)).toEqual([0.5, 0.25, 0.125]);
    const softly = rope({ damping: 8, anchorMode: "soft" });
    const soft = seeded(incoming, softly);
    run(soft, incoming, softly, 64 * 12, 4);
    const omegaSquared = (2 * Math.PI * ROPE_DEFAULTS.anchorStrength) ** 2;
    const h = FRAME / 4;
    expect(Math.abs(0.25 - (soft.position[1] as number) - GRAVITY / omegaSquared)).toBeLessThanOrEqual(TAU_SEGMENT / (2 * h * h * omegaSquared * POINTS) + 2 ** -22);
  });

  /*
   * A TARGET THAT MOVES STEADILY IS FOLLOWED WITHOUT A LAG. The pull's damper acts on the
   * point's motion RELATIVE to the target's, so a point moving with its target feels none
   * of it: once the start has died away the point is on the target and at its speed. A
   * damper on the point's own speed would hold it c·u ÷ k behind — 80 mm here.
   */
  it("a part weight follows a target moving at a steady speed with no lag, to the rounding of where it is", () => {
    const steady = rope({ gravity: 0, anchorFirst: 0.5 });
    const at = (frame: number): Float32Array => strand(1, () => [frame * 2 ** -6, 0, 0]);
    const state = seeded(at(0), steady);
    for (let frame = 1; frame <= 64 * 4; frame += 1) advanceRope(state, at(frame), steady, { deltaSeconds: FRAME, substeps: 4 });
    // 4 m along, at 1 m/s: where a float is 2⁻²¹ m apart.
    expect(Math.abs((state.position[0] as number) - 4)).toBeLessThanOrEqual(2 ** -20);
    expect(Math.abs((state.velocity[0] as number) - 1)).toBeLessThanOrEqual(2 ** -20 * 256);
  });

  it("a weight that rises from nothing finds a target that was already being followed: no kick", () => {
    /* The last point's target has been running away at 4 m/s while its weight was 0. The
       frame the weight becomes 0.01, the target the pull sees has moved one frame's worth —
       not the 8 metres since the strand was seeded, which a history kept only while a weight
       is above zero would hand the damper as one frame of motion at 512 m/s. */
    const incomingAt = (frame: number): Float32Array => strand(POINTS, (i) => (i === LINKS ? [frame * 2 ** -4, 0, 0] : [0, -i * REST, 0]));
    const loose = rope({ damping: 1, anchorLast: 0 });
    const state = seeded(incomingAt(0), loose);
    // The last segment was measured to a target that is somewhere else: give it its length.
    state.kept[(LINKS - 1) * 8 + 3] = REST;
    for (let frame = 1; frame <= 128; frame += 1) advanceRope(state, incomingAt(frame), loose, { deltaSeconds: FRAME, substeps: 4 });
    const before = Math.hypot(...pointOf(state.velocity, LINKS));
    advanceRope(state, incomingAt(129), rope({ damping: 1, anchorLast: 0.01 }), { deltaSeconds: FRAME, substeps: 4 });
    const after = Math.hypot(...pointOf(state.velocity, LINKS));
    // A weight of 0.01 on a target 8 m off and leaving at 4 m/s is a nudge: under a metre a second.
    expect(after - before).toBeLessThan(1);
    expect(after - before).toBeGreaterThan(0);
  });
});

describe("rope reference: two anchors (T1585b slice 2, the design's 4.6)", () => {
  it("held at both ends with slack, a strand hangs between them: its ends are their targets to the bit, its lowest point in the middle", () => {
    // Sixteen segments of 1/16 m between pins three quarters of a metre apart.
    const rest = 1 / 16;
    const incoming = strand(POINTS, (i) => [(0.75 / LINKS) * i, 0, 0]);
    const both = rope({ damping: 4, anchorLast: 1, iterations: 8 });
    const state = seeded(incoming, both);
    for (let k = 0; k < LINKS; k += 1) state.kept[k * 8 + 3] = rest;
    run(state, incoming, both, 64 * 8, 4);
    expect(pointOf(state.position, 0)).toEqual([0, 0, 0]);
    expect(pointOf(state.position, LINKS)).toEqual([0.75, 0, 0]);
    expect(pointOf(state.velocity, LINKS)).toEqual([0, 0, 0]);
    const tau = ROPE_TOLERANCE * rest + ROPE_TOLERANCE_FLOOR;
    for (let k = 0; k < LINKS; k += 1) expect(Math.abs(lengthOf(state.position, k) - rest), `segment ${k}`).toBeLessThanOrEqual(tau + 2 ** -23);
    // It has hung: the middle is well below the pins, and each half mirrors the other.
    expect(state.position[8 * 4 + 1] as number).toBeLessThan(-0.25);
    for (let point = 1; point < 8; point += 1) {
      expect(Math.abs((state.position[point * 4 + 1] as number) - (state.position[(LINKS - point) * 4 + 1] as number)), `point ${point}`).toBeLessThanOrEqual(LINKS * tau);
    }
  });

  /*
   * TAUT BETWEEN TWO PINS a strand has no length to spare, and under gravity across it it
   * sags by what its segments' tolerance lets it and no more: with e metres to spare over a
   * chord L, no shape hangs lower than a V, ½·√((L + e)² − L²).
   *
   * (The SINGULAR case is the taut strand with nothing across it: its tension is whatever
   * you like, and each pivot is raised by 2⁻¹² on a strand with two anchors so that the
   * elimination has an answer. The tests that go red without that are the target out of
   * reach along the strand, below, and the lap with both ends held.)
   */
  it("taut and straight between two pins, under gravity across it, every segment keeps its length and no point is thrown", () => {
    const rest = 1 / 16;
    const incoming = levelAt(rest);
    const both = rope({ damping: 1, anchorLast: 1, iterations: 8 });
    const state = seeded(incoming, both);
    let lowest = 0;
    let fastest = 0;
    for (let frame = 0; frame < 128; frame += 1) {
      advanceRope(state, incoming, both, { deltaSeconds: FRAME, substeps: 4 });
      for (let point = 0; point < POINTS; point += 1) {
        expect(Number.isFinite(state.position[point * 4 + 1] as number), `frame ${frame}`).toBe(true);
        lowest = Math.min(lowest, state.position[point * 4 + 1] as number);
        fastest = Math.max(fastest, Math.hypot(...pointOf(state.velocity, point)));
      }
    }
    const tau = ROPE_TOLERANCE * rest + ROPE_TOLERANCE_FLOOR;
    for (let k = 0; k < LINKS; k += 1) expect(Math.abs(lengthOf(state.position, k) - rest), `segment ${k}`).toBeLessThanOrEqual(tau + 2 ** -23);
    const spare = LINKS * (tau + 2 ** -23);
    expect(-lowest).toBeLessThanOrEqual(0.5 * Math.sqrt((1 + spare) ** 2 - 1));
    // …and it is a string under gravity, not a bar: it does sag.
    expect(-lowest).toBeGreaterThan(0.001);
    expect(fastest).toBeLessThan(1);
  });

  /*
   * OUT OF REACH, THE EARLIER PIN WINS. A straight strand of 2⁻⁶ m along +X whose last
   * target is put at twice that: the target is drawn in along the line to it, to the rope's
   * length times 1 + Max Stretch, and the last point is stored THERE. Length is kept and the
   * target is not — the Curve node's Arc out of reach, in the same words.
   */
  it("a last target out of reach is drawn in to the rope's length on the line to it; the first point does not move", () => {
    const both = rope({ gravity: 0, anchorLast: 1, maxStretch: 0 });
    const state = seeded(levelAt(REST), both);
    const far = strand(POINTS, (i) => (i === LINKS ? [2 ** -5, 0, 0] : [i * REST, 0, 0]));
    run(state, far, both, 4, 4);
    expect(pointOf(state.position, 0)).toEqual([0, 0, 0]);
    expect(pointOf(state.position, LINKS)).toEqual([2 ** -6, 0, 0]);
    expect(axis(state.position, 0)).toEqual(Array.from({ length: POINTS }, (_unused, point) => point * REST));
    // With Max Stretch at a quarter the rope gives that much before the target is lost.
    const giving = rope({ gravity: 0, anchorLast: 1, maxStretch: 0.25 });
    const stretched = seeded(levelAt(REST), giving);
    run(stretched, far, giving, 4, 4);
    expect(pointOf(stretched.position, LINKS)).toEqual([1.25 * 2 ** -6, 0, 0]);
    // The control: a target inside the rope's length is the last point, to the bit.
    const near = strand(POINTS, (i) => (i === LINKS ? [2 ** -7, 2 ** -8, 0] : [i * REST, 0, 0]));
    const reached = seeded(levelAt(REST), both);
    run(reached, near, both, 8, 4);
    expect(pointOf(reached.position, LINKS)).toEqual([2 ** -7, 2 ** -8, 0]);
  });

  it("the reach is measured from the NEAREST earlier pin: with the second point held too, it is one segment shorter", () => {
    const three = rope({ gravity: 0, anchorSecond: 1, anchorLast: 1, maxStretch: 0 });
    const state = seeded(levelAt(REST), three);
    // The target is straight above the second point, far away.
    const far = strand(POINTS, (i) => (i === LINKS ? [REST, 1, 0] : [i * REST, 0, 0]));
    run(state, far, three, 64, 4);
    expect(pointOf(state.position, 1)).toEqual([REST, 0, 0]);
    // Fifteen segments above the second point, on the line to the target.
    expect(pointOf(state.position, LINKS)).toEqual([REST, 15 * REST, 0]);
  });
});

describe("rope reference: Segment Length (T1585b slice 2)", () => {
  it("given the length the seed measured, it is the measured strand word for word; given twice that, the strand hangs twice as long", () => {
    const incoming = hangingAt();
    const play = (segmentLength: number, frames: number): RopeState => {
      const parameters = rope({ damping: 8, segmentLength });
      const state = seeded(incoming, parameters);
      run(state, incoming, parameters, frames, 4);
      return state;
    };
    expect(Array.from(play(REST, 16).position)).toEqual(Array.from(play(0, 16).position));
    const doubled = play(2 * REST, 64 * 8);
    const tau = ROPE_TOLERANCE * 2 * REST + ROPE_TOLERANCE_FLOOR;
    expect(Math.abs((doubled.position[LINKS * 4 + 1] as number) + 2 * LINKS * REST)).toBeLessThanOrEqual(LINKS * tau);
  });

  /*
   * THE FIRST CONSUMER'S SEED. Its incoming strip is a straight run with the LAST point
   * already where the claw should go, so the last segment as seeded is whatever that
   * distance is. Measured, the rope would have one segment two thirds of a metre long.
   * With Segment Length it has sixteen of a sixteenth.
   */
  it("a strip whose last point is somewhere else still makes a rope of its own length", () => {
    const rest = 1 / 16;
    const incoming = strand(POINTS, (i) => (i === LINKS ? [0.5, -0.5, 0] : [0, -i * rest, 0]));
    const hang = (segmentLength: number): number => {
      const parameters = rope({ damping: 8, segmentLength });
      const state = seeded(incoming, parameters);
      run(state, incoming, parameters, 64 * 12, 4);
      return state.position[LINKS * 4 + 1] as number;
    };
    const tau = ROPE_TOLERANCE * rest + ROPE_TOLERANCE_FLOOR;
    expect(Math.abs(hang(rest) + 1)).toBeLessThanOrEqual(LINKS * tau + 2 ** -20);
    // The control: measured from the seed, the last segment is the 0.66 m to that point.
    expect(hang(0)).toBeLessThan(-1.5);
  });
});

describe("rope reference: a weight per strand, and a weight per point (T1585b slice 2)", () => {
  it("Anchor Last mapped: the strand whose last point reads 1 hangs from both ends, the one that reads 0 from its first", () => {
    const rest = 1 / 16;
    const incoming = new Float32Array(2 * POINTS * 4);
    for (let j = 0; j < 2; j += 1) for (let i = 0; i < POINTS; i += 1) incoming.set([(0.75 / LINKS) * i, 0, j], (j * POINTS + i) * 4);
    const hold = new Float32Array(2 * POINTS);
    // Read at each strand's LAST point; a 1 anywhere else on the strand is not a weight.
    hold[LINKS] = 0;
    hold[POINTS + LINKS] = 1;
    hold[3] = 1;
    const mapped = rope({ damping: 2, iterations: 8 });
    const play = (maps: RopeMaps): RopeState => {
      const state = seeded(incoming, mapped, 2, maps);
      for (let slot = 0; slot < 2 * POINTS; slot += 1) if (slot % POINTS !== LINKS) state.kept[slot * 8 + 3] = rest;
      for (let frame = 0; frame < 64 * 2; frame += 1) advanceRope(state, incoming, mapped, { deltaSeconds: FRAME, substeps: 4 }, maps);
      return state;
    };
    const state = play({ anchorLast: hold });
    expect(pointOf(state.position, POINTS + LINKS)).toEqual([0.75, 0, 1]);
    expect(state.position[LINKS * 4 + 1] as number).toBeLessThan(-0.5);
    // THE WIRE CUT: with no map both strands take the parameter, 0, and both let go.
    const cut = play({});
    expect(cut.position[(POINTS + LINKS) * 4 + 1] as number).toBeLessThan(-0.5);
    expect(Array.from(cut.position.subarray(0, POINTS * 4))).toEqual(Array.from(state.position.subarray(0, POINTS * 4)));
  });

  it("a pin attribute holds any point: at 1 it is its incoming point to the bit, wherever on the strand it is", () => {
    const pin = new Float32Array(POINTS);
    pin[8] = 1;
    const held = rope({ damping: 1 });
    const at = (frame: number): Float32Array => strand(POINTS, (i) => [i * REST + frame * 2 ** -8, 0, 0]);
    const state = seeded(at(0), held, 1, { pin });
    for (let frame = 1; frame <= 32; frame += 1) {
      advanceRope(state, at(frame), held, { deltaSeconds: FRAME, substeps: 4 }, { pin });
      expect(pointOf(state.position, 8), `frame ${frame}`).toEqual([8 * REST + frame * 2 ** -8, 0, 0]);
      // Its velocity is its target's: 2⁻⁸ m a frame is a quarter of a metre a second.
      expect(state.velocity[8 * 4], `frame ${frame}`).toBe(0.25);
    }
    // The strand hangs from the first point and from the eighth: the tip is below both.
    expect(state.position[LINKS * 4 + 1] as number).toBeLessThan(-4 * REST);
    // The control: without the attribute the eighth point swings down with the rest.
    const free = seeded(at(0), held);
    for (let frame = 1; frame <= 32; frame += 1) advanceRope(state, at(frame), held, { deltaSeconds: FRAME, substeps: 4 });
    for (let frame = 1; frame <= 32; frame += 1) advanceRope(free, at(frame), held, { deltaSeconds: FRAME, substeps: 4 });
    expect(free.position[8 * 4 + 1] as number).toBeLessThan(-REST);
  });

  it("every point pinned, the rope IS the incoming strip, at the incoming strip's speed", () => {
    const pin = new Float32Array(POINTS).fill(1);
    const held = rope({ anchorFirst: 0 });
    // Carried rigidly, half a metre a second up and a quarter along: its segments keep their length.
    const at = (frame: number): Float32Array => strand(POINTS, (i) => [i * REST + frame * 2 ** -8, frame * 2 ** -7, 0]);
    const state = seeded(at(0), held, 1, { pin });
    for (let frame = 1; frame <= 8; frame += 1) advanceRope(state, at(frame), held, { deltaSeconds: FRAME, substeps: 4 }, { pin });
    expect(Array.from(state.position)).toEqual(Array.from(at(8)));
    expect(axis(state.velocity, 1)).toEqual(every(0.5));
    expect(axis(state.velocity, 0)).toEqual(every(0.25));
  });
});

describe("rope reference: grab and release without a pop (T1585b slice 2, the design's 4.5)", () => {
  /*
   * ONE strand, held at its first point, its last point's weight on a quintic from 0 to 1
   * over three seconds toward a target a quarter of a metre from where the tip hangs.
   * Everything indexed by strand is held fixed: this is one strand stepped through time.
   *
   * A weight that changes continuously moves its point continuously, so the largest move of
   * the tip in ONE FRAME halves when the frame does: the ratio between 64 and 128 frames a
   * second has the closed form 2. A pop does not halve.
   */
  const rest = 1 / 16;
  const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
  const target: Vec3 = [0.5, -0.75, 0];
  const incoming = strand(POINTS, (i) => (i === LINKS ? target : [0, -i * rest, 0]));
  const grab = (fps: number, weightAt: (seconds: number) => number): { largest: number; state: RopeState } => {
    const first = rope({ damping: 2, iterations: 8 });
    // Seeded hanging straight, so its segments are measured at their length; the last point's
    // target is somewhere else from the first frame on.
    const state = seeded(strand(POINTS, (i) => [0, -i * rest, 0]), first);
    let largest = 0;
    for (let frame = 1; frame <= fps * 4; frame += 1) {
      const before = pointOf(state.position, LINKS);
      advanceRope(state, incoming, rope({ damping: 2, iterations: 8, anchorLast: weightAt(frame / fps) }), { deltaSeconds: 1 / fps, substeps: Math.round(256 / fps) });
      const now = pointOf(state.position, LINKS);
      largest = Math.max(largest, Math.hypot(now[0] - before[0], now[1] - before[1], now[2] - before[2]));
    }
    return { largest, state };
  };

  it("the tip's largest move in a frame halves when the frame does; a stepped weight moves it by the whole gap", () => {
    // The ramp starts a quarter of a second in and ends at 3.25 s.
    const ramp = (seconds: number): number => ease((seconds - 0.25) / 3);
    const at64 = grab(64, ramp);
    const at128 = grab(128, ramp);
    expect(at64.largest / at128.largest).toBeGreaterThan(1.8);
    expect(at64.largest / at128.largest).toBeLessThan(2.2);
    // Not a tip that never moved: it came the quarter metre, at well under a metre a second.
    expect(at64.largest).toBeGreaterThan(0.001);
    expect(at64.largest * 64).toBeLessThan(1);
    // HARD LANDS: from the frame the weight reaches 1, the tip is its target to the bit.
    expect(pointOf(at64.state.position, LINKS)).toEqual(target);
    // The control: the weight stepped to 1 in one frame is a pop, by definition — the whole gap.
    const stepped = grab(64, (seconds) => (seconds < 1 ? 0 : 1));
    expect(stepped.largest).toBeGreaterThan(0.5);
  });
});

describe("rope reference: a lap with both ends held (T1585b slice 2)", () => {
  /*
   * The slice-1 lap with the last point pinned too: a taut strand of four segments carried
   * along +Z at 8 m/s by BOTH its ends through a wrap of −960 m. Every anchor's history goes
   * with the strand, so the far pin is not dragged across the jump either.
   *
   * The two PINS are their targets to the bit on every frame. The points between are not
   * exact as they were with one pin: two anchors soften the chain system's pivots, so a
   * step solves it to the tolerance and not to the last place. They are held to the stored
   * position's own spacing at 960 m, 2⁻¹⁴ m, and their speed to that over a step.
   */
  it("Teleport, Carry: a strand held at both ends goes through a 960 m wrap as if there were none", () => {
    const cols = 5;
    const pitch = 2 ** -4;
    const perFrame = 2 ** -3;
    const trailing = (socket: number): Float32Array => strand(cols, (i) => [0, 0, socket - i * pitch]);
    const lap = (parameters: RopeParameters, frames: number, check: (state: RopeState, socket: number, frame: number) => void): void => {
      const state = seeded(trailing(958), parameters);
      for (let frame = 1; frame < frames; frame += 1) {
        const travelled = 958 + perFrame * frame;
        const socket = travelled >= 960 ? travelled - 960 : travelled;
        advanceRope(state, trailing(socket), parameters, { deltaSeconds: FRAME, substeps: 8 });
        check(state, socket, frame);
      }
    };
    const spacing = 2 ** -14;
    let wrapped = false;
    lap(rope({ gravity: 0, anchorLast: 1, teleportDistance: 100, teleportMode: "carry" }), 40, (state, socket, frame) => {
      wrapped = wrapped || socket < 100;
      expect(state.position[2], `frame ${frame}`).toBe(socket);
      expect(state.position[(cols - 1) * 4 + 2], `frame ${frame}`).toBe(socket - (cols - 1) * pitch);
      expect(state.velocity[(cols - 1) * 4 + 2], `frame ${frame}`).toBe(perFrame * 64);
      for (let point = 1; point < cols - 1; point += 1) {
        expect(Math.abs((state.position[point * 4 + 2] as number) - (socket - point * pitch)), `frame ${frame}, point ${point}`).toBeLessThanOrEqual(spacing);
        // Once the strand is under way (it is seeded at rest and takes a frame to be towed).
        if (frame > 1) expect(Math.abs((state.velocity[point * 4 + 2] as number) - perFrame * 64), `frame ${frame}, point ${point}`).toBeLessThanOrEqual(spacing * 512);
      }
    });
    expect(wrapped).toBe(true);
    // The control: with Teleport off the same lap drags the strand 960 m in the frame of the wrap.
    let fastest = 0;
    lap(rope({ gravity: 0, anchorLast: 1 }), 18, (state) => {
      fastest = Math.max(fastest, Math.abs(state.velocity[2 * 4 + 2] as number));
    });
    expect(fastest).toBeGreaterThan(1000);
  });
});

/*
 * A STRAND SEEDED SHORT BETWEEN TWO PINS (the design's 15.3). Asked to be half as long again
 * as the straight line it is seeded on, a strand between two pins has slack and no shape
 * for it. The node builds none: the seed is still the incoming points, and the solve pays
 * the slack out under what acts on it. So nothing here has a HAND, and that is a statement
 * to the bit: turn the chord to its mirror image across the vertical and the strand is the
 * mirror image, at every frame. A node that bowed its slack toward a reference axis would
 * put both on the same side.
 *
 * Gravity then takes the slack to the low side of the chord, and once it has settled no
 * point lies further from its place under the next direction than the far pin itself moved
 * — on these 32 directions, the nearest of which is 11° from vertical. (Closer in it is not
 * so: the slack is a narrow loop that swings to the other side faster than the chord turns.
 * The design's 16.6 has the numbers.) A chord exactly along gravity has no low side:
 * nothing acts across it, and the strand stays on its chord's line, straight and short, on
 * neither side.
 */
describe("rope reference: a strand seeded short between two pins has no hand (T1585b slice 2, the design's 15.3)", () => {
  const DIRECTIONS = 32;
  const CHORD = 0.5;
  /** cos and sin of `step` 32nds of a turn, exact on the four axes and exactly mirrored across the vertical. */
  const turn = (step: number): readonly [number, number] => {
    const wrapped = ((step % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
    const quarter = DIRECTIONS / 4;
    if (wrapped % quarter === 0) return ([[1, 0], [0, 1], [-1, 0], [0, -1]] as const)[wrapped / quarter] as readonly [number, number];
    // The left half is the right half's mirror image by construction, not by a cosine's last place.
    if (wrapped > quarter && wrapped < 3 * quarter) {
      const [c, sn] = turn(DIRECTIONS / 2 - wrapped);
      return [-c, sn];
    }
    const angle = (2 * Math.PI * wrapped) / DIRECTIONS;
    return [Math.cos(angle), Math.sin(angle)];
  };
  const chordAt = (step: number): Float32Array => {
    const [c, sn] = turn(step);
    return strand(POINTS, (i) => [((c * CHORD) / LINKS) * i, ((sn * CHORD) / LINKS) * i, 0]);
  };
  const short = rope({ damping: 2, anchorLast: 1, restLengthScale: 1.5, iterations: 8 });
  const settle = (step: number, frames: number): RopeState => {
    const state = seeded(chordAt(step), short);
    run(state, chordAt(step), short, frames, 4);
    return state;
  };

  it("the seed is the incoming points in every direction, and a chord and its mirror image stay mirror images to the bit", () => {
    for (let step = 0; step < DIRECTIONS; step += 1) {
      expect(Array.from(seeded(chordAt(step), short).position), `direction ${step}`).toEqual(Array.from(chordAt(step)));
    }
    for (const frames of [1, 16, 64]) {
      for (let step = 0; step <= DIRECTIONS / 4; step += 1) {
        const here = settle(step, frames).position;
        const mirrored = settle(DIRECTIONS / 2 - step, frames).position;
        for (let point = 0; point < POINTS; point += 1) {
          expect((mirrored[point * 4] as number) + (here[point * 4] as number), `${frames} frames, direction ${step}, point ${point}`).toBe(0);
          expect(mirrored[point * 4 + 1], `${frames} frames, direction ${step}, point ${point}`).toBe(here[point * 4 + 1]);
        }
      }
    }
  });

  it("settled, no point lies further from its place under the next direction than the far pin moved; straight up or down it is on neither side", () => {
    const shapes = Array.from({ length: DIRECTIONS }, (_unused, step) => settle(step, 64 * 6).position);
    const pinMoved = CHORD * 2 * Math.sin(Math.PI / DIRECTIONS);
    const vertical = (step: number): boolean => step % (DIRECTIONS / 2) === DIRECTIONS / 4;
    let furthest = 0;
    for (let step = 0; step < DIRECTIONS; step += 1) {
      const next = (step + 1) % DIRECTIONS;
      if (vertical(step) || vertical(next)) continue;
      for (let point = 0; point < POINTS; point += 1) {
        const a = pointOf(shapes[step] as Float32Array, point);
        const b = pointOf(shapes[next] as Float32Array, point);
        furthest = Math.max(furthest, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    const tau = ROPE_TOLERANCE * (CHORD / LINKS) * 1.5 + ROPE_TOLERANCE_FLOOR;
    expect(furthest).toBeLessThanOrEqual(pinMoved + LINKS * tau);
    // The slack did go somewhere: a strand lying level hangs a quarter of a metre below its pins.
    expect((shapes[0] as Float32Array)[8 * 4 + 1] as number).toBeLessThan(-0.2);
    // Straight up and straight down: every point on the chord's own line, to the bit.
    for (const step of [DIRECTIONS / 4, (3 * DIRECTIONS) / 4]) {
      for (let point = 0; point < POINTS; point += 1) {
        expect(Math.abs((shapes[step] as Float32Array)[point * 4] as number), `direction ${step}, point ${point}`).toBe(0);
        expect(Math.abs((shapes[step] as Float32Array)[point * 4 + 2] as number), `direction ${step}, point ${point}`).toBe(0);
      }
    }
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * SLICE 4 — what a weight of 1 is, wherever it comes from (the first consumer's findings).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

describe("rope reference: a weight of 1 is a hold, and so is one a rounding short of it (T1585b slice 4)", () => {
  /** The last float below 1: what `mix(a, 1.0, s)` can give at `s = 1`. */
  const LAST_BELOW_ONE = Math.fround(1 - 2 ** -24);
  const rest = 1 / 16;
  // Held at its first point, its last point's target carried along at a quarter of a metre a second.
  const at = (frame: number): Float32Array => strand(POINTS, (i) => (i === LINKS ? [0.5 + frame * 2 ** -8, -0.25, 0] : [0, -i * rest, 0]));
  const play = (parameters: RopeParameters, maps: RopeMaps = {}): RopeState => {
    const state = seeded(at(0), parameters, 1, maps);
    for (let frame = 1; frame <= 96; frame += 1) advanceRope(state, at(frame), parameters, { deltaSeconds: FRAME, substeps: 4 }, maps);
    return state;
  };
  const only = (point: number, weight: number): Float32Array => {
    const map = new Float32Array(POINTS);
    map[point] = weight;
    return map;
  };
  const sameRun = (a: RopeState, b: RopeState): boolean =>
    Buffer.from(a.position.buffer).equals(Buffer.from(b.position.buffer)) && Buffer.from(a.velocity.buffer).equals(Buffer.from(b.velocity.buffer));
  const loose = rope({ damping: 2, iterations: 8, segmentLength: rest });

  it("the last float below 1 is the run at 1, word for word: as a station's number, as its map, and as a pin", () => {
    for (const weight of [LAST_BELOW_ONE, ROPE_HELD_FROM]) {
      // A station's number.
      const numbered = play({ ...loose, anchorLast: weight });
      expect(sameRun(numbered, play({ ...loose, anchorLast: 1 })), `Anchor Last ${weight}`).toBe(true);
      expect(pointOf(numbered.position, LINKS)).toEqual([0.5 + 96 * 2 ** -8, -0.25, 0]);
      // Its map, read at the strand's last point.
      expect(sameRun(play(loose, { anchorLast: only(LINKS, weight) }), play(loose, { anchorLast: only(LINKS, 1) })), `Anchor Last mapped ${weight}`).toBe(true);
      // A pin, on that point and on one in the middle of the strand.
      expect(sameRun(play(loose, { pin: only(LINKS, weight) }), play(loose, { pin: only(LINKS, 1) })), `pin ${weight}`).toBe(true);
      const middle = play(loose, { pin: only(8, weight) });
      expect(sameRun(middle, play(loose, { pin: only(8, 1) })), `pin in the middle ${weight}`).toBe(true);
      expect(pointOf(middle.position, 8)).toEqual([0, -8 * rest, 0]);
    }
  });

  /*
   * THE TOLERANCE IS A MILLIONTH, AND NOT MORE. Under it a weight is the spring it says: at
   * 0.999 a pin's spring is 999 times the one at a half, sized for one point's mass, and a
   * strand of seventeen hung from it by its first point rests seventeen weights over that
   * spring below its target: 17·g ÷ ((2π·strength)²·999), 0.86 mm. A tolerance wide enough
   * to swallow 0.999 would put it ON the target.
   */
  it("under the tolerance a weight is a pull: at 0.999 the point rests below its target, and the float under the tolerance is not the run at 1", () => {
    const hung = { ...loose, anchorFirst: 0, damping: 8 };
    const maps = { pin: only(0, 0.999) };
    const pulled = seeded(at(0), hung, 1, maps);
    for (let frame = 0; frame < 64 * 6; frame += 1) advanceRope(pulled, at(0), hung, { deltaSeconds: FRAME, substeps: 4 }, maps);
    const one = GRAVITY / ((2 * Math.PI * ROPE_DEFAULTS.anchorStrength) ** 2 * 999);
    expect(-(pulled.position[1] as number)).toBeGreaterThan(16 * one);
    expect(-(pulled.position[1] as number)).toBeLessThan(18 * one);
    const under = Math.fround(ROPE_HELD_FROM - 2 ** -24);
    expect(sameRun(play({ ...loose, anchorLast: under }), play({ ...loose, anchorLast: 1 }))).toBe(false);
  });
});

describe("rope reference: a held point is where it is told to be (T1585b slice 4, the design's D31)", () => {
  /*
   * UNDER HARD A WEIGHT OF 1 IS A HOLD, ALWAYS. The reach rule (the design's 4.6) is for a
   * target the ROPE cannot reach: points the solve can move between it and the pin before
   * it, and not enough rope. Between two held points that are neighbours there is nothing
   * to solve, and each is its incoming point however far apart they are told to be. (The
   * first consumer's rig holds rings up to 16 % further apart than the rope's pitch. Drawn
   * in, each ring trailed the one before it, and the last by 99 mm.)
   */
  it.each([
    ["16 % longer than the rope", (): number => 1.16],
    ["5 % shorter", (): number => 0.95],
    ["uneven, from 0.9 to 1.2 of a segment", (i: number): number => 0.9 + 0.075 * ((i * 7) % 5)],
  ] as const)("held at every point the rope IS the incoming strip to the bit, at the strip's speed: %s", (_label, gap) => {
    const pin = new Float32Array(POINTS).fill(1);
    const held = rope({ segmentLength: REST });
    const along = Array.from({ length: POINTS }, (_unused, i) => i).map((i, _index, all) => all.slice(1, i + 1).reduce((sum, k) => sum + gap(k) * REST, 0));
    // Carried a quarter of a metre a second along and half a metre a second up.
    const at = (frame: number): Float32Array => strand(POINTS, (i) => [(along[i] as number) + frame * 2 ** -8, frame * 2 ** -7, 0]);
    const state = seeded(at(0), held, 1, { pin });
    for (let frame = 1; frame <= 8; frame += 1) {
      advanceRope(state, at(frame), held, { deltaSeconds: FRAME, substeps: 4 }, { pin });
      expect(Array.from(state.position), `frame ${frame}`).toEqual(Array.from(at(frame)));
    }
    expect(axis(state.velocity, 0)).toEqual(every(0.25));
    expect(axis(state.velocity, 1)).toEqual(every(0.5));
  });

  it("Anchor First and Second both at 1 are both their incoming points, and the first segment is as long as they say: twice a segment, or half", () => {
    const two = rope({ gravity: 0, anchorSecond: 1, segmentLength: REST, maxStretch: 0 });
    const laid = (gap: number): Float32Array => strand(POINTS, (i) => (i === 0 ? [0, 0, 0] : [gap + (i - 1) * REST, 0, 0]));
    for (const gap of [2 * REST, REST / 2]) {
      const state = seeded(laid(gap), two);
      run(state, laid(gap), two, 2, 4);
      expect(pointOf(state.position, 0)).toEqual([0, 0, 0]);
      expect(pointOf(state.position, 1)).toEqual([gap, 0, 0]);
      // The rope after them keeps its own length: the third point is a segment past the second.
      expect(pointOf(state.position, 2)).toEqual([gap + REST, 0, 0]);
    }
  });

  /*
   * THE RULE'S OTHER SIDE, UNCHANGED. A pin with a point the solve can move between it and
   * the pin before it is still drawn in to the rope between them: the third point's target
   * is four segments from the first, there are two segments of rope, and it is put two
   * segments along the line. With the second point held as well the three are neighbours,
   * and each is its incoming point.
   */
  it("across a point the solve can move the earlier pin still wins: a pin two segments on is drawn in to two segments; with the point between held too, it is not", () => {
    const loose = rope({ gravity: 0, segmentLength: REST, maxStretch: 0 });
    const far = strand(POINTS, (i) => (i < 2 ? [i * REST, 0, 0] : [(i + 2) * REST, 0, 0]));
    const only = (points: readonly number[]): Float32Array => {
      const map = new Float32Array(POINTS);
      for (const point of points) map[point] = 1;
      return map;
    };
    const between = seeded(far, loose, 1, { pin: only([2]) });
    for (let frame = 0; frame < 4; frame += 1) advanceRope(between, far, loose, { deltaSeconds: FRAME, substeps: 4 }, { pin: only([2]) });
    expect(pointOf(between.position, 2)).toEqual([2 * REST, 0, 0]);
    const neighbours = seeded(far, loose, 1, { pin: only([1, 2]) });
    for (let frame = 0; frame < 4; frame += 1) advanceRope(neighbours, far, loose, { deltaSeconds: FRAME, substeps: 4 }, { pin: only([1, 2]) });
    expect(pointOf(neighbours.position, 1)).toEqual([REST, 0, 0]);
    expect(pointOf(neighbours.position, 2)).toEqual([4 * REST, 0, 0]);
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * SLICE 4 — the bend limit (the design's section 17: D30, D32).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

/** The angle the strand turns through at point j, radians: 0 along a straight run. */
const turnAt = (position: Float32Array, j: number): number => {
  const a = [0, 1, 2].map((c) => (position[j * 4 + c] as number) - (position[j * 4 - 4 + c] as number)) as [number, number, number];
  const b = [0, 1, 2].map((c) => (position[j * 4 + 4 + c] as number) - (position[j * 4 + c] as number)) as [number, number, number];
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return Math.atan2(cross, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};

describe("rope reference: the bend limit in closed form — a strand held out level by its first two points (T1585b slice 4)", () => {
  /*
   * A BEAM. The first two points are held a segment apart along +X and the other fifteen are
   * left to gravity. With no limit the strand hangs straight down from the second point, a
   * turn of 90° there. With a radius of 2 m every joint may turn 2·asin(2b ÷ 4R) = 2·asin(1/64),
   * 1.79°: the strand curls down along that circle, every joint at its limit, 27° in all.
   *
   * AT REST the shape itself says what each joint carries. Cut the strand at point j: the
   * points beyond it weigh m·g each, and about point j those weights turn the cut end by
   * Σ m·g·(xᵢ − xⱼ). Of the rows that reach across the cut only joint j's has a moment about
   * that point — the segment's passes through it, and the next joint's pushes on the point
   * itself. So joint j's row has pushed λⱼ = g·h²·Σ (xᵢ − xⱼ) per unit mass, and a COMPLIANT
   * row (the design's D30) gives by that times its compliance: 2⁻¹⁰ of the diagonal its rest
   * lengths give it, which is 1 ÷ b² for the first joint (one point of its three can move),
   * 5 ÷ b² for the second and 6 ÷ b² after.
   *
   *     turnⱼ = limit + 2⁻¹⁰ · (1, 5 or 6) ÷ b² · g·h² · Σ (xᵢ − xⱼ)
   *
   * At the root that give is 2.2e-4 rad and at the second joint 9.7e-4, eleven and fifty
   * times what a step may leave on a joint: the compliance is IN the answer. A row raised on
   * its diagonal with nothing on its right-hand side rests every joint at the limit itself.
   */
  const b = 2 ** -4;
  const h = FRAME / 4;
  const beam = (more: Partial<RopeParameters> = {}): RopeParameters => rope({ damping: 8, anchorSecond: 1, segmentLength: b, iterations: 8, minBendRadius: 2, ...more });
  const laid = levelAt(b);
  const rested = (parameters: RopeParameters): RopeState => {
    const state = seeded(laid, parameters);
    run(state, laid, parameters, 64 * 10, 4);
    return state;
  };
  /** What joint j of the resting shape gives by, from the weights beyond it. */
  const giveAt = (position: Float32Array, j: number): number => {
    let moment = 0;
    for (let i = j + 1; i < POINTS; i += 1) moment += GRAVITY * h * h * ((position[i * 4] as number) - (position[j * 4] as number));
    return ((ROPE_BEND_SOFTENING * (j === 1 ? 1 : j === 2 ? 5 : 6)) / (b * b)) * moment;
  };

  it.each([
    ["a radius of 2 m", 2],
    ["half that: twice the turn", 1],
  ] as const)("%s: every joint rests at its limit plus what its compliance gives for the weight beyond it, to the solver's exit tolerance", (_label, radius) => {
    const limit = 2 * Math.asin((2 * b) / (4 * radius));
    /** What a step may leave on a joint: its tolerance on the turn, and the floor on each of its points. */
    const tolerance = limit * ROPE_BEND_TOLERANCE + ROPE_BEND_FLOOR * (2 / b);
    const state = rested(beam({ bendLimit: true, minBendRadius: radius }));
    for (let j = 1; j < LINKS; j += 1) {
      expect(Math.abs(turnAt(state.position, j) - (limit + giveAt(state.position, j))), `joint ${j}`).toBeLessThanOrEqual(tolerance);
    }
    // The give is in the answer: at the second joint it is tens of tolerances.
    expect(giveAt(state.position, 2)).toBeGreaterThan(20 * tolerance);
    // The held points are their incoming points, every segment keeps its length, and it is at rest.
    expect(pointOf(state.position, 0)).toEqual([0, 0, 0]);
    expect(pointOf(state.position, 1)).toEqual([b, 0, 0]);
    for (let k = 1; k < LINKS; k += 1) expect(Math.abs(lengthOf(state.position, k) - b), `segment ${k}`).toBeLessThanOrEqual(ROPE_TOLERANCE * b + ROPE_TOLERANCE_FLOOR + 2 ** -23);
    expect(Math.max(...Array.from(state.velocity, Math.abs))).toBeLessThan(1e-3);
  });

  it("the control: with no limit the strand hangs straight down from its second point", () => {
    const state = rested(beam());
    expect(Math.abs(turnAt(state.position, 1) - Math.PI / 2)).toBeLessThan(0.001);
    expect(Math.abs((state.position[LINKS * 4 + 1] as number) + 15 * b)).toBeLessThan(0.001);
  });
});

describe("rope reference: the limit is one-sided (T1585b slice 4)", () => {
  /*
   * A LIMIT HOLDS A JOINT FROM BENDING FURTHER AND NEVER HOLDS IT BENT. The consumer's loop,
   * at rest with its lowest joints on their limit, has its far pin drawn away until the rope
   * is nearly straight between its pins. Every joint that was at its limit has to be LET GO
   * by the solve, in the step the segments ask it to open: a joint kept in the system while
   * it holds the strand bent fights the segments, and they lose their length.
   */
  it("a loop resting on its limit is drawn out nearly straight: its joints open, and every segment keeps its length while they do", () => {
    const links = 54;
    const pitch = 0.06;
    const limit = 2 * Math.asin(pitch / 0.3);
    const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
    // Carried up to a pin half a metre off over 6 s, rested until 20 s, then drawn out to 3 m over 2 s.
    const at = (t: number): Float32Array =>
      strand(links + 1, (i) => (i === links && t > 0 ? [0.5 * ease(t / 6) + 2.5 * ease((t - 20) / 2), -links * pitch * (1 - ease(t / 6)), 0] : [0, i === 0 ? 0 : -i * pitch, 0]));
    const parameters: RopeParameters = { ...ROPE_DEFAULTS, damping: 2, anchorLast: 1, segmentLength: pitch, minBendRadius: 0.15, iterations: 8, bendLimit: true };
    const state = seeded(at(0), parameters);
    let atLimit = 0;
    let stretch = 0;
    for (let frame = 1; frame <= 60 * 24; frame += 1) {
      advanceRope(state, at(frame / 60), parameters, { deltaSeconds: 1 / 60, substeps: 4 });
      if (frame === 60 * 20) for (let j = 1; j < links; j += 1) if (turnAt(state.position, j) > 0.99 * limit) atLimit += 1;
      if (frame > 60 * 20) for (let k = 0; k < links; k += 1) stretch = Math.max(stretch, Math.abs(lengthOf(state.position, k) - pitch));
    }
    // It was resting on its limit…
    expect(atLimit).toBeGreaterThanOrEqual(4);
    // …and is now a shallow curve between pins 3 m apart: no joint anywhere near its limit.
    let worst = 0;
    for (let j = 1; j < links; j += 1) worst = Math.max(worst, turnAt(state.position, j));
    expect(worst).toBeLessThan(0.25 * limit);
    expect(pointOf(state.position, links)).toEqual(pointOf(at(24), links));
    expect(state.position[links * 4]).toBe(3);
    // While it opened, no segment left its length by more than a step may leave it.
    expect(stretch).toBeLessThanOrEqual(ROPE_TOLERANCE * pitch + ROPE_TOLERANCE_FLOOR + 2 ** -22);
  });
});

describe("rope reference: with the limit on and never reached, a strand is the strand it was (T1585b slice 4)", () => {
  // A radius of a hundredth of a segment: no joint of these strands comes near it.
  const limited = (more: Partial<RopeParameters> = {}): RopeParameters => rope({ bendLimit: true, minBendRadius: REST / 100, ...more });

  it.each([1, 4, 8])("hung from its first point: sag 0 to the bit at %i steps a frame, and each segment carries the weight below it", (steps) => {
    const incoming = hangingAt();
    const state = seeded(incoming, limited());
    run(state, incoming, limited(), 64, steps);
    expect(axis(state.position, 1)).toEqual(Array.from({ length: POINTS }, (_unused, point) => hung(point)));
    expect(axis(state.position, 0)).toEqual(every(0));
    expect(axis(state.velocity, 1)).toEqual(every(0));
    expect(Array.from(state.tension)).toEqual(Array.from({ length: POINTS }, (_unused, point) => (point < LINKS ? (LINKS - point) * GRAVITY : 0)));
  });

  it("free, it falls g·h²·k(k+1)/2 at g·h·k, every point alike", () => {
    const incoming = hangingAt();
    const state = seeded(incoming, limited({ anchorFirst: 0 }));
    run(state, incoming, limited({ anchorFirst: 0 }), 8, 8);
    expect(axis(state.position, 1)).toEqual(Array.from({ length: POINTS }, (_unused, point) => hung(point) - 0.0634765625));
    expect(axis(state.velocity, 1)).toEqual(every(-1));
  });
});

describe("rope reference: the first consumer's loop (T1585b slice 4, the acceptance)", () => {
  /*
   * 54 segments of 0.06 m, both ends held half a metre apart, a radius of 0.15 m: a joint
   * may turn 2·asin(0.06 ÷ 0.3) = 23.07°. Hung with no limit the loop's lowest joints turn
   * more than twice that. The strand is seeded hanging straight and its far end is carried
   * up to its pin over six seconds — a pose the rope could lie in (a pose seeded with a fold
   * far past the limit can open into a loop with a full turn in it, the design's D33).
   */
  const links = 54;
  const pitch = 0.06;
  const radius = 0.15;
  const limit = 2 * Math.asin(pitch / (2 * radius));
  const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
  const loopAt = (t: number): Float32Array => strand(links + 1, (i) => (i === links && t > 0 ? [0.5 * ease(t / 6), -links * pitch * (1 - ease(t / 6)), 0] : [0, -i * pitch, 0]));
  const hang = (more: Partial<RopeParameters>, substeps: number): { worst: number; stretch: number; moved: number; state: RopeState } => {
    const parameters: RopeParameters = { ...ROPE_DEFAULTS, damping: 2, anchorLast: 1, segmentLength: pitch, minBendRadius: radius, iterations: 8, ...more };
    const state = seeded(loopAt(0), parameters);
    let worst = 0;
    let stretch = 0;
    let moved = 0;
    let was = state.position.slice();
    for (let frame = 1; frame <= 60 * 22; frame += 1) {
      advanceRope(state, loopAt(frame / 60), parameters, { deltaSeconds: 1 / 60, substeps });
      if (frame > 60 * 20) {
        for (let j = 1; j < links; j += 1) worst = Math.max(worst, turnAt(state.position, j));
        for (let k = 0; k < links; k += 1) stretch = Math.max(stretch, Math.abs(lengthOf(state.position, k) - pitch));
        for (let point = 0; point <= links; point += 1) {
          const [a, b] = [pointOf(state.position, point), pointOf(was, point)];
          moved = Math.max(moved, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        }
      }
      was = state.position.slice();
    }
    return { worst, stretch, moved, state };
  };

  it.each([
    [4, 1.0005],
    [16, 1.0002],
  ])("at rest no joint turns past its limit, at %i steps a frame; with no limit the loop's lowest joints turn twice as far", (substeps, ceiling) => {
    const limited = hang({ bendLimit: true }, substeps);
    // The limit, its exit tolerance, and what a resting joint gives (measured 1.0001 of the
    // limit at four steps and 1.0000 at sixteen; in closed form in the three-point case above).
    expect(limited.worst / limit).toBeLessThanOrEqual(ceiling);
    // …and it is AT its limit, not short of it: the loop is as tight as it is let be.
    expect(limited.worst / limit).toBeGreaterThan(0.999);
    // Its ends are their incoming points and its segments their length.
    expect(pointOf(limited.state.position, 0)).toEqual(pointOf(loopAt(22), 0));
    expect(pointOf(limited.state.position, links)).toEqual(pointOf(loopAt(22), links));
    expect(limited.state.position[links * 4]).toBe(0.5);
    expect(limited.stretch).toBeLessThanOrEqual(ROPE_TOLERANCE * pitch + ROPE_TOLERANCE_FLOOR + 2 ** -22);
    // The control.
    expect(hang({}, substeps).worst / limit).toBeGreaterThan(2);
  });

  /*
   * A LIMIT IS A SET OF ROWS THAT COME AND GO, and a resting bend must not show it. A joint
   * the solve has set a hair inside its limit is out of the system until gravity brings it
   * back, each joint on a step of its own, and the bend then chatters: before a joint within
   * a thousandth of its limit was kept in the system (ROPE_BEND_BAND), this loop shimmered
   * at sixteen steps a frame. Held to the SAME loop with no limit, whose own stillness is
   * what single precision leaves of a step that small.
   */
  it.each([4, 16])("at rest the limit's rows do not show: no point moves further in a frame than in the same loop with no limit, at %i steps a frame", (substeps) => {
    const limited = hang({ bendLimit: true }, substeps);
    const free = hang({}, substeps);
    expect(free.moved).toBeGreaterThan(0);
    expect(limited.moved).toBeLessThanOrEqual(2 * free.moved);
  });
});

describe("rope reference: where the limit and the pins cannot both be had (T1585b slice 4, the design's D30)", () => {
  /*
   * A strand whose first two points are held facing +X and whose last is held straight
   * BEHIND them, at the end of all its rope: taut, folded back on itself at the second
   * point by 180°, where the limit allows 24°. Nothing can meet the limit. Length and the
   * pins hold, the bend gives, and the step has an ANSWER: the strand comes to rest.
   *
   * With the softening as a raised pivot only, a step here has no fixed point: each Newton
   * step adds to the joint's multiplier what the last one failed to deliver.
   */
  it("taut and folded back at the second point: the pins hold, every segment keeps its length, the bend gives, and the strand is at rest", () => {
    const rest = 1 / 16;
    const pulled = rope({ damping: 2, anchorSecond: 1, anchorLast: 1, segmentLength: rest, iterations: 8, bendLimit: true, minBendRadius: 0.15 });
    // Fifteen segments of rope after the second point, and a target fourteen and a half behind it.
    const incoming = strand(POINTS, (i) => (i === LINKS ? [rest - 14.5 * rest, 0, 0] : [i * rest, 0, 0]));
    const state = seeded(strand(POINTS, (i) => [i * rest, 0, 0]), pulled);
    let fastest = 0;
    for (let frame = 0; frame < 64 * 8; frame += 1) {
      advanceRope(state, incoming, pulled, { deltaSeconds: FRAME, substeps: 4 });
      for (const value of state.position) expect(Number.isFinite(value), `frame ${frame}`).toBe(true);
      if (frame >= 64 * 6) for (let point = 0; point < POINTS; point += 1) fastest = Math.max(fastest, Math.hypot(...pointOf(state.velocity, point)));
    }
    expect(pointOf(state.position, 0)).toEqual([0, 0, 0]);
    expect(pointOf(state.position, 1)).toEqual([rest, 0, 0]);
    expect(pointOf(state.position, LINKS)).toEqual([rest - 14.5 * rest, 0, 0]);
    // Within Max Stretch (the guard's 2 %): the solve may leave a taut strand that far and no further.
    for (let k = 1; k < LINKS; k += 1) expect(Math.abs(lengthOf(state.position, k) - rest), `segment ${k}`).toBeLessThanOrEqual(0.02 * rest + 2 ** -22);
    // The bend gave: the strand leaves the second point turned far past the limit's 24°.
    expect(turnAt(state.position, 1)).toBeGreaterThan(1);
    // At rest.
    expect(fastest).toBeLessThan(0.01);
  });
});

describe("rope reference: a pose the limit cannot meet comes to rest, with the limit giving (T1585b slice 4b, the design's D41)", () => {
  /*
   * THE TABLE. Sixteen strands of sixteen segments of 1/16 m, the first two points of each
   * held facing +X, at a radius of 0.15 m: a joint may turn 24.0°. The last point of strand
   * `row` is held d = 7 + row/2 segments straight BEHIND the second: fifteen segments of
   * rope to reach a point d segments back, round a turn of half a circle. At d = 7 the turn
   * fits the radius; from 7.5 on it does not, and at 14.5 there is half a segment of slack.
   *
   * Every strand ARRIVES by a walk and is not seeded folded: laid straight, its far end is
   * carried round over two seconds to four segments behind, rested a second, walked out to d
   * over one more, and held five. The last two seconds are read. (Four segments behind is
   * itself tighter than the radius allows: fifteen segments cannot come back to their own
   * socket's axis that near it. The limit gives there too, by a whole limit on three joints,
   * and is the limit again by d = 6 or 7: the block after this one holds that.)
   *
   * WHAT IT WAS (slice 4, measured on this table): from d = 7.5 to 11.5 the fastest point of
   * the last two seconds moved at 2.7 to 66 m/s at four steps a frame, and to d = 12 at 11
   * to 239 m/s at sixteen. Further out the strand folded flat at its second point and lay
   * still, after being thrown at up to 280 m/s on the way. The same strands with no limit
   * lie still: 0.011 m/s at the most.
   */
  const rest = 1 / 16;
  const ROWS = 16;
  const LIMIT = 2 * Math.asin(rest / 0.3);
  const SECONDS = 9;
  const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
  const table = (t: number): Float32Array => {
    const out = new Float32Array(ROWS * POINTS * 4);
    for (let row = 0; row < ROWS; row += 1) {
      const d = 7 + row / 2;
      let far: Vec3 = [LINKS * rest, 0, row];
      if (t >= 2) {
        far = [rest - (4 + (d - 4) * ease(t - 3)) * rest, 0, row];
      } else if (t > 0) {
        const way = ease(t / 2);
        const reach = (15 - 11 * way) * rest;
        far = [rest + Math.cos(Math.PI * way) * reach, -Math.sin(Math.PI * way) * reach * 0.8, row];
      }
      for (let i = 0; i < POINTS; i += 1) out.set(i === LINKS ? far : [i * rest, 0, row], (row * POINTS + i) * 4);
    }
    return out;
  };
  interface Row {
    /** The fastest free point in the last two seconds, m/s. */
    fastest: number;
    /** The largest any segment past the held pair was off its length from the walk on, as a share. */
    stretch: number;
    /** The largest turn at any joint in the last two seconds, radians; and the joints' turns at the end. */
    worst: number;
    turns: number[];
  }
  const play = (more: Partial<RopeParameters>, substeps: number): Row[] => {
    const parameters = rope({ damping: 2, anchorSecond: 1, anchorLast: 1, segmentLength: rest, iterations: 8, minBendRadius: 0.15, ...more });
    const state = seeded(table(0), parameters, ROWS);
    const rows: Row[] = Array.from({ length: ROWS }, () => ({ fastest: 0, stretch: 0, worst: 0, turns: [] }));
    for (let frame = 1; frame <= SECONDS * 64; frame += 1) {
      const t = frame / 64;
      const incoming = table(t);
      advanceRope(state, incoming, parameters, { deltaSeconds: FRAME, substeps });
      for (let row = 0; row < ROWS; row += 1) {
        const position = state.position.subarray(row * POINTS * 4, (row + 1) * POINTS * 4);
        const velocity = state.velocity.subarray(row * POINTS * 4, (row + 1) * POINTS * 4);
        const seen = rows[row] as Row;
        // A held point is its incoming point, on every frame.
        for (const point of [0, 1, LINKS]) expect(pointOf(position, point), `frame ${frame}, row ${row}, point ${point}`).toEqual(pointOf(incoming.subarray(row * POINTS * 4), point));
        if (t > 3) for (let k = 1; k < LINKS; k += 1) seen.stretch = Math.max(seen.stretch, Math.abs(lengthOf(position, k) / rest - 1));
        if (t > SECONDS - 2) {
          for (let point = 2; point < LINKS; point += 1) seen.fastest = Math.max(seen.fastest, Math.hypot(...pointOf(velocity, point)));
          for (let j = 1; j < LINKS; j += 1) seen.worst = Math.max(seen.worst, turnAt(position, j));
        }
        if (frame === SECONDS * 64) for (let j = 1; j < LINKS; j += 1) seen.turns.push(turnAt(position, j));
      }
    }
    return rows;
  };

  /*
   * AT REST means: no free point faster than 0.03 m/s in the last two seconds, which is half
   * a millimetre a frame, or four times what the same strand with no limit shows where that
   * is more (it shows up to 0.026 m/s: a strand under gravity 8 still settling). Measured:
   * 0.000 m/s on thirteen rows of sixteen at four steps a frame and at most 0.025 on the
   * rest; 0.000 on all sixteen at sixteen steps.
   *
   * THE LIMIT GIVES, AND THE DESIGN DOC SAYS BY HOW MUCH (its section 18): from 1.04 of the
   * limit at d = 7 to 5.6 of it at d = 13, where one joint takes the whole turn. The excess
   * is spread over two to four joints while the slack lets it be (d = 10: 24°, 40°, 40°,
   * 33°, 24°) and gathers on one where it does not (d = 13: 24°, 135°, 24°).
   */
  it.each([4, 16])(
    "at %i steps a frame every row from d = 7 to 14.5 is at rest, its pins exact and every segment within Max Stretch; where the turn does not fit the radius the limit has given, and no joint has folded flat",
    (substeps) => {
      const limited = play({ bendLimit: true }, substeps);
      const free = play({}, substeps);
      for (let row = 0; row < ROWS; row += 1) {
        const [on, off] = [limited[row] as Row, free[row] as Row];
        const d = 7 + row / 2;
        // Seen red on the rows from d = 7.5 to 12 with the hinge taken out: 2.7 to 239 m/s.
        expect(on.fastest, `d ${d}`).toBeLessThanOrEqual(Math.max(4 * off.fastest, 0.03));
        expect(on.stretch, `d ${d}`).toBeLessThanOrEqual(0.02 + 2 ** -18);
        // No joint folded flat: the sharpest is 135°, where one joint takes the whole turn.
        expect(on.worst, `d ${d}`).toBeLessThan(2.5);
        // With no limit the strand folds at the second point: by 102° at d = 7, by more further out.
        expect(off.worst, `d ${d}`).toBeGreaterThan(4 * LIMIT);
      }
      // d = 7 is a pose the limit can meet, and it is met: within what a tight turn gives (measured 1.04 and 1.05).
      expect((limited[0] as Row).worst / LIMIT).toBeLessThan(1.08);
      // From d = 8 on it cannot be, and the limit has given: by a fifth and more.
      for (let row = 2; row < ROWS; row += 1) expect((limited[row] as Row).worst / LIMIT, `d ${7 + row / 2}`).toBeGreaterThan(1.15);
    },
    600_000,
  );
});

describe("rope reference: a limit that gave comes back when the pose lets it (T1585b slice 4b, the design's D41)", () => {
  /*
   * The table's strand walked OUT to d = 11, where the turn does not fit the radius and the
   * limit gives by more than twice, held two seconds, and walked BACK over one second to
   * d = 6, where it fits. The limit that opened closes: behind each joint as it straightens,
   * and onto one that still stands past it. Three seconds on, no joint is past its limit by
   * more than a resting bend gives.
   *
   * AND WITH A MAX STRETCH OF NOTHING (slice 4c, B277). An open limit closes onto its joint
   * only in a step the solve finished at its first attempt, and at a Max Stretch of nothing
   * no step was: every one was solved again, on a rounding. So the limit that gave at d = 11
   * stayed given: 2.02 and 2.31 of the limit back at d = 6, for good.
   */
  const rest = 1 / 16;
  const LIMIT = 2 * Math.asin(rest / 0.3);
  const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
  const behind = (t: number): number => (t < 2 ? 4 : t < 5 ? 4 + 7 * ease(t - 2) : 11 - 5 * ease(t - 5));
  const carried = (t: number): Float32Array => {
    if (t >= 2) return strand(POINTS, (i) => (i === LINKS ? [rest - behind(t) * rest, 0, 0] : [i * rest, 0, 0]));
    const way = ease(t / 2);
    const reach = (15 - 11 * way) * rest;
    return strand(POINTS, (i) => (i === LINKS && t > 0 ? [rest + Math.cos(Math.PI * way) * reach, -Math.sin(Math.PI * way) * reach * 0.8, 0] : [i * rest, 0, 0]));
  };

  it.each([
    [4, 0.02],
    [16, 0.02],
    [4, 0],
    [16, 0],
  ])("at %i steps a frame, Max Stretch %f: out at d = 11 the limit has given by twice; back at d = 6 every joint is within its limit again, and the strand is at rest", (substeps, maxStretch) => {
    const parameters = rope({ damping: 2, anchorSecond: 1, anchorLast: 1, segmentLength: rest, iterations: 8, minBendRadius: 0.15, bendLimit: true, maxStretch });
    const state = seeded(carried(0), parameters);
    let out = 0;
    let back = 0;
    let fastest = 0;
    for (let frame = 1; frame <= 9 * 64; frame += 1) {
      const t = frame / 64;
      advanceRope(state, carried(t), parameters, { deltaSeconds: FRAME, substeps });
      for (let j = 1; j < LINKS; j += 1) {
        if (t > 4 && t <= 5) out = Math.max(out, turnAt(state.position, j));
        if (t > 8) back = Math.max(back, turnAt(state.position, j));
      }
      if (t > 8) for (let point = 2; point < LINKS; point += 1) fastest = Math.max(fastest, Math.hypot(...pointOf(state.velocity, point)));
    }
    expect(out / LIMIT).toBeGreaterThan(2);
    // Measured 1.00 of the limit. Seen red at 1.3 and more with an open limit that never closes,
    // and at 2.02 and 2.31 at a Max Stretch of nothing with D36 asking the guard's exact test.
    expect(back / LIMIT).toBeLessThanOrEqual(1.02);
    expect(fastest).toBeLessThan(0.03);
  });
});

describe("rope reference: the first consumer's strand with its socket facing away from the claw (T1585b slice 4b)", () => {
  /*
   * 53 segments of 0.06 m, 3.18 m of rope, gravity 1.5, damping 1.5: the socket and the ring
   * after it held facing −X, the claw carried round over four seconds to a point `far`
   * metres off along +X. One segment is spent behind the socket, so 3.12 m of rope has
   * `far` + 0.06 m to cover, round a turn of half a circle that 0.15 m of radius does not
   * fit into what is left: the limit cannot be met at 2.9 m or at 3.0, and at 3.06 the rope
   * is TAUT, folded flat at the second point. A joint may turn 23.07°.
   */
  const COLS = 54;
  const PITCH = 0.06;
  const LIMIT = 2 * Math.asin(PITCH / 0.3);
  const FARS = [2.9, 3.0, 3.06, 3.1];
  interface Seen {
    fastest: number;
    stretch: number;
    worst: number;
  }
  const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
  const reaching = (t: number): Float32Array => {
    const out = new Float32Array(FARS.length * COLS * 4);
    FARS.forEach((far, row) => {
      const way = ease(t / 4);
      const angle = Math.PI * (1 - way);
      const reach = 3.12 + (far - 3.12) * way;
      for (let i = 0; i < COLS; i += 1) out.set(i === COLS - 1 && t > 0 ? [Math.cos(angle) * reach, Math.sin(angle) * reach * 0.6, row] : [-i * PITCH, 0, row], (row * COLS + i) * 4);
    });
    return out;
  };
  const play = (more: Partial<RopeParameters>, substeps: number): Seen[] => {
    const parameters: RopeParameters = { ...ROPE_DEFAULTS, gravity: 1.5, damping: 1.5, anchorSecond: 1, anchorLast: 1, segmentLength: PITCH, iterations: 8, minBendRadius: 0.15, ...more };
    const state = seeded(reaching(0), parameters, FARS.length);
    const rows: Seen[] = FARS.map(() => ({ fastest: 0, stretch: 0, worst: 0 }));
    for (let frame = 1; frame <= 12 * 64; frame += 1) {
      advanceRope(state, reaching(frame / 64), parameters, { deltaSeconds: FRAME, substeps });
      if (frame <= 10 * 64) continue;
      rows.forEach((seen, row) => {
        const position = state.position.subarray(row * COLS * 4, (row + 1) * COLS * 4);
        const velocity = state.velocity.subarray(row * COLS * 4, (row + 1) * COLS * 4);
        for (let point = 2; point < COLS - 1; point += 1) seen.fastest = Math.max(seen.fastest, Math.hypot(...pointOf(velocity, point)));
        for (let k = 1; k < COLS - 1; k += 1) seen.stretch = Math.max(seen.stretch, Math.abs(lengthOf(position, k) / PITCH - 1));
        for (let j = 1; j < COLS - 1; j += 1) seen.worst = Math.max(seen.worst, turnAt(position, j));
      });
    }
    return rows;
  };

  /*
   * Measured, four steps and sixteen: at 2.9 m 0.000 m/s, the first joints at 23°, 92°, 37°,
   * 23°, 9° (3.97 of the limit); at 3.0 m at most 0.02 m/s, at 90° and 88° (3.9 of it). The
   * same strands with no limit fold at the second point by 180° and show up to 0.016 m/s.
   * Slice 4 at 2.9 m, four steps: 0.49 m/s, for good.
   *
   * TAUT, at 3.06 m, the limit is given whole: the strand folds flat at the second point as
   * it does with no limit, and a joint that pushes at all there pushes on a strand that
   * cannot finish its step. Its limit is put where it stands and left alone, and the strand
   * is NEARLY still, which is all this row claims: measured 0.13 m/s (2 mm a frame) at four
   * steps a frame and 0.00 at sixteen, held here under 0.25. (Seen red at 0.8 to 3.4 m/s with
   * a joint that pushes under the yield left to push.)
   */
  it.each([4, 16])(
    "at %i steps a frame it is at rest with the claw 2.9 m and 3.0 m off and nearly so with the rope taut at 3.06 m, every segment its length; with slack the limit is given by four times and no more",
    (substeps) => {
      const limited = play({ bendLimit: true }, substeps);
      const free = play({}, substeps);
      for (const row of [0, 1, 2]) {
        const [on, off] = [limited[row] as Seen, free[row] as Seen];
        expect(on.fastest, `claw ${FARS[row]} m`).toBeLessThanOrEqual(Math.max(4 * off.fastest, row === 2 ? 0.25 : 0.03));
        expect(on.stretch, `claw ${FARS[row]} m`).toBeLessThanOrEqual(0.001);
        expect(on.worst / LIMIT, `claw ${FARS[row]} m`).toBeGreaterThan(3);
        if (row < 2) expect(on.worst / LIMIT, `claw ${FARS[row]} m`).toBeLessThan(4.5);
      }
      /*
       * THE CLAW AT 3.1 M IS OUT OF THE ROPE'S REACH, and what the strand does there is not
       * the limit's doing. A far pin is drawn in only when it is further than the rope with
       * Max Stretch on top (3.18 m here), and a rope whose Stretch is nothing cannot take
       * that 2 %: with NO limit this strand is thrown at 11 m/s at four steps a frame and 52
       * at sixteen, a segment 11 % long. That is the reach rule's own defect (the design's
       * section 18.7, with its bug row's text). This assertion is the repro of it.
       */
      expect((free[3] as Seen).fastest).toBeGreaterThan(1);
      expect((free[3] as Seen).stretch).toBeGreaterThan(0.02);
    },
    600_000,
  );
});

describe("rope reference: what leaving a joint alone buys, and what the wait buys (T1585b slice 4b, the design's D41)", () => {
  /*
   * LEFT ALONE, PINNED BY A COUNT. The consumer's strand with the claw 3.0 m off: its limit
   * cannot be met, and a joint that pushes there pushes on a strand that cannot finish its
   * step. Its limit is put where the joint stands and LEFT ALONE, so the steps after are a
   * rope with nothing pushing in it: one or two Newton steps a step (measured). With the
   * limit put there and then closed onto the joint again in the next step, the strand is as
   * still, and every step is spent trying: 7 to 8.
   */
  it("the consumer's strand with the claw 3.0 m off takes one or two Newton steps a step once its limit has given", () => {
    const COLS = 54;
    const PITCH = 0.06;
    const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
    const reaching = (t: number): Float32Array => {
      const way = ease(t / 4);
      const reach = 3.12 - 0.12 * way;
      return strand(COLS, (i) => (i === COLS - 1 && t > 0 ? [Math.cos(Math.PI * (1 - way)) * reach, Math.sin(Math.PI * (1 - way)) * reach * 0.6, 0] : [-i * PITCH, 0, 0]));
    };
    const parameters: RopeParameters = { ...ROPE_DEFAULTS, gravity: 1.5, damping: 1.5, anchorSecond: 1, anchorLast: 1, segmentLength: PITCH, iterations: 8, minBendRadius: 0.15, bendLimit: true };
    const state = seeded(reaching(0), parameters);
    const tally = { newton: 0 };
    for (let frame = 1; frame <= 12 * 64; frame += 1) {
      if (frame === 10 * 64 + 1) tally.newton = 0;
      advanceRope(state, reaching(frame / 64), parameters, { deltaSeconds: FRAME, substeps: 4, tally });
    }
    // The limit has given: the joint after the held pair stands far past 23°.
    expect(turnAt(state.position, 1)).toBeGreaterThan(1);
    expect(tally.newton / (2 * 64 * 4)).toBeLessThanOrEqual(3);
  });

  /*
   * THE WAIT, PINNED BY A SWEEP. A joint has to be in trouble for 1/32 s, step after step,
   * before its limit moves. The first consumer's loop with its far end 1.2 m from the first
   * and swept at 8 m/s, sixteen steps a frame, loads joints past the yield in bursts shorter
   * than that, and its limit does not open: the worst turn of four seconds is 1.03 of the
   * limit, as it was in slice 4. With no wait a burst opens it: 1.58.
   */
  it("a sweep that loads its joints past the yield only in bursts opens no limit: 8 m/s at sixteen steps a frame stays within a tenth of it", () => {
    const LENGTH = 3.24;
    const links = 54;
    const pitch = LENGTH / links;
    const limit = 2 * Math.asin(pitch / 0.3);
    const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
    const swept = (t: number): Float32Array => {
      const way = ease(t / 6);
      let far: Vec3 = [1.2 * way, -LENGTH * (1 - way), 0];
      if (t > 12) {
        const swing = (8 / (2 * Math.PI * 2)) * Math.sin(2 * Math.PI * 2 * (t - 12));
        far = [1.2 + swing, 0.3 * swing, 0];
      }
      return strand(links + 1, (i) => (i === links && t > 0 ? far : [0, -i * pitch, 0]));
    };
    const parameters: RopeParameters = { ...ROPE_DEFAULTS, anchorLast: 1, minBendRadius: 0.15, segmentLength: pitch, bendLimit: true, iterations: 8 };
    const state = seeded(swept(0), parameters);
    let worst = 0;
    for (let frame = 1; frame <= 16 * 60; frame += 1) {
      advanceRope(state, swept(frame / 60), parameters, { deltaSeconds: 1 / 60, substeps: 16 });
      if (frame > 12 * 60) for (let j = 1; j < links; j += 1) worst = Math.max(worst, turnAt(state.position, j));
    }
    expect(worst / limit).toBeGreaterThan(1);
    expect(worst / limit).toBeLessThanOrEqual(1.1);
  });
});

describe("rope reference: letting go of a strand held longer than itself (T1585b slice 4b, the design's D38)", () => {
  /*
   * THE SPEEDLESS TAKE-UP. Every point pinned to a strip laid `over` times the rope's pitch
   * along −Z and carried along +Z at 0.64 m/s: held, the rope IS that strip (D31). At two
   * seconds the pins let go, by a cut in one frame or by a ramp over 0.2 s. The rope takes
   * its own length back in the step it is let go, in POSITIONS ONLY: its far end moves by the
   * whole over-length in that frame, which is seen, and no speed is left in it.
   *
   * WHAT IT WAS (slice 4): the cut left the whole correction in the rope as speed, 55.6 m/s
   * at 16 % long and 8.0 at 2.5 %, and the rope went through its own anchor; the ramp 4.0.
   * THE CONTROL is the same strip at the rope's own pitch, cut: it swings down from its first
   * point under gravity and nothing more, 0.02 m/s in the frame of release and 1.04 m/s at
   * its fastest in the two seconds after.
   */
  const COLS = 54;
  const PITCH = 0.06;
  const BODY = 0.64;
  const RELEASE = 2;
  const cut = (t: number): number => (t >= RELEASE ? 0 : 1);
  const ramp = (t: number): number => {
    const x = Math.min(1, Math.max(0, (t - RELEASE) / 0.2));
    return 1 - x * x * (3 - 2 * x);
  };
  interface Released {
    /** In the frame of release: how far the furthest point moved against the body, its fastest stored speed against the body, the longest segment's share off its length. */
    jump: number;
    speed: number;
    stretch: number;
    /** From the release on: the fastest stored speed against the body. */
    fastest: number;
  }
  const letGo = (over: number, weight: (t: number) => number, more: Partial<RopeParameters> = {}, substeps = 4): Released => {
    const parameters: RopeParameters = { ...ROPE_DEFAULTS, iterations: 8, gravity: 1.5, damping: 1.5, segmentLength: PITCH, ...more };
    const strip = (t: number): Float32Array => strand(COLS, (i) => [0, 0, BODY * t - i * PITCH * over]);
    const pins = (t: number): RopeMaps => ({ pin: new Float32Array(COLS).fill(weight(t)) });
    const state = seeded(strip(0), parameters, 1, pins(0));
    const seen: Released = { jump: 0, speed: 0, stretch: 0, fastest: 0 };
    let before = state.position.slice();
    for (let frame = 1; frame <= 64 * 4; frame += 1) {
      const t = frame / 64;
      advanceRope(state, strip(t), parameters, { deltaSeconds: FRAME, substeps }, pins(t));
      let speed = 0;
      let move = 0;
      for (let point = 0; point < COLS; point += 1) {
        const v = pointOf(state.velocity, point);
        speed = Math.max(speed, Math.hypot(v[0], v[1], v[2] - BODY));
        const [now, was] = [pointOf(state.position, point), pointOf(before, point)];
        move = Math.max(move, Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2] - BODY * FRAME));
      }
      if (weight(t) < 1) seen.fastest = Math.max(seen.fastest, speed);
      if (weight(t) < 1 && weight((frame - 1) / 64) >= 1) {
        seen.jump = move;
        seen.speed = speed;
        for (let k = 0; k < COLS - 1; k += 1) seen.stretch = Math.max(seen.stretch, Math.abs(lengthOf(state.position, k) / PITCH - 1));
      } else if (weight(t) >= 1) {
        // Held, the rope is the strip, to the bit.
        expect(Array.from(state.position), `frame ${frame}`).toEqual(Array.from(strip(t)));
      }
      before = state.position.slice();
    }
    return seen;
  };
  const control = (): Released => letGo(1, cut);

  it("the control: a strip at the rope's own pitch is let go with nothing to take up", () => {
    const free = control();
    expect(free.jump).toBeLessThan(0.001);
    expect(free.speed).toBeLessThan(0.05);
    // It swings down under gravity (measured 1.04 m/s).
    expect(free.fastest).toBeGreaterThan(0.8);
    expect(free.fastest).toBeLessThan(1.3);
  });

  /*
   * THE SPEED IN THE FRAME OF RELEASE, against the control's fastest (1.04 m/s). A CUT leaves
   * nothing to move the strand but gravity for the rest of that frame: under a fifth of it
   * (measured 0.04 and 0.06 m/s). A RAMP's weight a frame after 1 is still a pull fifty
   * times as stiff as the one at a half, toward a strip the rope cannot lie along, and that
   * pull moves the points it holds: up to the control's own speed in that frame (measured
   * 0.11 to 1.05 m/s with the frame the ramp starts in), and 0.03 m/s from the next.
   */
  it.each([
    ["a cut", 1.16, cut, 0.2],
    ["a ramp over 0.2 s", 1.16, ramp, 1.25],
    ["a cut", 1.025, cut, 0.2],
    ["a ramp over 0.2 s", 1.025, ramp, 1.25],
  ] as const)("%s of a strip %f times the rope's length: the far end moves by the over-length in the frame of release, the rope is its own length at once, and it is left with the control's speed and no more", (_name, over, weight, factor) => {
    const taken = 53 * (over - 1) * PITCH;
    const free = control();
    const released = letGo(over, weight);
    // The contraction, seen: the whole over-length in one frame (517 mm and 80 mm measured).
    expect(released.jump).toBeGreaterThan(0.95 * taken);
    expect(released.jump).toBeLessThan(1.05 * taken);
    // Its own length in that frame, not Max Stretch's 2 % over it. (Seen red at 2 % with the guard taking a released segment to Max Stretch.)
    expect(released.stretch).toBeLessThanOrEqual(0.0005);
    // No speed from the take-up. Slice 4: 4 to 56 m/s.
    expect(released.speed).toBeLessThan(factor * free.fastest);
    // And none later: from the release on it is the control's swing. (Seen red at 3.1 m/s with the take-up left to the solve's later steps.)
    expect(released.fastest).toBeLessThan(Math.max(factor, 1.1) * free.fastest);
  });

  it("at sixteen steps a frame and at one it is the same: the take-up is a step's, not a frame's", () => {
    for (const substeps of [1, 16]) {
      const free = letGo(1, cut, {}, substeps);
      const released = letGo(1.16, cut, {}, substeps);
      expect(released.jump, `${substeps} steps`).toBeGreaterThan(0.95 * 53 * 0.16 * PITCH);
      expect(released.stretch, `${substeps} steps`).toBeLessThanOrEqual(0.0005);
      expect(released.speed, `${substeps} steps`).toBeLessThan(0.2 * free.fastest);
      expect(released.fastest, `${substeps} steps`).toBeLessThan(1.1 * free.fastest);
    }
  });

  /*
   * A PART WEIGHT HOLDS NO SEGMENT LONG. Below 1 a pin is a pull and the segment between two
   * pulled points is in the solve, so the rope is its own length under any weight short of a
   * hold: the take-up happens in the step a weight leaves 1, whatever it leaves it for. Cut
   * to a half, the strand shortens in that frame as it does cut to nothing, speedless, and
   * the pulls then draw it toward a strip it cannot lie along.
   */
  it("cut from 1 to a half: the same take-up, in the same frame, and the rope is its own length under the pull", () => {
    const free = control();
    const half = letGo(1.16, (t) => (t >= RELEASE ? 0.5 : 1));
    expect(half.jump).toBeGreaterThan(0.95 * 53 * 0.16 * PITCH);
    expect(half.stretch).toBeLessThanOrEqual(0.0005);
    expect(half.speed).toBeLessThan(0.2 * free.fastest);
  });

  it("Max Stretch is not what a released segment is taken to: at a quarter it is still the rope's own length in that frame", () => {
    const loose = letGo(1.16, cut, { maxStretch: 0.25 });
    expect(loose.stretch).toBeLessThanOrEqual(0.0005);
    expect(loose.speed).toBeLessThan(0.25);
  });
});

describe("rope reference: what holding a joint at its limit buys (T1585b slice 4b, the design's D39)", () => {
  /*
   * THE BAND AND THE LET-GO FLAG, PINNED BY A COUNT. A joint the solve has set a hair inside
   * its limit is held there, in the system, until it would rather open (`ROPE_BEND_BAND`).
   * Without that, each joint of a resting bend falls out of the system and is brought back
   * by gravity on a step of its own, and the step that brings it back needs a second Newton
   * step. The first consumer's loop at rest, sixteen steps a frame: ONE Newton step a step
   * with the band, 1.8 without (measured).
   */
  it("the resting loop at sixteen steps a frame takes one Newton step a step", () => {
    const LENGTH = 3.24;
    const links = 54;
    const pitch = LENGTH / links;
    const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
    const parameters: RopeParameters = { ...ROPE_DEFAULTS, damping: 2, anchorLast: 1, minBendRadius: 0.15, segmentLength: pitch, bendLimit: true, iterations: 8 };
    const carried = (t: number): Float32Array => {
      const way = ease(t / 6);
      return strand(links + 1, (i) => (i === links && t > 0 ? [0.5 * way, -LENGTH * (1 - way), 0] : [0, -i * pitch, 0]));
    };
    const state = seeded(carried(0), parameters);
    const tally = { newton: 0 };
    const [settle, read] = [26, 2];
    for (let frame = 1; frame <= (settle + read) * 64; frame += 1) {
      if (frame === settle * 64 + 1) tally.newton = 0;
      advanceRope(state, carried(frame / 64), parameters, { deltaSeconds: FRAME, substeps: 16, tally });
    }
    // The loop is at its limit on several joints: the count is of a bend, not of a straight strand.
    let atLimit = 0;
    for (let j = 1; j < links; j += 1) if (turnAt(state.position, j) > 0.99 * 2 * Math.asin(pitch / 0.3)) atLimit += 1;
    expect(atLimit).toBeGreaterThanOrEqual(4);
    // Seen red at 1.8 with the band at nothing, and with a joint in the band never let go.
    expect(tally.newton / (read * 64 * 16)).toBeLessThanOrEqual(1.05);
  });
});

describe("rope reference: Bend Limit with a Max Stretch of nothing solves a step once (T1585b slice 4c, B277)", () => {
  /*
   * LENGTH BEFORE BEND (D36) solves a step again, without the limit, when it ends with a
   * segment beyond Max Stretch. Its test was the guard's, which is exact: at a Max Stretch
   * of nothing a rounding is beyond it in every step, so every step was solved two or three
   * times over. It now asks only for a segment beyond Max Stretch by more than the solve's
   * own tolerance of a length. The claim is a COUNT: Newton steps a step, at four steps a
   * frame and at sixteen.
   *
   *                                         before          after     (Max Stretch 0.02)
   *   the consumer's loop at rest         10.0,  3.0      1.0, 1.0        1.0, 1.0
   *   that loop swept at 4 m/s            16.1, 11.8      4.2, 2.5        4.1, 2.5
   *   the consumer's strand, claw 2.9 m   11.1, 12.0      2.0, 2.0        2.0, 2.0
   *
   * WHAT IT DOES NOT CHANGE, AND THIS TEST DOES NOT CLAIM: the guard itself still runs in
   * every step at a Max Stretch of nothing, on the same roundings, and walks the strand to
   * its exact lengths; with the limit on that leaves the consumer's strand moving at 0.06 to
   * 0.3 m/s where it rests at 0.000 with a Max Stretch of 0.02 (the design's 19.3).
   */
  const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
  const LENGTH = 3.24;
  const links = 54;
  const pitch = LENGTH / links;
  const limit = 2 * Math.asin(pitch / 0.3);
  /** The first consumer's loop: carried up over six seconds, and from twelve swept at `peak` m/s when there is one. */
  const loop = (peak: number) => (t: number): Float32Array => {
    const way = ease(t / 6);
    const centre = peak > 0 ? 0.9 : 0.5;
    let far: Vec3 = [centre * way, -LENGTH * (1 - way), 0];
    if (peak > 0 && t > 12) {
      const swing = (peak / (2 * Math.PI * 2)) * Math.sin(2 * Math.PI * 2 * (t - 12));
      far = [centre + swing, 0.3 * swing, 0];
    }
    return strand(links + 1, (i) => (i === links && t > 0 ? far : [0, -i * pitch, 0]));
  };
  const counted = (incoming: (t: number) => Float32Array, parameters: RopeParameters, seconds: number, read: number, substeps: number): { newton: number; worst: number; state: RopeState } => {
    const state = seeded(incoming(0), parameters);
    const tally = { newton: 0 };
    let worst = 0;
    for (let frame = 1; frame <= seconds * 64; frame += 1) {
      if (frame === (seconds - read) * 64 + 1) tally.newton = 0;
      advanceRope(state, incoming(frame / 64), parameters, { deltaSeconds: FRAME, substeps, tally });
      if (frame > (seconds - read) * 64) for (let j = 1; j < state.cols - 1; j += 1) worst = Math.max(worst, turnAt(state.position, j));
    }
    return { newton: tally.newton / (read * 64 * substeps), worst, state };
  };
  const held = (more: Partial<RopeParameters>): RopeParameters => ({ ...ROPE_DEFAULTS, anchorLast: 1, minBendRadius: 0.15, segmentLength: pitch, bendLimit: true, iterations: 8, maxStretch: 0, ...more });

  it.each([4, 16])("at %i steps a frame the loop at rest takes one Newton step a step, as it does with a Max Stretch of 0.02, and is the same loop", (substeps) => {
    const none = counted(loop(0), held({ damping: 2 }), 26, 2, substeps);
    const some = counted(loop(0), held({ damping: 2, maxStretch: 0.02 }), 26, 2, substeps);
    // Seen red at 10 and at 3 with D36 asking the guard's exact test.
    expect(none.newton).toBeLessThanOrEqual(1.05);
    expect(some.newton).toBeLessThanOrEqual(1.05);
    // The limit holds on it as it does with a Max Stretch: at its limit, and not past it.
    expect(none.worst / limit).toBeGreaterThan(0.999);
    expect(none.worst / limit).toBeLessThanOrEqual(1.0005);
    // Its ends are their incoming points. Every segment is its length within a thousandth: the
    // guard, which walks this strand in every step, leaves what it could not place on the
    // segment before the far pin (0.05 % at four steps a frame, before this change and after).
    expect(pointOf(none.state.position, links)).toEqual(pointOf(loop(0)(26), links));
    for (let k = 0; k < links; k += 1) expect(Math.abs(lengthOf(none.state.position, k) - pitch), `segment ${k}`).toBeLessThanOrEqual(0.001 * pitch);
  });

  it.each([4, 16])("at %i steps a frame the loop swept at 4 m/s takes no more Newton steps a step than with a Max Stretch of 0.02, within a tenth", (substeps) => {
    const none = counted(loop(4), held({}), 16, 4, substeps);
    const some = counted(loop(4), held({ maxStretch: 0.02 }), 16, 4, substeps);
    // Seen red at 16.1 against 4.1, and at 11.8 against 2.5.
    expect(none.newton).toBeLessThanOrEqual(1.1 * some.newton);
    expect(some.newton).toBeGreaterThan(2);
  });

  it.each([4, 16])("at %i steps a frame the consumer's strand with the claw 2.9 m off, its limit given, takes two", (substeps) => {
    const COLS = 54;
    const PITCH = 0.06;
    const reaching = (t: number): Float32Array => {
      const way = ease(t / 4);
      const reach = 3.12 - 0.22 * way;
      return strand(COLS, (i) => (i === COLS - 1 && t > 0 ? [Math.cos(Math.PI * (1 - way)) * reach, Math.sin(Math.PI * (1 - way)) * reach * 0.6, 0] : [-i * PITCH, 0, 0]));
    };
    const none = counted(reaching, { ...ROPE_DEFAULTS, gravity: 1.5, damping: 1.5, anchorSecond: 1, anchorLast: 1, segmentLength: PITCH, iterations: 8, minBendRadius: 0.15, bendLimit: true, maxStretch: 0 }, 12, 2, substeps);
    // The limit has given: the joint after the held pair stands far past 23°.
    expect(none.worst).toBeGreaterThan(1);
    // Seen red at 11 and at 12.
    expect(none.newton).toBeLessThanOrEqual(3);
  });
});
