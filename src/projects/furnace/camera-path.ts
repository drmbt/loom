import type { DecodedCamera } from "../../domain/mesh/glb.ts";
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

interface Move {
  readonly shot: string;
  readonly dolly?: number;
  readonly truck?: number;
  readonly crane?: number;
  readonly push?: number;
  readonly orbit?: number;
}

/**
 * Every framing with its move, CLOSE pool first, WIDE pool after — the director (§T1370b)
 * picks from the close, dynamic set when the music is energetic and from the wide, slow set
 * when it is not, by index range; the time-driven cut plays them in this order.
 */
export const CUT: readonly Move[] = [
  // Close and dynamic.
  { shot: "shot.hero_low_furnace", dolly: 3.0, crane: 0.8 },
  { shot: "shot.electrode_closeup", orbit: 0.35 },
  { shot: "shot.crane_eye", truck: 5.0 },
  { shot: "shot.slag_door", push: -6, dolly: 0.8 },
  { shot: "shot.under_deck", dolly: 5.0 },
  { shot: "shot.ladle_pour", orbit: -0.3 },
  { shot: "shot.pipe_corridor", dolly: 7.0 },
  { shot: "shot.through_grating", crane: 2.0 },
  { shot: "shot.caster_strand", dolly: 5.0, truck: -1.0 },
  { shot: "shot.over_shoulder_ladle", truck: 3.0, push: -4 },
  { shot: "shot.cable_festoon", truck: 4.0 },
  // Wide and slow.
  { shot: "shot.establish_wide", truck: 8.0, dolly: 2.0 },
  { shot: "shot.conveyor_climb", crane: 3.0, dolly: 2.0 },
  { shot: "shot.scrap_bay", orbit: 0.25 },
  { shot: "shot.top_down", crane: -3.0 },
  { shot: "shot.ladle_furnace", dolly: 3.0 },
  { shot: "shot.pulpit_window", truck: 2.5 },
];

/** How many CUT entries, from the start, form the close pool; the rest are the wide pool. */
export const CLOSE_POOL = 11;

/** How far ahead of the eye the aim point sits, metres (the orbit's pivot). */
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
function firstHit(blockers: readonly Blocker[], from: readonly number[], to: readonly number[]): number {
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

/** The shot camera's view direction and its level right-hand side (forward × world up). */
function basis(camera: DecodedCamera): { forward: readonly number[]; right: readonly number[] } {
  const forward = camera.forward;
  const length = Math.hypot(forward[2], forward[0]) || 1;
  return { forward, right: [-forward[2] / length, 0, forward[0] / length] };
}

const n = (value: number): string => (Math.abs(value) < 1e-9 ? "0" : value.toFixed(4));

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

/**
 * The same shots driven from OUTSIDE (T1370b's director): `index` is an expression naming
 * which CUT entry is live, `progress` an expression from 0 (the cut) to 1 (the end of the
 * move), `time` the clock the handheld drift reads. Returned without a shot length — the
 * music decides it.
 */
export function shotPath(
  facts: FurnaceSceneFacts,
  drive: { readonly index: string; readonly progress: string; readonly time: string; readonly blockers?: readonly Blocker[] },
): Omit<CameraPath, "shotSeconds"> {
  const { index, time } = drive;
  const blockers = drive.blockers ?? [];
  const local = `clamp(${drive.progress}, 0, 1)`;
  // Smoothstep, centred on zero: −0.5 at the cut in, +0.5 at the end of the move.
  const ease = `((${local}) ^ 2 * (3 - 2 * (${local})) - 0.5)`;
  // A faint handheld drift: two incommensurate sines per axis, a few centimetres.
  const shake = [
    `(sin(${time} * 1.7) * 0.018 + sin(${time} * 4.1) * 0.006)`,
    `(sin(${time} * 2.3 + 1.0) * 0.014 + sin(${time} * 5.3) * 0.005)`,
    `(sin(${time} * 1.9 + 2.0) * 0.016)`,
  ];
  const eyeTerms: [string[], string[], string[]] = [[], [], []];
  const aimTerms: [string[], string[], string[]] = [[], [], []];
  const fovTerms: string[] = [];
  CUT.forEach((move, k) => {
    const camera = facts.cameras.get(move.shot);
    if (camera === undefined) throw new Error(`cameraPath: the GLB has no camera "${move.shot}".`);
    const { forward, right } = basis(camera);
    const active = `(${index} == ${k})`;
    // Each half of a straight move is shortened to keep CLEARANCE from every surface.
    const full = [0, 1, 2].map(
      (axis) => (move.dolly ?? 0) * forward[axis]! + (move.truck ?? 0) * right[axis]! + (move.crane ?? 0) * (axis === 1 ? 1 : 0),
    );
    const back = safeShare(blockers, camera.eye, full.map((value) => -value * 0.5));
    const ahead = safeShare(blockers, camera.eye, full.map((value) => value * 0.5));
    const signedEase = `(max(${ease}, 0) * ${n(ahead)} + min(${ease}, 0) * ${n(back)})`;
    const aimRest = [0, 1, 2].map((axis) => camera.eye[axis]! + forward[axis]! * AIM_DISTANCE);
    for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
      const translate = full[axis]!;
      let eye: string;
      if (move.orbit !== undefined) {
        // Orbit about the aim point around world Y: rotate (eye − aim) by orbit·ease.
        const dx = camera.eye[0]! - aimRest[0]!;
        const dz = camera.eye[2]! - aimRest[2]!;
        const angle = `(${n(move.orbit)} * ${ease})`;
        eye =
          axis === 0
            ? `(${n(aimRest[0]!)} + ${n(dx)} * cos(${angle}) + ${n(dz)} * sin(${angle}))`
            : axis === 2
              ? `(${n(aimRest[2]!)} - ${n(dx)} * sin(${angle}) + ${n(dz)} * cos(${angle}))`
              : `${n(camera.eye[1]!)}`;
      } else {
        eye = `(${n(camera.eye[axis]!)} + ${n(translate)} * ${signedEase})`;
      }
      eyeTerms[axis].push(`${active} * ${eye}`);
      const aim =
        move.orbit !== undefined ? n(aimRest[axis]!) : `(${n(aimRest[axis]!)} + ${n(translate)} * ${signedEase})`;
      aimTerms[axis].push(`${active} * ${aim}`);
    }
    fovTerms.push(`${active} * (${n(camera.fovDeg)} + ${n(move.push ?? 0)} * ${ease})`);
  });
  return {
    eye: [0, 1, 2].map((axis) => `${eyeTerms[axis as 0 | 1 | 2].join(" + ")} + ${shake[axis]}`) as unknown as [string, string, string],
    aim: [0, 1, 2].map((axis) => aimTerms[axis as 0 | 1 | 2].join(" + ")) as unknown as [string, string, string],
    fov: fovTerms.join(" + "),
  };
}
