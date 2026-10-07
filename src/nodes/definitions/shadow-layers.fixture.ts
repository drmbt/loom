import { cubePrimitive, encodeFixtureGlb } from "../../domain/mesh/glb.fixture.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { prepareMesh } from "../../points/mesh.ts";

/**
 * T1623b slice 4 — the scene the shadow-layer tests share (no GPU here; `shadow-layers.test.ts`
 * reads its plan and `vgpu/shadow-layers.gpu.test.ts` its pictures).
 *
 * A white floor 12 m square at y = 0 and a unit box standing over its middle (x and z from
 * −0.5 to 0.5, y from 0.5 to 1.5), each a file mesh with its own Geometry, seen from straight
 * above. The lights are the test's own: any number of casting suns and casting point lights,
 * listed in the order given. A file mesh's lambert is one-sided and its floor faces up, so a
 * floor pixel's light is a sum of terms a test can write down.
 *
 * THE PLATE. With the box alone the scene is its own mirror image east to west and north to
 * south, and so are the shadow maps of suns that mirror one another: a sun that read ANOTHER
 * sun's layer found the box where its own map has it, and the pictures could not tell
 * (found by mutation: every sun made to read layer 0, and three suns' test stayed green).
 * So the box's mesh has a second part, a plate one metre square at y = 1 over x 2.5 to 3.5
 * and z −3 to −2. Nothing mirrors it, and a test probes its shadow.
 */
export const FLOOR_ALBEDO = 0.8;
export const AMBIENT = 0.125;

const FLOOR = {
  positions: [-6, 0, -6, 6, 0, -6, 6, 0, 6, -6, 0, 6],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
  material: 0,
};
/** Where the plate is, in the floor's plane. Its height is one metre. */
export const PLATE = { x: [2.5, 3.5], z: [-3, -2], y: 1 } as const;
/* In the box's node, which stands one metre up: the plate's own y is 0 there. It faces up. */
const PLATE_PART = {
  positions: [PLATE.x[0], 0, PLATE.z[0], PLATE.x[1], 0, PLATE.z[0], PLATE.x[1], 0, PLATE.z[1], PLATE.x[0], 0, PLATE.z[1]],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
  material: 0,
};
export const SHADOW_LAYERS_GLB = encodeFixtureGlb({
  materials: [{ name: "white", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "floor", mesh: [FLOOR] },
    { name: "box", translation: [0, 1, 0], mesh: [cubePrimitive(0), PLATE_PART] },
  ],
});
export const SHADOW_LAYERS_MESHES: Readonly<Record<string, Uint8Array>> = { mesh_floor: SHADOW_LAYERS_GLB, mesh_box: SHADOW_LAYERS_GLB };

/** Straight above the middle, twelve metres of floor in the frame's height. */
export const SHADOW_LAYERS_CAMERA = { eye: [0, 10, 0.001], lookAt: [0, 0, 0], ortho: true, orthoHeight: 12, near: 0.1, far: 40 } as const;

type Parameters = Record<string, unknown>;
const node = (id: string, type: string, parameters: Parameters) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id });
const edge = (id: string, from: string, to: string, port: string) => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });

/** A casting sun travelling along `direction`, hard-edged, its volume over the whole floor. */
export const castingSun = (direction: readonly [number, number, number], intensity: number, more: Parameters = {}): Parameters => ({
  kind: "directional",
  direction: [...direction],
  intensity,
  shadows: true,
  shadowExtent: 9,
  shadowSoftness: 0,
  ...more,
});
/** A casting point light at `position`, hard-edged, with the soft falloff 1 / (1 + d²). */
export const castingLamp = (position: readonly [number, number, number], intensity: number, more: Parameters = {}): Parameters => ({
  kind: "point",
  position: [...position],
  intensity,
  shadows: true,
  shadowExtent: 14,
  shadowSoftness: 0,
  ...more,
});

/** The floor and the box under these Lights (`light_c0`, `light_c1`, …), listed in this order. `box`: more of the box's Geometry (a Transform). */
export function shadowLayersScene(lights: ReadonlyArray<Parameters>, render: Parameters = {}, box: Parameters = {}): GraphDocument {
  const facts = (role: string) => {
    const found = prepareMesh(SHADOW_LAYERS_GLB, role)?.facts;
    if (found === undefined) throw new Error(`the fixture has no "${role}"`);
    return found;
  };
  const nodes = [
    node("mesh_floor", "meshFileIn", { select: "floor", ...facts("floor") }),
    node("mesh_box", "meshFileIn", { select: "box", ...facts("box") }),
    node("geometry_floor", "geometry", { mode: "surface" }),
    node("geometry_box", "geometry", { mode: "surface", ...box }),
    node("camera_shot", "camera", { ...SHADOW_LAYERS_CAMERA }),
    ...lights.map((parameters, index) => node(`light_c${index}`, "light", parameters)),
    node("render_shot", "render", {
      scenes: "geometry_floor geometry_box",
      camera: "camera_shot",
      lights: lights.map((_, index) => `light_c${index}`).join(" "),
      ambientColor: [1, 1, 1, 1],
      ambientIntensity: AMBIENT,
      ...render,
    }),
    node("output_frame", "output", {}),
  ];
  const edges = [edge("e_floor", "mesh_floor", "geometry_floor", "points"), edge("e_box", "mesh_box", "geometry_box", "points"), edge("e_out", "render_shot", "output_frame", "input")];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}
