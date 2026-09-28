import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { markerOf } from "../scene-facts.ts";
import { type Pose, type V3, addv, apply, boneWorld, cross, dot, norm, reach, reachArm, subv } from "./reach.ts";

/**
 * T1407b (closeups2) — THE HELD SNEAKER, rows 5–8 (the reference's 3.170–5.380 s, frames
 * 76–128 at 23.976): ONE continuous handheld take with a single real cut at frame 91 (3.795 s).
 *
 *  - take 1 (rows 5–6, frames 76–90): the white low-top hangs from the figure's right hand
 *    beside the chest, is lifted to the face and swung up over the head, the lens low and close,
 *    looking up past the chain;
 *  - take 2 (rows 7–8, frames 91–128): brought down across the face, pushed at the lens until
 *    it fills the frame, then gone — the face under the sunglasses revealed, the head leaning
 *    in to the lens (the reference's raised left hand is left out: its fingers are not rigged).
 *
 * The bright frames inside both takes are STROBE FLASHES, not cuts: a flash at the lens lights
 * the frame, lifts it to a milky veil and throws a thin rainbow ring (`flash` below).
 *
 * The motion is KEYED on the reference's frame numbers (the keys below) and SAMPLED once per
 * frame here: at every frame the right arm is solved (reach.ts) so the wrist is where the key
 * puts it, the hand turned so its fingers point away from the lens (the fingers are folded into
 * the hand bone, not rigged: the hand always sits BEHIND the shoe), and the shoe — closeups2.py's
 * `shoeh`, built at HELD in its own axes — turned to the key's toe and sole directions and moved
 * so the palm sits against its far side. Each sampled channel (every bone knob, the shoe's turn
 * and place, the frame the close-up surface draws the leather in, the lens) becomes a
 * piecewise-linear expression of the clock, so sub-frames interpolate and the arm, the shoe and
 * the panels on the leather move as one.
 *
 * Positions are relative to the figure's stand FIG (glTF metres; the figure faces +Z: x is its
 * left, frame right; y up; z toward the lens).
 */

/** The figure's stand: in front of the white car's nose (car 3), the far wall close enough to fill the frame. */
export const FIG: V3 = [-0.25, 0, -6.5];

const FPS = 24;
/** The clock in frames of the take (the render runs at 24 fps; frame k of the take plays at k / 24 s). */
const U = `(abstime * ${FPS})`;

interface Key {
  /** The reference frame this key sits on. */
  readonly f: number;
  /** The right wrist (figure frame). */
  readonly wrist: V3;
  /** The shoe's toe and sole-up directions (the up is made orthogonal to the toe). */
  readonly toe: V3;
  readonly up: V3;
  /** The palm against the shoe: [depth off the centre line on the FAR side, y heel→toe, z up], shoe-local metres. */
  readonly grip: V3;
  /** Where the right elbow should fall (a pole for the reach), figure frame. */
  readonly elbow?: V3;
  /** Other knobs: the head, the neck, the spine. */
  readonly bones: Readonly<Record<string, V3>>;
  /** The lens (figure frame), its vertical fov (degrees), focus (metres) and horizon roll (degrees). */
  readonly eye: V3;
  readonly aim: V3;
  readonly fov: number;
  readonly focus: number;
  readonly roll: number;
}

export interface HeldTake {
  /** The reference frames the take plays: first, and one past the last. */
  readonly first: number;
  readonly end: number;
  readonly keys: readonly Key[];
  /** Strobe flashes: reference frame → strength (1 = the full flash). */
  readonly flashes: Readonly<Record<number, number>>;
  readonly fstop: number;
  /** Handheld shake, metres of eye wander. */
  readonly shake: number;
}

// the right hand's fingers at rest, wrist to the finger tips' centroid (measured on the MPFB mesh)
const FINGERS_R: V3 = norm([-0.057, -0.114, 0.142]);
// the right arm's starting guess for the reach (forward and down, the forearm bent up)
const PRIOR_R: Readonly<Record<string, V3>> = { upperarmR: [-0.5, 0, 0.3], forearmR: [-1.8, 0, 0] };
// the left arm hangs, elbow a little bent
const LEFT_DOWN: Readonly<Record<string, V3>> = { upperarmL: [0, 0, -0.62], forearmL: [-0.35, 0, 0] };

