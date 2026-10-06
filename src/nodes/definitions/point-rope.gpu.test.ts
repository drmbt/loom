import { describe, expect, it } from "vitest";

import { ROPE_TOLERANCE, ROPE_TOLERANCE_FLOOR } from "../../points/rope.ts";
import {
  ROPE_FRAME,
  SWEEP_DIRECTIONS,
  SWEEP_STEP,
  component,
  hanging,
  level,
  onRope,
  ropeTwin,
  segmentLength,
  sweptArc,
  type RopeFixture,
  type RopeRead,
  type RopeSession,
} from "./rope-test-support.ts";

/**
 * T1585b — THE ROPE on a real device (§V147): a strand through the compiler, the
 * kernel-steps region, the backend's rate-derived step count and Dawn, read back point by
 * point and held to closed forms and to the CPU reference (`src/points/rope.ts`).
 *
 * The fixtures are dyadic so that the closed forms are EXACT in single precision: sixteen
 * segments of 2⁻¹⁰ m, gravity 8, sixty-four frames a second. A frame's step, every whole
 * division of it, and every product below are then representable, and an assertion is
 * `toBe`, not a band. Where a claim is about a strand in general motion — where a square
 * root is irrational — the bound is the solver's own exit tolerance, stated where it is used.
 *
 * Every test names what it was seen red against.
 */

const LINKS = 16;
const POINTS = LINKS + 1;
const REST = 2 ** -10;
const GRAVITY = 8;

/** A Rope that runs exactly `steps` solver steps on a frame of the fixture's 1/64 s. */
const stepping = (steps: number, more: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  updateRate: 64 * steps,
  minSteps: 1,
  maxSteps: 16,
  gravity: GRAVITY,
  damping: 0,
  ...more,
});

/** Where point `point` of a strand hung from the origin rests: `point` segments down (and 0, not −0, at the top). */
const hung = (point: number, rest = REST): number => (point === 0 ? 0 : -point * rest);
const hangs = (drop = 0): number[] => Array.from({ length: POINTS }, (_unused, point) => hung(point) + drop);

const ys = (region: Float32Array): number[] => Array.from({ length: POINTS }, (_unused, point) => component(region, point, 1));
const xs = (region: Float32Array): number[] => Array.from({ length: POINTS }, (_unused, point) => component(region, point, 0));
const every = (value: number): number[] => Array<number>(POINTS).fill(value);

