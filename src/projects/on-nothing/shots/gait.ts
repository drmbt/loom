import type { Bone } from "../scene-facts.ts";
import { boneParam } from "../skin-kernel.ts";

/**
 * T1407b (cyc) — THE WALK, from clinical gait data instead of a sine per joint.
 *
 * The skin kernel poses the figure from per-bone Euler knobs (radians about the rest axes,
 * applied x, then y, then z; each bone about its rest head, then its parent's). A walk built
 * from one sine per joint reads as a machine: real joints do not move harmonically — the knee
 * flexes twice a stride (a small loading bump, then the big swing), the ankle plantarflexes at
 * heel strike and again, hard, at push-off, the hip spends longer extending than flexing.
 *
 * So the walk is authored the way a mocap clip is keyed: normative sagittal curves (hip, knee,
 * ankle; Winter 1991 / Perry 1992, per cent of the stride from heel strike) plus the pelvis
 * rotation and list, the trunk's counter-rotation, the arm swing and the elbow. Each frame of
 * a dense phase grid is posed through the SAME forward kinematics as the kernel, and the root
 * is SOLVED from it: its height puts the lowest point of either shoe on the floor, its travel
 * keeps the planted point of the stance shoe still. Every knob and the root are then fitted
 * with a Fourier series in the stride phase and emitted as knob expressions (the expression
 * language has sin/cos but no tables) — a periodic curve through the keys, exact to a
 * fraction of a degree at 8 harmonics.
 *
 * Arms are posed by AIM, not by Euler guesses: the upper arm is turned from its rest (A-pose)
 * direction onto "hanging, swung forward by the shoulder flexion", the forearm onto "bent
 * forward by the elbow flexion", and each rotation is decomposed into the kernel's x-y-z order.
 */

export type Vec3 = readonly [number, number, number];
/** Row-major 3×3. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
/** Knob name → Euler angles (radians), e.g. `thighL` → [x, y, z]. */
export type Pose = Record<string, Vec3>;

// ── 3×3 algebra ──

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  return r as unknown as Mat3;
}

export function apply(m: Mat3, v: Vec3): [number, number, number] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

const sub = (a: Vec3, b: Vec3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function normalize(v: Vec3): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export const rotX = (a: number): Mat3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
export const rotY = (a: number): Mat3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
export const rotZ = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/** The kernel's `euler()`: rz * ry * rx (x applied first). */
export function eulerMatrix(e: Vec3): Mat3 {
  return mul(rotZ(e[2]), mul(rotY(e[1]), rotX(e[0])));
}

/** Inverse of `eulerMatrix`: the (x, y, z) whose rz·ry·rx is `m`. */
export function matrixEuler(m: Mat3): [number, number, number] {
  const y = Math.asin(Math.max(-1, Math.min(1, -m[6])));
  return [Math.atan2(m[7], m[8]), y, Math.atan2(m[3], m[0])];
}

/** Rodrigues: rotation by `angle` about unit `axis`. */
export function axisAngle(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

/** The smallest rotation taking direction `from` onto direction `to`. */
export function rotationBetween(from: Vec3, to: Vec3): Mat3 {
  const a = normalize(from);
  const b = normalize(to);
  const axis = cross(a, b);
  const s = Math.hypot(axis[0], axis[1], axis[2]);
  const c = dot(a, b);
  if (s < 1e-9) return c > 0 ? IDENTITY : axisAngle(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]), Math.PI);
  return axisAngle(axis, Math.atan2(s, c));
}

// ── The kernel's forward kinematics, in TypeScript ──

/** A bone's world transform (figure-local, before yaw and place): the kernel's `boneXf`. */
export function boneTransform(bones: readonly Bone[], pose: Pose, index: number): { m: Mat3; t: [number, number, number] } {
  let m: Mat3 = IDENTITY;
  let t: [number, number, number] = [0, 0, 0];
  let j = index;
  for (let level = 0; level < 8 && j >= 0; level++) {
    const bone = bones[j]!;
    const r = eulerMatrix(pose[boneParam(bone)] ?? [0, 0, 0]);
    m = mul(r, m);
    t = add(apply(r, sub(t, bone.head)), bone.head);
    j = bone.parent;
  }
  return { m, t };
}

