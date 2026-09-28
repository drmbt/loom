import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { BLOOM_DOWN_WGSL, BRIGHT_PASS_WGSL } from "../../furnace/post.ts";
import { CAMERA_PARAMS, GTAO_WGSL, VIEW } from "../../furnace/screen-space.ts";
import { hazeLights, hazeWgsl } from "../atmosphere.ts";
import type { Area, Bone, OnNothingFacts } from "../scene-facts.ts";
import { carAreas } from "../scene-facts.ts";
import { PISTOL_GRIP, SKIN_ATTRIBUTES, boneParam, handPose, restPalm, skinKernel, type HandPose } from "../skin-kernel.ts";
import { SURFACE_WGSL } from "../surface.ts";
import { BLOOM_ADD_WGSL, DOF_FILL_WGSL, LENS_DOF_WGSL, STUDIO_ENV_WGSL } from "./closeups-fx.ts";
import { CLOSEUP_SURFACE_WGSL } from "./closeups-surface.ts";
import { apply, eulerMatrix, mul, type Pose, type Vec3 } from "./gait.ts";
import { Chain, cameraParams, num, vec3 } from "./title-graph.ts";

/**
 * T1407b (hands) — THE HANDS: the reference's tele close-ups of ringed hands
 * (docs/on-nothing-shotlist-2026-09-27.md; edl.json rows with `"plan": "hands"`). One graph per
 * take; each take is one reference cut (a row, or one part of a row that cuts inside itself).
 *
 * The figure is the clothed `fig`, cut in two by material (scene-facts.ts `figbody`, `figice`):
 * the body wears the scene's surface, the rings, the watch and the Cuban bracelet
 * (tools/blender/on-nothing/hands.py) the close-ups' pavé surface. Both are posed by the same
 * skin-kernel knobs, and the HANDS are posed by the finger knobs of T1419b (`curlL`, `spreadL`,
 * `thumbL`, through `handPose`).
 *
 * Arms are SOLVED, not guessed: `solveArm` fits the upper arm, forearm and hand Euler knobs so
 * the wrist lands on a world point with the hand pointing and the palm facing where the take
 * says (Nelder–Mead over the kernel's own forward kinematics, gait.ts). A gesture that changes
 * inside a cut is two solved poses and an eased blend between them.
 *
 * The chain is the close-ups' (closeups.ts): render → occlusion → [haze] → bokeh lamps → the
 * thin-lens depth of field → the streak glass → bloom → [a flare] → lens → grade → [CRT]. The
 * camera is a tele handheld with JOLTS: on top of the slow wander, short sharp knocks at
 * irregular times, as a hand-held long lens takes every step of the operator.
 */

type V3 = readonly [number, number, number];
type Side = "L" | "R";

// ── Small vector helpers ──
const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3, k = 1): [number, number, number] => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): [number, number, number] => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Where the figure stands and which way it faces (radians about +Y; 0 faces +Z). */
interface Placement {
  readonly place: V3;
  readonly yaw: number;
}

/** World → the figure's own frame (the kernel's `place + turn(yaw) * local`, inverted). */
function toLocal(p: V3, at: Placement): [number, number, number] {
  const d = sub(p, at.place);
  const c = Math.cos(at.yaw);
  const s = Math.sin(at.yaw);
  return [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]];
}
function dirToLocal(v: V3, at: Placement): [number, number, number] {
  const c = Math.cos(at.yaw);
  const s = Math.sin(at.yaw);
  return [c * v[0] - s * v[2], v[1], s * v[0] + c * v[2]];
}
/** The figure's own frame → world. */
export function toWorld(p: V3, at: Placement): [number, number, number] {
  const c = Math.cos(at.yaw);
  const s = Math.sin(at.yaw);
  return [at.place[0] + c * p[0] + s * p[2], at.place[1] + p[1], at.place[2] - s * p[0] + c * p[2]];
}

// ── The arm solver ──

function boneIndex(bones: readonly Bone[], name: string): number {
  const bone = bones.find((b) => b.name === name);
  if (bone === undefined) throw new Error(`hands: the rig has no bone "${name}" (rebuild the GLB: hands.py adds the fingers, T1419b).`);
  return bone.index;
}

/** A bone's world rotation and translation (figure-local): the kernel's walk, twelve deep. */
function transform(bones: readonly Bone[], pose: Pose, index: number): { m: ReturnType<typeof eulerMatrix>; t: [number, number, number] } {
  let m = eulerMatrix([0, 0, 0]);
  let t: [number, number, number] = [0, 0, 0];
  let j = index;
  for (let level = 0; level < 12 && j >= 0; level++) {
    const bone = bones[j]!;
    const r = eulerMatrix(pose[boneParam(bone)] ?? [0, 0, 0]);
    m = mul(r, m);
    t = add(apply(r, sub(t, bone.head)), bone.head);
    j = bone.parent;
  }
  return { m, t };
}

/** What a solved hand should do, in WORLD terms: where the wrist is, where the fingers point, which way the palm faces. */
export interface ArmGoal {
  readonly wrist: V3;
  readonly point: V3;
  readonly palm: V3;
  /** Optional: where the elbow should hang (keeps the elbow down and out of the frame). */
  readonly elbow?: V3;
}

const ARM_KNOBS = ["upperarm", "forearm", "hand"] as const;

function nelderMead(f: (x: number[]) => number, start: number[], step: number, iterations: number): { x: number[]; value: number } {
  const n = start.length;
  let simplex = [start.slice()];
  for (let i = 0; i < n; i++) {
    const p = start.slice();
    p[i] = p[i]! + step;
    simplex.push(p);
  }
  let values = simplex.map(f);
  for (let it = 0; it < iterations; it++) {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    simplex = order.map((i) => simplex[i]!);
    values = order.map((i) => values[i]!);
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) centroid[k] = centroid[k]! + simplex[i]![k]! / n;
    const worst = simplex[n]!;
    const along = (k: number): number[] => centroid.map((c, i) => c + k * (worst[i]! - c));
    const reflected = along(-1);
    const fr = f(reflected);
    if (fr < values[0]!) {
      const expanded = along(-2);
      const fe = f(expanded);
      if (fe < fr) { simplex[n] = expanded; values[n] = fe; } else { simplex[n] = reflected; values[n] = fr; }
    } else if (fr < values[n - 1]!) {
      simplex[n] = reflected; values[n] = fr;
    } else {
      const contracted = along(0.5);
      const fc = f(contracted);
      if (fc < values[n]!) { simplex[n] = contracted; values[n] = fc; } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i]!.map((v, k) => simplex[0]![k]! + 0.5 * (v - simplex[0]![k]!));
          values[i] = f(simplex[i]!);
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best]!, value: values[best]! };
}

/**
 * Solve one arm: upper arm, forearm and hand Euler knobs (radians about the rest axes) so the
 * wrist sits on `goal.wrist`, the middle finger's base points along `goal.point` and the palm
 * faces `goal.palm` — all world, turned into the figure's frame by `at`. The forearm is kept
 * near a hinge (its twist is the hand's job) and every angle is lightly held toward zero.
 */
export function solveArm(bones: readonly Bone[], side: Side, goal: ArmGoal, at: Placement, base: Pose = {}): Pose {
  const upper = boneIndex(bones, `upperarm.${side}`);
  const fore = boneIndex(bones, `forearm.${side}`);
  const hand = boneIndex(bones, `hand.${side}`);
  const handHead = bones[hand]!.head;
  const middle = bones[boneIndex(bones, `middle1.${side}`)]!.head;
  const restAlong = unit(sub(middle, handHead));
  const restPalmDir = restPalm(bones, side);
  const wrist = toLocal(goal.wrist, at);
  const point = unit(dirToLocal(goal.point, at));
  const palm = unit(dirToLocal(goal.palm, at));
  const elbow = goal.elbow === undefined ? undefined : toLocal(goal.elbow, at);
  const elbowHead = bones[fore]!.head;
  const shoulderHead = bones[upper]!.head;
  const knob = (name: string): string => `${name}${side}`;
  const poseOf = (x: number[]): Pose => {
    const pose: Record<string, Vec3> = { ...base };
    ARM_KNOBS.forEach((name, i) => { pose[knob(name)] = [x[i * 3]!, x[i * 3 + 1]!, x[i * 3 + 2]!]; });
    return pose;
  };
  const loss = (x: number[]): number => {
    const pose = poseOf(x);
    const h = transform(bones, pose, hand);
    const w = add(apply(h.m, handHead), h.t);
    const e = transform(bones, pose, upper);
    const el = add(apply(e.m, elbowHead), e.t);
    const a = apply(h.m, restAlong);
    const n = apply(h.m, restPalmDir);
    const dw = sub(w, wrist);
    let value = 2000 * dot(dw, dw) + 1.2 * (1 - dot(a, point)) + 0.8 * (1 - dot(n, palm));
    // the elbow only flexes: the forearm bends toward the upper arm's FRONT (its rest +Z)
    const u = unit(sub(el, add(apply(e.m, shoulderHead), e.t)));
    const f = unit(sub(w, el));
    const bend = sub(f, [u[0] * dot(u, f), u[1] * dot(u, f), u[2] * dot(u, f)]);
    const bendLength = Math.hypot(bend[0], bend[1], bend[2]);
    if (bendLength > 0.05) value += 3 * Math.max(0, -dot(bend, apply(e.m, [0, 0, 1])) / bendLength) ** 2;
    if (elbow !== undefined) {
      const de = sub(el, elbow);
      value += 40 * dot(de, de);
    }
    // the hand bends at the wrist, but not like rubber: past ~70 degrees it costs
    const handBend = Math.hypot(x[6]!, x[7]!, x[8]!);
    value += 0.4 * Math.max(0, handBend - 1.2) ** 2;
    for (const v of x) value += 0.002 * v * v;
    return value;
  };
  let best = { x: new Array<number>(9).fill(0), value: Infinity };
  // a few starts: rest, and arms lifted forward and to the side
  const starts = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [-1.2, 0, 0, -1.2, 0, 0, 0, 0, 0],
    [-0.6, 0.8, side === "L" ? 0.6 : -0.6, -1.8, 0, 0, 0, 0, 0],
    [-1.5, -0.5, side === "L" ? 0.8 : -0.8, -1.0, 0.5, 0, 0, 0, 0],
  ];
  for (const start of starts) {
    let run = nelderMead(loss, start, 0.4, 1500);
    run = nelderMead(loss, run.x, 0.08, 1500);
    if (run.value < best.value) best = run;
  }
  const solved = poseOf(best.x);
  {
    // fail loud: a goal the arm cannot reach is a staging error, not a pose
    const h = transform(bones, solved, hand);
    const miss = Math.hypot(...sub(add(apply(h.m, handHead), h.t), wrist));
    if (miss > 0.025) console.warn(`hands: the ${side} wrist misses its goal by ${(miss * 100).toFixed(1)} cm (move the figure or the goal).`);
  }
  const out: Pose = {};
  for (const name of ARM_KNOBS) out[knob(name)] = solved[knob(name)]!;
  return out;
}

