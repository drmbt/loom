import { describe, expect, it } from "vitest";

import {
  formatTopology,
  gridCellCounts,
  gridPointCount,
  gridSheets,
  gridVertexCount,
  kernelDimOf,
  parseTopology,
  stripsOf,
  stripsPointCount,
  type GridTopology,
} from "./topology.ts";

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

/**
 * T1587b slice 2 — a grid of several SHEETS: ten tubes swept from ten strips, one pointset,
 * one draw. The third number is how many `cols × rows` sheets follow one another in the
 * buffer; without it a claim is one sheet, and is written without it.
 */
describe("a grid of several sheets (T1587b)", () => {
  const grid = (claim: string): GridTopology => {
    const parsed = parseTopology(claim);
    if (parsed === null || parsed.kind !== "grid") throw new Error(`"${claim}" is not a grid`);
    return parsed;
  };

  it("round-trips the sheet count through parse ∘ format, before the wrap flags", () => {
    for (const claim of ["grid:12x54x10", "grid:12x54x10:wrapU", "grid:8x8x2:wrapV", "grid:4x4x1000:wrapUV"]) {
      expect(formatTopology(grid(claim)), claim).toBe(claim);
    }
    expect(grid("grid:12x54x10:wrapU")).toEqual({ kind: "grid", cols: 12, rows: 54, wrapU: true, wrapV: false, sheets: 10 });
  });

  it("one sheet is the claim it always was: parsed without the number, written without it", () => {
    // What every shipped document carries: no third number, and no `sheets` on what it parses to.
    expect(grid("grid:64x64:wrapU")).toEqual({ kind: "grid", cols: 64, rows: 64, wrapU: true, wrapV: false });
    expect(gridSheets(grid("grid:64x64"))).toBe(1);
    // An explicit one is the same claim, and is written the short way.
    expect(grid("grid:64x64x1:wrapU")).toEqual(grid("grid:64x64:wrapU"));
    expect(formatTopology({ kind: "grid", cols: 64, rows: 64, wrapU: true, wrapV: false, sheets: 1 })).toBe("grid:64x64:wrapU");
  });

  it("refuses a malformed sheet count rather than guessing one", () => {
    for (const claim of ["grid:4x4x0", "grid:4x4x", "grid:4x4x-2", "grid:4x4x2x2", "grid:4x4x1.5", "grid:4x4:wrapUx2"]) {
      expect(parseTopology(claim), claim).toBeNull();
    }
  });

  it("counts every sheet's points and vertices, and ONE sheet's cells", () => {
    const tubes = grid("grid:12x54x10:wrapU");
    expect(gridPointCount(tubes)).toBe(12 * 54 * 10);
    // A sheet's cells: twelve round (the seam's included), fifty-three along.
    expect(gridCellCounts(tubes)).toEqual({ cellsU: 12, cellsV: 53 });
    // The one draw: six vertices a cell, ten sheets, and no cell between two of them.
    expect(gridVertexCount(tubes)).toBe(12 * 53 * 6 * 10);
    expect(gridVertexCount(grid("grid:12x54:wrapU"))).toBe(12 * 53 * 6);
    expect(gridVertexCount(grid("grid:4x3x5"))).toBe(3 * 2 * 6 * 5);
    expect(gridVertexCount(grid("grid:4x3x5:wrapUV"))).toBe(4 * 3 * 6 * 5);
  });

  it("stripsOf: every row of every sheet is a strip", () => {
    expect(stripsOf(grid("grid:12x54x10:wrapU"))).toEqual({ cols: 12, rows: 540, closed: true });
    expect(stripsOf(grid("grid:12x54"))).toEqual({ cols: 12, rows: 54, closed: false });
  });

  it("kernelDimOf: ONE sheet's columns and rows, and how many sheets", () => {
    expect(kernelDimOf(grid("grid:12x54x10:wrapU"))).toEqual({ cols: 12, rows: 54, sheets: 10 });
    expect(kernelDimOf(grid("grid:12x54"))).toEqual({ cols: 12, rows: 54, sheets: 1 });
    // Strips are one sheet of `rows` curves, as they always were to a kernel.
    expect(kernelDimOf(parseTopology("strips:54x10:closed"))).toEqual({ cols: 54, rows: 10, sheets: 1 });
    expect(kernelDimOf(parseTopology("points"))).toBeUndefined();
    expect(kernelDimOf(parseTopology("mesh:12@buffer"))).toBeUndefined();
    expect(kernelDimOf(null)).toBeUndefined();
  });
});
