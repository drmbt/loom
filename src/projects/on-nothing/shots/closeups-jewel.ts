import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { markerOf } from "../scene-facts.ts";
import { type V3, addv, reachArm } from "./reach.ts";

/**
 * T1407b (closeups2) — the PENDANT's further takes, on closeups.py's pendant set (the "Nothing"
 * script pendant at `stage.pendant`, its face looking along +Z, glTF):
 *
 *  - take 1 (row 4, the reference's 2.669–3.170 s, frames 64–75): the pendant seen at a grazing
 *    angle from above, the word running across the frame, held at its left end by a ringed hand
 *    reaching in from the top left (the mirror shot's `fighand`: the left hand curled, the
 *    pyramid ring on it), its wearer a dark blur behind, and a second figure soft at the right;
 *    a strobe fires every third frame (66, 69, 72, 75) and the pavé blows out into a streak.
 *  - take 2 (row 15, 12.304–13.138 s, frames 295–314): the pendant turning, seen nearly edge-on
 *    from its right end, the grey-teal wall at the left and the dark shoulder at the right; the
 *    exposure steps with the strobe (bright at 297–301 and 314, dark 305–313).
 *
 * Each take is a camera (a slow orbit or drift, a handheld tremor), a lens, and a FLASH schedule
 * (reference frame → strength) the document turns into a strobe light and the flash pass.
 */

const FPS = 24;
const U = `(abstime * ${FPS})`;

export interface JewelSetup {
  readonly eye: V3;
  readonly aim: V3;
  readonly fov: number;
  readonly camera: Record<string, StoredParameter>;
  readonly focus: string;
  readonly focusAt: number;
  readonly fstop: number;
  /** The strobe: an expression, 0 between flashes. */
  readonly flash: string;
  /** The flash pass: lift (stops) and veil at a full flash, and the strobe light's intensity. */
  readonly lift: number;
  readonly veil: number;
  readonly strobe: number;
  /** The grade's exposure between flashes (stops). */
  readonly exposure: number;
  /** The ring's brightness in the flash pass (0: the flash only lifts and veils). */
  readonly ring: number;
  /** Figures in the set: area, where it stands, which way it faces (yaw), and its knobs. */
  readonly figures: readonly { readonly id: string; readonly area: "fighand" | "fig"; readonly place: V3; readonly yaw: number; readonly bones: Readonly<Record<string, V3>> }[];
}

const fixed = (value: number): string => (Math.abs(value) < 5e-7 ? "0" : value.toFixed(6));
const wob = (a: number, b: number, c: number, phase: number): string =>
  `(sin(abstime * ${a} + ${phase}) * 0.5 + sin(abstime * ${b} + ${(phase * 1.7).toFixed(3)}) * 0.3 + sin(abstime * ${c} + ${(phase * 2.3).toFixed(3)}) * 0.2)`;

function flashOf(first: number, flashes: Readonly<Record<number, number>>): string {
  const terms = Object.entries(flashes).map(([frame, strength]) => `clamp(1 - abs(floor(${U} + 0.001) - ${Number(frame) - first}), 0, 1) * ${strength}`);
  return terms.length === 0 ? "0" : terms.join(" + ");
}