/** A posed hand's pointing direction and palm normal (world), for checking a solve. */
export function handAxes(bones: readonly Bone[], side: Side, pose: Pose, at: Placement): { point: [number, number, number]; palm: [number, number, number] } {
  const hand = boneIndex(bones, `hand.${side}`);
  const h = transform(bones, pose, hand);
  const along = unit(sub(bones[boneIndex(bones, `middle1.${side}`)]!.head, bones[hand]!.head));
  const turn = (v: V3): [number, number, number] => sub(toWorld(v, at), toWorld([0, 0, 0], at));
  return { point: turn(apply(h.m, along)), palm: turn(apply(h.m, restPalm(bones, side))) };
}

/**
 * THE PISTOL HAND as knob expressions, for any shot (T1407b hands; the prism's 0:29 too): the
 * right arm solved so the wrist sits at `goal.wrist` with the pistol's barrel along `goal.point`
 * and the palm facing `goal.palm` — all in the FIGURE'S OWN frame (it faces +Z, its left is +X)
 * — and the hand closed round the grip (PISTOL_GRIP). Draw the prop with figureNodes' `gun`.
 */
export function pistolPose(bones: readonly Bone[], goal: ArmGoal): Record<string, string> {
  return { ...fixed(solveArm(bones, "R", goal, { place: [0, 0, 0], yaw: 0 })), ...handPose("R", PISTOL_GRIP) };
}

/** Where a posed hand's wrist ends up (world), for checking a solve. */
export function wristOf(bones: readonly Bone[], side: Side, pose: Pose, at: Placement): [number, number, number] {
  const hand = boneIndex(bones, `hand.${side}`);
  const h = transform(bones, pose, hand);
  return toWorld(add(apply(h.m, bones[hand]!.head), h.t), at);
}

// ── Expressions ──

/** 0 before `t0`, 1 after `t1`, eased between (shot time). */
const ease = (t0: number, t1: number): string => `smoothstep(${num(t0)}, ${num(t1)}, abstime)`;

/** Blend two poses' knobs by an expression k (0 = a, 1 = b); a knob only one side has blends from 0. */
function blendPoses(a: Pose, b: Pose, k: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[name] ?? [0, 0, 0];
    const vb = b[name] ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const axis = `${name}.${"xyz"[i]}`;
      out[axis] = Math.abs(vb[i]! - va[i]!) < 1e-6 ? num(va[i]!) : `${num(va[i]!)} + ${num(vb[i]! - va[i]!)} * ${k}`;
    }
  }
  return out;
}

function fixed(pose: Pose): Record<string, string> {
  return blendPoses(pose, pose, "0");
}

/** Add an expression onto a knob axis that may already hold one. */
function nudge(pose: Record<string, string>, axis: string, expression: string): void {
  pose[axis] = pose[axis] === undefined ? expression : `${pose[axis]} + ${expression}`;
}

/** A small tremor: three incommensurate sines, amplitude `size` radians. */
const tremor = (size: number, phase: number): string =>
  `(sin(abstime * 5.3 + ${phase}) * 0.5 + sin(abstime * 8.9 + ${(phase * 1.7).toFixed(3)}) * 0.3 + sin(abstime * 13.1 + ${(phase * 2.3).toFixed(3)}) * 0.2) * ${size}`;

/**
 * A TELE HANDHELD with JOLTS: the eye and the aim wander (three incommensurate sines per axis),
 * the horizon rolls and drifts, and on top every axis takes short, sharp knocks — a raised
 * sine to a high power, so most of the time it is still and now and then it snaps and settles.
 * `size` is the wander in metres, `jolt` the knocks' size (metres at the aim), `roll` degrees.
 */
function teleHandheld(eye: V3, aim: V3, size: number, jolt: number, roll: { readonly start: number; readonly lean: number; readonly wander: number }, drift: V3 = [0, 0, 0]): Record<string, StoredParameter> {
  const wob = (a: number, b: number, c: number, phase: number): string =>
    `(sin(abstime * ${a} + ${phase}) * 0.5 + sin(abstime * ${b} + ${(phase * 1.7).toFixed(3)}) * 0.3 + sin(abstime * ${c} + ${(phase * 2.3).toFixed(3)}) * 0.2)`;
  // knocks: sin^12 of a slow phase is a narrow spike; two of them at unrelated rates
  const knock = (rate: number, phase: number): string => `(sin(abstime * ${rate} + ${phase}) ^ 12)`;
  const axis = (base: number, d: number, k: number, phase: number, freq: readonly [number, number, number], j: number): StoredParameter =>
    expressionSlot(`${num(base)} + abstime * ${num(d)} + ${wob(freq[0], freq[1], freq[2], phase)} * ${num(size * k)} + (${knock(4.1, phase)} - ${knock(6.7, phase + 1.3)}) * ${num(jolt * j)}`, base);
  return {
    "eye.x": axis(eye[0], drift[0], 1, 0.3, [0.9, 2.3, 5.1], 0.3),
    "eye.y": axis(eye[1], drift[1], 0.7, 1.1, [1.3, 3.1, 6.7], 0.4),
    "eye.z": axis(eye[2], drift[2], 0.6, 2.2, [0.7, 1.7, 4.3], 0.2),
    "lookAt.x": axis(aim[0], drift[0], 1.4, 2.0, [0.7, 1.9, 4.3], 1),
    "lookAt.y": axis(aim[1], drift[1], 1.2, 2.7, [0.8, 2.1, 4.9], 0.8),
    "lookAt.z": axis(aim[2], drift[2], 0.8, 0.4, [0.6, 1.5, 3.7], 0.3),
    roll: expressionSlot(`${num(roll.start)} + abstime * ${num(roll.lean)} + ${wob(0.5, 1.4, 3.3, 0.9)} * ${num(roll.wander)} + ${knock(4.1, 0.3)} * ${num(roll.wander * 0.8)}`, roll.start),
  };
}

// ── The picture's extras ──

/**
 * BOKEH LAMPS: small bright sources out of the set (sodium practicals, far LEDs), drawn as round
 * faces of HDR radiance where nothing nearer covers them, so the thin-lens depth of field spreads
 * each into a disc. Input = the picture; More = [depth]. The lamps are baked in (world, radius,
 * colour × radiance).
 */
function bokehWgsl(lamps: readonly { readonly at: V3; readonly radius: number; readonly color: V3 }[]): string {
  const count = Math.max(1, lamps.length);
  const list = (f: (lamp: (typeof lamps)[number]) => string): string => (lamps.length === 0 ? "vec4f(0.0)" : lamps.map(f).join(", "));
  return `struct Params {
${CAMERA_PARAMS}
  gain: f32, // @default 1  Every lamp's radiance.
  flicker: f32, // @default 0  How much the lamps breathe (0 = steady).
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
${VIEW}
const LAMPS: u32 = ${lamps.length}u;
const LAMP_AT = array<vec4f, ${count}>(${list((l) => `vec4f(${l.at.map((v) => v.toFixed(4)).join(", ")}, ${l.radius.toFixed(4)})`)});
const LAMP_RGB = array<vec4f, ${count}>(${list((l) => `vec4f(${l.color.map((v) => v.toFixed(4)).join(", ")}, 0.0)`)});

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let v = makeView();
  let ray = rayAt(v, uv);
  let z = viewDepth(uv);
  var add = vec3f(0.0);
  for (var i = 0u; i < LAMPS; i = i + 1u) {
    let rel = LAMP_AT[i].xyz - params.eye;
    let along = dot(rel, ray);
    if (along <= 0.0) { continue; }
    let lampZ = dot(rel, v.forward);
    if (z > 0.0 && z < lampZ) { continue; }
    let miss = length(rel - ray * along);
    let r = LAMP_AT[i].w;
    let face = 1.0 - smoothstep(r * 0.8, r, miss);
    let breathe = 1.0 + params.flicker * sin(frameU.absTime * (7.0 + f32(i) * 1.3) + f32(i) * 2.1);
    add = add + LAMP_RGB[i].rgb * face * breathe;
  }
  return vec4f(base.rgb + add * params.gain, base.a);
}`;
}

/**
 * A RAINBOW FLARE ARC (the reference's 1:00.4): the out-of-focus ghost of a source far off the
 * frame — a thin ring much larger than the frame, centred off it, so only an arc crosses the
 * picture, its colours split (red outside), with a faint veil inside it. Input = the picture.
 */
const FLARE_ARC_WGSL = `struct Params {
  centre: vec2f, // @default 0  The ring's centre, frame units (0..1 across the frame; may lie outside it).
  radius: f32, // @default 0.8  Its radius, frame heights.
  width: f32, // @default 0.03  Width of each colour's band, frame heights.
  split: f32, // @default 0.035  How far apart red and blue sit, frame heights.
  gain: f32, // @default 0.6  Brightness.
  veil: f32, // @default 0.05  The haze inside the ring.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

fn band(d: f32, r: f32, w: f32) -> f32 {
  return exp(-pow((d - r) / w, 2.0));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let d = length((uv - params.centre) * vec2f(aspect, 1.0));
  let r = params.radius;
  let s = params.split;
  let w = params.width;
  let rgb = vec3f(band(d, r + s, w), band(d, r, w) * 0.9 + band(d, r + s * 0.5, w) * 0.4, band(d, r - s, w) * 1.1);
  let veil = (1.0 - smoothstep(r - w * 2.0, r, d)) * params.veil;
  return vec4f(base.rgb + (rgb * vec3f(1.0, 0.85, 1.0) + vec3f(veil * 0.8, veil * 0.9, veil)) * params.gain, base.a);
}`;

// ── Takes ──

interface Light {
  readonly at: V3;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
}

