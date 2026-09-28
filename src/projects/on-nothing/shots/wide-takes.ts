import type { StoredParameter } from "../../../domain/types/parameters.ts";
import type { Bone } from "../scene-facts.ts";
import { armPose, standingLegs, type KeyPose, type Pose } from "./gait.ts";
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
    ...armPose(bones, "L", { flex: 42 + spread, out: 38, elbow: 118, inward: 18, wrist: [-0.35, 0, 0.1] }),
    ...armPose(bones, "R", { flex: 46 - spread, out: 36, elbow: 122, inward: 18, wrist: [-0.35, 0, -0.1] }),
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

const NOD = { "neck.x": "0.05 * sin(abstime * 15.08)", "chest.y": "0.04 * sin(abstime * 7.54 + 0.6)" };

export const WIDE_TAKES: readonly WideTake[] = [
  {
    // 0 — row 54 (0:53.43–0:54.18 is the wide; 0:52.34 on is a CU of the hands, 0:54.18 on an MCU)
    // FITTED to ref f1291: nine lamps, residuals 7–30 px but for the rear-right car (~50 px).
    name: "locked",
    rows: [54],
    camera: { eye: [-0.45, 0.97, 7.79], aim: [-0.18, 1.18, 1.8], fov: 28.2, hand: { tiltIn: -2, tilt: -2, settle: 1, shake: 0.15 } },
    figure: { area: "figbare", at: [1.1, 1.93], facing: -15, performance: signs, groove: NOD },
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
    key: { position: [2.8, 2.2, 8.5], intensity: 70 },
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
    key: { position: [2.2, 1.6, 6.5], intensity: 26 },
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
    key: { position: [1.6, 2.0, 6.5], intensity: 30 },
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
];
