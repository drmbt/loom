import { describe, expect, it } from "vitest";

import { ROPE_DEFAULTS, ROPE_TOLERANCE, ROPE_TOLERANCE_FLOOR } from "../../points/rope.ts";
import {
  ROPE_FRAME,
  SWEEP_DIRECTIONS,
  component,
  hanging,
  onRope,
  ropeTwin,
  segmentLength,
  type RopeFixture,
  type RopePose,
  type RopeRead,
  type RopeSession,
} from "./rope-test-support.ts";

/**
 * T1585b SLICE 2 — THE ROPE'S ANCHORS on a real device (§V147): three stations, a weight per
 * strand from an attribute, a pin attribute, and the rule for two anchors, through the
 * compiler, the backend and Dawn, held to closed forms and to the CPU reference
 * (`src/points/rope.ts`, whose own closed forms are `points/rope.test.ts`).
 *
 * WHAT IS EXACT HERE AND WHAT IS NOT. A hard pin is stored as its target, so "the pinned
 * point IS the incoming point" is `toBe`, on every frame. What the solve places is not held
 * to the bit on this device (see the hanging strand in `point-rope.gpu.test.ts`): Metal
 * compiles with fast math, and a strand with two anchors softens its pivots besides. Those
 * are held to the solver's own exit tolerance, to a closed form with the bound the tolerance
 * carries, or to the reference within four digits of the strand's length, as said at each.
 *
 * Every test names what it was seen red against.
 */

const LINKS = 16;
const POINTS = LINKS + 1;
const REST = 1 / 16;
const GRAVITY = 8;
const TAU = ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR;

/** Four steps of 1/256 s on the fixture's 1/64 s frame. */
const stepping = (more: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  updateRate: 256,
  gravity: GRAVITY,
  damping: 2,
  iterations: 8,
  ...more,
});

async function frames(rope: RopeSession, count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) rope.render();
  await Promise.resolve();
}
const pointOf = (region: Float32Array, point: number): number[] => [component(region, point, 0), component(region, point, 1), component(region, point, 2)];
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const apart = (a: Float32Array, b: Float32Array): number => {
  let most = 0;
  for (let word = 0; word < a.length; word += 1) most = Math.max(most, Math.abs((a[word] as number) - (b[word] as number)));
  return most;
};

/**
 * A strand laid level along +X, a metre of sixteen segments, strands a unit apart along Z —
 * and from the first stepped frame on its LAST point's target is drawn in to `x`, so a strand
 * held there has a quarter of a metre of slack. Seeded on the straight strand, so its
 * segments are measured at their length.
 */
const drawnIn = (x: number, y = 0): RopePose => ({
  wgsl: `select(vec3f(f32(i) * ${REST}, 0.0, f32(j)), vec3f(${x}, ${y}, f32(j)), i == ${LINKS}u && t > 0.0)`,
  at: (i, j, t) => (i === LINKS && t > 0 ? [x, y, j] : [i * REST, 0, j]),
});

