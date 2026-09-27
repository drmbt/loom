import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1425b on a REAL device, exact to the byte (§V147): a CLOSE point key's shadow GROWS with
 * distance, so a small silhouette is magnified on the wall behind it.
 *
 * The row asked for a shadowed close point/spot key whose shadow grows. A casting point light
 * has done that since T1362b (its cube faces are perspective sweeps from the lamp), and a
 * projector with Occlusion is the shadowed spot (T704); this pins the point case analytically
 * so the magnification is a fact, not a hope.
 *
 * A lamp at x = 0; a 0.2 m square plate whose near face is at x = 0.49; a wall at x = 2. The
 * plate's shadow on the wall spans ±0.1 × 2 / 0.49 = ±0.408 m about (y 1, z 0) — 4.08× the
 * plate. At 192 px the cube tile is 96 × 144 texels, so a shadow texel on that wall is about
 * 4 cm across and 3 cm tall, and every reading keeps two or more texels from the edge:
 *  - z = 0.25 (outside the plate's own ±0.1, inside its magnified shadow), z = 0.33 and
 *    y = 1.3 read the ambient floor to the byte;
 *  - z = 0.52 and y = 1.5 (past the magnified edge) read the byte of the lamp not casting.
 * An orthographic (non-growing) shadow would light z = 0.25 and fail the first reading.
 */

const SIZE = 192;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const GLB = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
  nodes: [
    // the wall's lit face is x = 2
    { name: "wall", translation: [2.05, 1, 0], scale: [0.1, 3, 3], mesh: [cubePrimitive(0)] },
    // the plate: x 0.49..0.51, y 0.9..1.1, z −0.1..0.1
    { name: "plate", translation: [0.5, 1, 0], scale: [0.02, 0.2, 0.2], mesh: [cubePrimitive(0)] },
  ],
});
const FACTS = prepareMesh(GLB, "")!.facts;
const LAMP: [number, number, number] = [0, 1, 0];
const EYE: [number, number, number] = [1.0, 1.0, 2.5];
const LOOK: [number, number, number] = [2, 1, 0.3];

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

function graph(shadows: boolean): GraphDocument {
  const nodes = [
    node("mesh", "meshFileIn", { vertices: FACTS.vertices, triangles: FACTS.triangles, parts: FACTS.parts }, "mesh1"),
    node("geo", "geometry", { mode: "surface" }, "geo1"),
    node("cam", "camera", { eye: EYE, lookAt: LOOK }, "cam1"),
    node("key", "light", { kind: "point", position: LAMP, intensity: 4, shadows, shadowExtent: 5, shadowSoftness: 0 }, "key1"),
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

async function render(shadows: boolean): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(shadows),
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
const onWall = (z: number): [number, number, number] => [2, 1, z];

describe("a close point key's shadow grows with distance on Dawn (T1425b, §V147)", () => {
  it("a 0.2 m plate half a metre from the lamp throws a 0.82 m shadow on a wall 2 m away", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const cast = await render(true);
    const uncast = await render(false);
    for (const point of [onWall(0.25), onWall(0.33), [2, 1.3, 0] as [number, number, number]]) {
      expect(rgb(cast, texelOf(point))).toEqual([FLOOR_ONLY, FLOOR_ONLY, FLOOR_ONLY]);
      expect(rgb(uncast, texelOf(point))[0]).toBeGreaterThan(FLOOR_ONLY + 20);
    }
    for (const point of [onWall(0.52), [2, 1.5, 0] as [number, number, number]]) {
      expect(rgb(cast, texelOf(point))).toEqual(rgb(uncast, texelOf(point)));
    }
  });
});
