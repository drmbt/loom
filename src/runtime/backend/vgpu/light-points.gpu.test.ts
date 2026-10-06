import { describe, expect, it } from "vitest";

import type { CompiledGraph } from "../../../compiler/index.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import type { ProjectSettings } from "../../../domain/types/graph.ts";
import {
  FLOOR_ALBEDO,
  LAMP_HEIGHT,
  LAMP_INTENSITY,
  LAMP_RANGE,
  SCATTERED_LAMPS,
  THREE_LAMPS_AT,
  TOP_CAMERA,
  lampOnFloor,
  lampsScene,
  mapped,
  type LampsScene,
} from "../../../nodes/definitions/light-points.fixture.ts";
import { lightGridDimensions, lightTableStorage } from "../../../nodes/definitions/light-records.ts";
import { CASTERS_GLB } from "../../../nodes/definitions/shadow-casters.fixture.ts";
import { lightTableRowAt } from "../../../nodes/shaders/scene-lights.wgsl.ts";
import { LIGHT_GUARD_ABOVE } from "../../../nodes/shaders/scene-render.wgsl.ts";
import { TOLERANCE_CROSS_GPU_HDR, pixelAt } from "../../../tests/headless/pixel-compare.ts";
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
