import { describe, expect, it } from "vitest";

import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import type { ProjectSettings } from "../../../domain/types/graph.ts";
import {
  AMBIENT,
  FLOOR_ALBEDO,
  PLATE,
  SHADOW_LAYERS_CAMERA,
  SHADOW_LAYERS_MESHES,
  castingLamp,
  castingSun,
  shadowLayersScene,
} from "../../../nodes/definitions/shadow-layers.fixture.ts";
import { TOLERANCE_CROSS_GPU_HDR, pixelAt } from "../../../tests/headless/pixel-compare.ts";
import { renderHeadless, type RenderedFrame } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1623b, slice 4, on a REAL device (§V147): a casting light's shadow map is a layer of one
 * of its Render's two layered targets, and each light reads its own, through a 2D view of
 * that one layer.
 *
 * The scene is `shadow-layers.fixture.ts`: a white floor and a unit box over its middle,
 * seen from straight above, under casting lights of the test's own. Each light throws the
 * box's shadow to a place of its own, and each has an intensity of its own, so a floor pixel
 * says WHICH lights reach it: its value is the ambient and the sum of the lights that are
 * not shadowed there, by the Render's own arithmetic. A light reading another light's layer
 * would put a shadow where that other light throws one and none where its own falls.
 *
 * The box alone cannot show that for suns that mirror one another (their maps are mirror
 * images too), so the fixture has a plate off the middle and every sun's shadow of THAT is
 * probed as well: see the fixture.
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

type Vec3 = readonly [number, number, number];

async function render(lights: ReadonlyArray<Record<string, unknown>>, render: Record<string, unknown> = {}): Promise<RenderedFrame> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: shadowLayersScene(lights, render),
    settings,
    frames: 2,
    outputNodeId: "render_shot",
    outputPortId: "out",
    meshes: SHADOW_LAYERS_MESHES,
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  return frame;
}

/** The floor's red at a place on it, seen from above. */
function floorAt(frame: RenderedFrame, x: number, z: number): number {
  const matrix = cameraPayloadMatrix({ eye: [...SHADOW_LAYERS_CAMERA.eye] as [number, number, number], lookAt: [0, 0, 0], fovDeg: 55, near: 0.1, far: 40, ortho: true, orthoHeight: 12, roll: 0 }, 1);
  const clip = transformPoint(matrix, [x, 0, z]);
  const px = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const py = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return pixelAt(frame, px, py)[0] as number;
}
const expectLit = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(TOLERANCE_CROSS_GPU_HDR);
};

/** What a sun of this intensity travelling along `direction` gives the floor: albedo × intensity × the cosine. */
const sunOnFloor = (direction: Vec3, intensity: number): number => (FLOOR_ALBEDO * intensity * -direction[1]) / Math.hypot(...direction);
/** What a lamp gives a floor point: albedo × intensity × the soft falloff 1 / (1 + d²) × the cosine. */
function lampOnFloor(position: Vec3, intensity: number, x: number, z: number): number {
  const distance = Math.hypot(position[0] - x, position[1], position[2] - z);
  return (FLOOR_ALBEDO * intensity * (position[1] / distance)) / (1 + distance * distance);
}
const ambient = FLOOR_ALBEDO * AMBIENT;