export function posePoint(bones: readonly Bone[], pose: Pose, index: number, p: Vec3): [number, number, number] {
  const x = boneTransform(bones, pose, index);
  return add(apply(x.m, p), x.t);
}

export function boneNamed(bones: readonly Bone[], name: string): Bone {
  const bone = bones.find((b) => b.name === name);
  if (bone === undefined) throw new Error(`gait: the figure has no bone "${name}".`);
  return bone;
}

/** A bone's rest direction: from its head to its (first) child's head. */
export function restDirection(bones: readonly Bone[], name: string): [number, number, number] {
  const bone = boneNamed(bones, name);
  const child = bones.find((b) => b.parent === bone.index);
  if (child === undefined) throw new Error(`gait: bone "${name}" has no child to aim along.`);
  return normalize(sub(child.head, bone.head));
}

// ── Keyed curves ──

/** Keys as [position, value]; `periodic` wraps at `span` (a phase table in per cent). */
export type Keys = readonly (readonly [number, number])[];

/** Cubic Hermite through the keys (Catmull–Rom tangents), periodic over `span`. */
export function periodicSpline(keys: Keys, span = 100): (x: number) => number {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  if (k[k.length - 1]![0] >= span) k.pop();
  const n = k.length;
  const at = (i: number): readonly [number, number] => {
    const wraps = Math.floor(i / n);
    const key = k[((i % n) + n) % n]!;
    return [key[0] + wraps * span, key[1]];
  };
  return (xRaw: number) => {
    const x = ((xRaw % span) + span) % span;
    let i = n - 1;
    for (let j = 0; j < n; j++) if (k[j]![0] <= x) i = j;
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const xx = x < p1[0] ? x + span : x;
    const h = p2[0] - p1[0];
    const s = (xx - p1[0]) / h;
    const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0])) * h;
    const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0])) * h;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p1[1] + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * p2[1] + (s3 - s2) * m2;
  };
}

// ── Fourier fit and expression emission ──

export interface Fourier {
  readonly mean: number;
  readonly cos: readonly number[];
  readonly sin: readonly number[];
}

/** The first `harmonics` terms of a periodic sample set (samples cover one period, evenly). */
export function fourier(samples: readonly number[], harmonics: number): Fourier {
  const n = samples.length;
  const mean = samples.reduce((s, v) => s + v, 0) / n;
  const c: number[] = [];
  const s: number[] = [];
  for (let k = 1; k <= harmonics; k++) {
    let a = 0, b = 0;
    samples.forEach((v, i) => {
      const w = (2 * Math.PI * k * i) / n;
      a += v * Math.cos(w);
      b += v * Math.sin(w);
    });
    c.push((2 * a) / n);
    s.push((2 * b) / n);
  }
  return { mean, cos: c, sin: s };
}

export function evalFourier(f: Fourier, phase01: number): number {
  let v = f.mean;
  f.cos.forEach((a, i) => { v += a * Math.cos(2 * Math.PI * (i + 1) * phase01); });
  f.sin.forEach((b, i) => { v += b * Math.sin(2 * Math.PI * (i + 1) * phase01); });
  return v;
}

const num = (v: number, digits = 5): string => {
  const s = v.toFixed(digits);
  return s.startsWith("-") ? `(${s})` : s;
};

/**
 * The fit as an expression in the clock: phase = abstime · `cyclesPerSecond` + `phase0`
 * (in cycles). Terms under `floor` are dropped.
 */
export function fourierExpression(f: Fourier, cyclesPerSecond: number, phase0: number, clock = "abstime", floor = 2e-4): string {
  const terms: string[] = [num(f.mean)];
  const w = 2 * Math.PI * cyclesPerSecond;
  const o = 2 * Math.PI * phase0;
  for (let k = 1; k <= f.cos.length; k++) {
    const arg = `(${num(k * w, 6)} * ${clock} + ${num(k * o, 6)})`;
    if (Math.abs(f.cos[k - 1]!) > floor) terms.push(`${num(f.cos[k - 1]!)} * cos${arg}`);
    if (Math.abs(f.sin[k - 1]!) > floor) terms.push(`${num(f.sin[k - 1]!)} * sin${arg}`);
  }
  return terms.join(" + ");
}

