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
export const AREAS = ["stage", "grid", "curtain", "kabuki", "led", "talent", "rig", "deck", "strobe"] as const;
export type Area = (typeof AREAS)[number];

export interface AreaFacts {
  readonly select: string;
  readonly vertices: number;
  readonly triangles: number;
  /** Highest vertex (glTF y): the kabuki's pipe line, which its fly-out collapses to. */
  readonly topY: number;
  /** The Mesh File In's Parts fact, `index:name` (empty for an area without parts). */
  readonly parts: string;
  /** Part name → its index (as `surface.w` carries it) and pivot (its node origin, glTF). */
  readonly partTable: ReadonlyMap<string, { readonly index: number; readonly pivot: Vec3 }>;
}

export const PROJECTORS = ["SR", "SL", "DS"] as const;
export type ProjectorName = (typeof PROJECTORS)[number];

export interface ProjectorFacts {
  readonly name: ProjectorName;
  readonly eye: Vec3;
  readonly lookAt: Vec3;
  readonly throwRatio: number;
  readonly aspect: number;
  /**
   * Keystone H, degrees, as a MAGNITUDE: the side projectors' squaring-up (layout.py
   * `side_rig`), 0 for DS. The rig gives each side its sign (rig.ts).
   */
  readonly keystoneH: number;
  /** The DS projector's mount: the lens rides a clamp that slides in z and tilts the body. */
  readonly mount?: DsMount;
}

/** How the DS lens hangs off its clamp (glTF metres; tilt in degrees, positive down). */
export interface DsMount {
  readonly pivot: Vec3;
  /** The lens sits `forward` toward the scrim of the clamp and `drop` below it, at zero tilt. */
  readonly forward: number;
  readonly drop: number;
  /** The tilt that puts the optical axis on the canvas centre. */
  readonly restTilt: number;
  /** The scrim plane, glTF z. */
  readonly curtainZ: number;
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
  const facts: ProjectorFacts = {
    name,
    eye: [marker.position[0], marker.position[1], marker.position[2]],
    lookAt: vec3(extras["loom_look_at"], `proj.${name} loom_look_at`),
    throwRatio: number(extras["loom_throw_ratio"], `proj.${name} loom_throw_ratio`),
    aspect: number(extras["loom_aspect"], `proj.${name} loom_aspect`),
    keystoneH: extras["loom_keystone_h"] === undefined ? 0 : number(extras["loom_keystone_h"], `proj.${name} loom_keystone_h`),
  };
  if (name !== "DS") return facts;
  const offset = extras["loom_lens_offset"];
  if (!Array.isArray(offset) || offset.length !== 2) throw new Error(`Stage GLB: proj.DS loom_lens_offset must be [forward, drop], got ${JSON.stringify(offset)}.`);
  return {
    ...facts,
    mount: {
      pivot: vec3(extras["loom_pivot"], "proj.DS loom_pivot"),
      forward: number(offset[0], "proj.DS loom_lens_offset[0]"),
      drop: number(offset[1], "proj.DS loom_lens_offset[1]"),
      restTilt: number(extras["loom_tilt_deg"], "proj.DS loom_tilt_deg"),
      curtainZ: number(extras["loom_curtain_z"], "proj.DS loom_curtain_z"),
    },
  };
}

/**
 * A decoded camera as a Loom camera: eye, look-at, vertical FOV. The look-at is the point on
 * the camera's axis nearest the stage centre (`centre`), not an arbitrary distance down it:
 * the view's Orbit fader turns the eye about it, so 180° puts you as far behind the stage as
 * the shot is in front of it — looking back through the scrim.
 */
function shotFrom(camera: DecodedCamera, name: string, centre: Vec3): ShotFacts {
  const toward = (centre[0] - camera.eye[0]) * camera.forward[0] + (centre[1] - camera.eye[1]) * camera.forward[1] + (centre[2] - camera.eye[2]) * camera.forward[2];
  const reach = Math.max(2, toward);
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
    areas[area] = {
      select,
      vertices: mesh.vertexCount,
      triangles: mesh.triangleCount,
      topY,
      parts: mesh.parts.map((part) => `${part.index}:${part.name}`).join(" "),
      partTable: new Map(mesh.parts.map((part) => [part.name, { index: part.index, pivot: [part.pivot[0], part.pivot[1], part.pivot[2]] as Vec3 }])),
    };
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
  const deckTop = number(canvas.extras?.["loom_deck_top"], "canvas.US loom_deck_top");
  // The stage centre: mid-deck, across and up and down, at the deck's top.
  const deck = decodeGlb(glb, { select: areas.deck.select });
  let near = Infinity;
  let far = -Infinity;
  for (let index = 2; index < deck.positions.length; index += 3) {
    near = Math.min(near, deck.positions[index] ?? Infinity);
    far = Math.max(far, deck.positions[index] ?? -Infinity);
  }
  const centre: Vec3 = [0, deckTop, (near + far) / 2];
  const cameras = new Map(whole.cameras.map((camera) => [camera.name, camera]));
  const shots = SHOT_ORDER.map((name) => {
    const camera = cameras.get(`shot.${name}`);
    if (camera === undefined) throw new Error(`Stage GLB: no shot.${name} camera.`);
    return shotFrom(camera, name, centre);
  });
  return { glbUrl, areas, projectors, shots, deckTop };
}
