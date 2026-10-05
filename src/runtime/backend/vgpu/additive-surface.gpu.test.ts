import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { encodeFixtureGlb, type FixturePrimitive } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { compileGraph } from "../../../compiler/index.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1411b on a REAL device, exact to the byte (§V147): a Surface drawn with Blend: Additive
 * is LIGHT laid over the picture, not a body. The bug it fixes: an additive Material · WGSL
 * shell over a lit lamp rendered opaque — it wrote depth and the G-buffer and replaced the
 * colour, so the lamp behind it vanished.
 *
 * The stage: a lit wall (a file mesh at z = 0) and an additive, black, emissive shell with
 * three patches — one in FRONT of the wall, one BEHIND it, one over the empty background.
 * The shell is listed FIRST in `scenes`, so a shell drawn in list order without depth write
 * would be painted over by the wall behind it: only the deferral makes the front patch show.
 * The light casts shadows straight down the view axis, onto exactly the wall under the
 * front patch: a shell that entered the shadow sweep darkens it. The shell's material is
 * LAMBERT (black albedo, so its colour is its emission alone): an unlit material already
 * skips the shadow sweep (§V617), and would prove nothing about the additive rule.
 *
 * Every claim is against the SAME graph with the shell unnamed (the cut), plus the analytic
 * values: wall = 0.8 (default material) × 0.5 (file colour) × (0.12 ambient + 1 lambert)
 * = 0.448 → 114, and the shell's emission is (40, 80, 120)/255 — whole bytes, so the
 * one/one blend lands on integers and the sum is exact.
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
const EYE: Vec3 = [0, 0, 4];

