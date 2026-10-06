import { describe, expect, it } from "vitest";

import type { ProjectSettings } from "../../../domain/types/graph.ts";
import {
  LAMP_AT_WALL,
  RING,
  SHADOW_MESH_MESHES,
  SUN_AT_WALL,
  sagitta,
  shadowMeshScene,
  type ShadowMeshScene,
} from "../../../nodes/definitions/shadow-mesh.fixture.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1689b on a REAL device (§V147): a Geometry's shadow mesh casts in its shape's place.
 *
 * The scene is `shadow-mesh.fixture.ts`: a ring two metres in front of a wall, the lens
 * straight at the wall, orthographic, twelve metres over 192 pixels.
 *
 *  - A shadow mesh that IS the shape draws the picture drawn with none, byte for byte: the
 *    sweep reads the other input and nothing else moved (a sun, a point light's six faces,
 *    and a geometry that leaves instances out, whose sweeps draw by arguments of their own).
 *  - With Cast Shadows off, a shadow mesh changes no byte: nothing the camera sees reads it.
 *  - THE PROXY'S SHADOW ON A LIT WALL. Under a sun travelling straight at the wall the ring's
 *    shadow is an annulus, radius 1.1 to 1.9, and each mesh's own shadow falls short of that
 *    circle by no more than its SAGITTA (a chord for an arc): 0.041 m at the outer edge for the
 *    low ring's fifteen segments, 0.010 for the full ring's thirty. So the two pictures may
 *    differ only where a pixel's centre lies between the low ring's deepest chord and the
 *    circle, give or take ONE TEXEL of the shadow map (the map is twice the picture: a texel
 *    is half a pixel, 1/32 m, and its diagonal is what a lookup can be off by). That band is
 *    the whole claim: every pixel outside it is the same bytes, the ring's whole shadow among
 *    them, and inside it some pixels do differ, since the proxy is coarser.
 */

const SIZE = 192;
const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};
/** Metres a picture pixel, and a shadow-map texel under SUN_AT_WALL (Shadow Extent 6: twelve metres over twice the picture). */
const PIXEL = 12 / SIZE;
const TEXEL = 12 / (2 * SIZE);