/**
 * Non-periodic keys over TIME as an expression: a cubic Hermite (Catmull–Rom tangents, flat at
 * the ends) written as a telescoping sum of clamped segments, so it holds the first value
 * before the first key and the last after the last. `keys` as [seconds, value].
 */
export function keyedExpression(keys: Keys, clock = "abstime"): string {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  if (k.length === 0) throw new Error("keyedExpression: no keys.");
  if (k.length === 1) return num(k[0]![1]);
  const tangent = (i: number): number => {
    if (i === 0 || i === k.length - 1) return 0;
    return (k[i + 1]![1] - k[i - 1]![1]) / (k[i + 1]![0] - k[i - 1]![0]);
  };
  const terms: string[] = [num(k[0]![1])];
  for (let i = 0; i + 1 < k.length; i++) {
    const [t0, v0] = k[i]!;
    const [t1, v1] = k[i + 1]!;
    const d = t1 - t0;
    const delta = v1 - v0;
    const m0 = tangent(i) * d;
    const m1 = tangent(i + 1) * d;
    // H(s) − v0 = m0·s + (3Δ − 2m0 − m1)·s² + (m0 + m1 − 2Δ)·s³
    const c1 = m0, c2 = 3 * delta - 2 * m0 - m1, c3 = m0 + m1 - 2 * delta;
    if (Math.abs(c1) + Math.abs(c2) + Math.abs(c3) < 1e-7) continue;
    const s = `clamp((${clock} - ${num(t0, 4)}) / ${num(d, 4)}, 0, 1)`;
    terms.push(`(${num(c1)} * ${s} + ${num(c2)} * ${s} ^ 2 + ${num(c3)} * ${s} ^ 3)`);
  }
  return terms.join(" + ");
}

/** The same curve evaluated in TypeScript (tests and the root solve). */
export function keyedValue(keys: Keys, t: number): number {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  if (t <= k[0]![0]) return k[0]![1];
  if (t >= k[k.length - 1]![0]) return k[k.length - 1]![1];
  let i = 0;
  while (k[i + 1]![0] < t) i++;
  const tangent = (j: number): number => (j === 0 || j === k.length - 1 ? 0 : (k[j + 1]![1] - k[j - 1]![1]) / (k[j + 1]![0] - k[j - 1]![0]));
  const [t0, v0] = k[i]!;
  const [t1, v1] = k[i + 1]!;
  const d = t1 - t0;
  const s = (t - t0) / d;
  const m0 = tangent(i) * d;
  const m1 = tangent(i + 1) * d;
  return v0 + m0 * s + (3 * (v1 - v0) - 2 * m0 - m1) * s * s + (m0 + m1 - 2 * (v1 - v0)) * s * s * s;
}

// ── The gait ──

const DEG = Math.PI / 180;

/** Sagittal joint angles over the stride, per cent from heel strike, degrees (Winter/Perry). */
export const HIP_FLEXION: Keys = [[0, 29], [10, 28], [20, 22], [30, 14], [40, 5], [50, -6], [55, -10], [60, -6], [65, 2], [70, 10], [75, 19], [80, 26], [86, 32], [92, 32.5]];
export const KNEE_FLEXION: Keys = [[0, 4], [5, 10], [12, 17], [18, 16], [25, 11], [32, 6], [40, 5], [45, 8], [50, 15], [55, 25], [60, 38], [65, 49], [70, 59], [73, 61], [78, 57], [83, 42], [88, 22], [92, 9], [96, 4]];
export const ANKLE_DORSIFLEXION: Keys = [[0, 0], [6, -6], [12, -2], [20, 4], [30, 8], [40, 11], [46, 10], [52, 3], [57, -7], [62, -17], [65, -18], [70, -11], [76, -4], [82, 0], [90, 1]];

