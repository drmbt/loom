import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../../furnace/post.ts";
import { CAMERA_PARAMS, GTAO_WGSL, VIEW } from "../../furnace/screen-space.ts";
import { ENVIRONMENT_HDRI_WGSL, HEADLIGHT_COOKIE_WGSL, hazeLights, hazeWgsl } from "../atmosphere.ts";
import { CRT_WGSL, GRADE_WGSL, LENS_WGSL, OPTICS_COMPOSITE_WGSL, STREAK_WGSL } from "../fx.ts";
import { GLOSSY_SSR_WGSL } from "../reflections.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { carAreas } from "../scene-facts.ts";
import { LAMP_GLASS_WGSL, surfaceWgsl, type Footprint } from "../surface.ts";
import { ShotGraph, cameraRefs } from "./chain.ts";
import { DOF_FILL_WGSL, LENS_DOF_WGSL, STUDIO_ENV_WGSL } from "./closeups-fx.ts";
import { figureNodes } from "./figure.ts";
import { handheld, type HandheldOptions } from "./handheld.ts";
import { type Angles, type ArmTarget, type Euler, type V3, boneIndex, mirror, posed, solveArm } from "./mcu-rig.ts";
import { keyed } from "./motion.ts";
import { LAMP_DISC_WGSL } from "./ring.ts";
import { type HandPose, handPose } from "../skin-kernel.ts";

/**
 * T1407b (mcu) — THE PERFORMER CLOSE-UPS, the most common shot in the reference: the figure
 * (sunglasses, beanie, chain; the tee, or shirtless) framed low from a metre or less, dark,
 * rim-lit from behind, the headlights behind it smeared up into columns by the streak glass —
 * or nothing behind it at all, a black void with one hard top-back light glinting off the
 * chain and the rings.
 *
 * One builder, a TAKE TABLE (`MCU_TAKES`): a take is one set-up, a run of BEATS. A beat is
 * what one EDL row shows (or one of the cuts inside a row): where the figure stands, what it
 * does (arm TARGETS solved by shots/mcu-rig.ts into the skin kernel's knobs, keyed over the
 * beat), where the operator stands and how the handheld moves (shots/handheld.ts, restarted
 * each beat), the focus, and where the rim, top and fill lights sit. The beats of a take play
 * back to back on the take's clock; a row picks its beat with the EDL's `from`. Everything that
 * changes from beat to beat is ONE expression switched at the beat's first frame (a hard cut),
 * so a row that holds several cuts plays them in one render.
 *
 * Two stages share one graph: the CAR ROW (the warehouse, the five cars, their headlights and
 * projectors, the sodium practicals, haze) and the VOID, 80 m off to the side where nothing is
 * lit. A beat names its stage; the figure, the camera and the lights jump there on the cut.
 */

export const MCU_SHOTS = ["mcu"] as const;

type Stage = "cars" | "void";

/** Light slots: fixed colours, placed and powered per beat (figure-local metres: x its left, y up, z its front). */
const SLOTS = {
  /** A soft key high in front, off to one side: the face and the tee at a low mid-grey. */
  key: [0.92, 0.95, 1],
  /** The hard back light high behind the head: crowns, shoulders, the chain's glints. */
  top: [0.9, 0.95, 1],
  /** Rims behind either shoulder. */
  rimL: [0.85, 0.93, 1],
  rimR: [0.85, 0.93, 1],
  /** A dim cool front fill low beside the lens, so the face reads at all. */
  fill: [0.78, 0.86, 1],
  /** Sodium spill (the room's old high-bays). */
  warm: [1, 0.52, 0.2],
  /** A cyan LED kick. */
  cyan: [0.3, 0.85, 1],
} as const;
type Slot = keyof typeof SLOTS;

interface Light {
  readonly at: V3;
  readonly power: number;
}

/** A pose key: body knobs as Euler angles, and arm targets solved on top of them. */
interface Key {
  /** Beat-local seconds. */
  readonly t: number;
  readonly body?: Readonly<Record<string, Euler>>;
  readonly L?: ArmTarget;
  readonly R?: ArmTarget;
  /** Ease INTO this key out-only (a staccato hit). */
  readonly snap?: boolean;
}

export interface Beat {
  /** The EDL rows this beat plays (documentation, and the check against the EDL). */
  readonly rows: readonly number[];
  /** Length in frames at 24 fps (the row's frame count). */
  readonly frames: number;
  readonly stage: Stage;
  /** Where on the stage the figure stands (offset from the stage's mark, metres) and which way it faces (radians about +Y; 0 = +Z). */
  readonly at?: V3;
  readonly yaw?: number;
  readonly keys: readonly Key[];
  /** Additive knob expressions in `u` (beat-local seconds): breathing, the head with the beat. */
  readonly life?: Readonly<Record<string, string>>;
  /** The fingers (T1419b knobs through skin-kernel.ts handPose): a fist, a point, a spread; fields may be expressions in `u`. */
  readonly hands?: { readonly L?: HandPose; readonly R?: HandPose };
  /** The operator: eye and aim in the figure's frame (or `frame`), vertical fov (degrees), the handheld. */
  readonly eye?: V3;
  readonly aim?: V3;
  /**
   * The operator placed by what the frame shows (the reference's composition, measured off its
   * frames): the lens looks back along `dir` (figure's frame, from the head toward the lens)
   * from wherever the head (its posed centre at the beat's first key) fills `size` of the frame
   * height, turned so the head sits at `head` (x, y from the top-left, 0..1).
   */
  readonly frame?: { readonly dir: V3; readonly head: readonly [number, number]; readonly size: number };
  readonly fov: number;
  readonly hand: HandheldOptions;
  /** Focus distance (metres, or an expression in `u`; default: eye to aim) and f-number. */
  readonly focus?: number | string;
  readonly fstop?: number;
  readonly lights: Partial<Record<Slot, Light>>;
  /** `eye` and `aim` are WORLD metres, not the figure's frame (the car-row set-ups, framed on the cars). */
  readonly world?: boolean;
  /**
   * Practical lamps seen down the lens (ring.ts's lamp disc: a hard round source the depth
   * occludes), in the figure's frame; the streak glass smears each into a column. Radiance 0
   * hides one.
   */
  readonly lamps?: readonly { readonly at: V3; readonly size: number; readonly radiance: number }[];
  /**
   * A sodium lamp just off the lens, far out of focus: a big soft warm disc with a brighter rim
   * (row 20's red flare). Centre in uv (may be expressions in `u`), radius in frame heights.
   */
  /**
   * Practical TUBES: a vertical light column seen close (row 21's near tube, row 31's), a glowing
   * capsule between two points in the figure's frame; the depth occludes it and the lens blurs it.
   */
  readonly tubes?: readonly { readonly from: V3; readonly to: V3; readonly radius: number; readonly radiance: number }[];
  readonly flare?: { readonly centre: readonly [number | string, number | string]; readonly radius: number; readonly gain: number | string };
}

export interface Take {
  readonly name: string;
  /** Which figure: the beanie and the tee, shirtless, or the brimmed cap (rows 14, 32, 33: area `figcap`). */
  readonly wardrobe: "fig" | "figbare" | "figcap";
  /** T1407b (mcu2): the right hand holds the pistol (figureNodes' `gun`) through every beat. */
  readonly gun?: boolean;
  /** Streak reach (fraction of the frame height) at the start and end of each beat: one direction per cut. */
  readonly streak: { readonly from: number; readonly to: number; readonly gain: number; readonly threshold: number };
  readonly grade: Record<string, StoredParameter>;
  /**
   * The Render's flat ambient. The chain and the rings are a mirror metal (surface.ts's jewel) and
   * the room gives them next to nothing to mirror, so without it they read black; a little
   * ambient is what brings them up to the reference's white ice (the dark cloth barely moves).
   */
  readonly ambient: number;
  /** What an empty ray sees (default black): the grey-teal ground of the long-lens profiles. */
  readonly background?: readonly [number, number, number];
  /** The low cool key on the car fronts from far behind the lens (default 10): the rows' lamps read as columns over near-black cars. */
  readonly carKey?: number;
  readonly beats: readonly Beat[];
}

/** The stages' marks (world metres) and which way the figure faces there. */
const STAGE_MARK: Record<Stage, V3> = {
  // in front of the car row, six metres off the front bumpers: the lamps sit behind the figure
  cars: [0, 0, 4.6],
  // nothing within 60 m
  void: [-80, 0, 0],
};

// ── Arm targets (figure rest frame: x = its left, y up, z its front; metres) ──
// The head's crown is at (0, 1.806, 0.07), the face's front at z 0.17, the temples at x ±0.08.
// `onHead` targets ride on the posed head (the elbow stays in the body's frame).

