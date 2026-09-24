import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1362b on a REAL device, exact to the byte (§V147): a POINT light casts.
 *
 * A unit box hangs over a floor with a point light straight above it. The box's shadow on
 * the floor, seen from above past the box's own top, must be the AMBIENT FLOOR to the byte;
 * open floor further out must be the analytic inverse-square lambert; and the CUT — the same
 * light with Cast Shadows off — must light the shadowed texel. All three read one frame.
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
const GLB = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "floor", mesh: [FLOOR] },
    { name: "box", translation: [0, 1, 0], mesh: [cubePrimitive(0)] },
  ],
});
const FACTS = prepareMesh(GLB, "")!.facts;
const EYE: [number, number, number] = [0, 7, 0.01];
const LIGHT: [number, number, number] = [0, 3, 0];
const INTENSITY = 10;

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
    node("cam", "camera", { eye: EYE, lookAt: [0, 0, 0] }, "cam1"),
    node("bulb", "light", { kind: "point", position: LIGHT, intensity: INTENSITY, shadows, shadowExtent: 10, shadowSoftness: 0 }, "bulb1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "bulb1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 }, "shot1"),
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

const matrix = cameraPayloadMatrix({ eye: EYE, lookAt: [0, 0, 0], fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
function texelOf(world: readonly [number, number, number]): number {
  const clip = transformPoint(matrix, world);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return (y * SIZE + x) * 4;
}
/**
 * The floor point (y = 0) a texel's CENTRE sees — the projection inverted by Newton's method
 * on (x, z), so the analytic lambert is evaluated where the rasterizer shaded, not at the
 * point the texel was picked from (inverse-square changes a byte within one texel here).
 */
function floorAtTexelCentre(world: readonly [number, number, number]): [number, number, number] {
  const offset = texelOf(world) / 4;
  const target = [(offset % SIZE) + 0.5, Math.floor(offset / SIZE) + 0.5];
  const project = (x: number, z: number): [number, number] => {
    const clip = transformPoint(matrix, [x, 0, z]);
    return [((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE, (0.5 - (clip[1] / clip[3]) * 0.5) * SIZE];
  };
  let [x, z] = [world[0], world[2]];
  for (let step = 0; step < 20; step += 1) {
    const [px, py] = project(x, z);
    const h = 1e-4;
    const [ax, ay] = project(x + h, z);
    const [bx, by] = project(x, z + h);
    const j = [(ax - px) / h, (bx - px) / h, (ay - py) / h, (by - py) / h];
    const det = j[0]! * j[3]! - j[1]! * j[2]!;
    const ex = target[0]! - px;
    const ey = target[1]! - py;
    x += (j[3]! * ex - j[1]! * ey) / det;
    z += (-j[2]! * ex + j[0]! * ey) / det;
  }
  return [x, 0, z];
}

const rgb = (bytes: Uint8Array, at: number): number[] => [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];

/** Default lambert albedo 0.8 × (ambient 0.12 + I·(N·L)/(1 + d²)) at a floor point. */
function litFloor(point: readonly [number, number, number]): number {
  const toLight = [LIGHT[0] - point[0], LIGHT[1] - point[1], LIGHT[2] - point[2]];
  const d2 = toLight[0]! ** 2 + toLight[1]! ** 2 + toLight[2]! ** 2;
  const lambert = toLight[1]! / Math.sqrt(d2);
  return Math.round(0.8 * (0.12 + (INTENSITY * lambert) / (1 + d2)) * 255);
}

describe("point-light shadows on Dawn (T1362b, §V147)", () => {
  it("the box's shadow is the ambient floor, open floor is inverse-square lambert, and the cut lights the shadow", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // The box (x, z ∈ ±0.5, y ∈ 0.5..1.5) under a light at y = 3 shadows the floor out to
    // |x| = 1.0; x = 0.8 is inside it and visible from above past the box's top (which
    // covers |x| < 0.64 on the floor from this eye). x = 2.5 is open floor.
    const shadowed: [number, number, number] = [0.8, 0, 0];
    const open: [number, number, number] = [2.5, 0, 0];
    const floorOnly = Math.round(0.8 * 0.12 * 255);

    const cast = await render(true);
    expect(rgb(cast, texelOf(shadowed))).toEqual([floorOnly, floorOnly, floorOnly]);
    const openLit = litFloor(floorAtTexelCentre(open));
    expect(rgb(cast, texelOf(open))).toEqual([openLit, openLit, openLit]);

    const uncast = await render(false);
    const shadowedLit = litFloor(floorAtTexelCentre(shadowed));
    expect(rgb(uncast, texelOf(shadowed))).toEqual([shadowedLit, shadowedLit, shadowedLit]);
  });
});