export interface GaitStyle {
  /** Seconds per stride (two steps) in real time. */
  readonly period: number;
  /** Playback rate: 1 is real time, 0.5 the reference's slow motion. */
  readonly rate: number;
  /** Scales the sagittal ranges (hip and knee): below 1 a shorter, lazier step. */
  readonly stride: number;
  /** Shoulder swing amplitude and mean (degrees of flexion; the mean is slightly back). */
  readonly armSwing: number;
  readonly armMean: number;
  /** Elbow flexion at rest, and how much more it bends when the arm swings forward (degrees). */
  readonly elbow: number;
  readonly elbowSwing: number;
  /** Arms held this far out from the thigh (degrees). */
  readonly armOut: number;
  /** Pelvis rotation and list amplitudes (degrees); trunk counter-rotation share. */
  readonly pelvisTurn: number;
  readonly pelvisList: number;
  readonly counter: number;
  /** Lateral sway of the pelvis toward the stance foot, metres. */
  readonly sway: number;
  /** Each ankle's distance from the midline, metres (half the step width). */
  readonly track: number;
  /** Toe-out of the feet, degrees. */
  readonly toeOut: number;
  /** Anterior pelvic tilt, degrees: the offset between clinical hip flexion and the thigh's angle to the vertical. */
  readonly tilt: number;
  /** Forward trunk lean and head pitch (radians; + leans forward / looks down). */
  readonly lean: number;
  readonly head: number;
  /** Phase at abstime 0, in strides (0 = left heel strike). */
  readonly phase0: number;
}

export const NORMAL_WALK: GaitStyle = {
  period: 1.1,
  rate: 1,
  stride: 1,
  armSwing: 17,
  armMean: -4,
  elbow: 16,
  elbowSwing: 14,
  armOut: 7,
  pelvisTurn: 4.5,
  pelvisList: 3.5,
  counter: 0.75,
  sway: 0.022,
  track: 0.075,
  toeOut: 7,
  tilt: 10,
  lean: 0.04,
  head: 0.05,
  phase0: 0,
};

/** Contact points on each shoe, at rest (figure-local metres): heel, ball, toe. */
function shoePoints(bones: readonly Bone[], side: "L" | "R"): Vec3[] {
  const ankle = boneNamed(bones, `foot.${side}`).head;
  return [
    [ankle[0], 0.0, ankle[2] - 0.06],
    [ankle[0], 0.0, ankle[2] + 0.12],
    [ankle[0], 0.03, ankle[2] + 0.2],
  ];
}

export interface ArmAim {
  /** Shoulder flexion, degrees: + swings the arm forward (90 points it ahead, 180 straight up). */
  readonly flex: number;
  /** Abduction, degrees: + lifts it out to the side (from hanging). */
  readonly out: number;
  /** Elbow flexion, degrees: + bends the forearm forward and up. */
  readonly elbow: number;
  /** Inward (internal) rotation of the upper arm, degrees: turns the elbow's bend across the body (90 bends the forearm straight across the chest). */
  readonly inward?: number;
  /** Wrist flexion and deviation, radians (the hand's own knob). */
  readonly wrist?: Vec3;
}

/**
 * An arm AIMED rather than guessed: the upper arm turned from its rest (A-pose) direction onto
 * "hanging, lifted out by `out`, swung by `flex`", the forearm onto "bent by `elbow` in the
 * upper arm's hanging frame", each rotation decomposed into the kernel's x-y-z order.
 */