/** Both hands flat on the crown, elbows out wide (rows 30, 32). */
const ON_CROWN: ArmTarget = { elbow: [0.36, 1.55, 0.1], wrist: [0.12, 1.72, 0.0], tip: [0.0, 1.88, 0.03], seed: [[0, 0, 1.9], [0, 0, 1.6], [0, 0, 0]], onHead: true };
/** Hands cupping the back of the head, elbows high and wide (row 27, looking up). */
const BACK_OF_HEAD: ArmTarget = { elbow: [0.4, 1.62, 0.02], wrist: [0.11, 1.7, -0.07], tip: [0.02, 1.8, -0.1], seed: [[0, 0, 1.9], [0, 0, 1.6], [0, 0, 0]], onHead: true };
/** Palms over the face, the fingers up over the brow (row 33, the void cut). */
const OVER_FACE: ArmTarget = { elbow: [0.2, 1.3, 0.3], wrist: [0.07, 1.54, 0.28], tip: [0.05, 1.74, 0.24], seed: [[-1.0, 0, 0.3], [-1.6, 0, 0.3], [0, 0, 0]] };
/** Hands raised either side of a bowed head, wrists to the lens (row 14, from above). */
const RAISED: ArmTarget = { elbow: [0.34, 1.34, 0.14], wrist: [0.24, 1.64, 0.18], tip: [0.22, 1.82, 0.18], seed: [[-0.3, 0, 0.6], [-1.8, 0, 0.2], [0, 0, 0]] };
/** Reaching at the lens, both hands (row 33, the last cut). */
const REACH: ArmTarget = { elbow: [0.24, 1.34, 0.26], wrist: [0.1, 1.5, 0.42], tip: [0.09, 1.56, 0.58], seed: [[-1.2, 0, 0.1], [-0.4, 0, 0], [0, 0, 0]] };
/** The right hand at the ear, a phone (rows 9, 16). */
const PHONE_R: ArmTarget = { elbow: [-0.3, 1.28, 0.12], wrist: [-0.11, 1.52, 0.06], tip: [-0.09, 1.7, 0.06], seed: [[-0.6, 0, -0.4], [-2.0, 0, -0.3], [0, 0, 0]], onHead: true };
/** The left hand forward at the lens, pointing (rows 9, 33). */
const POINT_L: ArmTarget = { elbow: [0.3, 1.15, 0.2], wrist: [0.2, 1.33, 0.42], tip: [0.18, 1.4, 0.6], seed: [[-1.0, 0, 0.2], [-0.8, 0, 0], [0, 0, 0]] };
/** The left hand up by the face, gesturing (row 9, the low CU). */
const GESTURE_L: ArmTarget = { elbow: [0.3, 1.25, 0.22], wrist: [0.2, 1.5, 0.36], tip: [0.17, 1.68, 0.42], seed: [[-1.0, 0, 0.2], [-1.4, 0, 0], [0, 0, 0]] };
/** A fist thrust at the lens from the waist (row 16). */
const THRUST_L: ArmTarget = { elbow: [0.24, 1.08, 0.14], wrist: [0.1, 1.16, 0.44], tip: [0.08, 1.18, 0.6], seed: [[-0.8, 0, -0.2], [-0.8, 0, 0], [0, 0, 0]] };
/** The hand spread over the chest, the pendant under it (row 16). */
const ON_CHEST_L: ArmTarget = { elbow: [0.26, 1.08, 0.12], wrist: [0.1, 1.2, 0.2], tip: [-0.02, 1.3, 0.2], seed: [[-0.6, 0, -0.2], [-1.6, 0, 0], [0, 0, 0]] };
/** The hand spread wide into the lens (rows 10, 11). */
const SPREAD_L: ArmTarget = { elbow: [0.32, 1.28, 0.25], wrist: [0.26, 1.48, 0.5], tip: [0.28, 1.62, 0.62], seed: [[-1.2, 0, 0.3], [-1.0, 0, 0], [0, 0, 0]] };
/** A ringed fist raised at the lens, the watch showing (row 11). */
const FISTS: ArmTarget = { elbow: [0.28, 1.15, 0.16], wrist: [0.2, 1.4, 0.36], tip: [0.2, 1.52, 0.42], seed: [[-1.0, 0, 0.2], [-1.5, 0, 0], [0, 0, 0]] };
/** Hand at the mouth (row 23). */
const MOUTH_R: ArmTarget = { elbow: [-0.24, 1.22, 0.2], wrist: [-0.05, 1.46, 0.2], tip: [-0.01, 1.6, 0.21], seed: [[-1.0, 0, -0.3], [-1.9, 0, 0], [0, 0, 0]], onHead: true };
/** Hands low before the belly, working a phone, head down (rows 20, 33). */
const LOW_HANDS: ArmTarget = { elbow: [0.22, 1.08, 0.04], wrist: [0.1, 1.08, 0.3], tip: [0.03, 1.1, 0.44], seed: [[-0.4, 0, -0.4], [-1.2, 0, 0], [0, 0, 0]] };
/** Arms down, the hands loose at the thighs. */
const DOWN: ArmTarget = { elbow: [0.24, 1.18, -0.02], wrist: [0.27, 0.93, 0.06], tip: [0.28, 0.78, 0.1], seed: [[0, 0, -0.62], [0, 0, 0], [0, 0, 0]] };

/** Finger shapes (T1419b knobs): loose, a fist, pointing at the lens, fingers spread, a phone held at the ear, flat on the head. */
const LOOSE: HandPose = { curl: 0.45, spread: 0.05, thumb: 0.2 };
const FIST: HandPose = { curl: 1.5, thumb: 0.9, extra: [0, 0.05, 0.1, 0.15] };
const POINTING: HandPose = { curl: 1.4, point: 1, thumb: 0.8, extra: [0, 0, 0.05, 0.1] };
const SPREAD: HandPose = { curl: 0.15, spread: 0.3, thumbOut: 0.4 };
const PHONE: HandPose = { curl: 1.1, thumb: 0.7, extra: [0, 0, 0.1, 0.15] };
/** Rows 9–11: the free hand points, then spreads into the lens, and back, with the operator's beats. */
const SWITCHING: HandPose = (() => {
  const w = keyed("u", [[0, 0], [1.0, 0], [1.3, 1], [1.8, 1], [2.0, 0], [2.6, 0], [2.8, 1]]);
  return { curl: `1.4 - 1.25 * (${w})`, point: `1 - (${w})`, spread: `0.3 * (${w})`, thumb: `0.8 - 0.8 * (${w})`, thumbOut: `0.4 * (${w})` };
})();
const CUPPED: HandPose = { curl: 0.35, spread: 0.12, thumbOut: 0.2 };

/** Arms crossed in an X before the throat (row 54): the left wrist at the right of the neck. */
const CROSS_L: ArmTarget = { elbow: [0.26, 1.3, 0.22], wrist: [-0.1, 1.48, 0.2], tip: [-0.22, 1.56, 0.18], seed: [[-1.0, 0, 0.3], [-1.8, 0, 0.3], [0, 0, 0]] };

const both = (left: ArmTarget): { L: ArmTarget; R: ArmTarget } => ({ L: left, R: mirror(left) });
const right = (left: ArmTarget): ArmTarget => mirror(left);

/** The void's lights: a soft key high in front, the hard top-back light, rims either side. */
const VOID_LIGHTS: Beat["lights"] = {
  key: { at: [-0.8, 2.3, 1.0], power: 2 },
  top: { at: [0.15, 2.7, -0.6], power: 5 },
  rimL: { at: [0.7, 1.9, -0.7], power: 1.5 },
  rimR: { at: [-0.7, 1.8, -0.7], power: 1.2 },
  fill: { at: [0.3, 1.3, 1.4], power: 0.3 },
};
/** In front of the car row: the headlights behind do the rim; a dim key in front, the sodium spill. */
const ROW_LIGHTS: Beat["lights"] = {
  key: { at: [-0.9, 2.2, 1.3], power: 0.9 },
  top: { at: [0.1, 2.8, -0.8], power: 2 },
  fill: { at: [0.4, 1.2, 1.5], power: 0.1 },
  warm: { at: [1.5, 2.6, -1.2], power: 0.6 },
};

/** From above: the top light behind, a soft key high in front, rims either side. */
const TOP_LIGHTS: Beat["lights"] = {
  top: { at: [0.3, 3.4, -0.9], power: 3.5 },
  key: { at: [-0.6, 2.8, 0.8], power: 2.5 },
  rimL: { at: [0.8, 1.8, -0.4], power: 1.2 },
  rimR: { at: [-0.8, 1.8, -0.4], power: 1.2 },
};
/** Beside the cars: a dim cool key, a rim from behind, sodium spill. */
const CAR_LIGHTS: Beat["lights"] = {
  key: { at: [-0.9, 2.1, 1.2], power: 1.4 },
  rimL: { at: [0.7, 1.9, -0.8], power: 1.2 },
  fill: { at: [0.3, 1.1, 1.4], power: 0.08 },
  warm: { at: [1.8, 2.8, -1.5], power: 0.6 },
};

const VOID_GRADE: Record<string, StoredParameter> = { exposure: 0.35, black: 0.04, contrast: 1.2, saturation: 0.42, keepWarm: 0.8, bleach: 0.3, steel: [0.95, 1.0, 1.03], shadowTint: [0.95, 1.01, 1.04, 1], split: 0.4, grain: 0.035 };
const ROW_GRADE: Record<string, StoredParameter> = { exposure: 0.3, black: 0.035, contrast: 1.18, saturation: 0.45, keepWarm: 0.9, bleach: 0.3, steel: [0.96, 1.01, 1.03], shadowTint: [0.96, 1.02, 1.03, 1], split: 0.4, grain: 0.035 };

/**
 * THE TAKES. Frame counts are the reference's cuts (edl.json's rows and parts, 24 fps as
 * render.ts plays them); each row's or part's `from` in edl.json is its beat's start on the
 * take's clock (`beatStarts`), plus its offset into the beat where a continuous take is
 * intercut with another (rows 9–11).
 */
