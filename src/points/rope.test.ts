import { describe, expect, it } from "vitest";

import {
  ROPE_ANCHOR_STRENGTH_HZ,
  ROPE_DEFAULTS,
  ROPE_TOLERANCE,
  ROPE_TOLERANCE_FLOOR,
  advanceRope,
  createRopeState,
  stepRope,
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
const seeded = (incoming: Float32Array, parameters: RopeParameters, rows = 1): RopeState => {
  const state = createRopeState(incoming.length / 4 / rows, rows);
  advanceRope(state, incoming, parameters, { deltaSeconds: 0, substeps: 1, firstRun: true });
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
   * A WEIGHT BETWEEN 0 AND 1 IS A SPRING, of stiffness m·(2π·strength)²·a ÷ (1 − a), stepped
   * implicitly. Implicit stepping changes how a spring gets to rest and not where: the whole
   * strand hangs from it, 17 points of weight m·g, so it rests 17·g ÷ ((2π·strength)²·gain)
   * below its target — 0.861 m at weight 0.5 and 0.287 m at 0.75, at any step count.
   *
   * The bound is the exit tolerance carried through: a top segment left τ off its length is
   * a tension off by τ·m ÷ 2h², and the spring turns that into τ ÷ (2h²·ω²·gain) metres.
   *
   * (That figure is why slice 2 has to decide what mass the pull is scaled by: under a
   * point's own mass a "2 Hz" anchor lets a 16 mm strand hang most of a metre.)
   */
  it.each([
    [0.5, 1],
    [0.5, 8],
    [0.75, 4],
  ])("a weight of %f rests the strand's whole weight on a spring of that stiffness, at %i steps a frame", (weight, steps) => {
    const incoming = hangingAt();
    const held = rope({ damping: 8, anchorFirst: weight });
    const state = seeded(incoming, held);
    run(state, incoming, held, 64 * 12, steps);
    const gain = weight / (1 - weight);
    const omegaSquared = (2 * Math.PI * ROPE_ANCHOR_STRENGTH_HZ) ** 2;
    const closed = (POINTS * GRAVITY) / (omegaSquared * gain);
    const h = FRAME / steps;
    const bound = (ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR) / (2 * h * h * omegaSquared * gain) + 2 ** -22;
    expect(Math.abs(-(state.position[1] as number) - closed)).toBeLessThanOrEqual(bound);
    // The bound is not the claim: it is a thousandth of the sag at most.
    expect(bound).toBeLessThan(closed / 1000);
    // The strand below it hangs straight, at its length.
    expect(Math.abs((state.position[1] as number) - (state.position[LINKS * 4 + 1] as number) - LINKS * REST)).toBeLessThanOrEqual(LINKS * (ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR));
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