export function armPose(bones: readonly Bone[], side: "L" | "R", aim: ArmAim): Pose {
  const sx = side === "L" ? 1 : -1;
  const upperRest = restDirection(bones, `upperarm.${side}`);
  const foreRest = restDirection(bones, `forearm.${side}`);
  const out = aim.out * DEG;
  const hanging: Vec3 = [sx * Math.sin(out), -Math.cos(out), 0];
  const lower = rotationBetween(upperRest, hanging);
  const upper = mul(rotX(-aim.flex * DEG), lower);
  // The forearm, in the hanging frame: bent forward by the elbow, the bend turned in across
  // the body by the upper arm's internal rotation (about the hanging arm).
  const bent = apply(mul(axisAngle(hanging, sx * (aim.inward ?? 7) * DEG), rotX(-aim.elbow * DEG)), hanging);
  const fore = rotationBetween(foreRest, apply(transpose(lower), bent));
  return {
    [`upperarm${side}`]: matrixEuler(upper),
    [`forearm${side}`]: matrixEuler(fore),
    [`hand${side}`]: aim.wrist ?? [0.1, 0, sx * 0.08],
  };
}

/**
 * The legs of a figure standing easy: the rest pose's splay brought in under the hips (each
 * ankle `track` from the midline), a little weight on one leg (`shift`, + onto the left).
 */
export function standingLegs(bones: readonly Bone[], track = 0.1, shift = 0, toeOut = 8): Pose {
  const pose: Pose = {};
  for (const side of ["L", "R"] as const) {
    const sx = side === "L" ? 1 : -1;
    const thigh = boneNamed(bones, `thigh.${side}`);
    const ankleBone = boneNamed(bones, `foot.${side}`);
    const reach = thigh.head[1] - ankleBone.head[1];
    const adduct = -sx * Math.atan2(Math.abs(ankleBone.head[0]) - track, reach);
    // The free leg (the one not taking the weight) bends a little at the knee.
    const free = Math.max(0, -sx * shift);
    pose[`thigh${side}`] = [-free * 0.12, sx * toeOut * DEG * 0.5, adduct * 0.75];
    pose[`shin${side}`] = [free * 0.22, 0, adduct * 0.25];
    pose[`foot${side}`] = [-free * 0.08, sx * toeOut * DEG * 0.5, -adduct];
  }
  // Weight on the left leg drops the right hip: the pelvis rolls left-side up, the spine back.
  pose["pelvis"] = [0, 0, shift * 0.05];
  pose["spine"] = [0, 0, -shift * 0.04];
  return pose;
}

/** The pose at stride phase `p` (0..1, 0 = left heel strike). */
export function gaitPose(bones: readonly Bone[], style: GaitStyle, p: number): Pose {
  const pose: Pose = {};
  const hip = periodicSpline(HIP_FLEXION);
  const knee = periodicSpline(KNEE_FLEXION);
  const ankle = periodicSpline(ANKLE_DORSIFLEXION);
  const turn = (phase: number): number => -style.pelvisTurn * DEG * Math.cos(2 * Math.PI * phase);
  const list = (phase: number): number => style.pelvisList * DEG * Math.sin(2 * Math.PI * (phase + 0.05));
  const pelvisYaw = turn(p);
  const pelvisRoll = list(p);
  pose["pelvis"] = [0, pelvisYaw, pelvisRoll];
  // The trunk turns back against the pelvis and stays level: the shoulders counter-rotate.
  const counterYaw = -pelvisYaw * (1 + style.counter);
  pose["spine"] = [style.lean * 0.6, counterYaw * 0.5, -pelvisRoll * 0.6];
  pose["chest"] = [style.lean * 0.4, counterYaw * 0.5, -pelvisRoll * 0.4];
  // The head keeps looking where it walks.
  pose["neck"] = [style.head * 0.6, -(pelvisYaw + counterYaw) * 0.9, 0];
  pose["head"] = [style.head * 0.4, 0, 0];

  for (const side of ["L", "R"] as const) {
    const sx = side === "L" ? 1 : -1;
    const q = side === "L" ? p : p + 0.5;
    const pc = (((q % 1) + 1) % 1) * 100;
    const thigh = boneNamed(bones, `thigh.${side}`);
    const ankleBone = boneNamed(bones, `foot.${side}`);
    // Bring the rest pose's splayed legs under the body: rotate the leg about the hip (and a
    // little at the knee) until the ankle sits `track` from the midline.
    const reach = thigh.head[1] - ankleBone.head[1];
    const adduct = -sx * Math.atan2(Math.abs(ankleBone.head[0]) - style.track, reach);
    // Clinical hip flexion is measured against the PELVIS, which rides tilted forward: the
    // thigh's angle to the vertical is the flexion less that tilt (±20° at heel strike).
    const hipFlex = (hip(pc) * style.stride - style.tilt) * DEG;
    const kneeFlex = knee(pc) * DEG * (0.35 + 0.65 * style.stride);
    const dorsi = ankle(pc) * DEG;
    pose[`thigh${side}`] = [-hipFlex, -pelvisYaw + sx * style.toeOut * DEG * 0.5, adduct * 0.75 - pelvisRoll];
    pose[`shin${side}`] = [kneeFlex, 0, adduct * 0.25];
    // The sole stays flat across the track: undo the leg's roll at the ankle.
    pose[`foot${side}`] = [-dorsi, sx * style.toeOut * DEG * 0.5, -adduct];

    // Arms: this arm swings with the OTHER leg.
    const qa = side === "L" ? p : p + 0.5;
    const swing = Math.cos(2 * Math.PI * (qa - 0.53));
    const arm = armPose(bones, side, {
      flex: style.armMean + style.armSwing * swing,
      out: style.armOut,
      elbow: style.elbow + style.elbowSwing * Math.max(swing, -0.3),
    });
    Object.assign(pose, arm);
  }
  return pose;
}

