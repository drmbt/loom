import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import type { Bone } from "../scene-facts.ts";
import { NORMAL_WALK, armPose, standingLegs, type KeyPose, type Pose } from "./gait.ts";
import type { CameraTake, CarMove, FigureTake } from "./wide.ts";

/**
 * T1407b (wide) — THE TAKES of the wide warehouse coverage: one set-up of the reference each.
 * Times are the take's own clock (abstime 0 = the row's in-point unless the EDL's `from` says
 * otherwise). Cameras marked FITTED are least-squares solves against the reference's
 * headlight blobs (the reference frame named), with the tableau's cars where they stand in
 * the GLB; the figure's mark is the floor point under its feet in that frame.
 */
export interface WideTake {
  readonly name: string;
  /** The reference rows this take plays. */
  readonly rows: readonly number[];
  /** Cars moved from the tableau's marks (by index), or hidden. */
  readonly cars?: Readonly<Record<number, CarMove | "hide">>;
  readonly camera: CameraTake;
  readonly figure: FigureTake;
  readonly second?: FigureTake;
  /** The cars' low key (default: 4 m behind the lens, 0.45 m up, intensity 22). */
  readonly key?: { readonly position: readonly [number, number, number]; readonly intensity: number };
  /** The soft fill on the figure (default: high, 1.5 m toward the lens and 1.1 m to its side). */
  readonly fill?: { readonly position: readonly [number, number, number]; readonly intensity: number };
  /** An expression 0..1 multiplying key and fill: the reference's strobe. */
  readonly strobe?: string;
  readonly focus?: number;
  readonly aperture?: number;
  /** The streak columns' reach, fraction of the frame height (or an expression over abstime). */
  readonly reach?: number | string;
  readonly grade?: Record<string, StoredParameter>;
  /** Any other parameter, by node id. */
  readonly set?: Readonly<Record<string, Record<string, StoredParameter>>>;
}

const face = (pitch: number, turn: number, tilt = 0): Pose => ({ neck: [pitch * 0.6, turn * 0.6, tilt], head: [pitch * 0.4, turn * 0.4, tilt * 0.5] });

/** Row 54 (0:53.4): standing right of the hero car, square to the lens, both hands up at the shoulders throwing signs. */
function signs(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.17, 0.25, 12);
  const up = (spread: number): Pose => ({
    ...armPose(bones, "L", { flex: 70 + spread, out: 28, elbow: 120, inward: 60, wrist: [-0.35, 0, 0.1] }),
    ...armPose(bones, "R", { flex: 74 - spread, out: 26, elbow: 124, inward: 60, wrist: [-0.35, 0, -0.1] }),
  });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, legs, ...parts);
  return [
    { t: 0, pose: pose(up(0), face(-0.06, 0.05)) },
    { t: 0.35, pose: pose(up(6), face(-0.1, -0.04, 0.05)) },
    { t: 0.7, pose: pose(up(-4), face(-0.04, 0.06, -0.04)) },
    { t: 1.1, pose: pose(up(5), face(-0.1, 0, 0.03)) },
    { t: 1.5, pose: pose(up(0), face(-0.06, 0.05)) },
  ];
}

/** The reference's frame rate: a take's clock is reference seconds from its origin. */
const REF_FPS = 24000 / 1001;

/**
 * A strobe: 1 through each listed reference frame (as the take's clock sees it, `origin` s
 * being its 0), `floor` between them. The window is one output frame wide from the frame's
 * time, so every sub-frame of a --final render lands inside it.
 */
function strobe(frames: readonly number[], origin: number, floor: number): string {
  const hits = frames.map((f) => {
    const t = f / REF_FPS - origin;
    return `(abstime >= ${(t - 0.002).toFixed(4)}) * (abstime < ${(t + 1 / 24 - 0.002).toFixed(4)})`;
  });
  return `max(${floor}, ${hits.join(" + ")})`;
}

/** Rows 10–11 (0:05.70 on): the strobe wide — a lit frame now and then, the lamps alone between. */
const STROBE_ORIGIN = 5.7;
const STROBE_LIT = [149, 152, 169, 179, 195, 215, 218];
const at = (f: number): number => Number((f / REF_FPS - STROBE_ORIGIN).toFixed(3));