export const MCU_TAKES: readonly Take[] = [
  {
    // ── take 0 "void": black, front, low: hands on the head, reaching at the lens ──
    name: "void",
    wardrobe: "fig",
    streak: { from: 0.1, to: 0.16, gain: 1.6, threshold: 3.5 },
    grade: VOID_GRADE,
    ambient: 0.12,
    beats: [
      {
        // row 30 (31.91): both hands on the crown, the face tipped up and turned off the lens
        hands: { L: CUPPED, R: CUPPED },
        rows: [30],
        frames: 17,
        stage: "void",
        keys: [{ t: 0, body: { neck: [-0.12, -0.15, 0], head: [-0.16, -0.1, 0], chest: [-0.03, 0, 0] }, ...both(ON_CROWN) }],
        life: { "head.x": "sin(u * 4.4) * 0.03", "neck.y": "sin(u * 1.3) * 0.04" },
        frame: { dir: [0.15, -0.35, 1], head: [0.25, 0.3], size: 0.5 },
        fov: 40,
        hand: { tiltIn: -2.5, tilt: -1.2, settle: 0.6, shake: 0.3, creep: 0.04 },
        lights: VOID_LIGHTS,
      },
      {
        // row 27 (29.90): chest up, hands behind the head, looking up into the top light
        hands: { L: CUPPED, R: CUPPED },
        rows: [27],
        frames: 13,
        stage: "void",
        keys: [{ t: 0, body: { neck: [-0.3, 0.1, 0], head: [-0.35, 0.05, 0], chest: [-0.06, 0, 0] }, ...both(BACK_OF_HEAD) }],
        life: { "head.y": "sin(u * 2.1) * 0.05" },
        frame: { dir: [0, -0.35, 1], head: [0.47, 0.22], size: 0.36 },
        fov: 36,
        hand: { tiltIn: 1.5, tilt: 0.5, settle: 0.5, shake: 0.3, creep: 0.05 },
        lights: VOID_LIGHTS,
      },
      {
        // row 33, last part (37.08): hands thrust at the lens, soft; the focus pulls in to the face
        hands: { L: FIST, R: FIST },
        rows: [33],
        frames: 14,
        stage: "void",
        keys: [
          { t: 0, body: { neck: [-0.1, 0, 0], head: [-0.15, 0, 0] }, ...both(REACH) },
          { t: 0.55, body: { neck: [-0.1, 0, 0], head: [-0.15, 0, 0] }, L: { ...REACH, wrist: [0.22, 1.5, 0.5] }, R: right({ ...REACH, wrist: [0.18, 1.42, 0.58] }) },
        ],
        frame: { dir: [0, -0.25, 1], head: [0.5, 0.3], size: 0.42 },
        fov: 40,
        focus: "0.4 + 0.6 * clamp(u / 0.3, 0, 1)",
        fstop: 1.4,
        hand: { tiltIn: -3, tilt: -2, settle: 0.4, shake: 0.6, creep: 0.1 },
        lights: VOID_LIGHTS,
      },
      {
        // row 54, first part (52.34): arms crossed in an X before the throat, the head tipped back into the top light
        hands: { L: SPREAD, R: SPREAD },
        rows: [54],
        frames: 26,
        stage: "void",
        keys: [
          { t: 0, body: { neck: [-0.25, 0, 0], head: [-0.25, 0, 0], chest: [-0.05, 0, 0] }, L: CROSS_L, R: right({ ...CROSS_L, wrist: [0.1, 1.44, 0.2] }) },
          { t: 0.6, body: { neck: [-0.32, 0.08, 0], head: [-0.3, 0, 0], chest: [-0.06, 0, 0] }, L: { ...CROSS_L, wrist: [-0.08, 1.52, 0.2] }, R: right({ ...CROSS_L, wrist: [0.12, 1.36, 0.22] }) },
        ],
        life: { "head.y": "sin(u * 2.2) * 0.04" },
        frame: { dir: [0, -0.55, 1], head: [0.47, 0.15], size: 0.36 },
        fov: 40,
        hand: { tiltIn: 1, tilt: 0.5, settle: 0.6, shake: 0.3, creep: 0.03 },
        lights: VOID_LIGHTS,
      },
    ],
  },
  {
    // ── take 1 "top": from above the bowed head (rows 14, 32; row 33's second part) ──
    name: "top",
    wardrobe: "figcap",
    streak: { from: 0.12, to: 0.2, gain: 1.6, threshold: 3.5 },
    grade: VOID_GRADE,
    ambient: 0.12,
    beats: [
      {
        // row 14 (11.05): the head bowed, the hands raised either side, flapping with the beat
        hands: { L: LOOSE, R: LOOSE },
        rows: [14],
        frames: 30,
        stage: "void",
        keys: [{ t: 0, body: { neck: [0.35, 0, 0], head: [0.3, 0, 0], chest: [0.12, 0, 0] }, ...both(RAISED) }],
        life: {
          "head.y": "sin(u * 2.2) * 0.06",
          "forearmL.x": "sin(u * 7.2) * 0.25",
          "forearmR.x": "sin(u * 7.2 + 2.4) * 0.25",
          "handL.x": "sin(u * 7.2 + 0.8) * 0.3",
          "handR.x": "sin(u * 7.2 + 3.2) * 0.3",
        },
        frame: { dir: [0, 1.2, 1], head: [0.47, 0.32], size: 0.62 },
        fov: 44,
        hand: { tiltIn: -4, tilt: -2, settle: 0.8, shake: 0.5, creep: 0 },
        lights: TOP_LIGHTS,
      },
      {
        // row 32 (33.12): hands on the crown, from above and in front
        hands: { L: CUPPED, R: CUPPED },
        rows: [32],
        frames: 10,
        stage: "void",
        keys: [{ t: 0, body: { neck: [0.15, 0, 0], head: [0.12, 0, 0], chest: [0.04, 0, 0] }, ...both(ON_CROWN) }],
        frame: { dir: [0, 0.4, 1], head: [0.4, 0.3], size: 0.6 },
        fov: 40,
        hand: { tiltIn: 2, tilt: 1, settle: 0.3, shake: 0.4, creep: 0.05 },
        lights: TOP_LIGHTS,
      },
      {
        // row 33, second part (33.99): from above, the head bowed into both palms
        hands: { L: SPREAD, R: SPREAD },
        rows: [33],
        frames: 14,
        stage: "void",
        keys: [{ t: 0, body: { neck: [0.3, 0, 0], head: [0.25, 0, 0], chest: [0.08, 0, 0] }, ...both(OVER_FACE) }],
        life: { "head.x": "sin(u * 4.4) * 0.03" },
        frame: { dir: [0, 0.5, 1], head: [0.45, 0.25], size: 0.4 },
        fov: 34,
        hand: { tiltIn: -0.5, tilt: -0.2, settle: 0.5, shake: 0.2, creep: 0.03 },
        lights: TOP_LIGHTS,
      },
    ],
  },
  {
    // ── take 2 "row": before the car row, a wide lens a metre off, the far headlights smeared into columns ──
    name: "row",
    wardrobe: "fig",
    streak: { from: 0.3, to: 0.4, gain: 1.8, threshold: 4.5 },
    carKey: 2,
    grade: ROW_GRADE,
    ambient: 0.05,
    beats: [
      {
        // rows 9–11 (5.38–8.18): ONE continuous take, intercut with the wide: the phone at the ear,
        hands: { L: SWITCHING, R: PHONE },
        // the free hand working at the lens (pointing, then spread wide into it)
        rows: [9, 10, 11],
        frames: 67,
        stage: "cars",
        keys: [
          { t: 0, body: { spine: [0.22, 0, 0], chest: [0.18, 0, 0], neck: [-0.05, 0.1, 0], head: [-0.2, 0, 0] }, L: POINT_L, R: PHONE_R },
          { t: 0.6, body: { spine: [0.22, 0, 0], chest: [0.18, 0, 0], neck: [-0.08, 0.15, 0], head: [-0.2, 0.05, 0] }, L: { ...POINT_L, wrist: [0.24, 1.4, 0.45], tip: [0.3, 1.5, 0.6] }, R: PHONE_R },
          { t: 1.3, body: { spine: [0.22, 0, 0], chest: [0.18, 0, 0], neck: [-0.05, -0.05, 0], head: [-0.2, 0, 0] }, L: SPREAD_L, R: PHONE_R },
          { t: 2.0, body: { spine: [0.22, 0, 0], chest: [0.18, 0, 0], neck: [-0.05, 0.1, 0], head: [-0.18, 0.05, 0] }, L: POINT_L, R: PHONE_R },
          { t: 2.8, body: { spine: [0.22, 0, 0], chest: [0.18, 0, 0], neck: [-0.08, 0.05, 0], head: [-0.2, 0, 0] }, L: SPREAD_L, R: PHONE_R },
        ],
        life: { "head.x": "sin(u * 4.4) * 0.035", "chest.y": "sin(u * 1.1) * 0.05" },
        frame: { dir: [0, -0.15, 1], head: [0.5, 0.3], size: 0.45 },
        fov: 52,
        focus: 0.85,
        fstop: 2.2,
        hand: { tiltIn: 1.5, tilt: 2.5, settle: 0.6, shake: 0.6, creep: 0.02 },
        lights: ROW_LIGHTS,
      },
    ],
  },
  {
    // ── take 3 "row-bare": the same place, SHIRTLESS (rows 11, 16) ──
    name: "row-bare",
    wardrobe: "figbare",
    streak: { from: 0.3, to: 0.4, gain: 1.8, threshold: 4.5 },
    carKey: 2,
    grade: ROW_GRADE,
    ambient: 0.05,
    beats: [
      {
        // row 11 (8.18–9.68): the chains, then both ringed fists and the watches pushed at the lens
        hands: { L: FIST, R: FIST },
        rows: [11],
        frames: 36,
        stage: "cars",
        keys: [
          { t: 0, body: { neck: [0.1, 0, 0], head: [0.05, 0, 0] }, ...both(DOWN) },
          { t: 0.35, body: { neck: [0.05, 0, 0], head: [0.0, 0, 0] }, ...both(FISTS), snap: true },
          { t: 0.8, body: { neck: [0.05, 0.1, 0], head: [0.0, 0, 0] }, L: { ...FISTS, wrist: [0.18, 1.46, 0.4] }, R: right({ ...FISTS, wrist: [0.2, 1.36, 0.36] }) },
          { t: 1.5, body: { neck: [0.05, -0.1, 0], head: [0.0, 0, 0] }, ...both(FISTS) },
        ],
        life: { "head.x": "sin(u * 4.4) * 0.04" },
        frame: { dir: [0, -0.15, 1], head: [0.58, 0.28], size: 0.4 },
        fov: 46,
        focus: 0.8,
        fstop: 2.2,
        hand: { tiltIn: -1.5, tilt: -2.5, settle: 0.5, shake: 0.6, creep: 0.03 },
        lights: ROW_LIGHTS,
      },
      {
        // row 16, first part (13.14): waist height, a fist thrust into the lens, the bare torso behind
        hands: { L: FIST, R: LOOSE },
        rows: [16],
        frames: 13,
        stage: "cars",
        keys: [
          { t: 0, body: { chest: [0.05, 0.1, 0] }, L: THRUST_L, R: DOWN },
          { t: 0.5, body: { chest: [0.05, 0.15, 0] }, L: { ...THRUST_L, wrist: [0.1, 1.2, 0.5] }, R: DOWN },
        ],
        frame: { dir: [0, -0.2, 1], head: [0.45, -0.15], size: 0.55 },
        fov: 42,
        focus: 0.5,
        fstop: 2.8,
        hand: { tiltIn: -2, tilt: -1, settle: 0.5, shake: 0.5, creep: 0.05 },
        lights: ROW_LIGHTS,
      },
      {
        // row 16, third part (13.85): the ringed hand spread over the bare torso and the pendant
        hands: { L: SPREAD, R: LOOSE },
        rows: [16],
        frames: 14,
        stage: "cars",
        keys: [
          { t: 0, body: { chest: [0.05, 0, 0] }, L: ON_CHEST_L, R: DOWN },
          { t: 0.58, body: { chest: [0.05, 0.08, 0] }, L: { ...ON_CHEST_L, wrist: [0.06, 1.22, 0.22] }, R: DOWN },
        ],
        frame: { dir: [0.1, -0.1, 1], head: [0.5, -0.2], size: 0.5 },
        fov: 40,
        focus: 0.65,
        fstop: 2.8,
        hand: { tiltIn: 1, tilt: 2, settle: 0.5, shake: 0.5, creep: 0.03 },
        lights: ROW_LIGHTS,
      },
      {
        // row 16, second and fourth parts (13.68, 14.43): profile CU, the cap bowed over a phone at the ear, dark
        hands: { L: LOOSE, R: PHONE },
        rows: [16],
        frames: 27,
        stage: "cars",
        yaw: -1.2,
        keys: [{ t: 0, body: { neck: [0.35, 0, 0], head: [0.3, 0, 0], chest: [0.1, 0, 0] }, L: DOWN, R: PHONE_R }],
        life: { "neck.x": "sin(u * 4.4) * 0.03" },
        frame: { dir: [0.5, 0.1, 1], head: [0.55, 0.4], size: 0.55 },
        fov: 40,
        hand: { tiltIn: -1, tilt: -0.5, settle: 0.5, shake: 0.4, creep: 0.03 },
        lights: { ...ROW_LIGHTS, key: { at: [-0.9, 2.2, 1.3], power: 0.25 } },
      },
      {
        // row 54, fourth part (54.39): waist height, a spread hand thrust at the lens, the other arm up; the car row behind
        hands: { L: SPREAD, R: LOOSE },
        rows: [54],
        frames: 11,
        stage: "cars",
        keys: [
          { t: 0, body: { chest: [0.05, 0.1, 0] }, L: SPREAD_L, R: right({ ...ON_CROWN, onHead: false, elbow: [0.34, 1.6, -0.05], wrist: [0.2, 1.85, 0.0], tip: [0.18, 2.0, 0.02] }) },
        ],
        frame: { dir: [0, -0.1, 1], head: [0.42, -0.08], size: 0.34 },
        fov: 46,
        focus: 0.9,
        fstop: 2.2,
        hand: { tiltIn: -1, tilt: -0.5, settle: 0.4, shake: 0.5, creep: 0.03 },
        lights: ROW_LIGHTS,
      },
    ],
  },
  {
    // ── take 4 "low": row 8, the face revealed, a very low CU up at it, a white car's flank soft behind ──
    name: "low",
    wardrobe: "fig",
    streak: { from: 0.16, to: 0.22, gain: 1.8, threshold: 4.5 },
    grade: ROW_GRADE,
    ambient: 0.05,
    beats: [
      {
        // row 8 (4.30): the left hand working near the lens, the lens pushing in to the open mouth
        hands: { L: SPREAD, R: LOOSE },
        rows: [8],
        frames: 26,
        stage: "cars",
        at: [0.2, 0, -3.2],
        yaw: Math.PI / 2,
        keys: [
          { t: 0, body: { neck: [-0.05, 0.12, 0], head: [-0.04, 0.08, 0] }, L: GESTURE_L, R: DOWN },
          { t: 0.6, body: { neck: [-0.08, -0.05, 0], head: [-0.08, 0, 0] }, L: { ...GESTURE_L, wrist: [0.22, 1.45, 0.4] }, R: DOWN },
          { t: 1.1, body: { neck: [-0.12, -0.1, 0], head: [-0.12, 0, 0] }, L: DOWN, R: DOWN },
        ],
        life: { "head.x": "sin(u * 4.4) * 0.04" },
        frame: { dir: [0.1, -0.35, 1], head: [0.3, 0.3], size: 0.75 },
        fov: 44,
        focus: "0.62 - 0.2 * clamp(u / 1.1, 0, 1)",
        fstop: 1.8,
        hand: { tiltIn: 6, tilt: 4, settle: 0.8, shake: 0.7, creep: 0.12 },
        lights: { ...ROW_LIGHTS, key: { at: [-0.5, 1.4, 1.0], power: 0.8 }, cyan: { at: [0.6, 1.2, 0.8], power: 0.25 } },
      },
      {
        // row 61 (59.89): the face in the dark from below and very close, soft; a hand passing; it runs on into row 62
        hands: { L: LOOSE, R: CUPPED },
        rows: [61],
        frames: 13,
        stage: "cars",
        at: [0.2, 0, -3.2],
        yaw: Math.PI / 2,
        keys: [
          { t: 0, body: { neck: [-0.2, 0.1, 0], head: [-0.2, 0.05, 0] }, L: DOWN, R: right({ ...GESTURE_L, wrist: [0.25, 1.45, 0.36] }) },
          { t: 0.5, body: { neck: [-0.24, -0.05, 0], head: [-0.24, 0, 0] }, L: DOWN, R: right({ ...GESTURE_L, wrist: [0.08, 1.52, 0.42] }) },
        ],
        life: { "head.x": "sin(u * 4.4) * 0.03" },
        frame: { dir: [0.15, -0.55, 1], head: [0.55, 0.45], size: 0.95 },
        fov: 44,
        focus: 0.3,
        fstop: 1.4,
        hand: { tiltIn: -3, tilt: -5, settle: 0.4, shake: 0.7, creep: 0.02 },
        lights: { key: { at: [0.6, 1.2, 0.8], power: 0.4 }, rimL: { at: [0.7, 1.9, -0.8], power: 1.2 }, warm: { at: [-0.8, 1.3, 0.6], power: 0.25 } },
      },
    ],
  },
  {
    // ── take 5 "car": beside the cars, framed on them (world cameras) (rows 20, 21, 24, 33) ──
    name: "car",
    wardrobe: "fig",
    streak: { from: 0.2, to: 0.28, gain: 1.6, threshold: 5 },
    carKey: 4,
    grade: ROW_GRADE,
    ambient: 0.05,
    beats: [
      {
        // row 33, third part (34.58): at the black car's front corner, pointing at the lens; the bonnet fills the right
        hands: { L: POINTING, R: PHONE },
        rows: [33],
        frames: 60,
        stage: "cars",
        at: [0.8, 0, -11.5],
        yaw: 0.1,
        keys: [
          { t: 0, body: { neck: [0.12, 0.2, 0], head: [0.05, 0, 0] }, L: POINT_L, R: LOW_HANDS },
          { t: 0.9, body: { neck: [0.05, 0.1, 0], head: [0.0, 0, 0] }, L: { ...POINT_L, wrist: [0.26, 1.3, 0.4] }, R: LOW_HANDS },
          { t: 1.3, body: { neck: [-0.05, 0.0, 0], head: [-0.05, 0, 0] }, L: POINT_L, R: PHONE_R },
          { t: 2.5, body: { neck: [0.0, 0.1, 0], head: [0.0, 0, 0] }, L: { ...POINT_L, wrist: [0.22, 1.36, 0.44] }, R: PHONE_R },
        ],
        life: { "head.x": "sin(u * 4.4) * 0.04" },
        frame: { dir: [0.3, 0.6, 1], head: [0.2, 0.26], size: 0.42 },
        fov: 40,
        fstop: 2.2,
        hand: { tiltIn: -2, tilt: -3.5, settle: 1.0, shake: 0.5, creep: 0.04 },
        lights: CAR_LIGHTS,
      },
      {
        // row 33, first part (33.53): close down across the chain to the dark grille
        hands: { L: LOOSE, R: LOOSE },
        rows: [33],
        frames: 11,
        stage: "cars",
        at: [0.3, 0, -12.2],
        yaw: 0.1,
        keys: [{ t: 0, body: { neck: [0.3, 0.2, 0], head: [0.2, 0, 0], chest: [0.08, 0, 0] }, L: LOW_HANDS, R: DOWN }],
        world: true,
        eye: [0.15, 1.5, -7.25],
        aim: [1.2, 0.9, -8.3],
        fov: 40,
        focus: 0.4,
        fstop: 1.8,
        hand: { tiltIn: 3, tilt: 4, settle: 0.4, shake: 0.5, creep: 0.05 },
        lights: CAR_LIGHTS,
      },
      {
        // row 20 (21.61): beside the grey car, three-quarter, head down over the phone; a white car's lamps behind; the operator slides in
        hands: { L: LOOSE, R: PHONE },
        rows: [20],
        frames: 38,
        stage: "cars",
        at: [1.3, 0, -3.0],
        yaw: 0.6,
        keys: [
          { t: 0, body: { neck: [0.35, 0, 0], head: [0.3, 0, 0], chest: [0.1, 0, 0] }, ...both(LOW_HANDS) },
          { t: 1.5, body: { neck: [0.25, -0.2, 0], head: [0.2, -0.1, 0], chest: [0.1, 0, 0] }, ...both(LOW_HANDS) },
        ],
        life: { "head.x": "sin(u * 4.4) * 0.03" },
        frame: { dir: [-0.8, 0.1, 0.6], head: [0.62, 0.24], size: 0.45 },
        fov: 30,
        fstop: 2.0,
        hand: { tiltIn: -1, tilt: -0.3, settle: 1.2, shake: 0.35, creep: 0.08 },
        flare: { centre: ["0.12 + 0.04 * clamp(u / 1.6, 0, 1)", 0.45], radius: 0.36, gain: "0.3 * clamp((u - 0.6) / 0.3, 0, 1)" },
        lights: { ...CAR_LIGHTS, key: { at: [0.9, 2.0, 1.0], power: 1.2 } },
      },
      {
        // row 21 (23.19): low, the figure right of centre, an arm swinging across; a lamp column big at the left
        hands: { L: FIST, R: FIST },
        rows: [21],
        frames: 17,
        stage: "cars",
        at: [0.4, 0, -2.4],
        yaw: -0.2,
        keys: [
          { t: 0, body: { neck: [0.05, 0.2, 0] }, L: POINT_L, R: LOW_HANDS },
          { t: 0.4, body: { neck: [0.05, -0.1, 0] }, L: LOW_HANDS, R: right(POINT_L) },
        ],
        frame: { dir: [0.35, -0.45, 1], head: [0.56, 0.16], size: 0.28 },
        fov: 40,
        hand: { tiltIn: 2, tilt: 3, settle: 0.5, shake: 0.6, creep: 0.05 },
        // two tall tubes near the lens at the left, far out of focus: the reference's big columns
        tubes: [
          { from: [-0.9, 0.1, 0.4], to: [-0.9, 2.6, 0.4], radius: 0.09, radiance: 2.5 },
          { from: [-1.5, 0.1, -0.3], to: [-1.5, 2.6, -0.3], radius: 0.09, radiance: 2.5 },
        ],
        lights: { ...CAR_LIGHTS, warm: { at: [-2.5, 2.5, -1.0], power: 1.2 } },
      },
      {
        // row 24, first part (25.78): front, the white cars either side, the hands low then up in a gesture
        hands: { L: POINTING, R: LOOSE },
        rows: [24],
        frames: 20,
        stage: "cars",
        at: [0.2, 0, -2.0],
        keys: [
          { t: 0, body: { neck: [0.05, 0.1, 0] }, ...both(DOWN) },
          { t: 0.5, body: { neck: [0.05, 0.0, 0] }, L: LOW_HANDS, R: DOWN },
          { t: 0.8, body: { neck: [0.05, -0.15, 0] }, L: POINT_L, R: LOW_HANDS },
        ],
        life: { "head.x": "sin(u * 4.4) * 0.04" },
        frame: { dir: [0, 0, 1], head: [0.6, 0.26], size: 0.34 },
        fov: 36,
        hand: { tiltIn: -0.5, tilt: -0.2, settle: 0.5, shake: 0.3, creep: 0.03 },
        lights: CAR_LIGHTS,
      },
      {
        // row 55 (54.97): standing at the grey car's front corner, the phone at the ear; white cars either side, columns
        hands: { L: LOOSE, R: PHONE },
        rows: [55],
        frames: 15,
        stage: "cars",
        at: [0.9, 0, -2.1],
        keys: [
          { t: 0, body: { neck: [0.05, 0.2, 0] }, L: LOW_HANDS, R: PHONE_R },
          { t: 0.5, body: { neck: [0.05, 0.1, 0] }, L: DOWN, R: PHONE_R },
        ],
        life: { "head.x": "sin(u * 4.4) * 0.03" },
        frame: { dir: [-0.25, 0.05, 1], head: [0.56, 0.16], size: 0.17 },
        fov: 40,
        hand: { tiltIn: -0.5, tilt: -1, settle: 0.4, shake: 0.35, creep: 0.02 },
        lights: CAR_LIGHTS,
      },
      {
        // row 58 (57.31): low and close before the black car's lamps, both hands at the head over the face
        hands: { L: CUPPED, R: CUPPED },
        rows: [58],
        frames: 14,
        stage: "cars",
        at: [0, 0, 0.55],
        keys: [
          { t: 0, body: { neck: [0.1, 0, 0], head: [0.1, 0, 0] }, ...both(OVER_FACE) },
          { t: 0.45, body: { neck: [0.0, 0.15, 0], head: [0.0, 0.1, 0] }, L: OVER_FACE, R: right({ ...ON_CROWN, wrist: [0.12, 1.66, 0.06] }) },
        ],
        frame: { dir: [0, -0.5, 1], head: [0.48, 0.25], size: 0.42 },
        fov: 58,
        hand: { tiltIn: 2, tilt: 1, settle: 0.5, shake: 0.5, creep: 0.04 },
        lights: CAR_LIGHTS,
      },
    ],
  },
  {
    // ── take 6 "profile": a long lens close on the face and the chain, a pale grey ground (row 23) ──
    name: "profile",
    wardrobe: "fig",
    streak: { from: 0.2, to: 0.28, gain: 1.6, threshold: 4.5 },
    grade: { ...ROW_GRADE, exposure: 0.45 },
    ambient: 0.12,
    background: [0.55, 0.6, 0.6],
    beats: [
      {
        // row 23, first part (24.65): profile CU, the ringed left hand at the mouth, facing screen left
        hands: { L: { curl: 0.9, thumb: 0.5, extra: [0, 0.1, 0.2, 0.3] }, R: LOOSE },
        rows: [23],
        frames: 14,
        stage: "void",
        keys: [{ t: 0, body: { neck: [0.1, 0, 0], head: [0.05, 0, 0] }, L: mirror(MOUTH_R), R: DOWN }],
        frame: { dir: [1, -0.25, 0.45], head: [0.32, -0.18], size: 1.5 },
        fov: 20,
        focus: 0.6,
        fstop: 2.0,
        hand: { tiltIn: -0.5, tilt: -1, settle: 0.5, shake: 0.2, creep: 0.02 },
        lights: { key: { at: [1.0, 1.7, 0.6], power: 3.5 }, rimR: { at: [-0.6, 1.8, -0.5], power: 1.2 }, fill: { at: [0.8, 1.3, 0.2], power: 1.0 } },
      },
      {
        // row 23, second part (25.23): the chain at the side of the neck against the grey ground, soft
        hands: { L: LOOSE, R: LOOSE },
        rows: [23],
        frames: 13,
        stage: "void",
        keys: [{ t: 0, body: { neck: [0.1, 0, 0] }, ...both(DOWN) }],
        eye: [0.6, 1.42, 0.35],
        aim: [0.1, 1.45, 0.0],
        fov: 18,
        focus: 0.47,
        fstop: 2.0,
        hand: { tiltIn: -1, tilt: -1.5, settle: 0.5, shake: 0.2, creep: 0 },
        lights: { key: { at: [1.0, 2.0, -0.4], power: 1.5 }, rimR: { at: [-0.6, 1.8, -0.5], power: 1.2 }, cyan: { at: [0.8, 1.3, 0.6], power: 0.3 } },
      },
    ],
  },
  {
    // ── take 7 "profile-dark": close on the head against a dark teal ground, lamp columns (rows 24, 31) ──
    name: "profile-dark",
    wardrobe: "fig",
    streak: { from: 0.25, to: 0.35, gain: 1.6, threshold: 4.5 },
    grade: ROW_GRADE,
    ambient: 0.1,
    background: [0.03, 0.045, 0.045],
    beats: [
      {
        // row 24, second part (26.61): ECU from three-quarter behind: the beanie cuff, the sunglasses' temple, the cheek; lamps at the left
        hands: { L: LOOSE, R: LOOSE },
        rows: [24],
        frames: 25,
        stage: "void",
        keys: [{ t: 0, body: { neck: [0.1, 0.1, 0], head: [0.05, 0.05, 0] }, ...both(DOWN) }],
        life: { "head.y": "sin(u * 1.2) * 0.02" },
        frame: { dir: [-0.7, 0.3, 0.9], head: [0.4, 0.08], size: 1.7 },
        fov: 34,
        fstop: 2.8,
        hand: { tiltIn: 1, tilt: 1.5, settle: 0.8, shake: 0.15, creep: 0.01 },
        lights: { rimL: { at: [0.5, 1.9, -0.6], power: 1.5 }, key: { at: [-0.8, 2.0, 1.1], power: 2.5 }, cyan: { at: [0.6, 1.4, 0.6], power: 0.3 } },
        tubes: [
          { from: [0.9, 0.2, -1.4], to: [0.9, 2.8, -1.4], radius: 0.05, radiance: 4 },
          { from: [1.3, 0.2, -1.9], to: [1.3, 2.8, -1.9], radius: 0.05, radiance: 4 },
          { from: [1.7, 0.2, -2.4], to: [1.7, 2.8, -2.4], radius: 0.05, radiance: 4 },
        ],
      },
      {
        // row 31 (32.62): up at the face, looking up past a lamp column at the left
        hands: { L: LOOSE, R: LOOSE },
        rows: [31],
        frames: 12,
        stage: "void",
        keys: [{ t: 0, body: { neck: [-0.25, 0.2, 0], head: [-0.25, 0.1, 0] }, ...both(DOWN) }],
        frame: { dir: [0.2, -0.6, 1], head: [0.35, 0.28], size: 0.6 },
        fov: 42,
        fstop: 2.0,
        hand: { tiltIn: -3, tilt: -2, settle: 0.4, shake: 0.4, creep: 0.03 },
        lights: { key: { at: [-0.6, 2.2, 0.9], power: 1.5 }, top: { at: [0.2, 2.7, -0.5], power: 3 }, rimL: { at: [0.6, 1.8, -0.5], power: 1.2 } },
        tubes: [{ from: [-0.8, 0.2, -1.2], to: [-0.8, 2.8, -1.2], radius: 0.12, radiance: 1.8 }],
      },
    ],
  },
];

