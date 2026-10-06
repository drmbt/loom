import { describe, expect, it } from "vitest";

import type { CompiledGraph } from "../../../compiler/index.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import type { ProjectSettings } from "../../../domain/types/graph.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import {
  FLOOR_ALBEDO,
  LAMP_HEIGHT,
  LAMP_INTENSITY,
  LAMP_RANGE,
  THREE_LAMPS_AT,
  TOP_CAMERA,
  lampOnFloor,
  lampsScene,
  mapped,
  namedLights,
  spotShare,
  type LampsScene,
} from "../../../nodes/definitions/light-points.fixture.ts";
import { NAMED_LIGHT_STEP, lightGridDimensions, lightTableStorage, namedLightCapacity } from "../../../nodes/definitions/light-records.ts";
import { LIGHT_TABLE_HEADER, LIGHT_TABLE_HEADER_WORDS } from "../../../nodes/shaders/scene-lights.wgsl.ts";
import { TOLERANCE_CROSS_GPU_HDR, pixelAt } from "../../../tests/headless/pixel-compare.ts";
import { renderHeadless, type HarnessControl, type RenderedFrame } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1623b, slice 3, on a REAL device (§V147): a Light in Single mode that does not cast is a
 * row of the Render's light table.
 *
 * The scenes are `light-points.fixture.ts`'s floor, seen from straight above with no ambient,
 * under Lights in Single mode (`namedLights`). A pixel no light reaches is exactly black, and
 * a pixel one light reaches is that light by the Render's own arithmetic (`lampOnFloor`).
 *
 * Where a number is known from the scene it is asserted as that number, to the precision a
 * half float holds. Where the claim is that two documents are one picture (two orders of the
 * list; a driven value and the same value stored; the grid and one cell), the two frames are
 * compared byte for byte.
 */

const SIZE = 128;
const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

type Parameters = Record<string, unknown>;
interface Run {
  readonly frames?: number;
  readonly capture?: ReadonlyArray<number>;
  readonly animate?: boolean;
  readonly beforeFrames?: (control: HarnessControl) => void;
  readonly probeBuffers?: ReadonlyArray<string>;
}
interface Rendered {
  readonly frames: ReadonlyArray<RenderedFrame>;
  readonly last: RenderedFrame;
  readonly plan: CompiledGraph;
  readonly buffers: Readonly<Record<string, ArrayBuffer>>;
}

async function render(options: LampsScene, run: Run = {}): Promise<Rendered> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: lampsScene(options),
    settings,
    frames: run.frames ?? 2,
    fps: 60,
    outputNodeId: "render_shot",
    outputPortId: "out",
    ...(run.animate === true ? { animate: true } : {}),
    ...(run.capture === undefined ? {} : { capture: run.capture }),
    ...(run.beforeFrames === undefined ? {} : { beforeFrames: run.beforeFrames }),
    ...(run.probeBuffers === undefined ? {} : { probeBuffers: run.probeBuffers }),
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const last = result.frames[result.frames.length - 1];
  if (last === undefined) throw new Error("no frame captured");
  return { frames: result.frames, last, plan: result.plan, buffers: result.buffers ?? {} };
}

