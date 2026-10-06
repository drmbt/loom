import { cubePrimitive, encodeFixtureGlb } from "../../domain/mesh/glb.fixture.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { prepareMesh } from "../../points/mesh.ts";

/**
 * T1598b — the scene the shadow-caster tests share (no GPU here; `shadow-casters.test.ts`
 * reads its plan and `shadow-casters.gpu.test.ts` its pictures, so the two cannot be
 * talking about different scenes).
 *
 * Four meshes, each its own Mesh File In and Geometry, so each has its own bound and its
 * own name to put in a list:
 *
 *   floor  an 8 × 8 m quad at y = 0
 *   box    2 × 1 × 2 m, sitting on the floor (y 0.5 … 1.5)
 *   lid    a 0.4 m plate at y = 3, between the top light and the box
 *   far    a 1 m cube thirty metres away along +X
 *
 * and two casting point lights: `light_top` straight above the box, `light_side` out along
 * −X at the lid's height. So:
 *
 *   the box shadows the floor from the top light (a square to ±1.6 m) and, from the side
 *   light, a strip along +X; the lid shadows the middle of the box's top from the top light
 *   and nothing from the side light; the far cube is out of both lights' range.
 */
export const CASTER_ROLES = ["floor", "box", "lid", "far"] as const;
export type CasterRole = (typeof CASTER_ROLES)[number];

const FLOOR = {
  positions: [-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
  material: 0,
};

export const CASTERS_GLB = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "floor", mesh: [FLOOR] },
    { name: "box", translation: [0, 1, 0], scale: [2, 1, 2], mesh: [cubePrimitive(0)] },
    { name: "lid", translation: [0, 3, 0], scale: [0.4, 0.05, 0.4], mesh: [cubePrimitive(0)] },
    { name: "far", translation: [30, 1, 0], mesh: [cubePrimitive(0)] },
  ],
});

export const CASTERS_EYE: [number, number, number] = [0, 7, 5];
export const CASTERS_LOOK_AT: [number, number, number] = [0, 0.5, 0];
export const TOP_LIGHT: [number, number, number] = [0, 4, 0];
export const SIDE_LIGHT: [number, number, number] = [-4, 3, 0];
/** The top light's shadow range: the far cube, 30 m out, is three ranges away. */
export const TOP_RANGE = 10;

type Parameters = Record<string, unknown>;

export interface CastersScene {
  /** The top light's own parameters, over a casting point light at `TOP_LIGHT`. */
  readonly top?: Parameters;
  /** The side light's, over a casting point light at `SIDE_LIGHT`; `null` leaves the light out. */
  readonly side?: Parameters | null;
  /** Per-geometry parameters (a Transform), by role. */
  readonly geometry?: Partial<Record<CasterRole, Parameters>>;
  /** Roles whose mesh reaches its Geometry through a Point Kernel that changes nothing. */
  readonly throughKernel?: ReadonlyArray<CasterRole>;
  /** Per-mesh parameters over the measured facts, by role (to take a fact away). */
  readonly mesh?: Partial<Record<CasterRole, Parameters>>;
  readonly render?: Parameters;
}

const node = (id: string, type: string, parameters: Parameters) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id });
const edge = (id: string, from: string, to: string, port: string) => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });

/** The Mesh File In ids, for a harness's `meshes`. */
export const CASTER_MESHES: Readonly<Record<string, Uint8Array>> = Object.fromEntries(CASTER_ROLES.map((role) => [`mesh_${role}`, CASTERS_GLB]));

export function castersScene(options: CastersScene = {}): GraphDocument {
  const through = new Set(options.throughKernel ?? []);
  const nodes = [
    ...CASTER_ROLES.map((role) => {
      const facts = prepareMesh(CASTERS_GLB, role)?.facts;
      if (facts === undefined) throw new Error(`the fixture has no "${role}"`);
      return node(`mesh_${role}`, "meshFileIn", { select: role, ...facts, ...options.mesh?.[role] });
    }),
    ...[...through].map((role) => node(`kernel_${role}`, "pointKernel", { capacity: prepareMesh(CASTERS_GLB, role)?.facts.vertices ?? 0 })),
    ...CASTER_ROLES.map((role) => node(`geometry_${role}`, "geometry", { mode: "surface", ...options.geometry?.[role] })),
    node("camera_shot", "camera", { eye: CASTERS_EYE, lookAt: CASTERS_LOOK_AT }),
    node("light_top", "light", { kind: "point", position: TOP_LIGHT, intensity: 4, shadows: true, shadowExtent: TOP_RANGE, shadowSoftness: 0, ...options.top }),
    ...(options.side === null ? [] : [node("light_side", "light", { kind: "point", position: SIDE_LIGHT, intensity: 4, shadows: true, shadowExtent: 12, shadowSoftness: 0, ...options.side })]),
    node("render_shot", "render", {
      scenes: CASTER_ROLES.map((role) => `geometry_${role}`).join(" "),
      camera: "camera_shot",
      lights: options.side === null ? "light_top" : "light_top light_side",
      ambientColor: [1, 1, 1, 1],
      ambientIntensity: 0.12,
      ...options.render,
    }),
    node("output_frame", "output", {}),
  ];
  const edges = [
    ...CASTER_ROLES.flatMap((role) =>
      through.has(role)
        ? [edge(`e_${role}_in`, `mesh_${role}`, `kernel_${role}`, "in"), edge(`e_${role}`, `kernel_${role}`, `geometry_${role}`, "points")]
        : [edge(`e_${role}`, `mesh_${role}`, `geometry_${role}`, "points")],
    ),
    edge("e_out", "render_shot", "output_frame", "input"),
  ];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

/** One draw of a light's shadow sweep, read off its pass id. */
export interface SweepDraw {
  /** The light's index in the Render's Lights. */
  readonly light: number;
  /** The cube face, +X −X +Y −Y +Z −Z. */
  readonly face: number;
  readonly role: CasterRole;
  readonly skip: boolean;
}

/** Every geometry draw of every point light's shadow sweep in a plan (the clears left out). */
export function sweepDraws(passes: ReadonlyArray<{ readonly kind: string; readonly id: string; readonly skip?: boolean }>): SweepDraw[] {
  return passes.flatMap((pass) => {
    const match = /:shadow:(\d+):face(\d):(\d+)$/.exec(pass.id);
    if (pass.kind !== "draw" || match === null) return [];
    const role = CASTER_ROLES[Number(match[3])];
    if (role === undefined) throw new Error(`pass "${pass.id}" draws geometry ${String(match[3])}, which the scene does not have`);
    return [{ light: Number(match[1]), face: Number(match[2]), role, skip: pass.skip === true }];
  });
}
