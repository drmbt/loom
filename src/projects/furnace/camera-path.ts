import type { FurnaceSceneFacts } from "./scene-facts.ts";

/**
 * T1354b — the CAMERA PATH: a cut list over the Blender framings, each shot a MOVE.
 *
 * Every shot starts from its `shot.*` camera and moves in that camera's own frame — dolly
 * (along its view), truck (sideways), crane (up), push (fov) or orbit (around its aim) —
 * eased across the shot, centred on the authored pose so the framing the Blender pass
 * composed is the middle of the move. Cuts land on bar lines of the track's tempo.
 *
 * It is emitted as EXPRESSIONS of a time term, so the same path evaluated at
 * `(abstime - delta)` is the PREVIOUS frame's camera — what the motion blur reprojects
 * with — exactly, deterministically, with no stored state. When the director (§T1370b)
 * chooses shots from the music, the path stops being a function of time alone and the
 * previous camera comes from a one-frame delay instead.
 */

type Vec3 = readonly [number, number, number];

/** A framing built in code from the plant's own markers and pivots, not authored in Blender. */
interface Pose {
  readonly eye: Vec3;
  readonly aim: Vec3;
  readonly fov: number;
}

interface Move {
  /** A Blender `shot.*` camera, or {@link Move.pose}. */
  readonly shot?: string;
  readonly pose?: (facts: FurnaceSceneFacts) => Pose;
  /** Name, for a pose (a Blender shot is named by its camera). */
  readonly name?: string;
  readonly dolly?: number;
  readonly truck?: number;
  readonly crane?: number;
  /** FOV change across the move, degrees (negative pushes in). */
  readonly push?: number;
  /** Radians around the aim point, about world Y. */
  readonly orbit?: number;
  /** A DOLLY ZOOM: metres backwards (negative) or in, the lens narrowing to hold the subject's size. */
  readonly vertigo?: number;
  /** smooth: in-and-out; whip: fast off the cut, settling; creep: constant, relentless. */
  readonly ease?: "smooth" | "whip" | "creep";
  /** Rides a crane bridge along X (the rig's travel parameter). */
  readonly follow?: "craneX" | "crane2X";
}

const toward = (eye: Vec3, aim: Vec3, fov: number): Pose => ({ eye, aim, fov });
const at = (facts: FurnaceSceneFacts, name: string): Vec3 => {
  const marker = facts.markers.get(name);
  if (marker !== undefined) return marker.position;
  const part = facts.parts.get(name);
  if (part !== undefined) return part.pivot;
  throw new Error(`cameraPath: no marker or part "${name}" in the GLB.`);
};
const offset = (base: Vec3, by: Vec3): Vec3 => [base[0] + by[0], base[1] + by[1], base[2] + by[2]];

/**
 * Every framing with its move, CLOSE pool first, WIDE pool after — the director (§T1370b)
 * picks from the close, dynamic set when the music is energetic and from the wide, slow set
 * when it is not, by index range; the time-driven cut plays them in this order.
 */