export const HELD_TAKES: readonly HeldTake[] = [
  // take 1 — rows 5–6, reference frames 76–90
  {
    first: 76,
    end: 91,
    fstop: 1.8,
    shake: 0.004,
    flashes: { 80: 0.7, 83: 1, 86: 1, 89: 0.8 },
    keys: [
      // the shoe hangs from the hand beside the chest, frame left, toe down-left; the chain at
      // frame right, the mouth at the top edge; the lens low and close
      { f: 76, wrist: [-0.14, 1.32, 0.32], elbow: [-0.44, 1.12, 0.06], toe: [-0.8, -0.45, 0.35], up: [-0.4, 0.6, 0.25], grip: [0.06, 0.03, 0.07], bones: { ...LEFT_DOWN, neck: [0.14, 0, 0], head: [0.12, 0, 0] }, eye: [0.0, 1.2, 0.82], aim: [-0.08, 1.38, 0.1], fov: 34, focus: 0.5, roll: -4 },
      // lifted to the face's height, sole down, the forearm across the frame, the beard beside it
      { f: 82, wrist: [-0.13, 1.46, 0.3], elbow: [-0.45, 1.14, 0.06], toe: [-0.95, 0.05, 0.3], up: [0.05, 1, 0.1], grip: [0.06, 0.06, 0.05], bones: { ...LEFT_DOWN, neck: [0.08, 0, 0], head: [0.04, 0, 0] }, eye: [0.0, 1.22, 0.8], aim: [-0.07, 1.42, 0.1], fov: 34, focus: 0.5, roll: -6 },
      // over the head, the face under it, the lens at the chest looking up
      { f: 88, wrist: [-0.12, 1.58, 0.28], elbow: [-0.45, 1.18, 0.05], toe: [-1, 0.05, 0.15], up: [0, 1, 0], grip: [0.06, 0.07, 0.05], bones: { ...LEFT_DOWN, neck: [0.1, 0, 0], head: [0.15, 0, 0] }, eye: [0.02, 1.24, 0.78], aim: [-0.04, 1.48, 0.1], fov: 34, focus: 0.5, roll: 3 },
      { f: 91, wrist: [-0.1, 1.61, 0.28], elbow: [-0.45, 1.19, 0.05], toe: [-1, 0.0, 0.15], up: [0, 1, 0], grip: [0.06, 0.07, 0.05], bones: { ...LEFT_DOWN, neck: [0.1, 0, 0], head: [0.15, 0, 0] }, eye: [0.03, 1.25, 0.77], aim: [-0.03, 1.5, 0.1], fov: 34, focus: 0.5, roll: 4 },
    ],
  },
  // take 2 — rows 7–8, reference frames 91–128
  {
    first: 91,
    end: 129,
    fstop: 1.4,
    shake: 0.005,
    flashes: { 93: 1, 96: 1, 99: 1, 103: 0.8, 106: 1, 109: 0.35, 114: 0.25, 116: 0.35, 119: 0.3, 124: 0.2, 126: 0.25 },
    keys: [
      // across the face, toe to frame left, the sunglasses behind it
      { f: 91, wrist: [-0.02, 1.5, 0.36], elbow: [-0.4, 1.2, 0.1], toe: [-1, -0.05, 0.12], up: [0, 1, 0.1], grip: [0.06, 0.07, 0.05], bones: { ...LEFT_DOWN, neck: [0.05, 0, 0], head: [0.1, 0, 0] }, eye: [0.1, 1.32, 0.72], aim: [0.02, 1.58, 0.1], fov: 38, focus: 0.4, roll: 2 },
      // held at the lens, the face soft behind it, the left hand up by the face
      { f: 95, wrist: [0.0, 1.42, 0.42], elbow: [-0.38, 1.15, 0.15], toe: [-1, -0.08, 0.05], up: [-0.05, 1, 0.1], grip: [0.06, 0.08, 0.05], bones: { ...LEFT_DOWN, neck: [0.08, 0, 0], head: [0.15, 0, 0] }, eye: [0.1, 1.32, 0.74], aim: [0.02, 1.58, 0.1], fov: 38, focus: 0.34, roll: -3 },
      // pushed into the lens, a blur across the frame
      { f: 101, wrist: [0.05, 1.38, 0.56], elbow: [-0.34, 1.14, 0.25], toe: [-1, 0.1, 0.3], up: [0, 1, 0.2], grip: [0.06, 0.08, 0.05], bones: { ...LEFT_DOWN, neck: [0.08, 0, 0], head: [0.15, 0, 0] }, eye: [0.08, 1.36, 0.72], aim: [0.02, 1.6, 0.1], fov: 38, focus: 0.5, roll: -5 },
      // gone: swept down past the lens; the face from below
      { f: 105, wrist: [-0.35, 1.0, 0.35], elbow: [-0.4, 1.1, 0.0], toe: [-0.6, -0.6, 0.4], up: [0.1, 0.4, -1], grip: [0.06, 0.08, 0.05], bones: { ...LEFT_DOWN, neck: [0.12, 0, 0], head: [0.2, 0, 0] }, eye: [0.06, 1.42, 0.46], aim: [0.1, 1.66, 0.05], fov: 40, focus: 0.45, roll: -2 },
      { f: 116, wrist: [-0.35, 1.0, 0.3], elbow: [-0.4, 1.1, 0.0], toe: [-0.6, -0.6, 0.4], up: [0.1, 0.4, -1], grip: [0.06, 0.08, 0.05], bones: { ...LEFT_DOWN, neck: [0.12, 0, 0], head: [0.25, 0, 0] }, eye: [0.05, 1.44, 0.44], aim: [0.1, 1.66, 0.05], fov: 40, focus: 0.42, roll: 2 },
      // the head leans in to the lens, the mouth open, the hand gone
      { f: 128, wrist: [-0.35, 1.0, 0.3], elbow: [-0.4, 1.1, 0.0], toe: [-0.6, -0.6, 0.4], up: [0.1, 0.4, -1], grip: [0.06, 0.08, 0.05], bones: { ...LEFT_DOWN, spine: [0.12, 0, 0], chest: [0.1, 0, 0], neck: [0.2, 0, 0], head: [0.25, 0, 0] }, eye: [0.02, 1.48, 0.4], aim: [0.06, 1.62, 0.05], fov: 40, focus: 0.3, roll: 5 },
    ],
  },
];

