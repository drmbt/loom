import { describe, expect, it } from "vitest";

import type { CompiledGraph } from "../../../compiler/index.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import type { ProjectSettings } from "../../../domain/types/graph.ts";
import {
  FLOOR_ALBEDO,
  FRONT_CAMERA,
  LAMP_HEIGHT,
  LAMP_INTENSITY,
  LAMP_RANGE,
  QUARTER_TURN_Y,
  SCATTERED_LAMPS,
  SPOTS,
  THREE_LAMPS_AT,
  TOP_CAMERA,
  WALL_Z,
  lampOnFloor,
  lampOnPlane,
  lampsScene,
  mapped,
  spotShare,
  type LampsScene,
} from "../../../nodes/definitions/light-points.fixture.ts";
import { lightGridDimensions, lightTableStorage } from "../../../nodes/definitions/light-records.ts";
import { CASTERS_GLB } from "../../../nodes/definitions/shadow-casters.fixture.ts";
import { lightTableRowAt } from "../../../nodes/shaders/scene-lights.wgsl.ts";
import { LIGHT_GUARD_ABOVE } from "../../../nodes/shaders/scene-render.wgsl.ts";
import { TOLERANCE_CROSS_GPU_HDR, decodeComponents, pixelAt } from "../../../tests/headless/pixel-compare.ts";
import { renderHeadless, type HarnessControl, type RenderedFrame } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1589b, slice 1, on a REAL device (§V147): lights from a pointset, culled.
 *
 * The scenes are `light-points.fixture.ts`: a floor in the default material seen from
 * straight above, with no ambient, and lamps from a Light in Points mode over a small kernel.
 * So a pixel no lamp reaches is exactly black, and the pixel straight under one lamp is that
 * lamp by the Render's own arithmetic (`lampOnFloor`).
 *
 * Two kinds of claim. Where a number is known from the scene it is asserted as that number,
 * to the precision a half float holds. Where the claim is that two ways of drawing are one
 * picture (through the grid and through one cell; a counted pointset with a dead point and
 * the same set without it), the two frames are compared byte for byte.
 */

const SIZE = 128;
const settingsFor = (width: number, height: number): ProjectSettings => ({
  outputResolution: { width, height },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
});

interface Run {
  readonly frames?: number;
  readonly capture?: ReadonlyArray<number>;
  readonly size?: readonly [number, number];
  readonly beforeFrames?: (control: HarnessControl) => void;
  readonly probeBuffers?: ReadonlyArray<string>;
  readonly meshes?: Readonly<Record<string, Uint8Array>>;
}
interface Rendered {
  readonly frames: ReadonlyArray<RenderedFrame>;
  readonly last: RenderedFrame;
  readonly plan: CompiledGraph;
  readonly buffers: Readonly<Record<string, ArrayBuffer>>;
}

async function render(options: LampsScene = {}, run: Run = {}): Promise<Rendered> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const [width, height] = run.size ?? [SIZE, SIZE];
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: lampsScene(options),
    settings: settingsFor(width, height),
    frames: run.frames ?? 2,
    fps: 60,
    outputNodeId: "render_shot",
    outputPortId: "out",
    ...(run.capture === undefined ? {} : { capture: run.capture }),
    ...(run.beforeFrames === undefined ? {} : { beforeFrames: run.beforeFrames }),
    ...(run.probeBuffers === undefined ? {} : { probeBuffers: run.probeBuffers }),
    ...(run.meshes === undefined ? {} : { meshes: run.meshes }),
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const last = result.frames[result.frames.length - 1];
  if (last === undefined) throw new Error("no frame captured");
  return { frames: result.frames, last, plan: result.plan, buffers: result.buffers ?? {} };
}

