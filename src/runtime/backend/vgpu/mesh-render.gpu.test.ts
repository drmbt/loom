import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb, type FixtureScene } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1353b on a REAL device, exact to the byte (§V147): a GLB goes through the loader's own
 * path (`prepareMesh`), the fed buffers (`sourceId` on a plan buffer), the `mesh:` claim,
 * the indexed lit draw and the indexed depth sweep — and comes out as pixels whose values
 * are derived from the file by hand.
 *
 * Every claim has its CUT: the same graph with the feed withheld draws nothing (the index
 * list stays zero, every triangle degenerate), the same texel without the light is the
 * ambient floor, the part a kernel moves leaves the texel it covered.
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

const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  ...(label === undefined ? {} : { label }),
});

interface SceneOptions {
  readonly glb: Uint8Array;
  readonly eye: Vec3;
  readonly lookAt?: Vec3;
  readonly light?: { readonly direction: Vec3; readonly shadows?: boolean };
  /** WGSL for a Point Kernel spliced between the mesh and the geometry. */
  readonly kernel?: string;
  /** T1416b: the node's Select. The node is still SIZED for the whole file (stale facts). */
  readonly select?: string;
}

function meshGraph(options: SceneOptions): GraphDocument {
  const facts = prepareMesh(options.glb, "")?.facts;
  if (facts === undefined) throw new Error("fixture mesh is empty");
  const nodes = [
    node("mesh", "meshFileIn", { vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts, ...(options.select === undefined ? {} : { select: options.select }) }, "mesh1"),
    node("geo", "geometry", { mode: "surface" }, "geo1"),
    node("cam", "camera", { eye: [...options.eye], lookAt: [...(options.lookAt ?? [0, 0, 0])] }, "cam1"),
    node(
      "sun",
      "light",
      {
        kind: "directional",
        direction: [...(options.light?.direction ?? [0, 0, -1])],
        intensity: 1,
        ...(options.light?.shadows === true ? { shadows: true, shadowExtent: 4, shadowSoftness: 0 } : {}),
      },
      "sun1",
    ),
    node(
      "shot",
      "render",
      { scenes: "geo1", camera: "cam1", lights: options.light === undefined ? "" : "sun1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 },
      "shot1",
    ),
    node("out", "output", {}, "out1"),
    ...(options.kernel === undefined
      ? []
      : [
          node("move", "pointKernel", {
            capacity: facts.vertices,
            attributes: JSON.stringify([
              { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
              { name: "surface", type: "vec4f", default: [1, 0, 0, 0] },
            ]),
            kernel: options.kernel,
          }),
        ]),
  ];
  const edges =
    options.kernel === undefined
      ? { e1: { id: "e1", source: { nodeId: "mesh", portId: "out" }, target: { nodeId: "geo", portId: "points" } } }
      : {
          e1: { id: "e1", source: { nodeId: "mesh", portId: "out" }, target: { nodeId: "move", portId: "in" } },
          e3: { id: "e3", source: { nodeId: "move", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
        };
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: { ...edges, e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
    groups: {},
  } as never;
}

async function render(options: SceneOptions, feed = true): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: meshGraph(options),
    settings: SETTINGS,
    frames: 2,
    outputNodeId: "shot",
    outputPortId: "out",
    ...(feed ? { meshes: { mesh: options.glb } } : {}),
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(errors).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  return frame.bytes;
}

function texelOf(eye: Vec3, lookAt: Vec3, world: Vec3): number {
  const matrix = cameraPayloadMatrix({ eye, lookAt, fovDeg: 60, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
  const clip = transformPoint(matrix, world);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return (y * SIZE + x) * 4;
}

const rgb = (bytes: Uint8Array, at: number): number[] => [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];
const byte = (linear: number): number => Math.round(Math.min(1, linear) * 255);

describe("Mesh File In end to end on Dawn (T1353b, §V147)", () => {
  it("draws the file's material: default lambert 0.8 × vertex colour × (ambient + |N·L|), plus emissive", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const scene: FixtureScene = {
      materials: [
        { name: "painted", baseColor: [1, 0.5, 0.25, 1], roughness: 1 },
        { name: "hot", baseColor: [0.5, 0.5, 0.5, 1], roughness: 1, emissive: [0.1, 0.2, 0.3] },
      ],
      nodes: [{ name: "box", mesh: [cubePrimitive(0)] }],
    };
    const eye: Vec3 = [0, 0, 3];
    const centre = texelOf(eye, [0, 0, 0], [0, 0, 0.5]);

    const lit = await render({ glb: encodeFixtureGlb(scene), eye, light: { direction: [0, 0, -1] } });
    // Front face normal (0,0,1), toLight (0,0,1): |N·L| = 1. Albedo = 0.8 (the default
    // material) × the file's colour (1, 0.5, 0.25).
    expect(rgb(lit, centre)).toEqual([byte(0.8 * 1.12), byte(0.4 * 1.12), byte(0.2 * 1.12)]);

    // The cut: the same graph with the file's bytes withheld draws nothing at all.
    const unfed = await render({ glb: encodeFixtureGlb(scene), eye, light: { direction: [0, 0, -1] } }, false);
    expect(rgb(unfed, centre)).toEqual([0, 0, 0]);

    // Emissive is added after lighting, unshadowed and unscaled by the albedo.
    const hot = await render({
      glb: encodeFixtureGlb({ ...scene, nodes: [{ name: "box", mesh: [cubePrimitive(1)] }] }),
      eye,
      light: { direction: [0, 0, -1] },
    });
    expect(rgb(hot, centre)).toEqual([byte(0.4 * 1.12 + 0.1), byte(0.4 * 1.12 + 0.2), byte(0.4 * 1.12 + 0.3)]);
    // Three full renders: under a whole-suite GPU queue the 5 s default is not enough.
  }, 30_000);

  it("B227: a single-sided sheet is lit on the side facing the light only — its back is the ambient floor", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // One quad in z = 0 whose file normal is +Z, lit from +Z — cladding with the sun on it.
    const sheet = encodeFixtureGlb({
      materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
      nodes: [{ mesh: [{ positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2, 0, 2, 3], material: 0 }] }],
    });
    const front: Vec3 = [0, 0, 3];
    const back: Vec3 = [0, 0, -3];
    const lit = await render({ glb: sheet, eye: front, light: { direction: [0, 0, -1] } });
    expect(rgb(lit, texelOf(front, [0, 0, 0], [0, 0, 0]))).toEqual([byte(0.8 * 1.12), byte(0.8 * 1.12), byte(0.8 * 1.12)]);
    // From behind, the same sheet: the sun is on its OTHER side. Two-sided lambert lit it
    // as brightly as the front — the inside of every sunlit wall glowing.
    const behind = await render({ glb: sheet, eye: back, light: { direction: [0, 0, -1] } });
    expect(rgb(behind, texelOf(back, [0, 0, 0], [0, 0, 0]))).toEqual([byte(0.8 * 0.12), byte(0.8 * 0.12), byte(0.8 * 0.12)]);
  });

  it("the index list is the connectivity: a face turned away from the light is the ambient floor", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // Seen from +Z, lit from +X: the visible face's normal is perpendicular to the light.
    const eye: Vec3 = [0, 0, 3];
    const bytes = await render({
      glb: encodeFixtureGlb({ materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }], nodes: [{ mesh: [cubePrimitive(0)] }] }),
      eye,
      light: { direction: [-1, 0, 0] },
    });
    expect(rgb(bytes, texelOf(eye, [0, 0, 0], [0, 0, 0.5]))).toEqual([byte(0.8 * 0.12), byte(0.8 * 0.12), byte(0.8 * 0.12)]);
  });

  it("casts through the indexed depth sweep: the part's shadow on the floor is the ambient floor to the byte", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const floor = {
      positions: [-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3],
      normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
      indices: [0, 2, 1, 0, 3, 2],
      material: 0,
    };
    const glb = encodeFixtureGlb({
      materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
      nodes: [
        { name: "floor", mesh: [floor] },
        { name: "box", translation: [0, 1, 0], mesh: [cubePrimitive(0)] },
      ],
    });
    // Light travels (1, −1, 0)/√2: the box (x ∈ ±0.5, y ∈ 0.5..1.5) shadows x ∈ 0..2.
    const eye: Vec3 = [0, 7, 0.01];
    const shadowed = texelOf(eye, [0, 0, 0], [1.5, 0, 0]);
    const open = texelOf(eye, [0, 0, 0], [-1.5, 0, 0]);
    const bytes = await render({ glb, eye, light: { direction: [1, -1, 0], shadows: true } });
    expect(rgb(bytes, shadowed)).toEqual([byte(0.8 * 0.12), byte(0.8 * 0.12), byte(0.8 * 0.12)]);
    const lambert = Math.SQRT1_2;
    expect(rgb(bytes, open)).toEqual([byte(0.8 * (0.12 + lambert)), byte(0.8 * (0.12 + lambert)), byte(0.8 * (0.12 + lambert))]);
  });

  it("a kernel moves ONE part by its index (surface.w) and the mesh claim survives the kernel", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const glb = encodeFixtureGlb({
      materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
      nodes: [
        { name: "left", translation: [-1, 0, 0], mesh: [cubePrimitive(0)] },
        { name: "ladle", extras: { loom_part: "ladle" }, translation: [1, 0, 0], mesh: [cubePrimitive(0)] },
      ],
    });
    const eye: Vec3 = [0, 0, 5];
    const leftTexel = texelOf(eye, [0, 0, 0], [-1, 0, 0.5]);
    const ladleTexel = texelOf(eye, [0, 0, 0], [1, 0, 0.5]);
    const lift = (dy: number) => `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (q.surface.w == 1.0) { q.position = q.position + vec3f(0.0, ${dy.toFixed(1)}, 0.0); }
  return q;
}`;
    const litFace = [byte(0.8 * 1.12), byte(0.8 * 1.12), byte(0.8 * 1.12)];
    const still = await render({ glb, eye, light: { direction: [0, 0, -1] }, kernel: lift(0) });
    expect(rgb(still, leftTexel)).toEqual(litFace);
    expect(rgb(still, ladleTexel)).toEqual(litFace);
    // Part 1 lifted three units out of frame; part 0 (static) is untouched.
    const moved = await render({ glb, eye, light: { direction: [0, 0, -1] }, kernel: lift(3) });
    expect(rgb(moved, leftTexel)).toEqual(litFace);
    expect(rgb(moved, ladleTexel)).toEqual([0, 0, 0]);
  });

  it("T1416b: a Select that drops a sub-mesh re-measures — the node sized for the whole file draws the kept box only", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const glb = encodeFixtureGlb({
      materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }, { name: "cap", baseColor: [1, 1, 1, 1] }],
      nodes: [
        { name: "body", translation: [-1, 0, 0], mesh: [cubePrimitive(0)] },
        { name: "beanie", translation: [1, 0, 0], mesh: [cubePrimitive(1)] },
      ],
    });
    // The graph carries the WHOLE file's counts (two boxes); the Select keeps one. The counts
    // are the caller's no longer: the harness measures under the Select, as the app's loader does.
    expect(prepareMesh(glb, "!material:cap")?.facts.vertices).toBe((prepareMesh(glb, "")?.facts.vertices ?? 0) / 2);
    const eye: Vec3 = [0, 0, 4];
    const litFace = [byte(0.8 * 1.12), byte(0.8 * 1.12), byte(0.8 * 1.12)];
    const bothTexels = [texelOf(eye, [0, 0, 0], [-1, 0, 0.5]), texelOf(eye, [0, 0, 0], [1, 0, 0.5])] as const;
    const whole = await render({ glb, eye, light: { direction: [0, 0, -1] } });
    expect(bothTexels.map((at) => rgb(whole, at))).toEqual([litFace, litFace]);
    const bare = await render({ glb, eye, light: { direction: [0, 0, -1] }, select: "!material:cap" });
    expect(bothTexels.map((at) => rgb(bare, at))).toEqual([litFace, [0, 0, 0]]);
  });
});