async function frames(rope: RopeSession, count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) rope.render();
  await Promise.resolve();
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe("rope: a strand hung from its first point (T1585b, the design's section 10)", () => {
  /*
   * THE CLOSED FORM. Pinned at the top and at rest, a step drops every free point by
   * δ = g·h², which stretches the top segment by δ and no other. The chain system is then
   * tridiagonal with every pivot exactly 1, its solution is λₖ = −(16 − k)·δ, and every
   * point moves back up by exactly δ: the hanging strand is a FIXED POINT of the step, at
   * any step size. Its sag is 0, and segment k carries −λₖ ÷ h² = (16 − k)·g newtons — the
   * weight of the points below it.
   *
   * The relaxation kernel on this same fixture (`kernel-steps.gpu.test.ts`) sags
   * 128·g·h²: a quarter of the strand's length at one step a frame, 2⁻⁸ at eight.
   *
   * ON THE DEVICE THIS IS THE DESIGN'S FALLBACK, SINCE SLICE 2. Slice 1's program kept the
   * fixed point to the bit at all three step counts. Slice 2's — the same arithmetic for a
   * free point, in a larger program — does not at four and eight: the first stepped frame
   * reads a tension of 128.00009 N, which is one last place of the top segment's stretch
   * (2⁻¹³ m) and so of its square root. Metal compiles with fast math, and which square root
   * becomes a reciprocal estimate is its choice, made again whenever the text changes (two
   * rewrites of the direction and of the pivot did not move it). So the device is held to
   * what the solver's own exit allows: every segment within τ = rest ÷ 8192 + 10⁻⁷ m of its
   * length, so point k within k·τ of its place and moving at most 2k·τ a step, and segment
   * k's tension within what (16 − k) points each 2τ out of place in a step would add. The
   * REFERENCE is exact, here and in `points/rope.test.ts`.
   */
  it.each([1, 4, 8])("hangs at its length at %i steps a frame: sag within the solver's tolerance, and each segment carries the weight below it", async (steps) => {
    const fixture: RopeFixture = { cols: POINTS, pose: hanging(REST), rope: stepping(steps, { tensionOutput: true }) };
    await onRope(fixture, async (rope) => {
      await frames(rope, 64);
      const read = await rope.read();
      const tau = ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR;
      const h = ROPE_FRAME / steps;
      for (let point = 0; point < POINTS; point += 1) {
        // Seen red with the back substitution moving nothing: every segment 2% long, which is
        // where Max Stretch then holds it (the second point at −0.000996, 80 tolerances out).
        expect(Math.abs(component(read.position, point, 1) - hung(point)), `point ${point}`).toBeLessThanOrEqual(point * tau);
        expect(Math.abs(component(read.position, point, 0)), `point ${point}`).toBe(0);
        expect(Math.abs(component(read.velocity, point, 1)), `point ${point}`).toBeLessThanOrEqual((2 * point * tau) / h);
        // 128 newtons at the top, 8 at the tip, and none past the last point.
        const weightBelow = point < LINKS ? (LINKS - point) * GRAVITY : 0;
        expect(Math.abs((read.tension[point] as number) - weightBelow), `segment ${point}`).toBeLessThanOrEqual(((LINKS - point) * 2 * tau) / (h * h));
      }
      // The pinned point is the incoming point, to the bit, whatever the rest did.
      expect(component(read.position, 0, 1)).toBe(0);
      expect(read.tension[LINKS]).toBe(0);

      // The reference, stepped on the same frames, is the closed form to the bit.
      const twin = ropeTwin(fixture);
      for (let frame = 0; frame < 64; frame += 1) twin.render();
      expect(ys(twin.state.position)).toEqual(hangs());
      expect(ys(twin.state.velocity)).toEqual(every(0));
      expect(Array.from(twin.state.tension)).toEqual(Array.from({ length: POINTS }, (_unused, point) => (point < LINKS ? (LINKS - point) * GRAVITY : 0)));
    });
  }, 120_000);

  /*
   * WITH A COMPLIANCE the strand gives, by the closed form of a chain of springs: segment
   * k lengthens by α·Tₖ with α = stretch × rest and Tₖ = (16 − k)·g. At Stretch 2⁻¹⁰ that
   * is 2⁻¹⁷·(16 − k) metres, an eighth of the top segment's length. It is where the strand
   * comes to rest whatever the step — XPBD's claim, and the reason the parameter is a
   * compliance — so the same numbers are asserted at three step counts. The bound is the
   * solver's exit tolerance: what a step is allowed to leave on a segment.
   */
  it.each([1, 4, 8])("with a Stretch it comes to rest at the closed form α·g·(16 − k) a segment, at %i steps a frame", async (steps) => {
    const fixture: RopeFixture = { cols: POINTS, pose: hanging(REST), rope: stepping(steps, { damping: 8, stretch: 2 ** -10, maxStretch: 1 }) };
    await onRope(fixture, async (rope) => {
      await frames(rope, 384);
      const read = await rope.read();
      const bound = ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR;
      for (let k = 0; k < LINKS; k += 1) {
        const given = segmentLength(read.position, k) - REST;
        // Seen red at 0 with Stretch cut: the strand hangs at its rest length.
        expect(Math.abs(given - 2 ** -17 * (LINKS - k)), `segment ${k}`).toBeLessThanOrEqual(bound);
      }
      // …and it HAS given: the tip hangs 136·2⁻¹⁷ m below its rest length, to the same bound a segment.
      expect(Math.abs(-component(read.position, LINKS, 1) - LINKS * REST - 136 * 2 ** -17)).toBeLessThanOrEqual(bound * LINKS);
    });
  }, 180_000);
});