interface Take {
  /** The EDL row (and part) this take plays. */
  readonly row: string;
  readonly set: "warehouse" | "void" | "cyc";
  readonly placement: Placement;
  /** The figure's pose: skin-kernel knob axes → expressions (hand knobs included). */
  readonly pose: (bones: readonly Bone[]) => Record<string, string>;
  readonly eye: V3;
  readonly aim: V3;
  readonly focal: number;
  readonly fstop: number;
  /** Focus distance, metres (an expression may rack it). */
  readonly focus: number | string;
  readonly camera: { readonly size: number; readonly jolt: number; readonly roll: { readonly start: number; readonly lean: number; readonly wander: number }; readonly drift?: V3 };
  readonly lights: readonly Light[];
  readonly bokeh?: readonly { readonly at: V3; readonly radius: number; readonly color: V3 }[];
  /** Headlights in the haze (warehouse sets). */
  readonly haze?: number;
  /** `sharp`: the glass smears the bright pass itself, not its softened glow — thin columns from small lamps. */
  readonly streak: { readonly from: number; readonly to: number; readonly threshold: number; readonly gain: number; readonly sharp?: boolean };
  readonly flare?: { readonly centre: readonly [number, number]; readonly drift: readonly [number, number]; readonly radius: number; readonly gain: number | string; readonly veil?: number | string };
  /** Shot-time spans the key lights are out (a strobe). */
  readonly strobe?: readonly (readonly [number, number])[];
  /** The figure holds the pistol (the `figgun` area). */
  readonly gun?: boolean;
  /** When the pistol is in the hand: an expression, 1 = held, 0 = away (default: always). */
  readonly gunShow?: string;
  /** Which body wears the ice: the clothed `figbody` (default) or the shirtless `figbare`. */
  readonly body?: "figbody" | "figbare";
  /**
   * LAYERS (row 17c): one posed figure seen by several cameras, each layer its own Render, laid
   * over black by LIGHTEN (the brighter wins), each cut in whole at its shot time. The take's
   * eye and aim frame the first layer; a layer names where the HAND sits in its frame (u, v in
   * −1..1, v up) and the frame's roll. Depth-of-field and the depth passes are skipped.
   */
  readonly layers?: readonly { readonly at: number; readonly hand: V3; readonly roll: number; readonly u: number; readonly v: number; readonly distance: number }[];
  readonly grade: Record<string, StoredParameter>;
  readonly lensFx?: Record<string, StoredParameter>;
  readonly cars?: readonly number[];
  /** The studio's brightness in the reflections (1 = the close-ups'), and the Render's IBL gain. */
  readonly studio?: number;
  readonly environment?: number;
}

const COOL: [number, number, number] = [0.86, 0.94, 1];
const SODIUM: [number, number, number] = [1, 0.5, 0.17];

/** The stage the figure stands on for the tableau cut-ins: in front of the parked row, facing the lens. */
const TABLEAU_FIGURE: Placement = { place: [0, 0, 3.74], yaw: 0 };
/** Row 54: further in front of the parked row than the tableau's mark, so the lamps sit small and low. */
const FAR_FIGURE: Placement = { place: [0, 0, 6.5], yaw: 0 };
/** Row 47: in the void, facing +X — the head in profile to a lens on +Z, the right hand on the lens's side. */
const PROFILE_FIGURE: Placement = { place: [-60, 0, 0], yaw: Math.PI / 2 };
/** Row 3: beside the white car's (car1) left headlight, facing across its nose (−X). */
const CAR1_FIGURE: Placement = { place: [-1.84, 0, 1.42], yaw: -Math.PI / 2 };

const armsDown = (): Record<string, string> => ({ "upperarmL.z": "-0.62", "upperarmR.z": "0.62", "forearmL.x": "-0.2", "forearmR.x": "-0.2" });

function fingers(side: Side, pose: HandPose): Record<string, string> {
  return handPose(side, pose);
}

/** The grade the dark close-ups share: blacks crushed, mids desaturated, cold upper mids. */
const DARK_GRADE = (width: number, extra: Record<string, StoredParameter> = {}): Record<string, StoredParameter> => ({
  exposure: 0.1, black: 0.03, contrast: 1.18, saturation: 0.6, keepWarm: 0.85, bleach: 0.3,
  highlightTint: [0.96, 1.01, 1.04, 1], shadowTint: [0.93, 1.02, 1.06, 1], split: 0.5, grain: 0.045, grainSize: 1.3 * (width / 1920), ...extra,
});