describe("rope: held at both ends (T1585b slice 2, the design's 4.6)", () => {
  it("with slack it hangs between its pins: each end is its incoming point to the bit, every segment keeps its length, and the device is the reference", async () => {
    const fixture: RopeFixture = { cols: POINTS, pose: drawnIn(0.75), rope: stepping({ anchorLast: 1 }) };
    await onRope(fixture, async (rope) => {
      const twin = ropeTwin(fixture);
      for (let frame = 0; frame < 64 * 6; frame += 1) {
        rope.render();
        twin.render();
        if (frame % 48 !== 47) continue;
        const read = await rope.read();
        // Seen red with the last station's weight unread: the strand swings from its first
        // point, and its last is at x = −0.20 where it should be held at 0.75.
        expect(pointOf(read.position, 0), `frame ${frame}`).toEqual(pointOf(read.incoming, 0));
        expect(pointOf(read.position, LINKS), `frame ${frame}`).toEqual([0.75, 0, 0]);
        expect(pointOf(read.position, LINKS), `frame ${frame}`).toEqual(pointOf(read.incoming, LINKS));
        for (let k = 0; k < LINKS; k += 1) expect(Math.abs(segmentLength(read.position, k) - REST), `frame ${frame}, segment ${k}`).toBeLessThanOrEqual(TAU + 2 ** -22);
        // Four digits of the strand's one metre, as for a strand that swings from one pin.
        expect(apart(read.position, twin.state.position), `frame ${frame}`).toBeLessThan(1e-4);
      }
      const settled = await rope.read();
      // It hangs, and has come to rest. A metre of rope between pins 0.75 m apart can hang no
      // lower than a V, ½·√(1 − 0.75²) = 0.331 m; a chain hangs a little above that.
      const deepest = 0.5 * Math.sqrt(1 - 0.75 ** 2);
      expect(-component(settled.position, 8, 1)).toBeLessThanOrEqual(deepest);
      expect(-component(settled.position, 8, 1)).toBeGreaterThan(0.8 * deepest);
      expect(Math.max(...Array.from(settled.velocity, Math.abs))).toBeLessThan(0.01);
    });
  }, 180_000);

  /*
   * OUT OF REACH, THE EARLIER PIN WINS. The last target is put at twice the strand's length
   * along it: it is drawn in to the rope's length times 1 + Max Stretch, on the line to it.
   * The first point does not move; length is kept and the target is not. The reach is a sum
   * of sixteen exact products; where the device divides it by a square root the last point
   * is held to one last place of where it stands.
   */
  it("a last target out of reach is drawn in to the rope's length on the line to it, and the first point holds", async () => {
    const lastAt = async (maxStretch: number, pose: RopePose): Promise<RopeRead> =>
      onRope({ cols: POINTS, pose, rope: stepping({ gravity: 0, anchorLast: 1, maxStretch }) }, async (rope) => {
        await frames(rope, 6);
        return rope.read();
      });
    const beyond = await lastAt(0, drawnIn(2));
    expect(pointOf(beyond.position, 0)).toEqual([0, 0, 0]);
    // Seen red at x = 2, the target itself, with the reach rule out: sixteen segments of 12.5 cm.
    expect(Math.abs(component(beyond.position, LINKS, 0) - 1)).toBeLessThanOrEqual(2 ** -23);
    expect(Math.abs(component(beyond.position, LINKS, 1))).toBe(0);
    for (let k = 0; k < LINKS; k += 1) expect(Math.abs(segmentLength(beyond.position, k) - REST), `segment ${k}`).toBeLessThanOrEqual(TAU + 2 ** -22);
    // With Max Stretch at a quarter the rope gives that much before the target is lost.
    const giving = await lastAt(0.25, drawnIn(2));
    expect(Math.abs(component(giving.position, LINKS, 0) - 1.25)).toBeLessThanOrEqual(2 ** -22);
    // The control: a target inside the rope's length is the last point, to the bit.
    const within = await lastAt(0, drawnIn(0.5, 0.25));
    expect(pointOf(within.position, LINKS)).toEqual([0.5, 0.25, 0]);
  }, 180_000);

  it("the second point held with the first fixes the way the strand leaves: its first segment does not swing", async () => {
    // A strand laid level, held at its first TWO points, and let fall: it leaves along +X.
    const level: RopePose = { wgsl: `vec3f(f32(i) * ${REST}, 0.0, f32(j))`, at: (i, j) => [i * REST, 0, j] };
    const play = async (anchorSecond: number): Promise<RopeRead> =>
      onRope({ cols: POINTS, pose: level, rope: stepping({ anchorSecond, damping: 8 }) }, async (rope) => {
        await frames(rope, 64 * 8);
        return rope.read();
      });
    const held = await play(1);
    // Seen red with the second station's weight unread: the second point hangs a segment below the first.
    expect(pointOf(held.position, 1)).toEqual([REST, 0, 0]);
    // The rest hangs from the SECOND point: fifteen segments, each within its tolerance, straight below it.
    expect(Math.abs(component(held.position, LINKS, 1) + 15 * REST)).toBeLessThanOrEqual(15 * (TAU + 2 ** -22) + 0.001);
    expect(Math.abs(component(held.position, LINKS, 0) - REST)).toBeLessThan(0.01);
    // The control: with the second point free the whole strand hangs from the first.
    const free = await play(0);
    expect(component(free.position, 1, 1)).toBeLessThan(-0.9 * REST);
  }, 180_000);
});