describe("rope: a seed is the incoming points, whichever way the strand lies (T1585b)", () => {
  /*
   * THE FIRST CONSUMER'S FLIP, measured on its rig: a held arc built in closed form bowed
   * its slack toward a direction projected at right angles to the chord, and when the chord
   * swung through that direction the bow changed sides — 1.29 m of tentacle in one step,
   * however fine the step. A straight walk never met it.
   *
   * A running rope cannot do that: inertia holds the side it is on. A SEEDED rope could, if
   * the node built its pose. It builds none. A fresh state, Reset and Teleport with Reset
   * are one function, and it copies the incoming points slot for slot; the node holds no
   * reference axis, so there is no direction for a chord to pass through and no tie-break
   * to state.
   *
   * 128 strands, one per direction of a whole turn of the chord (`sweptArc`), four of them
   * exactly on an axis, seeded all three ways. Each is the incoming arc to the bit; and so
   * from one direction to the next no point moves further than the sweep itself moves it.
   */
  it.each(["turning", "across", "down"] as const)("slack %s: a fresh state, Reset and Teleport with Reset all seed the incoming arc, in every direction", async (bow) => {
    const pose = sweptArc(bow);
    const fixture: RopeFixture = { cols: POINTS, rows: SWEEP_DIRECTIONS, pose, rope: stepping(1, { teleportDistance: 8, teleportMode: "reset" }) };
    const incoming = (shift: readonly [number, number, number]): number[] =>
      Array.from({ length: SWEEP_DIRECTIONS * POINTS * 4 }, (_unused, word) => {
        const slot = Math.floor(word / 4);
        const axis = word % 4;
        return axis === 3 ? 0 : (pose.at(slot % POINTS, Math.floor(slot / POINTS), 0)[axis] as number) + (shift[axis] as number);
      });
    /** The furthest any point lies from the same point of the strand one direction on. */
    const furthest = (position: Float32Array): number => {
      let most = 0;
      for (let strand = 0; strand < SWEEP_DIRECTIONS; strand += 1) {
        const next = (strand + 1) % SWEEP_DIRECTIONS;
        for (let point = 0; point < POINTS; point += 1) {
          const here = (strand * POINTS + point) * 4;
          const there = (next * POINTS + point) * 4;
          most = Math.max(
            most,
            Math.hypot(
              (position[there] as number) - (position[here] as number),
              (position[there + 1] as number) - (position[here + 1] as number),
              (position[there + 2] as number) - (position[here + 2] as number),
            ),
          );
        }
      }
      return most;
    };
    await onRope(fixture, async (rope) => {
      const seededAs = async (shift: readonly [number, number, number], how: string): Promise<void> => {
        const read = await rope.read();
        // Seen red with the seed bowing its slack across a projected axis: the strands whose
        // chord has crossed that axis stand a quarter of a metre to the other side.
        expect(Array.from(read.position), how).toEqual(incoming(shift));
        expect(Math.max(...Array.from(read.velocity, Math.abs)), how).toBe(0);
        expect(furthest(read.position), how).toBeLessThanOrEqual(SWEEP_STEP);
        expect(furthest(read.position), how).toBeGreaterThan(SWEEP_STEP / 2);
      };
      rope.render();
      await seededAs([0, 0, 0], "a fresh state");

      // Let every strand swing off its seed, then hold them on an arc that has moved.
      await frames(rope, 3);
      expect(Array.from((await rope.read()).position)).not.toEqual(incoming([0, 0, 0]));
      rope.push({ reset: 1 });
      rope.shift([0.5, 0.25, 0]);
      rope.render();
      await seededAs([0.5, 0.25, 0], "Reset");

      // Swing again, then jump every anchor 64 m: past Teleport Distance, so each strand is put back.
      rope.push({ reset: 0 });
      await frames(rope, 3);
      rope.shift([0.5, 0.25, 64]);
      rope.render();
      await seededAs([0.5, 0.25, 64], "Teleport with Reset");
    });
  }, 120_000);
});

describe("rope: a strand that nothing holds falls as one body (T1585b)", () => {
  /*
   * Free, every point is predicted the same step down, no segment changes length, and the
   * solve has nothing to do: after k steps of h each point is lower by g·h²·k(k+1)/2 (the
   * step is implicit, so the first one already moves) and falls at g·h·k. At eight steps a
   * frame h is 1/512 and g·h² is 2⁻¹⁵, so every number is exact.
   */
  const fallen = (stepsRun: number): number => -(2 ** -15) * ((stepsRun * (stepsRun + 1)) / 2);

  it("a released anchor: the strand hangs, lets go, and every point falls g·h²·k(k+1)/2 at g·h·k", async () => {
    const fixture: RopeFixture = { cols: POINTS, pose: hanging(REST), rope: stepping(8) };
    await onRope(fixture, async (rope) => {
      await frames(rope, 4);
      // The control: still held, the strand has not moved.
      expect(ys((await rope.read()).position)).toEqual(hangs());
      rope.push({ anchorFirst: 0 });
      await frames(rope, 8);
      const read = await rope.read();
      // 64 steps: 2,080·2⁻¹⁵ = 0.0634765625 m, at 1 m/s. Seen red (the strand still hanging from 0) with the anchor's weight unread.
      expect(fallen(64)).toBe(-0.0634765625);
      expect(ys(read.position)).toEqual(hangs(fallen(64)));
      expect(ys(read.velocity)).toEqual(every(-1));
      expect(xs(read.position)).toEqual(every(0));
    });
  }, 120_000);

  it("from Reset, which is exact on any device: held on its incoming points while on, falling from the frame it goes off", async () => {
    const fixture: RopeFixture = { cols: POINTS, pose: hanging(REST), rope: stepping(8, { anchorFirst: 0, reset: true }) };
    await onRope(fixture, async (rope) => {
      await frames(rope, 4);
      const held = await rope.read();
      // Seen red (the first point 0.0092 m down already) with the reset flag unread.
      expect(ys(held.position)).toEqual(hangs());
      expect(ys(held.velocity)).toEqual(every(0));
      rope.push({ reset: 0 });
      await frames(rope, 2);
      const read = await rope.read();
      expect(ys(read.position)).toEqual(hangs(fallen(16)));
      expect(ys(read.velocity)).toEqual(every(-0.25));
    });
  }, 120_000);
});