/** A take's solved motion: each channel's value at every frame of the take (index = frame − first). */
export interface HeldSetup {
  readonly take: HeldTake;
  readonly frames: number;
  /** Figure knobs, by bone parameter name. */
  readonly bones: Readonly<Record<string, readonly V3[]>>;
  readonly held: V3;
  readonly origin: readonly V3[];
  readonly columns: readonly (readonly [V3, V3, V3])[];
  readonly axes: readonly (readonly [V3, V3, V3])[];
  readonly eye: readonly V3[];
  readonly aim: readonly V3[];
  readonly fov: readonly number[];
  readonly focus: readonly number[];
  readonly roll: readonly number[];
  readonly flash: string;
  /** The worst wrist miss of the reach over the take, metres. */
  readonly miss: number;
}

const vec3Of = (value: unknown, what: string): [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`closeups-held: prop.shoeh carries no ${what} (rebuild with closeups2.py).`);
  return [Number(value[0]), Number(value[1]), Number(value[2])];
};

const ease = (s: number): number => s * s * (3 - 2 * s);
const lerp3 = (a: V3, b: V3, s: number): V3 => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];

/** The keys around frame f and the eased share between them. */
function around(keys: readonly Key[], f: number): { readonly a: Key; readonly b: Key; readonly s: number } {
  let a = keys[0]!;
  let b = keys[keys.length - 1]!;
  for (let i = 0; i + 1 < keys.length; i++) {
    if (f >= keys[i]!.f && f <= keys[i + 1]!.f) {
      a = keys[i]!;
      b = keys[i + 1]!;
      break;
    }
  }
  const s = b.f === a.f ? 0 : Math.min(Math.max((f - a.f) / (b.f - a.f), 0), 1);
  return { a, b, s: ease(s) };
}

