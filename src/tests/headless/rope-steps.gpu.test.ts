import { describe, expect, it } from "vitest";

import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { ropeAttributes } from "../../nodes/definitions/point-rope.ts";
import { ROPE, component, hanging, ropeGraph } from "../../nodes/definitions/rope-test-support.ts";
import { pointRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1585b — the Rope's TIME through the whole stack: a document, the compiler, the frame
 * driver and the offline transport, on a real device, with no delta handed in by the test.
 *
 * `nodes/definitions/point-rope.gpu.test.ts` drives the backend frame by frame and holds
 * what a step does. This file holds the claim that needs a host the test does not operate:
 * that the step count follows EACH FRAME'S OWN LENGTH wherever the frame comes from. The
 * count is derived by the backend from the frame it renders (`rateSubsteps`), because the
 * compile that built the plan had no frame, and a host that renders a static document never
 * compiles again. So the same plan run at another frame rate, or in sub-frames, has to run
 * another number of steps — of the same size.
 *
 * THE COUNT IS READ OFF A FALL. A free strand at rest falls g·h²·k(k+1)/2 after k steps of
 * h, and at g = 8 and h = 1/256 that is 2⁻¹³·k(k+1)/2: a float, for every k here. The drop
 * of a frame therefore says how many steps have run and how long each was. The transport's
 * first frame has no predecessor and a delta of zero: it seeds, and steps nothing.
 */

const POINTS = 17;
const REST = 2 ** -10;
const FIXTURE = { cols: POINTS, pose: hanging(REST), rope: { updateRate: 256, gravity: 8, damping: 0, anchorFirst: 0 } };
const BUFFER = pointStorageId(ROPE);
const ATTRIBUTES = ropeAttributes({ tension: false });

/** How far a free strand has fallen after `steps` steps of 1/256 s. */
const fallen = (steps: number): number => -(2 ** -13) * ((steps * (steps + 1)) / 2);

interface Fall {
  /** The first point's height after each probed frame. */
  readonly heights: number[];
  /** The whole packed pair after the last probed frame. */
  readonly last: Uint8Array;
}

async function fall(options: { readonly fps: number; readonly frames: number; readonly probeFrames: ReadonlyArray<number>; readonly subframes?: number; readonly animate?: boolean }): Promise<Fall> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: ropeGraph(FIXTURE),
    fps: options.fps,
    frames: options.frames,
    outputNodeId: "output_probe",
    probeBuffers: [BUFFER],
    probeFrames: options.probeFrames,
    ...(options.subframes === undefined ? {} : { subframes: options.subframes }),
    ...(options.animate === true ? { animate: true } : {}),
  });
  const problems = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
  if (problems.length > 0) throw new Error(problems.map((d) => `${d.code}: ${d.message}`).join("; "));
  const frames = result.bufferFrames ?? [];
  const heightOf = (raw: ArrayBuffer | undefined): number => {
    if (raw === undefined) throw new Error("the rope's buffer was not probed");
    return component(new Float32Array(pointRegionSlice(raw, ATTRIBUTES, POINTS, "position").floats), 0, 1);
  };
  const final = frames[frames.length - 1]?.buffers[BUFFER];
  if (final === undefined) throw new Error("no frame was probed");
  return { heights: frames.map((entry) => heightOf(entry.buffers[BUFFER])), last: new Uint8Array(final) };
}

describe("rope: the step count follows each frame's own length, through the frame driver (T1585b)", () => {
  it("at 64 fps a frame is four steps of 1/256 s, on every frame of the fall", async () => {
    const at64 = await fall({ fps: 64, frames: 9, probeFrames: [0, 1, 2, 3, 8] });
    // Frame 0 seeds. Seen red at one step a frame (−0.00195 after frame 1, where four
    // steps of a quarter the size fall −0.00122) with the backend not deriving the count.
    expect(at64.heights).toEqual([0, fallen(4), fallen(8), fallen(12), fallen(32)]);
    expect(fallen(32)).toBe(-0.064453125);
  }, 120_000);

  it("at 32 fps a frame is eight steps of the SAME size, and the strand is the same strand", async () => {
    const at64 = await fall({ fps: 64, frames: 9, probeFrames: [8] });
    const at32 = await fall({ fps: 32, frames: 5, probeFrames: [1, 4] });
    expect(at32.heights).toEqual([fallen(8), fallen(32)]);
    // Half the frames, every byte the same: the rope does not know the frame rate.
    expect(Buffer.from(at32.last).equals(Buffer.from(at64.last))).toBe(true);
  }, 120_000);

  it("offline sub-frames are frames: four to a picture run one step each, and land on the same bytes", async () => {
    const at64 = await fall({ fps: 64, frames: 9, probeFrames: [8] });
    // `fps` is the rate the transport STEPS at: 256 sub-frames a second, four to a picture.
    const sub = await fall({ fps: 256, subframes: 4, frames: 33, probeFrames: [1, 4, 32] });
    expect(sub.heights).toEqual([fallen(1), fallen(4), fallen(32)]);
    expect(Buffer.from(sub.last).equals(Buffer.from(at64.last))).toBe(true);
  }, 120_000);

  /*
   * The other source of a count: a document that animates is compiled again every frame, at
   * that frame, and the animator pushes what the compile said. With the backend's own
   * derivation taken out this test alone stays green — which is the measure of the three
   * above: they are every host that renders a document in which nothing moves.
   */
  it("with the per-frame compile running too (a document that animates), the count is the same", async () => {
    const animated = await fall({ fps: 32, frames: 5, probeFrames: [1, 4], animate: true });
    expect(animated.heights).toEqual([fallen(8), fallen(32)]);
  }, 120_000);
});