describe("rope: Segment Length (T1585b slice 2)", () => {
  /*
   * THE FIRST CONSUMER'S SEED. Its incoming strip is a straight run with the LAST point
   * already where the claw should go, so the last segment as seeded is whatever that
   * distance is: measured, the rope has one segment two thirds of a metre long. With
   * Segment Length every segment is the number, and a strand let hang is its own length.
   */
  it("a strip whose last point is somewhere else still makes a rope of its own length", async () => {
    const pose: RopePose = {
      wgsl: `select(vec3f(0.0, -f32(i) * ${REST}, 0.0), vec3f(0.5, -0.5, 0.0), i == ${LINKS}u)`,
      at: (i) => (i === LINKS ? [0.5, -0.5, 0] : [0, -i * REST, 0]),
    };
    const tipAfter = async (segmentLength: number): Promise<number> =>
      onRope({ cols: POINTS, pose, rope: stepping({ damping: 8, segmentLength }) }, async (rope) => {
        await frames(rope, 64 * 12);
        return component((await rope.read()).position, LINKS, 1);
      });
    // Seen red at the control's own number with the parameter unread.
    expect(Math.abs((await tipAfter(REST)) + 1)).toBeLessThanOrEqual(LINKS * (TAU + 2 ** -22) + 2 ** -20);
    // The control: measured from the seed, the last segment is the 0.66 m to that point.
    expect(await tipAfter(0)).toBeLessThan(-1.5);
  }, 180_000);
});

describe("rope: a weight per strand, from an attribute (T1585b slice 2, the design's 4.4)", () => {
  /*
   * Two strands, both with a last target that leaves a quarter of a metre of slack. The
   * kernel upstream writes `hold` beside its positions: 0 on the first strand's points and
   * 1 on the second's. Anchor Last in Map mode reads it at each strand's last point — one
   * strand holds and its neighbour lets go, on one node.
   */
  const fixture = (more: Partial<RopeFixture>, rope: Readonly<Record<string, unknown>> = {}): RopeFixture => ({
    cols: POINTS,
    rows: 2,
    pose: drawnIn(0.75),
    weights: [{ name: "hold", wgsl: "f32(j)", at: (_i, j) => j }],
    rope: stepping(rope),
    ...more,
  });
  const play = async (which: RopeFixture): Promise<RopeRead> =>
    onRope(which, async (rope) => {
      await frames(rope, 64 * 2);
      return rope.read();
    });
  const last = (read: RopeRead, strand: number): number[] => pointOf(read.position, strand * POINTS + LINKS);

  it("the strand whose last point reads 1 holds, the one that reads 0 lets go; cut the map and both take the parameter", async () => {
    const mapped = await play(fixture({ maps: { anchorLast: "hold" } }));
    // Seen red with the last station's weight unread: the strand that should hold is at
    // x = 0.20, swinging with its neighbour.
    expect(last(mapped, 1)).toEqual([0.75, 0, 1]);
    expect(last(mapped, 0)[1]).toBeLessThan(-0.5);
    // THE WIRE CUT. No map: both follow the parameter. At 0 both let go…
    const cutLoose = await play(fixture({}));
    expect(last(cutLoose, 0)[1]).toBeLessThan(-0.5);
    expect(last(cutLoose, 1)[1]).toBeLessThan(-0.5);
    // …and at 1 both hold.
    const cutHeld = await play(fixture({}, { anchorLast: 1 }));
    expect(last(cutHeld, 0)).toEqual([0.75, 0, 0]);
    expect(last(cutHeld, 1)).toEqual([0.75, 0, 1]);
    // The strand that lets go under the map is the strand that lets go under the parameter, to the byte of its positions.
    expect(Array.from(mapped.position.subarray(0, POINTS * 4))).toEqual(Array.from(cutLoose.position.subarray(0, POINTS * 4)));
  }, 180_000);

  it("the map is read at the strand's own LAST point: a weight written anywhere else on the strand is not one", async () => {
    // `hold` is 1 on every point but each strand's last: no strand holds. Seen red with the
    // map read at the strand's first point: both strands hold.
    const elsewhere = await play(fixture({ weights: [{ name: "hold", wgsl: `select(1.0, 0.0, i == ${LINKS}u)`, at: (i) => (i === LINKS ? 0 : 1) }], maps: { anchorLast: "hold" } }));
    expect(last(elsewhere, 0)[1]).toBeLessThan(-0.5);
    expect(last(elsewhere, 1)[1]).toBeLessThan(-0.5);
  }, 120_000);
});