describe("rope: the anchor is the incoming point, and drags the strand (T1585b, the design's section 4.1)", () => {
  /*
   * A strand lying along +X is towed by its first point along −X at 2⁻⁶ m a frame: 1 m/s.
   * Pulled along its own axis an inextensible strand moves as one, so every point takes
   * the anchor's step in every solver step, exactly.
   */
  const TOW = 2 ** -6;

  it("a pinned point is its target to the bit, moves at the target's speed in EVERY step, and the strand follows at that speed", async () => {
    const fixture: RopeFixture = { cols: POINTS, pose: level(REST), rope: stepping(4, { gravity: 0 }) };
    await onRope(fixture, async (rope) => {
      await frames(rope, 1);
      for (let frame = 1; frame <= 6; frame += 1) {
        rope.shift([-TOW * frame, 0, 0]);
        rope.render();
        const read = await rope.read();
        // The pinned point IS the incoming point.
        expect(component(read.position, 0, 0), `frame ${frame}`).toBe(-TOW * frame);
        // Its velocity is the target's: the frame's move over the frame's step. A solver that
        // moved the anchor all at once in a frame's first step reads 0 here on its last —
        // seen red at exactly that, with the target not interpolated across the steps.
        expect(component(read.velocity, 0, 0), `frame ${frame}`).toBe(-TOW / ROPE_FRAME);
        expect(xs(read.velocity), `frame ${frame}`).toEqual(every(-1));
        expect(xs(read.position), `frame ${frame}`).toEqual(Array.from({ length: POINTS }, (_unused, point) => point * REST - TOW * frame));
      }
      // INERTIA. Let go, with no gravity and no drag: every point keeps the speed it had.
      rope.push({ anchorFirst: 0 });
      await frames(rope, 5);
      const free = await rope.read();
      expect(xs(free.velocity)).toEqual(every(-1));
      expect(xs(free.position)).toEqual(Array.from({ length: POINTS }, (_unused, point) => point * REST - TOW * 11));
    });
  }, 120_000);

  /*
   * LENGTH UNDER A SWAYING ANCHOR. A one-metre strand of sixteen segments hangs from a
   * point that sways an eighth of a metre once a second. The step limit of the design's
   * section 2.6 is h < √(l ÷ (a·N)): with l = 1/16 m, N = 16 segments and a no more than
   * g + A·ω² = 8 + 4.94 m/s², that is 17 ms, and the step here is 1/256 s — well inside. So
   * every step ends with every segment within the solver's exit tolerance of its length:
   * 1/8192 of it and the floor. The assertion adds what storing a point costs: the solve
   * works relative to the strand's first point and stores world positions below 2 m, where
   * a float is 2⁻²³ m apart, and a length read back is the difference of two of them.
   */
  it("keeps every segment within its exit tolerance of its length while the anchor sways, at every frame", async () => {
    const rest = 1 / 16;
    const fixture: RopeFixture = { cols: POINTS, pose: hanging(rest), rope: stepping(4, { damping: 0.5, iterations: 8 }) };
    const bound = ROPE_TOLERANCE * rest + ROPE_TOLERANCE_FLOOR + 4 * 2 ** -23;
    await onRope(fixture, async (rope) => {
      const twin = ropeTwin(fixture);
      await frames(rope, 1);
      twin.render();
      let worst = 0;
      let swung = 0;
      for (let frame = 1; frame <= 160; frame += 1) {
        const by: [number, number, number] = [Math.fround(0.125 * Math.sin(2 * Math.PI * frame * ROPE_FRAME)), 0, 0];
        rope.shift(by);
        twin.shift(by);
        rope.render();
        twin.render();
        if (frame % 8 !== 0) continue;
        const read = await rope.read();
        for (let k = 0; k < LINKS; k += 1) worst = Math.max(worst, Math.abs(segmentLength(read.position, k) - rest));
        swung = Math.max(swung, Math.abs(component(read.position, LINKS, 0) - component(read.position, 0, 0)));
        // The reference is the same strand to four digits of its one-metre length, 640
        // steps in. Not more: a square root and a division are not bit-specified in WGSL
        // and the device may fuse a multiply and an add, and a swinging strand carries each
        // such last-place difference forward (measured: 1.04e-5 m at frame 112).
        for (let point = 0; point < POINTS; point += 1) {
          for (const axis of [0, 1, 2] as const) {
            expect(Math.abs(component(read.position, point, axis) - component(twin.state.position, point, axis)), `frame ${frame}, point ${point}`).toBeLessThan(1e-4);
          }
        }
      }
      // Seen red at 1.11e-5 m, one and a half tolerances, with a step held to ONE Newton step.
      // That is how the uniform block's first name for Iterations was found out: the backend
      // writes a stepped dispatch's own `iterations` (1) into any member called that.
      expect(worst).toBeLessThanOrEqual(bound);
      // Not a strand that stood still: its tip swung more than a hand's width off the anchor.
      expect(swung).toBeGreaterThan(0.1);
    });
  }, 180_000);

  /*
   * THE GUARD. An anchor thrown a hundred strand-lengths in one frame is far past any step
   * limit: the Newton steps cannot converge, and Max Stretch is what bounds the damage. It
   * sets each segment's later point, in order from the first, so every segment ends the
   * step at most 2% long — to the float spacing at 100 m, which is 2⁻¹⁷ m.
   */
  it("an anchor thrown a hundred lengths in one frame leaves no segment beyond Max Stretch; raise the limit and one is", async () => {
    const rest = 1 / 16;
    const longest = async (maxStretch: number): Promise<number> =>
      onRope({ cols: POINTS, pose: hanging(rest), rope: stepping(4, { maxStretch, iterations: 1 }) }, async (rope) => {
        await frames(rope, 2);
        rope.shift([100, 0, 0]);
        rope.render();
        const read = await rope.read();
        let most = 0;
        for (let k = 0; k < LINKS; k += 1) most = Math.max(most, segmentLength(read.position, k));
        return most;
      });
    // Seen red at 53.5 m — one segment, of a sixteenth of a metre — with the guard never run.
    expect(await longest(0.02)).toBeLessThanOrEqual(rest * 1.02 + 3 * 2 ** -17);
    // The control: with the limit out of the way the same throw leaves a segment several times its length.
    expect(await longest(10)).toBeGreaterThan(rest * 2);
  }, 120_000);

  it("a weight between 0 and 1 is a pull, and the device and the reference agree on it", async () => {
    const fixture: RopeFixture = { cols: POINTS, pose: level(1 / 16), rope: stepping(4, { anchorFirst: 0.5, damping: 1 }) };
    await onRope(fixture, async (rope) => {
      const twin = ropeTwin(fixture);
      await frames(rope, 1);
      twin.render();
      rope.shift([0, 0.25, 0]);
      twin.shift([0, 0.25, 0]);
      for (let frame = 0; frame < 48; frame += 1) {
        rope.render();
        twin.render();
      }
      const read = await rope.read();
      for (let point = 0; point < POINTS; point += 1) {
        for (const axis of [0, 1, 2] as const) {
          // Four digits of a one-metre strand, as above (measured: 1.1e-5 m).
          expect(Math.abs(component(read.position, point, axis) - component(twin.state.position, point, axis)), `point ${point}`).toBeLessThan(1e-4);
        }
      }
      // It is neither free nor pinned: the first point has fallen below its target (a free
      // one would be metres down after 0.75 s at g = 8) and is not on it.
      const below = 0.25 - component(read.position, 0, 1);
      expect(below).toBeGreaterThan(0.01);
      expect(below).toBeLessThan(1);
    });
  }, 120_000);
});