export interface SolvedGait {
  /** Metres travelled per stride. */
  readonly strideLength: number;
  /** Per knob axis (`thighL.x`) and per root axis (`root.x/y/z`), the fitted series. */
  readonly series: ReadonlyMap<string, Fourier>;
  /** The phase grid's poses and roots (tests read them). */
  readonly samples: readonly { readonly p: number; readonly pose: Pose; readonly root: Vec3 }[];
}

const SAMPLES = 120;
export const HARMONICS = 8;
/** The root carries the contact switches (heel to ball to the other heel): kinks that need more terms. */
export const ROOT_HARMONICS = 12;

/**
 * Pose the stride on a dense grid and solve the root: its height puts the lowest shoe point
 * on the floor; its forward travel keeps the planted point still (the point touching the floor
 * does not move while it touches it); its sideways sway follows the stance foot.
 */
export function solveGait(bones: readonly Bone[], style: GaitStyle): SolvedGait {
  const points = { L: shoePoints(bones, "L"), R: shoePoints(bones, "R") };
  const foot = { L: boneNamed(bones, "foot.L").index, R: boneNamed(bones, "foot.R").index };
  const poses: Pose[] = [];
  const contacts: { side: "L" | "R"; k: number; y: number }[] = [];
  const heights: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const p = i / SAMPLES;
    const pose = gaitPose(bones, style, p);
    // Foot flat: from loading to heel-off the sole lies on the floor. The keyed ankle only
    // approximates that on this skeleton, so level the shoe (heel and ball at one height).
    for (const side of ["L", "R"] as const) {
      const pc = ((((side === "L" ? p : p + 0.5) % 1) + 1) % 1) * 100;
      const flat = Math.min(1, Math.max(0, (pc - 4) / 6)) * Math.min(1, Math.max(0, (40 - pc) / 6));
      if (flat <= 0) continue;
      const [heel, ball] = points[side];
      for (let pass = 0; pass < 3; pass++) {
        const h = posePoint(bones, pose, foot[side], heel!);
        const b = posePoint(bones, pose, foot[side], ball!);
        const pitch = Math.atan2(b[1] - h[1], Math.hypot(b[0] - h[0], b[2] - h[2]));
        const knob = `foot${side}`;
        const e = pose[knob]!;
        pose[knob] = [e[0] + pitch * flat, e[1], e[2]];
      }
    }
    poses.push(pose);
    let best = { side: "L" as "L" | "R", k: 0, y: Infinity };
    for (const side of ["L", "R"] as const) {
      points[side].forEach((point, k) => {
        const y = posePoint(bones, pose, foot[side], point)[1];
        if (y < best.y) best = { side, k, y };
      });
    }
    contacts.push(best);
    heights.push(-best.y);
  }
  // Forward travel: the contact point stays where it is on the floor.
  const forward: number[] = [0];
  for (let i = 0; i < SAMPLES; i++) {
    const c = contacts[i]!;
    const here = posePoint(bones, poses[i]!, foot[c.side], points[c.side][c.k]!)[2];
    const next = posePoint(bones, poses[(i + 1) % SAMPLES]!, foot[c.side], points[c.side][c.k]!)[2];
    forward.push(forward[i]! - (next - here));
  }
  const strideLength = forward[SAMPLES]!;
  const residual = forward.slice(0, SAMPLES).map((z, i) => z - (strideLength * i) / SAMPLES);
  const sway = Array.from({ length: SAMPLES }, (_, i) => style.sway * Math.sin((2 * Math.PI * i) / SAMPLES));
  const series = new Map<string, Fourier>();
  series.set("root.x", fourier(sway, HARMONICS));
  series.set("root.y", fourier(heights, ROOT_HARMONICS));
  series.set("root.z", fourier(residual, ROOT_HARMONICS));
  const knobs = Object.keys(poses[0]!);
  for (const knob of knobs) {
    (["x", "y", "z"] as const).forEach((axis, a) => {
      series.set(`${knob}.${axis}`, fourier(poses.map((pose) => pose[knob]![a]!), HARMONICS));
    });
  }
  return {
    strideLength,
    series,
    samples: poses.map((pose, i) => ({ p: i / SAMPLES, pose, root: [sway[i]!, heights[i]!, residual[i]!] as const })),
  };
}