describe("rope: a pin attribute, a weight on every point (T1585b slice 2)", () => {
  it("a point pinned in the middle of a strand is its incoming point to the bit while the strip moves, and the device is the reference", async () => {
    const fixture: RopeFixture = {
      cols: POINTS,
      pose: { wgsl: `vec3f(f32(i) * ${REST}, 0.0, f32(j))`, at: (i, j) => [i * REST, 0, j] },
      weights: [{ name: "clip", wgsl: "select(0.0, 1.0, i == 8u)", at: (i) => (i === 8 ? 1 : 0) }],
      rope: stepping({ pinAttribute: "clip" }),
    };
    await onRope(fixture, async (rope) => {
      const twin = ropeTwin(fixture);
      rope.render();
      twin.render();
      for (let frame = 1; frame <= 96; frame += 1) {
        const by: [number, number, number] = [frame * 2 ** -8, 0, 0];
        rope.shift(by);
        twin.shift(by);
        rope.render();
        twin.render();
        if (frame % 16 !== 0) continue;
        const read = await rope.read();
        // Seen red with the pin attribute unread: the eighth point swings down with the rest.
        expect(pointOf(read.position, 8), `frame ${frame}`).toEqual([8 * REST + frame * 2 ** -8, 0, 0]);
        expect(component(read.velocity, 8, 0), `frame ${frame}`).toBe(0.25);
        expect(apart(read.position, twin.state.position), `frame ${frame}`).toBeLessThan(1e-4);
      }
      // Two spans: the first sags between its two pins, the second hangs from the eighth point.
      const read = await rope.read();
      expect(component(read.position, 4, 1)).toBeLessThan(0);
      expect(component(read.position, LINKS, 1)).toBeLessThan(-4 * REST);
    });
  }, 180_000);
});

describe("rope: a weight a rounding short of 1 holds (T1585b slice 4, the first consumer's finding)", () => {
  /*
   * A weight that is COMPUTED upstream, `mix(a, 1.0, s)` at s = 1, can land on the last
   * float below 1, and under Hard that is a spring 16 million times the one at a half where
   * a hold was meant. A weight within a millionth of 1 is read as 1. The kernel here writes
   * that float by its bits, so no compiler folds it to 1 on the way.
   */
  const LAST_BELOW_ONE = Math.fround(1 - 2 ** -24);
  const level: RopePose = { wgsl: `vec3f(f32(i) * ${REST}, 0.0, f32(j))`, at: (i, j) => [i * REST, 0, j] };

  it("as a pin in the middle of a strand it is the incoming point to the bit while the strip moves; at 0.999 it is a pull, and hangs below", async () => {
    const pinned = (wgsl: string, weight: number): RopeFixture => ({
      cols: POINTS,
      pose: level,
      weights: [{ name: "clip", wgsl: `select(0.0, ${wgsl}, i == 8u)`, at: (i) => (i === 8 ? weight : 0) }],
      rope: stepping({ pinAttribute: "clip" }),
    });
    await onRope(pinned("bitcast<f32>(0x3f7fffffu)", LAST_BELOW_ONE), async (rope) => {
      rope.render();
      for (let frame = 1; frame <= 96; frame += 1) {
        rope.shift([frame * 2 ** -8, 0, 0]);
        rope.render();
        if (frame % 16 !== 0) continue;
        const read = await rope.read();
        // Seen red with the weight read as it is written: the point is a few micrometres off its target, and not it.
        expect(pointOf(read.position, 8), `frame ${frame}`).toEqual([8 * REST + frame * 2 ** -8, 0, 0]);
        expect(component(read.velocity, 8, 0), `frame ${frame}`).toBe(0.25);
      }
    });
    // The control: 0.999 is under the tolerance, a spring sized for one point's mass with half the strand on it.
    const pulled = await onRope(pinned("0.999", 0.999), async (rope) => {
      await frames(rope, 64 * 4);
      return rope.read();
    });
    // At least the eight points below it over that spring: 8·g ÷ ((2π·strength)²·999), 0.4 mm.
    expect(-component(pulled.position, 8, 1)).toBeGreaterThan((8 * GRAVITY) / ((2 * Math.PI * ROPE_DEFAULTS.anchorStrength) ** 2 * 999));
  }, 180_000);

  it("as a mapped Anchor Last it holds the strand's end on its incoming point, to the bit", async () => {
    const fixture: RopeFixture = {
      cols: POINTS,
      rows: 2,
      pose: drawnIn(0.75),
      weights: [{ name: "hold", wgsl: "bitcast<f32>(0x3f7fffffu)", at: () => LAST_BELOW_ONE }],
      maps: { anchorLast: "hold" },
      rope: stepping(),
    };
    const read = await onRope(fixture, async (rope) => {
      await frames(rope, 64 * 2);
      return rope.read();
    });
    for (let strand = 0; strand < 2; strand += 1) {
      expect(pointOf(read.position, strand * POINTS + LINKS), `strand ${strand}`).toEqual([0.75, 0, strand]);
      expect(pointOf(read.velocity, strand * POINTS + LINKS), `strand ${strand}`).toEqual([0, 0, 0]);
    }
  }, 180_000);
});