describe("rope: steps and time (T1585b, the design's section 6)", () => {
  /*
   * THE COUNT IS READ OFF THE FALL. A free strand at rest falls g·h²·S(S+1)/2 in its first
   * frame of S steps, with h the frame's step over S — a different number for every S, so
   * the drop says how many steps ran and how long each was.
   */
  const dropAfter = async (rope: Readonly<Record<string, unknown>>, delta: number, pushed?: Readonly<Record<string, number>>): Promise<number> =>
    onRope({ cols: POINTS, pose: hanging(REST), rope: { gravity: GRAVITY, damping: 0, anchorFirst: 0, ...rope } }, async (session) => {
      session.render();
      if (pushed !== undefined) session.pushSteps(pushed);
      session.render({ delta });
      return component((await session.read()).position, 0, 1);
    });
  const drop = (delta: number, steps: number): number => -GRAVITY * (delta / steps) ** 2 * ((steps * (steps + 1)) / 2);

  it("a frame runs clamp(round(delta × Update Rate), Min, Max) steps of delta ÷ steps: Notch's rule, at the backend", async () => {
    // 256 a second on a 1/64 s frame: four steps of 1/256. Seen red at −0.001953125, which is ONE
    // step of 1/64, with the backend leaving the count at what the plan was compiled with.
    expect(await dropAfter({ updateRate: 256 }, ROPE_FRAME)).toBe(drop(ROPE_FRAME, 4));
    // A tick that covers two project frames runs eight, at the SAME step.
    expect(await dropAfter({ updateRate: 256 }, 2 * ROPE_FRAME)).toBe(drop(2 * ROPE_FRAME, 8));
    expect(drop(2 * ROPE_FRAME, 8)).not.toBe(drop(2 * ROPE_FRAME, 4));
    // Max caps the count and the step grows: no time is lost.
    expect(await dropAfter({ updateRate: 256, maxSteps: 2 }, ROPE_FRAME)).toBe(drop(ROPE_FRAME, 2));
    // Min forces steps a slow rate would not ask for.
    expect(await dropAfter({ updateRate: 1, minSteps: 4 }, ROPE_FRAME)).toBe(drop(ROPE_FRAME, 4));
    // The rate is a VALUE of the region: pushed like a count, it takes effect the frame it arrives.
    expect(await dropAfter({ updateRate: 256 }, ROPE_FRAME, { rate: 512 })).toBe(drop(ROPE_FRAME, 8));
  }, 180_000);

  /** A strand let swing from level: every point moves, so the bytes are a history. */
  const swinging = (more: Readonly<Record<string, unknown>> = {}): RopeFixture => ({
    cols: POINTS,
    rows: 2,
    pose: level(1 / 16),
    rope: { updateRate: 256, gravity: GRAVITY, damping: 0.5, tensionOutput: true, ...more },
  });
  const after = async (fixture: RopeFixture, play: (rope: RopeSession) => void): Promise<RopeRead> =>
    onRope(fixture, async (rope) => {
      play(rope);
      return rope.read();
    });

  it("one tick of two frames is two ticks of one, byte for byte; so are four sub-frames and one frame", async () => {
    const eachFrame = await after(swinging(), (rope) => {
      for (let frame = 0; frame < 9; frame += 1) rope.render();
    });
    const doubled = await after(swinging(), (rope) => {
      rope.render();
      for (let tick = 0; tick < 4; tick += 1) rope.render({ delta: 2 * ROPE_FRAME });
    });
    const quartered = await after(swinging(), (rope) => {
      rope.render();
      for (let sub = 0; sub < 32; sub += 1) rope.render({ delta: ROPE_FRAME / 4 });
    });
    expect(same(doubled.bytes, eachFrame.bytes)).toBe(true);
    expect(same(quartered.bytes, eachFrame.bytes)).toBe(true);
    // Not a strand that never moved: it has swung well below where it was laid.
    expect(component(eachFrame.position, LINKS, 1)).toBeLessThan(-0.05);
    // The control: at another rate the same frames are another strand (five steps a frame, not four).
    const otherRate = await after(swinging({ updateRate: 320 }), (rope) => {
      for (let frame = 0; frame < 9; frame += 1) rope.render();
    });
    expect(same(otherRate.bytes, eachFrame.bytes)).toBe(false);
  }, 180_000);

  it("realtime, fixed-step and offline frames are the same bytes: the node has no frame-mode branch (§V662)", async () => {
    const play = (mode: "realtime" | "fixed-step" | "offline") => (rope: RopeSession) => {
      for (let frame = 0; frame < 9; frame += 1) rope.render({ mode });
    };
    const offline = await after(swinging(), play("offline"));
    expect(same((await after(swinging(), play("realtime"))).bytes, offline.bytes)).toBe(true);
    expect(same((await after(swinging(), play("fixed-step"))).bytes, offline.bytes)).toBe(true);
  }, 180_000);

  it("a seek replays byte for byte: frame 3 after a reset is the frame 3 of a run that only went to 3 (§V170)", async () => {
    const play = (count: number) => (rope: RopeSession) => {
      for (let frame = 0; frame <= count; frame += 1) rope.render();
    };
    const direct = await after(swinging(), play(3));
    const further = await after(swinging(), play(6));
    const sought = await after(swinging(), (rope) => {
      play(6)(rope);
      rope.seek();
      play(3)(rope);
    });
    expect(same(sought.bytes, direct.bytes)).toBe(true);
    // The state it was reset from was a different one.
    expect(same(further.bytes, direct.bytes)).toBe(false);
  }, 180_000);

  it("a frame of no length, and a Simulation Speed of 0, leave every byte as it was", async () => {
    await onRope(swinging(), async (rope) => {
      for (let frame = 0; frame < 5; frame += 1) rope.render();
      const before = await rope.read();
      rope.render({ delta: 0 });
      rope.render({ delta: 0 });
      expect(same((await rope.read()).bytes, before.bytes)).toBe(true);
      rope.push({ speed: 0 });
      rope.render();
      rope.render();
      expect(same((await rope.read()).bytes, before.bytes)).toBe(true);
      // The control: with time running again the strand moves on.
      rope.push({ speed: 1 });
      rope.render();
      expect(same((await rope.read()).bytes, before.bytes)).toBe(false);
    });
  }, 120_000);
});

