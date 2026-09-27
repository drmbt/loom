import type { DecodedCamera, DecodedMarker, DecodedMesh } from "../../domain/mesh/glb.ts";
import { formatJointTable } from "../../points/mesh.ts";

/**
 * T1400b — what the On Nothing documents need to know about the Blender export
 * (`tools/blender/on-nothing/`), measured from the GLB at build time: each area's mesh size,
 * the shot cameras, the stages the figure stands on, the light markers and the figure's
 * bone table (T1401b: the decoded glTF skin's joint table). The documents BAKE these, as the
 * furnace does.
 */

export interface MeshSelectionFacts {
  readonly select: string;
  readonly vertices: number;
  readonly triangles: number;
  readonly parts: string;
  /** T1401b: the Mesh File In's Joints fact — empty for an unskinned area. */
  readonly joints: string;
  /** The rig parts in this selection (index as `surface.w` carries it, pivot, rest rotation, parent). */
  readonly partTable: readonly PartFacts[];
}

export interface PartFacts {
  readonly index: number;
  readonly name: string;
  readonly pivot: readonly [number, number, number];
  /** Rest world rotation, unit quaternion (x, y, z, w). */
  readonly rotation: readonly [number, number, number, number];
  readonly parent?: string;
}

/** One bone of the figure: its table index, rest head (glTF metres) and parent (−1 at the root). */
export interface Bone {
  readonly index: number;
  readonly name: string;
  readonly parent: number;
  readonly head: readonly [number, number, number];
}

/** Where the figure stands in a shot, and which way it faces (unit, horizontal). */
export interface Stage {
  readonly position: readonly [number, number, number];
  readonly facing: readonly [number, number, number];
}

export interface OnNothingFacts {
  readonly glbUrl: string;
  readonly areas: ReadonlyMap<Area, MeshSelectionFacts>;
  readonly cameras: ReadonlyMap<string, DecodedCamera>;
  readonly markers: ReadonlyMap<string, DecodedMarker>;
  readonly stages: ReadonlyMap<string, Stage>;
  readonly bones: readonly Bone[];
}

/** The GLB's areas, one Mesh File In each (every object is named `<area>.<name>`). */
export const AREAS = ["wh", "car", "title", "fig", "cyc"] as const;
export type Area = (typeof AREAS)[number];

export function selectOf(area: Area): string {
  return `${area}.*`;
}

function vec3(value: unknown, what: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((entry) => typeof entry === "number")) {
    throw new Error(`On Nothing GLB: ${what} must be three numbers, got ${JSON.stringify(value)}.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

export function factsFrom(glbUrl: string, meshes: ReadonlyMap<Area, DecodedMesh>): OnNothingFacts {
  const any = meshes.get("fig");
  if (any === undefined) throw new Error("On Nothing GLB: no figure area decoded.");
  const areas = new Map<Area, MeshSelectionFacts>();
  for (const [area, mesh] of meshes) {
    if (mesh.vertexCount === 0) throw new Error(`On Nothing GLB: area "${area}" is empty — was the Blender build run with every module?`);
    areas.set(area, {
      select: selectOf(area),
      vertices: mesh.vertexCount,
      triangles: mesh.triangleCount,
      parts: mesh.parts.map((part) => `${part.index}:${part.name}`).join(" "),
      joints: formatJointTable(mesh.skin?.joints ?? []),
      partTable: mesh.parts.map((part) => ({ index: part.index, name: part.name, pivot: part.pivot, rotation: part.rotation, ...(part.parent === undefined || part.parent === "" ? {} : { parent: part.parent }) })),
    });
  }
  const markers = new Map(any.markers.map((marker) => [marker.name, marker]));
  const stages = new Map<string, Stage>();
  for (const marker of any.markers) {
    if (marker.name.startsWith("stage.")) {
      // The exporter drops an empty's rotation (the furnace README records it): the aim rides in extras.
      const [x, , z] = vec3(marker.extras?.["loom_dir"], `${marker.name} loom_dir`);
      const length = Math.hypot(x, z) || 1;
      stages.set(marker.name.slice("stage.".length), { position: marker.position, facing: [x / length, 0, z / length] });
    }
  }
  // The decoder's joint table, in its order: the indices `joints` carries, parents first.
  const skin = any.skin;
  if (skin === undefined) throw new Error("On Nothing GLB: the figure is not skinned — rebuild it with tools/blender/on-nothing (T1401b exports the armature as a glTF skin).");
  const bones: Bone[] = skin.joints.map((joint, index) => ({ index, name: joint.name, parent: joint.parent, head: joint.head }));
  return { glbUrl, areas, cameras: new Map(any.cameras.map((camera) => [camera.name, camera])), markers, stages, bones };
}

export function markerOf(facts: OnNothingFacts, name: string): DecodedMarker {
  const marker = facts.markers.get(name);
  if (marker === undefined) throw new Error(`The On Nothing GLB has no marker "${name}".`);
  return marker;
}

/** Rotate a vector by a unit quaternion (x, y, z, w). */
export function rotateByQuaternion(q: readonly [number, number, number, number], v: readonly [number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function wgslVec3(value: readonly [number, number, number]): string {
  return `vec3f(${value.map((component) => component.toFixed(5)).join(", ")})`;
}
