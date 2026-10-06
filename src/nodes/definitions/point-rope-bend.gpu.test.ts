import { describe, expect, it } from "vitest";

import { ROPE_BEND_FLOOR, ROPE_BEND_SOFTENING, ROPE_BEND_TOLERANCE, ROPE_TOLERANCE, ROPE_TOLERANCE_FLOOR } from "../../points/rope.ts";
import { ROPE_FRAME, component, onRope, ropeTwin, segmentLength, type RopeFixture, type RopePose, type RopeRead, type RopeSession } from "./rope-test-support.ts";

/**
 * T1585b SLICE 4 — THE BEND LIMIT'S SOLVE on a real device (§V147), held to a closed form and
 * to the CPU reference (`src/points/rope.ts`, whose own closed forms are
 * `points/rope.test.ts`): the banded system, its compliant rows (the design's D30), and the
 * step that is solved again without the limit when its lengths cannot be kept.
 *
 * What the limit does to a strand in motion, frame by frame, is
 * `tests/headless/rope-bend.gpu.test.ts`. Every test names what it was seen red against.
 */

const LINKS = 16;
const POINTS = LINKS + 1;
const REST = 1 / 16;
const GRAVITY = 8;
/** Four steps of 1/256 s on the fixture's 1/64 s frame. */
const H = ROPE_FRAME / 4;

