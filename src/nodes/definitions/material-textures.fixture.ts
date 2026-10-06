import { cubePrimitive, encodeFixtureGlb } from "../../domain/mesh/glb.fixture.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { prepareMesh } from "../../points/mesh.ts";

/**
 * T1658b — the scenes the texture inputs of a Material · WGSL are held on, shared by the
 * plan tests (`material-textures.test.ts`) and the Dawn tests
 * (`runtime/backend/vgpu/material-textures.gpu.test.ts`).
 *
 * THE PICTURE IS 64 × 64 AND SO IS THE TEXTURE. The camera is orthographic, two units tall,
 * so a pixel is a thirty-second of a unit and a two-unit quad fills the picture exactly:
 * pixel (x, y) is the quad's coordinate ((x + ½) ÷ 64, 1 − (y + ½) ÷ 64), the centre of
 * texel (x, 63 − y). Every expectation in the Dawn file is a texel derived that way.
 *
 * THE TEXTURE IS A RULER: texel (x, y) holds (4x, 4y, phase) as bytes. Four apart, so a
 * blend of two neighbours a quarter of the way along is a whole byte (4x + 1); and `phase`
 * is a parameter, so an expression on it makes a picture that changes every frame.
 */

export const TEXTURE_SIZE = 64;
export const TEXTURE_SETTINGS: ProjectSettings = {
  outputResolution: { width: TEXTURE_SIZE, height: TEXTURE_SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

/** texel (x, y) = (4x, 4y, phase) ÷ 255. */
export const RULER_SOURCE = `struct Params {
  phase: f32, // @default 0  The blue byte of every texel.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let white = textureSample(inputTexture, inputSampler, uv);
  return vec4f(floor(uv.x * ${TEXTURE_SIZE}.0) * 4.0 / 255.0, floor(uv.y * ${TEXTURE_SIZE}.0) * 4.0 / 255.0, params.phase / 255.0, 1.0) * white;
}`;

/** The ruler turned a quarter: texel (x, y) = (4y, 4x, 200) ÷ 255. A second texture that cannot be mistaken for the first. */
export const TURNED_SOURCE = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let white = textureSample(inputTexture, inputSampler, uv);
  return vec4f(floor(uv.y * ${TEXTURE_SIZE}.0) * 4.0 / 255.0, floor(uv.x * ${TEXTURE_SIZE}.0) * 4.0 / 255.0, 200.0 / 255.0, 1.0) * white;
}`;

/**
 * A hull and a lens in one mesh: a unit cube at the origin, and a second unit cube one and
 * a half units to its right under a node marked `loom_part: "lens"`, so every vertex of it
 * carries part 1 in its surface row (`s.attr.w`). The cube's faces each carry 0 to 1 in `uv`.
 */
export const HULL_GLB = encodeFixtureGlb({
  materials: [{ name: "plate", baseColor: [1, 1, 1, 1], roughness: 1 }],
  nodes: [
    { name: "hull", mesh: [cubePrimitive(0)] },
    { name: "lens", translation: [1.5, 0, 0], extras: { loom_part: "lens" }, mesh: [cubePrimitive(0)] },
  ],
});

type Parameters = Record<string, unknown>;
type Node = { id: string; type: string; definitionVersion: number; position: { x: number; y: number }; parameters: Parameters; label: string };
type Edge = { id: string; source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } };
const node = (id: string, type: string, parameters: Parameters): Node => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id });
const edge = (from: string, to: string, port: string, fromPort = "out"): Edge => ({ id: `${from}.${fromPort}-${to}.${port}`, source: { nodeId: from, portId: fromPort }, target: { nodeId: to, portId: port } });

function meshNode(id: string, select: string): Node {
  const facts = prepareMesh(HULL_GLB, select, {}, "", "world")?.facts;
  if (facts === undefined) throw new Error(`fixture selection "${select}" is empty`);
  return node(id, "meshFileIn", { select, frame: "world", vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts, frameOrigin: facts.frameOrigin });
}

export type TextureWire = "ruler" | "turned" | "webcam" | "movie";
/** The node each producer is. */
export const PRODUCER: Readonly<Record<TextureWire, string>> = { ruler: "wgsl_ruler", turned: "wgsl_turned", webcam: "webcam_live", movie: "movie_clip" };

export interface TextureScene {
  /** What is drawn: a two-unit quad (a grid Surface), the hull-and-lens mesh, or three instances of the hull cube. */
  readonly shape: "quad" | "mesh" | "instances";
  /** The Material · WGSL's source, and any other parameter of it. */
  readonly source: string;
  readonly material?: Parameters;
  /**
   * What is wired into Texture 1 to 4, in that order: a producer, or nothing. `webcam` and
   * `movie` are the live media nodes as a document holds them: a Webcam, and a Movie File In
   * with no file picked.
   */
  readonly wires?: ReadonlyArray<TextureWire | undefined>;
  /** The ruler's own parameters (its `phase`). */
  readonly ruler?: Parameters;
  readonly render?: Parameters;
  /** Lights by name, as the Render lists them. A casting sun is `light_sun`. */
  readonly lights?: string;
  readonly camera?: Parameters;
  /** More casting suns, `light_cast_0` on: each is one more shadow map a lit draw binds. */
  readonly casting?: number;
}

/** The node ids a test reads by. */
export const SHOT = "render_shot";
export const MATERIAL = "material_surface";
export const MESH_NODES = ["mesh_hull"] as const;

export function textureScene(scene: TextureScene): GraphDocument {
  const wires = scene.wires ?? [];
  const producers = [
    ...(wires.includes("ruler") || wires.includes("turned") ? [node("solid_white", "solid", { color: [1, 1, 1, 1] })] : []),
    ...(wires.includes("ruler") ? [node("wgsl_ruler", "customWgsl", { source: RULER_SOURCE, ...scene.ruler })] : []),
    ...(wires.includes("turned") ? [node("wgsl_turned", "customWgsl", { source: TURNED_SOURCE })] : []),
    ...(wires.includes("webcam") ? [node("webcam_live", "webcam", {})] : []),
    ...(wires.includes("movie") ? [node("movie_clip", "movieFileIn", {})] : []),
  ];
  const producerEdges = [
    ...(wires.includes("ruler") ? [edge("solid_white", "wgsl_ruler", "input")] : []),
    ...(wires.includes("turned") ? [edge("solid_white", "wgsl_turned", "input")] : []),
    ...wires.flatMap((wire, index) => (wire === undefined ? [] : [edge(PRODUCER[wire], MATERIAL, `texture${index + 1}`)])),
  ];
  const quad = [
    node("kernel_quad", "pointKernel", {
      capacity: 4,
      seed: 7,
      attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
      kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(f32(ctx.index % 2u) * 2.0 - 1.0, f32(ctx.index / 2u) * 2.0 - 1.0, 0.0);
  return q;
}`,
    }),
    node("topology_quad", "pointTopology", { connectivity: "grid", cols: 2, rows: 2 }),
    node("geometry_skin", "geometry", { mode: "surface", material: MATERIAL }),
  ];
  const mesh = [meshNode("mesh_hull", ""), node("geometry_skin", "geometry", { mode: "surface", material: MATERIAL })];
  const instances = [
    meshNode("mesh_hull", "hull"),
    node("kernel_places", "pointKernel", {
      capacity: 3,
      seed: 7,
      attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
      // Three cubes of a quarter unit a side… placed by the Geometry's Scale; here only where: left, middle, right.
      kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(f32(ctx.index) * 0.625 - 0.625, 0.0, 0.0);
  return q;
}`,
    }),
    node("geometry_skin", "geometry", { mode: "instances", shape: "mesh", material: MATERIAL, scale: 0.5 }),
  ];
  const shapeNodes = scene.shape === "quad" ? quad : scene.shape === "mesh" ? mesh : instances;
  const shapeEdges =
    scene.shape === "quad"
      ? [edge("kernel_quad", "topology_quad", "points"), edge("topology_quad", "geometry_skin", "points")]
      : scene.shape === "mesh"
        ? [edge("mesh_hull", "geometry_skin", "points")]
        : [edge("mesh_hull", "geometry_skin", "mesh"), edge("kernel_places", "geometry_skin", "points")];
  const nodes = [
    ...producers,
    ...shapeNodes,
    node(MATERIAL, "materialWgsl", { model: "unlit", source: scene.source, ...scene.material }),
    node("camera_lens", "camera", { eye: [0, 0, 5], lookAt: [0, 0, 0], ortho: true, orthoHeight: 2, near: 0.1, far: 100, ...scene.camera }),
    node("light_sun", "light", { kind: "directional", direction: [0, -1, -1], shadows: true, shadowExtent: 4 }),
    ...Array.from({ length: scene.casting ?? 0 }, (_, index) => node(`light_cast_${index}`, "light", { kind: "directional", direction: [index - 6, -4, -1], shadows: true, shadowExtent: 4 })),
    node(SHOT, "render", { scenes: "geometry_skin", camera: "camera_lens", lights: scene.lights ?? "", background: [0, 0, 0, 1], ...scene.render }),
    node("output_main", "output", {}),
  ];
  const edges = [...producerEdges, ...shapeEdges, edge(SHOT, "output_main", "input")];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

/** A source that names no texture: the surface the stock material would give. */
export const PLAIN_SOURCE = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  return surfaceDefaults(s);
}`;
