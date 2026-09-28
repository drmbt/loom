import type { Bone } from "../scene-facts.ts";
import { boneParam } from "../skin-kernel.ts";

/**
 * T1407b (mcu) — the figure's arms placed by TARGET, not by hand-tuned angles: a forward
 * kinematics that is the skin kernel's own (skin-kernel.ts: each bone turns about its rest head
 * by Euler angles x, then y, then z about the rest axes, then its parent does), and a damped
 * Gauss-Newton solve of an arm's three bones (upper arm, forearm, hand) so its elbow, wrist and
 * fingertip land where a pose asks. Everything is in the figure's REST frame (x = its left, y
 * up, z the way it faces, metres), before the kernel's yaw and place.
 *
 * The performances in shots/mcu.ts are written as these targets (hands on the head, at the
 * temples, a fist before the mouth), read off the reference's frames; the solver turns them
 * into the kernel's knobs once, at build time.
 */

export type V3 = readonly [number, number, number];
export type Euler = [number, number, number];
/** Knob name (`upperarmL`) → Euler angles, radians. */
export type Angles = Record<string, Euler>;

type M3 = [number, number, number, number, number, number, number, number, number];

function mul(a: M3, b: M3): M3 {
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0] as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return r;
}

function apply(m: M3, v: V3): [number, number, number] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** The kernel's euler(): Rz · Ry · Rx (row-major here). */
function euler(e: readonly number[]): M3 {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(e[0]!), Math.sin(e[0]!), Math.cos(e[1]!), Math.sin(e[1]!), Math.cos(e[2]!), Math.sin(e[2]!)];
  const rx: M3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry: M3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz: M3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul(rz, mul(ry, rx));
}