function takes(width: number): readonly Take[] {
  return [
    // ── take 0 · row 3 (0:02.34): a ringed right hand points down past the white car's LED
    // headlight; the car's front soft behind, the figure's black torso at the frame's right.
    {
      row: "3",
      set: "warehouse",
      cars: [0, 1],
      placement: CAR1_FIGURE,
      pose: (bones) => {
        const a = solveArm(bones, "R", { wrist: [-2.17, 1.0, 1.29], point: [-0.55, -0.8, 0.1], palm: [0.1, -0.5, -0.85], elbow: [-1.98, 1.1, 1.24] }, CAR1_FIGURE);
        const b = solveArm(bones, "R", { wrist: [-2.2, 0.98, 1.29], point: [-0.65, -0.72, 0.12], palm: [0.1, -0.5, -0.85], elbow: [-2.0, 1.09, 1.24] }, CAR1_FIGURE);
        const pose = { ...armsDown(), ...blendPoses(a, b, ease(0, 0.33)), ...fingers("R", { curl: 1.3, point: 0.95, thumb: 1.0, spread: 0.05, extra: [0, 0, 0.1, 0.2] }), ...fingers("L", { curl: 0.5 }) };
        nudge(pose, "handR.x", tremor(0.03, 0.4));
        nudge(pose, "chest.y", "-0.15");
        return pose;
      },
      eye: [-2.02, 1.0, 2.9],
      aim: [-2.36, 0.8, 0.0],
      focal: 85,
      fstop: 2.4,
      focus: 1.55,
      camera: { size: 0.006, jolt: 0.012, roll: { start: -6, lean: 4, wander: 1.5 } },
      lights: [
        { at: [-1.6, 1.5, 2.7], color: COOL, intensity: 1.8 },
        { at: [-2.9, 1.3, 2.3], color: COOL, intensity: 1.2 },
      ],
      haze: 0.02,
      streak: { from: 0.35, to: 0.45, threshold: 8, gain: 0.45 },
      grade: DARK_GRADE(width, { exposure: 0.35, saturation: 0.5 }),
    },
    // ── takes 1, 2 · row 12 parts b and d (0:09.76, 0:09.93) "MCU ringed fists and watches": both
    // fists up either side of the face, backs to the lens, a thumb out, the watches at the wrists,
    // the parked row's headlights low behind with their columns. The key STROBES in part d: its
    // second and third frames go dark while the headlights burn on.
    fistsTake(width, "12b", []),
    fistsTake(width, "12d", [[0.5 / 24, 2.5 / 24]]),
    // ── take 3 · row 12 parts a and c: the strobe's WIDE, the tableau from the front, the figure
    // flipping off, lit white.
    {
      row: "12a",
      set: "warehouse",
      cars: [0, 1, 2, 3, 4],
      placement: TABLEAU_FIGURE,
      pose: (bones) => {
        const at = TABLEAU_FIGURE;
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const left = solveArm(bones, "L", { wrist: w([0.14, 1.5, 0.22]), point: [-0.1, 1, 0.1], palm: [0, 0, -1], elbow: w([0.3, 1.2, 0.15]) }, at);
        const right = solveArm(bones, "R", { wrist: w([-0.16, 1.46, 0.24]), point: [0.12, 1, 0.1], palm: [0, 0, -1], elbow: w([-0.32, 1.18, 0.15]) }, at);
        return { ...fixed({ ...left, ...right }), ...fingers("L", { curl: 1.45, flip: 1, thumb: 0.7 }), ...fingers("R", { curl: 1.45, flip: 1, thumb: 0.7 }) };
      },
      eye: [0.05, 1.2, 5.75],
      aim: [0.0, 1.25, 2.0],
      focal: 24,
      fstop: 2.8,
      focus: 2.0,
      camera: { size: 0.02, jolt: 0.02, roll: { start: 0.5, lean: 0, wander: 0.6 } },
      lights: [
        { at: [0.6, 2.0, 5.2], color: COOL, intensity: 4 },
        { at: [-0.8, 1.4, 5.0], color: COOL, intensity: 1.5 },
        { at: [-2.4, 2.4, 2.2], color: COOL, intensity: 3 },
        { at: [2.6, 2.4, 2.2], color: COOL, intensity: 3 },
      ],
      haze: 0.035,
      streak: { from: 0.5, to: 0.55, threshold: 8, gain: 0.32 },
      grade: DARK_GRADE(width, { exposure: 0.45 }),
    },
    // ── take 4 · row 18 part a (0:17.39, two frames): a blown flare over the face, a red hotspot.
    { ...shhTake(width), row: "18a", flare: { centre: [0.85, 0.5], drift: [0, 0], radius: 0.78, gain: 1.0, veil: 1.6 }, grade: DARK_GRADE(width, { exposure: 0.9, saturation: 0.55, keepWarm: 1 }) },
    // ── take 5 · row 18 part b (0:17.48) "finger to lips, red bokeh".
    shhTake(width),
    // ── take 6 · row 18 part c (0:17.68–18.39) "pistol by sunglasses, sodium bokeh": three-quarter
    // profile, the hand holding the pistol up beside the glasses, the rings low in the frame, warm
    // sodium bokeh stacked beyond the face.
    {
      row: "18c",
      set: "void",
      gun: true,
      placement: { place: [-60, 0, 0], yaw: 0.9 },
      pose: (bones) => {
        const at: Placement = { place: [-60, 0, 0], yaw: 0.9 };
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const right = solveArm(bones, "R", { wrist: w([-0.1, 1.5, 0.2]), point: dirToWorld([0.05, 1, 0.1], at), palm: dirToWorld([1, 0, 0.1], at), elbow: w([-0.26, 1.2, 0.12]) }, at);
        const pose = { ...fixed(right), "upperarmL.z": "-0.62", "forearmL.x": "-0.2", ...fingers("R", PISTOL_GRIP) };
        nudge(pose, "neck.y", "-0.2");
        nudge(pose, "head.x", tremor(0.015, 0.8));
        nudge(pose, "forearmR.x", tremor(0.02, 2.1));
        return pose;
      },
      eye: [-59.36, 1.64, 1.27],
      aim: [-59.99, 1.6, 0.05],
      focal: 70,
      fstop: 2,
      focus: 1.22,
      camera: { size: 0.004, jolt: 0.008, roll: { start: -2, lean: 1, wander: 1 }, drift: [0.012, 0, 0] },
      lights: [
        { at: [-59.2, 2.0, 1.0], color: COOL, intensity: 1.6 },
        { at: [-60.6, 1.7, -0.5], color: SODIUM, intensity: 0.5 },
      ],
      bokeh: [
        { at: [-60.75, 1.75, -1.9], radius: 0.035, color: [26, 17, 8] },
        { at: [-60.65, 1.55, -2.1], radius: 0.035, color: [30, 20, 9] },
        { at: [-60.8, 1.35, -2.0], radius: 0.035, color: [22, 15, 7] },
        { at: [-60.55, 1.95, -2.4], radius: 0.035, color: [20, 14, 7] },
        { at: [-60.9, 1.15, -1.8], radius: 0.04, color: [40, 38, 34] },
        { at: [-61.1, 1.6, -1.6], radius: 0.03, color: [24, 16, 7] },
      ],
      streak: { from: 0.2, to: 0.28, threshold: 10, gain: 0.3 },
      grade: DARK_GRADE(width, { exposure: 0.1, saturation: 0.75, keepWarm: 1 }),
    },
    // ── take 7 · row 33 part b (0:33.99) "top-down: cap, hands over the face": from above and in
    // front, the head bowed, both hands spread over the face with their backs up, rings on the
    // hands, the watch and the Cuban at the wrist, a streak falling over the cap.
    {
      row: "33b",
      set: "void",
      placement: { place: [-60, 0, 0], yaw: 0 },
      pose: (bones) => {
        const at: Placement = { place: [-60, 0, 0], yaw: 0 };
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const left = solveArm(bones, "L", { wrist: w([0.06, 1.55, 0.22]), point: [0.08, 1, -0.1], palm: [0, 0, -1], elbow: w([0.2, 1.28, 0.14]) }, at);
        const right = solveArm(bones, "R", { wrist: w([-0.06, 1.55, 0.22]), point: [-0.08, 1, -0.1], palm: [0, 0, -1], elbow: w([-0.2, 1.28, 0.14]) }, at);
        const pose = { ...fixed({ ...left, ...right }), ...fingers("L", { curl: 0.06, thumb: 0.1 }), ...fingers("R", { curl: 0.06, thumb: 0.1 }) };
        // bowed: a POSITIVE x tips the head forward (the prism's negative one tips it back)
        nudge(pose, "neck.x", "0.4");
        nudge(pose, "head.x", "0.3");
        // the reference's fingers creep a little as he presses: a slow curl over the cut
        nudge(pose, "curlL.x", "0.06 * smoothstep(0, 0.58, abstime)");
        nudge(pose, "curlR.x", "0.06 * smoothstep(0, 0.58, abstime)");
        return pose;
      },
      eye: [-60.0, 2.35, 0.6],
      aim: [-60.0, 1.58, 0.12],
      focal: 45,
      fstop: 2.8,
      focus: 0.8,
      camera: { size: 0.003, jolt: 0.005, roll: { start: 0, lean: 0, wander: 0.5 } },
      lights: [
        { at: [-60.0, 2.6, 0.9], color: COOL, intensity: 1.6 },
        { at: [-60.1, 2.5, -0.2], color: COOL, intensity: 0.8 },
        { at: [-60.6, 2.0, 0.2], color: COOL, intensity: 0.3 },
      ],
      streak: { from: 0.4, to: 0.45, threshold: 3, gain: 0.35 },
      grade: DARK_GRADE(width, { exposure: 0.1, saturation: 0.35, keepWarm: 0.3 }),
    },
    // ── take 8 · row 60 (0:58.60) "CU of the chain and a watch, with bokeh" (T1407b closeups2)
    chainWatchTake(width),
    // ── take 9 · row 16 part a (0:13.14, 13 frames) "pistol pointed into the lens, tubes": shirtless,
    // the pistol held out at the lens, the parked row's headlights low behind in their columns;
    // frames 5-10 cut to the other hand's middle finger up, the pistol hanging in the right.
    {
      row: "16a",
      set: "warehouse",
      cars: [0, 1, 2, 3, 4],
      body: "figbare",
      gun: true,
      placement: TABLEAU_FIGURE,
      pose: (bones) => {
        const at = TABLEAU_FIGURE;
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const aim = solveArm(bones, "R", { wrist: w([-0.03, 1.27, 0.44]), point: [0.04, 0.03, 1], palm: [1, 0, 0.05], elbow: w([-0.18, 1.14, 0.2]) }, at);
        const low = solveArm(bones, "R", { wrist: w([-0.24, 1.0, 0.3]), point: [0.1, -1, 0.3], palm: [1, 0, 0.1], elbow: w([-0.27, 1.2, 0.1]) }, at);
        const flip = solveArm(bones, "L", { wrist: w([0.07, 1.13, 0.44]), point: [-0.05, 1, 0.2], palm: [0, 0.1, -1], elbow: w([0.2, 1.0, 0.25]) }, at);
        const a = { ...armsDown(), ...fixed(aim), ...fingers("R", PISTOL_GRIP), ...fingers("L", { curl: 0.5 }) };
        const b = { ...armsDown(), ...fixed({ ...low, ...flip }), ...fingers("R", PISTOL_GRIP), ...fingers("L", { curl: 1.45, flip: 1, thumb: 0.8, extra: [0, 0, 0.05, 0.1] }) };
        const pose = switchPoses(a, b, span(4 / 24, 10 / 24));
        nudge(pose, "forearmR.x", tremor(0.03, 0.6));
        nudge(pose, "neck.x", "0.1");
        return pose;
      },
      eye: [0.06, 1.3, 4.68],
      aim: [0.02, 1.24, 3.74],
      focal: 28,
      fstop: 2.2,
      focus: 0.38,
      camera: { size: 0.008, jolt: 0.015, roll: { start: -1.5, lean: 2, wander: 1.2 } },
      lights: [
        { at: [0.35, 1.45, 4.75], color: COOL, intensity: 0.9 },
        { at: [-0.5, 1.2, 4.6], color: COOL, intensity: 0.3 },
      ],
      haze: 0.035,
      streak: { from: 0.5, to: 0.55, threshold: 8, gain: 0.5 },
      grade: DARK_GRADE(width, { exposure: -0.1, saturation: 0.35, keepWarm: 0.3 }),
      environment: 0.15,
    },
    // ── take 10 · row 16 part c (0:13.85, 14 frames) "ringed hand and pendant over the bare torso":
    // the right hand hanging over the belly, rings across the fingers, the watch at the wrist; a
    // strobe blacks frames 1-2 and 9; from frame 10 the hand rests on the pistol at the waistband.
    {
      row: "16c",
      set: "warehouse",
      cars: [0, 1, 2, 3, 4],
      body: "figbare",
      gun: true,
      gunShow: span(9 / 24, 1),
      placement: TABLEAU_FIGURE,
      pose: (bones) => {
        const at = TABLEAU_FIGURE;
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const hang = solveArm(bones, "R", { wrist: w([-0.03, 1.13, 0.24]), point: [0.12, -1, 0.1], palm: [0, 0.1, -1], elbow: w([-0.22, 1.12, 0.05]) }, at);
        const grip = solveArm(bones, "R", { wrist: w([-0.07, 1.06, 0.22]), point: [0.05, -1, 0.1], palm: [1, 0, -0.2], elbow: w([-0.24, 1.1, 0.02]) }, at);
        const a = { ...armsDown(), ...fixed(hang), ...fingers("R", { curl: 0.3, spread: 0.12, thumb: 0.3, extra: [0, 0.05, 0.1, 0.2] }) };
        const b = { ...armsDown(), ...fixed(grip), ...fingers("R", PISTOL_GRIP) };
        const pose = switchPoses(a, b, span(9 / 24, 1));
        nudge(pose, "forearmR.x", tremor(0.03, 1.1));
        nudge(pose, "pelvis.y", "sin(abstime * 2.4) * 0.03");
        return pose;
      },
      eye: [0.04, 1.13, 4.52],
      aim: [0.0, 1.07, 3.74],
      focal: 32,
      fstop: 2.4,
      focus: 0.56,
      camera: { size: 0.006, jolt: 0.012, roll: { start: 1.5, lean: -1.5, wander: 1 } },
      lights: [
        { at: [0.3, 1.35, 4.45], color: COOL, intensity: 0.8 },
        { at: [-0.5, 1.0, 4.4], color: COOL, intensity: 0.25 },
      ],
      strobe: [[0, 2 / 24], [8 / 24, 9 / 24]],
      haze: 0.035,
      streak: { from: 0.5, to: 0.55, threshold: 8, gain: 0.5 },
      grade: DARK_GRADE(width, { exposure: -0.1, saturation: 0.35, keepWarm: 0.3 }),
      environment: 0.15,
    },
    // ── take 11 · row 17 part c (0:16.52, 21 frames) "CU hands and watches, pistol gesture": the
    // reference stacks five takes of an arm, a watch and a pistol over black, each cut in whole on
    // its frame (f396, f402, f406, f410, f413: docs/on-nothing-reactivity-2026-09-27.md) and
    // laid over the others by lighten. One posed arm (straight out, the pistol along it), five
    // cameras: up from the bottom, hanging from the top right, hanging from the top left, in from
    // the right, in from the left.
    armLayersTake(width),
    // ── take 12 · row 47 (0:47.46, frames 1138-1145) "CU of a ringed hand, dark": a tele from the
    // side, the head in profile bowed to the right, the ringed hand spread close to the lens and
    // soft, the chain sharp at the shoulder; warm bokeh high, a white one right; the last frame
    // (1145) is a strobe gone dark.
    {
      row: "47",
      set: "void",
      placement: PROFILE_FIGURE,
      pose: (bones) => {
        const at = PROFILE_FIGURE;
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        // the hand spread over the side and back of the bowed head on the lens's side, its back to
        // the lens and nearer it than the chain, so the tele's thin focus leaves it soft
        const right = solveArm(bones, "R", { wrist: w([-0.19, 1.5, -0.1]), point: dirToWorld([-0.1, 1, -0.2], at), palm: dirToWorld([1, 0, 0], at), elbow: w([-0.34, 1.28, -0.12]) }, at);
        const pose = { "upperarmL.z": "-0.62", "forearmL.x": "-0.2", ...fixed(right), ...fingers("R", { curl: 0.12, spread: 0.22, thumb: 0.1, extra: [0, 0.05, 0.1, 0.15] }) };
        nudge(pose, "neck.x", "0.5");
        nudge(pose, "neck.z", "-0.15");
        nudge(pose, "head.x", "0.35");
        // the hand drifts toward the lens over the cut
        nudge(pose, "forearmR.x", `-0.08 * smoothstep(0, 0.33, abstime) + ${tremor(0.02, 0.7)}`);
        return pose;
      },
      eye: [-60.02, 1.6, 1.3],
      aim: [-59.97, 1.58, 0.0],
      focal: 85,
      fstop: 1.4,
      focus: 1.27,
      camera: { size: 0.004, jolt: 0.012, roll: { start: -8, lean: -3, wander: 1.2 } },
      lights: [
        { at: [-60.6, 1.9, 1.3], color: COOL, intensity: 1.4 },
        { at: [-59.5, 2.0, -0.55], color: COOL, intensity: 0.8 },
        { at: [-59.6, 2.1, -1.2], color: SODIUM, intensity: 0.3 },
      ],
      strobe: [[6.5 / 24, 1]],
      bokeh: [
        { at: [-59.6, 2.0, -2.0], radius: 0.06, color: [26, 15, 6] },
        { at: [-59.35, 1.92, -2.5], radius: 0.06, color: [22, 13, 5] },
        { at: [-59.05, 1.55, -2.0], radius: 0.06, color: [34, 36, 38] },
        { at: [-59.5, 1.75, -2.4], radius: 0.05, color: [18, 11, 5] },
      ],
      streak: { from: 0.2, to: 0.25, threshold: 10, gain: 0.25 },
      grade: DARK_GRADE(width, { exposure: -0.3, saturation: 0.55, keepWarm: 0.7 }),
    },
    // ── take 13 · row 54 parts c and e (0:54.14, 0:54.85) "close torso with pistol, cars low": the
    // same set-up twice — shirtless, the pistol held at the belly into the lens, the other hand
    // out beside the chest, the parked row's lamps low behind. Part c (from 0) strobes dark on its
    // 2nd and 4th frames; part e plays from 0.5 s, past the strobe.
    {
      row: "54c",
      set: "warehouse",
      cars: [0, 1, 2, 3, 4],
      body: "figbare",
      gun: true,
      placement: FAR_FIGURE,
      pose: (bones) => {
        const at = FAR_FIGURE;
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const right = solveArm(bones, "R", { wrist: w([-0.05, 1.1, 0.3]), point: [0.05, 0.12, 1], palm: [1, 0, 0.05], elbow: w([-0.22, 1.05, 0.06]) }, at);
        const left = solveArm(bones, "L", { wrist: w([0.2, 1.24, 0.3]), point: [0.25, 0.85, 0.45], palm: [0, 0, -1], elbow: w([0.28, 1.05, 0.1]) }, at);
        const pose = { ...fixed({ ...right, ...left }), ...fingers("R", PISTOL_GRIP), ...fingers("L", { curl: 1.35, flip: 1, thumbOut: 0.5, extra: [0, 0, 0.05, 0.1] }) };
        nudge(pose, "forearmL.x", tremor(0.04, 0.9));
        nudge(pose, "chest.y", "0.08 + sin(abstime * 2.1) * 0.03");
        return pose;
      },
      eye: [0.05, 1.02, 7.71],
      aim: [0.0, 1.17, 6.5],
      focal: 28,
      // stopped down: the far lamps stay small points, so their columns stay thin
      fstop: 5.6,
      focus: 0.85,
      camera: { size: 0.008, jolt: 0.015, roll: { start: 1, lean: -1, wander: 1 } },
      lights: [
        { at: [0.4, 1.5, 7.66], color: COOL, intensity: 1.2 },
        { at: [-0.5, 1.2, 7.46], color: COOL, intensity: 0.4 },
        { at: [0.0, 1.8, 5.56], color: COOL, intensity: 0.5 },
      ],
      strobe: [[0.5 / 24, 1.5 / 24], [2.5 / 24, 3.5 / 24]],
      haze: 0.02,
      // a column is as wide as its lamp, and these models' DRL strips are wide: kept short and dim
      streak: { from: 0.3, to: 0.3, threshold: 30, gain: 0.22, sharp: true },
      grade: DARK_GRADE(width, { exposure: -0.1, saturation: 0.35, keepWarm: 0.3 }),
      environment: 0.15,
    },
    // ── take 14 · row 57 (0:56.06, 30 frames) "CU of a forearm with iced bracelets, streaks": one
    // handheld tele take — the right forearm across the frame before the face, the watch and the
    // Cuban to the lens, then out of shot (the head in three-quarter, cap and glasses), back
    // across as a fist, out again; the watch's glints smeared up into streaks, a cold teal
    // spill behind. (The reference's forearm is tattooed: a UV tattoo is a proposed row.)
    {
      row: "57",
      set: "void",
      placement: { place: [-60, 0, 0], yaw: 0.55 },
      pose: (bones) => {
        const at: Placement = { place: [-60, 0, 0], yaw: 0.55 };
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const across = solveArm(bones, "R", { wrist: w([0.1, 1.58, 0.32]), point: dirToWorld([1, 0.05, 0.05], at), palm: dirToWorld([0, 0, -1], at), elbow: w([-0.26, 1.48, 0.28]) }, at);
        const down = solveArm(bones, "R", { wrist: w([-0.12, 1.1, 0.3]), point: dirToWorld([0.3, -0.3, 1], at), palm: dirToWorld([1, 0, 0], at), elbow: w([-0.26, 1.2, 0.05]) }, at);
        const a = { "upperarmL.z": "-0.62", "forearmL.x": "-0.2", ...fixed(across), ...fingers("R", { curl: 1.4, thumb: 0.8, extra: [0, 0, 0.05, 0.1] }) };
        const b = { "upperarmL.z": "-0.62", "forearmL.x": "-0.2", ...fixed(down), ...fingers("R", { curl: 1.4, thumb: 0.8 }) };
        // across (0-0.25), out (0.3-0.5), across again (0.55-0.85), out (0.9-)
        const out = `(smoothstep(0.2, 0.3, abstime) - smoothstep(0.5, 0.58, abstime) + smoothstep(0.84, 0.92, abstime))`;
        const pose = switchPoses(a, b, out);
        nudge(pose, "neck.x", "0.2");
        nudge(pose, "neck.y", "-0.25");
        nudge(pose, "head.x", tremor(0.02, 0.4));
        return pose;
      },
      eye: [-59.72, 1.6, 1.25],
      aim: [-59.95, 1.62, 0.0],
      focal: 70,
      fstop: 2,
      focus: 1.02,
      camera: { size: 0.006, jolt: 0.015, roll: { start: -3, lean: 2, wander: 1.4 } },
      lights: [
        { at: [-59.4, 2.1, 1.1], color: COOL, intensity: 1.2 },
        { at: [-60.4, 1.6, 0.9], color: COOL, intensity: 0.35 },
      ],
      bokeh: [
        { at: [-60.6, 1.9, -1.8], radius: 0.12, color: [2, 10, 11] },
        { at: [-59.4, 2.05, -2.0], radius: 0.1, color: [2, 9, 10] },
        { at: [-60.9, 1.35, -2.2], radius: 0.08, color: [1.5, 7, 8] },
      ],
      streak: { from: 0.45, to: 0.55, threshold: 2, gain: 0.7 },
      grade: DARK_GRADE(width, { exposure: 0.1, saturation: 0.5, keepWarm: 0.3 }),
    },
    // ── take 15 · row 59 (0:57.89, 17 frames), one take for all five parts (from = each part's
    // offset): hands framing the face at eye level, rings, fingers pinched (0-0.33 s, a rainbow
    // veil flashing on 0.167 and 0.292 — those parts' posts lift the blacks), then both middle
    // fingers up at the lens, near and soft (0.33 s-); a red blob low left.
    {
      row: "59",
      set: "void",
      placement: { place: [-60, 0, 0], yaw: 0 },
      pose: (bones) => {
        const at: Placement = { place: [-60, 0, 0], yaw: 0 };
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const frameL = solveArm(bones, "L", { wrist: w([0.15, 1.5, 0.24]), point: [-0.35, 1, 0.1], palm: [0, 0, 1], elbow: w([0.27, 1.24, 0.16]) }, at);
        const frameR = solveArm(bones, "R", { wrist: w([-0.15, 1.5, 0.24]), point: [0.35, 1, 0.1], palm: [0, 0, 1], elbow: w([-0.27, 1.24, 0.16]) }, at);
        const flipL = solveArm(bones, "L", { wrist: w([0.14, 1.5, 0.4]), point: [-0.1, 1, 0.2], palm: [0, 0, -1], elbow: w([0.24, 1.25, 0.25]) }, at);
        const flipR = solveArm(bones, "R", { wrist: w([-0.14, 1.5, 0.4]), point: [0.1, 1, 0.2], palm: [0, 0, -1], elbow: w([-0.24, 1.25, 0.25]) }, at);
        const pinch: HandPose = { curl: 0.7, point: 0.35, thumb: 0.8, extra: [0, 0.2, 0.35, 0.45] };
        const a = { ...fixed({ ...frameL, ...frameR }), ...fingers("L", pinch), ...fingers("R", pinch) };
        const b = { ...fixed({ ...flipL, ...flipR }), ...fingers("L", { curl: 1.45, flip: 1, thumb: 0.8 }), ...fingers("R", { curl: 1.45, flip: 1, thumb: 0.8 }) };
        const pose = switchPoses(a, b, span(8 / 24, 99));
        nudge(pose, "forearmL.x", tremor(0.03, 0.2));
        nudge(pose, "forearmR.x", tremor(0.03, 1.7));
        return pose;
      },
      eye: [-60.0, 1.48, 0.95],
      aim: [-60.0, 1.6, 0.0],
      focal: 50,
      fstop: 1.8,
      focus: 0.8,
      camera: { size: 0.005, jolt: 0.015, roll: { start: 2, lean: -2, wander: 1.2 } },
      lights: [
        { at: [-59.5, 2.0, 0.9], color: COOL, intensity: 0.9 },
        { at: [-60.5, 1.4, 0.8], color: COOL, intensity: 0.3 },
      ],
      bokeh: [{ at: [-60.55, 1.3, -1.6], radius: 0.07, color: [40, 5, 2] }],
      flare: { centre: [0.7, 0.5], drift: [0, 0], radius: 0.95, gain: `1.1 * (${span(4 / 24, 5 / 24)} + ${span(7 / 24, 8 / 24)})`, veil: 0.35 },
      streak: { from: 0.25, to: 0.3, threshold: 6, gain: 0.35 },
      grade: DARK_GRADE(width, { exposure: 0.05, saturation: 0.45, keepWarm: 0.5 }),
    },
    // ── take 16 · row 62 (0:60.44, 8 frames), one take for its three parts: a ring-flare flash
    // over the face (frame 1), the low-angle face with a ringed hand at the cheek and a rainbow
    // arc crossing the right (frames 2-7), a flare blowing out the hand (frame 8).
    {
      row: "62",
      set: "void",
      placement: { place: [-60, 0, 0], yaw: -0.3 },
      pose: (bones) => {
        const at: Placement = { place: [-60, 0, 0], yaw: -0.3 };
        const w = (p: V3): [number, number, number] => toWorld(p, at);
        const right = solveArm(bones, "R", { wrist: w([-0.13, 1.52, 0.2]), point: dirToWorld([0.25, 1, 0.1], at), palm: dirToWorld([1, 0, -0.3], at), elbow: w([-0.28, 1.25, 0.1]) }, at);
        const pose = { "upperarmL.z": "-0.62", "forearmL.x": "-0.2", ...fixed(right), ...fingers("R", { curl: 0.55, spread: 0.1, thumb: 0.4, extra: [0, 0.1, 0.2, 0.3] }) };
        // chin up to a lens below
        nudge(pose, "neck.x", "-0.2");
        nudge(pose, "head.x", "-0.15");
        nudge(pose, "head.y", tremor(0.03, 0.5));
        return pose;
      },
      eye: [-60.1, 1.28, 0.55],
      aim: [-60.02, 1.68, 0.02],
      focal: 35,
      fstop: 1.8,
      focus: 0.62,
      camera: { size: 0.005, jolt: 0.015, roll: { start: -10, lean: 6, wander: 1.5 } },
      lights: [
        { at: [-59.6, 1.9, 0.6], color: COOL, intensity: 0.8 },
        { at: [-60.5, 1.3, 0.5], color: COOL, intensity: 0.2 },
      ],
      flare: { centre: [1.18, 0.35], drift: [-0.25, 0], radius: 0.85, gain: `0.7 + 1.6 * (${span(0, 1 / 24)} + ${span(7 / 24, 8 / 24)})`, veil: `0.08 + 1.4 * (${span(0, 1 / 24)} + ${span(7 / 24, 8 / 24)})` },
      streak: { from: 0.3, to: 0.35, threshold: 5, gain: 0.35 },
      grade: DARK_GRADE(width, { exposure: 0.05, saturation: 0.5, keepWarm: 0.5 }),
    },
  ];
}

