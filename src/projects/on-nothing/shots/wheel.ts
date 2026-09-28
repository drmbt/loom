import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { drivenCar } from "../car-rig.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { carAreas } from "../scene-facts.ts";

/**
 * T1407b — THE WHEEL SHOT (the reference's 2:00.1–2:03.2, 73 frames): a camera on the floor
 * just behind a white car's rear wheel, looking forward along its flank at a car parked nose
 * to nose with it, lamps on; a heavy dutch angle; outlined letters floating across the frame on
 * the beat.
 *
 * Measured from the reference, frame by frame (ref.mp4 from 120.125 s):
 * - the reference's wheel does not turn (its slots hold their angle within a few degrees over
 *   the 3 s) and the far car barely grows (+6 % ± 5 %). The owner wants it DRIVING instead
 *   (2026-09-27: "the car visibly drives and the wheel visibly spins"), so the car rolls
 *   toward the far car at walking pace with the camera riding on it;
 * - it is a REAR wheel: the round fuel flap sits on the panel between the lens and the arch,
 *   the flank runs away left of the wheel with the door mirror above it;
 * - the hub sits at (0.44, 0.71) of the frame, its disc (430 px radius) ~1.1 m from the lens;
 *   the camera is ~0.5 m off the floor, 26–27° vertical fov;
 * - the far car's lamps (10 m, 245 px apart) sit at (0.23, 0.33)–(0.35, 0.42): the line
 *   through them tilts 18° (the camera's roll), rising to 25° over the last 0.6 s;
 * - letters glow on every eighth note (a 0.2755 s period, the first at 0.117 s), one big
 *   burst at 0.375–0.5 s and a strobe on alternate frames from 2.25 s to the cut.
 *
 * The car is the GLB's rigged car (tools/blender/on-nothing/wheel_rig.py): the shot turns it
 * round and stands it on its own mark, so a white car of the tableau faces it — and the lens —
 * at 10 m.
 */

/** Seconds: the reference shot's length (73 frames at 23.976). */
export const WHEEL_SECONDS = 3.04;
/** The car's speed (m/s), and the moment it stands on the solved mark (s, mid-shot). */
const SPEED = 0.9;
const ON_MARK = 1.5;
/** The car turned round on its mark (radians), to face the hero. */
export const WHEEL_TURN = Math.PI;
/** The camera, from the rear wheel's hub: behind it, outboard of it, above the floor (m). */
const BEHIND = 0.77;
const OUTBOARD = 0.35;
const HEIGHT = 0.55;
/** The far car: which one (a white one, as the reference's), and where it must sit from the lens: distance (m) and azimuth off the flank toward the car (degrees). */
const FAR_CAR = "1";
const FAR_DISTANCE = 10;
const FAR_AZIMUTH = -3;
/**
 * The camera's yaw off the flank toward the car, its pitch, its roll and its vertical fov
 * (degrees). Solved (with BEHIND, OUTBOARD, FAR_AZIMUTH) against the reference's hub, far lamps
 * and disc size, with the far car held just outboard of the flank so the flank cannot hide it
 * (this model's body stands prouder of its wheels than the reference's): the lamps land within
 * 0.03 of the reference's across and ~0.1 lower; the hub ~0.05 right. A 36° vertical fov is an
 * ~20 mm lens on the reference's 2.39:1 frame, as the breakdown's "18–28 mm primes".
 */
const YAW = 18;
const PITCH = 2;
const ROLL = 18;
const FOV = 36;

