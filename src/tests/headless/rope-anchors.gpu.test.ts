import { describe, expect, it } from "vitest";

import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { ANCHOR, ROPE, component, incomingOf, ropeGraph, ropeRegionOf, segmentLength, type RopeFixture, type RopePose } from "../../nodes/definitions/rope-test-support.ts";
import { ROPE_DEFAULTS, ROPE_REACH_SLACK, ROPE_TOLERANCE, ROPE_TOLERANCE_FLOOR } from "../../points/rope.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1585b SLICE 2 — THE ROPE'S ANCHORS IN MOTION, frame by frame, through the whole stack: a
 * document whose upstream kernel moves the targets from the frame's own time, the compiler,
 * the frame driver and the offline transport, on a real device. Nothing is pushed from the
 * test; every assertion is on what each frame left, read with the harness's per-frame
 * probe (`probeFrames`) — the incoming points and the rope's, side by side.
 *
 * These are the first consumer's cases (sentinel-bot, §T1561b): a claw pinned to a target
 * that stands on a rung and then crosses to the next at 4 m/s, and at 8 m/s in an attack; a
 * claw that feels about after a wandering target at a part weight; a claw handed over to
 * its rung on a ramp, which must land without a pop.
 */

type Vec3 = readonly [number, number, number];

interface Probed {
  readonly frame: number;
  /** The incoming points of this frame, and the rope's: four floats a point. */
  readonly incoming: Float32Array;
  readonly position: Float32Array;
  readonly velocity: Float32Array;
}

async function play(fixture: RopeFixture, run: { readonly fps: number; readonly frames: number; readonly from: number }): Promise<Probed[]> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const rope = pointStorageId(ROPE);
  const anchor = pointStorageId(ANCHOR);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: ropeGraph(fixture),
    fps: run.fps,
    frames: run.frames,
    outputNodeId: "output_probe",
    probeBuffers: [rope, anchor],
    probeFrames: Array.from({ length: run.frames - run.from }, (_unused, index) => run.from + index),
  });
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