/** Row 17c: the stacked arm-and-pistol layers (see the take's note above). */
function armLayersTake(width: number): Take {
  const at: Placement = { place: [-60, 0, 0], yaw: 0 };
  // where the hand is: the solved wrist (below) plus half a hand along the arm
  const hand: V3 = [-60.71, 1.42, 0.06];
  // a layer is in from its frame: half a frame early, so the render's 1/24 s steps land on it
  const frame = (k: number): number => (k - 0.5) / 24;
  const layers = [
    { at: 0, hand, roll: -90, u: 0.0, v: 0.4, distance: 1.7 },
    { at: frame(6), hand, roll: 90, u: 0.4, v: -0.35, distance: 1.75 },
    { at: frame(10), hand, roll: 90, u: -0.48, v: -0.4, distance: 1.75 },
    { at: frame(14), hand, roll: 0, u: 0.22, v: 0.02, distance: 1.65 },
    { at: frame(17), hand, roll: 180, u: -0.2, v: 0.12, distance: 1.65 },
  ];
  const first = layerCamera(layers[0]!, 50);
  return {
    row: "17c",
    set: "void",
    gun: true,
    placement: at,
    pose: (bones) => {
      const out = solveArm(bones, "R", { wrist: toWorld([-0.62, 1.42, 0.05], at), point: [-1, 0, 0], palm: [0, 0, -1], elbow: toWorld([-0.36, 1.43, 0.03], at) }, at);
      const pose = { "upperarmL.z": "-0.62", ...fixed(out), ...fingers("R", PISTOL_GRIP) };
      nudge(pose, "handR.y", tremor(0.04, 0.5));
      return pose;
    },
    layers,
    eye: first.eye,
    aim: first.aim,
    focal: 50,
    fstop: 4,
    focus: 1.1,
    camera: { size: 0.004, jolt: 0.01, roll: { start: 0, lean: 0, wander: 0.8 } },
    lights: [
      { at: [-60.5, 1.9, 1.0], color: COOL, intensity: 2.2 },
      { at: [-61.1, 1.2, 0.8], color: COOL, intensity: 0.9 },
    ],
    streak: { from: 0.4, to: 0.5, threshold: 1.6, gain: 0.6 },
    grade: DARK_GRADE(width, { exposure: 0.35, saturation: 0.25, keepWarm: 0.3 }),
  };
}