/** The pixel a world point lands in, under the fixture's camera straight above the floor. */
function pixelOf(world: readonly [number, number, number]): [number, number] {
  const matrix = cameraPayloadMatrix(
    { eye: TOP_CAMERA["eye"] as [number, number, number], lookAt: TOP_CAMERA["lookAt"] as [number, number, number], fovDeg: 55, near: 0.1, far: 40, ortho: true, orthoHeight: 16, roll: 0 },
    1,
  );
  const clip = transformPoint(matrix, world);
  return [Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE), Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE)];
}
/** The colour of the pixel straight under a place, seen from above. */
const under = (frame: RenderedFrame, x: number, z: number): number[] => {
  const [px, py] = pixelOf([x, 0, z]);
  return pixelAt(frame, px, py).slice(0, 3);
};
/** A lit value as a half float holds it: within one part in 1,024 of the scene's own arithmetic. */
const expectLit = (actual: number | undefined, expected: number): void => {
  expect(Math.abs((actual ?? Number.NaN) - expected) / expected).toBeLessThan(TOLERANCE_CROSS_GPU_HDR);
};
const differingBytes = (a: Uint8Array, b: Uint8Array): number => {
  let count = a.length === b.length ? 0 : Math.max(a.length, b.length);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) count += 1;
  return count;
};
/** The most two pictures differ by in one channel, in steps of a half float's own bits. */
const largestStep = (a: Uint8Array, b: Uint8Array): number => {
  const x = new Uint16Array(a.buffer, a.byteOffset, a.byteLength / 2);
  const y = new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
  let worst = 0;
  for (let index = 0; index < x.length; index += 1) worst = Math.max(worst, Math.abs((x[index] as number) - (y[index] as number)));
  return worst;
};
const bare = (id: string): string => id.slice(id.indexOf("#") + 1);
const litText = (plan: CompiledGraph): string => String((plan.passes as ReadonlyArray<{ id: string; shader?: string }>).find((pass) => bare(pass.id) === "render_shot:scene:0")?.shader);
const tableFor = (named: number, points = 0) => lightTableStorage("render_shot", namedLightCapacity(named) + points, lightGridDimensions([SIZE, SIZE]));

/** Where the fixture's three lamps stand along x, and the row they stand on: pixel centres. */
const [LEFT, MIDDLE, RIGHT] = THREE_LAMPS_AT;
const ROW = 0.0625;
const SQUARE = { falloff: "inverseSquare" } as const;