/** An axis-aligned quad in the plane z, facing +Z (toward the camera). */
const quad = (x0: number, x1: number, y0: number, y1: number, z: number): FixturePrimitive => ({
  positions: [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  material: 0,
});

const WALL = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.6 }],
  nodes: [{ name: "wall", mesh: [quad(-1.5, 1.5, -1.5, 1.5, 0)] }],
});
const FRONT: Vec3 = [-0.8, 0, 1];
const BEHIND: Vec3 = [0.8, 0, -1];
const OVER_BACKGROUND: Vec3 = [1.5, 1.5, 1];
const SHELL = encodeFixtureGlb({
  materials: [{ name: "clear", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "front", mesh: [quad(-1.2, -0.4, -0.4, 0.4, 1)] },
    { name: "behind", mesh: [quad(0.4, 1.2, -0.4, 0.4, -1)] },
    { name: "open", mesh: [quad(1.3, 1.7, 1.3, 1.7, 1)] },
  ],
});
const SHELL_EMISSION = [40, 80, 120] as const;
const SHELL_WGSL = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.emissive = vec3f(${SHELL_EMISSION.map((value) => `${value}.0 / 255.0`).join(", ")});
  return o;
}`;

function graph(withShell: boolean): GraphDocument {
  const wallFacts = prepareMesh(WALL, "")!.facts;
  const shellFacts = prepareMesh(SHELL, "")!.facts;
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });
  const nodes = [
    node("wallMesh", "meshFileIn", { vertices: wallFacts.vertices, triangles: wallFacts.triangles, parts: wallFacts.parts }, "wallmesh1"),
    node("wall", "geometry", { mode: "surface" }, "wall1"),
    node("shellMesh", "meshFileIn", { vertices: shellFacts.vertices, triangles: shellFacts.triangles, parts: shellFacts.parts }, "shellmesh1"),
    node("shellMat", "materialWgsl", { model: "lambert", source: SHELL_WGSL }, "shellmat1"),
    node("shell", "geometry", { mode: "surface", material: "shellmat1", blend: "additive" }, "shell1"),
    node("cam", "camera", { eye: [...EYE], lookAt: [0, 0, 0] }, "cam1"),
    node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1, shadows: true, shadowExtent: 4, shadowSoftness: 0 }, "sun1"),
    node(
      "shot",
      "render",
      {
        // The shell FIRST: list order would draw it before the wall that sits behind it.
        scenes: withShell ? "shell1 wall1" : "wall1",
        camera: "cam1",
        lights: "sun1",
        ambientColor: [1, 1, 1, 1],
        ambientIntensity: 0.12,
        // Transparent, so the coverage the shell adds (none) is readable in alpha.
        background: [0, 0, 0, 0],
        depthOutput: true,
        normalOutput: true,
        albedoOutput: true,
      },
      "shot1",
    ),
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "wallMesh", portId: "out" }, target: { nodeId: "wall", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shellMesh", portId: "out" }, target: { nodeId: "shell", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

async function layer(withShell: boolean, port: "out" | "depth" | "normal" | "albedo"): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(withShell),
    settings: SETTINGS,
    frames: 1,
    outputNodeId: "shot",
    outputPortId: port,
    ...(port === "out" ? {} : { sinks: [{ nodeId: "shot", portId: port }] }),
    meshes: { wallMesh: WALL, shellMesh: SHELL },
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.frames[0]!.bytes;
}

function texelOf(world: Vec3): number {
  const matrix = cameraPayloadMatrix({ eye: EYE, lookAt: [0, 0, 0], fovDeg: 60, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
  const clip = transformPoint(matrix, world);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return (y * SIZE + x) * 4;
}

const rgba = (bytes: Uint8Array, at: number): number[] => Array.from(bytes.subarray(at, at + 4));

describe("an additive Surface is light over the picture (T1411b, §V147)", () => {
  it("adds its emission onto the lit wall behind it, hides behind the wall, casts no shadow", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const bare = await layer(false, "out");
    const shelled = await layer(true, "out");
    const wall = Math.round(0.8 * 0.5 * 1.12 * 255);
    expect(wall).toBe(114);

    // The cut: the wall alone is the analytic lit value under the front patch — unshadowed.
    expect(rgba(bare, texelOf(FRONT))).toEqual([wall, wall, wall, 255]);
    // In front: wall + emission, to the byte. Opaque (the bug) read the emission alone; a
    // list-order draw read the wall alone; a shell in the shadow sweep read the ambient floor
    // (0.8·0.5·0.12 → 12) plus the emission.
    expect(rgba(shelled, texelOf(FRONT))).toEqual([wall + SHELL_EMISSION[0], wall + SHELL_EMISSION[1], wall + SHELL_EMISSION[2], 255]);
    // Behind the wall: the depth TEST still runs — the wall hides it completely.
    expect(rgba(shelled, texelOf(BEHIND))).toEqual(rgba(bare, texelOf(BEHIND)));
    expect(rgba(bare, texelOf(BEHIND))).toEqual([wall, wall, wall, 255]);
    // Over the empty background: the emission onto black, and no coverage added — alpha stays
    // the background's 0, so the glow never makes a pixel "more opaque" than what it is over.
    expect(rgba(bare, texelOf(OVER_BACKGROUND))).toEqual([0, 0, 0, 0]);
    expect(rgba(shelled, texelOf(OVER_BACKGROUND))).toEqual([...SHELL_EMISSION, 0]);
  }, 60_000);

  it("leaves the Depth, Normal and Albedo outputs to the surface it glows over", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    for (const port of ["depth", "normal", "albedo"] as const) {
      const bare = await layer(false, port);
      const shelled = await layer(true, port);
      // The whole layer, byte for byte: the shell contributes nothing to any of them.
      expect(Buffer.from(shelled).equals(Buffer.from(bare)), `${port} layer changed under the shell`).toBe(true);
    }
    // And those layers hold the WALL where the shell sits in front of it — the G-buffer's
    // (0,0,1) → (128,128,255) with the file's roughness 0.6 → 153, and the wall's albedo
    // 0.4 → 102 with metallic 0 — not "no surface", and not the shell's black albedo.
    expect(rgba(await layer(true, "normal"), texelOf(FRONT))).toEqual([128, 128, 255, 153]);
    expect(rgba(await layer(true, "albedo"), texelOf(FRONT))).toEqual([102, 102, 102, 0]);
  }, 120_000);
});

/*
 * B256 — THE SAME RULE FOR EVERY KIND OF GEOMETRY. T1411b made an additive SURFACE light
 * rather than a body, and stopped there: a geometry in Points, Beam or Instances mode with
 * Blend: Additive still went into the camera's depth sweep (the Depth output), and a lit one
 * in Instances mode into every light's shadow sweep and the occlusion prepass. Found as
 * 6,000 additive dust motes that showed as dark discs once haze, focus and screen-space
 * occlusion read the Render's depth: each took a mote for a wall.
 *
 * The stage is the wall above with ONE point half a metre in front of its middle, drawn as
 * a billboard, a beam, a quad or a box. Its material is lit and BLACK, so as additive light
 * it adds nothing at all: with it in the scene, every output must be the wall alone, byte
 * for byte. The cut is the same geometry drawn Opaque, which must change them.
 *
 * The shape lies wholly over the wall on purpose. Over a TRANSPARENT background a billboard,
 * quad or box drawn additively also adds its alpha (the T917 blend sums all four channels),
 * where an additive Surface adds none (T1411b). That is a different question from this one,
 * about coverage rather than about being a body, and it is reported rather than decided here.
 */
const MOTE: Vec3 = [0, 0, 0.5];
/** Where the outputs are read: a tenth of a metre along from the point, inside every one of the four shapes. */
const ON_MOTE: Vec3 = [MOTE[0] + 0.1, MOTE[1], MOTE[2]];
/** The far plane, chosen so the wall's depth is a whole byte: 4 m ÷ 10 m = 0.4 → 102. */
const MOTE_FAR = 10;
const MOTE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tip", type: "vec3f", default: [0, 0, 0] },
]);
const MOTE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(${MOTE.map((value) => value.toFixed(1)).join(", ")});
  q.tip = vec3f(${(MOTE[0] + 0.5).toFixed(1)}, ${MOTE[1].toFixed(1)}, ${MOTE[2].toFixed(1)});
  return q;
}`;
const KINDS = {
  points: { mode: "points", scale: 0.6 },
  beam: { mode: "beam", endpoint: "tip", scale: 0.6, taper: 1 },
  quad: { mode: "instances", shape: "quad", scale: 0.6 },
  box: { mode: "instances", shape: "box", scale: 0.6 },
} as const;
type Kind = keyof typeof KINDS;
/** The one point, as a shape; `own` is the Geometry's In Depth Output. */
interface Mote {
  readonly kind: Kind;
  readonly blend: "additive" | "opaque";
  readonly own?: boolean;
}