/** Row 12's MCU: fists up either side of the face; `dark` lists the shot-time spans the strobe blacks out. */
function fistsTake(width: number, row: string, dark: readonly (readonly [number, number])[]): Take {
  return {
    row,
    set: "warehouse",
    cars: [0, 1, 2, 3, 4],
    placement: TABLEAU_FIGURE,
    pose: (bones) => {
      const at = TABLEAU_FIGURE;
      const w = (p: V3): [number, number, number] => toWorld(p, at);
      const left = solveArm(bones, "L", { wrist: w([0.14, 1.44, 0.4]), point: [-0.05, 1, 0.15], palm: [0.1, 0, -1], elbow: w([0.3, 1.18, 0.25]) }, at);
      const right = solveArm(bones, "R", { wrist: w([-0.15, 1.42, 0.42]), point: [0.05, 1, 0.15], palm: [-0.1, 0, -1], elbow: w([-0.32, 1.16, 0.25]) }, at);
      const pose = { ...fixed({ ...left, ...right }), ...fingers("L", { curl: 1.5, thumb: 0.9, extra: [0, 0, 0.05, 0.1] }), ...fingers("R", { curl: 1.5, thumb: 0.1, thumbOut: 0.6, extra: [0, 0, 0.05, 0.1] }) };
      nudge(pose, "forearmL.x", tremor(0.04, 0.2));
      nudge(pose, "forearmR.x", tremor(0.04, 1.4));
      nudge(pose, "neck.x", "0.06");
      return pose;
    },
    eye: [0.03, 1.38, 4.78],
    aim: [0.0, 1.5, 3.9],
    focal: 32,
    fstop: 2,
    focus: 0.62,
    camera: { size: 0.01, jolt: 0.02, roll: { start: 2.5, lean: -3, wander: 1.5 } },
    lights: [
      { at: [0.5, 1.9, 5.4], color: COOL, intensity: 2.2 },
      { at: [-0.6, 1.2, 5.0], color: COOL, intensity: 0.8 },
    ],
    strobe: dark,
    haze: 0.035,
    streak: { from: 0.55, to: 0.6, threshold: 8, gain: 0.6 },
    grade: DARK_GRADE(width, { exposure: 0.2 }),
  };
}

/** Row 18 part b: the index finger up at the lips, frontal, a red blob low left. */
function shhTake(width: number): Take {
  const at: Placement = { place: [-60, 0, 0], yaw: 0 };
  return {
    row: "18b",
    set: "void",
    placement: at,
    pose: (bones) => {
      const w = (p: V3): [number, number, number] => toWorld(p, at);
      const right = solveArm(bones, "R", { wrist: w([-0.02, 1.47, 0.16]), point: [0.1, 1, 0.15], palm: [0.7, 0, -0.7], elbow: w([-0.2, 1.17, 0.1]) }, at);
      const pose = { ...fixed(right), "upperarmL.z": "-0.62", "forearmL.x": "-0.2", ...fingers("R", { curl: 1.45, point: 1, thumb: 0.9, extra: [0, 0, 0.05, 0.1] }) };
      nudge(pose, "neck.x", "-0.06");
      nudge(pose, "head.y", tremor(0.02, 0.3));
      return pose;
    },
    eye: [-59.99, 1.64, 0.86],
    aim: [-60.0, 1.64, 0.05],
    focal: 60,
    fstop: 2,
    focus: 0.66,
    camera: { size: 0.004, jolt: 0.01, roll: { start: 3, lean: 0, wander: 1 } },
    lights: [
      { at: [-59.6, 1.9, 0.9], color: COOL, intensity: 0.7 },
      { at: [-60.5, 1.3, 0.4], color: SODIUM, intensity: 0.15 },
    ],
    bokeh: [
      { at: [-60.5, 1.3, -1.6], radius: 0.06, color: [60, 9, 2] },
      { at: [-60.75, 1.1, -2.4], radius: 0.05, color: [30, 22, 12] },
    ],
    streak: { from: 0.2, to: 0.25, threshold: 10, gain: 0.3 },
    grade: DARK_GRADE(width, { exposure: 0.1, saturation: 0.75, keepWarm: 1 }),
  };
}

/**
 * T1407b (closeups2) — row 60 (58.600–59.893, frames 1405–1435): a tele close-up from behind the
 * figure's right shoulder, three-quarter back: the right hand up at the side of the face, fingers
 * loose along the cap, the iced watch at the wrist; the Cuban chain across the near shoulder low
 * left, the face in shadow, tall capsules of far tube light out of focus at the right. The key
 * strobes dark over frames 1407–1408; the lens creeps round and in, so the chain grows in the
 * frame and the picture brightens toward the end.
 */
