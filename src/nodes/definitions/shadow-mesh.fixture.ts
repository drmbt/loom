import { encodeFixtureGlb, type FixturePrimitive } from "../../domain/mesh/glb.fixture.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { prepareMesh } from "../../points/mesh.ts";

/**
 * T1689b — the scene the shadow-mesh tests share (no GPU here; `shadow-mesh.test.ts` reads its
 * plan and `vgpu/shadow-mesh.gpu.test.ts` its pictures).
 *
 * A RING, a torus about the z axis (major radius 1.5, tube radius 0.4), in two meshes of one
 * frame: `ring`, 30 x 12 segments, 720 triangles; and `ring_low`, 15 x 6, 180: a quarter, as
 * the consumer's kit holds them (716 and 178). Their vertices lie on the same torus, so the
 * low one's facets are chords of the full one's.
 *
 * A WALL, 12 m square in the plane z = 0, facing +z. The ring is drawn as a MESH INSTANCE at
 * each point of a small pointset, two metres in front of the wall by default, and the lens
 * looks straight at the wall, orthographic, twelve metres high: a picture pixel is 12 / SIZE.
 *
 * Under a sun travelling straight at the wall the ring's shadow is an annulus, and how far a
 * mesh's shadow may fall short of the torus's own is its SAGITTA: a chord of the circle of
 * radius ρ over an angle 2π / M comes within ρ (1 − cos(π / M)) of the circle.
 */
export const RING = { major: 1.5, tube: 0.4, segments: [30, 12], low: [15, 6] } as const;
export const RING_TRIANGLES = 2 * RING.segments[0] * RING.segments[1];
export const RING_LOW_TRIANGLES = 2 * RING.low[0] * RING.low[1];
/** How far a ring of `segments` round falls short of radius `radius`, at most. */
export const sagitta = (radius: number, segments: number): number => radius * (1 - Math.cos(Math.PI / segments));

function torus(around: number, tube: number): FixturePrimitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < around; i += 1) {
    const a = (2 * Math.PI * i) / around;
    for (let j = 0; j < tube; j += 1) {
      const b = (2 * Math.PI * j) / tube;
      const reach = RING.major + RING.tube * Math.cos(b);
      positions.push(reach * Math.cos(a), reach * Math.sin(a), RING.tube * Math.sin(b));
      normals.push(Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b));
    }
  }
  const at = (i: number, j: number): number => (i % around) * tube + (j % tube);
  for (let i = 0; i < around; i += 1) {
    for (let j = 0; j < tube; j += 1) {
      indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return { positions, normals, indices, material: 0 };
}

const WALL: FixturePrimitive = {
  positions: [-6, -6, 0, 6, -6, 0, 6, 6, 0, -6, 6, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  material: 0,
};

export const SHADOW_MESH_GLB = encodeFixtureGlb({
  materials: [{ name: "white", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "wall", mesh: [WALL] },
    { name: "ring", mesh: [torus(RING.segments[0], RING.segments[1])] },
    { name: "ring_low", mesh: [torus(RING.low[0], RING.low[1])] },
    // The low ring three metres off its own frame's origin: read in the file's world it stands apart from the shape.
    { name: "ring_off", translation: [3, 0, 0], mesh: [torus(RING.low[0], RING.low[1])] },
  ],
});

type Parameters = Record<string, unknown>;
const node = (id: string, type: string, parameters: Parameters) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id });
const edge = (id: string, from: string, to: string, port: string) => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });

const meshNode = (id: string, select: string, frame: "world" | "object") => {
  const facts = prepareMesh(SHADOW_MESH_GLB, select, {}, "", frame)?.facts;
  if (facts === undefined) throw new Error(`the fixture has no "${select}"`);
  return node(id, "meshFileIn", { select, frame, ...facts });
};
const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "keep", type: "f32", default: [1] },
]);

