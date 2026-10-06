import { describe, expect, it } from "vitest";

import type { Quat, Vec2, Vec3 } from "./curve.ts";
import {
  sweepCapRows,
  sweepColumnCount,
  sweepColumns,
  sweepOutline,
  sweepSides,
  sweepStrip,
  type SweepOptions,
  type SweepOutline,
  type SweepPathPoint,
} from "./sweep.ts";

/**
 * The sweep's CPU reference (T1587b), held to numbers worked out BY HAND.
 *
 * The Dawn tests compare the GPU pass with `sweepStrip`, so whatever this file gets wrong
 * the node would get wrong in agreement with it. Every expectation here is therefore a
 * figure a person can check against the five rules at the top of `sweep.ts`, not a second
 * run of the same arithmetic: the corners of a square, the quarters of a ring of four, a
 * frame that turns the axes into each other.
 */

const IDENTITY: Quat = [0, 0, 0, 1];
const near = (actual: readonly number[], expected: readonly number[], what: string): void => {
  expected.forEach((value, at) => expect(actual[at], `${what}, component ${at} of [${actual.join(", ")}]`).toBeCloseTo(value, 12));
};
const HALF = Math.SQRT1_2;

describe("sweep outlines: how many columns (T1587b)", () => {
  it("a closed outline has a side a point, an open one a side fewer", () => {
    expect(sweepSides(sweepOutline("ring", 12, true))).toBe(12);
    expect(sweepSides(sweepOutline("square", 12, true))).toBe(4);
    expect(sweepSides(sweepOutline("strip", 3, true))).toBe(3);
  });

  it("a column a point, or two a side where the sides are flat", () => {
    expect(sweepColumnCount(sweepOutline("ring", 12, true))).toBe(12);
    expect(sweepColumnCount(sweepOutline("ring", 12, false))).toBe(24);
    // A Square is flat whatever Smooth says; a Strip is one flat side and needs no second column.
    expect(sweepColumnCount(sweepOutline("square", 12, true))).toBe(8);
    expect(sweepColumnCount(sweepOutline("strip", 3, false))).toBe(4);
    expect(sweepColumnCount({ points: { length: 5 }, closed: false, flat: true })).toBe(8);
    expect(sweepColumnCount({ points: { length: 5 }, closed: true, flat: true })).toBe(10);
  });

  it("a Ring has at least three sides and a Strip at least one segment", () => {
    expect(sweepOutline("ring", 1, true).points).toHaveLength(3);
    expect(sweepOutline("strip", 0, true).points).toEqual([[1, 0], [-1, 0]]);
  });

  it("a cap is two rows at its end, and a closed path has no ends", () => {
    expect(sweepCapRows("none", false)).toEqual({ start: 0, end: 0 });
    expect(sweepCapRows("start", false)).toEqual({ start: 2, end: 0 });
    expect(sweepCapRows("end", false)).toEqual({ start: 0, end: 2 });
    expect(sweepCapRows("both", false)).toEqual({ start: 2, end: 2 });
    expect(sweepCapRows("both", true)).toEqual({ start: 0, end: 0 });
  });
});