export const CUT: readonly Move[] = [
  // Close and dynamic.
  { shot: "shot.hero_low_furnace", dolly: 4.0, crane: 1.5, ease: "whip" },
  { shot: "shot.electrode_closeup", orbit: 0.7, crane: -1.0 },
  // Circling the three electrodes from above the roof, a long lens, never letting go.
  { name: "electrode_orbit", pose: (f) => toward(offset(at(f, "electrode_2"), [11, 8, 9]), offset(at(f, "electrode_2"), [0, 5, 0.3]), 26), orbit: 1.3, ease: "creep" },
  // The slag door as the one light in a black wall: far enough back that the sooty shell
  // frames the glow, the lens tightening as the camera backs away.
  { name: "slag_door_vertigo", pose: (f) => toward(offset(at(f, "emit.slag_door"), [-13, -2.5, 6]), offset(at(f, "emit.slag_door"), [0, -0.5, 0]), 34), vertigo: -6, ease: "smooth" },
  // The tap's sparks through a long lens from across the bay: compressed, flat, hot.
  { name: "tap_longlens", pose: (f) => toward(offset(at(f, "emit.spark_tap"), [17.4, 2, 4.7]), offset(at(f, "emit.spark_tap"), [0, 1.5, 0]), 24), truck: 3, push: -3, ease: "creep" },
  // Riding the scrap crane: under the girder, looking down the bay as it travels.
  { name: "crane_ride", pose: (f) => toward(offset(at(f, "crane_bridge"), [0, -2.2, -7]), offset(at(f, "crane_bridge"), [10, -12, -2]), 72), follow: "craneX", dolly: 2 },
  // Skimming the floor at 40 cm, ultra-wide, toward the furnace's base.
  { name: "floor_skim", pose: (f) => toward([-24.4, 0.45, 8.9], offset(at(f, "furnace_shell"), [0, -6, 0]), 84), dolly: 8, ease: "whip" },
  { shot: "shot.ladle_pour", orbit: -0.6, crane: 0.8 },
  { shot: "shot.under_deck", dolly: 6.0, ease: "whip" },
  { shot: "shot.caster_strand", dolly: 6.0, truck: -1.5 },
  { shot: "shot.over_shoulder_ladle", truck: 4.0, push: -8 },
  { shot: "shot.cable_festoon", truck: 5.0, ease: "creep" },
  { shot: "shot.through_grating", crane: 3.0, orbit: 0.3 },
  { shot: "shot.pipe_corridor", dolly: 9.0, ease: "creep" },
  // Wide and slow.
  { shot: "shot.establish_wide", truck: 10.0, dolly: 3.0 },
  { shot: "shot.crane_eye", truck: 6.0, follow: "craneX" },
  { shot: "shot.conveyor_climb", crane: 4.0, dolly: 3.0 },
  { shot: "shot.scrap_bay", orbit: 0.45 },
  { shot: "shot.top_down", crane: -4.0, orbit: 0.8, ease: "creep" },
  { shot: "shot.ladle_furnace", dolly: 4.0 },
  { shot: "shot.pulpit_window", truck: 3.0 },
  // Gliding under the roof trusses down the hall, the whole plant turning below.
  { name: "roof_glide", pose: (f) => toward([-44, 25, -9], offset(at(f, "furnace_shell"), [-8, -6, 2]), 50), dolly: 18, ease: "creep" },
];

/** How many CUT entries, from the start, form the close pool; the rest are the wide pool. */
export const CLOSE_POOL = 14;

/** How far ahead of a Blender shot's eye its aim point sits, metres (the orbit's pivot). */
const AIM_DISTANCE = 12;
/** How close a moving camera may come to any surface, metres. */
const CLEARANCE = 0.6;

/** Triangles the camera must not pass through: world positions (xyz) and u32 corner indices. */
export interface Blocker {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * The nearest hit of the segment from `from` to `to` against every blocker triangle, as a
 * fraction of the segment (Möller–Trumbore; 1 = clear). Build-time only — a few rays per shot
 * over the whole plant, which is what keeps a centred move from backing into a beam.
 */
export function firstHit(blockers: readonly Blocker[], from: readonly number[], to: readonly number[]): number {
  const dir = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!];
  let nearest = 1;
  for (const { positions: p, indices } of blockers) {
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
      const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
      const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
      const hx = dir[1]! * e2z - dir[2]! * e2y, hy = dir[2]! * e2x - dir[0]! * e2z, hz = dir[0]! * e2y - dir[1]! * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const sx = from[0]! - p[a]!, sy = from[1]! - p[a + 1]!, sz = from[2]! - p[a + 2]!;
      const u = (sx * hx + sy * hy + sz * hz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dir[0]! * qx + dir[1]! * qy + dir[2]! * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hit >= 0 && hit < nearest) nearest = hit;
    }
  }
  return nearest;
}

/** The share (0..1) of a half-move that stays CLEARANCE away from every surface. */
function safeShare(blockers: readonly Blocker[], from: readonly number[], offset: readonly number[]): number {
  const length = Math.hypot(offset[0]!, offset[1]!, offset[2]!);
  if (length < 1e-6 || blockers.length === 0) return 1;
  const reach = (length + CLEARANCE) / length;
  const to = [from[0]! + offset[0]! * reach, from[1]! + offset[1]! * reach, from[2]! + offset[2]! * reach];
  const hit = firstHit(blockers, from, to) * (length + CLEARANCE);
  return Math.max(0, Math.min(1, (hit - CLEARANCE) / length));
}

export interface CameraPath {
  /** Seconds per shot: whole bars of the track's tempo. */
  readonly shotSeconds: number;
  readonly eye: readonly [string, string, string];
  readonly aim: readonly [string, string, string];
  readonly fov: string;
}