describe("a Light in Single mode that does not cast is a row, on Dawn (T1623b slice 3, §V147)", () => {
  it("lights the floor from a named point light, a named sun and a named spot, each by the Render's own arithmetic and through its own walk", async () => {
    // Red: a point light with no Range over the left of the row. Green: a sun, straight down.
    // Blue: a spot over the right, straight down, sixty degrees with a hard edge. The sun's
    // and the spot's Direction are three units long: a direction has no length that matters.
    const SUN = 0.25;
    const scene = namedLights([
      { kind: "point", ...SQUARE, color: [1, 0, 0, 1], intensity: LAMP_INTENSITY, position: [LEFT, LAMP_HEIGHT, ROW] },
      { kind: "directional", color: [0, 1, 0, 1], intensity: SUN, direction: [0, -3, 0] },
      { kind: "spot", ...SQUARE, color: [0, 0, 1, 1], intensity: LAMP_INTENSITY, position: [RIGHT, LAMP_HEIGHT, ROW], direction: [0, -3, 0], cone: 60, coneSoftness: 0 },
    ]);
    const table = tableFor(3);
    const lit = await render(scene, { probeBuffers: [table.resourceId] });
    // Not one block of shader: the three are rows.
    expect(litText(lit.plan)).not.toMatch(/light\d+Meta/);
    // The header, off the device: three rows, all of which reach every pixel; one of any
    // kind (the spot), then one point light, then one sun.
    const header = new Uint32Array(lit.buffers[table.resourceId] ?? new ArrayBuffer(0)).slice(0, LIGHT_TABLE_HEADER_WORDS);
    expect([header[LIGHT_TABLE_HEADER.regionRows], header[LIGHT_TABLE_HEADER.rows], header[LIGHT_TABLE_HEADER.general], header[LIGHT_TABLE_HEADER.points], header[LIGHT_TABLE_HEADER.always]]).toEqual([NAMED_LIGHT_STEP, 3, 1, 2, 3]);

    // Under the point light: its own value; the sun's everywhere; nothing of the spot, eight units off its axis.
    const left = under(lit.last, LEFT, ROW);
    expectLit(left[0], lampOnFloor(LAMP_INTENSITY, 0));
    expectLit(left[1], FLOOR_ALBEDO * SUN);
    expect(left[2]).toBe(0);
    // Four units along: the point light by the inverse square alone (no Range, no window).
    expectLit(under(lit.last, MIDDLE, ROW)[0], lampOnFloor(LAMP_INTENSITY, 0, LAMP_HEIGHT, 4));
    // Under the spot, on its axis: the point light's value. One unit aside (26.6 degrees) still whole; 1.25 aside (32.0 degrees) nothing.
    const right = under(lit.last, RIGHT, ROW);
    expectLit(right[2], lampOnFloor(LAMP_INTENSITY, 0));
    expectLit(under(lit.last, RIGHT, ROW + 1)[2], lampOnFloor(LAMP_INTENSITY, 0, LAMP_HEIGHT, 1));
    expect(under(lit.last, RIGHT, ROW + 1.25)[2]).toBe(0);
    // The sun is the same everywhere on a flat floor, wherever its Light's Position says it stands.
    for (const [x, z] of [[RIGHT, ROW + 1.25], [-7.9375, 7.9375], [7.0625, -7.9375]] as const) expectLit(under(lit.last, x, z)[1], FLOOR_ALBEDO * SUN);

    // A soft cone: a share of the light in the fade, by the cone's own two cosines.
    const soft = await render(namedLights([{ kind: "spot", ...SQUARE, color: [0, 0, 1, 1], intensity: LAMP_INTENSITY, position: [RIGHT, LAMP_HEIGHT, ROW], direction: [0, -1, 0], cone: 60, coneSoftness: 0.4 }]));
    const aside = 0.875;
    const cosine = LAMP_HEIGHT / Math.hypot(LAMP_HEIGHT, aside);
    const share = spotShare(60, 0.4, cosine);
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.9);
    expectLit(under(soft.last, RIGHT, ROW + aside)[2], lampOnFloor(LAMP_INTENSITY, 0, LAMP_HEIGHT, aside) * share);
    // A slanted sun: the floor takes the cosine.
    const slanted = await render(namedLights([{ kind: "directional", color: [0, 1, 0, 1], intensity: SUN, direction: [0, -1, -1] }]));
    expectLit(under(slanted.last, MIDDLE, ROW)[1], FLOOR_ALBEDO * SUN * Math.SQRT1_2);
  }, 240_000);

  it("finds a named Light with a Range through the grid: its value inside, exactly nothing beyond, and the picture through one cell", async () => {
    const scene = namedLights([
      { kind: "point", ...SQUARE, color: [1, 0, 0, 1], intensity: LAMP_INTENSITY, range: LAMP_RANGE, position: [LEFT, LAMP_HEIGHT, ROW] },
      { kind: "spot", ...SQUARE, color: [0, 0, 1, 1], intensity: LAMP_INTENSITY, range: LAMP_RANGE, position: [RIGHT, LAMP_HEIGHT, ROW], direction: [0, -1, 0], cone: 60, coneSoftness: 0 },
    ]);
    const table = tableFor(2);
    const culled = await render(scene, { probeBuffers: [table.resourceId] });
    // Neither reaches every pixel: both are found through the cells.
    const words = new Uint32Array(culled.buffers[table.resourceId] ?? new ArrayBuffer(0));
    expect([words[LIGHT_TABLE_HEADER.always], words[LIGHT_TABLE_HEADER.rows]]).toEqual([0, 2]);
    expectLit(under(culled.last, LEFT, ROW)[0], lampOnFloor());
    expectLit(under(culled.last, RIGHT, ROW)[2], lampOnFloor());
    // 2.25 aside is 3.01 from the lamp, past a Range of 3: nothing, and not a small number.
    expect(under(culled.last, LEFT, ROW + 2.25)).toEqual([0, 0, 0]);
    expect(under(culled.last, MIDDLE, ROW)).toEqual([0, 0, 0]);
    // The grid left them out of cells: some hold neither, none holds what no cell could.
    const held = Array.from({ length: table.cells }, (_, cell) => words[table.cellsAt + cell * table.words] ?? 0);
    expect(new Set(held)).toEqual(new Set([0, 1, 2]));
    // And it is invisible: with the grid's dimensions set to one cell, as values, every pixel walks both rows and the picture is the same bytes.
    const walked = await render(scene, {
      beforeFrames: (control) => {
        for (const pass of control.plan.passes as ReadonlyArray<{ id: string; uniforms?: Record<string, unknown> }>) {
          const key = bare(pass.id).endsWith(":lights:grid") ? "grid" : pass.uniforms?.["lightGrid"] !== undefined ? "lightGrid" : undefined;
          if (key !== undefined) control.updateUniforms(pass.id, { [key]: [1, 1, 1, 1] });
        }
      },
    });
    expect(differingBytes(culled.last.bytes, walked.last.bytes)).toBe(0);

    // BOTH WALKS IN ONE PICTURE: a sun beside the two. It is the one row that reaches every
    // pixel, no cell holds it, and each pixel takes it once: the sun's value where neither
    // lamp reaches, and the sun's and the lamp's under the lamp.
    const SUN = 0.25;
    const both = await render(namedLights([...(scene.nodes ?? []).map((entry) => entry.parameters), { kind: "directional", color: [0, 1, 0, 1], intensity: SUN, direction: [0, -1, 0] }]), { probeBuffers: [table.resourceId] });
    const mixed = new Uint32Array(both.buffers[table.resourceId] ?? new ArrayBuffer(0));
    expect([mixed[LIGHT_TABLE_HEADER.always], mixed[LIGHT_TABLE_HEADER.rows]]).toEqual([1, 3]);
    expect(under(both.last, MIDDLE, ROW)).toEqual([0, under(both.last, -7.9375, 7.9375)[1], 0]);
    expectLit(under(both.last, MIDDLE, ROW)[1], FLOOR_ALBEDO * SUN);
    const lamp = under(both.last, LEFT, ROW);
    expectLit(lamp[0], lampOnFloor());
    expectLit(lamp[1], FLOOR_ALBEDO * SUN);
    // The sun's row is in no cell: the two lamps are rows 1 and 2 now, and no mask has bit 0.
    const masks = Array.from({ length: table.cells }, (_, cell) => mixed[table.cellsAt + cell * table.words] ?? 0);
    expect(new Set(masks)).toEqual(new Set([0, 2, 4]));
  }, 240_000);

  it("sums the lights in the Render's list order: two swapped are the same bytes, and three are the list's picture whatever their nodes are called", async () => {
    // Three white point lights with no Range, each reaching every pixel, of three intensities
    // at three heights: every pixel is a sum of three terms of three sizes.
    const lights: Parameters[] = [
      { kind: "point", ...SQUARE, intensity: 1.7, position: [LEFT, LAMP_HEIGHT, ROW] },
      { kind: "point", ...SQUARE, intensity: 2.3, position: [MIDDLE, 3, 2.0625] },
      { kind: "point", ...SQUARE, intensity: 0.9, position: [RIGHT, 1.5, -1.9375] },
    ];
    // TWO: a sum of two terms does not depend on which is added first.
    const two = await render(namedLights(lights.slice(0, 2)));
    const swapped = await render(namedLights(lights.slice(0, 2), { lights: "light_n1 light_n0" }));
    expect(differingBytes(two.last.bytes, swapped.last.bytes)).toBe(0);
    // The picture is of both: under the first, its own value and the second's from where it stands.
    const pixel = under(two.last, LEFT, ROW);
    pixel.forEach((value) => expectLit(value, lampOnFloor(1.7, 0) + lampOnFloor(2.3, 0, 3, Math.hypot(MIDDLE - LEFT, 2))));

    // THREE: the order of the sum is the LIST's. The same three Lights listed in the same
    // order from nodes whose names sort the other way round are the same bytes.
    const listed = await render(namedLights(lights));
    const renamed = await render({
      unwired: true,
      nodes: [
        { id: "light_zenith", type: "light", parameters: lights[0] as Parameters },
        { id: "light_middle", type: "light", parameters: lights[1] as Parameters },
        { id: "light_alpha", type: "light", parameters: lights[2] as Parameters },
      ],
      lights: "light_zenith light_middle light_alpha",
    });
    expect(differingBytes(listed.last.bytes, renamed.last.bytes)).toBe(0);
    // Listed backwards the same lights are summed backwards: the same picture to the last bit of a half float, and not required to be more.
    const backwards = await render(namedLights(lights, { lights: "light_n2 light_n1 light_n0" }));
    expect(largestStep(listed.last.bytes, backwards.last.bytes)).toBeLessThanOrEqual(1);
  }, 240_000);

  it("writes a driven Light every frame: its Intensity as it moves, and its Type through a sun, a point light and a spot, each the picture of that Type stored", async () => {
    // Intensity counts 2, 3, 4, 5 with the frames of a 60 Hz render.
    const breathing = await render(namedLights([{ kind: "point", ...SQUARE, intensity: expressionSlot("2 + abstime * 60", 2), position: [MIDDLE, LAMP_HEIGHT, ROW] }]), { frames: 4, capture: [0, 1, 3], animate: true });
    expect(breathing.frames.map((frame) => frame.frameIndex)).toEqual([0, 1, 3]);
    breathing.frames.forEach((frame) => under(frame, MIDDLE, ROW).forEach((value) => expectLit(value, lampOnFloor(2 + frame.frameIndex, 0))));

    // Type counts 0, 1, 2: the row moves from the suns' loop to the point lights' to the rows of any kind.
    const light = (kind: unknown): Parameters => ({ kind, ...SQUARE, color: [0, 1, 0, 1], intensity: LAMP_INTENSITY, position: [MIDDLE, LAMP_HEIGHT, ROW], direction: [0, -1, 0], cone: 50, coneSoftness: 0.3 });
    const beside = { kind: "point", ...SQUARE, color: [1, 0, 0, 1], intensity: 1, position: [LEFT, LAMP_HEIGHT, ROW] };
    const driven = await render(namedLights([beside, light(expressionSlot("floor(abstime * 60 + 0.5)", 0))]), { frames: 3, capture: [0, 1, 2], animate: true });
    const kinds = ["directional", "point", "spot"] as const;
    for (const [index, kind] of kinds.entries()) {
      const stored = await render(namedLights([beside, light(kind)]));
      expect([kind, differingBytes((driven.frames[index] as RenderedFrame).bytes, stored.last.bytes)]).toEqual([kind, 0]);
    }
    // The three are three pictures: far along the floor a sun lights, a point light barely does, and a spot of 50 degrees does not at all.
    const far = (frame: RenderedFrame | undefined): number => under(frame as RenderedFrame, MIDDLE, 6.0625)[1] as number;
    expectLit(far(driven.frames[0]), FLOOR_ALBEDO * LAMP_INTENSITY);
    expectLit(far(driven.frames[1]), lampOnFloor(LAMP_INTENSITY, 0, LAMP_HEIGHT, 6));
    expect(far(driven.frames[2])).toBe(0);
  }, 240_000);

  it("holds more named Lights than one step of rows, in every word of a cell: forty lights are one light's value, with a Range and without", async () => {
    const COUNT = NAMED_LIGHT_STEP + 8;
    const at: Parameters = { kind: "point", ...SQUARE, position: [MIDDLE, LAMP_HEIGHT, ROW] };
    // With no Range: forty rows of the point lights' loop, twenty turns of two.
    const forty = await render(namedLights(Array.from({ length: COUNT }, () => ({ ...at, intensity: LAMP_INTENSITY / COUNT }))));
    under(forty.last, MIDDLE, ROW).forEach((value) => expectLit(value, lampOnFloor(LAMP_INTENSITY, 0)));
    under(forty.last, MIDDLE, ROW + 3).forEach((value) => expectLit(value, lampOnFloor(LAMP_INTENSITY, 0, LAMP_HEIGHT, 3)));
    // With a Range, and the first thirty-two switched off: the eight that light are rows 32
    // to 39, the second word of a cell's mask. The off ones are in no cell.
    const table = tableFor(COUNT);
    const second = await render(
      namedLights(Array.from({ length: COUNT }, (_, index) => ({ ...at, range: LAMP_RANGE, intensity: index < NAMED_LIGHT_STEP ? 0 : LAMP_INTENSITY / 8 }))),
      { probeBuffers: [table.resourceId] },
    );
    under(second.last, MIDDLE, ROW).forEach((value) => expectLit(value, lampOnFloor()));
    expect(under(second.last, MIDDLE, ROW + 2.25)).toEqual([0, 0, 0]);
    const words = new Uint32Array(second.buffers[table.resourceId] ?? new ArrayBuffer(0));
    expect([words[LIGHT_TABLE_HEADER.regionRows], words[LIGHT_TABLE_HEADER.words], words[LIGHT_TABLE_HEADER.rows]]).toEqual([2 * NAMED_LIGHT_STEP, 2, COUNT]);
    const [px, py] = pixelOf([MIDDLE, 0, ROW]);
    const grid = lightGridDimensions([SIZE, SIZE]);
    const tile = Math.floor((px * grid[0]) / SIZE) + grid[0] * Math.floor((py * grid[1]) / SIZE);
    // Some slice of that tile holds the eight, in its second word, and its first word is empty in every slice.
    const masks = Array.from({ length: grid[2] }, (_, slice) => [0, 1].map((word) => words[table.cellsAt + (tile + grid[0] * grid[1] * slice) * table.words + word] ?? 0));
    expect(masks.every(([first]) => first === 0)).toBe(true);
    expect(masks.some(([, last]) => last === 0xff)).toBe(true);
  }, 240_000);

  it("gathers nine Lights in Points mode into one Render, past the seven one pass could bind: each set a ninth of the light", async () => {
    const names = Array.from({ length: 8 }, (_, index) => `light_set${index}`);
    const ninth = { mode: "points", kind: "point", ...SQUARE, intensity: LAMP_INTENSITY / 9, range: LAMP_RANGE, color: mapped("color", [1, 1, 1, 1]) };
    const nine = await render({
      light: { intensity: LAMP_INTENSITY / 9, color: mapped("color", [1, 1, 1, 1]) },
      nodes: names.map((id) => ({ id, type: "light", parameters: ninth })),
      edges: names.map((id) => ["kernel_lamps", id, "points"] as const),
      lights: ["light_lamps", ...names].join(" "),
    });
    expect((nine.plan.passes as ReadonlyArray<{ id: string }>).filter((pass) => bare(pass.id).startsWith("render_shot:lights:gather:"))).toHaveLength(10);
    // Under each lamp: nine ninths of that lamp, in its colour, and nothing of the others.
    THREE_LAMPS_AT.forEach((x, lamp) => {
      under(nine.last, x, ROW).forEach((value, channel) => {
        if (channel === lamp) expectLit(value, lampOnFloor());
        else expect([lamp, channel, value]).toEqual([lamp, channel, 0]);
      });
    });
  }, 240_000);

  it("walks the table of a Render that lists no light, and finds nothing in it: the ambient alone, to the byte of a half", async () => {
    const dark = await render(namedLights([]));
    expect(litText(dark.plan)).toContain("lightTable");
    expect(dark.last.bytes.every((byte, index) => index % 8 >= 6 || byte === 0)).toBe(true);
    const ambient = await render(namedLights([], { render: { ambientIntensity: 0.5 } }));
    // 0.8 × 0.5 = 0.4, which a half float holds as 0x3e66: one value in every pixel of the floor.
    const floor = under(ambient.last, MIDDLE, ROW);
    expect(floor).toEqual(under(ambient.last, -7.9375, 7.9375));
    floor.forEach((value) => expectLit(value, FLOOR_ALBEDO * 0.5));
  }, 240_000);

  it("adds a casting Light's block and the table's rows into one sum: a casting sun and a named point light on one floor", async () => {
    const SUN = 0.25;
    const scene = namedLights([
      { kind: "directional", color: [1, 1, 1, 1], intensity: SUN, direction: [0, -1, 0], shadows: true, shadowExtent: 10 },
      { kind: "point", ...SQUARE, color: [1, 0, 0, 1], intensity: LAMP_INTENSITY, position: [LEFT, LAMP_HEIGHT, ROW] },
    ]);
    const lit = await render(scene);
    // One block, the casting sun's, under its guard; the point light is a row.
    const text = litText(lit.plan);
    expect(text).toContain("light0Meta");
    expect(text).not.toContain("light1Meta");
    expect(text).toContain("if (lightMeta.y != 0.0) {");
    // Nothing stands over the floor: the sun's shadow map holds no caster in front of it.
    const pixel = under(lit.last, LEFT, ROW);
    expectLit(pixel[0], FLOOR_ALBEDO * SUN + lampOnFloor(LAMP_INTENSITY, 0));
    expectLit(pixel[1], FLOOR_ALBEDO * SUN);
    expectLit(under(lit.last, RIGHT, ROW)[2], FLOOR_ALBEDO * SUN);
  }, 240_000);
});

