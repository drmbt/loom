import type { Bone } from "../scene-facts.ts";

/**
 * T1407b (closeups2) — the figure's FORWARD KINEMATICS on the CPU: exactly the skin kernel's
 * bone walk (skin-kernel.ts: each bone turns about its REST head by Euler x, then y, then z
 * about the rest axes, then its parent's, up to the pelvis; the figure is then turned by `yaw`
 * and set down at `place`), so a document can put a prop where a posed hand IS — the held
 * shoe in the hand, the lens a hand's breadth from the face — instead of guessing.
 *
 * Only for static knobs (numbers): an animated pose would need the walk per frame.
 */

export type V3 = readonly [number, number, number];
/** Row-major 3×3. */
export type M3 = readonly [number, number, number, number, number, number, number, number, number];

export const mul = (a: M3, b: M3): M3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
export const apply = (m: M3, v: V3): [number, number, number] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const addv = (a: V3, b: V3, k = 1): [number, number, number] => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
export const subv = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): [number, number, number] => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rz · Ry · Rx, the kernel's `euler`. */
export function euler(e: V3): M3 {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(e[0]), Math.sin(e[0]), Math.cos(e[1]), Math.sin(e[1]), Math.cos(e[2]), Math.sin(e[2])];
  const rx: M3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry: M3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz: M3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul(rz, mul(ry, rx));
}

/** Rotation about +Y by `yaw` (the kernel's `turn`: 0 faces +Z). */
export function yawMatrix(yaw: number): M3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export interface Pose {
  readonly place: V3;
  readonly yaw: number;
  /** Knobs by bone parameter name (`upperarmR`), radians. */
  readonly bones: Readonly<Record<string, V3>>;
}

/** A bone's WORLD transform under the pose: world = m · rest + t. */
export function boneWorld(bones: readonly Bone[], pose: Pose, name: string): { readonly m: M3; readonly t: [number, number, number] } {
  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  let bone = byName.get(name);
  if (bone === undefined) throw new Error(`reach: no bone "${name}".`);
  let m: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let t: [number, number, number] = [0, 0, 0];
  for (let level = 0; level < 8 && bone !== undefined; level++) {
    const r = euler(pose.bones[bone.name.replace(/[^A-Za-z0-9]/g, "")] ?? [0, 0, 0]);
    m = mul(r, m);
    t = addv(apply(r, subv(t, bone.head)), bone.head);
    bone = bone.parent < 0 ? undefined : bones[bone.parent];
  }
  const turn = yawMatrix(pose.yaw);
  return { m: mul(turn, m), t: addv(apply(turn, t), pose.place) };
}

/** Where a REST point riding on `bone` lands in the world under the pose. */
export function reach(bones: readonly Bone[], pose: Pose, name: string, rest: V3): [number, number, number] {
  const x = boneWorld(bones, pose, name);
  return addv(apply(x.m, rest), x.t);
}

/**
 * Two-bone reach: the upper-arm (x, y, z) and forearm (x, z) knobs that put the WRIST (the
 * hand bone's head) at `target`, staying near `prior` (a natural starting pose, so the elbow
 * falls where a person's would). Deterministic coordinate descent with shrinking steps; the
 * residual is returned so a document can refuse a pose the arm cannot reach.
 */
export function reachArm(bones: readonly Bone[], pose: Pose, side: "L" | "R", target: V3, prior: Readonly<Record<string, V3>>, elbow?: V3): { readonly bones: Record<string, V3>; readonly miss: number } {
  const upper = `upperarm${side}`;
  const fore = `forearm${side}`;
  const wristRest = bones.find((bone) => bone.name === `hand.${side}`)?.head;
  const elbowRest = bones.find((bone) => bone.name === `forearm.${side}`)?.head;
  if (wristRest === undefined || elbowRest === undefined) throw new Error(`reachArm: no hand.${side} or forearm.${side}.`);
  const start = [...(prior[upper] ?? [0, 0, 0]), (prior[fore] ?? [0, 0, 0])[0], (prior[fore] ?? [0, 0, 0])[2]];
  const knobs = (x: readonly number[]): Record<string, V3> => ({ ...pose.bones, ...prior, [upper]: [x[0]!, x[1]!, x[2]!], [fore]: [x[3]!, (prior[fore] ?? [0, 0, 0])[1], x[4]!] });
  const cost = (x: readonly number[]): number => {
    const at = reach(bones, { ...pose, bones: knobs(x) }, `hand.${side}`, wristRest);
    const d = subv(at, target);
    let prefer = 0;
    for (let i = 0; i < x.length; i++) prefer += (x[i]! - start[i]!) ** 2;
    // an elbow hint (a pole): where the elbow should fall, weighed well below the wrist
    let pole = 0;
    if (elbow !== undefined) {
      const e = subv(reach(bones, { ...pose, bones: knobs(x) }, `upperarm.${side}`, elbowRest), elbow);
      pole = 0.15 * dot(e, e);
    }
    return dot(d, d) + 0.0004 * prefer + pole;
  };
  const x = [...start];
  let best = cost(x);
  for (let step = 0.4; step > 0.0005; step *= 0.6) {
    for (let pass = 0; pass < 12; pass++) {
      let moved = false;
      for (let i = 0; i < x.length; i++) {
        for (const sign of [1, -1]) {
          const trial = [...x];
          trial[i] = trial[i]! + sign * step;
          const c = cost(trial);
          if (c < best) {
            best = c;
            x[i] = trial[i]!;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }
  const solved = knobs(x);
  const at = reach(bones, { ...pose, bones: solved }, `hand.${side}`, wristRest);
  return { bones: solved, miss: Math.hypot(...subv(at, target)) };
}