function chainWatchTake(width: number): Take {
  const at: Placement = { place: [-60, 0, 0], yaw: 0 };
  const w = (p: V3): [number, number, number] => toWorld(p, at);
  // the lens: at the figure's right, a little behind, the face's side and the raised hand in view
  const eye = w([-1.25, 1.78, -0.2]);
  const aim = w([0.02, 1.6, 0.2]);
  const forward = unit(sub(aim, eye));
  const right = unit([-forward[2], 0, forward[0]]);
  const up: V3 = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  // the far tubes, 4.5 m off, placed in the frame: `sx` across (0..1), `sy` the capsule's centre
  // down from the top (0..1), `tall` its height (frame heights); each a short vertical stack of
  // lamps, which the lens spreads into a capsule
  const frameH = (2 * 4.5 * (18 / 2.347)) / 85;
  const frameW = frameH * 2.347;
  const tube = (sx: number, sy: number, tall: number, gain: number): { at: V3; radius: number; color: V3 }[] =>
    Array.from({ length: 5 }, (_, i) => {
      const y = (sy - 0.5 + (i / 4 - 0.5) * tall) * frameH;
      return { at: add(add(add(eye, forward, 4.5), right, (sx - 0.5) * frameW), up, -y), radius: 0.018, color: [gain * 0.9, gain * 0.97, gain] as V3 };
    });
  return {
    row: "60",
    set: "void",
    placement: at,
    pose: (bones) => {
      const arm = solveArm(bones, "R", { wrist: w([-0.12, 1.54, 0.16]), point: [0.1, 1, 0.15], palm: [1, 0, 0.1], elbow: w([-0.22, 1.26, 0.2]) }, at);
      const pose = { ...fixed(arm), "upperarmL.z": "-0.62", "forearmL.x": "-0.2", ...fingers("R", { curl: 0.35, spread: 0.08, thumb: 0.4, extra: [0, 0.1, 0.2, 0.3] }) };
      nudge(pose, "neck.x", "0.18");
      nudge(pose, "head.x", tremor(0.012, 0.5));
      nudge(pose, "forearmR.x", tremor(0.015, 1.7));
      return pose;
    },
    eye,
    aim,
    focal: 85,
    fstop: 1.4,
    focus: 1.3,
    camera: { size: 0.004, jolt: 0.006, roll: { start: -4, lean: 2, wander: 1 }, drift: [0.02, -0.01, 0.03] },
    lights: [
      // a cool key from beyond the face (the rim on the hand and the chain), a low fill for the shoulder
      { at: w([0.6, 2.1, 0.8]), color: COOL, intensity: 1.2 },
      { at: w([-0.7, 1.3, -0.1]), color: COOL, intensity: 0.2 },
      // the soft key over the lens: the side of the face, the back of the hand, the chain's top
      { at: w([-0.9, 2.4, 0.35]), color: COOL, intensity: 2.2 },
    ],
    // the key out over frames 1407–1408 (take frames 2–3; the spans sit between frame times)
    strobe: [[1.5 / 24, 3.5 / 24]],
    bokeh: [...tube(0.86, 0.42, 0.28, 150), ...tube(0.97, 0.62, 0.3, 100)],
    // the ice mirrors a brighter studio than the other hands takes (the chain), the IBL kept low (the skin)
    studio: 1.4,
    environment: 0.35,
    streak: { from: 0.2, to: 0.25, threshold: 12, gain: 0.25 },
    grade: DARK_GRADE(width, { exposure: 0.25, saturation: 0.4 }),
  };
}

function dirToWorld(v: V3, at: Placement): [number, number, number] {
  const c = Math.cos(at.yaw);
  const s = Math.sin(at.yaw);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}


export interface HandsOptions {
  readonly take?: number;
  readonly width?: number;
  readonly height?: number;
  readonly crt?: boolean;
}

/**
 * A layer's camera: looking straight down −Z at the hand from `distance` metres, rolled by
 * `roll` degrees, and shifted in its own image plane so the hand lands at (u, v) of the frame
 * (the rolled right and up are the ones the camera node builds: screen-space.ts VIEW).
 */
function layerCamera(layer: NonNullable<Take["layers"]>[number], focal: number): { eye: V3; aim: V3 } {
  const t = (layer.roll * Math.PI) / 180;
  const up: V3 = [Math.sin(t), Math.cos(t), 0];
  const right: V3 = [Math.cos(t), -Math.sin(t), 0];
  const halfW = (18 / focal) * layer.distance;
  const halfH = halfW / 2.347;
  const shift = add(add([0, 0, 0], right, -layer.u * halfW), up, -layer.v * halfH);
  const aim = add(layer.hand, shift);
  return { aim, eye: add(aim, [0, 0, 1], layer.distance) };
}

/** LIGHTEN: the Input (if `keep`), then each More picture wherever it is brighter, from its gate on. */
function lightenWgsl(layers: number): string {
  const gates = [`  keep: f32, // @default 1  1 lightens onto the Input, 0 starts from black.`, ...Array.from({ length: layers }, (_, i) => `  g${i}: f32, // @default 0  Layer ${i + 1} is in (1) or not yet (0).`)].join("\n");
  const binds = Array.from({ length: layers }, (_, i) => `@group(0) @binding(${4 + i}) var inputTexture${i + 1}: texture_2d<f32>;`).join("\n");
  const taps = Array.from({ length: layers }, (_, i) => `  c = max(c, textureSampleLevel(inputTexture${i + 1}, inputSampler, uv, 0.0).rgb * params.g${i});`).join("\n");
  return `struct Params {
${gates}
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
${binds}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var c = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb * params.keep;
${taps}
  return vec4f(c, 1.0);
}`;
}

/** Switch between two poses (knob axis → expression) by k (0 = a, 1 = b); an axis only one names switches from/to 0. */
function switchPoses(a: Record<string, string>, b: Record<string, string>, k: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[key] ?? "0";
    const vb = b[key] ?? "0";
    out[key] = va === vb ? va : `(${va}) + ((${vb}) - (${va})) * ${k}`;
  }
  return out;
}

/**
 * 1 on the frames whose time k/24 lies in [t0, t1), 0 elsewhere: a hard cut in, a hard cut out.
 * The edges sit half a frame early — a part renders from a whole frame, and an edge exactly on
 * a frame's time would give that frame half of each side.
 */
const span = (t0: number, t1: number): string => `(clamp((abstime - ${num(t0 - 1 / 48)}) * 10000, 0, 1) * clamp((${num(t1 - 1 / 48)} - abstime) * 10000, 0, 1))`;

/**
 * The PISTOL'S surface: a black polymer frame and a dark slide. Its GLB class (61) is one the
 * scene surface does not know, so it would fall to the material's defaults and read mid-grey
 * under a key; here it stays near black, a satin sheen on its flats.
 */
const GUN_SURFACE_WGSL = `struct Params {
  shade: f32, // @default 0.018  The pistol's albedo.
  sheen: f32, // @default 0.4  Roughness of its flats.
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(vec3f(p.shade), 1.0);
  o.roughness = p.sheen;
  o.metallic = 0.35;
  return o;
}`;

/** The fig area's pieces: the body (scene surface) and the ice (pavé surface). */
function figurePieces(facts: OnNothingFacts, gun: boolean, body: "figbody" | "figbare" = "figbody"): (readonly [string, Area, string])[] {
  if (!facts.areas.has(body) || !facts.areas.has("figice")) throw new Error("handsDocument: the GLB has no rings (rebuild it with tools/blender/on-nothing/hands.py, T1407b hands).");
  // `figbare` is the same MPFB body at the same rest, skinned by the same joints (scene-facts
  // checks the joint lists match), so `fig`'s ice sits on its fingers and wrist as on `fig`'s
  const pieces: (readonly [string, Area, string])[] = [["body", body, "surf1"], ["ice", "figice", "cusurf1"]];
  if (gun) {
    const own = facts.areas.get("figgun");
    const fig = facts.areas.get("fig");
    if (own === undefined || fig === undefined) throw new Error("handsDocument: the GLB has no pistol (rebuild it with tools/blender/on-nothing/hands.py).");
    // the pistol is skinned by its own copy of the rig: the kernel's indices hold only if its joints are fig's, in fig's order
    const names = (joints: string): string => joints.split(" ").map((entry) => entry.split(/[<@]/)[0]).join(" ");
    if (names(own.joints) !== names(fig.joints)) throw new Error("handsDocument: the pistol's rig lists other joints than the figure's.");
    pieces.push(["gun", "figgun", "gunsurf1"]);
  }
  return pieces;
}