describe("rope: a far pin that stands on a rung and crosses to the next (T1585b slice 2, the consumer's stride)", () => {
  /*
   * THE FIXTURE. A tentacle of 54 segments of 2⁻⁴ m (the consumer's are 0.06). Its socket
   * moves down the tunnel at the body's speed; its first two points are held, the second a
   * segment behind the first. Its last point is held to the claw's target, which STANDS on a
   * rung for 70% of a step and crosses to the next, 2 m on, in the other 30% on a
   * smoothstep: 5 times the body's speed at its fastest. A body at 0.8 m/s is a claw at
   * 4 m/s, the stride; at 1.6 m/s it is 8 m/s, the attack. The claw is a metre and a half
   * to the side, so the tentacle hangs slack between its socket and its claw throughout.
   *
   * It is seeded as a straight run behind the socket (so its segments are measured at
   * their length), and the claw's weight comes up from 0 over the first second and a half
   * from an attribute the kernel writes: the hand-over, then weight 1 for the rest.
   */
  const COLS = 55;
  const LAST = COLS - 1;
  const PITCH = 2 ** -4;
  const STRIDE = 2;
  const tentacle = (body: number, rope: Readonly<Record<string, unknown>>): RopeFixture => {
    const period = STRIDE / body;
    const claw = (t: number): Vec3 => {
      const cycle = t / period;
      const swing = Math.min(1, Math.max(0, (cycle - Math.floor(cycle) - 0.7) / 0.3));
      return [1.5, 0, 0.7 + (Math.floor(cycle) + swing * swing * (3 - 2 * swing)) * STRIDE];
    };
    const pose: RopePose = {
      wgsl: `select(vec3f(0.0, 0.0, ${body} * t - f32(i) * ${PITCH}), vec3f(1.5, 0.0, 0.7 + (floor(t / ${period}) + smoothstep(0.7, 1.0, fract(t / ${period}))) * ${STRIDE}.0), i == ${LAST}u && t > 0.0)`,
      at: (i, _j, t) => (i === LAST && t > 0 ? claw(t) : [0, 0, body * t - i * PITCH]),
    };
    return {
      cols: COLS,
      pose,
      weights: [{ name: "hold", wgsl: "smoothstep(0.0, 1.5, t)", at: (_i, _j, t) => Math.min(1, Math.max(0, t / 1.5)) ** 2 * (3 - 2 * Math.min(1, Math.max(0, t / 1.5))) }],
      maps: { anchorLast: "hold" },
      rope: { damping: 1.5, anchorSecond: 1, ...rope },
    };
  };
  /** What ten seconds of it read, from the fourth on: the claw is held from 1.5 s and the hand-over's swing has died down. */
  const stride = async (body: number, rope: Readonly<Record<string, unknown>>) => {
    const frames = await play(tentacle(body, rope), { fps: 60, frames: 600, from: 240 });
    let stretch = 0;
    let pinOff = 0;
    let clawSpeed = 0;
    let before: number[] | undefined;
    for (const frame of frames) {
      for (let k = 0; k < LAST; k += 1) stretch = Math.max(stretch, Math.abs(segmentLength(frame.position, k) - PITCH));
      // The held points against the incoming points of the SAME frame.
      for (const point of [0, 1, LAST]) pinOff = Math.max(pinOff, between(pointOf(frame.position, point), pointOf(frame.incoming, point)));
      const claw = pointOf(frame.position, LAST);
      if (before !== undefined) clawSpeed = Math.max(clawSpeed, between(claw, before) * 60);
      before = claw;
    }
    return { stretch, pinOff, clawSpeed, frames: frames.length };
  };
  /*
   * What a segment's length may be off by, read back: the solver's exit tolerance, and the
   * spacing of the stored positions where the body has got to — 16 m in the attack's ten
   * seconds, where a float is 2⁻¹⁹ m apart, on each of a segment's two ends.
   */
  const TOLERANCE = ROPE_TOLERANCE * PITCH + ROPE_TOLERANCE_FLOOR + 2 * 2 ** -19;

  it("the stride, a claw at 4 m/s, at Update Rate 240: the held points are their targets to the bit and no segment leaves its tolerance", async () => {
    const read = await stride(0.8, { updateRate: 240 });
    expect(read.frames).toBe(360);
    // The claw did cross: its fastest frame is the smoothstep's 1.5 × 2 m ÷ 0.75 s.
    expect(read.clawSpeed).toBeGreaterThan(3.9);
    expect(read.clawSpeed).toBeLessThanOrEqual(4.01);
    // Seen red with the last station's weight unread (the claw is not carried: its fastest
    // frame is 1.2 m/s), and at 0.107 m off its target with the second station's unread.
    expect(read.pinOff).toBe(0);
    expect(read.stretch).toBeLessThanOrEqual(TOLERANCE);
  }, 240_000);

  it("the attack, a claw at 8 m/s, at Update Rate 240: the same, at the default rate's four steps a frame", async () => {
    const read = await stride(1.6, { updateRate: 240 });
    expect(read.clawSpeed).toBeGreaterThan(7.8);
    expect(read.pinOff).toBe(0);
    expect(read.stretch).toBeLessThanOrEqual(TOLERANCE);
  }, 240_000);

  /*
   * WHAT THE ATTACK NEEDS, AND WHAT HOLDS IT WHEN IT DOES NOT GET IT. At one step a frame
   * the claw crosses 13 cm in a step and the solve cannot finish. Max Stretch then holds
   * EVERY segment (the design's D24): between two pins the guard first walks back from the
   * later one and then out from the earlier, so nothing is left for the segment before the
   * claw to take. Walking out only, that one segment was 177% long.
   *
   * Two steps a frame put every segment at its length. So: Min Update Steps 2 at 60 frames
   * a second, which Update Rate 240 already gives twice over, and which matters only where
   * the rate has been turned down. Two steps hold it only because the claw's target is
   * WALKED across them: seen red at 30 tolerances with the target put at its end in a
   * frame's first step.
   */
  it("the attack at ONE step a frame: the guard holds every segment within Max Stretch, the one before the claw too; two steps put each at its length", async () => {
    const one = await stride(1.6, { updateRate: 60 });
    // Max Stretch is 2%, read back to the stored positions' spacing. Seen red at 110 mm on
    // segment 53, the one before the claw, with the guard walking out from the first point only.
    expect(one.stretch).toBeLessThanOrEqual(0.02 * PITCH + 2 * 2 ** -19);
    // It is the guard that holds it and not the solve: a segment is tens of tolerances out.
    expect(one.stretch).toBeGreaterThan(10 * TOLERANCE);
    expect(one.pinOff).toBe(0);
    const two = await stride(1.6, { updateRate: 60, minSteps: 2 });
    expect(two.stretch).toBeLessThanOrEqual(TOLERANCE);
    expect(two.pinOff).toBe(0);
  }, 240_000);
});