/** The beats' start times on their take's clock (frame-aligned, 24 fps). */
export function beatStarts(take: Take): number[] {
  const starts: number[] = [];
  let frame = 0;
  for (const beat of take.beats) {
    starts.push(frame / 24);
    frame += beat.frames;
  }
  return starts;
}

export interface McuOptions {
  readonly take?: number;
  readonly width?: number;
  readonly height?: number;
  readonly crt?: boolean;
  readonly hdri?: boolean;
  readonly audio?: boolean;
  /** T1407b (mcu2): another take table on this builder (shots/mcu2.ts); default MCU_TAKES. */
  readonly takes?: readonly Take[];
}

const fmt = (value: number): string => (Math.abs(value) < 1e-9 ? "0" : value < 0 ? `(${value.toFixed(5)})` : value.toFixed(5));

/** The step at `a` seconds (frame-aligned: 1 from the frame that starts there, 0 a sub-frame before). */
const after = (a: number): string => `clamp((abstime - ${a.toFixed(5)} + 0.0005) * 4000, 0, 1)`;

/** One value per beat, held through the beat and switched at each beat's first frame. */
function switched(values: readonly string[], starts: readonly number[]): string {
  if (values.every((value) => value === values[0])) return values[0]!;
  const terms = values.map((value, index) => {
    const on = index === 0 ? "1" : after(starts[index]!);
    const off = index + 1 < values.length ? ` - ${after(starts[index + 1]!)}` : "";
    return `(${value}) * (${on}${off})`;
  });
  return terms.join(" + ");
}