describe("sweep outlines: where the columns stand (T1587b)", () => {
  it("a Square: the +X face first, two columns a side, each side its own normal", () => {
    const columns = sweepColumns(sweepOutline("square", 4, true), false);
    expect(columns.map((column) => column.at)).toEqual([[1, -1], [1, 1], [1, 1], [-1, 1], [-1, 1], [-1, -1], [-1, -1], [1, -1]]);
    expect(columns.map((column) => column.normal.map((value) => value + 0))).toEqual([[1, 0], [1, 0], [0, 1], [0, 1], [-1, 0], [-1, 0], [0, -1], [0, -1]]);
    // A quarter of the way round a side; the two columns at a corner share it, and the last closes on 1.
    expect(columns.map((column) => column.u)).toEqual([0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1]);
  });

  it("a smooth Ring of four: a point on each axis from +X toward +Y, each normal its own radius", () => {
    const columns = sweepColumns(sweepOutline("ring", 4, true), false);
    const axes: Vec2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    columns.forEach((column, index) => {
      near(column.at, axes[index]!, `column ${index}`);
      near(column.normal, axes[index]!, `normal ${index}`);
    });
    expect(columns.map((column) => column.u)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it("a flat Ring of four: the same four points, two columns a side, the sides' normals on the diagonals", () => {
    const columns = sweepColumns(sweepOutline("ring", 4, false), false);
    const points: Vec2[] = [[1, 0], [0, 1], [0, 1], [-1, 0], [-1, 0], [0, -1], [0, -1], [1, 0]];
    const diagonals: Vec2[] = [[HALF, HALF], [HALF, HALF], [-HALF, HALF], [-HALF, HALF], [-HALF, -HALF], [-HALF, -HALF], [HALF, -HALF], [HALF, -HALF]];
    columns.forEach((column, index) => {
      near(column.at, points[index]!, `column ${index}`);
      near(column.normal, diagonals[index]!, `normal ${index}`);
    });
  });

  it("a Strip: from +X to −X, so the side it is lit on is +Y", () => {
    const columns = sweepColumns(sweepOutline("strip", 2, true), false);
    expect(columns.map((column) => column.at)).toEqual([[1, 0], [0, 0], [-1, 0]]);
    expect(columns.map((column) => column.normal)).toEqual([[0, 1], [0, 1], [0, 1]]);
    expect(columns.map((column) => column.u)).toEqual([0, 0.5, 1]);
  });

  it("a smooth outline is sharp where it repeats a point", () => {
    /* Up the +X side, a corner, then along the top: the corner's two columns take the
       normal of the side each belongs to. */
    const outline: SweepOutline = { points: [[1, 0], [1, 1], [1, 1], [-0.5, 1]], closed: false, flat: false };
    const columns = sweepColumns(outline, false);
    expect(columns.map((column) => column.normal.map((value) => value + 0))).toEqual([[1, 0], [1, 0], [0, 1], [0, 1]]);
    // By sides, the one of no length included: thirds.
    columns.forEach((column, index) => expect(column.u).toBeCloseTo(index / 3, 12));
  });

  it("a smooth corner's normal is square to the line through its two neighbours", () => {
    const triangle: SweepOutline = { points: [[1, -0.5], [0, 1], [-1, -0.5]], closed: true, flat: false };
    const columns = sweepColumns(triangle, false);
    // The apex's neighbours are level, so its normal is straight up.
    near(columns[1]!.normal, [0, 1], "apex");
    /* The left corner's neighbours are the apex (0, 1) and, round the seam, the first point
       (1, −0.5): the line through them runs (1, −1.5), and a quarter turn clockwise of that
       is (−1.5, −1): down and out to the left. */
    near(columns[2]!.normal, [-1.5 / Math.hypot(1.5, 1), -1 / Math.hypot(1.5, 1)], "left");
  });

  it("Inward walks the same outline the other way from its first point, with every normal turned", () => {
    const ring = sweepColumns(sweepOutline("ring", 4, true), true);
    const axes: Vec2[] = [[1, 0], [0, -1], [-1, 0], [0, 1]];
    ring.forEach((column, index) => {
      near(column.at, axes[index]!, `column ${index}`);
      near(column.normal, [-axes[index]![0], -axes[index]![1]], `normal ${index}`);
    });
    // The way round still rises with the column.
    expect(ring.map((column) => column.u)).toEqual([0, 0.25, 0.5, 0.75]);

    const square = sweepColumns(sweepOutline("square", 4, true), true);
    // From the first corner back along the −Y face, then −X, +Y and +X.
    expect(square.map((column) => column.at)).toEqual([[1, -1], [-1, -1], [-1, -1], [-1, 1], [-1, 1], [1, 1], [1, 1], [1, -1]]);
    expect(square.map((column) => column.normal.map((value) => value + 0))).toEqual([[0, 1], [0, 1], [1, 0], [1, 0], [0, -1], [0, -1], [-1, 0], [-1, 0]]);
    expect(square.map((column) => column.u)).toEqual([0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1]);

    const strip = sweepColumns(sweepOutline("strip", 2, true), true);
    expect(strip.map((column) => column.at)).toEqual([[-1, 0], [0, 0], [1, 0]]);
    expect(strip.map((column) => column.normal.map((value) => value + 0))).toEqual([[0, -1], [0, -1], [0, -1]]);
  });
});

describe("sweepStrip: the grid (T1587b)", () => {
  const LINE: ReadonlyArray<SweepPathPoint> = [
    { position: [0, 0, -1], orient: IDENTITY, distance: 0, curveU: 0, curveLength: 2 },
    { position: [0, 0, 0], orient: IDENTITY, distance: 1, curveU: 0.5, curveLength: 2 },
    { position: [0, 0, 1], orient: IDENTITY, distance: 2, curveU: 1, curveLength: 2 },
  ];
  const square = (options: Partial<SweepOptions> = {}): SweepOptions => ({
    outline: sweepOutline("square", 4, true),
    inward: false,
    radius: 0.25,
    caps: "none",
    pathClosed: false,
    uvAlong: "points",
    uvLength: 1,
    ...options,
  });
  /** One value per row: column 0's. */
  const rows = <T>(vertices: ReadonlyArray<T>, columns = 8): T[] => vertices.filter((_, slot) => slot % columns === 0);

  it("is row × columns + column: a ring a path point, under the identity frame the profile itself", () => {
    const vertices = sweepStrip(LINE, square());
    expect(vertices).toHaveLength(24);
    // Column 1 is the corner (r, r).
    expect([1, 9, 17].map((slot) => vertices[slot]!.position)).toEqual([[0.25, 0.25, -1], [0.25, 0.25, 0], [0.25, 0.25, 1]]);
    expect(vertices.map((vertex) => vertex.point)).toEqual([0, 1, 2].flatMap((point) => Array<number>(8).fill(point)));
    expect(vertices[1]!.normal).toEqual([1, 0, 0]);
  });

  it("turns the profile by the frame: a frame of halves carries X to Y, Y to Z and Z to X", () => {
    const turned = sweepStrip(
      [
        { position: [1, 0, 0], orient: [0.5, 0.5, 0.5, 0.5] },
        { position: [2, 0, 0], orient: [0.5, 0.5, 0.5, 0.5] },
      ],
      square(),
    );
    expect(turned[1]!.position).toEqual([1, 0.25, 0.25]);
    expect(turned[1]!.normal).toEqual([0, 1, 0]);
    expect(turned[9]!.position).toEqual([2, 0.25, 0.25]);
  });

  it("multiplies the radius by the path point's own", () => {
    const tapered = sweepStrip(LINE.map((point, index) => ({ ...point, scale: [1, 2, 0.5][index]! })), square());
    expect([1, 9, 17].map((slot) => tapered[slot]!.position)).toEqual([[0.25, 0.25, -1], [0.5, 0.5, 0], [0.125, 0.125, 1]]);
  });

  it("caps: the start's centre and rim first, the end's rim and centre last", () => {
    const vertices = sweepStrip(LINE, square({ caps: "both" }));
    expect(vertices).toHaveLength(56);
    expect(rows(vertices).map((vertex) => vertex.point)).toEqual([0, 0, 0, 1, 2, 2, 2]);
    // Column 1 again: the centre is the path point, the rim the ring.
    const column = vertices.filter((_, slot) => slot % 8 === 1);
    expect(column.map((vertex) => vertex.position)).toEqual([
      [0, 0, -1],
      [0.25, 0.25, -1],
      [0.25, 0.25, -1],
      [0.25, 0.25, 0],
      [0.25, 0.25, 1],
      [0.25, 0.25, 1],
      [0, 0, 1],
    ]);
    // A cap faces out of its end.
    expect(column.map((vertex) => vertex.normal)).toEqual([[0, 0, -1], [0, 0, -1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [0, 0, 1], [0, 0, 1]]);
  });

  it("an inward cap faces into the tube", () => {
    const column = sweepStrip(LINE, square({ caps: "both", inward: true })).filter((_, slot) => slot % 8 === 0);
    expect(column.map((vertex) => vertex.normal.map((value) => value + 0))).toEqual([[0, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, -1]]);
  });

  it("a closed path takes no caps", () => {
    expect(sweepStrip(LINE, square({ caps: "both", pathClosed: true }))).toHaveLength(24);
  });

  it("the coordinate along: Points by rows, Stretch by share, Metres by distance over the tile", () => {
    const along = (options: Partial<SweepOptions>): number[] => rows(sweepStrip(LINE, square(options))).map((vertex) => vertex.uv[1]);
    expect(along({ uvAlong: "points" })).toEqual([0, 0.5, 1]);
    // A closed path's rows go on to the seam: thirds, not halves.
    along({ uvAlong: "points", pathClosed: true }).forEach((value, row) => expect(value).toBeCloseTo(row / 3, 12));
    expect(along({ uvAlong: "stretch" })).toEqual([0, 0.5, 1]);
    expect(along({ uvAlong: "metres", uvLength: 0.5 })).toEqual([0, 2, 4]);
    // A cap's centre is one radius further along: a quarter metre, half a tile, an eighth of the length.
    expect(along({ uvAlong: "metres", uvLength: 0.5, caps: "both" })).toEqual([-0.5, 0, 0, 2, 4, 4, 4.5]);
    expect(along({ uvAlong: "stretch", caps: "both" })).toEqual([-0.125, 0, 0, 0.5, 1, 1, 1.125]);
    // A loop of 2 m with a tile of 0.75 holds 2.67 tiles, rounded to 3: a metre is a tile and a half.
    expect(along({ uvAlong: "metres", uvLength: 0.75, pathClosed: true })).toEqual([0, 1.5, 3]);
    // And never fewer than one tile, however long the tile.
    expect(along({ uvAlong: "metres", uvLength: 100, pathClosed: true })).toEqual([0, 0.5, 1]);
  });

  it("the way round is the column's, the same on every row", () => {
    const vertices = sweepStrip(LINE, square({ caps: "end" }));
    for (let slot = 0; slot < vertices.length; slot += 1) expect(vertices[slot]!.uv[0]).toBe([0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1][slot % 8]);
  });

  it("a path point that is not on an axis: the ring is about the point", () => {
    const origin: Vec3 = [3, -2, 5];
    const ring = sweepStrip([{ position: origin, orient: IDENTITY }, { position: [3, -2, 6], orient: IDENTITY }], square({ radius: 2 }));
    expect(ring[0]!.position).toEqual([5, -4, 5]);
    expect(ring[3]!.position).toEqual([1, 0, 5]);
  });
});