export function handsDocument(facts: OnNothingFacts, options: HandsOptions): ProjectDocument {
  const width = options.width ?? 1920;
  const height = options.height ?? 818;
  const all = takes(width);
  const take = all[options.take ?? 0];
  if (take === undefined) throw new Error(`handsDocument: no take ${options.take} (there are ${all.length}).`);
  const chain = new Chain(["shot", "out"]);
  chain.add("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: SURFACE_WGSL, headGain: 1, wet: 0.3, wetGloss: 0.22, dryGloss: 0.62 }, { label: "surf1" });
  chain.add("cusurf", "materialWgsl", [-3000, -700], { model: "pbr", source: CLOSEUP_SURFACE_WGSL, pitch: 0.0011, fire: 0.35 }, { label: "cusurf1" });
  if (take.gun === true) chain.add("gunsurf", "materialWgsl", [-3000, -800], { model: "pbr", source: GUN_SURFACE_WGSL }, { label: "gunsurf1" });
  const scenes: string[] = [];

  // ── The set ──
  const mesh = (area: Area, material: string, row: number): void => {
    const f = facts.areas.get(area);
    if (f === undefined) throw new Error(`handsDocument: no "${area}" area in the GLB.`);
    chain.add(`mesh_${area}`, "meshFileIn", [-3600, row * 250], { file: facts.glbUrl, select: f.select, vertices: f.vertices, triangles: f.triangles, parts: f.parts }, { label: `mesh${area}1` });
    chain.add(`geo_${area}`, "geometry", [-3200, row * 250], { mode: "surface", material }, { label: `geo${area}1` });
    chain.link([`mesh_${area}`, "out"], [`geo_${area}`, "points"]);
    scenes.push(`geo${area}1`);
  };
  if (take.set === "warehouse") {
    mesh("wh", "surf1", 0);
    const cars = carAreas(facts);
    (take.cars ?? []).forEach((n, i) => {
      const area = cars[n];
      if (area !== undefined) mesh(area, "surf1", i + 1);
    });
  } else if (take.set === "cyc") {
    mesh("cyc", "surf1", 0);
  }

  // ── The figure: body and ice, one pose ──
  const known = new Set(facts.bones.map(boneParam));
  const knobs: Record<string, StoredParameter> = {};
  for (const bone of known) knobs[bone] = [0, 0, 0];
  const pose = take.pose(facts.bones);
  for (const [key, value] of Object.entries(pose)) {
    const [name, axis] = key.split(".");
    if (name === undefined) continue;
    const hand = /^(curl|spread|thumb)[LR]$/.test(name);
    if (!hand && !known.has(name)) throw new Error(`handsDocument: no bone knob "${key}".`);
    if (axis === undefined) {
      knobs[name] = expressionSlot(value, 0);
      continue;
    }
    if (knobs[name] === undefined) knobs[name] = name.startsWith("curl") ? [0, 0, 0, 0] : name.startsWith("thumb") ? [0, 0] : [0, 0, 0];
    knobs[key] = expressionSlot(value, 0);
  }
  const kernel = skinKernel(facts);
  figurePieces(facts, take.gun === true, take.body).forEach(([piece, area, material], index) => {
    const f = facts.areas.get(area)!;
    const y = 1200 + index * 250;
    // the pistol out of the hand: dropped far below the floor while `gunShow` is 0
    const away: Record<string, StoredParameter> = piece === "gun" && take.gunShow !== undefined ? { "place.y": expressionSlot(`${num(take.placement.place[1])} - 50 * (1 - (${take.gunShow}))`, take.placement.place[1]) } : {};
    chain.add(`fig_${piece}`, "meshFileIn", [-3600, y], { file: facts.glbUrl, select: f.select, vertices: f.vertices, triangles: f.triangles, parts: f.parts, joints: f.joints }, { label: `fig${piece}1` });
    chain.add(`skin_${piece}`, "pointKernel", [-3300, y], { capacity: f.vertices, attributes: SKIN_ATTRIBUTES, kernel, yaw: take.placement.yaw, place: vec3(take.placement.place), ...away, ...knobs }, { label: `skin${piece}1` });
    chain.add(`figGeo_${piece}`, "geometry", [-3000, y], { mode: "surface", material }, { label: `figgeo${piece}1` });
    chain.link([`fig_${piece}`, "out"], [`skin_${piece}`, "in"]);
    chain.link([`skin_${piece}`, "out"], [`figGeo_${piece}`, "points"]);
    scenes.push(`figgeo${piece}1`);
  });

  // ── Light ──
  const lights: string[] = [];
  // a strobe: the keys go out over each dark span (the headlights and the practicals burn on)
  // (the expression language has no step: a clamp over a steep ramp is the hard edge)
  const lit = (take.strobe ?? []).map(([t0, t1]) => `(1 - clamp((abstime - ${num(t0)}) * 10000, 0, 1) * clamp((${num(t1)} - abstime) * 10000, 0, 1))`).join(" * ");
  take.lights.forEach((light, i) => {
    const intensity = lit === "" ? light.intensity : expressionSlot(`${num(light.intensity)} * ${lit}`, light.intensity);
    chain.add(`key${i}`, "light", [-2600, 1800 + i * 80], { kind: "point", position: vec3(light.at), color: [...light.color, 1], intensity }, { label: `key${i}1` });
    lights.push(`key${i}1`);
  });
  if (take.set === "cyc") {
    chain.add("sun", "light", [-2600, 1700], { kind: "point", position: [4.5, 7.5, 6.5], color: [1, 0.98, 0.95, 1], intensity: 6 }, { label: "sun1" });
    lights.push("sun1");
  }

  // ── Environment, camera, Render ──
  chain.add("envSeed", "ramp", [-2900, 300], {}, { label: "envseed1", resolution: { mode: "fixed", width: 1024, height: 512 } });
  // the ice needs something to mirror: the close-ups' studio (soft box, strip, small sources and
  // cards gathered round the lens) — what makes every stone of a ring throw a glint
  const toward = unit(sub(take.eye, take.aim));
  const studio = take.studio ?? 1;
  chain.add("env", "customWgsl", [-2700, 500], { source: STUDIO_ENV_WGSL, softbox: 0.3 * studio, strip: 0.6 * studio, points: 60 * studio, count: 70, size: 0.006, ambient: 0.004, surround: 0.8 * studio, cards: 120, room: 0, roomTurn: 0, toward: vec3(toward) }, { label: "env1", resolution: { mode: "fixed", width: 2048, height: 1024 } });
  chain.link(["envSeed", "out"], ["env", "input"]);
  const fov = (2 * Math.atan(18 / 2.347 / take.focal) * 180) / Math.PI;
  const move = teleHandheld(take.eye, take.aim, take.camera.size, take.camera.jolt, take.camera.roll, take.camera.drift);
  chain.add("cam", "camera", [-2700, -900], { eye: vec3(take.eye), lookAt: vec3(take.aim), fov, near: 0.02, far: 200, ...move }, { label: "cam1" });
  chain.add("shot", "render", [-2400, 0], {
    scenes: scenes.join(" "),
    camera: "cam1",
    lights: lights.join(" "),
    projectors: "",
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: 0,
    background: take.set === "cyc" ? [0.85, 0.87, 0.88, 1] : [0, 0, 0, 1],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    albedoOutput: true,
    environmentIntensity: take.environment ?? 0.4,
    environmentTaps: 16,
  }, { label: "shot1" });
  chain.link(["env", "out"], ["shot", "environment"]);

  if (take.layers !== undefined) {
    // ── The layers: the same figure through other cameras, laid in by lighten on their frames ──
    const layered: { port: [string, string]; gate: StoredParameter }[] = [];
    take.layers.forEach((layer, i) => {
      const { eye, aim } = layerCamera(layer, take.focal);
      const id = `L${i}`;
      const moveL = teleHandheld(eye, aim, take.camera.size, take.camera.jolt, { ...take.camera.roll, start: take.camera.roll.start + layer.roll });
      chain.add(`cam${id}`, "camera", [-2700, -1100 - i * 150], { eye: vec3(eye), lookAt: vec3(aim), fov, near: 0.02, far: 200, ...moveL }, { label: `cam${id.toLowerCase()}1` });
      chain.add(`shot${id}`, "render", [-2400, -300 - i * 150], {
        scenes: scenes.join(" "), camera: `cam${id.toLowerCase()}1`, lights: lights.join(" "), projectors: "",
        ambientColor: [1, 1, 1, 1], ambientIntensity: 0, background: [0, 0, 0, 1], antialias: "msaa",
        environmentIntensity: take.environment ?? 0.4, environmentTaps: 16,
      }, { label: `shot${id.toLowerCase()}1` });
      chain.link(["env", "out"], [`shot${id}`, "environment"]);
      layered.push({ port: [`shot${id}`, "out"], gate: expressionSlot(`clamp((abstime - ${num(layer.at)}) * 10000 + 0.5, 0, 1)`, 0) });
    });
    // a Custom WGSL · Multi takes three More pictures: the stack runs in passes of three, each
    // lightening onto the one before (the first ignores its Input, the base Render)
    for (let start = 0; start < layered.length; start += 3) {
      const group = layered.slice(start, start + 3);
      const gates: Record<string, StoredParameter> = { keep: start === 0 ? 0 : 1 };
      group.forEach((layer, i) => { gates[`g${i}`] = layer.gate; });
      chain.pass(`stack${start / 3}`, lightenWgsl(group.length), gates, group.map((layer) => layer.port), [-2000 + (start / 3) * 100, 0]);
    }
  } else {
    const cam = cameraParams(take.eye, take.aim, fov);
    const depth = ["shot", "depth"] as const;
    const normal = ["shot", "normal"] as const;
    chain.pass("occlusion", GTAO_WGSL, { ...cam, radius: 0.06, strength: 0.5 }, [depth, normal], [-2100, 0]);
    if (take.haze !== undefined) {
      chain.pass("haze", hazeWgsl(hazeLights(facts, ["head"])), { ...cam, density: take.haze, ambient: [0.002, 0.0025, 0.003], anisotropy: 0.75, head: 0.3 }, [depth], [-1900, 0]);
    }
    if (take.bokeh !== undefined) chain.pass("bokeh", bokehWgsl(take.bokeh), { ...cam, gain: 1, flicker: 0.04 }, [depth], [-1800, 0]);
    const lens: Record<string, StoredParameter> = { ...cam, focal: take.focal, fstop: take.fstop, focus: typeof take.focus === "number" ? take.focus : expressionSlot(take.focus, 1), maxCoc: 0.05 };
    chain.pass("dof", LENS_DOF_WGSL, lens, [depth], [-1600, 0]);
    chain.pass("dofFill", DOF_FILL_WGSL, lens, [depth], [-1500, 0]);
  }
  const scene = chain.last;

  // ── The streak glass (stock), from the hottest sources softened to their glow ──
  chain.add("hotStreak", "customWgsl", [-1300, 700], { source: BRIGHT_PASS_WGSL, threshold: take.streak.threshold, knee: take.streak.threshold * 0.3 }, { resolution: { mode: "scale", factor: 0.5 } });
  chain.link(scene, ["hotStreak", "input"]);
  chain.add("hotSoft", "customWgsl", [-1200, 700], { source: BLOOM_DOWN_WGSL, clampLuma: 0 }, { resolution: { mode: "scale", factor: 0.5 } });
  chain.link(["hotStreak", "out"], ["hotSoft", "input"]);
  chain.stock("streak", "streak", {
    threshold: take.streak.threshold,
    knee: 0.8,
    length: expressionSlot(`${take.streak.from} + (${take.streak.to} - ${take.streak.from}) * clamp(abstime, 0, 1)`, take.streak.from),
    angle: 0,
    falloff: 1.2,
    spread: 0,
    tail: 0.04,
    striation: 0.25,
    striationScale: 120,
    gain: take.streak.gain,
    tint: [0.92, 0.98, 1, 1],
  }, [-1200, 0]);
  chain.link([take.streak.sharp === true ? "hotStreak" : "hotSoft", "out"], ["streak", "bright"]);
  const glow = chain.bloom(chain.last, 1.4, -1100);
  chain.pass("bloomAdd", BLOOM_ADD_WGSL, { gain: 0.1 }, [glow], [-600, 0]);
  if (take.flare !== undefined) {
    const f = take.flare;
    chain.pass("flare", FLARE_ARC_WGSL, {
      centre: [f.centre[0], f.centre[1]],
      "centre.x": expressionSlot(`${num(f.centre[0])} + abstime * ${num(f.drift[0])}`, f.centre[0]),
      "centre.y": expressionSlot(`${num(f.centre[1])} + abstime * ${num(f.drift[1])}`, f.centre[1]),
      radius: f.radius,
      gain: typeof f.gain === "number" ? f.gain : expressionSlot(f.gain, 0),
      veil: typeof f.veil === "string" ? expressionSlot(f.veil, 0) : (f.veil ?? 0.05),
    }, [], [-500, 0]);
  }
  chain.stock("lens", "lens", take.lensFx ?? { distortion: 0.02, edgeBlur: 0.012, swirl: 0.5, aberration: 0.0025, vignette: 0.7, vignetteRound: 0.8 }, [-300, 0]);
  chain.stock("grade", "filmGrade", take.grade, [-100, 0]);
  if (options.crt === true) chain.stock("crt", "crt", { amount: 1 }, [500, 0]);
  chain.add("out", "output", [700, 0], { toneMap: "none" }, { label: "out1" });
  chain.link(chain.last, ["out", "input"]);
  return chain.document(`hands-${take.row}`, width, height);
}

/** For the tests: the takes' rows, in take order. */
export function handTakeRows(): string[] {
  return takes(1920).map((take) => take.row);
}