describe("rope: reset and teleport (T1585b, the design's sections 4.7 and 4.8)", () => {
  const laid = (more: Readonly<Record<string, unknown>> = {}): RopeFixture => ({
    cols: POINTS,
    pose: level(1 / 16),
    rope: { updateRate: 256, gravity: GRAVITY, damping: 0.5, ...more },
  });

  it("Reset holds the rope on its incoming points at rest for as long as it is on, and lets it go again", async () => {
    await onRope(laid(), async (rope) => {
      await frames(rope, 12);
      const swung = await rope.read();
      expect(component(swung.position, LINKS, 1)).toBeLessThan(-0.05);
      rope.push({ reset: 1 });
      rope.shift([0.5, 0.25, 0]);
      await frames(rope, 3);
      const held = await rope.read();
      // On the incoming points — the shifted ones — and at rest. Seen red with the flag unread
      // (the second point at 0.533, mid-swing, where 0.5625 is its incoming place).
      expect(xs(held.position)).toEqual(Array.from({ length: POINTS }, (_unused, point) => point / 16 + 0.5));
      expect(ys(held.position)).toEqual(every(0.25));
      expect(ys(held.velocity)).toEqual(every(0));
      rope.push({ reset: 0 });
      await frames(rope, 4);
      expect(component((await rope.read()).position, LINKS, 1)).toBeLessThan(0.25);
    });
  }, 120_000);

  /*
   * CARRY. A jump of the anchor past Teleport Distance moves the strand's whole state by
   * the jump: its shape and its speed are what they would have been. A twin that never
   * jumps is the oracle — the carried strand is the twin moved by the jump, to the float
   * spacing where it lands (2⁻¹⁷ m below 128 m), and its velocities are the twin's.
   */
  it("Carry: past Teleport Distance the strand goes with the jump, its shape and its speed kept", async () => {
    const jump = 64;
    const play = async (fixture: RopeFixture, by: number): Promise<RopeRead> =>
      onRope(fixture, async (rope) => {
        await frames(rope, 12);
        rope.shift([0, 0, by]);
        await frames(rope, 2);
        return rope.read();
      });
    const stayed = await play(laid({ teleportDistance: 8 }), 0);
    const carried = await play(laid({ teleportDistance: 8 }), jump);
    let apart = 0;
    let speedApart = 0;
    for (let point = 0; point < POINTS; point += 1) {
      for (const axis of [0, 1, 2] as const) {
        const moved = axis === 2 ? jump : 0;
        apart = Math.max(apart, Math.abs(component(carried.position, point, axis) - moved - component(stayed.position, point, axis)));
        speedApart = Math.max(speedApart, Math.abs(component(carried.velocity, point, axis) - component(stayed.velocity, point, axis)));
      }
    }
    // Two stored positions, each rounded where it stands: 2⁻¹⁷ m at 64 m, twice.
    expect(apart).toBeLessThanOrEqual(2 * 2 ** -17);
    // A velocity is a difference of positions near the strand's own origin over the step:
    // what the rounding at 64 m can add is that spacing over 1/256 s.
    expect(speedApart).toBeLessThanOrEqual(2 * 2 ** -17 * 256);
    // The control: the same jump with Teleport off DRAGS the strand — its tip is flung at
    // hundreds of metres a second, where the carried one is swinging at under ten.
    const dragged = await play(laid(), jump);
    const speed = (read: RopeRead): number => Math.hypot(component(read.velocity, LINKS, 0), component(read.velocity, LINKS, 1), component(read.velocity, LINKS, 2));
    expect(speed(carried)).toBeLessThan(10);
    expect(speed(dragged)).toBeGreaterThan(100);
  }, 180_000);

  it("Teleport: Reset puts the strand on its incoming points at rest; under the distance nothing teleports", async () => {
    // One step a frame: the step that resets is then the whole of its frame. (At more, the
    // steps after it are ordinary ones, and the strand has already begun to fall again.)
    await onRope(laid({ updateRate: 64, teleportDistance: 8, teleportMode: "reset" }), async (rope) => {
      await frames(rope, 12);
      rope.shift([0, 0, 64]);
      rope.render();
      const read = await rope.read();
      expect(xs(read.position)).toEqual(Array.from({ length: POINTS }, (_unused, point) => point / 16));
      expect(ys(read.position)).toEqual(every(0));
      expect(Array.from({ length: POINTS }, (_unused, point) => component(read.position, point, 2))).toEqual(every(64));
      expect(ys(read.velocity)).toEqual(every(0));
      // A move UNDER the distance is an ordinary move: the strand is not put back.
      await frames(rope, 24);
      rope.shift([0, 0, 68]);
      rope.render();
      expect(component((await rope.read()).position, LINKS, 1)).toBeLessThan(-0.05);
    });
  }, 120_000);

  /*
   * THE FIRST CONSUMER'S CASE (sentinel-bot, §T1561b). Its world wraps every 960 m: once a
   * lap every socket's z falls by 960 with the same frame around it, while the socket keeps
   * moving. Teleport Distance 100, Carry, a strand of 54 segments trailing the socket.
   *
   * Made exact: a pitch of 2⁻⁴ m (the consumer's is 0.06) and a socket at 2⁻³ m a frame,
   * 8 m/s (its is about 9), with no gravity and no drag, so the strand is towed as one body
   * and every position before, at and after the wrap is a float — also at 960 m, where
   * floats are 2⁻¹⁴ m apart. "As if there were no wrap" is then a statement to the bit:
   * every point one pitch behind the last and every point at 8 m/s, on every frame.
   *
   * It is the MOVING anchor that makes this a test of Carry and not only of a jump. The
   * frame of the wrap asks the target to go from 959.875 to 0: that is the jump of −960
   * AND the eighth of a metre the socket travels in any frame. Carry takes the socket to
   * have come from where its speed puts it, so the strand is moved by exactly −960 and
   * the socket draws it on as before. Moved by the whole difference instead, the strand
   * lands in the right place for one frame with the socket standing still in it — seen red
   * so: every point reads 0 m/s on the frame of the wrap, moved and not towed.
   */
  it("the 960 m lap: Teleport Distance 100 with Carry takes a towed 54-segment strand through the wrap as if there were none", async () => {
    const cols = 55;
    const pitch = 2 ** -4;
    const perFrame = 2 ** -3;
    const lap = 960;
    const towed = (more: Readonly<Record<string, unknown>>): RopeFixture => ({
      cols,
      // Laid out behind the socket along −Z, as a tentacle trails.
      pose: { wgsl: `vec3f(0.0, 0.0, -f32(i) * ${String(pitch)})`, at: (i) => [0, 0, -i * pitch] },
      rope: { updateRate: 512, gravity: 0, damping: 0, ...more },
    });
    const zs = (region: Float32Array): number[] => Array.from({ length: cols }, (_unused, point) => component(region, point, 2));
    await onRope(towed({ teleportDistance: 100, teleportMode: "carry" }), async (rope) => {
      let crossed = false;
      // The socket starts two metres short of the wrap and crosses it on frame 16.
      for (let frame = 0; frame < 40; frame += 1) {
        const travelled = lap - 2 + perFrame * frame;
        const socket = travelled >= lap ? travelled - lap : travelled;
        crossed = crossed || travelled >= lap;
        rope.shift([0, 0, socket]);
        rope.render();
        if (frame === 0) continue;
        const read = await rope.read();
        expect(zs(read.position), `frame ${frame}`).toEqual(Array.from({ length: cols }, (_unused, point) => socket - point * pitch));
        expect(zs(read.velocity), `frame ${frame}`).toEqual(Array<number>(cols).fill(perFrame * 64));
      }
      expect(crossed).toBe(true);
    });
    // The control: the same lap with Teleport off drags the strand 960 m in the frame of the wrap.
    await onRope(towed({}), async (rope) => {
      for (let frame = 0; frame <= 16; frame += 1) {
        const travelled = lap - 2 + perFrame * frame;
        rope.shift([0, 0, travelled >= lap ? travelled - lap : travelled]);
        rope.render();
      }
      const read = await rope.read();
      expect(Math.abs(component(read.velocity, cols - 1, 2))).toBeGreaterThan(1000);
    });
  }, 180_000);
});