function strobeDance(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.24, 0.1, 16);
  const chest: Pose = { ...armPose(bones, "L", { flex: 35, out: 40, elbow: 95, inward: 75, wrist: [-0.3, 0, 0.2] }), ...armPose(bones, "R", { flex: 32, out: 38, elbow: 100, inward: 80, wrist: [-0.3, 0, -0.2] }) };
  const head: Pose = { ...armPose(bones, "L", { flex: 140, out: 40, elbow: 125, inward: 20 }), ...armPose(bones, "R", { flex: 135, out: 45, elbow: 120, inward: 20 }) };
  const face: Pose = { ...armPose(bones, "L", { flex: 80, out: 20, elbow: 120, inward: 60, wrist: [-0.4, 0, 0] }), ...armPose(bones, "R", { flex: 75, out: 25, elbow: 125, inward: 55, wrist: [-0.4, 0, 0] }) };
  const one: Pose = { ...armPose(bones, "L", { flex: 150, out: 30, elbow: 90, inward: 10 }), ...armPose(bones, "R", { flex: 20, out: 20, elbow: 40 }) };
  const lean = (pitch: number, turn: number): Pose => ({ spine: [pitch * 0.5, turn * 0.4, 0], chest: [pitch * 0.5, turn * 0.4, 0], neck: [-0.1, 0, 0] });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, legs, ...parts);
  return [
    { t: at(147), pose: pose(chest, lean(0.12, 0)) },
    { t: at(152), pose: pose(chest, lean(0.18, 0.1)) },
    { t: at(169), pose: pose(head, lean(-0.02, -0.1)) },
    { t: at(179), pose: pose(head, lean(0.04, 0.08)) },
    { t: at(195), pose: pose(face, lean(0.08, 0)) },
    { t: at(215), pose: pose(one, lean(0.02, -0.1)) },
    { t: at(218), pose: pose(one, lean(0.04, 0)) },
  ];
}

/** Row 19 (0:18.39 on): a low dance in front of the hero car; the clock is reference seconds from 0:18.39. */
function lowDance(bones: readonly Bone[]): KeyPose[] {
  // a wide lunge: the right leg (screen left) thrown out and down, the weight sunk on the left
  const lunge: Pose = {
    thighR: [-0.2, 0, -0.95], shinR: [0.25, 0, 0.15], footR: [0.1, 0, 0.8],
    thighL: [-0.85, 0.25, 0.25], shinL: [1.3, 0, 0], footL: [-0.45, 0, -0.2],
    pelvis: [0.15, 0.3, 0.12], spine: [0.25, 0.1, -0.15], chest: [0.15, 0.1, -0.05],
  };
  const upright: Pose = { ...standingLegs(bones, 0.2, -0.3, 14), spine: [0.08, 0, 0], chest: [0.05, 0, 0] };
  const chest = (d: number): Pose => ({ ...armPose(bones, "L", { flex: 30 + d, out: 35, elbow: 100, inward: 70 }), ...armPose(bones, "R", { flex: 45 - d, out: 30, elbow: 115, inward: 60 }) });
  const low = (d: number): Pose => ({ ...armPose(bones, "L", { flex: 10 + d, out: 15, elbow: 60, inward: 30 }), ...armPose(bones, "R", { flex: 35 - d, out: 20, elbow: 90, inward: 60 }) });
  const look = (pitch: number, turn: number): Pose => ({ neck: [pitch * 0.6, turn * 0.6, 0], head: [pitch * 0.4, turn * 0.4, 0] });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, ...parts);
  const t = (f: number): number => Number(((f - 441) / REF_FPS).toFixed(3));
  return [
    { t: t(441), pose: pose(lunge, chest(0), look(0.25, 0.3)) },
    { t: t(450), pose: pose(lunge, chest(8), look(0.3, 0.35)) },
    { t: t(459), pose: pose(upright, low(0), look(0.2, 0.1)) },
    { t: t(470), pose: pose(upright, low(10), look(0.35, 0.2)) },
    { t: t(484), pose: pose(upright, chest(15), look(0.1, -0.1)) },
    { t: t(494), pose: pose(upright, chest(-10), look(0.15, 0.15)) },
    { t: t(505), pose: pose(upright, low(5), look(0.4, 0.1)) },
    { t: t(517), pose: pose(upright, chest(5), look(0.2, 0)) },
  ];
}