const stepping = (more: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  updateRate: 256,
  gravity: GRAVITY,
  iterations: 8,
  segmentLength: REST,
  bendLimit: true,
  ...more,
});
async function frames(rope: RopeSession, count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) rope.render();
  await Promise.resolve();
}
const pointOf = (region: Float32Array, point: number): number[] => [component(region, point, 0), component(region, point, 1), component(region, point, 2)];
/** The angle the strand turns through at point j, radians. */
const turnAt = (position: Float32Array, j: number): number => {
  const [low, here, high] = [pointOf(position, j - 1), pointOf(position, j), pointOf(position, j + 1)];
  const a = [0, 1, 2].map((c) => (here[c] as number) - (low[c] as number)) as [number, number, number];
  const b = [0, 1, 2].map((c) => (high[c] as number) - (here[c] as number)) as [number, number, number];
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return Math.atan2(cross, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};
const level: RopePose = { wgsl: `vec3f(f32(i) * ${REST}, 0.0, f32(j))`, at: (i, j) => [i * REST, 0, j] };

describe("rope: the bend limit in closed form — a strand held out level by its first two points (T1585b slice 4)", () => {
  /*
   * A BEAM (`points/rope.test.ts` has the derivation). The first two points are held a
   * segment apart along +X and the other fifteen are left to gravity. With a radius of 2 m
   * every joint may turn 2·asin(1/64); the strand curls down along that circle, every joint
   * at its limit. At rest the SHAPE says what each joint carries — the weights beyond it,
   * times how far out they hang — and a compliant row gives by that times its compliance:
   *
   *     turnⱼ = limit + 2⁻¹⁰ · (1, 5 or 6) ÷ b² · g·h² · Σ (xᵢ − xⱼ)
   */
  const RADIUS = 2;
  const limit = 2 * Math.asin((2 * REST) / (4 * RADIUS));
  const tolerance = limit * ROPE_BEND_TOLERANCE + ROPE_BEND_FLOOR * (2 / REST);
  const giveAt = (position: Float32Array, j: number): number => {
    let moment = 0;
    for (let i = j + 1; i < POINTS; i += 1) moment += GRAVITY * H * H * (component(position, i, 0) - component(position, j, 0));
    return ((ROPE_BEND_SOFTENING * (j === 1 ? 1 : j === 2 ? 5 : 6)) / (REST * REST)) * moment;
  };
  const fixture: RopeFixture = { cols: POINTS, pose: level, rope: stepping({ damping: 8, anchorSecond: 1, minBendRadius: RADIUS }) };

  it("every joint rests at its limit plus what its compliance gives for the weight beyond it, and the device is the reference", async () => {
    await onRope(fixture, async (rope) => {
      const twin = ropeTwin(fixture);
      for (let frame = 0; frame < 64 * 10; frame += 1) {
        rope.render();
        twin.render();
      }
      const read = await rope.read();
      for (let j = 1; j < LINKS; j += 1) {
        // Seen red at 4.5e-5 rad on joint 2, more than two tolerances, with the row's compliance
        // left off its right-hand side.
        expect(Math.abs(turnAt(read.position, j) - (limit + giveAt(read.position, j))), `joint ${j}`).toBeLessThanOrEqual(tolerance);
      }
      // The give is in the answer: at the second joint it is tens of tolerances.
      expect(giveAt(read.position, 2)).toBeGreaterThan(20 * tolerance);
      expect(pointOf(read.position, 0)).toEqual([0, 0, 0]);
      expect(pointOf(read.position, 1)).toEqual([REST, 0, 0]);
      for (let k = 1; k < LINKS; k += 1) expect(Math.abs(segmentLength(read.position, k) - REST), `segment ${k}`).toBeLessThanOrEqual(ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR + 2 ** -22);
      expect(Math.max(...Array.from(read.velocity, Math.abs))).toBeLessThan(1e-3);
      // Four digits of the strand's one metre, as for the strands with no limit.
      let apart = 0;
      for (let word = 0; word < read.position.length; word += 1) apart = Math.max(apart, Math.abs((read.position[word] as number) - (twin.state.position[word] as number)));
      expect(apart).toBeLessThan(1e-4);
    });
  }, 180_000);

  it("the control: with Bend Limit off the same strand hangs straight down from its second point", async () => {
    const free: RopeFixture = { ...fixture, rope: stepping({ damping: 8, anchorSecond: 1, bendLimit: false }) };
    const read = await onRope(free, async (rope): Promise<RopeRead> => {
      await frames(rope, 64 * 10);
      return rope.read();
    });
    expect(Math.abs(turnAt(read.position, 1) - Math.PI / 2)).toBeLessThan(0.001);
  }, 180_000);
});

describe("rope: where the limit and the pins cannot both be had, length comes before bend (T1585b slice 4, the design's D36)", () => {
  /*
   * A strand whose first two points are held facing +X and whose last is held straight
   * BEHIND them, at the end of nearly all its rope: taut, folded back on itself at the
   * second point, where the limit allows 24°. Nothing can meet the limit, and its rows push
   * the strand against its own pins. A step that ends with a segment beyond Max Stretch is
   * solved again from where its points were placed, with no joint in the system: the pins
   * hold, every segment keeps its length, the bend gives, and the strand comes to rest.
   */
  const folded: RopePose = {
    wgsl: `select(vec3f(f32(i) * ${REST}, 0.0, f32(j)), vec3f(${REST - 14.5 * REST}, 0.0, f32(j)), i == ${LINKS}u && t > 0.0)`,
    at: (i, j, t) => (i === LINKS && t > 0 ? [REST - 14.5 * REST, 0, j] : [i * REST, 0, j]),
  };

  it("taut and folded back at the second point: the pins hold, every segment keeps its length, the bend gives, and the strand is at rest", async () => {
    const fixture: RopeFixture = { cols: POINTS, pose: folded, rope: stepping({ damping: 2, anchorSecond: 1, anchorLast: 1, minBendRadius: 0.15 }) };
    const read = await onRope(fixture, async (rope): Promise<RopeRead> => {
      await frames(rope, 64 * 8);
      return rope.read();
    });
    for (const value of read.position) expect(Number.isFinite(value)).toBe(true);
    for (const point of [0, 1, LINKS]) expect(pointOf(read.position, point), `point ${point}`).toEqual(pointOf(read.incoming, point));
    // Seen red at 2 % on segment 1, where the guard leaves it, with a step that cannot keep its
    // lengths left to the limit's rows and the guard. (On the reference, before this rule:
    // 7.7 % on the last segment and the strand at 74 m/s.)
    for (let k = 1; k < LINKS; k += 1) expect(Math.abs(segmentLength(read.position, k) - REST), `segment ${k}`).toBeLessThanOrEqual(ROPE_TOLERANCE * REST + ROPE_TOLERANCE_FLOOR + 2 ** -22);
    expect(turnAt(read.position, 1)).toBeGreaterThan(1);
    expect(Math.max(...Array.from(read.velocity, Math.abs))).toBeLessThan(0.01);
  }, 180_000);
});
