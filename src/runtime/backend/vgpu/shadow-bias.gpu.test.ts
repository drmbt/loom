import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1438b on a REAL device, exact to the byte (§V147): a light's Shadow Bias is in METRES.
 *
 * A thin plate hangs over a floor with a known GAP between the plate's underside and the
 * floor. A receiver counts as shadowed while it sits more than (built-in bias + Shadow Bias)
 * behind what the map stored, so the floor under the plate:
 *  - is the ambient floor to the byte with Shadow Bias 0 (the default every saved document
 *    keeps) and with a bias well under the gap;
 *  - is lit, to the byte of the same light with Cast Shadows off, once the bias exceeds the
 *    gap.
 * Bracketing the gap from both sides pins the UNIT: a bias read as a share of the range, or
 * of the directional volume's depth, would land on the wrong side of one bracket. The point
 * light's range is 12 m (where a share-of-range bias would be 12× too big); the directional
 * volume's depth is 3 × extent = 18 m.
 *
 * Why no acne repro: at this commit the reported acne (T1400b closeups, a shoe key at 2.5 m)
 * did not reproduce — not on a grazing floor, a coarse smooth-normal tube, nor the sneaker
 * shot at 1, 2.5 and 10 m ranges and 960 to 3840 px — after e9b15ddb made the cube bias
 * texel-true. The knob is the escape hatch the row asked for; this pins what it does.
 */

const SIZE = 64;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const FLOOR = {
  positions: [-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
  material: 0,
};
/** A 1.6 × 0.1 × 1.6 m plate whose underside is GAP = 0.5 m above the floor. */
const GAP = 0.5;
const GLB = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "floor", mesh: [FLOOR] },
    { name: "plate", translation: [0, GAP + 0.05, 0], scale: [1.6, 0.1, 1.6], mesh: [cubePrimitive(0)] },
  ],
});
const FACTS = prepareMesh(GLB, "")!.facts;
/** Low and to the side, so the floor under the plate's edge is visible past it. */
const EYE: [number, number, number] = [0, 1.2, 3.2];
const LOOK: [number, number, number] = [0, 0, 0.6];
/** On the floor under the plate, 0.2 m in from its front edge — seen past the edge from EYE. */
const UNDER: [number, number, number] = [0, 0, 0.6];

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

function graph(light: Record<string, unknown>): GraphDocument {
  const nodes = [
    node("mesh", "meshFileIn", { vertices: FACTS.vertices, triangles: FACTS.triangles, parts: FACTS.parts }, "mesh1"),
    node("geo", "geometry", { mode: "surface" }, "geo1"),
    node("cam", "camera", { eye: EYE, lookAt: LOOK }, "cam1"),
    node("key", "light", { shadowSoftness: 0, ...light }, "key1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "key1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 }, "shot1"),
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "mesh", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

async function render(light: Record<string, unknown>): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(light),
    settings: SETTINGS,
    frames: 2,
    outputNodeId: "shot",
    outputPortId: "out",
    meshes: { mesh: GLB },
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  return frame.bytes;
}

const matrix = cameraPayloadMatrix({ eye: EYE, lookAt: LOOK, fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
function texelOf(world: readonly [number, number, number]): number {
  const clip = transformPoint(matrix, world);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return (y * SIZE + x) * 4;
}
const rgb = (bytes: Uint8Array, at: number): number[] => [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];
const FLOOR_ONLY = Math.round(0.8 * 0.12 * 255);

/**
 * Straight down, the receiver sits exactly GAP behind the plate's underside, radially (point)
 * and along the light (directional). The built-in bias at a floor lit head-on is a texel or
 * so — centimetres here — so 0.3 m is well inside the gap and 0.7 m well past it.
 */
const INSIDE = 0.3;
const PAST = 0.7;

async function bracket(light: Record<string, unknown>): Promise<void> {
  const at = texelOf(UNDER);
  const open = rgb(await render(light), at);
  expect(open[0]).toBeGreaterThan(FLOOR_ONLY + 20);
  expect(rgb(await render({ ...light, shadows: true }), at)).toEqual([FLOOR_ONLY, FLOOR_ONLY, FLOOR_ONLY]);
  expect(rgb(await render({ ...light, shadows: true, shadowBias: INSIDE }), at)).toEqual([FLOOR_ONLY, FLOOR_ONLY, FLOOR_ONLY]);
  expect(rgb(await render({ ...light, shadows: true, shadowBias: PAST }), at)).toEqual(open);
}

describe("a light's Shadow Bias is in metres on Dawn (T1438b, §V147)", () => {
  it("a point light (12 m range): the floor 0.5 m under a plate stays shadowed at 0.3 m of bias and is lit at 0.7 m", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    await bracket({ kind: "point", position: [0, 3, 0.6], intensity: 10, shadowExtent: 12 });
  });

  it("a directional light (18 m of volume depth): the same bracket, converted by the volume's own depth range", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    await bracket({ kind: "directional", direction: [0, -1, 0], intensity: 1, shadowExtent: 6 });
  });
});
