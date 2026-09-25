import type { FurnaceSceneFacts } from "./scene-facts.ts";
import { wgslVec3 } from "./scene-facts.ts";

/**
 * T1354b — the SUN'S VIEW of the shop, for shadowed light shafts (§T1375b's first step).
 *
 * The Render keeps its own shadow maps to itself, so the furnace builds one it can read: an
 * orthographic camera looking along the key light, framed on the plant's bounds, and a second
 * Render drawing the plant from it with only its Depth output wired. The atmosphere then asks,
 * at every step of its march, whether the sun reaches that point of smoke — under the roof it
 * does not; through a window or a louvre it does. That is the difference between god rays and
 * a glow painted along a cylinder.
 */

export interface SunView {
  readonly eye: readonly [number, number, number];
  readonly aim: readonly [number, number, number];
  /** Ortho frame, metres: full height, and the width the render's aspect must match. */
  readonly height: number;
  readonly width: number;
  readonly near: number;
  readonly far: number;
  /** The view basis, as the Render's lookAt builds it. */
  readonly forward: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

type Vec3 = readonly [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** Frames the plant's bounds from far up the key light's path, with a margin. */
export function sunView(facts: FurnaceSceneFacts, keyDirection: Vec3): SunView {
  const { min, max } = facts.bounds;
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const forward = normalize(keyDirection);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
  const reach = Math.max(...corners.map((corner) => Math.abs(dot(sub(corner, centre), forward))));
  const standOff = reach + 10;
  const eye: Vec3 = [centre[0] - forward[0] * standOff, centre[1] - forward[1] * standOff, centre[2] - forward[2] * standOff];
  const margin = 1.04;
  const halfWidth = Math.max(...corners.map((corner) => Math.abs(dot(sub(corner, centre), right)))) * margin;
  const halfHeight = Math.max(...corners.map((corner) => Math.abs(dot(sub(corner, centre), up)))) * margin;
  return { eye, aim: centre, height: halfHeight * 2, width: halfWidth * 2, near: 1, far: standOff + reach + 10, forward, right, up };
}

/**
 * `sunLit(x)`: 1 where the sun reaches world point x, 0 where the plant stands between —
 * read from the sun render's Depth (view distance ÷ far) bound as `texture`.
 */
export function sunLitWgsl(view: SunView, texture: string): string {
  return `
const SUN_EYE: vec3f = ${wgslVec3(view.eye)};
const SUN_FORWARD: vec3f = ${wgslVec3(view.forward)};
const SUN_RIGHT: vec3f = ${wgslVec3(view.right)};
const SUN_UP: vec3f = ${wgslVec3(view.up)};
const SUN_HALF: vec2f = vec2f(${(view.width / 2).toFixed(4)}, ${(view.height / 2).toFixed(4)});
const SUN_FAR: f32 = ${view.far.toFixed(4)};

fn sunLit(x: vec3f) -> f32 {
  let offset = x - SUN_EYE;
  let along = dot(offset, SUN_FORWARD);
  let frame = vec2f(dot(offset, SUN_RIGHT), dot(offset, SUN_UP)) / SUN_HALF;
  if (abs(frame.x) >= 1.0 || abs(frame.y) >= 1.0) { return 0.0; }
  let size = vec2f(textureDimensions(${texture}));
  let texel = clamp(vec2i(vec2f(frame.x * 0.5 + 0.5, 0.5 - frame.y * 0.5) * size), vec2i(0), vec2i(size) - vec2i(1));
  let stored = textureLoad(${texture}, texel, 0).r;
  // Nothing drawn there (depth 0 or 1): open sky all the way down.
  if (stored <= 0.0 || stored >= 0.9999) { return 1.0; }
  return select(0.0, 1.0, along <= stored * SUN_FAR + 0.25);
}
`;
}
