import { decodeGlb, type DecodedCamera, type DecodedMarker } from "../../domain/mesh/glb.ts";

/**
 * Stage previz — what the document needs to know about the Blender export
 * (`tools/blender/stage-previz/`), measured from the GLB at build time: each area's mesh
 * size, the three projector rigs, the canvas, and the previz cameras. The document BAKES
 * these, as the furnace and On Nothing documents do, so moving a projector in
 * `layout.py` and rebuilding moves it in Loom too.
 */

export type Vec3 = readonly [number, number, number];

/** One Mesh File In per area; every exported object is named `<area>.<name>`. */
export const AREAS = ["stage", "grid", "curtain", "kabuki", "led", "talent"] as const;
export type Area = (typeof AREAS)[number];

export interface AreaFacts {
  readonly select: string;
  readonly vertices: number;
  readonly triangles: number;
  /** Highest vertex (glTF y): the kabuki's pipe line, which its fly-out collapses to. */
  readonly topY: number;
}

export const PROJECTORS = ["SR", "SL", "DS"] as const;
export type ProjectorName = (typeof PROJECTORS)[number];

export interface ProjectorFacts {
  readonly name: ProjectorName;
  readonly eye: Vec3;
  readonly lookAt: Vec3;
  readonly throwRatio: number;
  readonly aspect: number;
}

export interface ShotFacts {
  readonly name: string;
  readonly eye: Vec3;
  readonly lookAt: Vec3;
  readonly fov: number;
}

export interface StageFacts {
  readonly glbUrl: string;
  readonly areas: Readonly<Record<Area, AreaFacts>>;
  readonly projectors: Readonly<Record<ProjectorName, ProjectorFacts>>;
  readonly shots: readonly ShotFacts[];
  /** The deck's top surface, glTF y — the floor the low fog sits on. */
  readonly deckTop: number;
}

/** The order the shot switch steps through; a camera the GLB lacks is an error, not a gap. */
export const SHOT_ORDER = ["foh", "iso", "wing", "projector", "wide"] as const;

function vec3(value: unknown, what: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((entry) => typeof entry === "number")) {
    throw new Error(`Stage GLB: ${what} must be three numbers, got ${JSON.stringify(value)}.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function number(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Stage GLB: ${what} must be a number, got ${JSON.stringify(value)}.`);
  return value;
}

function projectorFrom(marker: DecodedMarker, name: ProjectorName): ProjectorFacts {
  const extras = marker.extras ?? {};
  return {
    name,
    eye: [marker.position[0], marker.position[1], marker.position[2]],
    lookAt: vec3(extras["loom_look_at"], `proj.${name} loom_look_at`),
    throwRatio: number(extras["loom_throw_ratio"], `proj.${name} loom_throw_ratio`),
    aspect: number(extras["loom_aspect"], `proj.${name} loom_aspect`),
  };
}

/** A decoded camera as a Loom camera: eye, a look-at point ten metres down its axis, vertical FOV. */
function shotFrom(camera: DecodedCamera, name: string): ShotFacts {
  const reach = 10;
  return {
    name,
    eye: [camera.eye[0], camera.eye[1], camera.eye[2]],
    lookAt: [camera.eye[0] + camera.forward[0] * reach, camera.eye[1] + camera.forward[1] * reach, camera.eye[2] + camera.forward[2] * reach],
    fov: camera.fovDeg,
  };
}

export function stageFacts(glb: Uint8Array, glbUrl: string): StageFacts {
  const areas = {} as Record<Area, AreaFacts>;
  for (const area of AREAS) {
    const select = `${area}.*`;
    const mesh = decodeGlb(glb, { select });
    if (mesh.vertexCount === 0) throw new Error(`Stage GLB: area "${area}" is empty — was it built by tools/blender/stage-previz/build.py?`);
    let topY = -Infinity;
    for (let index = 1; index < mesh.positions.length; index += 3) topY = Math.max(topY, mesh.positions[index] ?? -Infinity);
    areas[area] = { select, vertices: mesh.vertexCount, triangles: mesh.triangleCount, topY };
  }
  const whole = decodeGlb(glb, {});
  const markers = new Map(whole.markers.map((marker) => [marker.name, marker]));
  const projectors = {} as Record<ProjectorName, ProjectorFacts>;
  for (const name of PROJECTORS) {
    const marker = markers.get(`proj.${name}`);
    if (marker === undefined) throw new Error(`Stage GLB: no proj.${name} marker.`);
    projectors[name] = projectorFrom(marker, name);
  }
  const canvas = markers.get("canvas.US");
  if (canvas === undefined) throw new Error("Stage GLB: no canvas.US marker.");
  const cameras = new Map(whole.cameras.map((camera) => [camera.name, camera]));
  const shots = SHOT_ORDER.map((name) => {
    const camera = cameras.get(`shot.${name}`);
    if (camera === undefined) throw new Error(`Stage GLB: no shot.${name} camera.`);
    return shotFrom(camera, name);
  });
  return { glbUrl, areas, projectors, shots, deckTop: number(canvas.extras?.["loom_deck_top"], "canvas.US loom_deck_top") };
}