/** Coordinate descent from x0 (deterministic), shrinking steps. */
function minimise(cost: (x: readonly number[]) => number, x0: readonly number[], step0: number): number[] {
  const x = [...x0];
  let best = cost(x);
  for (let step = step0; step > 0.002; step *= 0.6) {
    for (let pass = 0; pass < 8; pass++) {
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
  return x;
}

/** Solves the take frame by frame: the arms' reach, the hand's turn, the shoe's turn and place, the lens. */
export function heldSetup(facts: OnNothingFacts, take: number): HeldSetup {
  const spec = HELD_TAKES[take - 1];
  if (spec === undefined) throw new Error(`closeups: the sneaker has no take ${take} (1–${HELD_TAKES.length} hold the shoe).`);
  const marker = markerOf(facts, "prop.shoeh");
  const held = marker.position;
  const restAxes: [V3, V3, V3] = [vec3Of(marker.extras?.["loom_x"], "loom_x"), vec3Of(marker.extras?.["loom_y"], "loom_y"), vec3Of(marker.extras?.["loom_z"], "loom_z")];
  const wristRestR = facts.bones.find((bone) => bone.name === "hand.R")?.head;
  if (wristRestR === undefined) throw new Error("closeups-held: the figure has no hand.R.");
  const frames = spec.end - spec.first;
  const boneNames = new Set<string>(["upperarmR", "forearmR", "handR", "upperarmL", "forearmL"]);
  for (const key of spec.keys) for (const name of Object.keys(key.bones)) boneNames.add(name);
  const bones: Record<string, V3[]> = Object.fromEntries([...boneNames].map((name) => [name, [] as V3[]]));
  const origin: V3[] = [];
  const columns: [V3, V3, V3][] = [];
  const axes: [V3, V3, V3][] = [];
  const eyes: V3[] = [];
  const aims: V3[] = [];
  const fovs: number[] = [];
  const focus: number[] = [];
  const rolls: number[] = [];
  let priorR: Record<string, V3> = { ...PRIOR_R };
  let hand: V3 | undefined;
  let miss = 0;
  // one sample past the end, so the last frame's sub-frames interpolate toward it
  for (let k = 0; k <= frames; k++) {
    const f = spec.first + k;
    const { a, b, s } = around(spec.keys, f);
    const rest: Record<string, V3> = {};
    for (const name of boneNames) {
      if (name.startsWith("upperarm") || name.startsWith("forearm") || name === "handR") continue;
      rest[name] = lerp3(a.bones[name] ?? [0, 0, 0], b.bones[name] ?? [0, 0, 0], s);
    }
    const eye = addv(FIG, lerp3(a.eye, b.eye, s));
    const base: Pose = { place: FIG, yaw: 0, bones: rest };
    // the left arm hangs (a raised left hand shows its unrigged, splayed fingers to the lens)
    const left: Record<string, V3> = { upperarmL: LEFT_DOWN["upperarmL"]!, forearmL: LEFT_DOWN["forearmL"]! };
    const withLeft: Pose = { ...base, bones: { ...rest, ...left } };
    const pole = a.elbow === undefined && b.elbow === undefined ? undefined : addv(FIG, lerp3(a.elbow ?? b.elbow!, b.elbow ?? a.elbow!, s));
    const solved = reachArm(facts.bones, withLeft, "R", addv(FIG, lerp3(a.wrist, b.wrist, s)), priorR, pole);
    miss = Math.max(miss, solved.miss);
    priorR = { upperarmR: solved.bones["upperarmR"]!, forearmR: solved.bones["forearmR"]! };
    const armed: Record<string, V3> = { ...rest, ...left, ...priorR };
    const wrist = reach(facts.bones, { ...base, bones: armed }, "hand.R", wristRestR);
    const toCam = norm(subv(eye, wrist));
    // the hand: fingers away from the lens, turning as little as it can from the last frame
    const fingersAway = (knob: readonly number[]): number => dot(apply(boneWorld(facts.bones, { ...base, bones: { ...armed, handR: [knob[0]!, knob[1]!, knob[2]!] } }, "hand.R").m, FINGERS_R), toCam);
    let knob: number[];
    if (hand === undefined) {
      let best = Infinity;
      knob = [0, 0, 0];
      for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) for (let l = -6; l <= 6; l++) {
        const trial = [i * 0.25, j * 0.25, l * 0.25];
        const score = fingersAway(trial) + 0.02 * dot(trial as unknown as V3, trial as unknown as V3);
        if (score < best) {
          best = score;
          knob = trial;
        }
      }
    } else {
      const from = hand;
      knob = minimise((x) => fingersAway(x) + 0.3 * ((x[0]! - from[0]) ** 2 + (x[1]! - from[1]) ** 2 + (x[2]! - from[2]) ** 2), [...from], 0.2);
    }
    hand = [knob[0]!, knob[1]!, knob[2]!];
    const pose: Record<string, V3> = { ...armed, handR: hand };
    for (const name of boneNames) bones[name]!.push(pose[name] ?? [0, 0, 0]);
    // the shoe: the key's orientation, the palm against its far side
    const toe = lerp3(a.toe, b.toe, s);
    const upWant = lerp3(a.up, b.up, s);
    const y = norm(toe);
    const z = norm(subv(upWant, addv([0, 0, 0], y, dot(upWant, y))));
    const x = cross(y, z);
    const want: [V3, V3, V3] = [x, y, z];
    columns.push([0, 1, 2].map((c) => [0, 1, 2].map((row) => want.reduce((sum, w, i) => sum + w[row]! * restAxes[i]![c]!, 0))) as unknown as [V3, V3, V3]);
    const handXf = boneWorld(facts.bones, { ...base, bones: pose }, "hand.R");
    const palm = addv(wrist, apply(handXf.m, FINGERS_R), 0.08);
    const grip = lerp3(a.grip, b.grip, s);
    const far = dot(x, toCam) > 0 ? -1 : 1;
    const gripWorld = addv(addv(addv([0, 0, 0], x, far * grip[0]), y, grip[1]), z, grip[2]);
    origin.push(subv(palm, gripWorld));
    axes.push(want);
    eyes.push(eye);
    aims.push(addv(FIG, lerp3(a.aim, b.aim, s)));
    fovs.push(a.fov + (b.fov - a.fov) * s);
    focus.push(a.focus + (b.focus - a.focus) * s);
    rolls.push(a.roll + (b.roll - a.roll) * s);
  }
  const flash = Object.entries(spec.flashes)
    .map(([frame, strength]) => `clamp(1 - abs(floor(${U} + 0.001) - ${Number(frame) - spec.first}), 0, 1) * ${strength}`)
    .join(" + ");
  return { take: spec, frames, bones, held, origin, columns, axes, eye: eyes, aim: aims, fov: fovs, focus, roll: rolls, flash: flash === "" ? "0" : flash, miss };
}

const fixed = (value: number): string => (Math.abs(value) < 5e-7 ? "0" : value.toFixed(6));

/** A channel sampled once a frame as a piecewise-linear expression of the clock (holds after its last sample). */
export function sampled(values: readonly number[]): string {
  let text = fixed(values[0]!);
  for (let i = 0; i + 1 < values.length; i++) {
    const delta = values[i + 1]! - values[i]!;
    if (Math.abs(delta) < 1e-6) continue;
    text += ` + clamp(${U} - ${i}, 0, 1) * ${delta < 0 ? `(${fixed(delta)})` : fixed(delta)}`;
  }
  return text;
}

/** A vec3 channel as three component slots (`name.x`, `name.y`, `name.z`) plus its first value. */
export function sampledVec(name: string, values: readonly V3[]): Record<string, StoredParameter> {
  const first = values[0]!;
  const out: Record<string, StoredParameter> = { [name]: [first[0], first[1], first[2]] };
  (["x", "y", "z"] as const).forEach((axis, index) => {
    out[`${name}.${axis}`] = expressionSlot(sampled(values.map((v) => v[index]!)), first[index]!);
  });
  return out;
}

/** The shoe's rigid turn and move (Point Kernel: position and normal). */
export const HELD_SHOE_KERNEL = `// T1407b closeups2 — the held shoe: world = origin + R · (rest − held), the normal turned by R.
struct Params {
  held: vec3f, // @default 0  The shoe's rest origin (closeups2.py HELD, glTF).
  origin: vec3f, // @default 0  Where that origin goes.
  rx: vec3f, // @default 0  R's first column.
  ry: vec3f, // @default 0  R's second column.
  rz: vec3f, // @default 0  R's third column.
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let d = p.position - ctx.params.held;
  q.position = ctx.params.origin + ctx.params.rx * d.x + ctx.params.ry * d.y + ctx.params.rz * d.z;
  q.normal = normalize(ctx.params.rx * p.normal.x + ctx.params.ry * p.normal.y + ctx.params.rz * p.normal.z);
  return q;
}`;

export const HELD_SHOE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
]);

