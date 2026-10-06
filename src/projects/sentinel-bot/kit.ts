import type { DecodedMarker, DecodedMesh } from "../../domain/mesh/glb.ts";

/**
 * T1561b — what the sentinel document needs to know about the KIT (the GLB that
 * `tools/blender/sentinel-bot/build.py` cuts from the reference FBX), measured from the file
 * at build time: where the tentacles leave the body, how long a tentacle is and how its rings
 * are spaced, and the claw's mechanism — where each phalanx sits on its carrier and the hinge
 * the reference performance turns it about.
 *
 * Frames are the kit's (its README): the ROBOT frame has +Z forward, +Y up; a JOINT frame has
 * +Z along the bone toward the tip.
 */

export type Vec3 = readonly [number, number, number];
/** x, y, z, w. */
export type Quat = readonly [number, number, number, number];

export interface MeshSelectionFacts {
  readonly select: string;
  readonly vertices: number;
  readonly triangles: number;
  readonly parts: string;
}

export interface Phalanx {
  readonly finger: number;
  /** 0 = the knuckle (carried by the hub), 1 = the tip (carried by the knuckle). */
  readonly link: number;
  /** The joint's origin in its carrier's frame. */
  readonly joint: Vec3;
  /** Its orientation there at rest. */
  readonly rest: Quat;
  /** The hinge axis, in the carrier's frame. */
  readonly axis: Vec3;
  /** The smallest and largest angle the reference performance reaches about it, radians from rest. */
  readonly range: readonly [number, number];
}

export interface KitFacts {
  /** Where the app fetches the GLB (a path under public/). */
  readonly glbUrl: string;
  /** Everything that rides the body rigidly: hull, eyes, lamp, front arms. Robot frame. */
  readonly robot: MeshSelectionFacts;
  /** One tentacle ring, in its joint frame: the shape drawn at every ring joint. */
  readonly ring: MeshSelectionFacts;
  /** The claw's cone, in its joint frame. */
  readonly hub: MeshSelectionFacts;
  /** The whole claw as one rigid piece, fingers at rest, in the hub's joint frame. */
  readonly claw: MeshSelectionFacts;
  /** Each phalanx's own mesh, in its joint frame, indexed finger * 2 + link like `phalanges`. */
  readonly phalanxMeshes: readonly MeshSelectionFacts[];
  /** Robot frame: where each tentacle leaves the body. */
  readonly sockets: readonly Vec3[];
  readonly ringCount: number;
  /** Metres between ring joints. */
  readonly ringPitch: number;
  /** Metres from the socket to the first ring's joint. */
  readonly ringStart: number;
  /** Metres from the socket to the claw hub's joint. */
  readonly hubDistance: number;
  readonly fingers: number;
  /** Indexed finger * 2 + link. */
  readonly phalanges: readonly Phalanx[];
  /**
   * Robot frame: each eye, by its FACE, what shows of it from in front. `position` is the face's middle (on the
   * eye's axis, which is the robot's forward one, as far forward as the eye reaches) and `face` its radius, metres.
   */
  readonly eyes: ReadonlyArray<{ readonly position: Vec3; readonly face: number }>;
}

export const ROBOT_SELECT = "body.* eyes.* lamp.* part:mand_*";

interface GltfNodeLike {
  readonly name?: string;
  readonly extras?: Readonly<Record<string, unknown>>;
}

function numbers(value: unknown, length: number, what: string): number[] {
  if (!Array.isArray(value) || value.length !== length || value.some((entry) => typeof entry !== "number")) {
    throw new Error(`The sentinel kit's ${what} is not ${length} numbers; rebuild it with tools/blender/sentinel-bot/build.py.`);
  }
  return value as number[];
}

function info(marker: DecodedMarker, key: string): number {
  const value = marker.extras?.[`loom_${key}`];
  if (typeof value !== "number") throw new Error(`The sentinel kit's kit.info has no loom_${key}; rebuild it with tools/blender/sentinel-bot/build.py.`);
  return value;
}

export function selectionFacts(select: string, mesh: DecodedMesh): MeshSelectionFacts {
  return { select, vertices: mesh.vertexCount, triangles: mesh.triangleCount, parts: mesh.parts.map((part) => `${part.index}:${part.name}`).join(" ") };
}

/**
 * `robot` is the kit decoded with `ROBOT_SELECT`; `shape` decodes one more selection (a ring,
 * the hub, a phalanx); `nodes` is the GLB's own node list (the hinges ride on mesh nodes, as extras).
 */
export function kitFactsFrom(glbUrl: string, robot: DecodedMesh, shape: (select: string) => DecodedMesh, nodes: readonly GltfNodeLike[]): KitFacts {
  const markers = new Map(robot.markers.map((marker) => [marker.name, marker]));
  const kit = markers.get("kit.info");
  if (kit === undefined) throw new Error("The GLB has no kit.info marker: it is not a sentinel kit.");
  const tentacles = info(kit, "tentacles");
  const fingers = info(kit, "fingers");
  const sockets: Vec3[] = [];
  for (let t = 0; t < tentacles; t += 1) {
    const socket = markers.get(`socket.${t}`);
    if (socket === undefined) throw new Error(`The sentinel kit has no socket.${t}.`);
    sockets.push(socket.position);
  }
  const phalanges: Phalanx[] = [];
  for (let finger = 0; finger < fingers; finger += 1) {
    for (let link = 0; link < 2; link += 1) {
      const name = `phalanx_${finger}_${link}`;
      const extras = nodes.find((node) => node.name === name)?.extras;
      if (extras === undefined) throw new Error(`The sentinel kit has no ${name}.`);
      phalanges.push({
        finger,
        link,
        joint: numbers(extras["loom_joint"], 3, `${name}.loom_joint`) as unknown as Vec3,
        rest: numbers(extras["loom_rest"], 4, `${name}.loom_rest`) as unknown as Quat,
        axis: numbers(extras["loom_axis"], 3, `${name}.loom_axis`) as unknown as Vec3,
        range: numbers(extras["loom_range"], 2, `${name}.loom_range`) as unknown as [number, number],
      });
    }
  }
  const eyes = robot.markers
    .filter((marker) => marker.name.startsWith("eye."))
    .map((marker) => {
      const face = marker.extras?.["loom_face"];
      // A kit from before the faces were measured has the half length of each eye's barrel there, and twice the eyes.
      if (typeof face !== "number") throw new Error(`The sentinel kit's ${marker.name} has no loom_face; rebuild it with tools/blender/sentinel-bot/build.py.`);
      return { position: marker.position, face };
    });
  return {
    glbUrl,
    robot: selectionFacts(ROBOT_SELECT, robot),
    ring: selectionFacts("ring", shape("ring")),
    hub: selectionFacts("hub", shape("hub")),
    claw: selectionFacts("claw", shape("claw")),
    phalanxMeshes: phalanges.map((phalanx) => selectionFacts(`phalanx_${phalanx.finger}_${phalanx.link}`, shape(`phalanx_${phalanx.finger}_${phalanx.link}`))),
    sockets,
    ringCount: info(kit, "ring_count"),
    ringPitch: info(kit, "ring_pitch"),
    ringStart: info(kit, "ring_start"),
    hubDistance: info(kit, "hub_distance"),
    fingers,
    phalanges,
    eyes,
  };
}

export function wgslVec3(value: Vec3): string {
  return `vec3f(${value.map((component) => component.toFixed(5)).join(", ")})`;
}

export function wgslVec4(value: Quat): string {
  return `vec4f(${value.map((component) => component.toFixed(6)).join(", ")})`;
}
