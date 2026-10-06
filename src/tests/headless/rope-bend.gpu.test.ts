import { describe, expect, it } from "vitest";

import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { ANCHOR, ROPE, component, incomingOf, ropeGraph, ropeRegionOf, segmentLength, type RopeFixture } from "../../nodes/definitions/rope-test-support.ts";
import { ROPE_TOLERANCE, ROPE_TOLERANCE_FLOOR } from "../../points/rope.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1585b SLICE 4 — THE ROPE'S BEND LIMIT, AND WHAT A HELD POINT IS, frame by frame through
 * the whole stack on a real device: a document whose upstream kernel moves the targets from
 * the frame's own time, the compiler, the frame driver and the offline transport. Nothing is
 * pushed from the test; every assertion is on what each frame left, read with the harness's
 * per-frame probe (`probeFrames`).
 *
 * WHAT IS EXACT HERE AND WHAT IS MEASURED. A held point is stored as its incoming point, so
 * "it IS the incoming point" is `toBe`, on every frame. A segment's length is held to the
 * solver's own exit tolerance. A joint's TURN is not a closed form on these strands (it is
 * one in `points/rope.test.ts`, a strand held out level, which the reference is held to and
 * the device to the reference in `nodes/definitions/point-rope-bend.gpu.test.ts`). Here the
 * limit is held to CEILINGS, each beside the figure measured when it was written and beside
 * the same strand with no limit, which is several times past it: the limit is compliant (the
 * design's D30) and is exceeded in fast motion by an amount the node's description states.
 *
 * Every strand is seeded in a pose the rope could lie in. A pose handed in folded far past
 * the limit can open into a loop with a full turn in it (the design's D33).
 */

interface Probed {
  readonly frame: number;
  readonly incoming: Float32Array;
  readonly position: Float32Array;
  readonly velocity: Float32Array;
}

async function play(fixture: RopeFixture, run: { readonly frames: number; readonly from: number; readonly every?: number }): Promise<Probed[]> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const rope = pointStorageId(ROPE);
  const anchor = pointStorageId(ANCHOR);
  const probeFrames: number[] = [];
  for (let frame = run.from; frame < run.frames; frame += run.every ?? 1) probeFrames.push(frame);
  const result = await renderHeadless({ host: nodeGpuHost(), graph: ropeGraph(fixture), fps: 60, frames: run.frames, outputNodeId: "output_probe", probeBuffers: [rope, anchor], probeFrames });
  const problems = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
  if (problems.length > 0) throw new Error(problems.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
  return (result.bufferFrames ?? []).map((entry) => ({
    frame: entry.frameIndex,
    incoming: incomingOf(entry.buffers[anchor] as ArrayBuffer, fixture),
    position: ropeRegionOf(entry.buffers[rope] as ArrayBuffer, fixture, "position"),
    velocity: ropeRegionOf(entry.buffers[rope] as ArrayBuffer, fixture, "velocity"),
  }));
}

const pointOf = (region: Float32Array, point: number): number[] => [component(region, point, 0), component(region, point, 1), component(region, point, 2)];
const between = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number), (a[2] as number) - (b[2] as number));
/** The angle the strand turns through at point j, radians: 0 along a straight run. */
const turnAt = (position: Float32Array, j: number): number => {
  const [low, here, high] = [pointOf(position, j - 1), pointOf(position, j), pointOf(position, j + 1)];
  const a = [0, 1, 2].map((c) => (here[c] as number) - (low[c] as number)) as [number, number, number];
  const b = [0, 1, 2].map((c) => (high[c] as number) - (here[c] as number)) as [number, number, number];
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return Math.atan2(cross, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};
/** Over the frames read: the largest turn at each joint, and the worst of them. */
const turnsOf = (frames: ReadonlyArray<Probed>, cols: number): { byJoint: number[]; worst: number } => {
  const byJoint = new Array<number>(cols).fill(0);
  for (const frame of frames) for (let j = 1; j < cols - 1; j += 1) byJoint[j] = Math.max(byJoint[j] as number, turnAt(frame.position, j));
  return { byJoint, worst: Math.max(...byJoint) };
};
/** Over the frames read: how far the longest or shortest segment is from `pitch`, metres. */
const stretchOf = (frames: ReadonlyArray<Probed>, cols: number, pitch: number, from = 0): number => {
  let worst = 0;
  for (const frame of frames) for (let k = from; k < cols - 1; k += 1) worst = Math.max(worst, Math.abs(segmentLength(frame.position, k) - pitch));
  return worst;
};
/** The furthest any point moved between two frames that follow each other. */
const movedOf = (frames: ReadonlyArray<Probed>, cols: number): number => {
  let worst = 0;
  for (let index = 1; index < frames.length; index += 1) {
    for (let point = 0; point < cols; point += 1) worst = Math.max(worst, between(pointOf((frames[index] as Probed).position, point), pointOf((frames[index - 1] as Probed).position, point)));
  }
  return worst;
};

const RADIUS = 0.15;
const DEGREES = 180 / Math.PI;
/** `ROPE_REPORT=1` prints what each case measured: the figures the design doc's section 17 quotes. */
const note = process.env["ROPE_REPORT"] === "1" ? (text: string): void => console.log(text) : (): void => undefined;

describe("rope: the first consumer's loop against the bend limit (T1585b slice 4, the acceptance)", () => {
  /*
   * 54 segments of 0.06 m, 3.24 m of rope, both ends held: a joint may turn
   * 2·asin(0.06 ÷ 0.3) = 23.07°. The strand is seeded hanging straight from its first point;
   * its far end is carried up over six seconds to a pin `centre` metres from the first, and
   * from `sweep.from` seconds that pin is swept at 2 Hz, `sweep.peak` m/s at its fastest.
   */
  const LENGTH = 3.24;
  const ARRIVE = 6;
  const loop = (links: number, rope: Readonly<Record<string, unknown>>, centre = 0.5, sweep?: { readonly peak: number; readonly from: number }, arrive = ARRIVE): RopeFixture => {
    const pitch = LENGTH / links;
    const along = `clamp(t / ${arrive}.0, 0.0, 1.0)`;
    const way = `(pow(${along}, 3.0) * (${along} * (${along} * 6.0 - 15.0) + 10.0))`;
    const swing = sweep === undefined ? "0.0" : `select(0.0, ${sweep.peak / (2 * Math.PI * 2)} * sin(${2 * Math.PI * 2} * (t - ${sweep.from}.0)), t > ${sweep.from}.0)`;
    return {
      cols: links + 1,
      pose: {
        wgsl: `select(vec3f(0.0, -f32(i) * ${pitch}, 0.0), vec3f(${centre} * ${way} + ${swing}, -${LENGTH} * (1.0 - ${way}) + 0.3 * ${swing}, 0.0), i == ${links}u && t > 0.0)`,
        at: () => [0, 0, 0],
      },
      rope: { anchorLast: 1, segmentLength: pitch, minBendRadius: RADIUS, ...rope },
    };
  };
  const LINKS = 54;
  const PITCH = LENGTH / LINKS;
  const LIMIT = 2 * Math.asin(PITCH / (2 * RADIUS));
  /** What a segment's length may be off by, read back: the solver's exit tolerance and the stored positions' spacing below 4 m, on each end. */
  const TOLERANCE = ROPE_TOLERANCE * PITCH + ROPE_TOLERANCE_FLOOR + 2 * 2 ** -22;

  it("at rest, at Update Rate 240: no joint past its limit, the ends their incoming points, every segment its length; with no limit the lowest joints turn twice as far", async () => {
    // Carried over 6 s, left 40 s to come to rest, then two seconds read frame by frame.
    const run = { frames: 60 * 48, from: 60 * 46 };
    const limited = await play(loop(LINKS, { updateRate: 240, bendLimit: true }), run);
    expect(limited).toHaveLength(120);
    const turns = turnsOf(limited, LINKS + 1);
    note(`rest, Update Rate 240: largest turn ${(turns.worst / LIMIT).toFixed(4)} of the limit; ${turns.byJoint.filter((turn) => turn > 0.99 * LIMIT).length} joints at it; worst segment ${((stretchOf(limited, LINKS + 1, PITCH) / PITCH) * 100).toFixed(4)} %; largest move in a frame ${(movedOf(limited, LINKS + 1) * 1e6).toFixed(2)} µm`);
    // Measured 1.0001 of the limit. Seen red at 2.19 with the joints' rows out of the system.
    expect(turns.worst / LIMIT).toBeLessThanOrEqual(1.0005);
    // …and AT its limit, not short of it: the loop is as tight as it is let be, on five joints.
    expect(turns.byJoint.filter((turn) => turn > 0.99 * LIMIT).length).toBeGreaterThanOrEqual(4);
    for (const frame of limited) {
      expect(pointOf(frame.position, 0), `frame ${frame.frame}`).toEqual(pointOf(frame.incoming, 0));
      expect(pointOf(frame.position, LINKS), `frame ${frame.frame}`).toEqual(pointOf(frame.incoming, LINKS));
    }
    expect(stretchOf(limited, LINKS + 1, PITCH)).toBeLessThanOrEqual(TOLERANCE);

    const free = await play(loop(LINKS, { updateRate: 240 }), run);
    note(`rest, no limit: largest turn ${(turnsOf(free, LINKS + 1).worst / LIMIT).toFixed(4)} of the limit; largest move in a frame ${(movedOf(free, LINKS + 1) * 1e6).toFixed(2)} µm`);
    expect(turnsOf(free, LINKS + 1).worst / LIMIT).toBeGreaterThan(2);
    /*
     * THE LIMIT'S ROWS COME AND GO, AND A RESTING BEND MUST NOT SHOW IT. Held to the same
     * loop with no limit, whose own stillness is what single precision leaves of a step:
     * measured 3.5 µm a frame with the limit against 4.5 without.
     */
    expect(movedOf(free, LINKS + 1)).toBeGreaterThan(0);
    expect(movedOf(limited, LINKS + 1)).toBeLessThanOrEqual(2 * movedOf(free, LINKS + 1));
  }, 600_000);

  it("at rest at Update Rate 960 and at 120 it is the same loop: the limit does not depend on the step", async () => {
    const run = { frames: 60 * 48, from: 60 * 46 };
    // Measured 1.0000 of the limit at 960, 28 µm a frame against 38 with no limit; 1.0003 at 120.
    const fine = await play(loop(LINKS, { updateRate: 960, bendLimit: true }), run);
    expect(turnsOf(fine, LINKS + 1).worst / LIMIT).toBeLessThanOrEqual(1.0005);
    expect(stretchOf(fine, LINKS + 1, PITCH)).toBeLessThanOrEqual(TOLERANCE);
    const coarse = await play(loop(LINKS, { updateRate: 120, bendLimit: true }), run);
    note(`rest, Update Rate 960: ${(turnsOf(fine, LINKS + 1).worst / LIMIT).toFixed(4)} of the limit, ${(movedOf(fine, LINKS + 1) * 1e6).toFixed(2)} µm a frame; Update Rate 120: ${(turnsOf(coarse, LINKS + 1).worst / LIMIT).toFixed(4)}, ${(movedOf(coarse, LINKS + 1) * 1e6).toFixed(2)} µm`);
    expect(turnsOf(coarse, LINKS + 1).worst / LIMIT).toBeLessThanOrEqual(1.001);
    // The same loop: its lowest point within a millimetre at both rates.
    const lowest = (frames: ReadonlyArray<Probed>): number => Math.min(...Array.from({ length: LINKS + 1 }, (_unused, point) => component((frames[frames.length - 1] as Probed).position, point, 1)));
    expect(Math.abs(lowest(fine) - lowest(coarse))).toBeLessThan(0.001);
  }, 600_000);

  /*
   * IN MOTION THE LIMIT IS EXCEEDED, BY THIS MUCH. The far pin stands 0.9 m from the first and
   * is swept at 2 Hz. The limit's rows are compliant, a step is finite, and at 8 m/s the pin
   * crosses half a segment in a step of 1/240 s. With no limit the same sweep folds the
   * strand to 7.8 times the limit in every frame.
   *
   * THE CEILINGS SIT ABOVE A RANGE, NOT AT A FIGURE. A whipped rope is chaotic, and the worst
   * joint of four seconds moves with the last place of the arithmetic: this build measures
   * 1.011, 1.001, 1.241 and 1.024 of the limit, and the build before its last change (the
   * same solve, written another way) 1.146, 1.004, 1.155 and 1.150. The node's description
   * gives the same ranges.
   */
  it.each([
    [4, 240, 1.25],
    [4, 960, 1.02],
    [8, 240, 1.5],
    [8, 960, 1.25],
  ] as const)("swept at %i m/s at Update Rate %i no joint is past %f of its limit, and no segment is at the guard", async (peak, updateRate, ceiling) => {
    const frames = await play(loop(LINKS, { updateRate, bendLimit: true }, 0.9, { peak, from: 12 }), { frames: 60 * 16, from: 60 * 12 });
    expect(frames).toHaveLength(240);
    const over = (by: number): number => frames.filter((frame) => turnsOf([frame], LINKS + 1).worst > LIMIT * by).length / frames.length;
    note(`swept ${peak} m/s, Update Rate ${updateRate}: largest turn ${(turnsOf(frames, LINKS + 1).worst / LIMIT).toFixed(3)} of the limit; frames over by 1 %: ${(over(1.01) * 100).toFixed(0)} %, by 5 %: ${(over(1.05) * 100).toFixed(0)} %; worst segment ${((stretchOf(frames, LINKS + 1, PITCH) / PITCH) * 100).toFixed(3)} %`);
    expect(turnsOf(frames, LINKS + 1).worst / LIMIT).toBeLessThanOrEqual(ceiling);
    // Never thrown: Max Stretch is 2 %, and no segment came near it (measured 0.2 % at the worst, at 8 m/s and 240).
    expect(stretchOf(frames, LINKS + 1, PITCH)).toBeLessThan(0.005 * PITCH);
    // The pin did sweep: its fastest frame is the peak.
    let fastest = 0;
    for (let index = 1; index < frames.length; index += 1) fastest = Math.max(fastest, between(pointOf((frames[index] as Probed).position, LINKS), pointOf((frames[index - 1] as Probed).position, LINKS)) * 60);
    expect(fastest).toBeGreaterThan(0.9 * peak);
  }, 600_000);

  it("the control: the same sweep with no limit folds the strand to several times the limit", async () => {
    const frames = await play(loop(LINKS, { updateRate: 240 }, 0.9, { peak: 4, from: 12 }), { frames: 60 * 16, from: 60 * 12 });
    expect(turnsOf(frames, LINKS + 1).worst / LIMIT).toBeGreaterThan(5);
  }, 300_000);

  /*
   * A THOUSAND POINTS. The same 3.24 m cut into 1,023 segments: a joint may turn 1.21°, and
   * one last place of a stored position is a tenth of that, so the bend is read as a RADIUS
   * over 32 joints. The limit's compliance is a share of each row's own diagonal, and what a
   * resting bend gives grows with the fourth power of the point count: at Update Rate 960
   * this loop's tightest radius is 0.118 m where it is asked for 0.15 (measured), against
   * 0.069 m with no limit. Stated in the description. At Update Rate 240 a strand this fine is
   * past its own step limit with or without the bend limit.
   */
  it("a 1,024-point strand at Update Rate 960: the loop's tightest radius is four fifths of what is asked, and far from the loop with no limit", async () => {
    const links = 1023;
    const pitch = LENGTH / links;
    const tightest = (frames: ReadonlyArray<Probed>): number => {
      const last = (frames[frames.length - 1] as Probed).position;
      let radius = Infinity;
      const span = 16;
      for (let j = span; j < links - span; j += 1) {
        const [a, b, c] = [pointOf(last, j - span), pointOf(last, j), pointOf(last, j + span)];
        const area = Math.abs(((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) - ((b[1] as number) - (a[1] as number)) * ((c[0] as number) - (a[0] as number))) / 2;
        if (area > 1e-12) radius = Math.min(radius, (between(a, b) * between(b, c) * between(c, a)) / (4 * area));
      }
      return radius;
    };
    // Carried over 3 s and left 2 s under a heavy damping: a step of this strand is a thousand points long, sixteen times a frame.
    const run = { frames: 60 * 5 + 1, from: 60 * 5 };
    const limited = await play(loop(links, { updateRate: 960, damping: 4, bendLimit: true }, 0.5, undefined, 3), run);
    const joints = turnsOf(limited, links + 1);
    note(`1,024 points, Update Rate 960: tightest radius over 32 joints ${tightest(limited).toFixed(4)} m; largest turn at one joint ${(joints.worst / (2 * Math.asin(pitch / (2 * RADIUS)))).toFixed(3)} of the limit; worst segment ${((stretchOf(limited, links + 1, pitch) / pitch) * 100).toFixed(4)} %`);
    expect(tightest(limited)).toBeGreaterThan(0.11);
    expect(tightest(limited)).toBeLessThanOrEqual(RADIUS);
    // Every segment keeps its length: the exit tolerance and the stored positions' spacing.
    expect(stretchOf(limited, links + 1, pitch)).toBeLessThanOrEqual(ROPE_TOLERANCE * pitch + ROPE_TOLERANCE_FLOOR + 2 * 2 ** -22);
    const free = await play(loop(links, { updateRate: 960, damping: 4 }, 0.5, undefined, 3), run);
    note(`1,024 points, no limit: tightest radius ${tightest(free).toFixed(4)} m`);
    expect(tightest(free)).toBeLessThan(0.08);
  }, 900_000);
});

describe("rope: the first consumer's cases, against the limit (T1585b slice 4, sentinel-bot 697f33f7)", () => {
  /*
   * Fixtures of this file's own with the consumer's lengths and weights: 53 segments of
   * 0.06 m (3.18 m), Update Rate 240, Iterations 8, Damping 1.5. A joint may turn 23.07°.
   * Each case is read from the fourth second to the fourteenth, and reports the largest turn
   * at each joint INDEX: the limit has to hold at the joint beside Anchor Second too.
   */
  const COLS = 54;
  const LAST = COLS - 1;
  const PITCH = 0.06;
  const LIMIT = 2 * Math.asin(PITCH / (2 * RADIUS));
  const consumer = (more: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({ updateRate: 240, iterations: 8, damping: 1.5, segmentLength: PITCH, minBendRadius: RADIUS, ...more });
  const run = { frames: 60 * 14, from: 60 * 4 };
  /** What the limit is held to on these strands. Measured 1.00 of it at every joint, in every case. */
  const CEILING = 1.02;

  /*
   * CASE 1 — HELD AT BOTH ENDS WITH SLACK. Socket and the ring after it held (Anchor First
   * and Second at 1), the claw on a rung 2.2 m to the side that it stands on for 70 % of a
   * stride and crosses to the next, 2 m on, at 3.2 m/s; gravity 1.5. The claw's weight comes
   * up over a second and a half from an attribute. With no limit the strand folds at joint 1,
   * right after Anchor Second: 82° with the socket facing aft, 137° with it facing straight
   * away from the claw.
   *
   * ACROSS A HELD PAIR the joint's row is still in the system. Two of its three points
   * cannot move, so the row turns the third: the strand leaves the socket inside a cone
   * about the socket's own direction, and the turn it needs is spread over the joints after.
   */
  const BODY = 0.64;
  const STRIDE = 2;
  const reaching = (away: boolean, rope: Readonly<Record<string, unknown>>): RopeFixture => {
    const period = STRIDE / BODY;
    const laid = away ? `vec3f(-f32(i) * ${PITCH}, 0.0, ${BODY} * t)` : `vec3f(0.0, 0.0, ${BODY} * t - f32(i) * ${PITCH})`;
    return {
      cols: COLS,
      pose: {
        wgsl: `select(${laid}, vec3f(2.2, 0.0, 0.7 + (floor(t / ${period}) + smoothstep(0.7, 1.0, fract(t / ${period}))) * ${STRIDE}.0), i == ${LAST}u && t > 0.0)`,
        at: () => [0, 0, 0],
      },
      weights: [{ name: "hold", wgsl: "smoothstep(0.0, 1.5, t)", at: () => 1 }],
      maps: { anchorLast: "hold" },
      rope: consumer({ gravity: 1.5, anchorSecond: 1, ...rope }),
    };
  };

  it.each([
    ["aft", false, 3],
    ["straight away from the claw", true, 5],
  ] as const)("case 1, the socket facing %s: no joint turns past its limit, joint 1 beside Anchor Second among them; with no limit joint 1 folds", async (facing, away, folds) => {
    const limited = await play(reaching(away, { bendLimit: true }), run);
    const turns = turnsOf(limited, COLS);
    note(`case 1, socket ${facing}, limit on, largest turn by joint (°): ${turns.byJoint.slice(1, LAST).map((turn) => (turn * DEGREES).toFixed(1)).join(" ")}`);
    // Seen red at 3.54 of the limit on joint 1 (the socket facing aft) with the joints' rows out of the system.
    for (let j = 1; j < LAST; j += 1) expect((turns.byJoint[j] as number) / LIMIT, `joint ${j}`).toBeLessThanOrEqual(CEILING);
    // The held points are their incoming points on every frame, and the rope keeps its length.
    for (const frame of limited) for (const point of [0, 1, LAST]) expect(pointOf(frame.position, point), `frame ${frame.frame}, point ${point}`).toEqual(pointOf(frame.incoming, point));
    expect(stretchOf(limited, COLS, PITCH, 1)).toBeLessThanOrEqual(ROPE_TOLERANCE * PITCH + ROPE_TOLERANCE_FLOOR + 2 * 2 ** -19);
    // The turn the strand needs is still made: the joints after the socket are AT their limit.
    expect((turns.byJoint[1] as number) / LIMIT).toBeGreaterThan(0.99);
    expect((turns.byJoint[2] as number) / LIMIT).toBeGreaterThan(0.99);
    // The control.
    const free = turnsOf(await play(reaching(away, {}), run), COLS);
    note(`case 1, socket ${facing}, no limit, largest turn by joint (°): ${free.byJoint.slice(1, LAST).map((turn) => (turn * DEGREES).toFixed(1)).join(" ")}`);
    expect((free.byJoint[1] as number) / LIMIT).toBeGreaterThan(folds);
  }, 600_000);

  /*
   * CASE 2 — A PART ANCHOR LAST. A loose strand towed at 3.2 m/s, its last point drawn at a
   * weight of 0.3 or 0.1 toward a target that wanders beside the body. With no limit the pull
   * on that one point kinks the end. With the limit the last joints stand at their limit and
   * no further: the kink is the limit's to stop, and a station's pull does not need spreading
   * for that. (What spreading it would add is a DIRECTION at the end, which one point cannot
   * have: that is a Pin Attribute's, a weight and a target on each of the last points.)
   */
  const SPEED = 3.2;
  const towed = (weight: number, rope: Readonly<Record<string, unknown>>): RopeFixture => ({
    cols: COLS,
    pose: {
      wgsl: `select(vec3f(0.0, 0.0, ${SPEED} * t - f32(i) * ${PITCH}), vec3f(1.2 + 0.4 * sin(${2 * Math.PI * 0.7} * t), 0.3 * sin(${2 * Math.PI * 0.45} * t + 1.0), ${SPEED} * t - 1.6 + 0.5 * sin(${2 * Math.PI * 0.3} * t)), i == ${LAST}u)`,
      at: () => [0, 0, 0],
    },
    rope: consumer({ gravity: 0, anchorSecond: 1, anchorLast: weight, ...rope }),
  });

  it.each([0.3, 0.1])("case 2, Anchor Last at %f toward a wandering target: no joint past its limit, the last three among them; with no limit the strand folds", async (weight) => {
    const turns = turnsOf(await play(towed(weight, { bendLimit: true }), run), COLS);
    for (let j = 1; j < LAST; j += 1) expect((turns.byJoint[j] as number) / LIMIT, `joint ${j}`).toBeLessThanOrEqual(CEILING);
    const free = turnsOf(await play(towed(weight, {}), run), COLS);
    note(`case 2, Anchor Last ${weight}: limit on, worst ${(turns.worst * DEGREES).toFixed(1)}°, last three ${turns.byJoint.slice(LAST - 3, LAST).map((turn) => (turn * DEGREES).toFixed(1)).join(" ")}; no limit, worst ${(free.worst * DEGREES).toFixed(1)}°, last three ${free.byJoint.slice(LAST - 3, LAST).map((turn) => (turn * DEGREES).toFixed(1)).join(" ")}`);
    expect(free.worst / LIMIT).toBeGreaterThan(2);
    expect(Math.max(...free.byJoint.slice(LAST - 3, LAST)) / LIMIT).toBeGreaterThan(1.2);
  }, 600_000);

  /*
   * CASE 3 — THE LIMIT AND THE PINS CANNOT BOTH BE HAD. Every point is drawn by a Pin
   * Attribute at 0.95 toward a swaying curve 2.5 % SHORTER than the rope. With no limit the
   * rope buckles between its targets, 61° at a joint. With the limit it cannot buckle that
   * tightly and it cannot be shorter: the PINS give. A weight under 1 is a pull and not a
   * hold, so the rope lies further from its targets, at its own length, bent no tighter than
   * it is let. Everything stays finite.
   */
  const drawn = (rope: Readonly<Record<string, unknown>>): RopeFixture => {
    const s = `(f32(i) * ${PITCH * 0.975})`;
    return {
      cols: COLS,
      pose: {
        wgsl: `vec3f(2.0 * (1.0 - cos(${s} / 2.0)) + 0.15 * sin(${Math.PI} * t) * (${s} / 3.0), 0.0, ${SPEED} * t - 2.0 * sin(${s} / 2.0))`,
        at: () => [0, 0, 0],
      },
      weights: [{ name: "clip", wgsl: "0.95", at: () => 0.95 }],
      rope: consumer({ gravity: 0, pinAttribute: "clip", ...rope }),
    };
  };
  const furthest = (frames: ReadonlyArray<Probed>): number => {
    let worst = 0;
    for (const frame of frames) for (let point = 0; point < COLS; point += 1) worst = Math.max(worst, between(pointOf(frame.position, point), pointOf(frame.incoming, point)));
    return worst;
  };

  it("case 3, every point drawn to a curve shorter than the rope: the bend holds, the rope keeps its length, and the pins give", async () => {
    const limited = await play(drawn({ bendLimit: true }), run);
    const turns = turnsOf(limited, COLS);
    for (let j = 1; j < LAST; j += 1) expect((turns.byJoint[j] as number) / LIMIT, `joint ${j}`).toBeLessThanOrEqual(CEILING);
    for (const frame of limited) for (const value of frame.position) expect(Number.isFinite(value), `frame ${frame.frame}`).toBe(true);
    // Its length: measured 0.008 % at the worst, a step's exit tolerance and what a pull at 0.95 leaves on it.
    expect(stretchOf(limited, COLS, PITCH)).toBeLessThan(0.001 * PITCH);
    const free = await play(drawn({}), run);
    note(`case 3: limit on, worst turn ${(turns.worst * DEGREES).toFixed(1)}°, worst segment ${((stretchOf(limited, COLS, PITCH) / PITCH) * 100).toFixed(3)} %, furthest from its target ${(furthest(limited) * 1000).toFixed(1)} mm; no limit, worst turn ${(turnsOf(free, COLS).worst * DEGREES).toFixed(1)}°, furthest ${(furthest(free) * 1000).toFixed(1)} mm`);
    expect(turnsOf(free, COLS).worst / LIMIT).toBeGreaterThan(2);
    // The pins gave: further from its targets with the limit than without (measured 55 mm against 20).
    expect(furthest(limited)).toBeGreaterThan(1.5 * furthest(free));
  }, 600_000);
});

describe("rope: a held point is where it is told to be, and what letting go of it does (T1585b slice 4, the design's D31)", () => {
  const COLS = 54;
  const LAST = COLS - 1;
  const PITCH = 0.06;
  const BODY = 0.64;
  const held = (more: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({ updateRate: 240, iterations: 8, gravity: 1.5, damping: 1.5, segmentLength: PITCH, pinAttribute: "clip", ...more });

  /*
   * THE FIRST CONSUMER'S RIG holds its rings up to 16 % further apart than the rope's pitch.
   * Every ring pinned at exactly 1 is its incoming point of the same frame, to the bit,
   * however far apart the rig puts them: here from 0.98 to 1.18 pitches, on a strand that is
   * carried along and swung about its socket. (Drawn in to the rope's length, as a target
   * out of reach of an earlier pin is, each ring trailed the one before it: 99 mm at the
   * last, measured on the consumer's own walk.)
   */
  it("pinned at every point to a strip up to 18 % longer than the rope: every point is its incoming point on every frame, to the bit", async () => {
    const along = `(${PITCH} * (f32(i) * 1.08 + 0.08 * sin(f32(i) * 1.3)))`;
    const fixture: RopeFixture = {
      cols: COLS,
      pose: { wgsl: `vec3f(cos(0.5 * sin(2.0 * t)) * ${along}, sin(0.5 * sin(2.0 * t)) * ${along}, ${BODY} * t)`, at: () => [0, 0, 0] },
      weights: [{ name: "clip", wgsl: "1.0", at: () => 1 }],
      rope: held({}),
    };
    const frames = await play(fixture, { frames: 240, from: 1 });
    expect(frames).toHaveLength(239);
    let longest = 0;
    for (const frame of frames) {
      // Seen red from the first frame with a held point that follows a held point drawn in to the rope's length.
      expect(Buffer.from(frame.position.buffer, frame.position.byteOffset, frame.position.byteLength).equals(Buffer.from(frame.incoming.buffer, frame.incoming.byteOffset, frame.incoming.byteLength)), `frame ${frame.frame}`).toBe(true);
      for (let k = 0; k < LAST; k += 1) longest = Math.max(longest, segmentLength(frame.position, k) / PITCH);
    }
    // The strip is longer than the rope, and the rope is the strip.
    expect(longest).toBeGreaterThan(1.15);
  }, 300_000);

  /*
   * LETTING GO OF A STRAND HELD LONGER THAN ITSELF. Every point pinned to a strip 16 % longer
   * than the rope, half a metre over the strand, and then released. A rope has its own
   * length the moment it is free to: in the first step a weight is under 1 the strand takes
   * it back, and its far end moves by the whole over-length in that frame, cut or ramp.
   * What differs is the SPEED that is left in it.
   *
   *   A CUT, 1 to 0 in one frame: nothing holds the strand as it shortens, the step's whole
   *   correction is speed, and the rope is thrown through its own anchor (measured 56 m/s,
   *   and 1.2 m in the frame).
   *   A RAMP over 0.2 s: the weight a frame after 1 is still a pull thousands of times as
   *   stiff as the one at a half, sized to hold each point, and it takes the speed out as the
   *   strand shortens (measured 4 m/s, and under 2.6 m/s from the next frame on).
   *
   * So: ramp a weight down. The node's descriptions say so.
   */
  const RELEASE = 2;
  const longer = (weight: string): RopeFixture => ({
    cols: COLS,
    pose: { wgsl: `vec3f(0.0, 0.0, ${BODY} * t - f32(i) * ${PITCH * 1.16})`, at: () => [0, 0, 0] },
    weights: [{ name: "clip", wgsl: weight, at: () => 1 }],
    rope: held({}),
  });
  /** From the frame of the release on: the fastest stored speed against the body's own, and the largest move of the last point in a frame. */
  const released = (frames: ReadonlyArray<Probed>): { speed: number; jump: number; stretch: number } => {
    let speed = 0;
    let jump = 0;
    for (let index = 1; index < frames.length; index += 1) {
      const frame = frames[index] as Probed;
      if (frame.frame < 60 * RELEASE) continue;
      for (let point = 0; point < COLS; point += 1) {
        const v = pointOf(frame.velocity, point);
        speed = Math.max(speed, Math.hypot(v[0] as number, v[1] as number, (v[2] as number) - BODY));
      }
      const [now, was] = [pointOf(frame.position, LAST), pointOf((frames[index - 1] as Probed).position, LAST)];
      jump = Math.max(jump, between(now, [was[0] as number, was[1] as number, (was[2] as number) + BODY / 60]));
    }
    // A second after the release, when the first frames' guard has had its say.
    const settled = frames.filter((frame) => frame.frame >= 60 * (RELEASE + 1));
    return { speed, jump, stretch: stretchOf(settled, COLS, PITCH) };
  };
  const run = { frames: 60 * 4, from: 60 * RELEASE - 3 };

  it("a weight ramped down over 0.2 s lets the strand take its length back in one frame, at a few metres a second; a cut throws it", async () => {
    const ramp = await play(longer(`(1.0 - smoothstep(${RELEASE}.0, ${RELEASE}.2, t))`), run);
    // Held: the frames before the release are the strip, 16 % long. (Seen red with the far end
    // 0.45 m short of its incoming point, a held point drawn in to the rope's length.)
    for (const frame of ramp.filter((entry) => entry.frame < 60 * RELEASE)) {
      expect(pointOf(frame.position, LAST), `frame ${frame.frame}`).toEqual(pointOf(frame.incoming, LAST));
      expect(segmentLength(frame.position, 26) / PITCH).toBeGreaterThan(1.15);
    }
    const ramped = released(ramp);
    note(`release, ramp over 0.2 s: far end moves ${(ramped.jump * 1000).toFixed(0)} mm in a frame; fastest stored speed ${ramped.speed.toFixed(2)} m/s; worst segment a second on ${((ramped.stretch / PITCH) * 100).toFixed(3)} %`);
    // The over-length, 53 × 0.16 × 0.06 = 0.51 m, goes in one frame…
    expect(ramped.jump).toBeGreaterThan(0.5);
    // …at a speed the pull has taken most of (measured 4.0 m/s)…
    expect(ramped.speed).toBeLessThan(8);
    // …and it is a rope of its own length after.
    expect(ramped.stretch).toBeLessThanOrEqual(ROPE_TOLERANCE * PITCH + ROPE_TOLERANCE_FLOOR + 2 * 2 ** -21);

    const cut = released(await play(longer(`select(1.0, 0.0, t >= ${RELEASE}.0)`), run));
    note(`release, cut: far end moves ${(cut.jump * 1000).toFixed(0)} mm in a frame; fastest stored speed ${cut.speed.toFixed(2)} m/s`);
    // Measured 56 m/s, and the rope ends on the far side of its anchor.
    expect(cut.speed).toBeGreaterThan(5 * ramped.speed);
    expect(cut.speed).toBeGreaterThan(30);
  }, 600_000);

  it("the control: a strip at the rope's own pitch is let go without either, cut in one frame", async () => {
    const legal: RopeFixture = { ...longer(`select(1.0, 0.0, t >= ${RELEASE}.0)`), pose: { wgsl: `vec3f(0.0, 0.0, ${BODY} * t - f32(i) * ${PITCH})`, at: () => [0, 0, 0] } };
    const free = released(await play(legal, run));
    note(`release, cut, a strip at the rope's own pitch: far end moves ${(free.jump * 1000).toFixed(0)} mm in a frame; fastest stored speed ${free.speed.toFixed(2)} m/s`);
    // It swings down under gravity and nothing more (measured 1.0 m/s, 17 mm in a frame).
    expect(free.speed).toBeLessThan(2);
    expect(free.jump).toBeLessThan(0.05);
  }, 300_000);
});