/**
 * The strobe's FLASH in the frame, after the grade (display light): the frame lifted toward a
 * milky teal-grey veil, strongest round the ring's centre, and a thin dispersed rainbow ring
 * (red outermost). `flash` is 0 between flashes.
 */
export const FLASH_WGSL = `struct Params {
  flash: f32, // @default 0  The flash (0 off, 1 the full flash).
  gain: f32, // @default 0.9  Exposure lift of the whole frame at a full flash (stops).
  veil: f32, // @default 0.22  The milky veil's level at a full flash.
  ring: f32, // @default 0.16  The rainbow ring's brightness.
  centre: vec2f, // @default 0.5  The ring's centre (uv).
  radius: f32, // @default 0.55  The ring's radius, fraction of the frame height.
  width: f32, // @default 0.012  The ring's width, fraction of the frame height.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let f = params.flash;
  if (f <= 0.0) { return vec4f(base, 1.0); }
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  let d = (uv - params.centre) * vec2f(aspect, 1.0);
  let r = length(d);
  // lifted and veiled: a screen-blend toward the veil, more of it inside the ring
  let lifted = 1.0 - (1.0 - base * exp2(params.gain * f)) * (1.0 - vec3f(0.78, 0.86, 0.88) * params.veil * f * (0.55 + 0.45 * smoothstep(params.radius * 1.3, 0.0, r)));
  // the ring: red outermost, blue inmost, fading round its circumference
  let t = (r - params.radius) / params.width;
  let band = vec3f(exp(-(t - 0.9) * (t - 0.9) * 2.0), exp(-t * t * 2.0), exp(-(t + 0.9) * (t + 0.9) * 2.0));
  let around = 0.55 + 0.45 * cos(atan2(d.y, d.x) - 0.6);
  let colour = lifted + band * params.ring * f * min(f, 1.0) * around;
  return vec4f(min(colour, vec3f(1.0)), 1.0);
}`;

