import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../../tests/headless/pixel-compare.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1414b on a REAL device, exact (§V147): the Render's SHADOW MATTE output and the
 * Geometry's SHADOW ONLY switch — what a composite needs to lay a performer's shadow on a
 * surface it draws itself (On Nothing's prism wall), without a second camera at the light and
 * a hand-rolled shadow-map lookup.
 *
 * The scene is mesh-render.gpu.test.ts's: a white 6 m floor, a unit box standing 0.5..1.5 m
 * over it, a directional key travelling (1, −1, 0)/√2 with hard shadows, so the box shadows
 * the floor over x ∈ 0..2 and nothing at x < 0; the lens straight down from 7 m. The box is
 * RED so the camera can tell it from the floor. Every expected value is derived: lambert
 * 0.8 × (0.12 + √½) lit, 0.8 × 0.12 shadowed; the matte 1 in shadow, 0 lit, a = coverage.
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

type Vec3 = readonly [number, number, number];
const EYE: Vec3 = [0, 7, 0.01];

const GLB = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }, { name: "red", baseColor: [1, 0, 0, 1] }],
  nodes: [
    { name: "floor", mesh: [{ positions: [-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 2, 1, 0, 3, 2], material: 0 }] },
    { name: "box", translation: [0, 1, 0], mesh: [cubePrimitive(1)] },
  ],
});

const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  ...(label === undefined ? {} : { label }),
});

function meshNode(id: string, select: string) {
  const facts = prepareMesh(GLB, select)?.facts;
  if (facts === undefined) throw new Error(`fixture selection "${select}" is empty`);
  return node(id, "meshFileIn", { select, vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts }, `${id}1`);
}

function graph(boxShadowOnly: boolean): GraphDocument {
  const nodes = [
    meshNode("floorMesh", "floor"),
    meshNode("boxMesh", "box"),
    node("floorGeo", "geometry", { mode: "surface" }, "floorgeo1"),
    node("boxGeo", "geometry", { mode: "surface", shadowOnly: boxShadowOnly }, "boxgeo1"),
    node("cam", "camera", { eye: [...EYE], lookAt: [0, 0, 0] }, "cam1"),
    node("sun", "light", { kind: "directional", direction: [1, -1, 0], intensity: 1, shadows: true, shadowExtent: 4, shadowSoftness: 0 }, "sun1"),
    node("shot", "render", { scenes: "floorgeo1 boxgeo1", camera: "cam1", lights: "sun1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12, shadowOutput: true, depthOutput: true }, "shot1"),
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "floorMesh", portId: "out" }, target: { nodeId: "floorGeo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "boxMesh", portId: "out" }, target: { nodeId: "boxGeo", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

/** One port of the Render, decoded to floats, as a texel reader. */
async function read(boxShadowOnly: boolean, port: "out" | "shadow" | "depth"): Promise<(world: Vec3) => number[]> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(boxShadowOnly),
    settings: SETTINGS,
    frames: 2,
    outputNodeId: "shot",
    outputPortId: port,
    ...(port === "out" ? {} : { sinks: [{ nodeId: "shot", portId: port }] }),
    meshes: { floorMesh: GLB, boxMesh: GLB },
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  const values = decodeComponents(frame.bytes, frame.format);
  const matrix = cameraPayloadMatrix({ eye: EYE, lookAt: [0, 0, 0], fovDeg: 60, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
  return (world) => {
    const clip = transformPoint(matrix, world);
    const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * frame.width);
    const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * frame.height);
    const at = (y * frame.width + x) * 4;
    return [values[at]!, values[at + 1]!, values[at + 2]!, values[at + 3]!];
  };
}

const byte = (linear: number): number => Math.round(Math.min(1, linear) * 255) / 255;
const LIT_FLOOR = byte(0.8 * (0.12 + Math.SQRT1_2));
const SHADOWED_FLOOR = byte(0.8 * 0.12);
/** Floor points seen past the box's side, in its shadow and out of it, and a point on the box's top. */
const IN_SHADOW: Vec3 = [1.5, 0, 0];
const IN_LIGHT: Vec3 = [-1.5, 0, 0];
const BOX_TOP: Vec3 = [-0.3, 1.5, 0];
/** Past the floor's edge: nothing drew there. */
const EMPTY: Vec3 = [3.6, 0, 0];

describe("the shadow matte and shadow-only bodies on Dawn (T1414b, §V147)", () => {
  it("the matte is 1 where the key is blocked, 0 where it lands, and its alpha marks a surface", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const matte = await read(false, "shadow");
    expect(matte(IN_SHADOW)).toEqual([1, 0, 0, 1]);
    expect(matte(IN_LIGHT)).toEqual([0, 0, 0, 1]);
    // The box's own top faces the key: lit, and a surface.
    expect(matte(BOX_TOP)).toEqual([0, 0, 0, 1]);
    expect(matte(EMPTY)).toEqual([0, 0, 0, 0]);
    // The picture agrees with the matte, texel for texel.
    const picture = await read(false, "out");
    expect(picture(IN_SHADOW).slice(0, 3)).toEqual([SHADOWED_FLOOR, SHADOWED_FLOOR, SHADOWED_FLOOR]);
    expect(picture(IN_LIGHT).slice(0, 3)).toEqual([LIT_FLOOR, LIT_FLOOR, LIT_FLOOR]);
    expect(picture(BOX_TOP).slice(0, 3)).toEqual([LIT_FLOOR, 0, 0]);
  }, 60_000);

  it("a shadow-only box still shadows the floor, and the camera sees the floor where the box stood", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const picture = await read(true, "out");
    // Its shadow is exactly the visible box's shadow ...
    expect(picture(IN_SHADOW).slice(0, 3)).toEqual([SHADOWED_FLOOR, SHADOWED_FLOOR, SHADOWED_FLOOR]);
    // ... and where its red top was, the lit floor behind it (that ray lands at x < 0).
    expect(picture(BOX_TOP).slice(0, 3)).toEqual([LIT_FLOOR, LIT_FLOOR, LIT_FLOOR]);
    // The matte carries the shadow and no box; the depth output sees the floor through it.
    const matte = await read(true, "shadow");
    expect(matte(IN_SHADOW)).toEqual([1, 0, 0, 1]);
    expect(matte(BOX_TOP)).toEqual([0, 0, 0, 1]);
    const [withBox, without] = [await read(false, "depth"), await read(true, "depth")];
    expect(without(BOX_TOP)[0]).toBeGreaterThan(withBox(BOX_TOP)[0]!);
    expect(without(BOX_TOP)[0]).toEqual(without(IN_LIGHT)[0]);
  }, 60_000);

  it("refuses Shadow Only on a body that casts nothing, by name", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const points = graph(true) as unknown as { nodes: Record<string, { parameters: Record<string, unknown> }> };
    points.nodes["boxGeo"]!.parameters["mode"] = "points";
    await expect(
      renderHeadless({ host: nodeGpuHost(), graph: points as never, settings: SETTINGS, frames: 1, outputNodeId: "shot", meshes: { floorMesh: GLB, boxMesh: GLB } }),
    ).rejects.toThrow(/Shadow Only keeps only an object's shadow, and a points geometry casts no shadow/);
  }, 60_000);
});