/** Row 13 (0:10.093 on, f242–f264): hands at the temples, a strobe blink, then down into a squat, forearms on the knees. */
const t13 = (f: number): number => Number(((f - 242) / REF_FPS).toFixed(3));
function squat(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.16, 0.1, 14);
  const low: Pose = {
    thighL: [-1.45, 0.25, 0.3], shinL: [2.05, 0, 0], footL: [-0.55, 0.1, -0.2],
    thighR: [-1.45, -0.25, -0.3], shinR: [2.05, 0, 0], footR: [-0.55, -0.1, 0.2],
    spine: [0.35, 0, 0], chest: [0.15, 0, 0],
  };
  const temples: Pose = { ...armPose(bones, "L", { flex: 165, out: 35, elbow: 120, inward: 90, wrist: [-0.3, 0, 0] }), ...armPose(bones, "R", { flex: 162, out: 38, elbow: 118, inward: 90, wrist: [-0.3, 0, 0] }) };
  const knees: Pose = { ...armPose(bones, "L", { flex: 55, out: 20, elbow: 30, inward: 25 }), ...armPose(bones, "R", { flex: 50, out: 22, elbow: 35, inward: 25 }) };
  const look = (pitch: number, turn: number): Pose => ({ neck: [pitch * 0.6, turn * 0.6, 0], head: [pitch * 0.4, turn * 0.4, 0] });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, ...parts);
  return [
    { t: t13(242), pose: pose(legs, temples, look(0.05, 0)) },
    { t: t13(246), pose: pose(legs, temples, look(0.1, -0.1)) },
    { t: t13(251), pose: pose(legs, knees, { spine: [0.2, 0, 0] }, look(0.2, 0)) },
    { t: t13(257), pose: pose(legs, knees, { spine: [0.3, 0, 0], chest: [0.15, 0, 0], thighL: [-0.5, 0.2, 0.2], shinL: [0.8, 0, 0], thighR: [-0.5, -0.2, -0.2], shinR: [0.8, 0, 0] }, look(-0.15, 0)) },
    { t: t13(262), pose: pose(low, knees, look(-0.1, 0)) },
    { t: t13(264), pose: pose(low, knees, look(0.05, 0.05)) },
  ];
}

/** Row 34 (0:37.663 on): standing in the gap, counting at the chest, then a hand up to the cap. */
function gapStand(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.13, 0.3, 10);
  const count: Pose = { ...armPose(bones, "L", { flex: 40, out: 12, elbow: 95, inward: 55 }), ...armPose(bones, "R", { flex: 38, out: 14, elbow: 105, inward: 60, wrist: [-0.3, 0, 0] }) };
  const cap: Pose = { ...armPose(bones, "L", { flex: 150, out: 55, elbow: 130, inward: 10 }), ...armPose(bones, "R", { flex: 20, out: 10, elbow: 40, inward: 30 }) };
  const look = (pitch: number, turn: number): Pose => ({ neck: [pitch * 0.6, turn * 0.6, 0], head: [pitch * 0.4, turn * 0.4, 0] });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, legs, ...parts);
  return [
    { t: 0, pose: pose(count, look(0.25, 0.05)) },
    { t: 0.8, pose: pose(count, look(0.1, -0.1)) },
    { t: 1.4, pose: pose(count, look(0.0, 0.05)) },
    { t: 1.9, pose: pose(cap, look(-0.05, -0.2)) },
    { t: 2.46, pose: pose(cap, look(0.05, -0.4)) },
  ];
}

