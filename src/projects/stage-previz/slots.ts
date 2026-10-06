import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import type { StageFacts, Vec3 } from "./facts.ts";

/** Stage previz — the expression helpers the session's builders share. */

export type Slots = Record<string, ParameterSlot>;

export const fmt = (value: number): string => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/** v0 when s < 0.5, v1 when 0.5 <= s < 1.5, … — a stepped pick by comparisons. */
export function pick(values: readonly number[], s: string): string {
  let out = fmt(values[0] ?? 0);
  for (let k = 1; k < values.length; k += 1) {
    const delta = (values[k] ?? 0) - (values[k - 1] ?? 0);
    if (Math.abs(delta) > 1e-6) out += ` + ${fmt(delta)} * (${s} >= ${k - 0.5})`;
  }
  return out;
}

/** Every component of a vec3 slot from three expressions. */
export function vecSlots(key: string, sources: readonly [string, string, string], retained: Vec3): Slots {
  const axes = ["x", "y", "z"] as const;
  return Object.fromEntries(axes.map((axis, index) => [`${key}.${axis}`, expressionSlot(sources[index] ?? "0", retained[index] ?? 0)]));
}

/** A vec3 slot that follows another node's vec3 parameter. */
export function follow(key: string, target: string, parameter: string, retained: Vec3): Slots {
  return vecSlots(key, [`op('${target}').par.${parameter}.x`, `op('${target}').par.${parameter}.y`, `op('${target}').par.${parameter}.z`], retained);
}

/**
 * The vertical FOV of the camera that renders a projector's occluders (rolled with it, 16:9):
 * the lens's image with 15% to spare, widened for shift, and for keystone, which in Loom's
 * model reaches PAST the native image on its wide side by 1 / (1 − tan k).
 */
export function shadowFovSource(projector: string): string {
  const par = (name: string) => `op('${projector}').par.${name}`;
  const spare = `(1 + 2 * max(abs(${par("shiftX")}), abs(${par("shiftY")})))`;
  const keystone = `max(0.25, 1 - abs(sin(${par("keystoneH")} * 0.0174532925) / cos(${par("keystoneH")} * 0.0174532925)) - abs(sin(${par("keystoneV")} * 0.0174532925) / cos(${par("keystoneV")} * 0.0174532925)))`;
  return `2 * atan2(0.575 * ${spare} / ${keystone}, ${par("throwRatio")} * ${par("aspect")}) * 57.29578`;
}

/** A slider's value, published under a channel of its own name. */
export const chan = (name: string): string => `op('${name}').chan.${name}`;

/**
 * The view camera's eye, look-at and FOV, stepped through the GLB's shots by the Shot slider;
 * the eye turned about the vertical through the shot's look-at by the Orbit slider (degrees,
 * positive turns the camera toward stage left's side of the house: +x), and moved along its
 * line to the look-at by the Zoom slider (feet, + farther), never closer than 5% of the way.
 */
export function viewSlots(facts: StageFacts): Slots {
  const shot = (pickOf: (entry: StageFacts["shots"][number]) => number): string => pick(facts.shots.map(pickOf), chan("shot"));
  const first = facts.shots[0]!;
  const angle = `${chan("orbit")} * 0.0174532925`;
  const reach = shot((s) => Math.hypot(s.eye[0] - s.lookAt[0], s.eye[1] - s.lookAt[1], s.eye[2] - s.lookAt[2]));
  const scale = `max(0.05, 1 + ${chan("zoom")} * 0.3048 / (${reach}))`;
  const lookX = shot((s) => s.lookAt[0]);
  const lookY = shot((s) => s.lookAt[1]);
  const lookZ = shot((s) => s.lookAt[2]);
  const awayX = `(${shot((s) => s.eye[0] - s.lookAt[0])})`;
  const awayY = `(${shot((s) => s.eye[1] - s.lookAt[1])})`;
  const awayZ = `(${shot((s) => s.eye[2] - s.lookAt[2])})`;
  return {
    ...vecSlots("eye", [
      `${lookX} + ${scale} * (${awayX} * cos(${angle}) + ${awayZ} * sin(${angle}))`,
      `${lookY} + ${scale} * ${awayY}`,
      `${lookZ} + ${scale} * (${awayZ} * cos(${angle}) - ${awayX} * sin(${angle}))`,
    ], first.eye),
    ...vecSlots("lookAt", [shot((s) => s.lookAt[0]), shot((s) => s.lookAt[1]), shot((s) => s.lookAt[2])], first.lookAt),
    fov: expressionSlot(shot((s) => s.fov), first.fov),
  };
}

/**
 * T1641b: the colour a scalar expression stands for, as a colour. A colour parameter driven by
 * `chan(...) * k` broadcasts the number to grey, so the static it falls back to has to be that
 * grey with full alpha, not the bare number (which a colour cannot take, and so never applied).
 */
export function grey(level: number): [number, number, number, number] {
  return [level, level, level, 1];
}