describe("rope: grab and release without a pop (T1585b slice 2, the design's 4.5)", () => {
  /*
   * ONE strand of a metre, hung from its first point. From the first frame its last point
   * has a target a third of a metre off to the side, and a weight the kernel writes on a
   * quintic: 0 until a quarter of a second, 1 from three and a quarter. Everything indexed
   * by strand is held fixed — this is one strand stepped through time.
   *
   * A weight that changes continuously moves its point continuously, so the tip's largest
   * move in ONE FRAME halves when the frame does: between 64 and 128 frames a second the
   * ratio's closed form is 2 (the reference reads 1.99). A pop does not halve.
   */
  const LINKS = 16;
  const REST = 1 / 16;
  const TARGET: Vec3 = [0.5, -0.75, 0];
  const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
  const hand = (weight: { readonly wgsl: string; readonly at: (t: number) => number }): RopeFixture => ({
    cols: LINKS + 1,
    pose: {
      wgsl: `select(vec3f(0.0, -f32(i) * ${REST}, 0.0), vec3f(${TARGET[0]}, ${TARGET[1]}, 0.0), i == ${LINKS}u && t > 0.0)`,
      at: (i, _j, t) => (i === LINKS && t > 0 ? TARGET : [0, -i * REST, 0]),
    },
    weights: [{ name: "hold", wgsl: weight.wgsl, at: (_i, _j, t) => weight.at(t) }],
    maps: { anchorLast: "hold" },
    rope: { updateRate: 256, gravity: 8, damping: 2, iterations: 8 },
  });
  const RAMP = {
    wgsl: "pow(clamp((t - 0.25) / 3.0, 0.0, 1.0), 3.0) * (clamp((t - 0.25) / 3.0, 0.0, 1.0) * (clamp((t - 0.25) / 3.0, 0.0, 1.0) * 6.0 - 15.0) + 10.0)",
    at: (t: number): number => ease((t - 0.25) / 3),
  };
  const largestMove = (frames: ReadonlyArray<Probed>): number => {
    let largest = 0;
    for (let index = 1; index < frames.length; index += 1) {
      largest = Math.max(largest, between(pointOf((frames[index] as Probed).position, LINKS), pointOf((frames[index - 1] as Probed).position, LINKS)));
    }
    return largest;
  };

  it("the tip's largest move in a frame halves when the frame does, and from the frame the weight is 1 it is its target to the bit", async () => {
    const at64 = await play(hand(RAMP), { fps: 64, frames: 64 * 4, from: 0 });
    const at128 = await play(hand(RAMP), { fps: 128, frames: 128 * 4, from: 0 });
    const ratio = largestMove(at64) / largestMove(at128);
    // Seen red with the last station's weight unread: nothing moves the tip at all.
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
    // It came the third of a metre, and at well under a metre a second.
    expect(largestMove(at64)).toBeGreaterThan(0.001);
    expect(largestMove(at64) * 64).toBeLessThan(1);
    // HARD LANDS. The weight is 1 from 3.25 s: frame 208 at 64 frames a second.
    for (const frame of at64.filter((entry) => entry.frame >= 209)) {
      expect(pointOf(frame.position, LINKS), `frame ${frame.frame}`).toEqual([...TARGET]);
    }
    // …and it was on its way before: a tenth of a second earlier it is within a millimetre.
    const nearly = at64.find((entry) => entry.frame === 202) as Probed;
    expect(between(pointOf(nearly.position, LINKS), TARGET)).toBeLessThan(0.001);
    expect(between(pointOf(nearly.position, LINKS), TARGET)).toBeGreaterThan(0);
  }, 240_000);

  it("the control: a weight stepped to 1 in one frame moves the tip by the whole gap in that frame", async () => {
    const stepped = await play(hand({ wgsl: "select(0.0, 1.0, t >= 1.0)", at: (t) => (t >= 1 ? 1 : 0) }), { fps: 64, frames: 64 * 2, from: 0 });
    // From where it hangs, (0, −1), to the target: 0.56 m in one frame.
    expect(largestMove(stepped)).toBeGreaterThan(0.5);
  }, 120_000);
});