export function jewelSetup(facts: OnNothingFacts, take: number): JewelSetup {
  const s = markerOf(facts, "stage.pendant").position;
  if (take === 1) {
    // row 4: from above and in front, 70° off the face's normal, so the face is seen at a
    // grazing angle and the word runs across the frame; a drift to the left
    const eye = addv(s, [0.03, 0.41, 0.29]);
    const aim = addv(s, [-0.012, 0.0, -0.005]);
    const shake = 0.0015;
    const camera: Record<string, StoredParameter> = {
      "eye.x": expressionSlot(`${fixed(eye[0])} + abstime * (-0.02) + ${wob(2.1, 5.3, 11.1, 0.3)} * ${fixed(shake)}`, eye[0]),
      "eye.y": expressionSlot(`${fixed(eye[1])} + ${wob(2.7, 6.1, 12.7, 1.1)} * ${fixed(shake)}`, eye[1]),
      "eye.z": expressionSlot(`${fixed(eye[2])} + ${wob(1.9, 4.7, 9.3, 2.2)} * ${fixed(shake)}`, eye[2]),
      "lookAt.x": expressionSlot(`${fixed(aim[0])} + abstime * (-0.02) + ${wob(1.7, 4.9, 10.3, 2.0)} * ${fixed(shake * 2)}`, aim[0]),
      "lookAt.y": expressionSlot(`${fixed(aim[1])} + ${wob(2.3, 5.1, 9.9, 2.7)} * ${fixed(shake * 2)}`, aim[1]),
      "lookAt.z": expressionSlot(fixed(aim[2]), aim[2]),
      roll: expressionSlot(`-4 + abstime * 3 + ${wob(1.5, 3.4, 7.3, 0.9)} * 1.5`, -4),
    };
    // the holder behind the pendant, facing the lens, the left hand (curled, the ring on it)
    // reaching forward to the word's left end; the second figure further back at the right
    const holder: V3 = [s[0] - 0.3, 0, s[2] - 0.5];
    const lean: Record<string, V3> = { upperarmR: [0, 0, 0.62], forearmR: [-0.35, 0, 0], neck: [0.25, 0, 0], head: [0.2, 0, 0], chest: [0.15, 0, 0] };
    const solved = reachArm(facts.bones, { place: holder, yaw: 0, bones: lean }, "L", addv(s, [-0.085, 0.005, 0.015]), { upperarmL: [-1.0, 0, 0.3], forearmL: [-0.8, 0, 0] });
    return {
      eye,
      aim,
      fov: 8.77,
      camera,
      focus: fixed(Math.hypot(aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]) * 0.99),
      focusAt: Math.hypot(aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]),
      fstop: 5.6,
      flash: flashOf(64, { 66: 1, 69: 1, 72: 1, 75: 1 }),
      // the strobe whitens the pavé more than the room
      lift: 0.4,
      veil: 0.05,
      strobe: 6,
      exposure: -0.1,
      ring: 0,
      figures: [
        { id: "holder", area: "fighand", place: holder, yaw: 0, bones: solved.bones },
        { id: "second", area: "fig", place: [s[0] + 0.3, 0, s[2] - 0.55], yaw: 0, bones: { upperarmL: [0, 0, -0.62], upperarmR: [-1.2, 0, 0.2], forearmR: [-1.6, 0, 0], forearmL: [-0.35, 0, 0], neck: [0.2, 0, 0] } },
      ],
    };
  }
  if (take === 2) {
    // row 15: nearly edge-on from the word's right end, the lens orbiting a little round it
    // (the pendant "turns"); the grey-teal wall behind at the left
    const r = 0.3;
    const a0 = (55 * Math.PI) / 180;
    const a1 = (45 * Math.PI) / 180;
    const len = 20 / FPS;
    const angle = `(${fixed(a0)} + (${fixed(a1 - a0)}) * clamp(abstime / ${fixed(len)}, 0, 1))`;
    const eye: V3 = addv(s, [r * Math.sin(a0), 0.035, r * Math.cos(a0)]);
    const aim: V3 = addv(s, [0.005, -0.004, 0]);
    const shake = 0.001;
    const camera: Record<string, StoredParameter> = {
      "eye.x": expressionSlot(`${fixed(s[0])} + ${fixed(r)} * sin(${angle}) + ${wob(2.1, 5.3, 11.1, 0.3)} * ${fixed(shake)}`, eye[0]),
      "eye.y": expressionSlot(`${fixed(eye[1])} + ${wob(2.7, 6.1, 12.7, 1.1)} * ${fixed(shake)}`, eye[1]),
      "eye.z": expressionSlot(`${fixed(s[2])} + ${fixed(r)} * cos(${angle}) + ${wob(1.9, 4.7, 9.3, 2.2)} * ${fixed(shake)}`, eye[2]),
      "lookAt.x": expressionSlot(`${fixed(aim[0])} + ${wob(1.7, 4.9, 10.3, 2.0)} * ${fixed(shake)}`, aim[0]),
      "lookAt.y": expressionSlot(`${fixed(aim[1])} + ${wob(2.3, 5.1, 9.9, 2.7)} * ${fixed(shake)}`, aim[1]),
      "lookAt.z": expressionSlot(fixed(aim[2]), aim[2]),
      roll: expressionSlot(`8 + ${wob(1.5, 3.4, 7.3, 0.9)} * 1`, 8),
    };
    return {
      eye,
      aim,
      fov: 8.77,
      camera,
      focus: "0.29",
      focusAt: 0.29,
      fstop: 4,
      // the strobe steps: 295 (+0) … 314 (+19); bright 297–301 and 314, dark 305–313
      lift: 0.9,
      veil: 0.22,
      strobe: 0.6,
      exposure: -0.7,
      flash: flashOf(295, { 295: 0.25, 296: 0.3, 297: 0.8, 298: 1.5, 299: 1.5, 300: 1.5, 301: 1.1, 302: 0.6, 303: 0.6, 304: 0.6, 314: 1.3 }),
      ring: 0,
      figures: [],
    };
  }
  throw new Error(`closeups: the pendant has no take ${take} (1: row 4, 2: row 15).`);
}