/** The pixel a world point lands in, under a camera as the Camera node states it. */
function pixelOf(camera: Record<string, unknown>, world: readonly [number, number, number], size: readonly [number, number] = [SIZE, SIZE]): [number, number] {
  const matrix = cameraPayloadMatrix(
    {
      eye: camera["eye"] as [number, number, number],
      lookAt: camera["lookAt"] as [number, number, number],
      fovDeg: (camera["fov"] as number | undefined) ?? 55,
      near: (camera["near"] as number | undefined) ?? 0.1,
      far: (camera["far"] as number | undefined) ?? 100,
      ortho: camera["ortho"] === true,
      orthoHeight: (camera["orthoHeight"] as number | undefined) ?? 2,
      roll: (camera["roll"] as number | undefined) ?? 0,
    },
    size[0] / size[1],
  );
  const clip = transformPoint(matrix, world);
  return [Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * size[0]), Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * size[1])];
}
/** The colour of the floor pixel straight under a place, seen from above. */
const under = (frame: RenderedFrame, x: number, z: number): number[] => {
  const [px, py] = pixelOf(TOP_CAMERA, [x, 0, z]);
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
/** A pass's id as its node wrote it. */
const bare = (id: string): string => id.slice(id.indexOf("#") + 1);

const ROW = 0.0625;

describe("lights from a pointset, on Dawn (T1589b, §V147)", () => {
  it("lights the floor under each point with that point's own colour, and with nothing of the others", async () => {
    const lit = (await render({ light: { color: mapped("color", [1, 1, 1, 1]) } })).last;
    const expected = lampOnFloor();
    // 0.8 × 2 × (1 − (2/3)⁴)² ÷ 2²: the number the scene's own values give.
    expect(expected).toBeCloseTo(0.2576, 4);
    THREE_LAMPS_AT.forEach((x, lamp) => {
      const pixel = under(lit, x, ROW);
      pixel.forEach((value, channel) => {
        // Red under the first, green under the second, blue under the third; the neighbours
        // are out of range, and out of range is exactly nothing.
        if (channel === lamp) expectLit(value, expected);
        else expect([lamp, channel, value]).toEqual([lamp, channel, 0]);
      });
    });
    // Half way between the green lamp and the blue, two units from each along the floor:
    // inside the last of both ranges, where the window has all but closed. Each gives its
    // own small share, by the same arithmetic, and the red lamp nothing.
    const between = under(lit, 2.0625, ROW);
    const edge = lampOnFloor(LAMP_INTENSITY, LAMP_RANGE, LAMP_HEIGHT, 2);
    expect(edge).toBeCloseTo(0.00623, 5);
    expect(between[0]).toBe(0);
    expectLit(between[1], edge);
    expectLit(between[2], edge);
    // Three units off the row, beyond every range: black.
    expect(under(lit, THREE_LAMPS_AT[1], ROW + 3)).toEqual([0, 0, 0]);

    // The edge cut at the Render: with the Light out of its Lights the three pixels are dark.
    const unlisted = (await render({ lights: "" })).last;
    for (const x of THREE_LAMPS_AT) expect(under(unlisted, x, ROW)).toEqual([0, 0, 0]);
    // The edge cut at the map: with Color back to a value, every lamp is the Light's white.
    const unmapped = (await render()).last;
    for (const x of THREE_LAMPS_AT) under(unmapped, x, ROW).forEach((value) => expectLit(value, expected));
  }, 240_000);

  it("multiplies the Light's own value by a mapped attribute, and stands a light where a mapped Position says", async () => {
    const plain = (await render()).last;
    // Intensity 4 × an attribute of 0.5 is Intensity 2 with no map; Range 2 × 1.5 is Range 3.
    const intensity = (await render({ light: { intensity: mapped("gain", LAMP_INTENSITY * 2) } })).last;
    expect(differingBytes(intensity.bytes, plain.bytes)).toBe(0);
    const range = (await render({ light: { range: mapped("reach", LAMP_RANGE / 1.5) } })).last;
    expect(differingBytes(range.bytes, plain.bytes)).toBe(0);
    // One channel of a vector: (0.25, 0.5).y, the same half.
    const channel = (await render({ light: { intensity: mapped("pair", LAMP_INTENSITY * 2, "y") } })).last;
    expect(differingBytes(channel.bytes, plain.bytes)).toBe(0);
    // And the map is read: the same Intensity 4 with no map is twice as bright.
    const doubled = (await render({ light: { intensity: LAMP_INTENSITY * 2 } })).last;
    expectLit(under(doubled, THREE_LAMPS_AT[1], ROW)[0], lampOnFloor(LAMP_INTENSITY * 2));

    // A colour multiplies too: a red Light over the three lamps' own colours leaves the red one.
    const red = (await render({ light: { color: mapped("color", [1, 0, 0, 1]) } })).last;
    expectLit(under(red, THREE_LAMPS_AT[0], ROW)[0], lampOnFloor());
    expect(under(red, THREE_LAMPS_AT[1], ROW)).toEqual([0, 0, 0]);
    expect(under(red, THREE_LAMPS_AT[2], ROW)).toEqual([0, 0, 0]);

    // Position in Map mode: `place` is the same row turned to run along z.
    const turned = (await render({ light: { position: mapped("place", [0, 0, 0]) } })).last;
    expectLit(under(turned, ROW, THREE_LAMPS_AT[2])[0], lampOnFloor());
    expect(under(turned, THREE_LAMPS_AT[2], ROW)).toEqual([0, 0, 0]);
  }, 240_000);

  it("gathers three Lights in Points mode into one Render: each set lights from its own records, in its own colour, with its own values", async () => {
    // Three kinds of lamp in one scene, each a Light of its own (a tunnel's crown lamps, its
    // wall lamps, a hall's ring): red along x; green along z from the same points turned, at
    // half the intensity; blue at two far corners from a kernel of its own, brighter and
    // shorter of reach. Their records sit one set after the other in the Render's table.
    const FAR = 5.9375;
    const corners = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let side = f32(ctx.index) * 2.0 - 1.0;
  q.position = vec3f(side * ${FAR}, ${LAMP_HEIGHT}.0, side * ${FAR});
  return q;
}`;
    const position = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);
    const points = { mode: "points", kind: "point", falloff: "inverseSquare" };
    const ROWS = 3 + 3 + 2;
    const table = lightTableStorage("render_shot", ROWS, lightGridDimensions([SIZE, SIZE]));
    const three = await render(
      {
        light: { color: [1, 0, 0, 1] },
        nodes: [
          { id: "light_cross", type: "light", parameters: { ...points, color: [0, 1, 0, 1], intensity: LAMP_INTENSITY / 2, range: LAMP_RANGE, position: mapped("place", [0, 0, 0]) } },
          { id: "kernel_corners", type: "pointKernel", parameters: { capacity: 2, attributes: position, kernel: corners } },
          { id: "light_corners", type: "light", parameters: { ...points, color: [0, 0, 1, 1], intensity: LAMP_INTENSITY * 2, range: 2.5 } },
        ],
        edges: [
          ["kernel_lamps", "light_cross", "points"],
          ["kernel_corners", "light_corners", "points"],
        ],
        lights: "light_lamps light_cross light_corners",
      },
      { probeBuffers: [table.resourceId] },
    );
    // The first set: red, under the ends of its row.
    for (const x of [THREE_LAMPS_AT[0], THREE_LAMPS_AT[2]]) {
      const pixel = under(three.last, x, ROW);
      expectLit(pixel[0], lampOnFloor());
      expect([pixel[1], pixel[2]]).toEqual([0, 0]);
    }
    // The second: green, at half, under the ends of the turned row.
    for (const z of [THREE_LAMPS_AT[0], THREE_LAMPS_AT[2]]) {
      const pixel = under(three.last, ROW, z);
      expectLit(pixel[1], lampOnFloor(LAMP_INTENSITY / 2));
      expect([pixel[0], pixel[2]]).toEqual([0, 0]);
    }
    // Where the two rows cross, a red lamp and a green one stand in one place.
    const crossing = under(three.last, THREE_LAMPS_AT[1], ROW);
    expectLit(crossing[0], lampOnFloor());
    expectLit(crossing[1], lampOnFloor(LAMP_INTENSITY / 2));
    expect(crossing[2]).toBe(0);
    // The third: blue, at twice the intensity and a range of its own, at its two corners.
    for (const side of [-1, 1]) {
      const pixel = under(three.last, side * FAR, side * FAR);
      expectLit(pixel[2], lampOnFloor(LAMP_INTENSITY * 2, 2.5));
      expect([pixel[0], pixel[1]]).toEqual([0, 0]);
    }

    // The table itself, read back off the device. Its header is where every loop over it
    // takes its bounds: the rows it holds, the words a cell has, where the cells start.
    const words = new Uint32Array(three.buffers[table.resourceId] ?? new ArrayBuffer(0));
    expect(Array.from(words.slice(0, 4))).toEqual([ROWS, 1, table.cellsAt, 0]);
    // And every row says what it is and which Light of the Render's Lights it came from:
    // no cone, a point light, no shadow slot, and the Light's place in the list.
    const floats = new Float32Array(words.buffer);
    const cones = lightTableRowAt("cone", ROWS);
    const coneOf = (row: number): number[] => Array.from(floats.slice(cones + row * 4, cones + row * 4 + 4));
    expect(Array.from({ length: ROWS }, (_, row) => coneOf(row))).toEqual([0, 0, 0, 1, 1, 1, 2, 2].map((light) => [-1, 1, 0, light]));
  }, 240_000);

  it("lights from rows in every word of a cell's mask: rows 0, 33 and 66 of sixty-seven", async () => {
    // A cell holds one bit a row, 32 to a word. Sixty-seven rows are three words, and the
    // three lamps of the row are the first row of each; every row between them is switched
    // off by its gain. So the second lamp is lit only if the build wrote, and the walk read,
    // a word past the first, and the third only if both reached the last.
    const spread = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let lamp = ctx.index / 33u;
  q.position = vec3f((f32(lamp) - 1.0) * 4.0 + ${ROW}, ${LAMP_HEIGHT}.0, ${ROW});
  q.color = vec4f(f32(lamp == 0u), f32(lamp == 1u), f32(lamp == 2u), 1.0);
  q.gain = f32(ctx.index % 33u == 0u);
  return q;
}`;
    const lit = (await render({ count: 67, kernel: spread, light: { color: mapped("color", [1, 1, 1, 1]), intensity: mapped("gain", LAMP_INTENSITY) } })).last;
    THREE_LAMPS_AT.forEach((x, lamp) => {
      under(lit, x, ROW).forEach((value, channel) => {
        if (channel === lamp) expectLit(value, lampOnFloor());
        else expect([lamp, channel, value]).toEqual([lamp, channel, 0]);
      });
    });
  }, 240_000);

  it("lights from a pointset of directional lights: that many suns along the Light's Direction, with no place and no range, and Type is a value", async () => {
    // Three suns, red, green and blue, straight down. Every pixel of the floor is their sum,
    // wherever their points stand and whatever the Light's Range says: a quarter each, white.
    const INTENSITY = 0.25;
    const suns = (kind: string, direction: number[]): LampsScene => ({ light: { kind, direction, intensity: INTENSITY, color: mapped("color", [1, 1, 1, 1]) } });
    const down = await render(suns("directional", [0, -1, 0]));
    const flat = FLOOR_ALBEDO * INTENSITY;
    for (const [x, z] of [[THREE_LAMPS_AT[0], ROW], [ROW, 7.0625], [-7.9375, -7.9375]] as const) under(down.last, x, z).forEach((value) => expectLit(value, flat));
    // Slanted by an eighth of a turn, the floor takes the cosine.
    const slanted = await render(suns("directional", [0, -1, -1]));
    under(slanted.last, ROW, 7.0625).forEach((value) => expectLit(value, flat * Math.SQRT1_2));

    // As point lights the same set is three pools, and the far end of the floor is dark.
    const lamps = await render(suns("point", [0, -1, 0]));
    expect(under(lamps.last, ROW, 7.0625)).toEqual([0, 0, 0]);
    // TYPE IS A VALUE: the programs compiled for the point lights, with one float of the
    // Light's own values written, draw the suns' picture byte for byte. Nothing was built.
    const switched = await render(suns("point", [0, -1, 0]), {
      beforeFrames: (control) => {
        const resolve = (control.plan.passes as ReadonlyArray<{ id: string; uniforms?: Record<string, unknown> }>).find((pass) => bare(pass.id) === "light_lamps:lights:resolve");
        if (resolve === undefined) throw new Error("the plan has no resolve pass");
        const shape = resolve.uniforms?.["shape"] as number[];
        expect(shape[2]).toBe(1);
        control.updateUniforms(resolve.id, { shape: [shape[0] as number, shape[1] as number, 0, 0] });
      },
    });
    expect(differingBytes(switched.last.bytes, down.last.bytes)).toBe(0);
  }, 240_000);

  it("walks the table beside more Lights in Single mode than B260's guard starts at: every block's light and every lamp's, each where it stands", async () => {
    // Nine Lights in Single mode in a row along x, five units down the floor from the lamps'
    // row: white, each a little brighter than the last, each with a range short of its
    // neighbour's foot (1.5 away, range 1.2 from a metre up) and far short of the lamps' row.
    // Above eight, each of their blocks works under a test that the light is on (B260); the
    // walk of the table takes no such test, and stands after them in the same function.
    const NAMED = 9;
    expect(NAMED).toBeGreaterThan(LIGHT_GUARD_ABOVE);
    const BACK = 5.0625;
    const at = (index: number): number => (index - 4) * 1.5 + ROW;
    const gain = (index: number): number => 1 + index * 0.25;
    const names = Array.from({ length: NAMED }, (_, index) => `light_named${index}`);
    const both = await render({
      light: { color: mapped("color", [1, 1, 1, 1]) },
      nodes: names.map((id, index) => ({ id, type: "light", parameters: { kind: "point", falloff: "inverseSquare", color: [1, 1, 1, 1], intensity: gain(index), range: 1.2, position: [at(index), 1, BACK] } })),
      lights: `${names.join(" ")} light_lamps`,
    });
    const lit = (both.plan.passes as ReadonlyArray<{ id: string; shader?: string }>).find((pass) => bare(pass.id) === "render_shot:scene:0");
    // The scene is the one the sentence is about: guarded blocks, and the walk.
    expect(String(lit?.shader)).toContain("if (lightMeta.y != 0.0)");
    expect(String(lit?.shader)).toContain("lightTable");
    // Under each Light in Single mode: that light alone, white, by the same arithmetic.
    names.forEach((_, index) => {
      const pixel = under(both.last, at(index), BACK);
      pixel.forEach((value) => expectLit(value, lampOnFloor(gain(index), 1.2, 1)));
    });
    // Under each lamp of the set: that lamp alone, in its colour.
    THREE_LAMPS_AT.forEach((x, lamp) => {
      under(both.last, x, ROW).forEach((value, channel) => {
        if (channel === lamp) expectLit(value, lampOnFloor());
        else expect([lamp, channel, value]).toEqual([lamp, channel, 0]);
      });
    });
    // Between the two rows, beyond every range: black.
    expect(under(both.last, ROW, 3.0625)).toEqual([0, 0, 0]);
  }, 240_000);

  it("lights a Sweep of two strips, a grid of two sheets in one draw: each sheet under its own lamp, and nothing between them", async () => {
    // Two ribbons two units wide along x, one under the middle lamp of the turned row and one
    // under its last: a path of two strips through Curve Frames and a Sweep, one Geometry.
    const STEPS = 7;
    const path = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let strip = ctx.index / ${STEPS}u;
  let along = ctx.index % ${STEPS}u;
  q.position = vec3f(f32(along) * 2.0 - 6.0, 0.0, ${THREE_LAMPS_AT[1]} + f32(strip) * 4.0);
  return q;
}`;
    const position = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);
    const scene: LampsScene = {
      light: { color: mapped("color", [1, 1, 1, 1]), position: mapped("place", [0, 0, 0]) },
      nodes: [
        { id: "kernel_path", type: "pointKernel", parameters: { capacity: STEPS * 2, attributes: position, kernel: path } },
        { id: "topology_path", type: "pointTopology", parameters: { connectivity: "strips", cols: STEPS, rows: 2 } },
        { id: "frames_path", type: "pointCurveFrames", parameters: {} },
        { id: "sweep_skin", type: "pointSweep", parameters: { profile: "strip", sides: 1, radius: 1, uvAlong: "points" } },
        { id: "geometry_skin", type: "geometry", parameters: { mode: "surface" } },
      ],
      edges: [
        ["kernel_path", "topology_path", "points"],
        ["topology_path", "frames_path", "points"],
        ["frames_path", "sweep_skin", "points"],
        ["sweep_skin", "geometry_skin", "points"],
      ],
      scenes: "geometry_skin",
    };
    const swept = await render(scene);
    // The draw is the sheeted one: a grid of two sheets, in one draw that joins neither to the other.
    const lit = (swept.plan.passes as ReadonlyArray<{ id: string; shader?: string }>).find((pass) => bare(pass.id) === "render_shot:scene:0");
    expect(String(lit?.shader)).toContain("gridSheet");
    // The first sheet under the green lamp, the second under the blue: each the lamp's own value, as a floor's.
    const first = under(swept.last, ROW, THREE_LAMPS_AT[1]);
    expectLit(first[1], lampOnFloor());
    expect([first[0], first[2]]).toEqual([0, 0]);
    const second = under(swept.last, ROW, THREE_LAMPS_AT[2]);
    expectLit(second[2], lampOnFloor());
    expect([second[0], second[1]]).toEqual([0, 0]);
    // Half way between the two sheets, in the last of both lamps' ranges: nothing is drawn, so nothing is lit.
    expect(under(swept.last, ROW, 2.0625)).toEqual([0, 0, 0]);
    // And through the grid it is the picture through one cell.
    const walked = await render(scene, { beforeFrames: oneCell(2) });
    expect(differingBytes(swept.last.bytes, walked.last.bytes)).toBe(0);
  }, 240_000);

  it("lets a light with no Range reach everywhere: it is in every cell, and falls off by the inverse square alone", async () => {
    const endless = (await render({ light: { range: 0, color: mapped("color", [1, 1, 1, 1]) } })).last;
    // Under the red lamp: its own light with no window, and the green and the blue from four and eight units along.
    const pixel = under(endless, THREE_LAMPS_AT[0], ROW);
    expectLit(pixel[0], lampOnFloor(LAMP_INTENSITY, 0));
    expectLit(pixel[1], lampOnFloor(LAMP_INTENSITY, 0, LAMP_HEIGHT, 4));
    expectLit(pixel[2], lampOnFloor(LAMP_INTENSITY, 0, LAMP_HEIGHT, 8));
    // And at the far corner of the floor, where no cell of a ranged lamp's would hold it.
    const [cornerX, cornerY] = pixelOf(TOP_CAMERA, [-7.9375, 0, 7.9375]);
    expect(pixelAt(endless, cornerX, cornerY)[0]).toBeGreaterThan(0);
  }, 240_000);

  it("lights a frame from where a kernel put the light IN THAT FRAME: no frame of latency", async () => {
    const STEP = 2;
    const stepping = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(${THREE_LAMPS_AT[0]} + f32(ctx.frameIndex) * ${STEP}.0, ${LAMP_HEIGHT}.0, ${ROW});
  return q;
}`;
    const { frames } = await render({ count: 1, kernel: stepping }, { frames: 4, capture: [0, 1, 2, 3] });
    expect(frames.map((frame) => frame.frameIndex)).toEqual([0, 1, 2, 3]);
    for (const frame of frames) {
      // The brightest pixel of the lamp's row, and where the lamp is in THIS frame.
      const [, row] = pixelOf(TOP_CAMERA, [0, 0, ROW]);
      let brightest = 0;
      for (let x = 1; x < SIZE; x += 1) if ((pixelAt(frame, x, row)[0] ?? 0) > (pixelAt(frame, brightest, row)[0] ?? 0)) brightest = x;
      const here = THREE_LAMPS_AT[0] + frame.frameIndex * STEP;
      expect([frame.frameIndex, brightest]).toEqual([frame.frameIndex, pixelOf(TOP_CAMERA, [here, 0, ROW])[0]]);
      // Not merely nearest: it is the lamp's own value, and where it stood two frames ago is out of its range.
      expectLit(pixelAt(frame, brightest, row)[0], lampOnFloor());
      if (frame.frameIndex >= 2) expect(under(frame, here - STEP * 2, ROW)).toEqual([0, 0, 0]);
    }
  }, 240_000);

  it("lights from the live points of a counted pointset only: a dead slot is no light", async () => {
    const LIVE = -1.9375;
    const DEAD = 2.0625;
    // Two points, four units apart, both alive and lit on the first frame; the second is
    // killed on the next. Its slot then still holds where it stood: a light, if it is read.
    const killOne = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) { q.id = ctx.index; }
  q.position = vec3f(${LIVE} + f32(q.id) * 4.0, ${LAMP_HEIGHT}.0, ${ROW});
  q.velocity = vec3f(0.0);
  if (q.id == 1u && ctx.frameIndex >= 1u) { q.alive = 0u; }
  return q;
}`;
    const one = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(${LIVE}, ${LAMP_HEIGHT}.0, ${ROW});
  return q;
}`;
    const counted = await render({ counted: true, count: 2, kernel: killOne }, { frames: 5, capture: [0, 4] });
    const [alive, after] = counted.frames as [RenderedFrame, RenderedFrame];
    // While both live, both light.
    expectLit(under(alive, LIVE, ROW)[0], lampOnFloor());
    expectLit(under(alive, DEAD, ROW)[0], lampOnFloor());
    // Once one is dead, its place is dark and the other is as it was.
    expectLit(under(after, LIVE, ROW)[0], lampOnFloor());
    expect(under(after, DEAD, ROW)).toEqual([0, 0, 0]);
    // The whole picture is the one a single uncounted point gives.
    const single = (await render({ count: 1, kernel: one }, { frames: 5 })).last;
    expect(differingBytes(after.bytes, single.bytes)).toBe(0);
  }, 240_000);
});