export interface WalkExpressions {
  /** Knob axis (`thighL.x`) → expression. */
  readonly knobs: Record<string, string>;
  /** The root, figure-local (x = its left, y = up, z = forward), as expressions; z includes the steady travel. */
  readonly root: { readonly x: string; readonly y: string; readonly z: string };
  readonly speed: number;
  readonly strideLength: number;
}

/**
 * The walk as knob expressions on `clock` (seconds). The steady travel is `speed · clock`
 * (metres per second of playback) plus the solved residual.
 */
export function walkExpressions(bones: readonly Bone[], style: GaitStyle, clock = "abstime"): WalkExpressions {
  const solved = solveGait(bones, style);
  const cps = style.rate / style.period;
  const knobs: Record<string, string> = {};
  for (const [key, f] of solved.series) {
    if (key.startsWith("root.")) continue;
    const flat = f.cos.every((v) => Math.abs(v) < 2e-4) && f.sin.every((v) => Math.abs(v) < 2e-4);
    if (flat && Math.abs(f.mean) < 2e-4) continue;
    knobs[key] = flat ? num(f.mean) : fourierExpression(f, cps, style.phase0, clock);
  }
  const speed = solved.strideLength * cps;
  const z = `${num(speed, 6)} * ${clock} + ${fourierExpression(solved.series.get("root.z")!, cps, style.phase0, clock)}`;
  return {
    knobs,
    root: {
      x: fourierExpression(solved.series.get("root.x")!, cps, style.phase0, clock),
      y: fourierExpression(solved.series.get("root.y")!, cps, style.phase0, clock),
      z,
    },
    speed,
    strideLength: solved.strideLength,
  };
}

/** A pose held at a time: the performance keys of a figure that does not walk. */
export interface KeyPose {
  readonly t: number;
  readonly pose: Pose;
}

/** Key poses → per knob axis keys (`upperarmR.x` → [[t, v], …]); a knob missing from a key holds 0. */
export function poseKeys(keys: readonly KeyPose[]): Record<string, Keys> {
  const knobs = new Set(keys.flatMap((key) => Object.keys(key.pose)));
  const out: Record<string, Keys> = {};
  for (const knob of knobs) {
    (["x", "y", "z"] as const).forEach((axis, a) => {
      const series = keys.map((key): readonly [number, number] => [key.t, key.pose[knob]?.[a] ?? 0]);
      if (series.some(([, v]) => Math.abs(v) > 1e-5)) out[`${knob}.${axis}`] = series;
    });
  }
  return out;
}
