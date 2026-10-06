/**
 * The electric arc between a wire's tip and the port it would connect to (T1639b).
 *
 * Pure functions: two points, a tick and a seed in, a polyline out. Nothing here knows a
 * clock, a pointer or the DOM, which is what lets the shape be tested and lets the drawing
 * be one attribute write. The measurements this is built from are in
 * docs/wire-snap-design-2026-10-06.md: in the reference the bolt has a corner about every
 * 7 px, alternating sides, at most 8 % of its length off the straight line, a thin branch
 * that leaves it past half way and runs back towards the tip, and a new shape 15 times a
 * second.
 */

export interface ArcPoint {
  readonly x: number;
  readonly y: number;
}

/** A new shape this often. The reference holds each one for 2 frames of 30: 15 Hz. */
export const ARC_TICK_MS = 66;

/** Which shape is showing at this time. The drawing loop redraws when this changes. */
export function arcTick(nowMs: number): number {
  return Math.floor(nowMs / ARC_TICK_MS);
}

/** One corner about this often along the bolt, in design pixels. */
const CORNER_EVERY_PX = 6;
const MIN_CORNERS = 3;
const MAX_CORNERS = 14;
/** The furthest a corner sits from the straight line: this share of the bolt's length... */
const AMPLITUDE_OF_LENGTH = 0.14;
/** ...and never more than this, in design pixels, however long the bolt is. */
const AMPLITUDE_MAX_PX = 4.5;
/** Below this length, in design pixels, there is no room for a branch. */
const BRANCH_MIN_LENGTH_PX = 14;
/** The branch stands up to this many amplitudes off the line. */
const BRANCH_REACH = 2.4;

export interface ArcInput {
  /** The wire's tip. The bolt starts exactly here. */
  readonly from: ArcPoint;
  /** The port's centre. The bolt ends exactly here. */
  readonly to: ArcPoint;
  /** Which shape (`arcTick`). The same tick and seed always give the same shape. */
  readonly tick: number;
  /** Tells one port's arc from another's. Any integer. */
  readonly seed: number;
  /** Graph units per design pixel (`wireScale`), so the arc holds its size on screen. */
  readonly scale: number;
}

/** mulberry32: small, fast, and the same numbers in every engine. */
function generator(seed: number, tick: number): () => number {
  let state = (seed ^ Math.imul(tick + 1, 0x9e3779b1)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** The furthest a corner of this bolt may sit from the straight line, in graph units. */
export function arcAmplitude(length: number, scale: number): number {
  return Math.min(AMPLITUDE_MAX_PX * scale, AMPLITUDE_OF_LENGTH * length);
}

interface Frame {
  readonly length: number;
  /** Unit vector along the bolt. */
  readonly ux: number;
  readonly uy: number;
  /** Unit vector across it. */
  readonly nx: number;
  readonly ny: number;
}

function frameOf(from: ArcPoint, to: ArcPoint): Frame | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const ux = dx / length;
  const uy = dy / length;
  return { length, ux, uy, nx: -uy, ny: ux };
}

/**
 * The main bolt: a zigzag from `from` to `to`.
 *
 * The first and last points ARE the two ends, so the bolt meets the tip and the port
 * whatever the numbers in between do. Corners alternate sides (which is what makes it read
 * as a bolt and not as noise), sit a random share of the amplitude off the line, and are
 * held closer to it near the ends.
 */
export function arcBolt(input: ArcInput): ArcPoint[] {
  const { from, to, scale } = input;
  const frame = frameOf(from, to);
  if (frame === null) return [from, to];
  const random = generator(input.seed, input.tick);
  const amplitude = arcAmplitude(frame.length, scale);
  const corners = Math.max(
    MIN_CORNERS,
    Math.min(MAX_CORNERS, Math.round(frame.length / (CORNER_EVERY_PX * scale))),
  );
  const firstSide = random() < 0.5 ? 1 : -1;
  const points: ArcPoint[] = [from];
  for (let index = 1; index < corners; index += 1) {
    const along = (index + (random() - 0.5) * 0.5) / corners;
    const side = index % 2 === 1 ? firstSide : -firstSide;
    const reach = amplitude * (0.45 + 0.55 * random()) * Math.sqrt(Math.sin(Math.PI * along));
    points.push({
      x: from.x + frame.ux * along * frame.length + frame.nx * side * reach,
      y: from.y + frame.uy * along * frame.length + frame.ny * side * reach,
    });
  }
  points.push(to);
  return points;
}

/**
 * The branch: a thinner line that leaves the bolt past half way and runs back towards the
 * tip, on the upper side. Empty when the bolt is too short to carry one.
 *
 * It starts ON a corner of the bolt it is given, so the two cannot come apart.
 */
export function arcBranch(bolt: readonly ArcPoint[], input: ArcInput): ArcPoint[] {
  const frame = frameOf(input.from, input.to);
  if (frame === null || frame.length < BRANCH_MIN_LENGTH_PX * input.scale || bolt.length < 4) return [];
  // Its own stream of numbers, so adding the branch never changed the bolt's shape.
  const random = generator(input.seed ^ 0x5bd1e995, input.tick);
  const amplitude = arcAmplitude(frame.length, input.scale);
  const root = bolt[Math.max(1, Math.min(bolt.length - 2, Math.round((bolt.length - 1) * 0.6)))];
  if (root === undefined) return [];
  // The upper side on screen: y grows downwards, so "up" is the normal with the smaller y.
  const up = frame.ny > 0 ? -1 : 1;
  // Where the root is along the bolt; the branch's other two points are placed from the
  // LINE, not from the root, so how far it stands off is bounded whatever the root did.
  const rootAlong = (root.x - input.from.x) * frame.ux + (root.y - input.from.y) * frame.uy;
  const kneeAlong = rootAlong - frame.length * (0.16 + 0.1 * random());
  const endAlong = kneeAlong - frame.length * (0.14 + 0.1 * random());
  const kneeOff = up * amplitude * (1.4 + (BRANCH_REACH - 1.6) * random());
  const endOff = up * amplitude * (1.2 + (BRANCH_REACH - 1.2) * random());
  const at = (along: number, off: number): ArcPoint => ({
    x: input.from.x + frame.ux * along + frame.nx * off,
    y: input.from.y + frame.uy * along + frame.ny * off,
  });
  return [root, at(kneeAlong, kneeOff), at(endAlong, endOff)];
}

/** How far `point` sits from the straight line through `from` and `to`. For the tests. */
export function distanceFromLine(point: ArcPoint, from: ArcPoint, to: ArcPoint): number {
  const frame = frameOf(from, to);
  if (frame === null) return Math.hypot(point.x - from.x, point.y - from.y);
  return Math.abs((point.x - from.x) * frame.nx + (point.y - from.y) * frame.ny);
}

/** How many amplitudes off the line a branch may stand. Exported for the same reason. */
export const ARC_BRANCH_REACH = BRANCH_REACH;

function coordinate(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The `d` of a polyline, to a hundredth of a unit. Empty for fewer than two points. */
export function polylinePath(points: readonly ArcPoint[]): string {
  if (points.length < 2) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${coordinate(point.x)} ${coordinate(point.y)}`)
    .join(" ");
}