/* ------------------------------------------------------------------------------------ */
/* Culling is invisible                                                                  */
/* ------------------------------------------------------------------------------------ */

const LAMPS = 300;
const MANY: LampsScene = {
  count: LAMPS,
  kernel: SCATTERED_LAMPS,
  scenes: "geometry_floor geometry_wall",
  light: { color: mapped("color", [1, 1, 1, 1]), intensity: mapped("gain", 1.5), range: mapped("reach", LAMP_RANGE) },
};

/** Six views of the three hundred lamps: each is one way the grid could disagree with the picture. */
const VIEWS: ReadonlyArray<{ readonly name: string; readonly scene: LampsScene; readonly size?: readonly [number, number] }> = [
  { name: "a perspective camera in front of the set", scene: { camera: { ortho: false, eye: [0, 5, 11], lookAt: [0, 1, 0], fov: 55, near: 0.1, far: 60 } } },
  { name: "low, close and rolled", scene: { camera: { ortho: false, eye: [-6, 1.2, 5], lookAt: [3, 1, -4], roll: 30, fov: 70, near: 0.05, far: 80 } } },
  { name: "among the lamps, looking along the floor", scene: { camera: { ortho: false, eye: [0.3, 0.8, 0.2], lookAt: [8, 0.6, -1], fov: 90, near: 0.02, far: 40 } } },
  { name: "an orthographic camera above it", scene: { camera: { ...TOP_CAMERA } } },
  { name: "under SSAA, a surface twice the size", scene: { camera: { ortho: false, eye: [4, 6, 9], lookAt: [0, 0, 0], near: 0.1, far: 60 }, render: { antialias: "ssaa" } } },
  { name: "a picture twice as wide as it is high", scene: { camera: { ortho: false, eye: [0, 4, 10], lookAt: [0, 1, 0], near: 0.1, far: 60 } }, size: [192, 96] },
];