function moteGraph(mote: Mote | null, render: Record<string, unknown> = {}): GraphDocument {
  const wallFacts = prepareMesh(WALL, "")!.facts;
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });
  const nodes = [
    node("wallMesh", "meshFileIn", { vertices: wallFacts.vertices, triangles: wallFacts.triangles, parts: wallFacts.parts }, "mesh_wall"),
    node("wall", "geometry", { mode: "surface" }, "geometry_wall"),
    node("motes", "pointKernel", { capacity: 1, seed: 7, group: "", attributes: MOTE_ATTRIBUTES, kernel: MOTE_KERNEL }, "kernel_mote"),
    // Lit, and black in diffuse and specular: as light it is nothing; as a body it hides, shadows and occludes.
    node("moteMat", "materialPhong", { color: [0, 0, 0, 1], specular: [0, 0, 0, 1] }, "material_mote"),
    ...(mote === null ? [] : [node("mote", "geometry", { ...KINDS[mote.kind], material: "material_mote", blend: mote.blend, ...(mote.own === true ? { inDepthOutput: true } : {}) }, "geometry_mote")]),
    node("cam", "camera", { eye: [...EYE], lookAt: [0, 0, 0], far: MOTE_FAR }, "camera_shot"),
    node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1, shadows: true, shadowExtent: 4, shadowSoftness: 0 }, "light_sun"),
    node(
      "shot",
      "render",
      {
        // The wall FIRST, so an opaque mote in front of it is drawn over it.
        scenes: mote === null ? "geometry_wall" : "geometry_wall geometry_mote",
        camera: "camera_shot",
        lights: "light_sun",
        ambientColor: [1, 1, 1, 1],
        ambientIntensity: 0.12,
        background: [0, 0, 0, 0],
        depthOutput: true,
        ...render,
      },
      "render_shot",
    ),
    node("out", "output", {}, "output_frame"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "wallMesh", portId: "out" }, target: { nodeId: "wall", portId: "points" } },
      ...(mote === null ? {} : { e2: { id: "e2", source: { nodeId: "motes", portId: "out" }, target: { nodeId: "mote", portId: "points" } } }),
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

async function moteLayer(mote: Mote | null, port: "out" | "depth"): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: moteGraph(mote),
    settings: SETTINGS,
    frames: 1,
    outputNodeId: "shot",
    outputPortId: port,
    ...(port === "out" ? {} : { sinks: [{ nodeId: "shot", portId: port }] }),
    meshes: { wallMesh: WALL },
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.frames[0]!.bytes;
}