describe("a Surface and a primitive instance under one named Light (T1623b slice 3)", () => {
  /* The lamps' three points carry a box each, a unit across (Size is its half), drawn as primitive instances;
     the floor is a Surface. One Light in Single mode lights both: the floor as a row of the
     table, the boxes as the block the instances generator still unrolls (until slice 7). */
  const boxes = (lights: ReadonlyArray<Parameters>): LampsScene =>
    namedLights(lights, {
      unwired: false,
      nodes: [{ id: "geometry_boxes", type: "geometry", parameters: { mode: "instances", shape: "box", scale: 0.5 } }],
      edges: [["kernel_lamps", "geometry_boxes", "points"]],
      scenes: "geometry_floor geometry_boxes",
      lights: lights.map((_, index) => `light_n${index}`).join(" "),
    });
  /** The top of a unit box centred at the lamps' height. */
  const TOP = LAMP_HEIGHT + 0.5;
  const HIGH = 6;

  it("lights both from the same values: the box's top by its distance, the floor beside it by its own, under a point light and under a sun", async () => {
    const point = await render(boxes([{ kind: "point", ...SQUARE, color: [1, 1, 1, 1], intensity: 9, position: [MIDDLE, HIGH, ROW] }]));
    const passes = point.plan.passes as ReadonlyArray<{ id: string; shader?: string; uniforms?: Record<string, unknown> }>;
    const surface = passes.find((pass) => bare(pass.id) === "render_shot:scene:0");
    const instances = passes.find((pass) => bare(pass.id) === "render_shot:scene:1");
    // The one Light is in this Render twice: a row for the Surface, three uniform rows for the instances.
    expect(Object.keys(surface?.uniforms ?? {}).filter((key) => /^light\d/.test(key))).toEqual([]);
    expect(Object.keys(instances?.uniforms ?? {}).filter((key) => /^light\d/.test(key)).sort()).toEqual(["light0Color", "light0Meta", "light0Vector"]);
    // Straight under the light: the top of the middle box, 3.5 below it.
    under(point.last, MIDDLE, ROW).forEach((value) => expectLit(value, lampOnFloor(9, 0, HIGH - TOP)));
    // The floor two units along the row, between two boxes, six below the light and two aside.
    under(point.last, MIDDLE + 2, ROW).forEach((value) => expectLit(value, lampOnFloor(9, 0, HIGH, 2)));
    // The top of the next box: 3.5 below and four aside.
    under(point.last, RIGHT, ROW).forEach((value) => expectLit(value, lampOnFloor(9, 0, HIGH - TOP, 4)));

    // A sun straight down gives a box's top and the floor the one value.
    const sun = await render(boxes([{ kind: "directional", color: [1, 1, 1, 1], intensity: 0.5, direction: [0, -1, 0] }]));
    expect(under(sun.last, MIDDLE, ROW)).toEqual(under(sun.last, MIDDLE + 2, ROW));
    under(sun.last, MIDDLE, ROW).forEach((value) => expectLit(value, FLOOR_ALBEDO * 0.5));
  }, 240_000);

  it("gives a named Spot its cone on the Surface and none on the instances, which is what the Render says", async () => {
    // A spot straight down over the middle box, forty degrees wide: 20 degrees a side.
    const spot = await render(boxes([{ kind: "spot", ...SQUARE, color: [1, 1, 1, 1], intensity: 9, position: [MIDDLE, HIGH, ROW], direction: [0, -1, 0], cone: 40, coneSoftness: 0 }]));
    // On its axis both are lit: the top of the middle box.
    under(spot.last, MIDDLE, ROW).forEach((value) => expectLit(value, lampOnFloor(9, 0, HIGH - TOP)));
    // The floor four units along and two back is 36.7 degrees off the axis: outside the cone, black.
    expect(under(spot.last, MIDDLE + 4, ROW + 2)).toEqual([0, 0, 0]);
    // The floor one unit along (9.5 degrees) is inside it.
    under(spot.last, MIDDLE + 1, ROW).forEach((value) => expectLit(value, lampOnFloor(9, 0, HIGH, 1)));
    // The next box's top is 48.8 degrees off the axis, and is lit as by a point light: the
    // instances generator reads no cone yet (slice 7), and the Render's warning says so.
    under(spot.last, RIGHT, ROW).forEach((value) => expectLit(value, lampOnFloor(9, 0, HIGH - TOP, 4)));
  }, 240_000);
});