/** The view direction and its level right-hand side (forward × world up). */
function basis(forward: Vec3): { forward: Vec3; right: Vec3 } {
  const length = Math.hypot(forward[2], forward[0]) || 1;
  return { forward, right: [-forward[2] / length, 0, forward[0] / length] };
}

const n = (value: number): string => (Math.abs(value) < 1e-9 ? "0" : value.toFixed(4));

/** A move's framing as eye, unit forward, aim distance and lens — from Blender or from a pose. */
function framing(facts: FurnaceSceneFacts, move: Move): { eye: Vec3; forward: Vec3; reach: number; fov: number } {
  if (move.pose !== undefined) {
    const pose = move.pose(facts);
    const d: Vec3 = [pose.aim[0] - pose.eye[0], pose.aim[1] - pose.eye[1], pose.aim[2] - pose.eye[2]];
    const reach = Math.hypot(d[0], d[1], d[2]) || 1;
    // A pose must SEE its subject: the plant between eye and aim is a black frame, loudly.
    // The last quarter is the subject's own clutter (an electrode's arms, a ladle's rim).
    const near: Vec3 = [pose.eye[0] + d[0] * 0.75, pose.eye[1] + d[1] * 0.75, pose.eye[2] + d[2] * 0.75];
    const hit = firstHit(facts.blockers, pose.eye, near);
    if (hit < 1) throw new Error(`cameraPath: pose "${move.name ?? "?"}" is blocked ${(hit * reach * 0.75).toFixed(1)} m from its eye, before its subject at ${reach.toFixed(1)} m.`);
    return { eye: pose.eye, forward: [d[0] / reach, d[1] / reach, d[2] / reach], reach, fov: pose.fov };
  }
  const camera = move.shot === undefined ? undefined : facts.cameras.get(move.shot);
  if (camera === undefined) throw new Error(`cameraPath: the GLB has no camera "${move.shot ?? move.name ?? "?"}".`);
  return { eye: camera.eye, forward: camera.forward, reach: AIM_DISTANCE, fov: camera.fovDeg };
}

/**
 * The path as expressions of `time` (an expression term: `abstime`, or `(abstime - delta)`
 * for the previous frame). `beatsPerMinute` and `bars` set the shot length.
 */
export function cameraPath(
  facts: FurnaceSceneFacts,
  time: string,
  beatsPerMinute: number,
  bars: number,
  blockers: readonly Blocker[] = [],
): CameraPath {
  const shotSeconds = (bars * 4 * 60) / beatsPerMinute;
  return {
    ...shotPath(facts, {
      index: `(floor(${time} / ${n(shotSeconds)}) % ${CUT.length})`,
      progress: `((${time} % ${n(shotSeconds)}) / ${n(shotSeconds)})`,
      time,
      blockers,
    }),
    shotSeconds,
  };
}

export interface ShotDrive {
  readonly index: string;
  readonly progress: string;
  readonly time: string;
  readonly blockers?: readonly Blocker[];
  /** Handheld amplitude (1 = a few centimetres at rest); the director's energy. */
  readonly shake?: string;
  /** 0..1, decaying after a kick: the camera jolts forward and the lens punches in. */
  readonly punch?: string;
}

/**
 * The same shots driven from OUTSIDE (T1370b's director): `index` is an expression naming
 * which CUT entry is live, `progress` an expression from 0 (the cut) to 1 (the end of the
 * move), `time` the clock the handheld drift reads. Returned without a shot length — the
 * music decides it.
 */