/** Row 37 (0:41.500 on, f995–f1015): a stepping dance beside the hero car, turned to screen right. */
const t37 = (f: number): number => Number(((f - 995) / REF_FPS).toFixed(3));
function stepDance(bones: readonly Bone[]): KeyPose[] {
  const stand = standingLegs(bones, 0.15, 0.3, 12);
  const lift = (side: "L" | "R"): Pose => ({ ...stand, [`thigh${side}`]: [-0.9, 0, 0], [`shin${side}`]: [1.2, 0, 0], [`foot${side}`]: [-0.2, 0, 0] });
  const arms = (d: number): Pose => ({ ...armPose(bones, "L", { flex: 45 + d, out: 30, elbow: 110, inward: 70 }), ...armPose(bones, "R", { flex: 35 - d, out: 25, elbow: 95, inward: 60 }) });
  const look = (pitch: number, turn: number): Pose => ({ neck: [pitch * 0.6, turn * 0.6, 0], head: [pitch * 0.4, turn * 0.4, 0] });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, ...parts);
  return [
    { t: t37(995), pose: pose(stand, arms(0), look(0.3, -0.3)) },
    { t: t37(1000), pose: pose(lift("R"), arms(10), look(0.2, -0.2), { spine: [0.15, 0, 0] }) },
    { t: t37(1004), pose: pose(stand, arms(-5), look(0.35, -0.3)) },
    { t: t37(1008), pose: pose(lift("L"), arms(8), look(0.25, -0.1), { spine: [0.12, 0, 0] }) },
    { t: t37(1012), pose: pose(stand, arms(0), look(0.4, -0.3)) },
  ];
}

/** Row 37's light: steady, flashing up every third frame (f997 … f1009), dark on f995, fading from f1012. */
function flicker37(): string {
  const at = (f: number, a: number, b: number): string => `(abstime >= ${(t37(f) - 0.002).toFixed(4)}) * (abstime < ${(t37(b) - 0.002).toFixed(4)}) * ${a}`;
  const peaks = [997, 1000, 1003, 1006, 1009].map((f) => at(f, 0.3, f + 1));
  return `(1 - ${at(995, 0.65, 996)} + ${peaks.join(" + ")}) * (1 - 0.45 * smoothstep(${t37(1012)}, ${t37(1015)}, abstime))`;
}

/** Rows 38 and 40: standing in the gap between two cars, a hand to the cap, the other low. */
function capTouch(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.14, 0.2, 12);
  const cap: Pose = armPose(bones, "L", { flex: 160, out: 30, elbow: 120, inward: 90, wrist: [-0.3, 0, 0] });
  const low = (d: number): Pose => armPose(bones, "R", { flex: 15 + d, out: 12, elbow: 35 + d, inward: 30 });
  const reach: Pose = armPose(bones, "R", { flex: 55, out: 20, elbow: 60, inward: 40, wrist: [-0.4, 0, 0] });
  const look = (pitch: number, turn: number): Pose => ({ neck: [pitch * 0.6, turn * 0.6, 0], head: [pitch * 0.4, turn * 0.4, 0] });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, legs, ...parts);
  return [
    { t: 0, pose: pose(cap, low(0), look(0.1, 0.15)) },
    { t: 0.3, pose: pose(cap, low(10), look(0.05, 0.25)) },
    { t: 0.55, pose: pose(armPose(bones, "L", { flex: 20, out: 12, elbow: 40, inward: 30 }), reach, look(0.1, -0.1)) },
    { t: 0.9, pose: pose(armPose(bones, "L", { flex: 25, out: 14, elbow: 45, inward: 30 }), reach, look(0.15, -0.15)) },
  ];
}

/** Row 43: seen from behind, the right arm swung from overhead down and out across the hero car. */
function armSwing(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.15, -0.2, 12);
  const up: Pose = armPose(bones, "R", { flex: 170, out: 25, elbow: 25, inward: 0 });
  const across: Pose = armPose(bones, "R", { flex: 95, out: 55, elbow: 15, inward: 0 });
  const other: Pose = armPose(bones, "L", { flex: 10, out: 10, elbow: 30, inward: 30 });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, legs, other, ...parts);
  return [
    { t: 0, pose: pose(up, { chest: [0, -0.2, 0.05] }) },
    { t: 0.2, pose: pose(up, { chest: [0, -0.15, 0.05] }) },
    { t: 0.4, pose: pose(across, { chest: [0.05, 0.25, 0] }) },
    { t: 0.55, pose: pose(across, { chest: [0.05, 0.3, 0] }) },
  ];
}