describe("rope: what a weight between 0 and 1 is (T1585b slice 2, D19 and D20)", () => {
  /*
   * THE FIRST CONSUMER'S NUMBERS. 55 points 60 mm apart, gravity 9.81, hung from a first
   * point at a fractional weight under Hard, Anchor Strength 2 Hz. The pull is a spring
   * sized for the STRAND's mass, so the strand rests g ÷ ((2π·strength)²·gain) below its
   * target whatever its length: 62 mm at weight 0.5, 145 mm at 0.3. Sized for one point's
   * mass it would hang 3.4 m and 8.0 m low — seen red at exactly those.
   *
   * The bound is the solver's exit tolerance carried through the spring (a top segment τ
   * off its length is a tension off by τ·m ÷ 2h²), as in the reference's own test.
   */
  it.each([
    [0.5, 0.06212],
    [0.3, 0.14495],
  ])("the consumer's 55 points at weight %f rest %f m below the target", async (weight, metres) => {
    const cols = 55;
    const pitch = 0.06;
    const fixture: RopeFixture = { cols, pose: hanging(pitch), rope: { updateRate: 256, damping: 4, anchorFirst: weight } };
    await onRope(fixture, async (rope) => {
      await frames(rope, 64 * 20);
      const read = await rope.read();
      const omegaSquared = (2 * Math.PI * ROPE_DEFAULTS.anchorStrength) ** 2;
      const gain = weight / (1 - weight);
      const closed = ROPE_DEFAULTS.gravity / (omegaSquared * gain);
      expect(closed).toBeCloseTo(metres, 5);
      const h = ROPE_FRAME / 4;
      const bound = (ROPE_TOLERANCE * pitch + ROPE_TOLERANCE_FLOOR) / (2 * h * h * omegaSquared * gain * cols) + 2 ** -21;
      expect(Math.abs(-component(read.position, 0, 1) - closed)).toBeLessThanOrEqual(bound);
      expect(bound).toBeLessThan(closed / 500);
    });
  }, 180_000);

  it("Hard at a weight of 0.5 is Soft at 1, byte for byte; and neither is the target", async () => {
    const play = async (rope: Readonly<Record<string, unknown>>): Promise<RopeRead> =>
      onRope({ cols: POINTS, pose: hanging(REST), rope: stepping(rope) }, async (session) => {
        session.render();
        session.shift([0.25, 0.125, 0]);
        await frames(session, 24);
        return session.read();
      });
    const hard = await play({ anchorFirst: 0.5, anchorMode: "hard" });
    const soft = await play({ anchorFirst: 1, anchorMode: "soft" });
    // Seen red with the mode unread: Soft at 1 is then Hard at 1, a pin.
    expect(same(soft.bytes, hard.bytes)).toBe(true);
    // On its way to the target and not on it: a pull, not a pin.
    expect(Math.hypot(component(hard.position, 0, 0) - 0.25, component(hard.position, 0, 1) - 0.125)).toBeGreaterThan(0.01);
    // The control: Hard at 1 is the target to the bit, and is another strand.
    const pinned = await play({ anchorFirst: 1, anchorMode: "hard" });
    expect(pointOf(pinned.position, 0)).toEqual([0.25, 0.125, 0]);
    expect(same(pinned.bytes, hard.bytes)).toBe(false);
  }, 180_000);
});