const sourceOf = (slot: StoredParameter): string => (slot as unknown as { bindings: { expression: { source: string } } }).bindings.expression.source;

/**
 * The WARM FLARE: the out-of-focus disc of a sodium lamp an arm's length off the lens — far
 * wider than the depth of field's largest disc (a lens element's ghost, not a scene bokeh): a
 * soft orange-red fill with a brighter rim, added in linear light before the grade.
 */
const WARM_FLARE_WGSL = `struct Params {
  centre: vec2f, // @default 0.1  Disc centre, uv.
  radius: f32, // @default 0.4  Radius, frame heights.
  gain: f32, // @default 0  Brightness (0 off).
  color: vec3f, // @default 1  Colour.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  if (params.gain <= 0.0) { return base; }
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let d = length((uv - params.centre) * vec2f(aspect, 1.0)) / max(params.radius, 1e-4);
  let fill = 1.0 - smoothstep(0.82, 1.0, d);
  let rim = exp(-pow((d - 0.93) / 0.06, 2.0));
  return vec4f(base.rgb + params.color * params.gain * (fill * 0.35 + rim * 0.65), base.a);
}`;

/**
 * A TUBE LAMP: an emissive capsule between `a` and `b` (world), drawn where the view ray passes
 * within `radius` of the segment and nothing nearer covers it. HDR radiance, soft-edged, so the
 * depth of field spreads it and the streak glass lengthens it. Input = the picture, More = [depth].
 */