describe("rope: a weight that rises from nothing (T1585b slice 2)", () => {
  /*
   * A target's history is kept whether or not its weight is above zero. Here the last
   * point's target runs away at 4 m/s for two seconds while its weight is 0, and then the
   * weight becomes 0.01. The pull's damper acts on the target's motion over the step: with
   * the history kept, that is one frame of 4 m/s, and a weight of 0.01 is a nudge. With a
   * history kept only while a weight is above zero it is the whole eight metres in one
   * frame — 512 m/s — and the tip is kicked by the damper, twenty times what the spring gives.
   */
  it("finds a target that was already being followed: the frame the weight appears, the tip is nudged and not kicked", async () => {
    const LINKS = 16;
    const REST = 1 / 16;
    const fixture: RopeFixture = {
      cols: LINKS + 1,
      pose: {
        wgsl: `select(vec3f(0.0, -f32(i) * ${REST}, 0.0), vec3f(4.0 * t, 0.0, 0.0), i == ${LINKS}u && t > 0.0)`,
        at: (i, _j, t) => (i === LINKS && t > 0 ? [4 * t, 0, 0] : [0, -i * REST, 0]),
      },
      weights: [{ name: "hold", wgsl: "select(0.0, 0.01, t >= 2.0)", at: (_i, _j, t) => (t >= 2 ? 0.01 : 0) }],
      maps: { anchorLast: "hold" },
      rope: { updateRate: 256, gravity: 8, damping: 1 },
    };
    const frames = await play(fixture, { fps: 64, frames: 130, from: 126 });
    const speedAt = (frame: number): number => Math.hypot(...pointOf((frames.find((entry) => entry.frame === frame) as Probed).velocity, LINKS));
    // Frame 128 is t = 2 s: the first with a weight. What the spring itself can add in that
    // frame is its pull on the tip for a sixty-fourth of a second: (2π·strength)²·gain, sized
    // for the strand's seventeen points, times the eight metres to the target — 3.4 m/s.
    // Measured 2.1. Seen red at 46 m/s with the history of an unweighted station left where
    // it was seeded.
    const gain = 0.01 / 0.99;
    const nudge = ((2 * Math.PI * ROPE_DEFAULTS.anchorStrength) ** 2 * gain * (LINKS + 1) * 8) / 64;
    expect(speedAt(127)).toBeLessThan(0.05);
    expect(speedAt(128) - speedAt(127)).toBeGreaterThan(0);
    expect(speedAt(128) - speedAt(127)).toBeLessThanOrEqual(nudge);
  }, 120_000);
});

