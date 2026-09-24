import type { DecodedCamera, DecodedMarker, DecodedMesh } from "../../domain/mesh/glb.ts";

/**
 * T1354b — what the furnace document needs to know about the Blender export, measured from
 * the GLB at build time: the two mesh selections' sizes, the part table, the shot cameras
 * and the markers (emitters, fixtures, louvres).
 *
 * The document BAKES these (light positions and emitter origins become WGSL constants, shot
 * poses become camera parameters). §T1364b is the row that makes them live graph data
 * instead, so a re-export moves shots and lights without a rebuild.
 */

export interface MeshSelectionFacts {
  readonly select: string;
  readonly vertices: number;
  readonly triangles: number;
  readonly parts: string;
}

export interface FurnaceSceneFacts {
  /** Where the app fetches the GLB (a path under public/). */
  readonly glbUrl: string;
  readonly plant: MeshSelectionFacts;
  readonly machines: MeshSelectionFacts;
  /** Part name → index (1-based, as `surface.w` carries it) and rest pivot. */
  readonly parts: ReadonlyMap<string, { readonly index: number; readonly pivot: readonly [number, number, number] }>;
  readonly cameras: ReadonlyMap<string, DecodedCamera>;
  readonly markers: ReadonlyMap<string, DecodedMarker>;
}

// The pulpit glass is left out until a mesh can wear glass (§T1357b); drawn opaque it walls the pulpit in.
export const PLANT_SELECT = "!part:* !material:glass_pulpit";
export const MACHINES_SELECT = "part:*";

export function sceneFactsFrom(
  glbUrl: string,
  plant: DecodedMesh,
  machines: DecodedMesh,
): FurnaceSceneFacts {
  const facts = (mesh: DecodedMesh, select: string): MeshSelectionFacts => ({
    select,
    vertices: mesh.vertexCount,
    triangles: mesh.triangleCount,
    parts: mesh.parts.map((part) => `${part.index}:${part.name}`).join(" "),
  });
  return {
    glbUrl,
    plant: facts(plant, PLANT_SELECT),
    machines: facts(machines, MACHINES_SELECT),
    parts: new Map(machines.parts.map((part) => [part.name, { index: part.index, pivot: part.pivot }])),
    cameras: new Map(machines.cameras.map((camera) => [camera.name, camera])),
    markers: new Map(machines.markers.map((marker) => [marker.name, marker])),
  };
}

/** A marker's position, or a loud failure naming what the export is missing. */
export function markerAt(facts: FurnaceSceneFacts, name: string): readonly [number, number, number] {
  const marker = facts.markers.get(name);
  if (marker === undefined) throw new Error(`The furnace GLB has no marker "${name}".`);
  return marker.position;
}

export function wgslVec3(value: readonly [number, number, number]): string {
  return `vec3f(${value.map((component) => component.toFixed(4)).join(", ")})`;
}