describe("additive geometry of every kind is light over the picture (B256, §V147)", () => {
  it.each(Object.keys(KINDS) as Kind[])("a %s drawn additively leaves the Depth output at the wall's depth, and the picture to the wall", async (kind) => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const at = texelOf(ON_MOTE);

    // The Depth output's red is distance along the view axis over the far plane: the wall
    // is four metres from the eye and the far plane ten, 0.4 → 102, everywhere on it.
    const wallDepth = Math.round((4 / MOTE_FAR) * 255);
    expect(wallDepth).toBe(102);
    const bareDepth = await moteLayer(null, "depth");
    expect(rgba(bareDepth, at)).toEqual([wallDepth, 0, 0, 255]);

    // The cut: drawn Opaque it is a body, nearer the eye than the wall.
    const opaqueDepth = await moteLayer({ kind, blend: "opaque" }, "depth");
    expect(rgba(opaqueDepth, at)[0]).toBeLessThan(wallDepth);

    // Additive: the wall's depth exactly, and the whole layer is the wall's, byte for byte.
    const additiveDepth = await moteLayer({ kind, blend: "additive" }, "depth");
    expect(rgba(additiveDepth, at)).toEqual([wallDepth, 0, 0, 255]);
    expect(Buffer.from(additiveDepth).equals(Buffer.from(bareDepth)), `the Depth output changed under an additive ${kind}`).toBe(true);

    // And the picture: black light adds nothing, hides nothing and casts no shadow. (A box
    // or a quad that cast one would leave the wall behind it at its ambient floor.)
    const bare = await moteLayer(null, "out");
    const wall = Math.round(0.8 * 0.5 * 1.12 * 255);
    expect(rgba(bare, at)).toEqual([wall, wall, wall, 255]);
    expect(rgba(await moteLayer({ kind, blend: "opaque" }, "out"), at)).not.toEqual([wall, wall, wall, 255]);
    const additive = await moteLayer({ kind, blend: "additive" }, "out");
    expect(Buffer.from(additive).equals(Buffer.from(bare)), `the picture changed under a black additive ${kind}`).toBe(true);
  }, 120_000);

  /*
   * The way back, asked for. A light-only Render whose depth a later pass composites by (a
   * beam placed in front of or behind a raymarched room: E75, E77, E78 and E79 are built on
   * it) needs to know where the light IS. In Depth Output writes the additive geometry's own
   * depth into the Depth output and nowhere else: it is still light to every light and to
   * the occlusion prepass, and to the picture.
   */
  it.each(Object.keys(KINDS) as Kind[])("a %s that asks (In Depth Output) has its own depth there, and is still light to the picture", async (kind) => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const at = texelOf(ON_MOTE);
    // A billboard, a beam and a quad lie in the point's own plane, 3.5 m from the eye:
    // 0.35 → 89. A box's scale is its half-extent, so its near face is 2.9 m away: 0.29 → 74.
    const own = Math.round(((kind === "box" ? 4 - (MOTE[2] + 0.6) : 4 - MOTE[2]) / MOTE_FAR) * 255);
    expect([kind, own]).toEqual([kind, kind === "box" ? 74 : 89]);
    expect(rgba(await moteLayer({ kind, blend: "additive", own: true }, "depth"), at)).toEqual([own, 0, 0, 255]);
    // The picture is still the wall's: its depth is stated, it is not a body. No shadow, nothing hidden.
    const bare = await moteLayer(null, "out");
    const asked = await moteLayer({ kind, blend: "additive", own: true }, "out");
    expect(Buffer.from(asked).equals(Buffer.from(bare)), `the picture changed under a black additive ${kind} with a depth of its own`).toBe(true);
  }, 120_000);

  it("is in the lit pass and in no sweep: not the Depth output's, the occlusion prepass's, a light's or the Light Depth output's", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const capabilities = { tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"], timestampQuery: false, limits: { maxTextureDimension2D: 8192 } } as never;
    /** The Render's passes that draw geometry 1 (the mote), by what they are. */
    const drawsOfMote = (kind: Kind, blend: "additive" | "opaque", own = false): string[] => {
      const plan = compileGraph({
        graph: moteGraph({ kind, blend, own }, { ambientOcclusion: true, lightDepthOutput: true }),
        settings: SETTINGS,
        registry,
        capabilities,
        sinks: [
          { nodeId: "shot", portId: "depth", kind: "preview" },
          { nodeId: "shot", portId: "lightDepth", kind: "preview" },
        ],
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      return plan.passes.flatMap((pass) => {
        const match = /^shot#shot:(.+):1$/.exec(pass.id);
        return pass.kind === "draw" && match !== null ? [match[1] as string] : [];
      });
    };
    for (const kind of Object.keys(KINDS) as Kind[]) {
      expect([kind, drawsOfMote(kind, "additive")]).toEqual([kind, ["scene"]]);
      // Asked for, it is in the camera's Depth output and still in no light's sweep and no occlusion prepass.
      expect([kind, drawsOfMote(kind, "additive", true)]).toEqual([kind, ["depthOut", "scene"]]);
    }
    // In Depth Output is an additive geometry's question: an opaque one is in every sweep whatever it says.
    expect(drawsOfMote("box", "opaque", true)).toEqual(["shadow:0", "lightDepth", "depthOut", "ao:depth", "scene"]);
    // The cut, so the list above is not empty by accident: an opaque box is in all of them.
    expect(drawsOfMote("box", "opaque")).toEqual(["shadow:0", "lightDepth", "depthOut", "ao:depth", "scene"]);
    // A billboard or a beam has no light-facing shape (T647, T680): opaque, it is in the camera's Depth output alone.
    expect(drawsOfMote("points", "opaque")).toEqual(["depthOut", "scene"]);
    expect(drawsOfMote("beam", "opaque")).toEqual(["depthOut", "scene"]);
  });
});
