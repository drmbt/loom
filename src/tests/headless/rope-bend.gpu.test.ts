import { describe, expect, it } from "vitest";

import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { ANCHOR, ROPE, component, incomingOf, ropeGraph, ropeRegionOf, segmentLength, type RopeFixture } from "../../nodes/definitions/rope-test-support.ts";
import { ROPE_REACH_SHARE, ROPE_REACH_SLACK, ROPE_TOLERANCE, ROPE_TOLERANCE_FLOOR } from "../../points/rope.ts";
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
   * 250 POINTS AT REST, ON A DEVICE (slice 4b: the design quoted these from the reference).
   * The same 3.24 m cut into 249 segments: a joint may turn 4.97°, and what a resting bend
   * gives under the strand's own weight is 3 % of that at Update Rate 240 and a quarter of a
   * percent at 960. Under the yield at both, so no limit opens.
   */
  it.each([
    [240, 1.04],
    [960, 1.01],
  ] as const)("a 250-point strand at rest at Update Rate %i: no joint is past %f of its limit, and it is at it", async (updateRate, ceiling) => {
    const links = 249;
    const pitch = LENGTH / links;
    const limit = 2 * Math.asin(pitch / (2 * RADIUS));
    // Carried over 6 s, left 14 s under a damping of 2, then two seconds read.
    const frames = await play(loop(links, { updateRate, damping: 2, bendLimit: true }), { frames: 60 * 22, from: 60 * 20 });
    const turns = turnsOf(frames, links + 1);
    note(`250 points at rest, Update Rate ${updateRate}: largest turn ${(turns.worst / limit).toFixed(4)} of the limit; worst segment ${((stretchOf(frames, links + 1, pitch) / pitch) * 100).toFixed(4)} %; largest move in a frame ${(movedOf(frames, links + 1) * 1e6).toFixed(2)} µm`);
    expect(turns.worst / limit).toBeLessThanOrEqual(ceiling);
    expect(turns.worst / limit).toBeGreaterThan(0.999);
    expect(stretchOf(frames, links + 1, pitch)).toBeLessThanOrEqual(ROPE_TOLERANCE * pitch + ROPE_TOLERANCE_FLOOR + 2 * 2 ** -22);
  }, 900_000);

  /*
   * IN MOTION THE LIMIT IS EXCEEDED, BY THIS MUCH. The far pin stands 0.9 m from the first and
   * is swept at 2 Hz. The limit's rows are compliant, a step is finite, and at 8 m/s the pin
   * crosses half a segment in a step of 1/240 s. With no limit the same sweep folds the
   * strand to 7.8 times the limit in every frame.
   *
   * THE CEILINGS SIT ABOVE A RANGE, NOT AT A FIGURE. A whipped rope is chaotic, and the worst
   * joint of four seconds moves with the last place of the arithmetic: slice 4 measured
   * 1.011, 1.001, 1.241 and 1.024 of the limit, and the build before its last change (the
   * same solve, written another way) 1.146, 1.004, 1.155 and 1.150. The node's description
   * gives the same ranges.
   *
   * SLICE 4B (the limit gives where it cannot be met) leaves three of the four as they were,
   * to the digit: 1.011, 1.001 and 1.024. Their joints are past the yield only in bursts
   * shorter than the wait. THE SWEEP AT 8 M/S AT UPDATE RATE 240 IS NOT ONE OF THEM: a step
   * of 1/240 s cannot carry that sweep, its joints give more than the yield for a fifth of a
   * second at a time, and the limit opens there as it does in any pose it cannot hold.
   * Measured 1.399 of the limit where slice 4 measured 1.241, and a worst segment of 0.69 %
   * where it measured 0.2 %. On the reference, over nine sweeps beside this one (centre 0.85
   * to 0.95 m, 7.5 to 8.5 m/s): slice 4 a mean of 1.32 and at most 1.52, with a segment up
   * to 1.06 % off; slice 4b a mean of 1.46 and at most 2.00, a segment up to 1.94 % off. So
   * this row's ceiling on the TURN is what it was and is not a bound on the neighbourhood,
   * before or after; and its ceiling on a SEGMENT is now Max Stretch itself, the guard's
   * own, where the other three keep the quarter of it they had.
   */
  it.each([
    [4, 240, 1.25, 0.005],
    [4, 960, 1.02, 0.005],
    [8, 240, 1.5, 0.02],
    [8, 960, 1.25, 0.005],
  ] as const)("swept at %i m/s at Update Rate %i no joint is past %f of its limit, and no segment is past %f of its length", async (peak, updateRate, ceiling, slack) => {
    const frames = await play(loop(LINKS, { updateRate, bendLimit: true }, 0.9, { peak, from: 12 }), { frames: 60 * 16, from: 60 * 12 });
    expect(frames).toHaveLength(240);
    const over = (by: number): number => frames.filter((frame) => turnsOf([frame], LINKS + 1).worst > LIMIT * by).length / frames.length;
    note(`swept ${peak} m/s, Update Rate ${updateRate}: largest turn ${(turnsOf(frames, LINKS + 1).worst / LIMIT).toFixed(3)} of the limit; frames over by 1 %: ${(over(1.01) * 100).toFixed(0)} %, by 5 %: ${(over(1.05) * 100).toFixed(0)} %; worst segment ${((stretchOf(frames, LINKS + 1, PITCH) / PITCH) * 100).toFixed(3)} %`);
    expect(turnsOf(frames, LINKS + 1).worst / LIMIT).toBeLessThanOrEqual(ceiling);
    // Never thrown: Max Stretch is 2 %. Three of the four come nowhere near it; at 8 m/s and 240 a segment is within it and no more is claimed.
    expect(stretchOf(frames, LINKS + 1, PITCH)).toBeLessThanOrEqual(slack * PITCH + 2 * 2 ** -22);
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
   * slice 4 measured this loop's tightest radius at 0.118 m where it is asked for 0.15,
   * against 0.069 m with no limit. At Update Rate 240 a strand this fine is past its own step
   * limit with or without the bend limit.
   *
   * SLICE 4B MAKES IT WORSE HERE, AND SAYS SO. At 0.118 m the joints of this loop give 28 %
   * of their limit under the strand's own weight: 6 thousandths of a radian, past the yield
   * of 4. A joint that gives more than the yield for longer than the wait has its limit
   * opened, whatever loads it, and no rule tried could tell a strand's own weight from a pose
   * that cannot be met without letting the second one thrash (the design's section 18.3). So
   * this loop's limit opens: 0.096 m measured, two thirds of what is asked. Stated in the
   * description, with what holds it: more steps (a joint's give falls with the square of the
   * step).
   */
  it("a 1,024-point strand at Update Rate 960: the loop's tightest radius is two thirds of what is asked, and still far from the loop with no limit", async () => {
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
    // Slice 4: 0.118. Slice 4b: 0.096.
    expect(tightest(limited)).toBeGreaterThan(0.085);
    expect(tightest(limited)).toBeLessThanOrEqual(RADIUS);
    // Every segment keeps its length: the exit tolerance and the stored positions' spacing.
    expect(stretchOf(limited, links + 1, pitch)).toBeLessThanOrEqual(ROPE_TOLERANCE * pitch + ROPE_TOLERANCE_FLOOR + 2 * 2 ** -22);
    const free = await play(loop(links, { updateRate: 960, damping: 4 }, 0.5, undefined, 3), run);
    note(`1,024 points, no limit: tightest radius ${tightest(free).toFixed(4)} m`);
    expect(tightest(free)).toBeLessThan(0.08);
  }, 900_000);
});

describe("rope: a pose the limit cannot meet comes to rest, with the limit giving (T1585b slice 4b, the design's D41)", () => {
  /*
   * THE TABLE, as `points/rope.test.ts` has it, on a device: sixteen strands of sixteen
   * segments of 1/16 m in one pointset, the first two points of each held facing +X, the
   * last of strand `j` held d = 7 + j/2 segments straight behind the second, at a radius of
   * 0.15 m (a joint may turn 24.0°). Each arrives by a walk and is not seeded folded: its far
   * end is carried round over two seconds to four segments behind, rested a second, walked
   * out to d over one more, and held five. The last two seconds are read. (Four segments
   * behind is itself tighter than the radius allows; the limit gives there too, and is the
   * limit again by d = 6 or 7.)
   */
  const REST = 1 / 16;
  const ROWS = 16;
  const POINTS = 17;
  const LIMIT = 2 * Math.asin(REST / (2 * RADIUS));
  const ease = (x: string): string => `(pow(clamp(${x}, 0.0, 1.0), 3.0) * (clamp(${x}, 0.0, 1.0) * (clamp(${x}, 0.0, 1.0) * 6.0 - 15.0) + 10.0))`;
  const d = "(7.0 + 0.5 * f32(j))";
  const round = ease("t / 2.0");
  const reach = `((15.0 - 11.0 * ${round}) * ${REST})`;
  const carriedRound = `vec3f(${REST} + cos(${Math.PI} * ${round}) * ${reach}, -sin(${Math.PI} * ${round}) * ${reach} * 0.8, f32(j))`;
  const walkedOut = `vec3f(${REST} - (4.0 + (${d} - 4.0) * ${ease("t - 3.0")}) * ${REST}, 0.0, f32(j))`;
  const table = (rope: Readonly<Record<string, unknown>>): RopeFixture => ({
    cols: POINTS,
    rows: ROWS,
    pose: { wgsl: `select(vec3f(f32(i) * ${REST}, 0.0, f32(j)), select(${carriedRound}, ${walkedOut}, t >= 2.0), i == 16u && t > 0.0)`, at: () => [0, 0, 0] },
    rope: { gravity: 8, damping: 2, anchorSecond: 1, anchorLast: 1, segmentLength: REST, iterations: 8, minBendRadius: RADIUS, ...rope },
  });
  interface Row {
    fastest: number;
    stretch: number;
    worst: number;
    turns: number[];
  }
  /** Strand `row` of a region, as a region of its own. */
  const strandOf = (region: Float32Array, row: number, cols: number): Float32Array => region.subarray(row * cols * 4, (row + 1) * cols * 4);
  const SECONDS = 9;
  const rowsOf = (frames: ReadonlyArray<Probed>): Row[] =>
    Array.from({ length: ROWS }, (_unused, row) => {
      const seen: Row = { fastest: 0, stretch: 0, worst: 0, turns: [] };
      for (const frame of frames) {
        const [position, velocity, incoming] = [strandOf(frame.position, row, POINTS), strandOf(frame.velocity, row, POINTS), strandOf(frame.incoming, row, POINTS)];
        // A held point is its incoming point, on every frame.
        for (const point of [0, 1, POINTS - 1]) expect(pointOf(position, point), `frame ${frame.frame}, row ${row}, point ${point}`).toEqual(pointOf(incoming, point));
        for (let k = 1; k < POINTS - 1; k += 1) seen.stretch = Math.max(seen.stretch, Math.abs(segmentLength(position, k) / REST - 1));
        if (frame.frame <= 60 * (SECONDS - 2)) continue;
        for (let point = 2; point < POINTS - 1; point += 1) seen.fastest = Math.max(seen.fastest, Math.hypot(...pointOf(velocity, point)));
        for (let j = 1; j < POINTS - 1; j += 1) seen.worst = Math.max(seen.worst, turnAt(position, j));
      }
      const last = strandOf((frames[frames.length - 1] as Probed).position, row, POINTS);
      for (let j = 1; j < POINTS - 1; j += 1) seen.turns.push(turnAt(last, j));
      return seen;
    });
  // Read from the end of the walk on.
  const run = { frames: 60 * SECONDS + 1, from: 60 * 4 };

  /*
   * AT REST means: no free point faster than 0.03 m/s in the last two seconds, half a
   * millimetre a frame, or six times what the same strand with no limit shows where that is
   * more (it shows 0.002 to 0.026 m/s: a strand under gravity 8 still settling). Measured:
   * 0.000 m/s on twelve rows of sixteen at Update Rate 240 and at most 0.023 on the rest; at
   * 960, 0.000 on fifteen and 0.089 at d = 11, which is 3.9 times its strand with no limit
   * and a tenth of a millimetre a step.
   *
   * WHAT THAT ROW DOES (slice 4c, read from the device step by step; the design's 19.4). The
   * hinge is idle: the openings of its two open joints do not move and no clock runs. Those
   * two joints rest giving 0.98 and 0.81 of the yield, inside the band between half the yield
   * and the yield where a limit neither opens nor closes; and a step that rebuilds that much
   * push from nothing does not land on the same point twice on this device. It lands on a
   * cycle of three frames, in the strand beyond the bend. Neither the gap nor the closing
   * rate acts on a joint in that band. The one constant that bounds the band is the yield,
   * which every row's opening hangs on, so the bound stands as it is and the row is filed.
   * SLICE 4, measured on the reference's same table: from d = 7.5 to 11.5, 2.7 to 66 m/s at
   * four steps a frame, and to d = 12, 11 to 239 at sixteen; further out it folded flat at
   * its second point and lay still, thrown at up to 280 m/s on the way.
   */
  it.each([
    [240, 4],
    [960, 16],
  ] as const)("at Update Rate %i (%i steps a frame) every row from d = 7 to 14.5 is at rest, its pins exact and every segment within Max Stretch; where the turn does not fit the radius the limit has given, and no joint has folded flat", async (updateRate, steps) => {
    const limited = rowsOf(await play(table({ updateRate, bendLimit: true }), run));
    const free = rowsOf(await play(table({ updateRate }), run));
    note(`table, Update Rate ${updateRate} (${steps} steps a frame): d, fastest point in the last 2 s m/s (with no limit), worst segment %, largest turn as a multiple of the limit, the first joints' turns at the end`);
    for (let row = 0; row < ROWS; row += 1) {
      const [on, off] = [limited[row] as Row, free[row] as Row];
      note(`  d ${(7 + row / 2).toFixed(1).padStart(4)}: ${on.fastest.toFixed(3)} (${off.fastest.toFixed(3)}); ${(on.stretch * 100).toFixed(2)} %; ${(on.worst / LIMIT).toFixed(2)}; ${on.turns.slice(0, 6).map((turn) => (turn * DEGREES).toFixed(0)).join(" ")}`);
    }
    for (let row = 0; row < ROWS; row += 1) {
      const [on, off] = [limited[row] as Row, free[row] as Row];
      const at = `d ${7 + row / 2}`;
      // Seen red on the rows from d = 7.5 to 12 with the hinge taken out of the program.
      expect(on.fastest, at).toBeLessThanOrEqual(Math.max(6 * off.fastest, 0.03));
      expect(on.stretch, at).toBeLessThanOrEqual(0.02 + 2 ** -18);
      // No joint folded flat: the sharpest is 135°, where one joint takes the whole turn.
      expect(on.worst, at).toBeLessThan(2.5);
      // With no limit the strand folds at the second point: by 102° at d = 7, by more further out.
      expect(off.worst, at).toBeGreaterThan(4 * LIMIT);
    }
    // d = 7 is a pose the limit can meet, and it is met: within what a tight turn gives.
    expect((limited[0] as Row).worst / LIMIT).toBeLessThan(1.08);
    // From d = 8 on it cannot be, and the limit has given.
    for (let row = 2; row < ROWS; row += 1) expect((limited[row] as Row).worst / LIMIT, `d ${7 + row / 2}`).toBeGreaterThan(1.15);
  }, 900_000);

  /*
   * THE LIMIT COMES BACK. One strand walked OUT to d = 11, held two seconds, and walked BACK
   * over one second to d = 6, where the turn fits the radius. The limit that opened closes:
   * three seconds on, no joint is past it by more than a resting bend gives.
   *
   * AND WITH A MAX STRETCH OF NOTHING (slice 4c, B277). An open limit closes onto its joint
   * only in a step the solve finished at its first attempt, and at a Max Stretch of nothing
   * no step was: length before bend (D36) asked the guard's exact test, a rounding failed it,
   * and every step was solved two or three times. The limit that gave at d = 11 stayed given
   * (reference: 2.02 and 2.31 of the limit back at d = 6), and a step cost 3.1 to 5.7 times
   * one at a Max Stretch of 0.02 (measured by the timing rule; 1.15 now). D36 now asks for a
   * segment beyond Max Stretch by more than the solve's own tolerance of a length.
   */
  it.each([
    [240, 0.02],
    [960, 0.02],
    [240, 0],
    [960, 0],
  ] as const)("at Update Rate %i, Max Stretch %f, a limit that gave at d = 11 is the limit again back at d = 6, and the strand is at rest", async (updateRate, maxStretch) => {
    const behind = `select(select(11.0 - 5.0 * ${ease("t - 5.0")}, 4.0 + 7.0 * ${ease("t - 2.0")}, t < 5.0), 4.0, t < 2.0)`;
    const fixture: RopeFixture = {
      cols: POINTS,
      pose: { wgsl: `select(vec3f(f32(i) * ${REST}, 0.0, 0.0), select(${carriedRound.replace("f32(j)", "0.0")}, vec3f(${REST} - ${behind} * ${REST}, 0.0, 0.0), t >= 2.0), i == 16u && t > 0.0)`, at: () => [0, 0, 0] },
      rope: { gravity: 8, damping: 2, anchorSecond: 1, anchorLast: 1, segmentLength: REST, iterations: 8, minBendRadius: RADIUS, updateRate, bendLimit: true, maxStretch },
    };
    const frames = await play(fixture, { frames: 60 * 9 + 1, from: 60 * 4 });
    const out = turnsOf(frames.filter((frame) => frame.frame <= 60 * 5), POINTS).worst;
    const back = frames.filter((frame) => frame.frame > 60 * 8);
    let fastest = 0;
    for (const frame of back) for (let point = 2; point < POINTS - 1; point += 1) fastest = Math.max(fastest, Math.hypot(...pointOf(frame.velocity, point)));
    note(`out and back, Update Rate ${updateRate}, Max Stretch ${maxStretch}: at d = 11 the largest turn is ${(out / LIMIT).toFixed(2)} of the limit; back at d = 6, ${(turnsOf(back, POINTS).worst / LIMIT).toFixed(3)}; fastest point ${fastest.toFixed(3)} m/s`);
    expect(out / LIMIT).toBeGreaterThan(2);
    // Seen red with an open limit that never closes; and, at a Max Stretch of nothing, with D36 asking the guard's exact test.
    expect(turnsOf(back, POINTS).worst / LIMIT).toBeLessThanOrEqual(1.02);
    // At rest, at a Max Stretch of nothing too: with the limit on the guard is called by a
    // segment beyond Max Stretch by more than the solve's tolerance, and no longer walks the
    // strand on a rounding in every step (slice 4d; it read 0.035 m/s at Update Rate 240).
    expect(fastest).toBeLessThan(0.03);
  }, 600_000);

  /*
   * THE FIRST CONSUMER'S STRAND WITH ITS SOCKET FACING AWAY FROM THE CLAW. 53 segments of
   * 0.06 m, 3.18 m of rope, gravity 1.5, damping 1.5: the socket and the ring after it held
   * facing −X, the claw carried round over four seconds to a point 2.9, 3.0, 3.06 and 3.1 m
   * off along +X, a strand each. One segment is spent behind the socket, so 3.12 m of rope
   * has that distance and 0.06 m to cover, round a turn of half a circle: the limit cannot
   * be met at 2.9 or at 3.0 m; at 3.06 the rope is taut; and 3.1 m is out of its reach.
   */
  const COLS = 54;
  const PITCH = 0.06;
  const FARS = [2.9, 3.0, 3.06, 3.1];
  const TURN = 2 * Math.asin(PITCH / (2 * RADIUS));
  const reaching = (rope: Readonly<Record<string, unknown>>): RopeFixture => {
    const way = ease("t / 4.0");
    const far = "select(select(select(3.1, 3.06, j == 2u), 3.0, j == 1u), 2.9, j == 0u)";
    const out = `(3.12 + (${far} - 3.12) * ${way})`;
    return {
      cols: COLS,
      rows: FARS.length,
      pose: { wgsl: `select(vec3f(-f32(i) * ${PITCH}, 0.0, f32(j)), vec3f(cos(${Math.PI} * (1.0 - ${way})) * ${out}, sin(${Math.PI} * (1.0 - ${way})) * ${out} * 0.6, f32(j)), i == ${COLS - 1}u && t > 0.0)`, at: () => [0, 0, 0] },
      rope: { gravity: 1.5, damping: 1.5, anchorSecond: 1, anchorLast: 1, segmentLength: PITCH, iterations: 8, minBendRadius: RADIUS, ...rope },
    };
  };
  const seenOf = (frames: ReadonlyArray<Probed>): { fastest: number; stretch: number; worst: number; turns: number[]; end: number }[] =>
    FARS.map((_far, row) => {
      const seen = { fastest: 0, stretch: 0, worst: 0, turns: [] as number[], end: 0 };
      for (const frame of frames) {
        const [position, velocity] = [strandOf(frame.position, row, COLS), strandOf(frame.velocity, row, COLS)];
        for (let point = 2; point < COLS - 1; point += 1) seen.fastest = Math.max(seen.fastest, Math.hypot(...pointOf(velocity, point)));
        for (let k = 1; k < COLS - 1; k += 1) seen.stretch = Math.max(seen.stretch, Math.abs(segmentLength(position, k) / PITCH - 1));
        for (let j = 1; j < COLS - 1; j += 1) seen.worst = Math.max(seen.worst, turnAt(position, j));
      }
      const last = strandOf((frames[frames.length - 1] as Probed).position, row, COLS);
      for (let j = 1; j < 8; j += 1) seen.turns.push(turnAt(last, j));
      seen.end = component(last, COLS - 1, 0);
      return seen;
    });

  it.each([
    [240, 4],
    [960, 16],
  ] as const)("at Update Rate %i (%i steps a frame) the consumer's strand is at rest with the claw 2.9 m and 3.0 m off and nearly so taut at 3.06 m, every segment its length; with slack the limit is given by four times and no more", async (updateRate, steps) => {
    const reading = { frames: 60 * 12 + 1, from: 60 * 10 + 1 };
    const limited = seenOf(await play(reaching({ updateRate, bendLimit: true }), reading));
    const free = seenOf(await play(reaching({ updateRate }), reading));
    FARS.forEach((far, row) => {
      const [on, off] = [limited[row] as (typeof limited)[number], free[row] as (typeof free)[number]];
      note(`claw ${far} m, Update Rate ${updateRate} (${steps} steps a frame): fastest point in the last 2 s ${on.fastest.toFixed(3)} m/s (with no limit ${off.fastest.toFixed(3)}); worst segment ${(on.stretch * 100).toFixed(2)} % (${(off.stretch * 100).toFixed(2)} %); largest turn ${(on.worst / TURN).toFixed(2)} of the limit; the first joints ${on.turns.map((turn) => (turn * DEGREES).toFixed(0)).join(" ")}`);
    });
    for (const row of [0, 1, 2]) {
      const [on, off] = [limited[row] as (typeof limited)[number], free[row] as (typeof free)[number]];
      const at = `claw ${FARS[row]} m`;
      // Taut, the strand is nearly still and no more is claimed: measured on the reference 0.13 m/s at four steps a frame, 2 mm a frame.
      expect(on.fastest, at).toBeLessThanOrEqual(Math.max(4 * off.fastest, row === 2 ? 0.25 : 0.03));
      expect(on.stretch, at).toBeLessThanOrEqual(0.001);
      expect(on.worst / TURN, at).toBeGreaterThan(3);
      if (row < 2) expect(on.worst / TURN, at).toBeLessThan(4.5);
    }
    /*
     * THE CLAW AT 3.1 M IS OUT OF THE ROPE'S REACH (B276, slice 4d). This rope has no Stretch,
     * so it reaches its own length: the pin is drawn in to 3.06 m, the far end stands 40 mm
     * short of it, and the strand is the taut one of the row before. With NO limit it rests.
     * With the limit it is nearly still, as that row is.
     *
     * WHAT IT WAS: a far pin was drawn in only beyond the rope's length with Max Stretch on
     * top (3.18 m here), which a rope with no Stretch cannot be. On this device, with no
     * limit, the strand was thrown at 11 m/s at Update Rate 240 and 47 at 960, a segment 13 %
     * long; with the limit at 14 and 35.
     */
    const [on, off] = [limited[3] as (typeof limited)[number], free[3] as (typeof free)[number]];
    expect(off.fastest).toBeLessThanOrEqual(0.03);
    expect(off.stretch).toBeLessThanOrEqual(0.001);
    expect(on.fastest).toBeLessThanOrEqual(0.25);
    expect(on.stretch).toBeLessThanOrEqual(0.001);
    // Short of its pin by what it cannot reach: 3.1 m asked, 3.06 m and the reach's slack (48 µm) had.
    for (const seen of [on, off]) expect(Math.abs(seen.end - (3.06 + 3.12 * ROPE_REACH_SLACK))).toBeLessThan(2e-5);
  }, 900_000);

  /*
   * THE REACH IS WHAT THE ROPE CAN BE IN A STEP (B276), on a device: a segment of length l
   * reaches l × (1 + min(Max Stretch, max(2⁻¹⁶, ¼·Stretch·l·m ÷ h²))). Two strands with no
   * bend limit, their first two points held and the claw carried round to 3.1 m: one of 53
   * segments of 0.06 m, one measured from a strip laid in segments of 0.04 and 0.08 m in
   * turn (no Segment Length). Both have 3.12 m of rope after the held pair. Over Stretch and
   * mass, at Update Rate 240 and 960: the strand rests, and its far end stands short of the
   * pin by what is asked less what each segment can be.
   *
   * WHAT IT WAS, on the reference with the old reach (the rope's length with Max Stretch
   * whatever its Stretch), the equal strand, m/s at 240 and 960: no Stretch 11.5 and 52;
   * 10⁻⁷, 8.9 and 1.9; 4·10⁻⁷, 3.9 and 1.2; 1.6·10⁻⁶, 0.46 and 0.00. No step at a Stretch of
   * nothing: a rope that barely stretches was thrown as the rope that does not.
   */
  const alongWgsl = "select(f32(i) * 0.06, f32(i / 2u) * 0.12 + f32(i % 2u) * 0.04, j == 1u)";
  const along = (i: number, unequal: boolean): number => (unequal ? Math.floor(i / 2) * 0.12 + (i % 2) * 0.04 : i * 0.06);
  const outOfReach = (rope: Readonly<Record<string, unknown>>, segmentLength: number): RopeFixture => {
    const way = ease("t / 4.0");
    const out = `(3.12 + (3.1 - 3.12) * ${way})`;
    return {
      cols: COLS,
      rows: 2,
      pose: { wgsl: `select(vec3f(-(${alongWgsl}), 0.0, f32(j)), vec3f(cos(${Math.PI} * (1.0 - ${way})) * ${out}, sin(${Math.PI} * (1.0 - ${way})) * ${out} * 0.6, f32(j)), i == ${COLS - 1}u && t > 0.0)`, at: () => [0, 0, 0] },
      rope: { gravity: 1.5, damping: 1.5, anchorSecond: 1, anchorLast: 1, segmentLength, iterations: 8, ...rope },
    };
  };
  /** How far short of a pin at 3.1 m the strand stands: what is asked, less what each segment after the held pair can be in a step. */
  const shortOf = (stretch: number, mass: number, unequal: boolean, updateRate: number): number => {
    let reach = 0;
    for (let k = 1; k < COLS - 1; k += 1) {
      const l = along(k + 1, unequal) - along(k, unequal);
      reach += l * (1 + Math.min(0.02, Math.max(ROPE_REACH_SLACK, ROPE_REACH_SHARE * stretch * l * mass * updateRate * updateRate)));
    }
    return Math.max(0, 3.1 + along(1, unequal) - reach);
  };

  it.each([
    ["no Stretch", 0, 1],
    ["a Stretch of 10⁻⁷", 1e-7, 1],
    ["a Stretch of 4·10⁻⁷", 4e-7, 1],
    ["a Stretch of 1.6·10⁻⁶", 1.6e-6, 1],
    ["a Stretch of 10⁻⁷ and a mass of 4", 1e-7, 4],
    ["a Stretch of 6.4·10⁻⁶ and a mass of a quarter", 6.4e-6, 0.25],
  ] as const)("with %s a claw 40 mm past the rope's own length is drawn in to what the rope can be in a step: at Update Rate 240 and 960 both strands rest, short of the pin by that much", async (name, stretch, mass) => {
    for (const updateRate of [240, 960]) {
      // The equal strand takes its Segment Length; the other is measured from the strip, and the equal one beside it then is too.
      for (const given of [PITCH, 0]) {
        const frames = await play(outOfReach({ updateRate, stretch, mass }, given), { frames: 60 * 12 + 1, from: 60 * 10 + 1 });
        for (const row of given === 0 ? [1] : [0]) {
          const unequal = row === 1;
          let fastest = 0;
          let stretched = 0;
          for (const frame of frames) {
            const [position, velocity] = [strandOf(frame.position, row, COLS), strandOf(frame.velocity, row, COLS)];
            for (let point = 2; point < COLS - 1; point += 1) fastest = Math.max(fastest, Math.hypot(...pointOf(velocity, point)));
            for (let k = 1; k < COLS - 1; k += 1) stretched = Math.max(stretched, Math.abs(segmentLength(position, k) / (along(k + 1, unequal) - along(k, unequal)) - 1));
          }
          const last = strandOf((frames[frames.length - 1] as Probed).position, row, COLS);
          const short = 3.1 - component(last, COLS - 1, 0);
          const expected = shortOf(stretch, mass, unequal, updateRate);
          const at = `Update Rate ${updateRate}, segments ${unequal ? "0.04 and 0.08 m" : "0.06 m"}`;
          note(`reach, ${name}, ${at}: fastest point in the last 2 s ${fastest.toFixed(3)} m/s; worst segment ${(stretched * 100).toFixed(2)} %; the far end ${(short * 1000).toFixed(2)} mm short of its pin (${(expected * 1000).toFixed(2)} by the rule)`);
          // Seen red with the old reach put back in the shader.
          expect(fastest, at).toBeLessThanOrEqual(0.03);
          expect(stretched, at).toBeLessThanOrEqual(0.02 + 2 ** -13);
          expect(Math.abs(short - expected), at).toBeLessThan(1e-4);
          // The held pair is where it is told to be.
          for (const point of [0, 1]) expect(pointOf(last, point), at).toEqual(pointOf(strandOf((frames[frames.length - 1] as Probed).incoming, row, COLS), point));
        }
      }
    }
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

describe("rope: a held point is where it is told to be, and what letting go of it does (T1585b slices 4 and 4b, the design's D31 and D38)", () => {
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
   * LETTING GO OF A STRAND HELD LONGER THAN ITSELF (slice 4b, the design's D38). Every point
   * pinned to a strip longer than the rope and then released, by a cut in one frame or by a
   * ramp over 0.2 s. A rope has its own length the moment it is free to: in the step a
   * weight leaves 1 the strand takes it back, in POSITIONS ONLY. Its far end moves by the
   * whole over-length in that frame, which is seen (517 mm at 16 % long, 80 mm at 2.5 %), and
   * no speed is left in it: from then on it is the control's swing, the same strip at the
   * rope's own pitch, cut (1.04 m/s at its fastest).
   *
   * WHAT IT WAS (slice 4): a cut left the whole correction in the rope as speed, 56 m/s, and
   * the rope went through its own anchor; a ramp left 4.
   */
  const RELEASE = 2;
  const CUT = `select(1.0, 0.0, t >= ${RELEASE}.0)`;
  const RAMP = `(1.0 - smoothstep(${RELEASE}.0, ${RELEASE}.2, t))`;
  const longer = (weight: string, over = 1.16): RopeFixture => ({
    cols: COLS,
    pose: { wgsl: `vec3f(0.0, 0.0, ${BODY} * t - f32(i) * ${PITCH * over})`, at: () => [0, 0, 0] },
    weights: [{ name: "clip", wgsl: weight, at: () => 1 }],
    rope: held({}),
  });
  /**
   * The frame of the release is the one the far end moves furthest in. In it: that move, the
   * fastest stored speed against the body's own, and how far the longest segment is off its
   * length. From it on: the fastest stored speed. And a second on: the worst segment.
   */
  const released = (frames: ReadonlyArray<Probed>): { jump: number; speed: number; taken: number; fastest: number; stretch: number } => {
    const speedOf = (frame: Probed): number => {
      let speed = 0;
      for (let point = 0; point < COLS; point += 1) {
        const v = pointOf(frame.velocity, point);
        speed = Math.max(speed, Math.hypot(v[0] as number, v[1] as number, (v[2] as number) - BODY));
      }
      return speed;
    };
    let jump = 0;
    let at = 1;
    for (let index = 1; index < frames.length; index += 1) {
      const [now, was] = [pointOf((frames[index] as Probed).position, LAST), pointOf((frames[index - 1] as Probed).position, LAST)];
      const moved = between(now, [was[0] as number, was[1] as number, (was[2] as number) + BODY / 60]);
      if (moved > jump) [jump, at] = [moved, index];
    }
    let fastest = 0;
    for (let index = at; index < frames.length; index += 1) fastest = Math.max(fastest, speedOf(frames[index] as Probed));
    const settled = frames.filter((frame) => frame.frame >= 60 * (RELEASE + 1));
    return { jump, speed: speedOf(frames[at] as Probed), taken: stretchOf([frames[at] as Probed], COLS, PITCH), fastest, stretch: stretchOf(settled, COLS, PITCH) };
  };
  const run = { frames: 60 * 4, from: 60 * RELEASE - 3 };
  /** The control: the strip at the rope's own pitch, cut. */
  const control = async (): Promise<{ jump: number; speed: number; fastest: number }> => {
    const frames = await play(longer(CUT, 1), run);
    // Nothing to take up, so no frame stands out: the fastest stored speed of the two seconds after the cut, and the far end's largest move.
    let fastest = 0;
    let jump = 0;
    for (let index = 1; index < frames.length; index += 1) {
      const frame = frames[index] as Probed;
      if (frame.frame < 60 * RELEASE) continue;
      for (let point = 0; point < COLS; point += 1) {
        const v = pointOf(frame.velocity, point);
        fastest = Math.max(fastest, Math.hypot(v[0] as number, v[1] as number, (v[2] as number) - BODY));
      }
      const [now, was] = [pointOf(frame.position, LAST), pointOf((frames[index - 1] as Probed).position, LAST)];
      jump = Math.max(jump, between(now, [was[0] as number, was[1] as number, (was[2] as number) + BODY / 60]));
    }
    return { jump, speed: fastest, fastest };
  };

  it.each([
    ["a cut", 1.16, CUT, 0.2],
    ["a ramp over 0.2 s", 1.16, RAMP, 1.25],
    ["a cut", 1.025, CUT, 0.2],
    ["a ramp over 0.2 s", 1.025, RAMP, 1.25],
  ] as const)("%s of a strip %f times the rope's length: the far end moves by the over-length in one frame, the rope is its own length in it, and no point is thrown", async (name, over, weight, factor) => {
    const free = await control();
    const frames = await play(longer(weight, over), run);
    // Held: the frames before the release are the strip, long. (Seen red with a held point drawn in to the rope's length.)
    for (const frame of frames.filter((entry) => entry.frame < 60 * RELEASE)) {
      expect(pointOf(frame.position, LAST), `frame ${frame.frame}`).toEqual(pointOf(frame.incoming, LAST));
      expect(segmentLength(frame.position, 26) / PITCH).toBeGreaterThan(over - 0.01);
    }
    const let1 = released(frames);
    note(`release, ${name}, ${((over - 1) * 100).toFixed(1)} % long: far end moves ${(let1.jump * 1000).toFixed(0)} mm in the frame of release; fastest stored speed in it ${let1.speed.toFixed(2)} m/s, from it on ${let1.fastest.toFixed(2)} m/s (the control ${free.fastest.toFixed(2)}); longest segment in it ${((let1.taken / PITCH) * 100).toFixed(3)} % off, a second on ${((let1.stretch / PITCH) * 100).toFixed(3)} %`);
    // The contraction, seen: the whole over-length in one frame.
    const taken = 53 * (over - 1) * PITCH;
    expect(let1.jump).toBeGreaterThan(0.95 * taken);
    expect(let1.jump).toBeLessThan(1.05 * taken);
    // Its own length in that frame, not Max Stretch's 2 % over it. (Seen red at 2 % with the guard taking a released segment to Max Stretch.)
    expect(let1.taken).toBeLessThanOrEqual(0.0005 * PITCH);
    // No speed from the take-up: a cut leaves under a fifth of what the control reaches by
    // swinging; a ramp's pull, still stiff a frame after 1, moves the points it holds by up to
    // the control's own speed. Slice 4: 56 m/s and 4.
    expect(let1.speed).toBeLessThan(factor * free.fastest);
    // And none later: from the release on it is the control's swing. No point is thrown.
    expect(let1.fastest).toBeLessThan(Math.max(factor, 1.1) * free.fastest);
    // It is a rope of its own length after.
    expect(let1.stretch).toBeLessThanOrEqual(ROPE_TOLERANCE * PITCH + ROPE_TOLERANCE_FLOOR + 2 * 2 ** -21);
  }, 600_000);

  it("the control: a strip at the rope's own pitch is let go without either, cut in one frame", async () => {
    const free = await control();
    note(`release, cut, a strip at the rope's own pitch: far end moves ${(free.jump * 1000).toFixed(0)} mm in a frame; fastest stored speed ${free.speed.toFixed(2)} m/s`);
    // It swings down under gravity and nothing more (measured 1.0 m/s, 17 mm in a frame).
    expect(free.speed).toBeLessThan(2);
    expect(free.jump).toBeLessThan(0.05);
  }, 300_000);
});
