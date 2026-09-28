import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";

/**
 * T1407b — the HANDHELD operator, for every shot's camera (the owner: "we're perfectly
 * parallel to the floor… doesn't convey the handheld look").
 *
 * - a Dutch TILT that eases in over `settle` seconds from `tiltIn` to `tilt` degrees and then
 *   keeps drifting — the horizon is never quite level;
 * - sway of the eye and a wander of the aim, three incommensurate sines per axis so it never
 *   loops visibly, scaled by `shake` (1 = a steady operator on a long lens);
 * - an optional creep toward the subject, metres per second along the view.
 *
 * Expressions only (sin/cos/clamp — the engine has no exp or smoothstep). Streaks are
 * image-space, so they turn with this roll, as a filter on the lens does.
 */
export interface HandheldOptions {
  readonly tiltIn?: number;
  readonly tilt?: number;
  readonly settle?: number;
  readonly shake?: number;
  readonly creep?: number;
  /** Seconds added to the clock: a shot that CONTINUES another's move starts where that one ended. */
  readonly timeOffset?: number;
}

export function handheld(eye: readonly [number, number, number], aim: readonly [number, number, number], options: HandheldOptions = {}): Record<string, StoredParameter> {
  const { tiltIn = 3.5, tilt = 1.2, settle = 1.2, shake = 1, creep = 0.12, timeOffset = 0 } = options;
  const t = timeOffset === 0 ? "abstime" : `(abstime + ${timeOffset})`;
  const wob = (a: number, b: number, c: number, phase: number) =>
    `(sin(${t} * ${a} + ${phase}) * 0.5 + sin(${t} * ${b} + ${phase * 1.7}) * 0.3 + sin(${t} * ${c} + ${phase * 2.3}) * 0.2)`;
  const ease = `(clamp(${t} / ${settle}, 0, 1) ^ 2 * (3 - 2 * clamp(${t} / ${settle}, 0, 1)))`;
  const dx = aim[0] - eye[0];
  const dz = aim[2] - eye[2];
  const len = Math.hypot(dx, dz) || 1;
  const fx = dx / len;
  const fz = dz / len;
  return {
    "eye.x": expressionSlot(`${eye[0]} + ${wob(0.9, 2.3, 5.1, 0.3)} * ${0.05 * shake} + ${fx} * ${t} * ${creep}`, eye[0]),
    "eye.y": expressionSlot(`${eye[1]} + ${wob(1.3, 3.1, 6.7, 1.1)} * ${0.03 * shake}`, eye[1]),
    "eye.z": expressionSlot(`${eye[2]} + ${fz} * ${t} * ${creep}`, eye[2]),
    "lookAt.x": expressionSlot(`${aim[0]} + ${wob(0.7, 1.9, 4.3, 2.0)} * ${0.07 * shake}`, aim[0]),
    "lookAt.y": expressionSlot(`${aim[1]} + ${wob(0.8, 2.1, 4.9, 2.7)} * ${0.04 * shake}`, aim[1]),
    "lookAt.z": expressionSlot(`${aim[2]}`, aim[2]),
    roll: expressionSlot(`${tiltIn} + (${tilt} - ${tiltIn}) * ${ease} - ${wob(0.5, 1.4, 3.3, 0.9)} * ${1.4 * shake}`, tilt),
  };
}
