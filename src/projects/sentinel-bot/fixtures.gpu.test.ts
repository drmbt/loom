import { beforeAll, describe, expect, it } from "vitest";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { CHAMBERS, PATH, chamberAt, pathAt } from "./path.ts";
import { BORE_ATTRIBUTES, BORE_COLUMNS, BORE_KERNEL, BORE_ROWS, BORE_SURFACE_WGSL, FIXTURES, bulkheadAt, tubeAt } from "./tunnel.ts";

/**
 * T1561b — THE TUNNEL'S OTHER LAMPS, on a real GPU: the wall the kernel builds, under the
 * wall's own material, with no light in the scene, so a pixel holds only what the wall gives off.
 *
 * The owner asked for "different lights at different positions in the tube". What that owes
 * whoever looks: a lamp that works glows WHERE the rule puts it, a dead one is dark, a bore's
 * lamp is not in a hall nor a hall's in the bore, and the switch is the difference. Which lamp
 * works is whole numbers (tunnel.ts, FIXTURES), so the test asks the rule and then looks.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

type Vec = [number, number, number];
const SIZE = 65;
const BORE = 2.6;
/** With Lamp at 1 a pixel holds the material's own shares. */
const LAMP = 1;
/** What a lit bulkhead's lens and a lit tube's give off, per unit of Lamp (the material's own numbers). */
const BULKHEAD_LENS = [1, 0.5, 0.16].map((channel) => channel * 0.4);
const TUBE_LENS = [0.62, 1, 0.78].map((channel) => channel * 0.5);
/** The most a lit bulkhead throws on the wall at its own foot, per unit of Lamp: its share times the palest the liner is (0.16 at its lightest, its stain at most 1.15). */
const BULKHEAD_THROWN = 0.22 * 0.16 * 1.15;
/** …and a tube. */
const TUBE_THROWN = 0.1 * 0.16 * 1.15;

const map = (attribute: string, fallback: number[]): StoredParameter => ({ mode: "map", bindings: { static: { kind: "static", value: fallback }, map: { kind: "map", attribute } } });

/** The tunnel's frame at `z` (path.ts, pathFrame): right is level, up is what is left. */
function frameAt(z: number): { origin: Vec; right: Vec; up: Vec } {
  const [ahead, behind] = [pathAt(z + 0.01), pathAt(z - 0.01)];
  const along: Vec = [ahead[0] - behind[0], ahead[1] - behind[1], ahead[2] - behind[2]];
  const length = Math.hypot(...along);
  const forward: Vec = [along[0] / length, along[1] / length, along[2] / length];
  const level = Math.hypot(forward[2], forward[0]);
  const right: Vec = [forward[2] / level, 0, -forward[0] / level];
  const up: Vec = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]];
  return { origin: pathAt(z), right, up };
}