export interface ShadowMeshScene {
  /** What feeds Shadow Mesh: a mesh node's id (`mesh_ring`, `mesh_low`, `mesh_off`), `grid_plain` (no triangles), or nothing. */
  readonly proxy?: string;
  /** The Lights, each a Light's parameters; listed in this order. */
  readonly lights?: ReadonlyArray<Parameters>;
  /** The rings' Geometry, beyond Mode: Instances and Shape: Mesh. */
  readonly geometry?: Parameters;
  /** Where the rings stand: WGSL for `q.position` (and `q.keep`) by the point's index `i`. Default: one ring at (0, 0, 2). */
  readonly place?: string;
  readonly rings?: number;
  readonly render?: Parameters;
  /** A Projector's parameters: listed by the Render, its cookie a white Solid. */
  readonly projector?: Parameters;
}

/** A sun travelling straight at the wall, hard-edged, its volume over the whole wall and the ring. */
export const SUN_AT_WALL: Parameters = { kind: "directional", direction: [0, 0, -1], intensity: 1, shadows: true, shadowExtent: 6, shadowSoftness: 0 };
/** A point light six metres in front of the wall's middle. */
export const LAMP_AT_WALL: Parameters = { kind: "point", position: [0, 0, 6], intensity: 40, shadows: true, shadowExtent: 14, shadowSoftness: 0 };

export const SHADOW_MESH_NODES = ["mesh_wall", "mesh_ring", "mesh_low", "mesh_off"] as const;

export function shadowMeshScene(options: ShadowMeshScene = {}): GraphDocument {
  const lights = options.lights ?? [SUN_AT_WALL];
  const rings = options.rings ?? 1;
  const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  let i = ctx.index;\n  q.position = vec3f(0.0, 0.0, 2.0);\n  q.keep = 1.0;\n${options.place ?? ""}\n  return q;\n}`;
  const nodes = [
    meshNode("mesh_wall", "wall", "world"),
    meshNode("mesh_ring", "ring", "object"),
    meshNode("mesh_low", "ring_low", "object"),
    meshNode("mesh_off", "ring_off", "world"),
    node("grid_plain", "pointGrid", { cols: 4, rows: 4 }),
    node("kernel_rings", "pointKernel", { capacity: rings, seed: 1, group: "", attributes: ATTRIBUTES, kernel, value1: 0, value2: 0, value3: 0, value4: 0 }),
    node("geometry_wall", "geometry", { mode: "surface" }),
    node("geometry_rings", "geometry", { mode: "instances", shape: "mesh", ...options.geometry }),
    node("camera_shot", "camera", { eye: [0, 0, 10], lookAt: [0, 0, 0], ortho: true, orthoHeight: 12, near: 0.1, far: 40 }),
    ...lights.map((parameters, index) => node(`light_c${index}`, "light", parameters)),
    ...(options.projector === undefined ? [] : [node("solid_cookie", "solid", { color: [1, 1, 1, 1] }), node("projector_throw", "projector", options.projector)]),
    node("render_shot", "render", {
      scenes: "geometry_wall geometry_rings",
      camera: "camera_shot",
      lights: lights.map((_, index) => `light_c${index}`).join(" "),
      ...(options.projector === undefined ? {} : { projectors: "projector_throw" }),
      ambientColor: [1, 1, 1, 1],
      ambientIntensity: 0.125,
      background: [0, 0, 0, 1],
      ...options.render,
    }),
    node("output_frame", "output", {}),
  ];
  const edges = [
    edge("e_wall", "mesh_wall", "geometry_wall", "points"),
    edge("e_points", "kernel_rings", "geometry_rings", "points"),
    edge("e_shape", "mesh_ring", "geometry_rings", "mesh"),
    ...(options.proxy === undefined ? [] : [edge("e_proxy", options.proxy, "geometry_rings", "shadowMesh")]),
    ...(options.projector === undefined ? [] : [edge("e_cookie", "solid_cookie", "projector_throw", "cookie")]),
    edge("e_out", "render_shot", "output_frame", "input"),
  ];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

/** The meshes a headless render of the scene needs. */
export const SHADOW_MESH_MESHES: Readonly<Record<string, Uint8Array>> = Object.fromEntries(SHADOW_MESH_NODES.map((id) => [id, SHADOW_MESH_GLB]));