const TUBE_WGSL = `struct Params {
${CAMERA_PARAMS}
  a: vec3f, // @default 0  One end (world metres).
  b: vec3f, // @default 0  The other end.
  radius: f32, // @default 0.03  Tube radius, metres.
  radiance: f32, // @default 0  Radiance (0 off).
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
${VIEW}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  if (params.radiance <= 0.0) { return base; }
  let v = makeView();
  let d = rayAt(v, uv);
  // closest approach between the ray eye + d t and the segment a + u s, s in [0, 1]
  let u = params.b - params.a;
  let w = params.eye - params.a;
  let aa = dot(d, d);
  let bb = dot(d, u);
  let cc = dot(u, u);
  let dd = dot(d, w);
  let ee = dot(u, w);
  let den = max(aa * cc - bb * bb, 1e-8);
  let sc = clamp((bb * ee - cc * dd) / den, 0.0, 1e6);
  let tc = clamp((aa * ee - bb * dd) / den, 0.0, 1.0);
  let gap = length(w + d * sc - u * tc);
  let core = 1.0 - smoothstep(params.radius * 0.6, params.radius, gap);
  if (core <= 0.0) { return base; }
  let p = params.a + u * tc;
  let z = viewDepth(uv);
  if (z > 0.0 && z < dot(p - params.eye, v.forward)) { return base; }
  return vec4f(base.rgb + vec3f(0.92, 0.97, 1.0) * params.radiance * core, base.a);
}`;

/** Figure-local → world (the skin kernel's turn: yaw about +Y, then the place). */
function toWorld(place: V3, yaw: number, local: V3): [number, number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [place[0] + c * local[0] + s * local[2], place[1] + local[1], place[2] - s * local[0] + c * local[2]];
}

/** The beat's eye and aim in world metres: given (`eye`/`aim`, `world`), or composed (`frame`). */
function framing(beat: Beat, place: V3, yaw: number, head: V3, aspect: number): { eye: [number, number, number]; aim: [number, number, number] } {
  if (beat.frame === undefined) {
    if (beat.eye === undefined || beat.aim === undefined) throw new Error(`mcu: beat of rows ${beat.rows.join(",")} has neither eye/aim nor frame.`);
    return beat.world === true ? { eye: [...beat.eye], aim: [...beat.aim] } : { eye: toWorld(place, yaw, beat.eye), aim: toWorld(place, yaw, beat.aim) };
  }
  const { dir, head: at, size } = beat.frame;
  const h = toWorld(place, yaw, head);
  const o = toWorld(place, yaw, [0, 0, 0]);
  const d0 = toWorld(place, yaw, dir);
  const d = [d0[0] - o[0], d0[1] - o[1], d0[2] - o[2]];
  const n = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
  const u = d.map((v) => v / n) as [number, number, number];
  const tanV = Math.tan((beat.fov * Math.PI) / 360);
  // the head (0.27 m, crown to chin with the beanie) fills `size` of the frame height
  const distance = 0.27 / (size * 2 * tanV);
  const eye: [number, number, number] = [h[0] + u[0] * distance, h[1] + u[1] * distance, h[2] + u[2] * distance];
  // turn the view off the head so the head lands at `at`: yaw (about +Y) then pitch
  const ax = Math.atan((at[0] - 0.5) * 2 * tanV * aspect);
  const ay = Math.atan((0.5 - at[1]) * 2 * tanV);
  const f = [-u[0], -u[1], -u[2]];
  const pitch0 = Math.asin(Math.max(-1, Math.min(1, f[1]!)));
  const heading0 = Math.atan2(f[0]!, -f[2]!);
  // the head to the right of centre means the lens looks to its left
  const heading = heading0 - ax;
  const pitch = pitch0 - ay;
  const forward: [number, number, number] = [Math.cos(pitch) * Math.sin(heading), Math.sin(pitch), -Math.cos(pitch) * Math.cos(heading)];
  return { eye, aim: [eye[0] + forward[0] * distance, eye[1] + forward[1] * distance, eye[2] + forward[2] * distance] };
}

/** Solve a beat's keys into per-knob keyed expressions over `u`. */
/** The head's centre (rest metres) the framing measures from: between the ears, at the brow. */
const HEAD_CENTRE: V3 = [0, 1.7, 0.06];

function performance(facts: OnNothingFacts, beat: Beat): { knobs: Record<string, string>; head: V3 } {
  const solved: Angles[] = [];
  let previous: Angles = {};
  for (const key of beat.keys) {
    const body: Angles = {};
    for (const [knob, angles] of Object.entries(key.body ?? {})) body[knob] = [...angles] as Euler;
    let pose: Angles = { ...previous, ...body };
    for (const side of ["L", "R"] as const) {
      const target = key[side];
      if (target === undefined) continue;
      pose = { ...pose, ...solveArm(facts.bones, pose, side, previous[`upperarm${side}`] === undefined ? target : { ...target, seed: undefined as never }) };
    }
    solved.push(pose);
    previous = pose;
  }
  const knobs = new Set(solved.flatMap((pose) => Object.keys(pose)));
  const out: Record<string, string> = {};
  for (const knob of knobs) {
    for (let axis = 0; axis < 3; axis++) {
      const keys = solved.map((pose, index) => [beat.keys[index]!.t, pose[knob]?.[axis] ?? 0, ...(beat.keys[index]!.snap === true ? ["snap"] : [])] as const);
      if (keys.every((key) => Math.abs(key[1]) < 1e-6)) continue;
      out[`${knob}.${"xyz"[axis]}`] = keys.length === 1 ? fmt(keys[0]![1]) : keyed("u", keys as never);
    }
  }
  for (const side of ["L", "R"] as const) {
    const shape = beat.hands?.[side];
    if (shape !== undefined) Object.assign(out, handPose(side, shape));
  }
  for (const [knob, expression] of Object.entries(beat.life ?? {})) {
    out[knob] = out[knob] === undefined ? expression : `${out[knob]} + ${expression}`;
  }
  return { knobs: out, head: posed(facts.bones, solved[0] ?? {}, boneIndex(facts.bones, "head"), HEAD_CENTRE) };
}