/** The middle pixel of a look from the tunnel's axis straight at the wall, `around` of a turn round it (0.5 the crown) at `z` along it. */
async function wallPixel(z: number, around: number, overrides: Record<string, number> = {}): Promise<number[]> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const frame = frameAt(z);
  const theta = (around - 0.25) * 2 * Math.PI;
  const radius = BORE * (1 + CHAMBERS.swell * chamberAt(z)) + 0.05;
  const wall = frame.origin.map((part, axis) => part + ((frame.right[axis] as number) * Math.cos(theta) + (frame.up[axis] as number) * Math.sin(theta)) * radius);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        node("grid_bore", "pointGrid", [0, 0], { cols: BORE_COLUMNS, rows: BORE_ROWS, count: BORE_COLUMNS * BORE_ROWS, sizeX: 2, sizeY: 2 }),
        // No relief: the wall stands exactly at its radius, so the look lands where the arithmetic says.
        node("kernel_bore", "pointKernel", [0, 0], { capacity: BORE_COLUMNS * BORE_ROWS, attributes: BORE_ATTRIBUTES, kernel: BORE_KERNEL, travel: z, relief: 0 }),
        // No grime: a sooted lens gives less, by a noise this test cannot know.
        node("material_bore", "materialWgsl", [0, 0], { model: "pbr", source: BORE_SURFACE_WGSL, lamp: LAMP, bore: BORE, grime: 0, ...overrides }, { label: "material_bore" }),
        node("geometry_bore", "geometry", [0, 0], { mode: "surface", material: "material_bore", tint: map("tint", [0, 0, 0, 0]) as never }, { label: "geometry_bore" }),
        node("camera_axis", "camera", [0, 0], { eye: [...frame.origin], lookAt: wall }, { label: "camera_axis" }),
        node("render_shot", "render", [0, 0], { scenes: "geometry_bore", camera: "camera_axis", lights: "", ambientColor: [1, 1, 1, 1], ambientIntensity: 0 }, { label: "render_shot" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [edge("grid-bore", ["grid_bore", "out"], ["kernel_bore", "in"]), edge("bore-geo", ["kernel_bore", "out"], ["geometry_bore", "points"]), edge("shot-out", ["render_shot", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: SIZE, height: SIZE }, workingFormat: "rgba8unorm" }),
    frames: 2,
    outputNodeId: "render_shot",
    outputPortId: "out",
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  const frameBytes = result.frames[result.frames.length - 1];
  if (frameBytes === undefined) throw new Error("no frame captured");
  const at = (Math.floor(SIZE / 2) * SIZE + Math.floor(SIZE / 2)) * 4;
  return [frameBytes.bytes[at] ?? -1, frameBytes.bytes[at + 1] ?? -1, frameBytes.bytes[at + 2] ?? -1];
}

const bulkheadZ = (index: number): number => (index + FIXTURES.bulkheadAlong) * FIXTURES.spacing;
const tubeZ = (index: number): number => (index + FIXTURES.tubeAlong) * FIXTURES.spacing;
const COUNT = Math.round(PATH.period / FIXTURES.spacing);
/** The first fixture along the lap that answers `wanted`. */
function first(wanted: (index: number) => boolean): number {
  for (let index = 2; index < COUNT; index += 1) if (wanted(index)) return index;
  throw new Error("no such fixture in the lap: the runs in FIXTURES have changed, choose the case again");
}
/** Each channel within what the lens alone gives and the lens with the most the wall can add under it. */
function expectLit(pixel: number[], lens: number[], thrown: number): void {
  for (const [channel, share] of lens.entries()) {
    expect(pixel[channel]).toBeGreaterThanOrEqual(Math.round(share * LAMP * 255));
    expect(pixel[channel]).toBeLessThanOrEqual(Math.round((share + thrown * (lens[channel] as number) / Math.max(...lens)) * LAMP * 255) + 1);
  }
}

describe("the tunnel's other lamps (T1561b)", () => {
  it("a bulkhead that works glows amber on its wall of the bore; a dead one is dark, and so is the wall when the lamps are switched off", async () => {
    const lit = first((index) => bulkheadAt(index).state === 1 && chamberAt(bulkheadZ(index)) === 0);
    // Its neighbours are 3.2 m off: what a lit one throws that far is a fiftieth of a byte.
    const dead = first((index) => bulkheadAt(index).state === 0 && chamberAt(bulkheadZ(index)) === 0);
    const sideOf = (index: number): number => 0.5 + FIXTURES.bulkheadSide * bulkheadAt(index).wall;
    expectLit(await wallPixel(bulkheadZ(lit), sideOf(lit)), BULKHEAD_LENS, BULKHEAD_THROWN);
    // The wall across from it has no lens: only what the lamp would throw that far, which is nothing a byte holds.
    expect(await wallPixel(bulkheadZ(lit), 1 - sideOf(lit))).toEqual([0, 0, 0]);
    expect(await wallPixel(bulkheadZ(dead), sideOf(dead))).toEqual([0, 0, 0]);
    expect(await wallPixel(bulkheadZ(lit), sideOf(lit), { fixtures: 0 })).toEqual([0, 0, 0]);
  }, 240_000);

  it("a hall has tubes along its shoulders and no bulkheads; the bore has no tubes", async () => {
    const inHall = (z: number): boolean => chamberAt(z) === 1;
    const tube = first((index) => inHall(tubeZ(index)) && tubeAt(index, 1) === 1);
    expectLit(await wallPixel(tubeZ(tube), 0.5 + FIXTURES.tubeSide), TUBE_LENS, TUBE_THROWN);
    // The same place on a tube that is dead.
    const deadTube = first((index) => inHall(tubeZ(index)) && tubeAt(index, 1) === 0);
    expect(await wallPixel(tubeZ(deadTube), 0.5 + FIXTURES.tubeSide)).toEqual([0, 0, 0]);
    // Where the rule has a working tube but the tunnel is plain bore, and the bulkheads either side are dead: no tube.
    const noTube = first((index) => chamberAt(tubeZ(index)) === 0 && tubeAt(index, 1) === 1 && bulkheadAt(index).state === 0 && bulkheadAt(index - 1).state === 0);
    expect(await wallPixel(tubeZ(noTube), 0.5 + FIXTURES.tubeSide)).toEqual([0, 0, 0]);
    // Where the rule has a working bulkhead but the tunnel is a hall, and the tubes of that wall are dead there: no bulkhead.
    const noBulkhead = first((index) => inHall(bulkheadZ(index)) && bulkheadAt(index).state === 1 && tubeAt(index, bulkheadAt(index).wall) === 0 && tubeAt(index + 1, bulkheadAt(index).wall) === 0);
    expect(await wallPixel(bulkheadZ(noBulkhead), 0.5 + FIXTURES.bulkheadSide * bulkheadAt(noBulkhead).wall)).toEqual([0, 0, 0]);
  }, 240_000);
});