type Vec3 = readonly [number, number, number];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** About +y by `angle` radians (right-handed, as the kernel's axisAngle). */
const turnY = (v: Vec3, angle: number): Vec3 => [v[0] * Math.cos(angle) + v[2] * Math.sin(angle), v[1], -v[0] * Math.sin(angle) + v[2] * Math.cos(angle)];
const f = (value: number): string => value.toFixed(5);

/** GLSL's smoothstep as an expression (the grammar has none). */
function smooth(edge0: number, edge1: number, x: string): string {
  const t = `clamp((${x} - ${f(edge0)}) / ${f(edge1 - edge0)}, 0, 1)`;
  return `(${t} ^ 2 * (3 - 2 * ${t}))`;
}

/** Handheld wander, −1..1: three incommensurate sines. */
function wander(seed: number): string {
  return `(0.55 * sin(abstime * ${f(1.3 + seed * 0.21)} + ${f(seed * 1.7)}) + 0.3 * sin(abstime * ${f(2.9 + seed * 0.37)} + ${f(seed * 2.3 + 1)}) + 0.15 * sin(abstime * ${f(6.1 + seed * 0.53)} + ${f(seed * 0.9 + 2)}))`;
}

export interface WheelRig {
  readonly area: string;
  /** The rigged car's name as its lamps carry it (`lamp.head.<car>l`). */
  readonly car: string;
  /** The car's forward on its mark (world), which is where the lens looks. */
  readonly forward: Vec3;
  /** Outboard of the wheel the camera sits by. */
  readonly side: Vec3;
  /** The car's origin (its rig root's pivot) in the GLB, about which it turns. */
  readonly origin: Vec3;
  /** The world offset that moves the turned car from its tableau mark to the shot's. */
  readonly place: Vec3;
  /** The wheel's hub on the shot's mark (before the creep). */
  readonly hub: Vec3;
}

/** A rest point of the rigged car, on the shot's mark (before the creep). */
function onMark(rig: Pick<WheelRig, "origin" | "place">, at: Vec3): Vec3 {
  return add(add(rig.origin, turnY(sub(at, rig.origin), WHEEL_TURN)), rig.place);
}

/** The rigged car and where the shot puts it; undefined when the GLB carries no rig. */
export function wheelRig(facts: OnNothingFacts): WheelRig | undefined {
  // The area whose rig root is its own car (the decoder lists every rig's parts in each area).
  const area = carAreas(facts).find((entry) => facts.areas.get(entry)?.partTable.some((part) => part.name === entry) === true);
  if (area === undefined) return undefined;
  const parts = facts.areas.get(area)!.partTable;
  const car = drivenCar(parts);
  const name = car.body.name.slice(3);
  const origin = car.body.pivot;
  const forward = turnY(car.forward, WHEEL_TURN);
  // The lens looks along `forward` with the car on its right: outboard is to its left.
  const side: Vec3 = [forward[2], 0, -forward[0]];
  // The rear wheel on that side.
  const rear = parts
    .filter((part) => new RegExp(`^${car.body.name}_wheel_r[lr]$`).test(part.name))
    .sort((a, b) => dot(turnY(sub(b.pivot, origin), WHEEL_TURN), side) - dot(turnY(sub(a.pivot, origin), WHEEL_TURN), side))[0];
  if (rear === undefined) throw new Error(`wheelRig: ${area} has no rear wheel parts (${car.body.name}_wheel_r*).`);
  // The far car, between its two lamps.
  const far = [...facts.markers.values()].filter((marker) => marker.name === `lamp.head.${FAR_CAR}l` || marker.name === `lamp.head.${FAR_CAR}r`);
  if (far.length !== 2 || FAR_CAR === name) throw new Error(`wheelRig: car ${FAR_CAR} has no pair of headlights to face the lens.`);
  const target = scale(far.reduce<Vec3>((sum, marker) => add(sum, marker.position), [0, 0, 0]), 1 / far.length);
  // eye = hub − F·BEHIND + S·OUTBOARD, and the target sits FAR_DISTANCE along F from the eye,
  // turned FAR_AZIMUTH toward the car (−S): solve for the hub, level with the rest hub.
  const az = (FAR_AZIMUTH * Math.PI) / 180;
  const along = FAR_DISTANCE * Math.cos(az) - BEHIND;
  const across = FAR_DISTANCE * Math.sin(az) - OUTBOARD;
  const hub: Vec3 = [target[0] - forward[0] * along + side[0] * across, rear.pivot[1], target[2] - forward[2] * along + side[2] * across];
  const turned = onMark({ origin, place: [0, 0, 0] }, rear.pivot);
  const place: Vec3 = [hub[0] - turned[0], 0, hub[2] - turned[2]];
  return { area, car: name, forward, side, origin, place, hub };
}

/** Metres the rigged car has driven past its mark by `abstime` (negative before it; the placement is `place`). */
export const WHEEL_DRIVE = `((abstime - ${ON_MARK}) * ${SPEED})`;

/** A rest point of the rigged car as it rides: turned, placed, crept. */
export function riding(rig: WheelRig, key: string, at: Vec3): Record<string, StoredParameter> {
  const base = onMark(rig, at);
  return Object.fromEntries([0, 1, 2].map((axis) => [`${key}.${"xyz"[axis]}`, expressionSlot(`${f(base[axis]!)} + ${f(rig.forward[axis]!)} * ${WHEEL_DRIVE}`, base[axis]!)]));
}

/** A rest direction of the rigged car on its mark. */
export function turned(direction: Vec3): Vec3 {
  return turnY(direction, WHEEL_TURN);
}

/** Where the lens stands on the mark (before the creep and the handheld drift). */
function eyeOf(rig: WheelRig): Vec3 {
  return [rig.hub[0] - rig.forward[0] * BEHIND + rig.side[0] * OUTBOARD, HEIGHT, rig.hub[2] - rig.forward[2] * BEHIND + rig.side[2] * OUTBOARD];
}

/**
 * The camera: 0.5 m off the floor behind the rear wheel, turned YAW° off the flank toward the
 * car, pitched PITCH°, rolled ROLL°, riding with the car. Handheld: a wander in yaw (±1.1°),
 * pitch (±0.8°), roll (±2.5°) and position (±12 mm), and the reference's late roll of 6° more
 * over its last 0.6 s.
 */
export function wheelCamera(rig: WheelRig): Record<string, StoredParameter> {
  const eye = eyeOf(rig);
  const yaw = `(${f((YAW * Math.PI) / 180)} + ${wander(1)} * 0.02)`;
  const pitch = `(${f((PITCH * Math.PI) / 180)} + ${wander(2)} * 0.014)`;
  const aimAxis = (axis: number): string =>
    `${f(eye[axis]!)} + ${f(rig.forward[axis]!)} * ${WHEEL_DRIVE} + 6 * (${f(rig.forward[axis]!)} * cos(${yaw}) + ${f(-rig.side[axis]!)} * sin(${yaw})) + ${axis === 1 ? 6 : 0} * ${pitch}`;
  const drift = (axis: number): string => `${wander(3 + axis)} * 0.012`;
  return {
    eye: [...eye],
    "eye.x": expressionSlot(`${f(eye[0])} + ${f(rig.forward[0])} * ${WHEEL_DRIVE} + ${drift(0)}`, eye[0]),
    "eye.y": expressionSlot(`${f(eye[1])} + ${drift(1)}`, eye[1]),
    "eye.z": expressionSlot(`${f(eye[2])} + ${f(rig.forward[2])} * ${WHEEL_DRIVE} + ${drift(2)}`, eye[2]),
    "lookAt.x": expressionSlot(aimAxis(0), eye[0]),
    "lookAt.y": expressionSlot(aimAxis(1), eye[1]),
    "lookAt.z": expressionSlot(aimAxis(2), eye[2]),
    roll: expressionSlot(`${ROLL} - ${wander(6)} * 2.5 + 6 * ${smooth(2.4, 3.0, "abstime")}`, ROLL),
    fov: FOV,
  };
}

/**
 * The shot's light, besides the cars' headlight projectors, riding with the car as a film
 * crew's would: ONE key, the far car's beams reaching the wheel — a cool point 4 m ahead of
 * the lens and outboard, so the disc's face and the arch lip catch it from the front left and
 * the panel beside the lens, lit at an ever flatter angle as it nears the lens, falls off to
 * dark, as the reference's does. It casts, so the wheel throws its shadow back along the
 * floor. A breath of cool top. No sodium: the reference's floor here is cold.
 */
export function wheelLights(rig: WheelRig): Array<Record<string, StoredParameter>> {
  const eye = eyeOf(rig);
  const riding = (at: Vec3): Record<string, StoredParameter> => ({
    position: [...at],
    "position.x": expressionSlot(`${f(at[0])} + ${f(rig.forward[0])} * ${WHEEL_DRIVE}`, at[0]),
    "position.z": expressionSlot(`${f(at[2])} + ${f(rig.forward[2])} * ${WHEEL_DRIVE}`, at[2]),
  });
  const key = add(add(eye, scale(rig.forward, KEY[0])), scale(rig.side, KEY[1]));
  return [
    { kind: "point", ...riding([key[0], KEY[2], key[2]]), color: [0.8, 0.93, 1, 1], intensity: KEY[3], shadows: true, shadowExtent: 12, shadowSoftness: 2 },
    { kind: "directional", direction: [0.25, -1, -0.2], color: [0.85, 0.95, 1, 1], intensity: 0.03 },
  ];
}

/** The key: metres ahead of the lens, outboard, above the floor; intensity. */
const KEY = [4.2, 2.0, 0.5, 16] as const;

/**
 * The grade, set against the reference's frame: mids teal-grey (the disc and the lit panel at
 * rgb 119,138,137 — green and blue a seventh over red), the floor near black (11,14,15), the
 * blacks cool, the lamps neutral white.
 */
export const WHEEL_GRADE: Record<string, StoredParameter> = {
  exposure: 0.1,
  black: 0.03,
  contrast: 1.25,
  saturation: 0.55,
  keepWarm: 0.6,
  steel: [0.88, 1.03, 1.03],
  shadowTint: [0.9, 1.04, 1.06, 1],
  split: 0.7,
};

/**
 * Screen-space reflections for this shot: the flank's white clear coat, seen at a grazing
 * angle, catches lamp reflections through its orange-peel normals as bright specks (the
 * pass's own fix is T1412b). Here the SSR keeps only what is rough enough to smear: the paint
 * reflects the room through the Render's environment (the HDRI) instead.
 */
export const WHEEL_SSR: Record<string, StoredParameter> = { roughnessCutoff: 0.55, keepBright: 12, dimShare: 0.05, strength: 0.6 };

/** Depth of field: the wheel's face in focus at ~1.1 m; the panel by the lens melts, the far car softens. */
export const WHEEL_DOF: Record<string, StoredParameter> = { focusDistance: 1.15, aperture: 0.7, maxRadius: 22 };

/** The glyph row's timing and placement (measured; see the module comment). */
export const WHEEL_GLYPHS: Record<string, StoredParameter> = {
  gain: 1.8,
  beat: 0.2755,
  phase: 0.117,
  burstAt: 0.375,
  burstLength: 0.16,
  strobeFrom: 2.25,
  strobeTo: 3.2,
};

/**
 * DIGITAL GLYPHS (layer 7): thin outlined lowercase letters — "cocoon", the next title's
 * word — in a row across the frame, and two big ones on the bursts. Measured: the row sits at
 * 0.54 of the height, a letter every 0.245 of the width, 0.2 of the height tall, soft as if
 * out of focus; each beat turns every letter about its horizontal axis (upright one beat, near
 * flat the next); the big pair fills half the height and wobbles on the strobe. Each letter is
 * EXTRUDED upward — a translucent column its own width, brightest along its sides, as long as
 * the letter is tall (the reference's glyphs read as glass cylinders) — and written into the
 * HDR picture before the optics, so the streak glass lengthens it further.
 * Custom WGSL: Input = the frame.
 */
export const WHEEL_GLYPHS_WGSL = `struct Params {
  gain: f32, // @default 1.8  Letter radiance at a beat's peak (HDR: just over the streak glass's threshold).
  row: f32, // @default 0.54  Row height, fraction of the frame from the top.
  pitch: f32, // @default 0.245  Letter spacing, fraction of the frame width.
  size: f32, // @default 0.2  Letter height, fraction of the frame height.
  stroke: f32, // @default 0.03  Stroke half-width, fraction of a letter's height.
  soft: f32, // @default 0.09  Defocus of the row, fraction of a letter's height.
  extrude: f32, // @default 1.1  Column above each letter, in letter heights.
  column: f32, // @default 0.55  The column's brightness against the letter's.
  ghost: f32, // @default 0.04  Level the row idles at between beats.
  beat: f32, // @default 0.2755  Seconds between pulses (an eighth note).
  phase: f32, // @default 0.117  First pulse, seconds.
  decay: f32, // @default 0.05  A pulse's 1/e fall, seconds.
  burstAt: f32, // @default 0.375  The big burst, seconds.
  burstLength: f32, // @default 0.16  Its length, seconds.
  strobeFrom: f32, // @default 2.25  The strobe's start, seconds.
  strobeTo: f32, // @default 3.2  Its end.
  tint: vec3f, // @default 1  Letter colour.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

fn hash(n: f32) -> f32 { return fract(sin(n * 91.3458 + 1.7) * 47453.5453); }

fn ellipse(p: vec2f, r: vec2f) -> f32 {
  // Distance to an ellipse's outline, good near the curve (a thin stroke is all we need).
  let k = length(p / r);
  return (k - 1.0) * min(r.x, r.y);
}

// Signed distance (letter heights) from the stroke's centre line of one lowercase letter:
// 0 = c, 1 = o, 2 = n. Origin at the letter's centre, y up, height 1.
fn letter(p: vec2f, which: u32) -> f32 {
  if (which == 2u) {
    // n: two stems and an arch over them.
    let stems = min(length(vec2f(abs(p.x + 0.3), max(abs(p.y + 0.18) - 0.32, 0.0))), length(vec2f(abs(p.x - 0.3), max(abs(p.y + 0.18) - 0.32, 0.0))));
    let arch = select(1e3, abs(ellipse(p - vec2f(0.0, 0.14), vec2f(0.3, 0.36))), p.y > 0.14);
    return min(stems, arch);
  }
  let r = vec2f(0.4, 0.5);
  let ring = abs(ellipse(p, r));
  if (which == 1u) { return ring; }
  // c: the ring with its right side open, ends rounded.
  let a = atan2(p.y, p.x);
  if (abs(a) > 0.8) { return ring; }
  let end = vec2f(cos(0.8) * r.x, sin(0.8) * r.y);
  return min(length(p - end), length(p - vec2f(end.x, -end.y)));
}

// The word, a letter per slot: c o c o o n.
fn slotLetter(i: i32) -> u32 {
  switch (i) {
    case 0, 2: { return 0u; }
    case 5: { return 2u; }
    default: { return 1u; }
  }
}

// Glow of a stroke at distance d (letter heights): a defocused, gaussian edge and a faint halo.
fn glow(d: f32, stroke: f32, soft: f32) -> f32 {
  let e = max(d - stroke, 0.0) / soft;
  return exp(-e * e) + 0.03 * exp(-e * 0.3);
}

// The letter smeared upward over params.extrude letter heights, fading with the reach:
// its sides stack into bright walls, its arcs into a faint filled band.
fn column(p: vec2f, which: u32, stroke: f32, soft: f32, gain: f32) -> f32 {
  var sum = 0.0;
  for (var k = 1; k <= 12; k = k + 1) {
    let f = f32(k) / 12.0;
    sum = sum + glow(letter(p - vec2f(0.0, f * params.extrude), which), stroke, soft * 1.4) * (1.0 - f * 0.8);
  }
  return sum / 12.0 * params.column * gain;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let t = frameU.absTime;
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  // Screen in frame heights, y up.
  let s = vec2f(uv.x * aspect, 1.0 - uv.y);

  // The beat: which pulse, and how far into it.
  let k = floor(max(t - params.phase, 0.0) / params.beat);
  let into = t - params.phase - k * params.beat;
  let pulse = select(0.0, exp(-into / params.decay), t >= params.phase);
  let frameIndex = floor(t * 24.0 + 0.5);
  let strobe = step(params.strobeFrom, t) * step(t, params.strobeTo);
  let strobeOn = strobe * (1.0 - fract(frameIndex * 0.5) * 2.0);
  let burst = step(params.burstAt, t) * step(t, params.burstAt + params.burstLength);

  // THE ROW: each beat tips every letter about its horizontal axis and nudges its size.
  var light = 0.0;
  let tip = select(0.0, 1.2, hash(k) > 0.5);
  let squash = max(cos(tip + (hash(k + 7.0) - 0.5) * 0.4), 0.2);
  let size = params.size * (0.85 + 0.35 * hash(k + 3.0));
  // On the strobe the row holds dim between the big frames (the reference's 2.9 s).
  let rowLevel = max(params.ghost, pulse * (1.0 - strobe)) + strobe * (1.0 - strobeOn) * 0.35;
  let drift = t * 0.012;
  for (var i = 0; i < 6; i = i + 1) {
    let cx = (f32(i) + 0.5) * params.pitch * aspect + (hash(f32(i) + k * 3.1) - 0.5) * 0.05 - drift;
    let cy = 1.0 - params.row + (hash(f32(i) * 1.7 + k) - 0.5) * 0.04;
    var p = (s - vec2f(cx, cy)) / size;
    p.y = p.y / squash;
    let d = letter(p, slotLetter(i));
    light = light + (glow(d, params.stroke, params.soft) + column(p, slotLetter(i), params.stroke, params.soft, 1.0)) * rowLevel;
    // A dim echo a little below each letter (the reference's doubled glyphs).
    let q = p + vec2f(0.0, 0.42);
    light = light + glow(letter(q, slotLetter(i)), params.stroke, params.soft * 1.6) * rowLevel * 0.22;
  }

  // THE BIG PAIR: a "c" left, an "o" right, half the frame tall, on the burst and the strobe.
  let bigLevel = max(burst * (0.6 + 0.4 * pulse), strobeOn);
  if (bigLevel > 0.0) {
    let bigSize = 0.5 * (1.0 + 0.15 * hash(frameIndex));
    let bigSquash = select(0.72, 1.0, hash(frameIndex + 11.0) > 0.5);
    for (var j = 0; j < 2; j = j + 1) {
      let cx = select(0.78, 0.2, j == 0) * aspect + (hash(frameIndex + f32(j) * 5.0) - 0.5) * 0.08;
      var p = (s - vec2f(cx, 0.64)) / bigSize;
      p.y = p.y / bigSquash;
      p.x = p.x + 0.1 * sin(p.y * 4.0 + t * 29.0 + f32(j)) * strobe;
      let which = select(1u, 0u, j == 0);
      // thinner and crisper than the row (they are nearer the focus), their columns stronger
      light = light + (glow(letter(p, which), params.stroke * 0.45, params.soft * 0.35) + column(p, which, params.stroke * 0.45, params.soft * 0.5, 1.8)) * bigLevel;
    }
  }
  return vec4f(base.rgb + params.tint * light * params.gain, base.a);
}`;

export interface HazeLightLike {
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/** The haze table with the rigged car's own lamps on its mark (turned and placed). */
export function placedHaze<T extends HazeLightLike>(facts: OnNothingFacts, rig: WheelRig, lights: readonly T[]): T[] {
  const own = [...facts.markers.values()].filter((marker) => marker.name.startsWith(`lamp.head.${rig.car}`)).map((marker) => marker.position);
  return lights.map((light) =>
    own.some((position) => Math.hypot(position[0] - light.position[0], position[1] - light.position[1], position[2] - light.position[2]) < 1e-4)
      ? { ...light, position: onMark(rig, light.position), direction: turned(light.direction) }
      : light,
  );
}