/** The same document with the grid's dimensions set to ONE cell, as values: every pixel then walks every light the view holds. */
const oneCell = (passes: number) => (control: HarnessControl): void => {
  let moved = 0;
  for (const pass of control.plan.passes as ReadonlyArray<{ id: string; uniforms?: Record<string, unknown> }>) {
    const key = bare(pass.id).endsWith(":lights:grid") ? "grid" : pass.uniforms?.["lightGrid"] !== undefined ? "lightGrid" : undefined;
    if (key === undefined) continue;
    const orthographic = (pass.uniforms?.[key] as number[])[3] as number;
    control.updateUniforms(pass.id, { [key]: [1, 1, 1, orthographic] });
    moved += 1;
  }
  // The build, and every lit draw that walks the table.
  expect(moved).toBe(passes);
};

describe("the grid is invisible: a culled frame is the frame every light is walked for (T1589b)", () => {
  for (const view of VIEWS) {
    it(`${view.name}: through the grid and through one cell, byte for byte`, async () => {
      const size = view.size ?? ([SIZE, SIZE] as const);
      const scene: LampsScene = { ...MANY, ...view.scene };
      const table = lightTableStorage("render_shot", LAMPS, lightGridDimensions(size));
      const culled = await render(scene, { size, probeBuffers: [table.resourceId] });
      const walked = await render(scene, { size, beforeFrames: oneCell(3), probeBuffers: [table.resourceId] });
      expect(differingBytes(culled.last.bytes, walked.last.bytes)).toBe(0);

      // The comparison is of two different programs' work. The grid did leave lights out:
      // its cells, read back, hold different sets, none of them every lamp.
      const bitsOf = (buffer: ArrayBuffer | undefined, cell: number): number => {
        const words = new Uint32Array(buffer ?? new ArrayBuffer(0));
        let held = 0;
        for (let word = 0; word < table.words; word += 1) {
          let bits = words[table.cellsAt + cell * table.words + word] ?? 0;
          while (bits !== 0) {
            bits &= bits - 1;
            held += 1;
          }
        }
        return held;
      };
      const perCell = Array.from({ length: table.cells }, (_, cell) => bitsOf(culled.buffers[table.resourceId], cell));
      const fullest = Math.max(...perCell);
      expect(fullest).toBeGreaterThan(0);
      expect(fullest).toBeLessThan(LAMPS);
      expect(perCell.filter((held) => held === 0).length).toBeGreaterThan(0);
      // And the one cell of the reference holds more than any cell of the grid did.
      expect(bitsOf(walked.buffers[table.resourceId], 0)).toBeGreaterThan(fullest);

      // The picture is lit by them: with the Light's Intensity at nothing it is black.
      const dark = await render({ ...scene, light: { ...MANY.light, intensity: mapped("gain", 0) } }, { size, probeBuffers: [table.resourceId] });
      expect(dark.last.bytes.every((byte, index) => index % 8 >= 6 || byte === 0)).toBe(true);
      expect(differingBytes(culled.last.bytes, dark.last.bytes)).toBeGreaterThan(size[0] * size[1]);
      // And a light that gives nothing costs nothing: it is off, in no cell, so no pixel walks it.
      expect(Math.max(...Array.from({ length: table.cells }, (_, cell) => bitsOf(dark.buffers[table.resourceId], cell)))).toBe(0);
    }, 240_000);
  }
});

