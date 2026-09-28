import type { GraphEdge, GraphNode, ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { handPose, PISTOL_GRIP } from "../skin-kernel.ts";
import { figureNodes } from "./figure.ts";
import type { Pose } from "./gait.ts";
import { pistolPose, solveArm as solveHand, type ArmGoal } from "./hands.ts";
import { type Beat, type McuOptions, type Take, beatStarts, mcuDocument } from "./mcu.ts";
import { type ArmTarget, mirror } from "./mcu-rig.ts";
import { addNode, connect, finish, setParams, spliceAfter, surgery } from "./splice.ts";

/**
 * T1407b (mcu2) — THE PERFORMER CLOSE-UPS of 42–51 s (rows 39, 41, 42, 44, 49, 50, 51, 52a),
 * on shots/mcu.ts's builder with a take table of their own. Everything a beat is — the stage,
 * the arm targets (shots/mcu-rig.ts), the operator, the lights — is mcu.ts's; this file adds
 * what those rows need on top, by graph surgery on the finished document:
 *
 *  - FINGERS: the hand knobs (skin-kernel.ts handPose: the middle fingers up, the index to the
 *    lips, two fingers pointing) ride in a beat's `life`, which mcu.ts adds to the knobs as is;
 *  - palm-true hands (the flipped backs of row 51, the finger at the lips of row 50) come from
 *    shots/hands.ts's solver, which aims the palm too, and ride in `life` the same way;
 *  - the PISTOL (rows 51b, 52a: hands.ts's pistolPose and figureNodes' gun);
 *  - STROBE frames (rows 42, 51a): the front lights drop out on the reference's dark frames
 *    while the headlights behind stay on;
 *  - a red practical's bokeh (row 39);
 *  - row 50's SPLIT: a pale cyc strip behind the profile at the left, the figure standing on it
 *    small and soft (a second, renamed figure in the same Render), a cool grey-teal ground
 *    elsewhere — keyed in wherever the Render saw nothing.
 */

export const MCU2_SHOTS = ["mcu2"] as const;

// ── Poses (figure rest frame: x its left, y up, z its front; metres) ──
/** Arms down, the hands loose at the thighs (mcu.ts's DOWN). */
const DOWN: ArmTarget = { elbow: [0.24, 1.18, -0.02], wrist: [0.27, 0.93, 0.06], tip: [0.28, 0.78, 0.1], seed: [[0, 0, -0.62], [0, 0, 0], [0, 0, 0]] };
/** The left arm swung out to the side and forward, low (row 41). */
const SWING_L: ArmTarget = { elbow: [0.4, 1.26, 0.12], wrist: [0.6, 1.36, 0.36], tip: [0.68, 1.4, 0.5], seed: [[-0.6, 0, 0.9], [-0.6, 0, 0], [0, 0, 0]] };
/** The right hand at the cap's brim (row 49). */
const BRIM_R: ArmTarget = { elbow: [-0.36, 1.42, 0.18], wrist: [-0.14, 1.72, 0.2], tip: [-0.03, 1.82, 0.24], seed: [[-1.0, 0, -0.9], [-1.6, 0, 0], [0, 0, 0]] };
/** The right hand dropping away from it, before the chest (row 49). */
const CHEST_R: ArmTarget = { elbow: [-0.3, 1.14, 0.12], wrist: [-0.2, 1.3, 0.3], tip: [-0.12, 1.36, 0.44], seed: [[-0.8, 0, -0.3], [-1.2, 0, 0], [0, 0, 0]] };
/** The left forearm raised at the frame's right edge, the bracelets (row 49). */
const RAISED_L: ArmTarget = { elbow: [0.34, 1.22, 0.14], wrist: [0.28, 1.5, 0.26], tip: [0.24, 1.66, 0.3], seed: [[-0.6, 0, 0.5], [-1.8, 0, 0], [0, 0, 0]] };
/** Row 44: palms over the face, the fingers up over the brow (mcu.ts's OVER_FACE, the head tipped back). */
const OVER_FACE: ArmTarget = { elbow: [0.2, 1.3, 0.3], wrist: [0.05, 1.56, 0.3], tip: [0.03, 1.76, 0.27], seed: [[-1.0, 0, 0.3], [-1.6, 0, 0.3], [0, 0, 0]] };
/** …the hands sliding down to the mouth, the fingers still up. */
const AT_MOUTH: ArmTarget = { elbow: [0.22, 1.26, 0.3], wrist: [0.08, 1.46, 0.34], tip: [0.06, 1.64, 0.32], seed: [[-1.0, 0, 0.3], [-1.6, 0, 0.3], [0, 0, 0]] };
/** …and opening out, palms up and forward, the fingers spread. */
const OPEN: ArmTarget = { elbow: [0.2, 1.18, 0.24], wrist: [0.08, 1.42, 0.36], tip: [0.1, 1.58, 0.44], seed: [[-1.0, 0, 0.3], [-1.3, 0, 0.3], [0, 0, 0]] };
/** Row 52a: the left hand forward, two fingers pointing across at the lens. */
const TWO_FINGERS_L: ArmTarget = { elbow: [0.3, 1.2, 0.26], wrist: [0.15, 1.42, 0.44], tip: [0.03, 1.45, 0.54], seed: [[-1.2, 0, 0.3], [-0.6, 0, 0], [0, 0, 0]] };
/** Row 52a's crouch at the lens: the torso folded forward, the head up (the legs sink below the floor, out of frame). */
const CROUCH: Record<string, [number, number, number]> = { spine: [0.25, 0, 0], chest: [0.15, 0.05, 0], neck: [-0.3, 0, 0], head: [-0.12, 0, 0] };

const both = (left: ArmTarget): { L: ArmTarget; R: ArmTarget } => ({ L: left, R: mirror(left) });
const f = (value: number): string => (value < 0 ? `(${value.toFixed(5)})` : value.toFixed(5));

/** A hands.ts solve (wrist, finger direction, palm) as fixed knob expressions, for a beat's `life`. */
function palmTrue(facts: OnNothingFacts, side: "L" | "R", goal: ArmGoal, base: Pose = {}): Record<string, string> {
  const pose = solveHand(facts.bones, side, goal, { place: [0, 0, 0], yaw: 0 }, base);
  const out: Record<string, string> = {};
  for (const [knob, angles] of Object.entries(pose)) {
    angles.forEach((value, axis) => {
      if (Math.abs(value) > 1e-6) out[`${knob}.${"xyz"[axis]}`] = f(value);
    });
  }
  return out;
}

/** Light sets (figure-local metres). */
const CAP_ROW_LIGHTS: Beat["lights"] = {
  key: { at: [-0.5, 2.2, 1.1], power: 1.2 },
  top: { at: [0.1, 2.8, -0.8], power: 2 },
  fill: { at: [0.3, 1.1, 1.2], power: 0.15 },
  warm: { at: [1.6, 2.4, -1.4], power: 0.8 },
};
const VOID_TOP: Beat["lights"] = {
  top: { at: [0.0, 2.5, -0.1], power: 14 },
  key: { at: [-0.4, 2.4, 1.2], power: 1.6 },
  rimL: { at: [0.7, 1.9, -0.7], power: 1.0 },
  rimR: { at: [-0.7, 1.8, -0.7], power: 0.9 },
  fill: { at: [0.2, 1.2, 1.4], power: 0.15 },
};

const ROW_GRADE: Record<string, StoredParameter> = { exposure: 0.3, black: 0.035, contrast: 1.18, saturation: 0.2, keepWarm: 0.2, bleach: 0.3, steel: [0.96, 1.01, 1.03], shadowTint: [0.96, 1.02, 1.03, 1], split: 0.4, grain: 0.035 };
const VOID_GRADE: Record<string, StoredParameter> = { exposure: 0.35, black: 0.04, contrast: 1.2, saturation: 0.2, keepWarm: 0.2, bleach: 0.3, steel: [0.95, 1.0, 1.03], shadowTint: [0.95, 1.01, 1.04, 1], split: 0.4, grain: 0.035 };

/** What mcu2 adds to a take: strobe frames per beat (beat-local frame numbers), a red practical, the split's cyc. */
interface Extras {
  readonly dark?: Readonly<Record<number, readonly number[]>>;
  readonly red?: boolean;
  readonly cyc?: boolean;
  /** The room's sodium high-bays, times this (row 41's warm walls). */
  readonly sodium?: number;
}

/** Row 51a's lean at the lens (the body knobs the palm-true arms are solved on). */
const LEAN: Record<string, [number, number, number]> = { spine: [0.12, 0, 0], chest: [0.1, 0, 0], neck: [-0.1, 0, 0], head: [-0.08, 0, 0] };

function takes(facts: OnNothingFacts): { take: Take; extras: Extras }[] {
  const flipL = handPose("L", { curl: 1.45, flip: 1, thumb: 0.7 });
  const flipR = handPose("R", { curl: 1.45, flip: 1, thumb: 0.7 });
  const loose = { ...handPose("L", { curl: 0.35, thumb: 0.2, extra: [0, 0.05, 0.1, 0.2] }), ...handPose("R", { curl: 0.35, thumb: 0.2, extra: [0, 0.05, 0.1, 0.2] }) };
  return [
    {
      // ── take 0 "beanie": the beanie and the tee: the face CUs of row 39, row 41 before the car row, row 49 in the void ──
      take: {
        name: "beanie",
        wardrobe: "fig",
        streak: { from: 0.2, to: 0.3, gain: 1.8, threshold: 4.5 },
        grade: { ...ROW_GRADE, saturation: 0.15, keepWarm: 0.2 },
        ambient: 0.06,
        carKey: 2,
        beats: [
          {
            // row 39, parts a–e (42.88): up under the chin, very close, soft, the focus arriving on the sunglasses
            rows: [39],
            frames: 10,
            stage: "void",
            keys: [
              { t: 0, body: { neck: [-0.12, 0.08, 0], head: [-0.1, 0.05, 0] }, ...both(DOWN) },
              { t: 0.4, body: { neck: [-0.05, 0.02, 0], head: [-0.04, 0, 0] }, ...both(DOWN) },
            ],
            life: { "head.x": "sin(u * 4.4) * 0.03", ...loose },
            frame: { dir: [0.12, -0.55, 1], head: [0.56, 0.33], size: 1.3 },
            fov: 42,
            focus: "0.1 + 0.2 * clamp((u - 0.3) / 0.08, 0, 1)",
            fstop: 1.2,
            hand: { tiltIn: 2, tilt: 1, settle: 0.4, shake: 0.35, creep: 0.02 },
            lights: { key: { at: [0.2, 1.2, 0.9], power: 1.8 }, top: { at: [0.1, 2.6, -0.5], power: 1.5 }, fill: { at: [-0.4, 1.9, 0.8], power: 0.6 } },
            lamps: [{ at: [-0.5, 1.3, -1.6], size: 0.35, radiance: 0.5 }],
          },
          {
            // row 39, parts f–g (43.34): the beanie and the sunglasses, the head lowered
            rows: [39],
            frames: 6,
            stage: "void",
            keys: [{ t: 0, body: { neck: [-0.08, 0.05, 0], head: [-0.08, 0, 0] }, ...both(DOWN) }],
            life: { "head.x": "sin(u * 4.4) * 0.03", ...loose },
            frame: { dir: [0.1, 0.15, 1], head: [0.56, 0.42], size: 1.0 },
            fov: 40,
            fstop: 2,
            hand: { tiltIn: -1, tilt: -1.5, settle: 0.3, shake: 0.3, creep: 0.05 },
            lights: { key: { at: [-0.4, 2.1, 1.0], power: 1.5 }, top: { at: [0.1, 2.6, -0.5], power: 1.5 }, fill: { at: [0.1, 1.2, 0.8], power: 0.2 } },
            lamps: [{ at: [-0.6, 1.4, -1.6], size: 0.35, radiance: 0.4 }],
          },
          {
            // row 41 (44.13): ground-up, a wide lens; the left arm swings out at the lens; tubes and sodium behind
            rows: [41],
            frames: 8,
            stage: "cars",
            keys: [
              { t: 0, body: { neck: [-0.02, 0.1, 0], head: [0, 0.05, 0] }, L: DOWN, R: DOWN },
              { t: 0.3, body: { neck: [-0.02, -0.05, 0], head: [0, 0, 0] }, L: SWING_L, R: DOWN },
            ],
            life: loose,
            frame: { dir: [0.05, -0.5, 1], head: [0.55, 0.27], size: 0.62 },
            fov: 58,
            fstop: 2.4,
            hand: { tiltIn: 3, tilt: 2, settle: 0.3, shake: 0.6, creep: 0.1 },
            lights: { ...CAP_ROW_LIGHTS, key: { at: [-0.6, 2.0, 1.0], power: 0.8 } },
          },
          {
            // row 49 (48.42): from above and in front, the beanie's crown; the right hand leaves its cuff; the face soft below
            rows: [49],
            frames: 19,
            stage: "void",
            keys: [
              { t: 0, body: { neck: [0.12, -0.05, 0], head: [0.08, 0, 0], chest: [0.04, 0, 0] }, L: RAISED_L, R: BRIM_R },
              { t: 0.2, body: { neck: [0.15, -0.05, 0], head: [0.1, 0, 0], chest: [0.04, 0, 0] }, L: RAISED_L, R: CHEST_R },
            ],
            life: { "head.y": "sin(u * 1.6) * 0.04", ...loose },
            frame: { dir: [-0.05, 0.4, 1], head: [0.6, 0.35], size: 1.1 },
            fov: 40,
            focus: 0.3,
            fstop: 1.8,
            hand: { tiltIn: 2, tilt: 1.2, settle: 0.8, shake: 0.25, creep: 0.02 },
            lights: VOID_TOP,
          },
        ],
      },
      extras: { red: true, sodium: 3 },
    },
    {
      // ── take 1 "bare": shirtless, the phone at the ear, before the car row (row 42) ──
      take: {
        name: "bare",
        wardrobe: "figbare",
        streak: { from: 0.3, to: 0.4, gain: 1.8, threshold: 4.5 },
        grade: { ...ROW_GRADE, steel: [0.9, 1.02, 1.07], shadowTint: [0.9, 1.02, 1.06, 1] },
        ambient: 0.05,
        carKey: 3,
        beats: [
          {
            // row 42 (44.46): chest height, the phone at the right ear, the left hand low; the lamps behind; strobed
            rows: [42],
            frames: 10,
            stage: "cars",
            at: [0.3, 0, -3.0],
            yaw: -0.25,
            keys: [{ t: 0, body: { neck: [0.05, 0.15, 0], head: [0.02, 0.05, 0] }, L: DOWN, R: { elbow: [-0.3, 1.28, 0.12], wrist: [-0.11, 1.52, 0.06], tip: [-0.09, 1.7, 0.06], seed: [[-0.6, 0, -0.4], [-2.0, 0, -0.3], [0, 0, 0]], onHead: true } }],
            life: { "neck.y": "sin(u * 3.0) * 0.06", ...handPose("R", { curl: 0.9, thumb: 0.8 }), ...handPose("L", { curl: 0.35, thumb: 0.2 }) },
            frame: { dir: [0.1, -0.1, 1], head: [0.55, 0.03], size: 0.6 },
            fov: 34,
            fstop: 2.4,
            hand: { tiltIn: 1, tilt: 2, settle: 0.4, shake: 0.6, creep: -0.05 },
            lights: { key: { at: [-0.8, 2.1, 1.3], power: 2.4 }, top: { at: [0.1, 2.8, -0.8], power: 2 }, rimL: { at: [0.8, 1.7, -0.9], power: 2 }, fill: { at: [0.3, 1.1, 1.4], power: 0.3 } },
          },
        ],
      },
      extras: { dark: { 0: [2, 3, 5, 6, 9] } },
    },
    {
      // ── take 2 "bare-gun": shirtless with the pistol (rows 51b, 52a) ──
      take: {
        name: "bare-gun",
        wardrobe: "figbare",
        gun: true,
        streak: { from: 0.3, to: 0.4, gain: 1.8, threshold: 4.5 },
        grade: ROW_GRADE,
        ambient: 0.05,
        carKey: 2,
        beats: [
          {
            // row 51b (50.47): low, the bare torso standing, the pistol held across the waist; mostly strobe-dark
            rows: [51],
            frames: 4,
            stage: "cars",
            keys: [{ t: 0, body: { chest: [0.02, 0.1, 0] }, L: DOWN }],
            life: pistolPose(facts.bones, { wrist: [-0.04, 1.22, 0.32], point: [0.9, 0.1, 0.4], palm: [0, -1, 0], elbow: [-0.26, 1.08, 0.18] }),
            frame: { dir: [0, -0.35, 1], head: [0.52, -0.3], size: 0.7 },
            fov: 50,
            fstop: 2.8,
            hand: { tiltIn: 3, tilt: 3, settle: 0.2, shake: 0.8, creep: 0.1 },
            lights: { key: { at: [-0.4, 1.8, 1.2], power: 0.5 }, top: { at: [0.1, 2.8, -0.8], power: 1.4 } },
          },
          {
            // row 52a (50.63): crouched low at the lens, the pistol sideways in the right hand, two fingers of the left pointing
            rows: [52],
            frames: 10,
            stage: "cars",
            at: [0, -0.42, 0],
            keys: [
              { t: 0, body: CROUCH, L: TWO_FINGERS_L },
              { t: 0.4, body: { ...CROUCH, chest: [0.15, -0.08, 0], neck: [-0.3, 0.08, 0] }, L: { ...TWO_FINGERS_L, wrist: [0.18, 1.38, 0.44] } },
            ],
            life: {
              ...palmTrue(facts, "R", { wrist: [-0.1, 1.4, 0.44], point: [0.8, 0.1, 0.5], palm: [0, -1, 0.2], elbow: [-0.3, 1.2, 0.26] }, CROUCH),
              ...handPose("R", PISTOL_GRIP),
              ...handPose("L", { curl: 1.45, point: 1, flip: 1, thumb: 0.8 }),
            },
            frame: { dir: [0, 0.05, 1], head: [0.48, 0.17], size: 0.45 },
            fov: 64,
            fstop: 2.8,
            hand: { tiltIn: -3, tilt: -2, settle: 0.3, shake: 0.9, creep: 0.08 },
            lights: { key: { at: [-0.4, 2.0, 1.2], power: 1.5 }, top: { at: [0.1, 2.6, -0.6], power: 2 }, fill: { at: [0.2, 1.0, 1.2], power: 0.3 } },
          },
        ],
      },
      extras: { dark: { 0: [0, 2, 3] } },
    },
    {
      // ── take 3 "beanie-void": row 44, the beanie and the tee in the black void ──
      take: {
        name: "beanie-void",
        wardrobe: "fig",
        streak: { from: 0.1, to: 0.16, gain: 1.6, threshold: 3.5 },
        grade: VOID_GRADE,
        ambient: 0.12,
        beats: [
          {
            // row 44 (45.42): the head tipped back, both palms over the face, sliding down, then opening out
            rows: [44],
            frames: 18,
            stage: "void",
            keys: [
              { t: 0, body: { neck: [-0.25, 0, 0], head: [-0.2, 0, 0] }, ...both(OVER_FACE) },
              { t: 0.3, body: { neck: [-0.25, 0, 0], head: [-0.2, 0, 0] }, ...both(OVER_FACE) },
              { t: 0.45, body: { neck: [-0.3, 0, 0], head: [-0.25, 0, 0] }, ...both(AT_MOUTH) },
              { t: 0.72, body: { neck: [-0.3, 0, 0], head: [-0.25, 0, 0] }, ...both(OPEN) },
            ],
            life: {
              ...handPose("L", { curl: "0.12", spread: "0.1 + 0.25 * clamp((u - 0.45) / 0.3, 0, 1)", thumb: 0.2 }),
              ...handPose("R", { curl: "0.12", spread: "0.1 + 0.25 * clamp((u - 0.45) / 0.3, 0, 1)", thumb: 0.2 }),
            },
            frame: { dir: [0, -0.12, 1], head: [0.48, 0.22], size: 0.5 },
            fov: 30,
            fstop: 2.8,
            hand: { tiltIn: 0.3, tilt: 0.2, settle: 0.8, shake: 0.12, creep: 0.02 },
            lights: VOID_TOP,
          },
        ],
      },
      extras: {},
    },
    {
      // ── take 4 "profile-cyc": row 50, the profile, a finger to the lips; the figure again on the cyc behind ──
      take: {
        name: "profile-cyc",
        wardrobe: "figcap",
        streak: { from: 0.2, to: 0.28, gain: 1.6, threshold: 4.5 },
        grade: { ...ROW_GRADE, exposure: 0.45 },
        ambient: 0.1,
        background: [0.05, 0.075, 0.08],
        beats: [
          {
            // row 50 (49.22): a long lens on the right profile, facing screen right; the index at the lips, the rings
            rows: [50],
            frames: 15,
            stage: "void",
            keys: [{ t: 0, body: { neck: [0.05, 0, 0], head: [0.04, 0, 0] }, L: DOWN }],
            life: {
              ...palmTrue(facts, "R", { wrist: [-0.03, 1.46, 0.22], point: [0.08, 1, 0.1], palm: [0.9, 0, -0.3], elbow: [-0.24, 1.2, 0.12] }),
              ...handPose("R", { curl: 1.35, point: 1, thumb: 0.7, extra: [0, -0.2, 0, 0] }),
              "head.y": "sin(u * 1.4) * 0.015",
            },
            frame: { dir: [-1, 0.02, 0.18], head: [0.42, 0.36], size: 1.0 },
            fov: 20,
            focus: 0.62,
            fstop: 2.8,
            hand: { tiltIn: 0.5, tilt: 0.8, settle: 0.5, shake: 0.15, creep: 0.01 },
            lights: { key: { at: [-1.0, 2.0, 0.6], power: 0.9 }, rimL: { at: [0.7, 1.8, -0.2], power: 2.2 }, cyan: { at: [-0.8, 1.3, 0.6], power: 0.25 } },
          },
        ],
      },
      extras: { cyc: true },
    },
    {
      // ── take 5 "cap": the brimmed cap and the tee before the car row (row 51a) ──
      take: {
        name: "cap",
        wardrobe: "figcap",
        streak: { from: 0.2, to: 0.3, gain: 1.8, threshold: 4.5 },
        grade: { ...ROW_GRADE, saturation: 0.15, keepWarm: 0.2 },
        ambient: 0.06,
        carKey: 2,
        beats: [
          {
            // row 51a (49.84): close and low, both middle fingers up either side of the face, the backs of the hands to the lens; strobed
            rows: [51],
            frames: 15,
            stage: "cars",
            keys: [{ t: 0, body: LEAN }],
            life: {
              ...palmTrue(facts, "L", { wrist: [0.11, 1.52, 0.3], point: [-0.05, 1, 0.05], palm: [0, 0, -1], elbow: [0.3, 1.26, 0.2] }, LEAN),
              ...palmTrue(facts, "R", { wrist: [-0.12, 1.5, 0.31], point: [0.05, 1, 0.05], palm: [0, 0, -1], elbow: [-0.3, 1.24, 0.2] }, LEAN),
              ...flipL,
              ...flipR,
              "neck.y": "sin(u * 2.2) * 0.08",
            },
            frame: { dir: [0, -0.25, 1], head: [0.48, 0.2], size: 0.42 },
            fov: 62,
            fstop: 2.8,
            hand: { tiltIn: -2, tilt: -1, settle: 0.4, shake: 0.7, creep: 0.05 },
            lights: { key: { at: [-0.3, 2.0, 1.2], power: 1.6 }, top: { at: [0.1, 2.8, -0.8], power: 2 }, fill: { at: [0.2, 1.2, 1.2], power: 0.3 } },
          },
        ],
      },
      extras: { dark: { 0: [8, 11, 13, 14] } },
    },
  ];
}

/** The rows' `from` on each take's clock, for edl.json. */
export function mcu2Starts(facts: OnNothingFacts): { name: string; rows: string; from: number }[] {
  return takes(facts).flatMap(({ take }) => beatStarts(take).map((from, b) => ({ name: take.name, rows: take.beats[b]!.rows.join(","), from })));
}

const sourceOf = (slot: StoredParameter): string | undefined => (slot as unknown as { bindings?: { expression?: { source: string } } }).bindings?.expression?.source;
const after = (a: number): string => `clamp((abstime - ${a.toFixed(5)} + 0.0005) * 4000, 0, 1)`;

/**
 * The split's ground (row 50): wherever the Render saw nothing, a pale cyc strip at the left
 * (its right edge soft, a glow bleeding past it) and the cool grey-teal ground elsewhere,
 * darker to the right. Input = the picture; More = [depth].
 */
const CYC_GROUND_WGSL = `struct Params {
  edge: f32, // @default 0.2  Where the cyc strip ends, uv x.
  soft: f32, // @default 0.03  Its edge's softness, uv.
  cyc: vec3f, // @default 1  The strip's radiance.
  ground: vec3f, // @default 0.05  The ground's radiance at the strip.
  fall: f32, // @default 1.4  How the ground darkens toward the right.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let size = vec2f(textureDimensions(inputTexture1));
  let d = textureLoad(inputTexture1, vec2i(clamp(uv * size, vec2f(0.0), size - 1.0)), 0).r;
  if (d > 0.0 && d < 0.999) { return base; }
  let strip = 1.0 - smoothstep(params.edge - params.soft, params.edge + params.soft, uv.x);
  let glow = exp(-max(uv.x - params.edge, 0.0) * 9.0) * 0.35;
  let ground = params.ground * exp(-max(uv.x - params.edge, 0.0) * params.fall) * (0.8 + 0.4 * uv.y);
  let floorShade = mix(1.0, 0.82, smoothstep(0.6, 1.0, uv.y));
  return vec4f(mix(ground + params.cyc * glow, params.cyc * floorShade, strip), base.a);
}`;

/** A figure's nodes and edges under new ids and labels (a second figure in one graph). */
function renamed(nodes: readonly GraphNode[], edges: readonly GraphEdge[], suffix: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const ids = new Map(nodes.map((n) => [n.id, `${n.id}${suffix}`]));
  return {
    nodes: nodes.map((n) => ({ ...n, id: ids.get(n.id)!, ...(n.label === undefined ? {} : { label: `${n.label.replace(/1$/, "")}${suffix}1` }) })),
    edges: edges.map((e) => ({ ...e, id: `${e.id}${suffix}`, source: { ...e.source, nodeId: ids.get(e.source.nodeId) ?? e.source.nodeId }, target: { ...e.target, nodeId: ids.get(e.target.nodeId) ?? e.target.nodeId } })),
  };
}

export function mcu2Document(facts: OnNothingFacts, options: McuOptions): ProjectDocument {
  const table = takes(facts);
  const index = options.take ?? 0;
  const entry = table[index];
  if (entry === undefined) throw new Error(`mcu2Document: no take ${index} (there are ${table.length}).`);
  const base = mcuDocument(facts, { ...options, takes: table.map((t) => t.take) });
  const cut = surgery(base);
  const starts = beatStarts(entry.take);

  // ── Strobe: the front lights drop out on the reference's dark frames ──
  const dark = Object.entries(entry.extras.dark ?? {}).flatMap(([beat, frames]) => frames.map((frame) => starts[Number(beat)]! + frame / 24));
  if (dark.length > 0) {
    const off = dark.map((t) => `(${after(t)} - ${after(t + 1 / 24)})`).join(" + ");
    for (const id of ["l_key", "l_fill", "l_top"]) {
      const node = cut.nodes[id];
      if (node === undefined) continue;
      const source = sourceOf(node.parameters["intensity"]!);
      const retained = typeof node.parameters["intensity"] === "number" ? node.parameters["intensity"] : 1;
      const on = source ?? String(retained);
      setParams(cut, id, { intensity: expressionSlot(`(${on}) * (1 - 0.95 * (${off}))`, 1) });
    }
  }

  // ── The sodium high-bays, brighter (row 41) ──
  if (entry.extras.sodium !== undefined) {
    for (const id of ["sodiumA", "sodiumB"]) setParams(cut, id, { intensity: (cut.nodes[id]!.parameters["intensity"] as number) * entry.extras.sodium });
  }

  // ── A red practical's bokeh (row 39): the first lamp slot, tinted ──
  if (entry.extras.red === true) setParams(cut, "lamp0", { tint: [1, 0.12, 0.08, 1] });

  // ── The split (row 50): the figure again, small on the pale cyc behind ──
  if (entry.extras.cyc === true) {
    const cam = cut.nodes["cam"]!;
    const eye = cam.parameters["eye"] as number[];
    const aim = cam.parameters["lookAt"] as number[];
    const fovParam = cam.parameters["fov"];
    const fov = typeof fovParam === "number" ? fovParam : (fovParam as unknown as { bindings: { static: { value: number } } }).bindings.static.value;
    const forward = [aim[0]! - eye[0]!, 0, aim[2]! - eye[2]!];
    const n = Math.hypot(forward[0]!, forward[2]!);
    const fw = [forward[0]! / n, 0, forward[2]! / n];
    const right = [-fw[2]!, 0, fw[0]!];
    // measured: the small figure fills ~0.85 of the frame height, its centre at x 0.06, y 0.52
    const aspect = (options.width ?? 1920) / (options.height ?? 818);
    const tanV = Math.tan((fov * Math.PI) / 360);
    const distance = 1.8 / (0.85 * 2 * tanV);
    const across = (0.06 - 0.5) * 2 * tanV * aspect * distance;
    const place: [number, number, number] = [eye[0]! + fw[0]! * distance + right[0]! * across, eye[1]! - 0.9 - (0.52 - 0.5) * 2 * tanV * distance, eye[2]! + fw[2]! * distance + right[2]! * across];
    const second = figureNodes(facts, {
      area: "figcap",
      material: "surf1",
      yaw: Math.atan2(-fw[0]!, -fw[2]!) + 0.5,
      place,
      pose: { "upperarmL.z": "-0.9", "upperarmR.z": "0.75", "forearmL.x": "-0.3", "forearmR.x": "-0.2", "neck.x": "0.1", "thighL.z": "0.08", "thighR.z": "-0.08" },
    });
    const copy = renamed(second.nodes, second.edges, "b");
    for (const node of copy.nodes) cut.nodes[node.id] = node;
    for (const edge of copy.edges) cut.edges[edge.id] = edge;
    const shot = cut.nodes["shot"]!;
    setParams(cut, "shot", { scenes: `${shot.parameters["scenes"] as string} figgeob1` });
    // light it as the cyc does: a broad soft front light on it alone
    addNode(cut, "l_cyc", "light", [-2600, 1900], { kind: "point", position: [place[0] - fw[0]! * 2.5, place[1] + 2.2, place[2] - fw[2]! * 2.5], color: [0.9, 0.97, 1, 1], intensity: 14 }, { label: "lcyc1" });
    setParams(cut, "shot", { lights: `${cut.nodes["shot"]!.parameters["lights"] as string} lcyc1` });
    addNode(cut, "cycGround", "customWgslMulti", [-2250, 150], { source: CYC_GROUND_WGSL, edge: 0.2, soft: 0.025, cyc: [2.2, 2.4, 2.45], ground: [0.2, 0.27, 0.29], fall: 1.6 }, { label: "cycground1", resolution: { mode: "project" } });
    spliceAfter(cut, "shot", "cycGround");
    connect(cut, ["shot", "depth"], ["cycGround", "more"], 0);
  }
  return finish(base, cut, "mcu2");
}
