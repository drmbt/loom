import { describe, expect, it } from "vitest";

import type { ProjectSettings } from "../../../domain/types/graph.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHADOW_LAYERS_MESHES, castingLamp, castingSun, shadowLayersScene } from "../../../nodes/definitions/shadow-layers.fixture.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1688b on a REAL device (§V147): a casting light's shadow put out and brought back by a
 * value, Shadow On.
 *
 * The scene is `shadow-layers.fixture.ts`: a floor, a box over its middle and a plate off it,
 * seen from above, under casting lights of the test's own. Every claim is an equality of
 * whole frames, byte for byte:
 *
 *  - out, the picture is the picture of the same light with Cast Shadows off;
 *  - out, the light beside it keeps its shadow;
 *  - the frame it comes back, the shadow is where the caster is NOW, a caster that moved
 *    while the shadow was out: nothing of the map from before is left to read;
 *  - driven by an expression, any value but 0 is on.
 */

const SIZE = 96;
const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};
type Parameters = Record<string, unknown>;

/** The frames asked for, each as its bytes. */
async function frames(lights: ReadonlyArray<Parameters>, run: { box?: Parameters; count?: number; capture?: number[]; animate?: boolean } = {}): Promise<number[][]> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const count = run.count ?? 2;
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: shadowLayersScene(lights, {}, run.box ?? {}),
    settings,
    frames: count,
    fps: 60,
    capture: run.capture ?? [count - 1],
    outputNodeId: "render_shot",
    outputPortId: "out",
    meshes: SHADOW_LAYERS_MESHES,
    ...(run.animate === true ? { animate: true } : {}),
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  expect(result.frames).toHaveLength((run.capture ?? [count - 1]).length);
  return result.frames.map((frame) => Array.from(frame.bytes));
}
const frame = async (lights: ReadonlyArray<Parameters>, run: Parameters = {}): Promise<number[]> => (await frames(lights, run))[0] as number[];
const differing = (a: number[], b: number[]): number => a.reduce((total, value, index) => total + (value === b[index] ? 0 : 1), 0);

const EAST = [1, -1, 0] as const;
const SOUTH = [0, -1, 1] as const;
const OUT = { shadowOn: false };

describe("T1688b: a casting light's shadow, out by a value, on Dawn (§V147)", () => {
  it.each([
    ["a sun", castingSun(EAST, 1)],
    ["a point light", castingLamp([-2, 3, 0], 12)],
    ["a soft sun (Shadow Softness 2, 25 reads of a map that holds nothing)", castingSun(EAST, 1, { shadowSoftness: 2 })],
  ])("%s with Shadow On off is the picture of that light with Cast Shadows off, byte for byte, and not the picture with its shadow", async (_name, light) => {
    const out = await frame([{ ...light, ...OUT }]);
    expect(differing(out, await frame([{ ...light, shadows: false }]))).toBe(0);
    // The shadow it does not draw is a real one: with it on the picture is another.
    expect(differing(out, await frame([light]))).toBeGreaterThan(100);
  }, 240_000);

  it("puts out that light's shadow alone: the light beside it casts as it did", async () => {
    const lamp = castingLamp([-2, 3, 0], 12);
    const sun = castingSun(SOUTH, 0.5);
    // The lamp's shadow out, the sun's on: the picture with a lamp that does not cast, and a sun that does.
    expect(differing(await frame([{ ...lamp, ...OUT }, sun]), await frame([{ ...lamp, shadows: false }, sun]))).toBe(0);
    // And the other way round.
    expect(differing(await frame([lamp, { ...sun, ...OUT }]), await frame([lamp, { ...sun, shadows: false }]))).toBe(0);
  }, 240_000);

  it("comes back on the frame its value says, with the shadow of the box where the box is NOW: the map holds nothing of the frame it went out on", async () => {
    /* Four frames. The box travels half a metre a frame, the whole time. The shadow is on at
       frame 0, out at frames 1 and 2, and back at frame 3: floor(|f − 1.5|) is 1, 0, 0, 1. */
    const box = { "translate.x": expressionSlot("abstime * 60 * 0.5", 0) };
    const sun = castingSun(EAST, 1);
    const run = { box, count: 4, capture: [0, 1, 2, 3], animate: true };
    const switched = await frames([{ ...sun, shadowOn: expressionSlot("floor(abs(abstime * 60 - 1.5))", true) }], run);
    const alwaysOn = await frames([sun], run);
    const neverCasting = await frames([{ ...sun, shadows: false }], run);
    // The box does move, and its shadow with it: the frames are four pictures.
    expect(differing(alwaysOn[0] as number[], alwaysOn[3] as number[])).toBeGreaterThan(100);
    expect(differing(alwaysOn[2] as number[], alwaysOn[3] as number[])).toBeGreaterThan(100);
    // On, out, out, on: each frame is the frame of the document that was that way all along.
    expect(differing(switched[0] as number[], alwaysOn[0] as number[])).toBe(0);
    expect(differing(switched[1] as number[], neverCasting[1] as number[])).toBe(0);
    expect(differing(switched[2] as number[], neverCasting[2] as number[])).toBe(0);
    expect(differing(switched[3] as number[], alwaysOn[3] as number[])).toBe(0);
  }, 240_000);

  it("driven by an expression, any value but 0 is on: a half is the whole shadow, and there is no half shadow", async () => {
    const sun = castingSun(EAST, 1);
    const on = await frame([sun], { animate: true });
    expect(differing(await frame([{ ...sun, shadowOn: expressionSlot("0.5", true) }], { animate: true }), on)).toBe(0);
    expect(differing(await frame([{ ...sun, shadowOn: expressionSlot("-1", true) }], { animate: true }), on)).toBe(0);
    expect(differing(await frame([{ ...sun, shadowOn: expressionSlot("0", true) }], { animate: true }), await frame([{ ...sun, shadows: false }], { animate: true }))).toBe(0);
  }, 240_000);
});