export function mcuDocument(facts: OnNothingFacts, options: McuOptions): ProjectDocument {
  const takeIndex = options.take ?? 0;
  const table = options.takes ?? MCU_TAKES; // T1407b (mcu2)
  const take = table[takeIndex];
  if (take === undefined) throw new Error(`mcuDocument: no take ${takeIndex} (there are ${table.length}).`);
  const width = options.width ?? 1920;
  const height = options.height ?? 818;
  const aspect = width / height;
  const starts = beatStarts(take);
  const local = (index: number, expression: string): string => expression.replace(/\bu\b/g, `(abstime - ${starts[index]!.toFixed(5)})`);
  const cars = take.beats.some((beat) => beat.stage === "cars");
  const g = new ShotGraph();

  // ── Where each beat stands ──
  const places = take.beats.map((beat) => {
    const mark = STAGE_MARK[beat.stage];
    const offset = beat.at ?? [0, 0, 0];
    return [mark[0] + offset[0], mark[1] + offset[1], mark[2] + offset[2]] as V3;
  });
  const yaws = take.beats.map((beat) => beat.yaw ?? 0);

  // ── The material every surface wears; the car row ──
  const footprints: Footprint[] = cars
    ? carAreas(facts).map((area) => {
        const b = facts.areas.get(area)!.bounds;
        return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, (b.max[0] - b.min[0]) / 2 - 0.12, (b.max[2] - b.min[2]) / 2 - 0.25] as const;
      })
    : [];
  g.node("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: surfaceWgsl(footprints), headGain: 1, wet: 0, wetGloss: 0.32, dryGloss: 0.6 }, { label: "surf1" });
  const scenes: string[] = [];
  const lights: string[] = [];
  const projectors: string[] = [];
  if (cars) {
    ["wh", ...carAreas(facts)].forEach((area, index) => {
      const mesh = facts.areas.get(area as never);
      if (mesh === undefined) throw new Error(`mcuDocument: no "${area}" area in the GLB.`);
      g.node(`mesh_${area}`, "meshFileIn", [-3600, index * 250], { file: facts.glbUrl, select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts }, { label: `mesh${area}1` });
      g.node(`geo_${area}`, "geometry", [-3300, index * 250], { mode: "surface", material: "surf1" }, { label: `geo${area}1` });
      g.edge(`mesh-geo-${area}`, [`mesh_${area}`, "out"], [`geo_${area}`, "points"]);
      scenes.push(`geo${area}1`);
    });
    const glass = facts.areas.get("lampglass");
    if (glass !== undefined) {
      g.node("mesh_lampglass", "meshFileIn", [-3600, 1700], { file: facts.glbUrl, select: glass.select, vertices: glass.vertices, triangles: glass.triangles, parts: glass.parts }, { label: "meshlampglass1" });
      g.node("glassMat", "materialWgsl", [-3300, 1750], { model: "unlit", source: LAMP_GLASS_WGSL, roughness: 0.02 }, { label: "glassmat1" });
      g.node("geo_lampglint", "geometry", [-3000, 1750], { mode: "surface", material: "glassmat1", blend: "additive" }, { label: "geolampglint1" });
      g.edge("mesh-geo-lampglint", ["mesh_lampglass", "out"], ["geo_lampglint", "points"]);
      scenes.push("geolampglint1");
    }
    // one projector per car, from between its headlights (document.ts's low beams)
    g.node("cookieSeed", "ramp", [-3000, 2000], {}, { label: "cookieseed1", resolution: { mode: "fixed", width: 256, height: 128 } });
    g.node("cookie", "customWgsl", [-2800, 2000], { source: HEADLIGHT_COOKIE_WGSL }, { label: "cookie1", resolution: { mode: "fixed", width: 256, height: 128 } });
    g.edge("seed-cookie", ["cookieSeed", "out"], ["cookie", "input"]);
    const heads = [...facts.markers.values()].filter((marker) => marker.name.startsWith("lamp.head."));
    const carIds = [...new Set(heads.map((marker) => marker.name.slice("lamp.head.".length, -1)))].sort();
    carIds.forEach((car, index) => {
      const pair = heads.filter((marker) => marker.name.slice("lamp.head.".length, -1) === car);
      const centre = [0, 1, 2].map((axis) => pair.reduce((sum, marker) => sum + marker.position[axis]!, 0) / pair.length) as [number, number, number];
      const dir = (pair[0]!.extras?.["loom_light_dir"] as number[] | undefined) ?? [0, 0, 1];
      const id = `head${index}`;
      g.node(id, "projector", [-2600, 2000 + index * 60], {
        eye: [...centre],
        lookAt: [centre[0] + dir[0]! * 2, centre[1] + dir[1]! * 2, centre[2] + dir[2]! * 2],
        throwRatio: 0.5,
        aspect: 2.4,
        brightness: 2.5,
        color: [0.78, 0.92, 1, 1],
        falloff: true,
        occlusion: true,
      }, { label: `${id}1` });
      g.edge(`cookie-${id}`, ["cookie", "out"], [id, "cookie"]);
      projectors.push(`${id}1`);
    });
    // the room's sodium high-bays (document.ts), and a low cool key on the car fronts from far behind the lens
    const warm = [1, 0.52, 0.2, 1];
    g.node("sodiumA", "light", [-2600, 2400], { kind: "point", position: [-9, 7.2, -6], color: warm, intensity: 4 }, { label: "sodiuma1" });
    g.node("sodiumB", "light", [-2600, 2500], { kind: "point", position: [10, 7.2, -9], color: warm, intensity: 3 }, { label: "sodiumb1" });
    g.node("carKey", "light", [-2600, 2600], { kind: "point", position: [0, 0.45, 16], color: [0.88, 0.94, 1, 1], intensity: take.carKey ?? 10 }, { label: "carkey1" });
    lights.push("sodiuma1", "sodiumb1", "carkey1");
  }

  // ── The figure ──
  const pose: Record<string, string[]> = {};
  const heads: V3[] = [];
  take.beats.forEach((beat, index) => {
    const acted = performance(facts, beat);
    heads.push(acted.head);
    for (const [knob, expression] of Object.entries(acted.knobs)) {
      (pose[knob] ??= take.beats.map(() => "0"))[index] = local(index, expression);
    }
  });
  const figure = figureNodes(facts, {
    area: take.wardrobe,
    material: "surf1",
    yaw: switched(yaws.map(fmt), starts),
    place: [0, 1, 2].map((axis) => switched(places.map((p) => fmt(p[axis]!)), starts)) as [string, string, string],
    pose: Object.fromEntries(Object.entries(pose).map(([knob, values]) => [knob, switched(values, starts)])),
    ...(take.gun === true ? { gun: true } : {}), // T1407b (mcu2)
  });
  g.nodes.push(...figure.nodes);
  g.edges.push(...figure.edges);
  scenes.push(figure.scene);

  // ── The lights of the beats: one node per slot any beat uses, placed and powered per beat ──
  (Object.keys(SLOTS) as Slot[]).forEach((slot, index) => {
    if (!take.beats.some((beat) => beat.lights[slot] !== undefined)) return;
    const world = take.beats.map((beat, b) => toWorld(places[b]!, yaws[b]!, beat.lights[slot]?.at ?? [0, 3, 0]));
    const params: Record<string, StoredParameter> = {
      kind: "point",
      color: [...SLOTS[slot], 1],
      position: world[0]!,
      intensity: expressionSlot(switched(take.beats.map((beat) => fmt(beat.lights[slot]?.power ?? 0)), starts), take.beats[0]!.lights[slot]?.power ?? 0),
    };
    [0, 1, 2].forEach((axis) => {
      params[`position.${"xyz"[axis]}`] = expressionSlot(switched(world.map((p) => fmt(p[axis]!)), starts), world[0]![axis]!);
    });
    g.node(`l_${slot}`, "light", [-2600, 1000 + index * 100], params, { label: `l${slot.toLowerCase()}1` });
    lights.push(`l${slot.toLowerCase()}1`);
  });

  // ── Environment (reflections: the jewellery's glints) ──
  g.node("envSeed", "ramp", [-2700, 300], {}, { label: "envseed1", resolution: { mode: "fixed", width: 1024, height: 512 } });
  // a jeweller's studio for the reflections (closeups-fx.ts): cards round the lens, an overhead
  // box, a scatter of hard points — the chain, the rings and the sunglasses glint white, as in
  // the reference, where the room's own bars left them black
  const toward = take.beats.map((beat, b) => {
    const e = framing(beat, places[b]!, yaws[b]!, heads[b]!, aspect).eye;
    const f = toWorld(places[b]!, yaws[b]!, [0, 1.35, 0]);
    const d = [e[0] - f[0], e[1] - f[1], e[2] - f[2]];
    const n = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    return d.map((v) => v / n) as [number, number, number];
  });
  const envParams: Record<string, StoredParameter> = { source: STUDIO_ENV_WGSL, softbox: 3, strip: 4, points: 60, count: 70, size: 0.01, ambient: 0.004, surround: 1.0, cards: 60, room: 0, toward: toward[0]! };
  [0, 1, 2].forEach((axis) => { envParams[`toward.${"xyz"[axis]}`] = expressionSlot(switched(toward.map((v) => fmt(v[axis]!)), starts), toward[0]![axis]!); });
  g.node("env", "customWgsl", [-2700, 500], envParams, { label: "env1", resolution: { mode: "fixed", width: 1024, height: 512 } });
  g.edge("seed-env", ["envSeed", "out"], ["env", "input"]);
  const hdri = options.hdri === true;
  if (hdri) {
    g.node("hdri", "movieFileIn", [-2900, 700], { file: "media/on-nothing/hdri.png" }, { label: "hdri1", resolution: { mode: "fixed", width: 2048, height: 1024 } });
    g.node("envHdri", "customWgsl", [-2700, 700], { source: ENVIRONMENT_HDRI_WGSL, gain: 0.6, crush: 0.7 }, { label: "envhdri1", resolution: { mode: "fixed", width: 2048, height: 1024 } });
    g.edge("hdri-env", ["hdri", "out"], ["envHdri", "input"]);
  }

  // ── The operator ──
  const framed = take.beats.map((beat, b) => framing(beat, places[b]!, yaws[b]!, heads[b]!, aspect));
  const eyes = framed.map((f) => f.eye);
  const aims = framed.map((f) => f.aim);
  const moves = take.beats.map((beat, b) => handheld(eyes[b]!, aims[b]!, { ...beat.hand, timeOffset: -starts[b]! }));
  const camera: Record<string, StoredParameter> = {};
  for (const key of ["eye.x", "eye.y", "eye.z", "lookAt.x", "lookAt.y", "lookAt.z", "roll"]) {
    const retained = key.startsWith("eye") ? eyes[0]![key.endsWith("x") ? 0 : key.endsWith("y") ? 1 : 2]! : key === "roll" ? 0 : aims[0]![key.endsWith("x") ? 0 : key.endsWith("y") ? 1 : 2]!;
    camera[key] = expressionSlot(switched(moves.map((move) => sourceOf(move[key]!)), starts), retained);
  }
  const fovs = take.beats.map((beat) => beat.fov);
  camera["fov"] = expressionSlot(switched(fovs.map(fmt), starts), fovs[0]!);
  g.node("cam", "camera", [-2700, -900], { eye: eyes[0]!, lookAt: aims[0]!, fov: fovs[0]!, near: 0.03, far: 200, ...camera }, { label: "cam1" });
  const cameraParams = cameraRefs("cam1", eyes[0]!, aims[0]!, fovs[0]!, 200);

  g.node("shot", "render", [-2400, 0], {
    scenes: scenes.join(" "),
    camera: "cam1",
    lights: lights.join(" "),
    projectors: projectors.join(" "),
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: take.ambient,
    background: [...(take.background ?? [0, 0, 0]), 1],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    albedoOutput: true,
    environmentIntensity: 0.25,
    environmentTaps: 16,
  }, { label: "shot1" });
  g.edge("env-shot", [hdri ? "envHdri" : "env", "out"], ["shot", "environment"]);

  // ── Screen space ──
  const depth = ["shot", "depth"] as const;
  const normal = ["shot", "normal"] as const;
  if (cars) {
    g.pass("reflections", GLOSSY_SSR_WGSL, { ...cameraParams, strength: 1.2, maxDistance: 30, roughnessCutoff: 0.55, thickness: 0.4, blur: 1.6, stretch: 4, keepBright: 4, dimShare: 0.1 }, g.last, [depth, normal], [-2100, 0]);
  }
  g.pass("occlusion", GTAO_WGSL, { ...cameraParams, radius: 0.3, strength: 0.9, power: 1.6 }, g.last, [depth, normal], [-1900, 0]);
  if (cars) {
    g.pass("haze", hazeWgsl(hazeLights(facts, ["head"])), { ...cameraParams, density: 0.035, ambient: [0.0025, 0.0045, 0.005], anisotropy: 0.72, head: 0.25 }, g.last, [depth], [-1700, 0]);
  }
  // the lens: the thin-lens depth of field (closeups-fx.ts), its focal length from the fov
  const focal = (fov: number): number => 18 / (Math.tan((fov * Math.PI) / 360) * aspect);
  const lensParams: Record<string, StoredParameter> = {
    ...cameraParams,
    focal: expressionSlot(switched(fovs.map((fov) => fmt(focal(fov))), starts), focal(fovs[0]!)),
    fstop: expressionSlot(switched(take.beats.map((beat) => fmt(beat.fstop ?? 2)), starts), take.beats[0]!.fstop ?? 2),
    focus: expressionSlot(switched(take.beats.map((beat, b) => (typeof beat.focus === "string" ? local(b, beat.focus) : fmt(beat.focus ?? Math.hypot(eyes[b]![0] - aims[b]![0], eyes[b]![1] - aims[b]![1], eyes[b]![2] - aims[b]![2])))), starts), 1),
    maxCoc: 0.03,
  };
  // the practical lamps, drawn before the lens blurs them (so they bloom into discs and streak)
  const lampCount = Math.max(0, ...take.beats.map((beat) => beat.lamps?.length ?? 0));
  for (let k = 0; k < lampCount; k++) {
    const world = take.beats.map((beat, b) => toWorld(places[b]!, yaws[b]!, beat.lamps?.[k]?.at ?? [0, -50, 0]));
    const params: Record<string, StoredParameter> = {
      ...cameraParams,
      lamp: world[0]!,
      size: expressionSlot(switched(take.beats.map((beat) => fmt(beat.lamps?.[k]?.size ?? 0.05)), starts), 0.05),
      radiance: expressionSlot(switched(take.beats.map((beat) => fmt(beat.lamps?.[k]?.radiance ?? 0)), starts), 0),
      tint: [0.9, 0.96, 1, 1],
    };
    [0, 1, 2].forEach((axis) => { params[`lamp.${"xyz"[axis]}`] = expressionSlot(switched(world.map((p) => fmt(p[axis]!)), starts), world[0]![axis]!); });
    g.pass(`lamp${k}`, LAMP_DISC_WGSL, params, g.last, [depth], [-1600, 200 + k * 100]);
  }
  const tubeCount = Math.max(0, ...take.beats.map((beat) => beat.tubes?.length ?? 0));
  for (let k = 0; k < tubeCount; k++) {
    const params: Record<string, StoredParameter> = {
      ...cameraParams,
      radius: expressionSlot(switched(take.beats.map((beat) => fmt(beat.tubes?.[k]?.radius ?? 0.03)), starts), 0.03),
      radiance: expressionSlot(switched(take.beats.map((beat) => fmt(beat.tubes?.[k]?.radiance ?? 0)), starts), 0),
    };
    for (const end of ["a", "b"] as const) {
      const world = take.beats.map((beat, b) => toWorld(places[b]!, yaws[b]!, (end === "a" ? beat.tubes?.[k]?.from : beat.tubes?.[k]?.to) ?? [0, -50, 0]));
      params[end] = world[0]!;
      [0, 1, 2].forEach((axis) => { params[`${end}.${"xyz"[axis]}`] = expressionSlot(switched(world.map((q) => fmt(q[axis]!)), starts), world[0]![axis]!); });
    }
    g.pass(`tube${k}`, TUBE_WGSL, params, g.last, [depth], [-1580, 600 + k * 100]);
  }
  g.pass("dof", LENS_DOF_WGSL, lensParams, g.last, [depth], [-1500, 0]);
  g.pass("dofFill", DOF_FILL_WGSL, lensParams, g.last, [depth], [-1400, 0]);
  if (take.beats.some((beat) => beat.flare !== undefined)) {
    const flare = (b: number, axis: 0 | 1): string => {
      const value = take.beats[b]!.flare?.centre[axis] ?? 0.5;
      return typeof value === "string" ? local(b, value) : fmt(value);
    };
    g.pass("flare", `${SHARED_UNIFORMS_WGSL}\n${WARM_FLARE_WGSL}`, {
      centre: [0.1, 0.4],
      "centre.x": expressionSlot(switched(take.beats.map((_, b) => flare(b, 0)), starts), 0.1),
      "centre.y": expressionSlot(switched(take.beats.map((_, b) => flare(b, 1)), starts), 0.4),
      radius: expressionSlot(switched(take.beats.map((beat) => fmt(beat.flare?.radius ?? 0.4)), starts), 0.4),
      gain: expressionSlot(switched(take.beats.map((beat, b) => { const v = beat.flare?.gain ?? 0; return typeof v === "string" ? local(b, v) : fmt(v); }), starts), 0),
      color: [1, 0.48, 0.2],
    }, g.last, [], [-1350, 0]);
  }
  const scene = g.last;

  // ── Optics: the streak glass (three chained box passes, document.ts's), bloom ──
  const audio = options.audio === true;
  if (audio) {
    g.node("song", "audioFileIn", [-4200, 1400], { file: "media/on-nothing/song.wav", playMode: "timeline" }, { label: "song1" });
    g.node("pickLevels", "valueSelect", [-3900, 1300], { channels: "level low high" }, { label: "picklevels1" });
    g.node("smooth", "valueLag", [-3600, 1300], { lag: 0.02, releaseRatio: 4 }, { label: "smooth1" });
    g.node("rank", "valueNormalize", [-3300, 1300], { window: 16 }, { label: "rank1" });
    g.node("levels", "valueLag", [-3000, 1300], { lag: 1.0, releaseRatio: 1.5 }, { label: "levels1" });
    g.edge("song-pick", ["song", "out"], ["pickLevels", "in"]);
    g.edge("pick-smooth", ["pickLevels", "out"], ["smooth", "in"]);
    g.edge("smooth-rank", ["smooth", "out"], ["rank", "in"]);
    g.edge("rank-levels", ["rank", "out"], ["levels", "in"]);
  }
  const loud = audio ? "clamp(op('levels1').chan.level * 0.6 + op('levels1').chan.low * 0.4, 0, 1)" : "0.5";
  // one direction per cut: each beat's columns grow from `from` to `to` over the beat
  const grow = switched(take.beats.map((beat, b) => `clamp((abstime - ${starts[b]!.toFixed(5)}) / ${(beat.frames / 24).toFixed(5)}, 0, 1)`), starts);
  const reach = `((${take.streak.from} + (${take.streak.to - take.streak.from}) * (${grow})) * (0.9 + 0.2 * ${loud}))`;
  g.node("bright", "customWgsl", [-1300, 300], { source: BRIGHT_PASS_WGSL, threshold: 1.4, knee: 0.8 }, { label: "bright1", resolution: { mode: "scale", factor: 0.5 } });
  g.edge("scene-bright", scene, ["bright", "input"]);
  g.node("streakSrc", "customWgsl", [-1300, 200], { source: BRIGHT_PASS_WGSL, threshold: take.streak.threshold, knee: 1.2 }, { label: "streaksrc1", resolution: { mode: "scale", factor: 0.5 } });
  g.edge("scene-streaksrc", scene, ["streakSrc", "input"]);
  ([400, 60, 20] as const).forEach((div, index) => {
    const id = `streak${index}`;
    g.node(id, "customWgsl", [-1100 + index * 100, 300], { source: STREAK_WGSL, step: expressionSlot(`${reach} / ${div}`, take.streak.from / div), decay: index === 2 ? 1.6 : 50, finish: index === 2 ? 1 : 0, compress: index === 0 ? 3 : 0, ...(index === 0 ? { minSize: 0.004 } : {}), down: 0, gain: take.streak.gain, striation: 0.22, striationScale: 110 }, { label: `${id}1`, resolution: { mode: "scale", factor: 1 } });
    g.edge(`into-${id}`, [index === 0 ? "streakSrc" : `streak${index - 1}`, "out"], [id, "input"]);
  });
  for (const level of [1, 2, 3, 4]) {
    g.node(`bloomDown${level}`, "customWgsl", [-900, 150 + level * 150], { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? 1 : 0 }, { label: `bloomdown${level}1`, resolution: { mode: "scale", factor: 0.5 } });
    g.edge(`bloom-down${level}`, [level === 1 ? "bright" : `bloomDown${level - 1}`, "out"], [`bloomDown${level}`, "input"]);
  }
  for (const level of [0, 1, 2, 3]) {
    g.node(`bloomUp${level}`, "customWgslMulti", [-700, 150 + level * 150], { source: BLOOM_UP_WGSL, lower: 1 }, { label: `bloomup${level}1`, resolution: { mode: "scale", factor: 2 } });
    g.edge(`bloom-up${level}-lower`, [level === 3 ? "bloomDown4" : `bloomUp${level + 1}`, "out"], [`bloomUp${level}`, "input"]);
    g.edge(`bloom-up${level}-own`, [level === 0 ? "bright" : `bloomDown${level}`, "out"], [`bloomUp${level}`, "more"], 0);
  }
  g.pass("optics", OPTICS_COMPOSITE_WGSL, { streak: 0.8, halo: 0, bloom: 0.12, streakTint: [0.9, 0.97, 1, 1] }, scene, [["streak2", "out"], ["bright", "out"], ["bloomUp0", "out"]], [-500, 0]);

  // ── Lens and grade ──
  g.pass("lens", LENS_WGSL, { distortion: 0.05, edgeBlur: 0.016, swirl: 0.6, aberration: 0.002, vignette: 0.65, vignetteRound: 0.75 }, g.last, [], [-300, 0]);
  g.pass("grade", GRADE_WGSL, { ...take.grade, grainSize: 1.3 * (width / 1920) }, g.last, [], [-100, 0]);
  if (options.crt === true) g.pass("crt", CRT_WGSL, { amount: 1 }, g.last, [], [500, 0]);
  return g.document("mcu", width, height);
}
