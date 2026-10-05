import { rotateByQuat, type Quat, type Vec2, type Vec3 } from "./curve.ts";

/**
 * T1587b — A SWEEP ON THE CPU: the reference the Sweep node is tested against.
 *
 * A sweep carries a PROFILE (an outline in its own plane) along a PATH (one strip of points,
 * each with a frame) and joins the copies into a sheet. What comes out is a GRID of a
 * pointset (`topology.ts`): columns go round the profile, rows go along the path, and slot
 * `row × columns + column` is one vertex. `nodes/shaders/sweep.wgsl.ts` is this file in
 * WGSL, and the Dawn tests hold the two together. It is headless: no GPU, no node types.
 *
 * ## The rules
 *
 * 1. THE PROFILE SITS IN THE FRAME'S X AND Y. A path point's `orient` carries +Z onto the
 *    curve and +Y onto its normal (Curve Frames, §T1586b), so profile point (x, y) lands at
 *    `point + orient × (x, y, 0) × radius`. The sweep has no twist of its own: the frame is
 *    Curve Frames'.
 * 2. COLUMNS GO FROM +X TOWARD +Y. A grid's lit normal is `across × along` (the Render's
 *    central differences), so with rows running down the tangent this order makes it point
 *    AWAY from the path. Inward walks the outline the other way from the same first point,
 *    which turns that normal round.
 * 3. A SIDE THAT SHOULD BE FLAT HAS TWO COLUMNS OF ITS OWN. Where two columns stand in one
 *    place the difference across is one-sided for each, so each gets its own side's normal
 *    and the cell between them has no area. There is no index list anywhere.
 * 4. A CAP IS TWO MORE ROWS: the end ring again, then that ring drawn in to the path point.
 *    Rule 3 gives the repeated ring the cap's flat normal. It is a fan, so it is right for
 *    an outline every point of which can see the path point.
 * 5. `normal` IS FOR A KERNEL, NOT FOR THE LIGHT. It is the outline's own normal in the
 *    ring's plane (the cap's on a cap), on the side `facing` names. The lit normal is the
 *    grid's, worked out from the positions after every kernel.
 */

export const SWEEP_PROFILES = ["ring", "square", "strip", "custom"] as const;
export type SweepProfile = (typeof SWEEP_PROFILES)[number];

export const SWEEP_CAPS = ["none", "start", "end", "both"] as const;
export type SweepCaps = (typeof SWEEP_CAPS)[number];

export const SWEEP_UV_ALONG = ["stretch", "metres", "points"] as const;
export type SweepUvAlong = (typeof SWEEP_UV_ALONG)[number];

/** A ring has at least this many sides. */
export const SWEEP_RING_MIN_SIDES = 3;

/** An outline as the sweep reads it: points in the profile's plane, in order, before the radius. */
export interface SweepOutline {
  readonly points: ReadonlyArray<Vec2>;
  readonly closed: boolean;
  /** Every side flat: each is drawn between two columns of its own (rule 3). */
  readonly flat: boolean;
}

/**
 * The three outlines the node makes itself. A Ring starts on +X; a Square's first side is
 * its +X face; a Strip runs from +X to −X, so its +Y side is the lit one (rule 2).
 */
export function sweepOutline(profile: Exclude<SweepProfile, "custom">, sides: number, smooth: boolean): SweepOutline {
  if (profile === "square") {
    return { points: [[1, -1], [1, 1], [-1, 1], [-1, -1]], closed: true, flat: true };
  }
  if (profile === "strip") {
    const segments = Math.max(1, Math.round(sides));
    return { points: Array.from({ length: segments + 1 }, (_, k): Vec2 => [1 - (2 * k) / segments, 0]), closed: false, flat: false };
  }
  const count = Math.max(SWEEP_RING_MIN_SIDES, Math.round(sides));
  return {
    points: Array.from({ length: count }, (_, k): Vec2 => [Math.cos((k / count) * 2 * Math.PI), Math.sin((k / count) * 2 * Math.PI)]),
    closed: true,
    flat: !smooth,
  };
}

/** Sides of an outline: a closed one has as many as points. */
export const sweepSides = (outline: Pick<SweepOutline, "closed"> & { readonly points: { readonly length: number } }): number =>
  outline.closed ? outline.points.length : outline.points.length - 1;

/** Columns of the grid: one a point, or two a side where every side is flat. */
export const sweepColumnCount = (outline: Pick<SweepOutline, "closed" | "flat"> & { readonly points: { readonly length: number } }): number =>
  outline.flat ? 2 * sweepSides(outline) : outline.points.length;

/** Cap rows before the first ring and after the last: two each. A closed path has no ends. */
export function sweepCapRows(caps: SweepCaps, pathClosed: boolean): { readonly start: number; readonly end: number } {
  if (pathClosed) return { start: 0, end: 0 };
  return { start: caps === "start" || caps === "both" ? 2 : 0, end: caps === "end" || caps === "both" ? 2 : 0 };
}

export interface SweepColumn {
  /** Where the column stands in the profile's plane, before the radius. */
  readonly at: Vec2;
  /** The outline's normal there, on the side the sweep faces. */
  readonly normal: Vec2;
  /** The share of the way round, by sides: it rises with the column whichever way the sweep faces. */
  readonly u: number;
}

