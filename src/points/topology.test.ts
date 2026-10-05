import { describe, expect, it } from "vitest";

import { formatTopology, gridCellCounts, gridPointCount, parseTopology, stripsOf, stripsPointCount } from "./topology.ts";

/** The T302 vocabulary: one grammar, parsed and formatted by the same module. */
describe("point topology grammar (T302)", () => {
  it("round-trips every form through parse ∘ format", () => {
    for (const value of ["points", "grid:64x64", "grid:48x24:wrapU", "grid:3x9:wrapV", "grid:48x24:wrapUV"]) {
      const parsed = parseTopology(value);
      expect(parsed, value).not.toBeNull();
      expect(formatTopology(parsed as NonNullable<typeof parsed>)).toBe(value);
    }
  });

  it("treats an absent claim as points, and an unknown one as null — never a guess", () => {
    expect(parseTopology(undefined)).toEqual({ kind: "points" });
    expect(parseTopology("grid:64")).toBeNull();
    expect(parseTopology("grid:64x64:wrapQ")).toBeNull();
    expect(parseTopology("mesh:whatever")).toBeNull();
  });

  it("counts cells per axis: a wrapped axis gains its seam cell", () => {
    const open = parseTopology("grid:48x24");
    const tube = parseTopology("grid:48x24:wrapU");
    const torus = parseTopology("grid:48x24:wrapUV");
    if (open?.kind !== "grid" || tube?.kind !== "grid" || torus?.kind !== "grid") throw new Error("parse failed");
    expect(gridCellCounts(open)).toEqual({ cellsU: 47, cellsV: 23 });
    expect(gridCellCounts(tube)).toEqual({ cellsU: 48, cellsV: 23 });
    expect(gridCellCounts(torus)).toEqual({ cellsU: 48, cellsV: 24 });
    expect(gridPointCount(torus)).toBe(48 * 24);
  });
});

/** T1586b: curves are strips — rows of equal slot runs, connected along U only. */
describe("the strips claim (T1586b)", () => {
  it("round-trips open and closed strips through parse ∘ format", () => {
    for (const value of ["strips:55x10", "strips:240x1", "strips:8x3:closed"]) {
      const parsed = parseTopology(value);
      expect(parsed, value).not.toBeNull();
      expect(formatTopology(parsed as NonNullable<typeof parsed>)).toBe(value);
    }
    expect(parseTopology("strips:8x3:closed")).toEqual({ kind: "strips", cols: 8, rows: 3, closed: true });
  });

  it("refuses a malformed strips claim rather than guessing one", () => {
    expect(parseTopology("strips:8")).toBeNull();
    expect(parseTopology("strips:0x3")).toBeNull();
    expect(parseTopology("strips:8x3:wrapU")).toBeNull();
    expect(parseTopology("strips:8x3:open")).toBeNull();
  });

  /**
   * The ONE answer to "what strips does this edge carry" — and the reason a rope and a
   * cloth solve on one layout: a grid's rows are strips, closed exactly when it wraps U.
   * A V wrap says nothing about a strip, which is why the wrapV grid below is open.
   */
  it("stripsOf: a strips claim is itself, a grid's rows are strips, points and mesh carry none", () => {
    expect(stripsOf(parseTopology("strips:55x10"))).toEqual({ cols: 55, rows: 10, closed: false });
    expect(stripsOf(parseTopology("strips:8x3:closed"))).toEqual({ cols: 8, rows: 3, closed: true });
    expect(stripsOf(parseTopology("grid:48x24"))).toEqual({ cols: 48, rows: 24, closed: false });
    expect(stripsOf(parseTopology("grid:48x24:wrapU"))).toEqual({ cols: 48, rows: 24, closed: true });
    expect(stripsOf(parseTopology("grid:48x24:wrapV"))).toEqual({ cols: 48, rows: 24, closed: false });
    expect(stripsOf(parseTopology("points"))).toBeUndefined();
    expect(stripsOf(parseTopology(undefined))).toBeUndefined();
    expect(stripsOf(parseTopology("mesh:12@scratch:m:indices"))).toBeUndefined();
    // A string nobody understands is `null` from the parser, and no strips from here.
    expect(stripsOf(parseTopology("strips:8"))).toBeUndefined();
    expect(stripsPointCount({ cols: 55, rows: 10, closed: false })).toBe(550);
  });
});