describe("rope: feeling about — a wandering target at a part weight (T1585b slice 2, D20)", () => {
  /*
   * The same strand, its last point drawn toward a target that wanders (three sines, a
   * quarter of a metre each way at most, 0.3 to 0.8 Hz) by a weight that stays between 0.3
   * and 0.5 under Hard. That is a spring of stiffness M·(2π·strength)²·a ÷ (1 − a) with the
   * strand's mass for M: a blend toward the target. The tip follows it with a lag and is
   * never snapped onto it.
   *
   * How far behind it may be has a closed form in two parts. STANDING: the spring carries
   * at most the strand's whole weight, so g ÷ (ω²·gain) at most. MOVING: a target swinging
   * at frequency f is followed to within r² ÷ (1 + r²) of its swing, r = f ÷ (strength·√gain),
   * by a critically damped follower whose damper acts on the motion relative to the target.
   */
  const LINKS = 16;
  const REST = 1 / 16;
  const WANDER: ReadonlyArray<readonly [number, number, number, 0 | 1 | 2]> = [
    // amplitude (m), frequency (Hz), phase, axis
    [0.25, 0.5, 0, 0],
    [0.125, 0.8, 1, 1],
    [0.25, 0.3, 2, 2],
  ];
  const HOME: Vec3 = [0.5, -0.5, 0];
  const targetAt = (t: number): Vec3 => {
    const out: [number, number, number] = [HOME[0], HOME[1], HOME[2]];
    for (const [amplitude, hz, phase, axis] of WANDER) out[axis] += amplitude * Math.sin(2 * Math.PI * hz * t + phase);
    return out;
  };
  const wave = (axis: 0 | 1 | 2): string => {
    const term = WANDER.filter((entry) => entry[3] === axis).map(([amplitude, hz, phase]) => `${amplitude} * sin(${2 * Math.PI * hz} * t + ${phase}.0)`);
    return `${HOME[axis]} + ${term.join(" + ")}`;
  };
  const feeler = (anchorLast: number): RopeFixture => ({
    cols: LINKS + 1,
    pose: {
      wgsl: `select(vec3f(0.0, -f32(i) * ${REST}, 0.0), vec3f(${wave(0)}, ${wave(1)}, ${wave(2)}), i == ${LINKS}u && t > 0.0)`,
      at: (i, _j, t) => (i === LINKS && t > 0 ? targetAt(t) : [0, -i * REST, 0]),
    },
    rope: { updateRate: 256, gravity: 8, damping: 2, iterations: 8, anchorLast },
  });
  /** How far the tip is from its target over eight seconds, from the second on. */
  const behind = async (weight: number, fps = 64) => {
    const frames = await play(feeler(weight), { fps, frames: fps * 10, from: fps * 2 });
    let furthest = 0;
    let nearest = Number.POSITIVE_INFINITY;
    let largest = 0;
    let before: number[] | undefined;
    /** Over the frames whose target is out of the rope's reach: how many, and the furthest the tip is from where the reach puts it. */
    let beyond = 0;
    let offReach = 0;
    /** Over the frames whose target is within the rope's own length: how many, and the furthest the tip is from it. */
    let within = 0;
    let offTarget = 0;
    // The rope from the first point to the tip: sixteen segments, and the reach's slack.
    const rope = LINKS * REST;
    const reach = rope * (1 + ROPE_REACH_SLACK);
    for (const frame of frames) {
      const tip = pointOf(frame.position, LINKS);
      const target = pointOf(frame.incoming, LINKS);
      const off = between(tip, target);
      furthest = Math.max(furthest, off);
      nearest = Math.min(nearest, off);
      if (before !== undefined) largest = Math.max(largest, between(tip, before));
      before = tip;
      const far = Math.hypot(target[0] as number, target[1] as number, target[2] as number);
      if (far <= rope) {
        within += 1;
        offTarget = Math.max(offTarget, off);
      } else if (far > reach + 1e-6) {
        beyond += 1;
        offReach = Math.max(offReach, between(tip, target.map((value) => (value * reach) / far)));
      }
    }
    return { furthest, nearest, largest, beyond, offReach, within, offTarget };
  };
  const allowed = (weight: number): number => {
    const gain = weight / (1 - weight);
    const omegaSquared = (2 * Math.PI * ROPE_DEFAULTS.anchorStrength) ** 2;
    let moving = 0;
    for (const [amplitude, hz] of WANDER) {
      const r = hz / (ROPE_DEFAULTS.anchorStrength * Math.sqrt(gain));
      moving += (amplitude * r * r) / (1 + r * r);
    }
    return 8 / (omegaSquared * gain) + moving;
  };

  it.each([0.3, 0.4, 0.5])("at weight %f the tip follows the target within its standing and moving lag, and is never on it", async (weight) => {
    const read = await behind(weight);
    // Seen red at 1.0 m with the weight unread (the tip hangs under the first point), and at
    // 0.40 m at weight 0.3 with the pull sized for one point's mass: twice what is allowed.
    expect(read.furthest).toBeLessThanOrEqual(allowed(weight));
    expect(read.nearest).toBeGreaterThan(0);
  }, 240_000);

  /*
   * AT 1 THE TIP IS THE TARGET WHEREVER THE ROPE REACHES IT (re-derived in slice 4d, B276).
   * This target wanders a little past a metre from the strand's first point, on a metre of
   * rope with no Stretch. The reach used to be the rope's length with Max Stretch on top, so
   * the tip was the target on every frame, on a rope longer than itself. A rope with no
   * Stretch reaches its own length: where the target is within it the tip is the target, to
   * the bit, and where it is beyond the tip is on the line to it at the rope's reach.
   */
  it("the controls: at 1 the tip IS the target on every frame the rope reaches it, and at the rope's reach on the line to it on the rest; at 0 it does not know there is one; and it moves without a pop", async () => {
    const held = await behind(1);
    expect(held.within).toBeGreaterThan(400);
    expect(held.offTarget).toBe(0);
    // Some frames ARE out of reach, or the other half of this claims nothing.
    expect(held.beyond).toBeGreaterThan(0);
    // Stored positions near a metre are a ten-millionth apart.
    expect(held.offReach).toBeLessThanOrEqual(3 * 2 ** -23);
    expect((await behind(0)).nearest).toBeGreaterThan(0.3);
    // Continuity, as for the hand-over: the largest move in a frame halves with the frame.
    const ratio = (await behind(0.4, 64)).largest / (await behind(0.4, 128)).largest;
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  }, 240_000);
});