/**
 * The take's camera: the sampled eye, aim, fov and roll, with a handheld tremor on top (three
 * incommensurate sines per axis, `shake` metres of eye wander, the aim wandering a little more).
 */
export function heldCamera(setup: HeldSetup): Record<string, StoredParameter> {
  const shake = setup.take.shake;
  const wob = (a: number, b: number, c: number, phase: number): string =>
    `(sin(abstime * ${a} + ${phase}) * 0.5 + sin(abstime * ${b} + ${(phase * 1.7).toFixed(3)}) * 0.3 + sin(abstime * ${c} + ${(phase * 2.3).toFixed(3)}) * 0.2)`;
  const axis = (values: readonly number[], k: number, phase: number, freq: readonly [number, number, number]): StoredParameter =>
    expressionSlot(`${sampled(values)} + ${wob(freq[0], freq[1], freq[2], phase)} * ${fixed(shake * k)}`, values[0]!);
  const eye = (i: number): number[] => setup.eye.map((v) => v[i]!);
  const aim = (i: number): number[] => setup.aim.map((v) => v[i]!);
  return {
    "eye.x": axis(eye(0), 1, 0.3, [2.1, 5.3, 11.1]),
    "eye.y": axis(eye(1), 0.8, 1.1, [2.7, 6.1, 12.7]),
    "eye.z": axis(eye(2), 0.6, 2.2, [1.9, 4.7, 9.3]),
    "lookAt.x": axis(aim(0), 3, 2.0, [1.7, 4.9, 10.3]),
    "lookAt.y": axis(aim(1), 2.5, 2.7, [2.3, 5.1, 9.9]),
    "lookAt.z": axis(aim(2), 1, 0.4, [1.6, 3.5, 7.7]),
    fov: expressionSlot(sampled(setup.fov), setup.fov[0]!),
    roll: expressionSlot(`${sampled(setup.roll)} + ${wob(1.5, 3.4, 7.3, 0.9)} * 1.2`, setup.roll[0]!),
  };
}