describe("each casting light reads its own layer, on Dawn (T1623b slice 4, §V147)", () => {
  /* Three suns at 45 degrees. A sun travelling (1, −1, 0) throws the box's shadow over x from
     0 to 2 (z within half a metre); (−1, −1, 0) over x from −2 to 0; (0, −1, 1) over z from 0
     to 2 (x within half a metre). Four probes: one inside each shadow alone, one outside all. */
  const EAST: Vec3 = [1, -1, 0];
  const WEST: Vec3 = [-1, -1, 0];
  const SOUTH: Vec3 = [0, -1, 1];
  const PROBES = { east: [1.4, 0], west: [-1.4, 0], south: [0, 1.4], open: [-3, -3] } as const;
  /* The plate is a metre up, so each sun throws its shadow a metre along its way: east of it
     over x from 3.5 to 4.5, west of it over x from 1.5 to 2.5, south of it over z from −2 to −1. */
  const PLATE_PROBES: Readonly<Record<"east" | "west" | "south", readonly [number, number]>> = { east: [PLATE.x[1] + 0.5, -2.5], west: [PLATE.x[0] - 0.5, -2.5], south: [3, PLATE.z[1] + 0.5] };
  const gains = { east: 1, west: 0.5, south: 0.25 };
  const each = { east: sunOnFloor(EAST, gains.east), west: sunOnFloor(WEST, gains.west), south: sunOnFloor(SOUTH, gains.south) };
  const all = each.east + each.west + each.south;
  /** Every probe of the three suns' picture: the box's three shadows, the plate's three, and the open floor. */
  const expectThreeShadows = (frame: RenderedFrame): void => {
    expectLit(floorAt(frame, ...PROBES.open), ambient + all);
    const at = (probe: readonly [number, number]): number => floorAt(frame, probe[0], probe[1]);
    for (const probes of [PROBES, PLATE_PROBES]) {
      expectLit(at(probes.east), ambient + all - each.east);
      expectLit(at(probes.west), ambient + all - each.west);
      expectLit(at(probes.south), ambient + all - each.south);
    }
  };

  /* Hard-edged (one read of the map) and soft (the taps of Shadow Softness 1, another text):
     every probe is half a metre inside its shadow and a tap reaches a texel, a tenth of a metre. */
  it.each([0, 1])("three casting suns at Shadow Softness %i: each one's shadow where it throws it, the other two lighting it", async (shadowSoftness) => {
    const frame = await render([castingSun(EAST, gains.east, { shadowSoftness }), castingSun(WEST, gains.west, { shadowSoftness }), castingSun(SOUTH, gains.south, { shadowSoftness })]);
    expectThreeShadows(frame);
    // The three shadows are three different values: a layer read by the wrong light would swap two of them.
    expect(new Set([each.east, each.west, each.south].map((value) => value.toFixed(4))).size).toBe(3);
  }, 240_000);

  it("the same three listed in another order, and the box drawn ahead of the floor: a layer follows its light, and keeps the nearest of what is drawn into it", async () => {
    /* The second half is the depth buffer the layers share: with the floor drawn AFTER the box
       and no depth test, the floor's distance would stand where the box's was, in every layer,
       and no shadow would fall. */
    const frame = await render([castingSun(SOUTH, gains.south), castingSun(EAST, gains.east), castingSun(WEST, gains.west)], { scenes: "geometry_box geometry_floor" });
    expectThreeShadows(frame);
  }, 240_000);

  it("two casting lamps and a casting sun between them in the list: two layers of the cubes and one of the maps", async () => {
    // A lamp to the west throws the box's shadow east, and the other way round; the sun throws it south.
    const WEST_LAMP: Vec3 = [-2, 3, 0];
    const EAST_LAMP: Vec3 = [2, 3, 0];
    const gains = { westLamp: 12, sun: 0.25, eastLamp: 6 };
    const frame = await render([castingLamp(WEST_LAMP, gains.westLamp), castingSun(SOUTH, gains.sun), castingLamp(EAST_LAMP, gains.eastLamp)]);
    const at = (x: number, z: number) => ({ west: lampOnFloor(WEST_LAMP, gains.westLamp, x, z), east: lampOnFloor(EAST_LAMP, gains.eastLamp, x, z), sun: sunOnFloor(SOUTH, gains.sun) });
    // A lamp's light changes from one pixel to the next, so each probe is a pixel's CENTRE (a pixel is an eighth of a metre).
    const NEAR = 1.4375;
    const FAR = -2.9375;
    // Out in the open: all three.
    const open = at(FAR, FAR);
    expectLit(floorAt(frame, FAR, FAR), ambient + open.west + open.east + open.sun);
    // East of the box the west lamp is shadowed (its ray to there passes the box at y 1.25) and the east lamp is not.
    const east = at(NEAR, 0.0625);
    expectLit(floorAt(frame, NEAR, 0.0625), ambient + east.east + east.sun);
    // West of it, the other way round.
    const west = at(-NEAR, 0.0625);
    expectLit(floorAt(frame, -NEAR, 0.0625), ambient + west.west + west.sun);
    // South of it the sun is shadowed and both lamps light.
    const south = at(0.0625, NEAR);
    expectLit(floorAt(frame, 0.0625, NEAR), ambient + south.west + south.east);
    // The two lamps give that place different amounts, so reading each other's layer would show.
    expect(Math.abs(east.east - west.west) / west.west).toBeGreaterThan(0.2);
  }, 240_000);

  it("sixteen casting suns in one Render, as many as a stage may bind textures: every layer is drawn and read", async () => {
    // Eight travel east and eight west, each with a gain of its own. A shadow is then eight suns' worth exactly:
    // one layer left undrawn, or read by another light, would leave light in it or take light from the open floor.
    const suns = Array.from({ length: 16 }, (_, index) => ({ direction: index % 2 === 0 ? EAST : WEST, gain: 0.02 + index * 0.01 }));
    const frame = await render(suns.map((sun) => castingSun(sun.direction, sun.gain)));
    const sum = (direction: Vec3): number => suns.filter((sun) => sun.direction === direction).reduce((total, sun) => total + sunOnFloor(direction, sun.gain), 0);
    expectLit(floorAt(frame, ...PROBES.open), ambient + sum(EAST) + sum(WEST));
    expectLit(floorAt(frame, ...PROBES.east), ambient + sum(WEST));
    expectLit(floorAt(frame, ...PROBES.west), ambient + sum(EAST));
    expect(Math.abs(sum(EAST) - sum(WEST)) / sum(WEST)).toBeGreaterThan(0.05);
  }, 240_000);
});