/** Row 52b: hands at the waistband, shoulders rolling, head down. */
function waistband(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.15, 0.2, 12);
  const hands = (d: number): Pose => ({ ...armPose(bones, "L", { flex: 12 + d, out: 18, elbow: 55, inward: 55 }), ...armPose(bones, "R", { flex: 15 - d, out: 16, elbow: 60, inward: 55 }) });
  const look = (pitch: number, turn: number): Pose => ({ neck: [pitch * 0.6, turn * 0.6, 0], head: [pitch * 0.4, turn * 0.4, 0] });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, legs, ...parts);
  return [
    { t: 0, pose: pose(hands(0), look(0.25, 0.2), { chest: [0.1, 0.12, 0] }) },
    { t: 0.12, pose: pose(hands(6), look(0.35, 0.1), { chest: [0.12, -0.05, 0] }) },
    { t: 0.25, pose: pose(hands(-4), look(0.45, -0.1), { chest: [0.15, -0.15, 0] }) },
  ];
}

const NOD = { "neck.x": "0.05 * sin(abstime * 15.08)", "chest.y": "0.04 * sin(abstime * 7.54 + 0.6)" };

export const WIDE_TAKES: readonly WideTake[] = [
  {
    // 0 — row 54's wide part (0:53.428–0:54.138, f1281–f1297; before it a CU of the hands, after
    // it an MCU, both another subject). FITTED to ref f1291: nine lamps, residuals 7–30 px but for
    // the rear-right car (~50 px). Measured light: the car band ~44 with flashes (~66) on f1286,
    // f1289 and f1296. The clock: seconds from 0:53.428.
    name: "locked",
    rows: [54],
    camera: { eye: [-0.45, 0.97, 7.79], aim: [-0.18, 1.18, 1.8], fov: 28.2, hand: { tiltIn: -2, tilt: -2, settle: 1, shake: 0.15 } },
    figure: { area: "figbare", at: [1.1, 1.93], facing: -15, performance: signs, groove: NOD },
    strobe: `(1 + ${[1286, 1289, 1296].map((f) => `(abstime >= ${((f - 1281) / REF_FPS - 0.002).toFixed(4)}) * (abstime < ${((f - 1280) / REF_FPS - 0.002).toFixed(4)}) * 0.6`).join(" + ")})`,
    key: { position: [0.6, 1.3, 11.5], intensity: 16 },
    // the reference's lamps here are small crisp strips under thin, faint columns
    reach: 0.6,
    set: { optics: { streak: 0.35, bloom: 0.05 }, bright: { threshold: 3 } },
  },
  {
    // 1 — rows 10 and 11 (0:05.70–0:09.68): the strobe wide, cut frame by frame against the
    // phone MCU (another subject). One locked camera: FITTED to ref f149 (nine lamps, residuals
    // 2–17 px, the rear cars 1.2–1.3 m further left than the tableau's); the figure's mark from
    // its feet there. Lit only on the strobe's frames; between them the lamps and their columns.
    // The clock: reference seconds from 0:05.70 (the EDL's `from` = part start − 5.70).
    name: "strobe",
    rows: [10, 11],
    cars: { 3: { place: [-1.3, 0] }, 4: { place: [-1.16, 0] } },
    camera: { eye: [0.49, 1.48, 6.03], aim: [-0.11, 1.08, 0.08], fov: 36.3, hand: { tiltIn: -0.9, tilt: -0.9, settle: 1, shake: 0.12 } },
    figure: {
      area: "figbare",
      at: [0.03, 1.48],
      facing: 6,
      performance: strobeDance,
      groove: NOD,
      // it is up at the lens, a silhouette, for f186–f187 and again (lit) for f195; on its mark for f215
      path: [[at(184), 0.03, 1.48], [at(186.5), 0.1, 3.4], [at(189), 0.03, 1.48], [at(193), 0.03, 1.48], [at(195), 0.15, 3.0], [at(205), 0.0, 1.6]],
    },
    // measured: the dark frames read luma 30-40 on the car band, the lit ones 48-60
    strobe: strobe(STROBE_LIT, STROBE_ORIGIN, 0.35),
    // off the lens axis, so the figure's shadow falls beside the hero car, not over it
    key: { position: [2.8, 2.2, 8.5], intensity: 42 },
    // the reference's lamps are small crisp strips under thin, tall, faint columns
    reach: 0.6,
    set: { optics: { streak: 0.35, bloom: 0.05 }, bright: { threshold: 3 } },
  },
  {
    // 2 — row 19 (0:18.393–0:21.605, f441–f517), one continuous shot: the low lunge in front of
    // the hero car, the lamps smeared into fat columns that RETRACT to short blown boxes over
    // f455–f462 while the operator pushes in and tilts up onto the figure (ref f450, f488).
    // Judged, not fitted: a least-squares solve on f450's seven lamps would not settle (our
    // cars' lamps sit 0.1–0.2 m lower than the real ones). The clock: seconds from 0:18.393.
    name: "lunge",
    rows: [19],
    cars: { 3: { place: [-1.5, 0] }, 4: { place: [1.0, 0] } },
    camera: { eye: [0.2, 0.45, 4.3], aim: [0.02, 1.05, 0], fov: 42, hand: { tiltIn: 2.5, tilt: 0.4, settle: 2.5, shake: 0.45 }, move: [0.03, 0.01, -0.3], aimMove: [0.03, 0.17, 0] },
    figure: { area: "fig", at: [0.12, 1.3], facing: 15, performance: lowDance, groove: NOD },
    // well off to the side: on the lens axis the figure threw its shadow over the hero's grille
    key: { position: [4.5, 1.6, 5.0], intensity: 15 },
    reach: `(0.12 + 0.22 * (1 - smoothstep(${((455 - 441) / REF_FPS).toFixed(3)}, ${((462 - 441) / REF_FPS).toFixed(3)}, abstime)))`,
    set: { bright: { threshold: 1.1 }, optics: { bloom: 0.22, streak: 0.95 } },
  },
  {
    // 3 — row 13 (0:10.093–0:11.053, f242–f264): the figure close in front of the hero car, the
    // side cars turned in toward it; hands at the temples, a strobe blink (f247–f250), then
    // down into a squat. Judged against ref f257. The clock: seconds from 0:10.093.
    name: "squat",
    rows: [13],
    cars: { 1: { place: [-0.6, -0.6], turn: 0.45 }, 2: { place: [0.6, -0.9], turn: -0.45 }, 3: { place: [-0.9, 0] }, 4: { place: [-0.6, 0] } },
    camera: { eye: [0.08, 1.5, 2.35], aim: [0.0, 1.35, -1.5], fov: 40, hand: { tiltIn: -1.5, tilt: -0.8, settle: 0.6, shake: 0.4 }, move: [0, -0.1, -0.12], aimMove: [0, -0.22, 0] },
    figure: { area: "fig", at: [0.05, 1.05], facing: 0, performance: squat, groove: NOD, lift: [[t13(252), 0], [t13(262), -0.36]] },
    strobe: `max(0.05, 1 - (abstime >= ${(t13(247) - 0.002).toFixed(4)}) * (abstime < ${(t13(251) - 0.002).toFixed(4)}))`,
    key: { position: [1.6, 2.0, 6.5], intensity: 17 },
    reach: 0.7,
    set: { optics: { streak: 0.55 } },
  },
  {
    // 4 — row 34 (0:37.663–0:40.123, f903–f962): the figure in the gap between two white SUVs
    // parked side by side, nose away; their flanks, washed by a hard key beside the lens, blow
    // out white and streak. Judged against ref f915 and f951. The clock: seconds from 0:37.663.
    name: "gap",
    rows: [34],
    cars: { 0: "hide", 1: { place: [1.46, 1.45], turn: Math.PI }, 2: { place: [-1.4, 2.18], turn: Math.PI }, 3: { place: [0, -4] }, 4: { place: [-1.5, -4] } },
    camera: { eye: [0.0, 1.15, 1.9], aim: [0.02, 1.45, -3], fov: 44, hand: { tiltIn: 1.2, tilt: 0.5, settle: 2, shake: 0.35 }, move: [0, 0, -0.06] },
    figure: { area: "fig", at: [0.0, 0.15], facing: 0, performance: gapStand, groove: NOD },
    // a fast wide lens held on the figure: the flanks a metre off melt into soft white
    aperture: 1.6,
    key: { position: [0.0, 1.6, 3.2], intensity: 45 },
    fill: { position: [0.3, 2.2, 0.6], intensity: 4 },
    reach: 0.45,
  },
  {
    // 5 — row 37 (0:41.500–0:42.38, f995–f1015): the headlight row from low and wide, the figure
    // stepping beside the hero car. FITTED to ref f1001 at a fixed 40° (seven lamps, residuals
    // 1–20 px; the rear cars 0.8 m left / 1.3 m right of the tableau's). Measured light: the car
    // band reads ~95 with a flash every third frame (~110), dark on f995, fading out from f1012.
    // The clock: seconds from 0:41.500.
    name: "row",
    rows: [37],
    cars: { 3: { place: [-0.81, 0] }, 4: { place: [1.27, 0] } },
    camera: { eye: [-0.26, 0.66, 5.31], aim: [-0.15, 0.99, -0.68], fov: 40, hand: { tiltIn: -0.8, tilt: -0.8, settle: 1, shake: 0.2 } },
    figure: { area: "figbare", at: [0.35, 1.1], facing: 70, performance: stepDance, groove: NOD },
    strobe: flicker37(),
    // the reference reads bright here (the car band ~95 of 255): a strong low key, the grade opened
    key: { position: [-1.0, 1.2, 7.5], intensity: 45 },
    grade: { exposure: 0.55 },
    reach: 0.42,
    set: { optics: { streak: 0.7 } },
  },
  {
    // 6 — row 38 (0:42.38 on): the figure in the gap between two white cars turned in toward
    // the lens, the near-left car's lamp blowing a beam straight in; low, the trusses above.
    // Judged against ref f1020. The clock: seconds from the row's in-point.
    name: "headlights",
    rows: [38],
    // the left car turned nearly side-on (its flank and lamp toward the gap, as in the reference)
    cars: { 0: "hide", 1: { place: [0.13, 3.98], turn: 1.25 }, 2: { place: [-0.9, 2.58], turn: -0.6 }, 3: { place: [0, -3] }, 4: { place: [-1.5, -3] } },
    camera: { eye: [0.0, 1.1, 3.85], aim: [0.05, 1.3, 0], fov: 46, hand: { tiltIn: -2, tilt: -1.2, settle: 0.5, shake: 0.4 } },
    figure: { area: "fig", at: [0.05, 1.6], facing: -8, performance: capTouch, groove: NOD },
    key: { position: [0.8, 1.8, 7.5], intensity: 14 },
    reach: 0.18,
  },
  {
    // 7 — row 40 (0:43.54 on): the hero car in the left foreground turned toward the gap, the
    // figure in the gap, a white car with a bar grille on the right; strobe-short columns.
    // Judged against ref f1050. The clock: seconds from the row's in-point.
    name: "gap-hero",
    rows: [40],
    cars: { 0: { place: [-2.0, 2.6], turn: 0.55 }, 1: { place: [-1.0, -3.0] }, 2: { place: [-0.75, 0.6], turn: -0.3 }, 3: { place: [0.6, -2] }, 4: { place: [0.2, -2] } },
    camera: { eye: [0.25, 1.0, 4.4], aim: [0.4, 1.3, -2], fov: 44, hand: { tiltIn: 1.5, tilt: 0.8, settle: 0.5, shake: 0.45 } },
    figure: { area: "fig", at: [0.4, 0.9], facing: -5, performance: capTouch, groove: NOD },
    key: { position: [1.5, 1.8, 7.0], intensity: 14 },
    reach: 0.2,
  },
  {
    // 8 — row 43 (0:44.88 on): from behind the figure, the hero car head-on beyond it, the side
    // cars turned in with their lamps and short columns; the arm swings over; handheld.
    // Judged against ref f1084. The clock: seconds from the row's in-point.
    name: "behind",
    rows: [43],
    cars: { 1: { place: [-0.4, 0.6], turn: 0.6 }, 2: { place: [0.5, 0.5], turn: -0.5 } },
    camera: { eye: [0.35, 1.5, 3.9], aim: [-0.05, 0.8, 0], fov: 50, hand: { tiltIn: 2, tilt: 1, settle: 0.4, shake: 0.7 } },
    figure: { area: "fig", at: [0.75, 1.95], facing: 185, performance: armSwing },
    // off to the left of the lens, so the figure's shadow misses the hero's grille
    key: { position: [-1.8, 1.2, 5.0], intensity: 26 },
    reach: 0.2,
  },
  {
    // 9 — row 52b (0:51.051–0:51.301, f1224–f1229): the shirtless figure close, head down, hands
    // at the waistband, the cars behind blown into fat white columns. The brightness IS the look
    // (the car band reads 150–170 of 255 on every frame), not a flash. Judged against ref f1226.
    name: "blown-close",
    rows: [52],
    cars: { 3: { place: [-1.3, 0] }, 4: { place: [-1.16, 0] } },
    camera: { eye: [0.2, 1.3, 3.25], aim: [0.0, 1.25, 0], fov: 38, hand: { tiltIn: 2.5, tilt: 1.5, settle: 0.3, shake: 1.2 }, move: [0.3, 0, 0] },
    figure: { area: "figbare", at: [0.05, 1.8], facing: 12, performance: waistband, groove: NOD },
    key: { position: [0.6, 1.6, 6.0], intensity: 30 },
    fill: { position: [0.8, 2.0, 3.0], intensity: 8 },
    reach: 0.7,
    grade: { exposure: 1.3, lift: 0.16 },
    // 53a (f1230–f1232) continues this set-up from 0.25 s: the operator whips away to the left,
    // the key drops, and the frame goes dark past the columns
    strobe: "1 - 0.85 * smoothstep(0.24, 0.3, abstime)",
    set: {
      optics: { streak: 1.4, bloom: 0.5 },
      bright: { threshold: 0.8 },
      cam: { "lookAt.x": expressionSlot("-3.2 * smoothstep(0.25, 0.33, abstime) + 0.03 * sin(abstime * 4.3)", 0) },
      grade: { exposure: expressionSlot("1.3 - 1.1 * smoothstep(0.24, 0.3, abstime)", 1.3) },
    },
  },
  {
    // 10 — row 56 (0:55.60–0:56.06, f1333–f1343): a whip onto shin height, then locked low on
    // the hero car's front corner while the figure's legs walk across, left to right, in the
    // baggy shorts, the chain swinging. The walk is shots/gait.ts's clinical gait at 0.6×
    // (the reference's slowed cadence). Judged against ref f1340. The clock: seconds from 0:55.60.
    name: "legs",
    rows: [56],
    cars: { 3: { place: [-1.3, 0] }, 4: { place: [-1.16, 0] } },
    // at the hero's front-left corner, shin height, looking across its bumper to the legs beyond
    camera: { eye: [-2.2, 0.3, 2.2], aim: [0.35, 0.42, 0.6], fov: 34, hand: { tiltIn: -3, tilt: -1.5, settle: 0.3, shake: 0.25 } },
    figure: { area: "fig", at: [-0.45, 1.3], facing: 90, walk: { ...NORMAL_WALK, rate: 0.6 } },
    key: { position: [-3.5, 0.8, 3.0], intensity: 22 },
    // a low soft wash on the legs and the floor round them (the reference's floor reads lit)
    fill: { position: [-0.8, 0.5, 2.6], intensity: 6 },
    reach: 0.3,
    // the whip: the aim swings in from the right over the first four frames
    set: { cam: { "lookAt.x": expressionSlot("0.35 + 2.6 * (1 - smoothstep(0, 0.17, abstime)) + 0.03 * sin(abstime * 3.1)", 0.35) } },
  },
];
