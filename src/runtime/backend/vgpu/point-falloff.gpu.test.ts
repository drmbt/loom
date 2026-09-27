import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1437b on a REAL device, exact to the byte (§V147): a point light's FALLOFF CURVE.
 *
 * The bug: every point light fell off as 1/(1 + d²), which is nearly flat inside a metre, so
 * a lamp 30 cm from a pendant lit its near and far faces almost alike and washed the close-up.
 * The fix is a Falloff law (Inverse Square, 1/d²) and a Range that windows the light to zero.
 *
 * One floor, one lamp 1.5 m above it, read from straight above at three floor points along
 * the curve. Every reading is the analytic lambert at the texel's true floor point:
 *  - Inverse Square, no range: 0.8 × (0.12 + I·(N·L)/d²);
 *  - with a Range, the same times (1 − (d/range)⁴)², and a point PAST the range reads the
 *    ambient floor to the byte — the light ends;
 *  - the CUT: the default law, 1/(1 + d²), at the same texels — what a saved document keeps.
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
  nodes: [{ name: "floor", mesh: [FLOOR] }],
});
const FACTS = prepareMesh(GLB, "")!.facts;
const EYE: [number, number, number] = [0, 7, 0.01];
const LIGHT: [number, number, number] = [0, 1.5, 0];
const INTENSITY = 2;
const AMBIENT = 0.12;

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

function graph(lamp: Record<string, unknown>): GraphDocument {
  const nodes = [
    node("mesh", "meshFileIn", { vertices: FACTS.vertices, triangles: FACTS.triangles, parts: FACTS.parts }, "mesh1"),
    node("geo", "geometry", { mode: "surface" }, "geo1"),
    node("cam", "camera", { eye: EYE, lookAt: [0, 0, 0] }, "cam1"),
    node("bulb", "light", { kind: "point", position: LIGHT, intensity: INTENSITY, ...lamp }, "bulb1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "bulb1", ambientColor: [1, 1, 1, 1], ambientIntensity: AMBIENT }, "shot1"),
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

async function render(lamp: Record<string, unknown>): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(lamp),
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
/** The floor point (y = 0) a texel's CENTRE sees — the projection inverted by Newton's method. */
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

const grey = (bytes: Uint8Array, at: number): number[] => [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];

/** Default lambert albedo 0.8 × (ambient + I·(N·L)·law(d)·window(d)) at the floor point a texel shows. */
function litFloor(world: readonly [number, number, number], law: "soft" | "inverseSquare", range = 0): number {
  const point = floorAtTexelCentre(world);
  const toLight = [LIGHT[0] - point[0], LIGHT[1] - point[1], LIGHT[2] - point[2]];
  const d2 = toLight[0]! ** 2 + toLight[1]! ** 2 + toLight[2]! ** 2;
  const lambert = toLight[1]! / Math.sqrt(d2);
  const falloff = law === "soft" ? 1 / (1 + d2) : 1 / d2;
  const reach = range > 0 ? Math.min(1, Math.max(0, 1 - (d2 / (range * range)) ** 2)) ** 2 : 1;
  return Math.round(0.8 * (AMBIENT + INTENSITY * lambert * falloff * reach) * 255);
}

/** Three floor points along the curve: d = 1.58 m, 2.12 m and 2.92 m from the lamp. */
const CURVE: ReadonlyArray<[number, number, number]> = [
  [0.5, 0, 0],
  [1.5, 0, 0],
  [2.5, 0, 0],
];

describe("point-light falloff on Dawn (T1437b, §V147)", () => {
  it("Inverse Square is 1/d² along the floor, and the default law is still 1/(1 + d²)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const physical = await render({ falloff: "inverseSquare" });
    const shipped = await render({});
    for (const point of CURVE) {
      const law = litFloor(point, "inverseSquare");
      expect(grey(physical, texelOf(point))).toEqual([law, law, law]);
      const soft = litFloor(point, "soft");
      expect(grey(shipped, texelOf(point))).toEqual([soft, soft, soft]);
      // the two laws are different pictures at every point on the curve, or this proves nothing
      expect(law).not.toEqual(soft);
    }
    // the close-up claim itself: near vs far, Inverse Square is the steeper curve
    const [near, , far] = CURVE.map((point) => [litFloor(point, "inverseSquare"), litFloor(point, "soft")] as const);
    expect(near![0] - far![0]).toBeGreaterThan(near![1] - far![1]);
  });

  it("a Range windows the light to exactly zero: past it the floor is the ambient floor", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const range = 2.6;
    const ranged = await render({ falloff: "inverseSquare", range });
    const [inside, middle, beyond] = CURVE;
    for (const point of [inside!, middle!]) {
      const windowed = litFloor(point, "inverseSquare", range);
      expect(grey(ranged, texelOf(point))).toEqual([windowed, windowed, windowed]);
    }
    // d = 2.92 m > 2.6 m: nothing of the lamp arrives
    const floorOnly = Math.round(0.8 * AMBIENT * 255);
    expect(grey(ranged, texelOf(beyond!))).toEqual([floorOnly, floorOnly, floorOnly]);
    // and the range is what did it: the soft law with the same range ends there too
    const softRanged = await render({ range });
    expect(grey(softRanged, texelOf(beyond!))).toEqual([floorOnly, floorOnly, floorOnly]);
    const softMiddle = litFloor(middle!, "soft", range);
    expect(grey(softRanged, texelOf(middle!))).toEqual([softMiddle, softMiddle, softMiddle]);
  });
});