const unit2 = (v: Vec2): Vec2 => {
  const length = Math.hypot(v[0], v[1]);
  return length > 0 ? [v[0] / length, v[1] / length] : [0, 0];
};

/** The columns of one ring, in grid order (rules 2 and 3). */
export function sweepColumns(outline: SweepOutline, inward: boolean): SweepColumn[] {
  const { points, closed, flat } = outline;
  const count = points.length;
  const sides = sweepSides(outline);
  const columns = sweepColumnCount(outline);
  const point = (k: number): Vec2 => points[k] as Vec2;
  /* The outward normal of a direction along the outline: it turned a quarter turn clockwise. */
  const outward = (from: Vec2, to: Vec2): Vec2 => unit2([to[1] - from[1], -(to[0] - from[0])]);
  const result: SweepColumn[] = [];
  for (let column = 0; column < columns; column += 1) {
    /* Inward: the same outline, walked the other way from its first point. */
    const walked = !inward ? column : closed && !flat ? (columns - column) % columns : columns - 1 - column;
    let at: Vec2;
    let normal: Vec2;
    if (flat) {
      const side = Math.floor(walked / 2);
      at = point((side + (walked % 2)) % count);
      normal = outward(point(side), point((side + 1) % count));
    } else {
      at = point(walked);
      const next = closed ? (walked + 1) % count : Math.min(walked + 1, count - 1);
      const previous = closed ? (walked + count - 1) % count : Math.max(walked, 1) - 1;
      normal = outward(point(previous), point(next));
    }
    result.push({
      at,
      normal: inward ? [-normal[0], -normal[1]] : normal,
      u: flat ? Math.floor((column + 1) / 2) / sides : column / sides,
    });
  }
  return result;
}

export interface SweepPathPoint {
  readonly position: Vec3;
  /** The frame: +Z down the curve, +Y its normal. */
  readonly orient: Quat;
  /** What multiplies the radius here (the mapped attribute); 1 when nothing is mapped. */
  readonly scale?: number;
  /** Curve Frames' metrics, for the coordinate along. */
  readonly distance?: number;
  readonly curveU?: number;
  readonly curveLength?: number;
}

export interface SweepOptions {
  readonly outline: SweepOutline;
  readonly inward: boolean;
  /** The profile's half-width, metres. */
  readonly radius: number;
  readonly caps: SweepCaps;
  readonly pathClosed: boolean;
  readonly uvAlong: SweepUvAlong;
  /** Metres: metres of curve to one tile. */
  readonly uvLength: number;
}

export interface SweepVertex {
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly uv: Vec2;
  /** The path point this vertex stands on: every carried attribute is copied from it. */
  readonly point: number;
}

/**
 * One strip swept: every vertex of the grid, in slot order (`row × columns + column`).
 * Rows are the start cap's two (its centre first), the path's points, the end cap's two
 * (its centre last).
 */
export function sweepStrip(path: ReadonlyArray<SweepPathPoint>, options: SweepOptions): SweepVertex[] {
  const columns = sweepColumns(options.outline, options.inward);
  const capRows = sweepCapRows(options.caps, options.pathClosed);
  const rows = capRows.start + path.length + capRows.end;
  const facing = options.inward ? -1 : 1;
  const tile = Math.max(options.uvLength, 1e-6);
  const vertices: SweepVertex[] = [];
  for (let row = 0; row < rows; row += 1) {
    /* Which path point the row stands on, and whether it is a cap's (rule 4). */
    let index = row - capRows.start;
    let cap = 0;
    let centre = false;
    if (row < capRows.start) {
      index = 0;
      cap = -1;
      centre = row === 0;
    } else if (index >= path.length) {
      index = path.length - 1;
      cap = 1;
      centre = row === rows - 1;
    }
    const point = path[index] as SweepPathPoint;
    const radius = options.radius * (point.scale ?? 1);
    /* The coordinate along: a cap's centre is one radius further than its rim. */
    const beyond = centre ? cap * radius : 0;
    const length = point.curveLength ?? 0;
    let v: number;
    if (options.uvAlong === "points") {
      v = options.pathClosed ? row / rows : row / Math.max(rows - 1, 1);
    } else if (options.uvAlong === "stretch") {
      v = (point.curveU ?? 0) + (length > 0 ? beyond / length : 0);
    } else if (options.pathClosed) {
      /* A loop holds a whole number of tiles, so the pattern meets itself at the seam. */
      v = length > 0 ? ((point.distance ?? 0) * Math.max(Math.round(length / tile), 1)) / length : 0;
    } else {
      v = ((point.distance ?? 0) + beyond) / tile;
    }
    for (const column of columns) {
      const offset = rotateByQuat(point.orient, [column.at[0] * radius, column.at[1] * radius, 0]);
      const local: Vec3 = cap === 0 ? [column.normal[0], column.normal[1], 0] : [0, 0, cap * facing];
      vertices.push({
        position: centre ? point.position : [point.position[0] + offset[0], point.position[1] + offset[1], point.position[2] + offset[2]],
        normal: rotateByQuat(point.orient, local),
        uv: [column.u, v],
        point: index,
      });
    }
  }
  return vertices;
}