export function shotPath(facts: FurnaceSceneFacts, drive: ShotDrive): Omit<CameraPath, "shotSeconds"> {
  const { index, time } = drive;
  const blockers = drive.blockers ?? [];
  const local = `clamp(${drive.progress}, 0, 1)`;
  // Each easing centred on zero: −0.5 at the cut in, +0.5 at the end of the move.
  const eases = {
    smooth: `((${local}) ^ 2 * (3 - 2 * (${local})) - 0.5)`,
    whip: `(0.5 - (1 - ${local}) ^ 3)`,
    creep: `(${local} - 0.5)`,
  } as const;
  const shake = drive.shake ?? "1";
  const punch = drive.punch ?? "0";
  // Handheld: two incommensurate sines per axis, a few centimetres at rest, more when the
  // music pushes — the operator's hands getting less steady.
  const hand = [
    `((sin(${time} * 1.7) * 0.018 + sin(${time} * 4.1) * 0.006 + sin(${time} * 11.3) * 0.004) * ${shake})`,
    `((sin(${time} * 2.3 + 1.0) * 0.014 + sin(${time} * 5.3) * 0.005 + sin(${time} * 13.7) * 0.004) * ${shake})`,
    `((sin(${time} * 1.9 + 2.0) * 0.016 + sin(${time} * 9.1) * 0.004) * ${shake})`,
  ];
  const eyeTerms: [string[], string[], string[]] = [[], [], []];
  const aimTerms: [string[], string[], string[]] = [[], [], []];
  const fovTerms: string[] = [];
  CUT.forEach((move, k) => {
    const shot = framing(facts, move);
    const { forward, right } = basis(shot.forward);
    const ease = eases[move.ease ?? "smooth"];
    const active = `(${index} == ${k})`;
    // Each half of a straight move is shortened to keep CLEARANCE from every surface.
    const full = [0, 1, 2].map(
      (axis) =>
        ((move.dolly ?? 0) + (move.vertigo ?? 0)) * forward[axis]! + (move.truck ?? 0) * right[axis]! + (move.crane ?? 0) * (axis === 1 ? 1 : 0),
    );
    const back = safeShare(blockers, shot.eye, full.map((value) => -value * 0.5));
    const ahead = safeShare(blockers, shot.eye, full.map((value) => value * 0.5));
    const signedEase = `(max(${ease}, 0) * ${n(ahead)} + min(${ease}, 0) * ${n(back)})`;
    const aimRest = [0, 1, 2].map((axis) => shot.eye[axis]! + forward[axis]! * shot.reach);
    const ride = move.follow === undefined ? "" : ` + op('rig1').par.${move.follow}`;
    // The kick: a jolt along the view, 25 cm at full punch.
    const jolt = (axis: number): string => ` + ${n(forward[axis]! * 0.25)} * ${punch}`;
    for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
      const translate = full[axis]!;
      let eye: string;
      if (move.orbit !== undefined) {
        // Orbit about the aim point around world Y: rotate (eye − aim) by orbit·ease, plus
        // any straight move on top.
        const dx = shot.eye[0]! - aimRest[0]!;
        const dz = shot.eye[2]! - aimRest[2]!;
        const angle = `(${n(move.orbit)} * ${ease})`;
        const base =
          axis === 0
            ? `(${n(aimRest[0]!)} + ${n(dx)} * cos(${angle}) + ${n(dz)} * sin(${angle}))`
            : axis === 2
              ? `(${n(aimRest[2]!)} - ${n(dx)} * sin(${angle}) + ${n(dz)} * cos(${angle}))`
              : `${n(shot.eye[1]!)}`;
        eye = `(${base} + ${n(translate)} * ${signedEase})`;
      } else {
        eye = `(${n(shot.eye[axis]!)} + ${n(translate)} * ${signedEase})`;
      }
      eyeTerms[axis].push(`${active} * (${eye}${axis === 0 ? ride : ""}${jolt(axis)})`);
      // An orbit and a dolly zoom keep the subject; the other moves carry the aim with the eye.
      const aimMoves = move.orbit === undefined && move.vertigo === undefined;
      const aim = aimMoves ? `(${n(aimRest[axis]!)} + ${n(translate)} * ${signedEase})` : n(aimRest[axis]!);
      aimTerms[axis].push(`${active} * (${aim}${axis === 0 ? ride : ""})`);
    }
    // The lens: its own push, the dolly zoom's compensation (the subject at `reach` keeps its
    // size as the eye backs off), and the kick's punch.
    const vertigoFov =
      move.vertigo === undefined
        ? `${n(shot.fov)}`
        : // The expression engine has no tan/atan; at a telephoto lens the angle is its tangent.
          `(${n(shot.fov)} * ${n(shot.reach)} / (${n(shot.reach)} - ${n(move.vertigo)} * ${ease}))`;
    fovTerms.push(`${active} * (${vertigoFov} + ${n(move.push ?? 0)} * ${ease} - 4 * ${punch})`);
  });
  return {
    eye: [0, 1, 2].map((axis) => `${eyeTerms[axis as 0 | 1 | 2].join(" + ")} + ${hand[axis]}`) as unknown as [string, string, string],
    aim: [0, 1, 2].map((axis) => aimTerms[axis as 0 | 1 | 2].join(" + ")) as unknown as [string, string, string],
    fov: fovTerms.join(" + "),
  };
}
