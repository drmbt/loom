import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1424b on a REAL device, exact to the byte (§V147): one lamp switched INSIDE one mesh.
 *
 * The bug: a car's lamps share one emissive material, so a lamp could only be switched with
 * all of them. Two lamp quads here share the material `lampglass` (emissive 0.4, black body,
 * no lights, no ambient — every byte on them is emission), in ONE Mesh File In:
 *  - with no Lamps (the default every saved document keeps), both read round(0.4 × 255);
 *  - with Lamps "lamp.left, lamp.right" and the gains at their default 1, both read the same
 *    bytes — naming groups changes nothing until a gain does;
 *  - Lamp Gain 1 = 0 puts out the left lamp ONLY (0), and Lamp Gain 2 = 0.5 halves the right
 *    one: round(0.2 × 255); a third lamp in no group keeps its emission.
 * And a token's `&` requires both terms: a third lamp on a second material is picked out by
 * object AND material, which a car's one-object body needs (its headlights and tail lights
 * are materials of one object).
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

const quad = (x: number, y: number, material: number) => ({
  positions: [x - 0.5, y - 0.5, 0, x + 0.5, y - 0.5, 0, x + 0.5, y + 0.5, 0, x - 0.5, y + 0.5, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  material,
});
const GLB = encodeFixtureGlb({
  materials: [
    { name: "lampglass", baseColor: [0, 0, 0, 1], emissive: [0.4, 0.4, 0.4] },
    { name: "tailglass", baseColor: [0, 0, 0, 1], emissive: [0.4, 0.4, 0.4] },
  ],
  nodes: [
    { name: "lamp.left", mesh: [quad(-1, 0, 0)] },
    { name: "lamp.right", mesh: [quad(1, 0, 0)] },
    { name: "lamp.tail", mesh: [quad(0, 1.2, 1)] },
  ],
});
const EYE: [number, number, number] = [0, 0, 4];

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

function graph(mesh: Record<string, unknown>): GraphDocument {
  const nodes = [
    // the harness measures vertices/triangles/parts from the file with these Lamps
    node("mesh", "meshFileIn", { ...mesh }, "mesh1"),
    node("geo", "geometry", { mode: "surface" }, "geo1"),
    node("cam", "camera", { eye: EYE, lookAt: [0, 0, 0] }, "cam1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "", ambientIntensity: 0 }, "shot1"),
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

async function render(mesh: Record<string, unknown>): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(mesh),
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
const rgb = (bytes: Uint8Array, at: number): number[] => [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];
const grey = (value: number): number[] => [value, value, value];
const LEFT = texelOf([-1, 0, 0]);
const RIGHT = texelOf([1, 0, 0]);
const TAIL = texelOf([0, 1.2, 0]);
const FULL = Math.round(0.4 * 255);

describe("per-lamp emissive gain inside one mesh on Dawn (T1424b, §V147)", () => {
  it("two lamps sharing one material: one goes out, the other halves, and the defaults change nothing", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const plain = await render({});
    expect(rgb(plain, LEFT)).toEqual(grey(FULL));
    expect(rgb(plain, RIGHT)).toEqual(grey(FULL));

    const grouped = await render({ lamps: "lamp.left, lamp.right" });
    expect(grouped).toEqual(plain);

    const switched = await render({ lamps: "lamp.left, lamp.right", lampGain1: 0, lampGain2: 0.5 });
    expect(rgb(switched, LEFT)).toEqual(grey(0));
    expect(rgb(switched, RIGHT)).toEqual(grey(Math.round(0.2 * 255)));
    expect(rgb(switched, TAIL)).toEqual(grey(FULL));
  });

  it("& joins terms: lamp.*&material:tailglass is the tail lamp alone, where the same terms space-separated take all three", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const both = await render({ lamps: "lamp.*&material:tailglass", lampGain1: 0 });
    expect(rgb(both, TAIL)).toEqual(grey(0));
    expect(rgb(both, LEFT)).toEqual(grey(FULL));
    expect(rgb(both, RIGHT)).toEqual(grey(FULL));
    const either = await render({ lamps: "lamp.* material:tailglass", lampGain1: 0 });
    expect([rgb(either, TAIL), rgb(either, LEFT), rgb(either, RIGHT)]).toEqual([grey(0), grey(0), grey(0)]);
  });
});