/** Where a rest point bound rigidly to `bone` lands under `pose` (the kernel's boneXf, then the point). */
export function posed(bones: readonly Bone[], pose: Angles, bone: number, rest: V3): [number, number, number] {
  let m: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let t: [number, number, number] = [0, 0, 0];
  let j = bone;
  while (j >= 0) {
    const b = bones[j]!;
    const r = euler(pose[boneParam(b)] ?? [0, 0, 0]);
    const h = b.head;
    m = mul(r, m);
    const shifted = apply(r, [t[0] - h[0], t[1] - h[1], t[2] - h[2]]);
    t = [shifted[0] + h[0], shifted[1] + h[1], shifted[2] + h[2]];
    j = b.parent;
  }
  const p = apply(m, rest);
  return [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
}

export function boneIndex(bones: readonly Bone[], name: string): number {
  const found = bones.find((bone) => bone.name === name);
  if (found === undefined) throw new Error(`mcu-rig: no bone "${name}".`);
  return found.index;
}

/**
 * The fingertip at rest, relative to the hand bone's head: the far end of the hand's own
 * vertices on the MPFB figure (measured off the GLB: the left hand's head 0.500, 1.103, 0.213,
 * its farthest vertex 0.563, 0.976, 0.366). Mirrored for the right.
 */
const TIP_L: V3 = [0.063, -0.127, 0.153];

export interface ArmTarget {
  /** Where the elbow (the forearm's head) should be. */
  readonly elbow: V3;
  /** Where the wrist (the hand's head) should be. */
  readonly wrist: V3;
  /** Where the fingertips should point to / reach. */
  readonly tip: V3;
  /** Where to start the solve (upper arm, forearm, hand Euler angles), and what the solve is pulled back toward. */
  readonly seed?: readonly [Euler, Euler, Euler];
  /** The wrist and the fingertips are given on the REST head and follow the head wherever the pose turns it (hands on the head). */
  readonly onHead?: boolean;
}

/**
 * Solve one arm (side "L" or "R") against `target`, holding every other knob of `pose` (the
 * torso's lean, the shoulders) as given; starts from `pose`'s own arm angles, so a sequence of
 * keys solved in order stays on one continuous branch. Returns the arm's three knobs.
 */
export function solveArm(bones: readonly Bone[], pose: Angles, side: "L" | "R", target: ArmTarget): Angles {
  const names = [`upperarm${side}`, `forearm${side}`, `hand${side}`];
  const forearm = boneIndex(bones, `forearm.${side}`);
  const hand = boneIndex(bones, `hand.${side}`);
  const upper = boneIndex(bones, `upperarm.${side}`);
  const sx = side === "L" ? 1 : -1;
  const handHead = bones[hand]!.head;
  const tipRest: V3 = [handHead[0] + TIP_L[0] * sx, handHead[1] + TIP_L[1], handHead[2] + TIP_L[2]];
  if (target.onHead === true) {
    // carry the wrist and the tip with the posed head (the elbow stays in the body's frame)
    const head = boneIndex(bones, "head");
    target = { ...target, onHead: false, wrist: posed(bones, pose, head, target.wrist), tip: posed(bones, pose, head, target.tip) };
  }
  const seed: number[] = target.seed === undefined ? names.flatMap((name) => pose[name] ?? [0, 0, 0]) : target.seed.flat();
  const x: number[] = [...seed];
  const withX = (v: readonly number[]): Angles => ({ ...pose, [names[0]!]: [v[0]!, v[1]!, v[2]!], [names[1]!]: [v[3]!, v[4]!, v[5]!], [names[2]!]: [v[6]!, v[7]!, v[8]!] });
  // weights: the wrist matters most, then the elbow (the arm's attitude), then the hand's aim;
  // a light pull toward zero keeps the forearm and hand from twisting where nothing asks them to
  const residual = (v: readonly number[]): number[] => {
    const p = withX(v);
    const e = posed(bones, p, upper, bones[forearm]!.head);
    const w = posed(bones, p, forearm, handHead);
    const t = posed(bones, p, hand, tipRest);
    const r: number[] = [];
    for (let a = 0; a < 3; a++) r.push((e[a]! - target.elbow[a]!) * 1.5);
    for (let a = 0; a < 3; a++) r.push((w[a]! - target.wrist[a]!) * 2.0);
    for (let a = 0; a < 3; a++) r.push((t[a]! - target.tip[a]!) * 0.8);
    v.forEach((value, index) => r.push((value - seed[index]!) * (index < 3 ? 0.004 : index < 6 ? 0.02 : 0.03)));
    return r;
  };
  let lambda = 1e-3;
  let r = residual(x);
  let cost = r.reduce((sum, value) => sum + value * value, 0);
  for (let iteration = 0; iteration < 200 && cost > 1e-10; iteration++) {
    // numeric Jacobian
    const J: number[][] = [];
    for (let k = 0; k < x.length; k++) {
      const probe = [...x];
      probe[k]! += 1e-5;
      const rk = residual(probe);
      J.push(rk.map((value, index) => (value - r[index]!) / 1e-5));
    }
    // (JᵀJ + λ diag) δ = −Jᵀr
    const n = x.length;
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => J[i]!.reduce((sum, value, index) => sum + value * J[j]![index]!, 0)));
    const g = Array.from({ length: n }, (_, i) => J[i]!.reduce((sum, value, index) => sum + value * r[index]!, 0));
    let improved = false;
    for (let attempt = 0; attempt < 12 && !improved; attempt++) {
      const M = A.map((row, i) => row.map((value, j) => value + (i === j ? lambda * (1 + A[i]![i]!) : 0)));
      const delta = solve(M, g.map((value) => -value));
      const next = x.map((value, index) => value + delta[index]!);
      const rn = residual(next);
      const cn = rn.reduce((sum, value) => sum + value * value, 0);
      if (cn < cost) {
        x.splice(0, x.length, ...next);
        r = rn;
        cost = cn;
        lambda = Math.max(lambda * 0.3, 1e-7);
        improved = true;
      } else {
        lambda *= 10;
      }
    }
    if (!improved) break;
  }
  const out = withX(x);
  return { [names[0]!]: out[names[0]!]!, [names[1]!]: out[names[1]!]!, [names[2]!]: out[names[2]!]! };
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[pivot]![c]!)) pivot = r;
    [M[c], M[pivot]] = [M[pivot]!, M[c]!];
    const d = M[c]![c]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / d;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / (row[i]! || 1e-12));
}

/** Mirror a left-side target to the right (x flips). */
export function mirror(target: ArmTarget): ArmTarget {
  const flip = (v: V3): V3 => [-v[0], v[1], v[2]];
  // a mirror in x keeps x rotations and negates y and z
  const seed = target.seed?.map((e) => [e[0], -e[1], -e[2]] as Euler) as [Euler, Euler, Euler] | undefined;
  return { ...target, elbow: flip(target.elbow), wrist: flip(target.wrist), tip: flip(target.tip), ...(seed === undefined ? {} : { seed }) };
}
