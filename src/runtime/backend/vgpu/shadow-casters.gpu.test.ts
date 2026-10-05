import { describe, expect, it } from "vitest";

import type { CompiledGraph } from "../../../compiler/index.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import type { ProjectSettings } from "../../../domain/types/graph.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { CASTER_MESHES, CASTERS_EYE, CASTERS_LOOK_AT, castersScene, sweepDraws, type CastersScene } from "../../../nodes/definitions/shadow-casters.fixture.ts";
import { renderHeadless, type HarnessControl } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1598b on a REAL device, to the byte (§V147): which geometry a light's shadow sweep draws.
 *
 * The scene is `shadow-casters.fixture.ts`: a floor, a box on it, a small lid hanging over
 * the box, a cube thirty metres away; a point light above the box and one out to the side,
 * both casting. Three places are read, each in exactly one shadow:
 *
 *   FLOOR_BY_BOX   on the floor, in the box's shadow from the TOP light, lit by the side light
 *   FLOOR_BEHIND   on the floor, in the box's shadow from the SIDE light, lit by the top light
 *   BOX_TOP        the middle of the box's top, in the LID's shadow from the top light
 *
 * Every claim is one picture against another, byte for byte: a shadow that is "gone" is the
 * picture with no shadows at that texel, and one that "stays" is the picture with them all.
 */

const SIZE = 128;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const FLOOR_BY_BOX: [number, number, number] = [-1.35, 0, 0.9];
const FLOOR_BEHIND: [number, number, number] = [2.5, 0, 0];
const BOX_TOP: [number, number, number] = [0, 1.5, 0];

const matrix = cameraPayloadMatrix({ eye: CASTERS_EYE, lookAt: CASTERS_LOOK_AT, fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
function texel(bytes: Uint8Array, world: readonly [number, number, number]): number[] {
  const clip = transformPoint(matrix, world);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  const at = (y * SIZE + x) * 4;
  return [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];
}

interface Rendered {
  readonly bytes: Uint8Array;
  readonly plan: CompiledGraph;
}

async function render(options: CastersScene = {}, run: { frames?: number; animate?: boolean; beforeFrames?: (control: HarnessControl) => void } = {}): Promise<Rendered> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: castersScene(options),
    settings: SETTINGS,
    frames: run.frames ?? 2,
    fps: 60,
    outputNodeId: "render_shot",
    outputPortId: "out",
    meshes: CASTER_MESHES,
    ...(run.animate === true ? { animate: true } : {}),
    ...(run.beforeFrames === undefined ? {} : { beforeFrames: run.beforeFrames }),
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  return { bytes: frame.bytes, plan: result.plan };
}

const UNSHADOWED: CastersScene = { top: { shadows: false }, side: { shadows: false } };

describe("a light's caster lists, on Dawn (T1598b, §V147)", () => {
  it("an excluded caster casts no shadow from THAT light, still casts from the other, and still receives", async () => {
    const all = (await render()).bytes;
    const none = (await render(UNSHADOWED)).bytes;
    // The scene is what the header says: each place is in a shadow, and only shadows put it there.
    for (const place of [FLOOR_BY_BOX, FLOOR_BEHIND, BOX_TOP]) expect(texel(all, place)).not.toEqual(texel(none, place));

    const excluded = (await render({ top: { shadowExclude: "geometry_box" } })).bytes;
    // The box's shadow from the top light is gone: the floor beside it is as lit as with no shadows at all.
    expect(texel(excluded, FLOOR_BY_BOX)).toEqual(texel(none, FLOOR_BY_BOX));
    // Per light: from the side light the box casts as before.
    expect(texel(excluded, FLOOR_BEHIND)).toEqual(texel(all, FLOOR_BEHIND));
    // And it still RECEIVES the top light's shadows: the lid's lies on it as before.
    expect(texel(excluded, BOX_TOP)).toEqual(texel(all, BOX_TOP));
  }, 240_000);

  it("Shadow Casters names the only casters: what is left out casts nothing, what is named casts as before", async () => {
    const all = (await render()).bytes;
    const none = (await render(UNSHADOWED)).bytes;
    const only = (await render({ top: { shadowCasters: "geometry_box" } })).bytes;
    // The lid is not named: its shadow on the box is gone.
    expect(texel(only, BOX_TOP)).toEqual(texel(none, BOX_TOP));
    // The box is: its shadow on the floor is where it was.
    expect(texel(only, FLOOR_BY_BOX)).toEqual(texel(all, FLOOR_BY_BOX));
    expect(texel(only, FLOOR_BEHIND)).toEqual(texel(all, FLOOR_BEHIND));
  }, 240_000);
});

describe("a caster a point light cannot reach, on Dawn (T1598b, §V147)", () => {
  it("is skipped face by face, and the picture is the one with nothing skipped", async () => {
    const culled = await render();
    const draws = sweepDraws(culled.plan.passes);
    // 2 lights × 6 faces × 4 geometries; the floor holds both lights, the far cube is out
    // of both ranges, and the box and the lid are each in one or two faces of each.
    expect([draws.length, draws.filter((draw) => draw.skip).length]).toEqual([48, 31]);
    expect(draws.filter((draw) => draw.role === "far" && !draw.skip)).toEqual([]);

    // The same document with every skipped draw drawn again: a skip may only ever remove
    // a draw that put nothing in the map.
    let drawnAgain = 0;
    const everything = await render({}, {
      beforeFrames: (control) => {
        for (const pass of control.plan.passes) {
          if (pass.kind !== "draw" || pass.skip !== true) continue;
          control.updateUniforms(pass.id, {}, false);
          drawnAgain += 1;
        }
      },
    });
    expect(drawnAgain).toBe(31);
    expect(Array.from(culled.bytes)).toEqual(Array.from(everything.bytes));
  }, 240_000);

  it("casts on the frame it comes into reach: a driven Transform un-skips its draws with no recompile", async () => {
    // The far cube, brought 27.5 m in: it stands beside the box, and the floor beyond it is in its shadow.
    const BEYOND: [number, number, number] = [3.5, 0, 0];
    const standing = await render({ geometry: { far: { translate: [-27.5, 0, 0] } } });
    expect(texel(standing.bytes, BEYOND)).not.toEqual(texel((await render()).bytes, BEYOND));

    // The same place reached by a value: out of range on frame 0, where the plan is built
    // with all six of its draws skipped, and there on frame 1, the frame captured.
    const arriving = await render({ geometry: { far: { "translate.x": expressionSlot("-abstime * 60 * 27.5", 0) } } }, { animate: true });
    expect(sweepDraws(arriving.plan.passes).filter((draw) => draw.light === 0 && draw.role === "far" && !draw.skip)).toEqual([]);
    expect(Array.from(arriving.bytes)).toEqual(Array.from(standing.bytes));
  }, 240_000);
});