/* ------------------------------------------------------------------------------------ */
/* Every draw that lights                                                                */
/* ------------------------------------------------------------------------------------ */

describe("every surface draw takes the lamps (T1589b)", () => {
  it("lights a grid, a mesh, mesh instances under a Material · WGSL and an additive surface, each through its own material", async () => {
    const paint = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(1.0, 1.0, 1.0, 1.0);
  return o;
}`;
    // Two small slabs on the floor under the red and the blue lamp, as instances of one mesh.
    const slabs = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(${THREE_LAMPS_AT[0]} + f32(ctx.index) * 8.0, 0.4, ${ROW});
  return q;
}`;
    const raised = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x + 0.5, 0.25, p.position.y + 1.5);
  return q;
}`;
    const position = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);
    const scene: LampsScene = {
      light: { color: mapped("color", [1, 1, 1, 1]) },
      nodes: [
        // A mesh Surface: the box of the shadow-caster fixture, two units square, its top at y = 1.5.
        { id: "mesh_box", type: "meshFileIn", parameters: { select: "box" } },
        { id: "material_box", type: "materialPbr", parameters: { color: [1, 1, 1, 1], metallic: 0, roughness: 0.6 } },
        { id: "geometry_box", type: "geometry", parameters: { mode: "surface", material: "material_box" } },
        // Mesh instances under a Material · WGSL.
        { id: "mesh_slab", type: "meshFileIn", parameters: { select: "lid", frame: "object" } },
        { id: "kernel_slabs", type: "pointKernel", parameters: { capacity: 2, attributes: position, kernel: slabs } },
        { id: "material_slabs", type: "materialWgsl", parameters: { model: "pbr", source: paint, roughness: 0.7 } },
        { id: "geometry_slabs", type: "geometry", parameters: { mode: "instances", shape: "mesh", material: "material_slabs" } },
        // An additive surface, a phong material: light laid over the floor.
        { id: "grid_glow", type: "pointGrid", parameters: { cols: 3, rows: 3, count: 9, sizeX: 1, sizeY: 1 } },
        { id: "kernel_glow", type: "pointKernel", parameters: { capacity: 9, attributes: position, kernel: raised } },
        { id: "material_glow", type: "materialPhong", parameters: { color: [1, 1, 1, 1], specular: [0, 0, 0, 1], roughness: 1 } },
        { id: "geometry_glow", type: "geometry", parameters: { mode: "surface", material: "material_glow", blend: "additive" } },
      ],
      edges: [
        ["mesh_box", "geometry_box", "points"],
        ["mesh_slab", "geometry_slabs", "mesh"],
        ["kernel_slabs", "geometry_slabs", "points"],
        ["grid_glow", "kernel_glow", "in"],
        ["kernel_glow", "geometry_glow", "points"],
      ],
      scenes: "geometry_floor geometry_box geometry_slabs geometry_glow",
    };
    const meshes = { mesh_box: CASTERS_GLB, mesh_slab: CASTERS_GLB };
    const lit = await render(scene, { meshes });
    // The lit draw of each of the four walks the table; no other pass binds it.
    const walkers = (lit.plan.passes as ReadonlyArray<{ id: string; buffers?: ReadonlyArray<{ binding: string }> }>)
      .filter((pass) => pass.buffers?.some((buffer) => buffer.binding === "lightTable") === true && !bare(pass.id).includes(":lights:"))
      .map((pass) => bare(pass.id));
    expect(walkers).toEqual(["render_shot:scene:0", "render_shot:scene:1", "render_shot:scene:2", "render_shot:scene:3"]);

    const dark = await render({ ...scene, light: { ...scene.light, intensity: 0 } }, { meshes });
    const at = (frame: RenderedFrame, world: readonly [number, number, number]): number[] => {
      const [px, py] = pixelOf(TOP_CAMERA, world);
      return pixelAt(frame, px, py).slice(0, 3);
    };
    // The floor, far from everything else, under no slab: the green lamp's own floor is under the box, so read beside the blue one.
    const places: ReadonlyArray<readonly [string, readonly [number, number, number], number]> = [
      ["the floor beside the blue lamp's slab", [THREE_LAMPS_AT[2], 0, ROW + 1], 2],
      ["the top of the mesh box, under the green lamp", [THREE_LAMPS_AT[1], 1.5, ROW], 1],
      ["a mesh instance under the red lamp", [THREE_LAMPS_AT[0], 0.45, ROW], 0],
      ["the additive surface, in reach of the green lamp", [0.5, 0.25, 1.5], 1],
    ];
    for (const [name, world, channel] of places) {
      const bright = at(lit.last, world);
      // Lit in its lamp's colour and in no other, and dark with the lamps at nothing.
      expect([name, (bright[channel] ?? 0) > 0.01]).toEqual([name, true]);
      bright.forEach((value, index) => {
        if (index !== channel) expect([name, index, value]).toEqual([name, index, 0]);
      });
      expect([name, at(dark.last, world)]).toEqual([name, [0, 0, 0]]);
    }
    // The box's top is half a unit under its lamp: the Render's own inverse square, through the pbr lobe's diffuse half.
    expect(at(lit.last, [THREE_LAMPS_AT[1], 1.5, ROW])[1]).toBeGreaterThan(lampOnFloor());
  }, 240_000);

  it("keeps the lamps' light antialiased under MSAA: an edge pixel holds a share of the lit value, by coverage", async () => {
    // What this holds is the reason the lights are walked in the lit draw and not added to a
    // resolved picture afterwards: the lamps' light is IN the multisampled colour, so an edge
    // is antialiased in it. Seen red by a Render whose lit draws leave the walk out under MSAA
    // (the inside pixel goes dark); nothing in the walk itself knows the sample count.
    //
    // A slab 4.18 units square at y = 1 over nothing, lit from above by one lamp. Seen from
    // above at eight pixels a unit its edge at x = 2.09 crosses the pixel whose centre is at
    // 2.0625: the centre is covered, so the pixel is shaded, and one of its four samples is not.
    const slab = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x, 1.0, p.position.y);
  return q;
}`;
    const lamp = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(${ROW}, 4.0, ${ROW});
  return q;
}`;
    const position = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);
    const scene = (antialias: string): LampsScene => ({
      count: 1,
      kernel: lamp,
      light: { range: 20 },
      nodes: [
        { id: "grid_slab", type: "pointGrid", parameters: { cols: 2, rows: 2, count: 4, sizeX: 4.18, sizeY: 4.18 } },
        { id: "kernel_slab", type: "pointKernel", parameters: { capacity: 4, attributes: position, kernel: slab } },
        { id: "geometry_slab", type: "geometry", parameters: { mode: "surface" } },
      ],
      edges: [
        ["grid_slab", "kernel_slab", "in"],
        ["kernel_slab", "geometry_slab", "points"],
      ],
      scenes: "geometry_slab",
      render: { antialias },
    });
    const hard = (await render(scene("none"))).last;
    const soft = (await render(scene("msaa"))).last;
    const [inside, row] = pixelOf(TOP_CAMERA, [1.5, 1, ROW]);
    const [edgeA] = pixelOf(TOP_CAMERA, [2.0625, 1, ROW]);
    const [edgeB] = pixelOf(TOP_CAMERA, [-2.0625, 1, ROW]);
    const red = (frame: RenderedFrame, x: number): number => pixelAt(frame, x, row)[0] ?? Number.NaN;
    // Well inside the slab nothing changed: one shaded value a pixel, whatever the sample count.
    expect(red(soft, inside)).toBe(red(hard, inside));
    expect(red(hard, inside)).toBeGreaterThan(0.01);
    for (const edge of [edgeA, edgeB]) {
      // Without MSAA the edge pixel is wholly the slab's; one pixel further out is nothing.
      const whole = red(hard, edge);
      expect(whole).toBeGreaterThan(0.01);
      const outward = edge > inside ? 1 : -1;
      expect([red(hard, edge + outward), red(soft, edge + outward)]).toEqual([0, 0]);
      // With it, the pixel holds a quarter, a half or three quarters of that value: its covered samples.
      const share = red(soft, edge) / whole;
      const quarters = Math.round(share * 4);
      expect([1, 2, 3]).toContain(quarters);
      // A ratio of two half floats: twice the precision one of them holds.
      expect(Math.abs(share - quarters / 4)).toBeLessThan(2 * TOLERANCE_CROSS_GPU_HDR);
    }
  }, 240_000);

  it("holds the floor's albedo and the lamps' height as the fixture states them", () => {
    // The numbers `lampOnFloor` is made of, said once more where the assertions lean on them.
    expect([FLOOR_ALBEDO, LAMP_HEIGHT, LAMP_INTENSITY, LAMP_RANGE]).toEqual([0.8, 2, 2, 3]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Slice 2: a cone, and a way to shine                                                   */
/* ------------------------------------------------------------------------------------ */

/** The middle lamp of the three: it is the green one. */
const MIDDLE = THREE_LAMPS_AT[1];
const GREEN = 1;
/** The cosine off a spot's axis of the floor point `aside` from the foot of a lamp that shines straight down. */
const offAxis = (aside: number): number => LAMP_HEIGHT / Math.hypot(LAMP_HEIGHT, aside);

describe("a spot is a row with a cone: it shines along its direction and nowhere else (T1589b slice 2)", () => {
  const DOWN = { direction: [0, -1, 0], color: mapped("color", [1, 1, 1, 1]) };
  const green = (frame: RenderedFrame, aside: number): number => under(frame, MIDDLE, ROW + aside)[GREEN] ?? Number.NaN;

  it("straight down: the point light's value on the axis and inside the inner angle, a share of it in the fade, and exactly nothing outside the cone", async () => {
    // Cone 60 with Cone Softness 0.4: whole inside 18 degrees off the axis, nothing from 30.
    const cone = { ...DOWN, kind: "spot", cone: 60, coneSoftness: 0.4 };
    const spot = (await render({ ...SPOTS, light: cone })).last;
    const point = (await render({ ...SPOTS, light: { ...DOWN, kind: "point" } })).last;
    // On the axis, and half a unit aside (14 degrees off it): the point light's value, to the bit.
    for (const aside of [0, 0.5]) {
      expect([aside, green(spot, aside)]).toEqual([aside, green(point, aside)]);
      expectLit(green(spot, aside), lampOnFloor(LAMP_INTENSITY, LAMP_RANGE, LAMP_HEIGHT, aside));
    }
    // 0.875 aside is 23.6 degrees off: in the fade, where the cone leaves 0.633 of the light.
    const fade = spotShare(60, 0.4, offAxis(0.875));
    expect(fade).toBeCloseTo(0.6329, 4);
    expectLit(green(spot, 0.875), lampOnFloor(LAMP_INTENSITY, LAMP_RANGE, LAMP_HEIGHT, 0.875) * fade);
    // 1.5 aside is 36.9 degrees off: outside the cone, well inside the range. Exactly nothing,
    // where the point light still gives a fifth of what it gives under itself.
    expect(under(spot, MIDDLE, ROW + 1.5)).toEqual([0, 0, 0]);
    expectLit(green(point, 1.5), lampOnFloor(LAMP_INTENSITY, LAMP_RANGE, LAMP_HEIGHT, 1.5));

    // And "nothing" is what the Render gives with no light at all: under an ambient the
    // pixel outside the cone is the pixel of the same Render with the Light out of its Lights.
    const ambient = { ambientIntensity: 0.25 };
    const lit = (await render({ ...SPOTS, light: cone, render: ambient })).last;
    const unlit = (await render({ ...SPOTS, lights: "", render: ambient })).last;
    expect(under(lit, MIDDLE, ROW + 1.5)).toEqual(under(unlit, MIDDLE, ROW + 1.5));
    expectLit(under(unlit, MIDDLE, ROW + 1.5)[GREEN], FLOOR_ALBEDO * 0.25);
    expect(green(lit, 0)).toBeGreaterThan(green(unlit, 0) + 0.2);
  }, 240_000);

  it("a Cone Softness of 0 is a hard edge, a Cone of 359 or more is every direction, and a Cone in Map mode multiplies", async () => {
    const point = (await render({ ...SPOTS, light: { ...DOWN, kind: "point" } })).last;
    // No fade: the two cosines of the cone are one. 29.4 degrees off is whole, 32.0 is nothing.
    const hard = (await render({ ...SPOTS, light: { ...DOWN, kind: "spot", cone: 60, coneSoftness: 0 } })).last;
    expect(green(hard, 1.125)).toBe(green(point, 1.125));
    expect(green(hard, 1.125)).toBeGreaterThan(0.1);
    expect(under(hard, MIDDLE, ROW + 1.25)).toEqual([0, 0, 0]);

    // A spot that shines every way is the point light, the whole picture of it: even with a
    // Cone Softness of 1, which would otherwise fade it from its axis out.
    for (const cone of [359, 360]) {
      const every = (await render({ ...SPOTS, light: { ...DOWN, kind: "spot", cone, coneSoftness: 1 } })).last;
      expect([cone, differingBytes(every.bytes, point.bytes)]).toEqual([cone, 0]);
    }
    // 358 is still a cone: it has a fade, and the point light's picture is not its picture.
    const nearly = (await render({ ...SPOTS, light: { ...DOWN, kind: "spot", cone: 358, coneSoftness: 1 } })).last;
    expect(differingBytes(nearly.bytes, point.bytes)).toBeGreaterThan(0);

    // Cone 30 times an attribute of 2 is Cone 60 with no map.
    const plain = (await render({ ...SPOTS, light: { ...DOWN, kind: "spot", cone: 60 } })).last;
    const doubled = (await render({ ...SPOTS, light: { ...DOWN, kind: "spot", cone: mapped("spread", 30, "x") } })).last;
    expect(differingBytes(doubled.bytes, plain.bytes)).toBe(0);
    expect(differingBytes(plain.bytes, point.bytes)).toBeGreaterThan(0);

    // A mapped cone of nothing is a spot that is OFF: dark, and in no cell, so no pixel walks it.
    const table = lightTableStorage("render_shot", 3, lightGridDimensions([SIZE, SIZE]));
    const shut = await render({ ...SPOTS, light: { ...DOWN, kind: "spot", cone: mapped("spread", 60, "y") } }, { probeBuffers: [table.resourceId] });
    expect(under(shut.last, MIDDLE, ROW)).toEqual([0, 0, 0]);
    expectLit(under(shut.last, THREE_LAMPS_AT[0], ROW)[0], lampOnFloor());
    const floats = new Float32Array(shut.buffers[table.resourceId] ?? new ArrayBuffer(0));
    const row = (name: "place" | "aim" | "cone", slot: number): number[] => Array.from(floats.slice(lightTableRowAt(name, 3) + slot * 4, lightTableRowAt(name, 3) + slot * 4 + 4));
    // The range of each row: the Light's, and for the shut one the mark of a row that is off.
    expect([0, 1, 2].map((slot) => row("place", slot)[3])).toEqual([LAMP_RANGE, -1, LAMP_RANGE]);
    // And what a spot's row holds: the way it shines and the cosine of half its Cone; the
    // cosine of the inner angle, and its kind.
    expect(row("aim", 0).slice(0, 3)).toEqual([0, -1, 0]);
    expect(row("aim", 0)[3]).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(row("cone", 0)[0]).toBeCloseTo(Math.cos((Math.PI / 6) * 0.6), 6);
    expect(row("cone", 0).slice(1)).toEqual([2, 0, 0]);
  }, 240_000);

  it("a spot with no way to shine is off, and Type is a value: the point lights' programs draw the spots after one float is written", async () => {
    const table = lightTableStorage("render_shot", 3, lightGridDimensions([SIZE, SIZE]));
    const aimless = await render({ ...SPOTS, light: { ...DOWN, kind: "spot", direction: [0, 0, 0] } }, { probeBuffers: [table.resourceId] });
    const floats = new Float32Array(aimless.buffers[table.resourceId] ?? new ArrayBuffer(0));
    expect([0, 1, 2].map((slot) => floats[lightTableRowAt("place", 3) + slot * 4 + 3])).toEqual([-1, -1, -1]);
    expect(aimless.last.bytes.every((byte, index) => index % 8 >= 6 || byte === 0)).toBe(true);
    // A point light has no way to shine and needs none.
    const point = await render({ ...SPOTS, light: { ...DOWN, kind: "point", direction: [0, 0, 0] } });
    expectLit(under(point.last, MIDDLE, ROW)[GREEN], lampOnFloor());

    const spot = (await render({ ...SPOTS, light: { ...DOWN, kind: "spot" } })).last;
    const switched = await render(
      { ...SPOTS, light: { ...DOWN, kind: "point" } },
      {
        beforeFrames: (control) => {
          const resolve = (control.plan.passes as ReadonlyArray<{ id: string; uniforms?: Record<string, unknown> }>).find((pass) => bare(pass.id) === "light_lamps:lights:resolve");
          if (resolve === undefined) throw new Error("the plan has no resolve pass");
          const shape = resolve.uniforms?.["shape"] as number[];
          expect(shape[2]).toBe(1);
          control.updateUniforms(resolve.id, { shape: [shape[0] as number, shape[1] as number, 2, 0] });
        },
      },
    );
    expect(differingBytes(switched.last.bytes, spot.bytes)).toBe(0);
    // The two pictures it was between are different pictures.
    expect(under(spot, MIDDLE, ROW + 1.5)).toEqual([0, 0, 0]);
  }, 240_000);
});

describe("which way a spot shines: Direction, turned by Orient, each from the node or from the point (T1589b slice 2)", () => {
  // Cone 40 with Cone Softness 0.25: whole inside 15 degrees off the axis, nothing from 20.
  const OBLIQUE = { kind: "spot", cone: 40, coneSoftness: 0.25, range: 6, color: mapped("color", [1, 1, 1, 1]) };
  /** A lamp two units up that shines down at 45 degrees meets the floor two units along. */
  const REACH = LAMP_HEIGHT;
  const ON_AXIS = lampOnFloor(LAMP_INTENSITY, 6, LAMP_HEIGHT, REACH);

  /** The brightest pixel of one channel of a frame. */
  const brightest = (frame: RenderedFrame, channel: number): [number, number] => {
    const values = decodeComponents(frame.bytes, frame.format);
    let best = -1;
    let at = 0;
    for (let pixel = 0; pixel < frame.width * frame.height; pixel += 1) {
      const value = values[pixel * 4 + channel] ?? 0;
      if (value > best) {
        best = value;
        at = pixel;
      }
    }
    return [at % frame.width, Math.floor(at / frame.width)];
  };

  it("Orient in Map mode turns each lamp's Direction: a quarter turn about the vertical carries its light a quarter turn round its foot, and cutting the map carries it back", async () => {
    // Direction (1, −1, 0): along +x and down. The points' `turn` is a quarter turn about +Y,
    // which carries +X to −Z.
    const light = { ...OBLIQUE, direction: [1, -1, 0] };
    const plain = (await render({ ...SPOTS, light })).last;
    const turned = (await render({ ...SPOTS, light: { ...light, orient: mapped("turn", [0, 0, 0, 1]) } })).last;
    expect(ON_AXIS).toBeCloseTo(0.1278, 4);

    // Where the axis meets the floor: the point light's value there. Where the other axis
    // meets it: exactly nothing. And straight under the lamp, 45 degrees off either: nothing.
    expectLit(under(plain, MIDDLE + REACH, ROW)[GREEN], ON_AXIS);
    expect(under(plain, MIDDLE, ROW - REACH)).toEqual([0, 0, 0]);
    expectLit(under(turned, MIDDLE, ROW - REACH)[GREEN], ON_AXIS);
    expect(under(turned, MIDDLE + REACH, ROW)).toEqual([0, 0, 0]);
    for (const frame of [plain, turned]) expect(under(frame, MIDDLE, ROW)[GREEN]).toBe(0);

    // THE BRIGHTEST PIXEL. It is not where the axis meets the floor: the inverse square
    // pulls it toward the lamp, to the near side of the cone. It is on the line from the
    // lamp's foot to that place, and the turn carries it a quarter turn round the foot.
    const [foot, row] = pixelOf(TOP_CAMERA, [MIDDLE, 0, ROW]);
    const [far] = pixelOf(TOP_CAMERA, [MIDDLE + REACH, 0, ROW]);
    const [px, py] = brightest(plain, GREEN);
    expect(py).toBe(row);
    expect(px).toBeGreaterThan(Math.min(foot, far));
    expect(px).toBeLessThan(Math.max(foot, far));
    // How far from the foot it is, in the floor's own units, whichever way the camera lays x across the picture.
    const along = (REACH * (px - foot)) / (far - foot);
    expect(brightest(turned, GREEN)).toEqual(pixelOf(TOP_CAMERA, [MIDDLE, 0, ROW - along]));
    // With the map cut the turned Light is the plain one again: that IS `plain`.

    // The same turn as a VALUE on the node turns every light of the set alike: the picture
    // the attribute gave, byte for byte.
    const byValue = (await render({ ...SPOTS, light: { ...light, orient: [...QUARTER_TURN_Y] } })).last;
    expect(differingBytes(byValue.bytes, turned.bytes)).toBe(0);
    expect(differingBytes(plain.bytes, turned.bytes)).toBeGreaterThan(0);
    // PER POINT. `swing` is a turn of each lamp's own: none for the red one, the quarter turn
    // for the green one, a quarter turn the other way (+X to +Z) for the blue one. Each
    // lamp's light is where its own turn carries it, and nowhere another's would have.
    const swung = (await render({ ...SPOTS, light: { ...light, orient: mapped("swing", [0, 0, 0, 1]) } })).last;
    expectLit(under(swung, THREE_LAMPS_AT[0] + REACH, ROW)[0], ON_AXIS);
    expectLit(under(swung, MIDDLE, ROW - REACH)[GREEN], ON_AXIS);
    expectLit(under(swung, THREE_LAMPS_AT[2], ROW + REACH)[2], ON_AXIS);
    expect(under(swung, THREE_LAMPS_AT[0], ROW - REACH)).toEqual([0, 0, 0]);
    expect(under(swung, MIDDLE, ROW + REACH)).toEqual([0, 0, 0]);
    expect(under(swung, THREE_LAMPS_AT[2] + REACH, ROW)).toEqual([0, 0, 0]);

    // A quaternion is a turn whatever its length: twice as long, the same quarter turn.
    const long = (await render({ ...SPOTS, light: { ...light, orient: QUARTER_TURN_Y.map((part) => part * 2) } })).last;
    expectLit(under(long, MIDDLE, ROW - REACH)[GREEN], ON_AXIS);
    expect(under(long, MIDDLE + REACH, ROW)).toEqual([0, 0, 0]);
  }, 240_000);

  it("Direction in Map mode gives each lamp a way of its own, in place of the Light's, and Orient turns that too", async () => {
    // `way`: the red lamp along +x and down, the green one along −z and down, the blue one straight down.
    const own = (await render({ ...SPOTS, light: { ...OBLIQUE, direction: mapped("way", [0, -1, 0]) } })).last;
    expectLit(under(own, THREE_LAMPS_AT[0] + REACH, ROW)[0], ON_AXIS);
    expectLit(under(own, MIDDLE, ROW - REACH)[GREEN], ON_AXIS);
    expectLit(under(own, THREE_LAMPS_AT[2], ROW)[2], lampOnFloor(LAMP_INTENSITY, 6));
    // Each of the three is dark where another's way would have taken it.
    expect(under(own, THREE_LAMPS_AT[0], ROW)).toEqual([0, 0, 0]);
    expect(under(own, MIDDLE + REACH, ROW)).toEqual([0, 0, 0]);
    expect(under(own, THREE_LAMPS_AT[2], ROW - REACH)).toEqual([0, 0, 0]);

    // The edge cut: with Direction back to the value, every lamp shines the Light's own way, straight down.
    const one = (await render({ ...SPOTS, light: { ...OBLIQUE, direction: [0, -1, 0] } })).last;
    THREE_LAMPS_AT.forEach((x, lamp) => expectLit(under(one, x, ROW)[lamp], lampOnFloor(LAMP_INTENSITY, 6)));
    expect(under(one, THREE_LAMPS_AT[0] + REACH, ROW)).toEqual([0, 0, 0]);
    expect(under(one, MIDDLE, ROW - REACH)).toEqual([0, 0, 0]);

    // Both in Map mode: the red lamp's way, +x and down, turned a quarter turn about +Y, is −z and down.
    const both = (await render({ ...SPOTS, light: { ...OBLIQUE, direction: mapped("way", [0, -1, 0]), orient: mapped("turn", [0, 0, 0, 1]) } })).last;
    expectLit(under(both, THREE_LAMPS_AT[0], ROW - REACH)[0], ON_AXIS);
    // And the green lamp's, −z and down, is −x and down: it lands where the red lamp's own way had taken the red one.
    const landed = under(both, THREE_LAMPS_AT[0] + REACH, ROW);
    expect(landed[0]).toBe(0);
    expectLit(landed[GREEN], ON_AXIS);
  }, 240_000);

  it("the consumer's lamps: along a climbing path each shines along its own frame's down, from the orient of Curve Frames, and does not light the crown beside it", async () => {
    // Three lamps half a unit in front of the wall, on a path that climbs at 45 degrees
    // along it. The path's frame at every lamp: its tangent (1, 1, 0)/√2, its normal the
    // perpendicular nearest to up, (−1, 1, 0)/√2. So "down" for a lamp is (1, −1, 0)/√2:
    // ahead and below, not below. Cone 150 with a soft edge, as the consumer lights its tunnel.
    // The path is straight, so the three frames are one frame: that each point's own turn is
    // read is the case of `swing` above. This one is the chain, Curve Frames into a Light.
    const DEPTH = 0.5;
    const FRAME_DOWN = [Math.SQRT1_2, -Math.SQRT1_2, 0] as const;
    const WORLD_DOWN = [0, -1, 0] as const;
    const LAMPS: ReadonlyArray<readonly [number, number]> = [
      [-3.9375, 2.0625],
      [-1.9375, 4.0625],
      [0.0625, 6.0625],
    ];
    const path = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let along = f32(ctx.index) * 2.0;
  q.position = vec3f(along - 3.9375, along + 2.0625, ${WALL_Z + DEPTH});
  q.color = vec4f(f32(ctx.index == 0u), f32(ctx.index == 1u), f32(ctx.index == 2u), 1.0);
  return q;
}`;
    const attributes = JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      { name: "color", type: "vec4f", qualifier: "color", default: [1, 1, 1, 1] },
    ]);
    const RANGE = 24;
    const lamps = (light: Record<string, unknown>): LampsScene => ({
      unwired: true,
      scenes: "geometry_wall",
      camera: FRONT_CAMERA,
      light: { direction: [...WORLD_DOWN], cone: 150, coneSoftness: 0.8, range: RANGE, color: mapped("color", [1, 1, 1, 1]), ...light },
      nodes: [
        { id: "kernel_path", type: "pointKernel", parameters: { capacity: 3, attributes, kernel: path } },
        { id: "topology_path", type: "pointTopology", parameters: { connectivity: "strips", cols: 3, rows: 1 } },
        { id: "frames_path", type: "pointCurveFrames", parameters: {} },
      ],
      edges: [
        ["kernel_path", "topology_path", "points"],
        ["topology_path", "frames_path", "points"],
        ["frames_path", "light_lamps", "points"],
      ],
    });
    const onWall = (frame: RenderedFrame, x: number, y: number): number[] => {
      const [px, py] = pixelOf(FRONT_CAMERA, [x, y, WALL_Z]);
      return pixelAt(frame, px, py).slice(0, 3);
    };
    /** What lamp `index` gives the wall at a place, shining along `axis` inside the consumer's cone. */
    const spotOnWall = (index: number, x: number, y: number, axis: readonly [number, number, number]): number => {
      const lamp = LAMPS[index] as readonly [number, number];
      const out = [x - lamp[0], y - lamp[1], -DEPTH] as const;
      const cosine = (out[0] * axis[0] + out[1] * axis[1] + out[2] * axis[2]) / Math.hypot(...out);
      return lampOnPlane([-out[0], -out[1], -out[2]], [0, 0, 1], LAMP_INTENSITY, RANGE) * spotShare(150, 0.8, cosine);
    };
    const [mx, my] = LAMPS[1] as readonly [number, number];

    const framed = (await render(lamps({ kind: "spot", orient: mapped("orient", [0, 0, 0, 1]) }))).last;
    // Along its own down, one unit ahead and one below: nearly all of the middle lamp's light,
    // and the fade of its two neighbours', each in its own colour.
    const below = onWall(framed, mx + 1, my - 1);
    expect(spotOnWall(1, mx + 1, my - 1, FRAME_DOWN)).toBeCloseTo(0.2363, 4);
    [0, 1, 2].forEach((lamp) => expectLit(below[lamp], spotOnWall(lamp, mx + 1, my - 1, FRAME_DOWN)));
    // THE CROWN BESIDE IT: one unit on along the path, level with the lamp in the path's own
    // frame. A quarter turn off every lamp's axis, outside the cone: exactly nothing, of any of the three.
    expect(onWall(framed, mx + 1, my + 1)).toEqual([0, 0, 0]);
    // As bare lamps the same three light that crown as brightly as the wall below them.
    const bareLamps = (await render(lamps({ kind: "point" }))).last;
    expectLit(onWall(bareLamps, mx + 1, my + 1)[GREEN], lampOnPlane([-1, -1, DEPTH], [0, 0, 1], LAMP_INTENSITY, RANGE));
    expect(onWall(bareLamps, mx + 1, my + 1)[GREEN]).toBeGreaterThan(0.2);

    // THE EDGE CUT. With Orient's map cut the lamps shine straight down the world instead.
    // Level with the lamp and ahead of it is lit along the frame's down and dark along the world's;
    // behind and below it is the other way round.
    const world = (await render(lamps({ kind: "spot" }))).last;
    expectLit(onWall(framed, mx + 1.5, my)[GREEN], spotOnWall(1, mx + 1.5, my, FRAME_DOWN));
    expect(onWall(framed, mx + 1.5, my)[GREEN]).toBeGreaterThan(0.1);
    expect(onWall(world, mx + 1.5, my)[GREEN]).toBe(0);
    expect(onWall(framed, mx - 1.25, my - 1.25)[GREEN]).toBe(0);
    expectLit(onWall(world, mx - 1.25, my - 1.25)[GREEN], spotOnWall(1, mx - 1.25, my - 1.25, WORLD_DOWN));
    expect(onWall(world, mx - 1.25, my - 1.25)[GREEN]).toBeGreaterThan(0.05);
  }, 240_000);
});