describe("rope: a lap with both ends held (T1585b slice 2, the design's 4.7)", () => {
  /*
   * The slice-1 lap with the far end pinned too: a taut strand of 54 segments carried along
   * +Z at 8 m/s by BOTH its ends through a wrap of −960 m, Teleport Distance 100, Carry.
   * Every anchor's history goes with the strand, so the far pin is not dragged across the
   * jump. The two pins are their targets to the bit on every frame; the points between are
   * held to the stored position's own spacing at 960 m, 2⁻¹⁴ m (two anchors soften the
   * pivots, so a step solves to the tolerance and not to the last place).
   */
  it("Teleport Distance 100 with Carry takes a strand held at both ends through a 960 m wrap as if there were none", async () => {
    const cols = 55;
    const pitch = 2 ** -4;
    const perFrame = 2 ** -3;
    const lap = 960;
    const towed = (more: Readonly<Record<string, unknown>>): RopeFixture => ({
      cols,
      pose: { wgsl: `vec3f(0.0, 0.0, -f32(i) * ${String(pitch)})`, at: (i) => [0, 0, -i * pitch] },
      rope: { updateRate: 512, gravity: 0, damping: 0, anchorLast: 1, ...more },
    });
    const spacing = 2 ** -14;
    await onRope(towed({ teleportDistance: 100, teleportMode: "carry" }), async (rope) => {
      let crossed = false;
      for (let frame = 0; frame < 40; frame += 1) {
        const travelled = lap - 2 + perFrame * frame;
        const socket = travelled >= lap ? travelled - lap : travelled;
        crossed = crossed || travelled >= lap;
        rope.shift([0, 0, socket]);
        rope.render();
        if (frame === 0) continue;
        const read = await rope.read();
        expect(component(read.position, 0, 2), `frame ${frame}`).toBe(socket);
        expect(component(read.position, cols - 1, 2), `frame ${frame}`).toBe(socket - (cols - 1) * pitch);
        expect(component(read.velocity, cols - 1, 2), `frame ${frame}`).toBe(perFrame * 64);
        for (let point = 1; point < cols - 1; point += 1) {
          // Seen red on the frame of the wrap with the far anchor's history left behind: the far
          // pin then crosses the 960 m in that one frame, at 3,482 m/s by its own velocity.
          expect(Math.abs(component(read.position, point, 2) - (socket - point * pitch)), `frame ${frame}, point ${point}`).toBeLessThanOrEqual(spacing);
          if (frame > 1) expect(Math.abs(component(read.velocity, point, 2) - perFrame * 64), `frame ${frame}, point ${point}`).toBeLessThanOrEqual(spacing * 512);
        }
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
      expect(Math.abs(component((await rope.read()).velocity, 27, 2))).toBeGreaterThan(1000);
    });
  }, 180_000);
});

/*
 * A STRAND SEEDED SHORT BETWEEN TWO PINS (the design's 15.3). Asked to be half as long again
 * as the straight line it is seeded on, a strand between two pins has slack and no shape
 * for it. The node builds none: the seed is still the incoming points, and the solve pays
 * the slack out under what acts on it. So nothing here has a HAND: turn the chord to its
 * mirror image across the vertical and the strand is the mirror image.
 *
 * 128 strands, one a direction of a whole turn of the chord in the XY plane (a walk round a
 * diamond, so the directions are floats and each has its exact mirror image), four of them
 * on an axis. A chord straight up or down has no low side: nothing acts across it, and the
 * strand stays on its chord's line, on neither side.
 *
 * (That the settled shape then varies no faster than the far pin moves is asserted on the
 * reference, on chords at least 11° from vertical: `points/rope.test.ts`. It is not true
 * closer in. A few degrees from vertical the slack is a narrow loop that swings to the other
 * side faster than the chord turns — measured on these 128 directions, settled: 60 mm
 * between the chords 3.8° and 1.8° from vertical, whose far pins are 22 mm apart — and the
 * chord exactly on the vertical, which stays straight, is 248 mm from its neighbour.)
 */
describe("rope: a strand seeded short between two pins has no hand (T1585b slice 2, the design's 15.3)", () => {
  const side = SWEEP_DIRECTIONS / 4;
  const k = `(f32(j % ${side}u) / ${side}.0)`;
  const q = `((j / ${side}u) % 4u)`;
  const along = `select(select(select(vec2f(${k}, ${k} - 1.0), vec2f(${k} - 1.0, -${k}), ${q} == 2u), vec2f(-${k}, 1.0 - ${k}), ${q} == 1u), vec2f(1.0 - ${k}, ${k}), ${q} == 0u)`;
  const alongAt = (j: number): readonly [number, number] => {
    const step = (j % side) / side;
    return ([[1 - step, step], [-step, 1 - step], [step - 1, -step], [step, step - 1]] as const)[Math.floor(j / side) % 4] as readonly [number, number];
  };
  /** Half a metre of chord on an axis; every strand at the origin, so its mirror image is its own x negated. */
  const chords: RopePose = {
    wgsl: `vec3f(${along}, 0.0) * (f32(i) / 32.0)`,
    at: (i, j) => [(alongAt(j)[0] * i) / 32, (alongAt(j)[1] * i) / 32, 0],
  };
  const fixture: RopeFixture = { cols: POINTS, rows: SWEEP_DIRECTIONS, pose: chords, rope: stepping({ anchorLast: 1, restLengthScale: 1.5 }) };
  const mirrorOf = (strand: number): number => (SWEEP_DIRECTIONS / 2 - strand + SWEEP_DIRECTIONS) % SWEEP_DIRECTIONS;

  it("the seed is the incoming chord in every direction; a chord and its mirror image stay mirror images; straight up it is on neither side", async () => {
    await onRope(fixture, async (rope) => {
      let rendered = 0;
      const to = async (frame: number): Promise<RopeRead> => {
        for (; rendered <= frame; rendered += 1) rope.render();
        return rope.read();
      };
      const seed = await to(0);
      expect(Array.from(seed.position)).toEqual(Array.from(seed.incoming));
      for (const frame of [1, 16, 64 * 6]) {
        const read = await to(frame);
        let unlike = 0;
        for (let strand = 0; strand < SWEEP_DIRECTIONS; strand += 1) {
          const mirror = mirrorOf(strand);
          for (let point = 0; point < POINTS; point += 1) {
            const here = pointOf(read.position, strand * POINTS + point);
            const there = pointOf(read.position, mirror * POINTS + point);
            unlike = Math.max(unlike, Math.abs((here[0] as number) + (there[0] as number)), Math.abs((here[1] as number) - (there[1] as number)));
          }
        }
        // Seen red with a seed that bows every strand's slack toward +X: the seed is then not
        // the incoming chord (the assertion above), and a chord and its mirror image lie on
        // one side.
        expect(unlike, `frame ${frame}`).toBe(0);
        // Straight up and straight down: on the chord's own line.
        for (const strand of [SWEEP_DIRECTIONS / 4, (3 * SWEEP_DIRECTIONS) / 4]) {
          for (let point = 0; point < POINTS; point += 1) {
            expect(Math.abs(component(read.position, strand * POINTS + point, 0)), `frame ${frame}, strand ${strand}`).toBe(0);
            expect(Math.abs(component(read.position, strand * POINTS + point, 2)), `frame ${frame}, strand ${strand}`).toBe(0);
          }
        }
      }
      const settled = await to(64 * 6);
      // The slack did go somewhere: a strand lying level hangs well below its pins.
      expect(component(settled.position, 8, 1)).toBeLessThan(-0.2);
    });
  }, 240_000);
});

describe("rope: a grid of several sheets is rows × sheets strands (T1587b's claim, T1585b slice 2)", () => {
  /*
   * Two sheets of two rows of seventeen points: four strands, and the claim on the edge is
   * `grid:17x2x2`. Let fall from rest with nothing holding them, every point of every
   * strand is lower by g·h²·k(k+1)/2 after k steps — so a strand the walk never reached
   * (rows read without the sheets) would still be where it was seeded.
   */
  it("every strand of every sheet is simulated, and the claim passes through", async () => {
    const fixture: RopeFixture = {
      cols: POINTS,
      rows: 4,
      sheets: 2,
      pose: hanging(2 ** -10),
      rope: { updateRate: 512, gravity: GRAVITY, damping: 0, anchorFirst: 0 },
    };
    await onRope(fixture, async (rope) => {
      const out = rope.plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === "rope_strand");
      expect((out as { uniforms?: Record<string, number> } | undefined)?.uniforms).toMatchObject({ cols: POINTS, rows: 4 });
      await frames(rope, 9);
      const read = await rope.read();
      // 64 steps of 1/512 s: 2,080·2⁻¹⁵ m.
      for (let strand = 0; strand < 4; strand += 1) {
        for (let point = 0; point < POINTS; point += 1) {
          expect(component(read.position, strand * POINTS + point, 1), `strand ${strand}, point ${point}`).toBe((point === 0 ? 0 : -point * 2 ** -10) - 0.0634765625);
          expect(component(read.velocity, strand * POINTS + point, 1), `strand ${strand}, point ${point}`).toBe(-1);
        }
      }
    });
  }, 120_000);
});