async function frame(scene: ShadowMeshScene): Promise<Uint8Array> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const result = await renderHeadless({ host: nodeGpuHost(), graph: shadowMeshScene(scene), settings, frames: 2, outputNodeId: "render_shot", outputPortId: "out", meshes: SHADOW_MESH_MESHES });
  expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const last = result.frames[result.frames.length - 1];
  if (last === undefined) throw new Error("no frame captured");
  expect([last.width, last.height, last.format]).toEqual([SIZE, SIZE, "rgba16float"]);
  return last.bytes;
}
/** The pixels whose eight bytes differ, as [x, y]. */
function differing(a: Uint8Array, b: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
    for (let byte = 0; byte < 8; byte += 1) {
      if (a[pixel * 8 + byte] !== b[pixel * 8 + byte]) {
        out.push([pixel % SIZE, Math.floor(pixel / SIZE)]);
        break;
      }
    }
  }
  return out;
}
/** How far a pixel's centre is from the wall's middle, in metres. */
const radiusOf = ([x, y]: [number, number]): number => Math.hypot((x + 0.5) * PIXEL - 6, (y + 0.5) * PIXEL - 6);
/** The wall's red at a place on it. */
function wallAt(bytes: Uint8Array, x: number, y: number): number {
  const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const bits = halves[(Math.floor((6 - y) / PIXEL) * SIZE + Math.floor((x + 6) / PIXEL)) * 4] as number;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  return exponent === 0 ? 2 ** -14 * (fraction / 1024) : 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** A sun from the side, so that a ring's shadow falls beside the ring and is in view (straight on, the ring hides its own). */
const SIDE_SUN = { ...SUN_AT_WALL, direction: [0.5, 0, -1] };
/** Two rings side by side, each wholly in front of the wall. */
const TWO = { rings: 2, place: "  q.position = vec3f(select(-2.5, 2.5, i == 1u), 0.0, 2.0);" };

describe("T1689b: a shadow mesh that is the shape, on Dawn (§V147)", () => {
  it.each([
    ["a sun", { lights: [SIDE_SUN] }],
    ["a point light, six faces", { lights: [LAMP_AT_WALL] }],
    ["a sun and a point light, and the shadow matte beside them", { lights: [SIDE_SUN, LAMP_AT_WALL], render: { shadowOutput: true } }],
    ["a geometry that leaves an instance out: the sweeps draw by the shadow mesh's own arguments", { ...TWO, lights: [SIDE_SUN, LAMP_AT_WALL], place: `${TWO.place}\n  q.keep = select(0.0, 1.0, i == 1u);`, geometry: { group: "p.keep > 0.5" } }],
  ] as Array<[string, ShadowMeshScene]>)("%s: the picture with the shape wired to Shadow Mesh is the picture with nothing wired, byte for byte", async (_name, scene) => {
    const none = await frame(scene);
    expect(differing(await frame({ ...scene, proxy: "mesh_ring" }), none)).toEqual([]);
    // And it is a picture of a ring that casts: without the light's shadow it is another.
    expect(differing(none, await frame({ ...scene, lights: (scene.lights ?? []).map((light) => ({ ...light, shadows: false })) })).length).toBeGreaterThan(200);
  }, 240_000);

  it("the instance left out casts nothing through the shadow mesh either: the wall behind it is lit", async () => {
    const scene: ShadowMeshScene = { ...TWO, lights: [SUN_AT_WALL], place: `${TWO.place}\n  q.keep = select(0.0, 1.0, i == 1u);`, geometry: { group: "p.keep > 0.5", shadowOnly: true }, proxy: "mesh_low" };
    const bytes = await frame(scene);
    // Under the kept ring's tube (x = 2.5 + 1.5) the wall is in shadow; under where the other would be (x = -2.5 - 1.5), lit.
    expect(wallAt(bytes, -4, 0)).toBeGreaterThan(wallAt(bytes, 4, 0) * 4);
  }, 240_000);
});

describe("T1689b: what the camera sees does not read the shadow mesh, on Dawn", () => {
  it("with Cast Shadows off the low ring on Shadow Mesh changes no byte of the picture, the ring in view and lit", async () => {
    const unlitByShadow = { lights: [{ ...SUN_AT_WALL, shadows: false }, { ...LAMP_AT_WALL, shadows: false }] };
    expect(differing(await frame({ ...unlitByShadow, proxy: "mesh_low" }), await frame(unlitByShadow))).toEqual([]);
  }, 240_000);
});

describe("T1689b: a lit wall behind one ring, the full ring casting against the low one, on Dawn", () => {
  const OUTER = RING.major + RING.tube;
  const INNER = RING.major - RING.tube;
  const SLACK = TEXEL * Math.SQRT2;
  /** Where the low ring's shadow may differ from the full ring's: between its deepest chord and the circle, a texel either side. */
  const bands: ReadonlyArray<readonly [number, number]> = [
    [OUTER - sagitta(OUTER, RING.low[0]) - SLACK, OUTER + SLACK],
    [INNER - sagitta(INNER, RING.low[0]) - SLACK, INNER + SLACK],
  ];
  const inABand = (radius: number): boolean => bands.some(([from, to]) => radius >= from && radius <= to);

  it("the two shadows differ only within the low ring's sagitta and a texel of the annulus's two edges; everywhere else the wall is the same bytes", async () => {
    // The ring casts and is not seen (Shadow Only): the picture is the wall and the shadow on it.
    const scene: ShadowMeshScene = { lights: [SUN_AT_WALL], geometry: { shadowOnly: true } };
    const full = await frame(scene);
    const low = await frame({ ...scene, proxy: "mesh_low" });
    // The bound, in numbers: 0.0415 m and a texel's diagonal at the outer edge, 0.0240 m and the same at the inner; a texel is 0.03125 m.
    expect(bands.map(([from, to]) => [from.toFixed(4), to.toFixed(4)])).toEqual([["1.8143", "1.9442"], ["1.0318", "1.1442"]]);
    const moved = differing(full, low);
    expect(moved.filter((pixel) => !inABand(radiusOf(pixel)))).toEqual([]);
    // The proxy IS coarser: some pixels of the bands do differ, and far fewer than the bands hold.
    const held = Array.from({ length: SIZE * SIZE }, (_, pixel): [number, number] => [pixel % SIZE, Math.floor(pixel / SIZE)]).filter((pixel) => inABand(radiusOf(pixel))).length;
    expect(moved.length).toBeGreaterThan(20);
    expect(moved.length).toBeLessThan(held / 2);
    // Both are a ring's shadow: dark under the tube's middle, lit in the hole and outside.
    for (const bytes of [full, low]) {
      const lit = wallAt(bytes, 0, 0);
      expect(wallAt(bytes, 3, 3)).toBe(lit);
      expect(wallAt(bytes, RING.major, 0)).toBeLessThan(lit / 4);
      expect(wallAt(bytes, 0, -RING.major)).toBe(wallAt(bytes, RING.major, 0));
    }
  }, 240_000);

  it("a shadow mesh that stands apart casts from where IT stands: the shadow moves with it, and the node has said so", async () => {
    // `mesh_off` is the low ring three metres along x in its own frame.
    const bytes = await frame({ lights: [SUN_AT_WALL], geometry: { shadowOnly: true }, proxy: "mesh_off" });
    const lit = wallAt(bytes, -4, -4);
    expect(wallAt(bytes, 3 + RING.major, 0)).toBeLessThan(lit / 4);
    expect(wallAt(bytes, -RING.major, 0)).toBe(lit);
  }, 240_000);
});
