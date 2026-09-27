import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1405b on a REAL device, exact to the byte (§V147): a directional light's Shadow Centre.
 *
 * The bug: a directional light's shadow volume was framed around the WORLD ORIGIN, Shadow
 * Extent either side, so a set built 20 m away got no sun shadows at all — On Nothing's sets
 * sit where the warehouse put them, not at the origin.
 *
 * A plate hangs 0.5 m over a floor, the whole set 20 m out along +x, under a sun straight
 * down with a 2 m extent. The floor under the plate:
 *  - with the default centre (the origin) is LIT, to the byte of the same sun not casting —
 *    the set is outside the volume, which is the bug;
 *  - with Shadow Centre on the set is the ambient floor to the byte.
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

const SET: [number, number, number] = [20, 0, 0];
const FLOOR = {
  positions: [-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4].map((value, index) => value + (SET[index % 3] ?? 0)),
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
  material: 0,
};
const GLB = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "floor", mesh: [FLOOR] },
    { name: "plate", translation: [SET[0], 0.55, SET[2]], scale: [1.6, 0.1, 1.6], mesh: [cubePrimitive(0)] },
  ],
});
const FACTS = prepareMesh(GLB, "")!.facts;
const EYE: [number, number, number] = [SET[0], 1.2, 3.2];
const LOOK: [number, number, number] = [SET[0], 0, 0.6];
/** On the floor under the plate, 0.2 m in from its front edge — seen past the edge from EYE. */
const UNDER: [number, number, number] = [SET[0], 0, 0.6];

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
    node("sun", "light", { kind: "directional", direction: [0, -1, 0], intensity: 1, shadowExtent: 2, shadowSoftness: 0, ...light }, "sun1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "sun1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 }, "shot1"),
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

describe("a directional light's Shadow Centre on Dawn (T1405b, §V147)", () => {
  it("a set 20 m off the origin: unshadowed with the default centre, shadowed with the centre on the set", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const at = texelOf(UNDER);
    const open = rgb(await render({}), at);
    expect(open[0]).toBeGreaterThan(FLOOR_ONLY + 20);
    // the bug, pinned: the origin-framed volume does not reach the set
    expect(rgb(await render({ shadows: true }), at)).toEqual(open);
    // the fix: framed on the set, the plate shadows the floor under it
    expect(rgb(await render({ shadows: true, shadowCenter: SET }), at)).toEqual([FLOOR_ONLY, FLOOR_ONLY, FLOOR_ONLY]);
  });
});
