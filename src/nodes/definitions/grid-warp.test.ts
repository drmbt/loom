import { describe, expect, it } from "vitest";

import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { defaultParameters } from "../../domain/parameters/validate.ts";
import { validateNodeDefinition } from "../registry/registry.ts";
import { GRID_WARP_MAX } from "../shaders/grid-warp.wgsl.ts";
import { gridFold, gridWarpNode, gridWarpPoint, identityPoint, pointKey } from "./grid-warp.ts";
import type { Point2, WarpGrid } from "./grid-warp.ts";
import { compileContext, readNodePlan } from "./test-support.ts";

/**
 * Grid Warp's arithmetic and plan (T1509b), against values derived BY HAND in the comments.
 * The pixels are the Dawn test's claim (`grid-warp.gpu.test.ts`, against an independently
 * written mesh); this file pins the forward map, the fold verdict and the per-size schema.
 */

function identityGrid(columns: number, rows: number, smooth: boolean): WarpGrid {
  const points: Point2[] = [];
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) points.push(identityPoint(column, row, columns, rows));
  return { columns, rows, points, smooth };
}

const moved = (grid: WarpGrid, column: number, row: number, to: Point2): WarpGrid => ({
  ...grid,
  points: grid.points.map((point, index) => (index === row * grid.columns + column ? to : point)),
});

function compile(parameters: Record<string, unknown>) {
  const options = { inputs: ["input"], parameters } as const;
  const compiled = gridWarpNode.compile(compileContext(options as never));
  const read = readNodePlan(compiled.passes, options as never);
  expect(read.ok).toBe(true);
  const pass = read.passes[0];
  if (pass?.kind !== "draw") throw new Error("gridWarp did not emit a draw pass");
  return { pass, diagnostics: compiled.diagnostics ?? [] };
}

describe("the forward map (T1509b)", () => {
  it.each([false, true])("is the identity on an undistorted grid, exactly, everywhere (smooth: %s)", (smooth) => {
    // Bilinear of a linear function is itself; Catmull-Rom reproduces linear data, and the
    // straight-line continuation past each edge keeps the end cells linear too.
    for (const [columns, rows] of [[3, 3], [2, 2], [4, 3]] as const) {
      const grid = identityGrid(columns, rows, smooth);
      for (const [gu, gv] of [[0, 0], [0.25, 1.5], [columns - 1, rows - 1], [1.0625, 0.5]] as const) {
        if (gu > columns - 1 || gv > rows - 1) continue;
        const [x, y] = gridWarpPoint(grid, gu, gv);
        expect(x).toBeCloseTo(gu / (columns - 1), 14);
        expect(y).toBeCloseTo(gv / (rows - 1), 14);
      }
    }
  });

  it.each([false, true])("passes through every control point (smooth: %s)", (smooth) => {
    const grid = moved(identityGrid(3, 3, smooth), 1, 1, [0.7, 0.6]);
    expect(gridWarpPoint(grid, 1, 1)).toEqual([0.7, 0.6]);
    expect(gridWarpPoint(grid, 2, 0)).toEqual([1, 0]);
  });

  it("bends the picture between points by hand-derived amounts: bilinear 1/2, Catmull-Rom 5/8", () => {
    /*
     * 3 × 2 grid, the middle column's bottom point raised by d = 0.2: (0.5, 0) → (0.5, 0.2).
     * Half way between it and the left corner, on the bottom row (gu = 0.5, gv = 0):
     *  - bilinear: the mean of 0 and d, so y = 0.1;
     *  - Catmull-Rom at t = 1/2 weighs P-1, P0, P1, P2 by -1/16, 9/16, 9/16, -1/16. P-1 is
     *    the straight continuation 2·P0 − P1, so its y is −d; P0 and P2 have y 0, P1 has d:
     *    y = (−1/16)(−d) + (9/16)d = (10/16)d = 0.125.
     */
    const lifted = moved(identityGrid(3, 2, false), 1, 0, [0.5, 0.2]);
    expect(gridWarpPoint(lifted, 0.5, 0)[1]).toBeCloseTo(0.1, 14);
    expect(gridWarpPoint({ ...lifted, smooth: true }, 0.5, 0)[1]).toBeCloseTo(0.125, 14);
  });

  it.each([false, true])("reproduces an AFFINE grid exactly — a Corner Pin parallelogram (smooth: %s)", (smooth) => {
    // x = 0.6u + 0.2v + 0.1, y = 0.1u + 0.7v + 0.05: every grid point placed by it, every
    // in-between point must follow it too.
    const affine = ([u, v]: Point2): Point2 => [0.6 * u + 0.2 * v + 0.1, 0.1 * u + 0.7 * v + 0.05];
    const base = identityGrid(4, 3, smooth);
    const grid = { ...base, points: base.points.map(affine) };
    for (const [gu, gv] of [[0.3, 0.2], [1.5, 1.75], [2.9, 0.1]] as const) {
      const [x, y] = gridWarpPoint(grid, gu, gv);
      const [ex, ey] = affine([gu / 3, gv / 2]);
      expect(x).toBeCloseTo(ex, 14);
      expect(y).toBeCloseTo(ey, 14);
    }
  });
});

describe("a grid that folds (T1509b)", () => {
  it("accepts the identity, an affine grid and a MIRRORED grid (rear projection)", () => {
    expect(gridFold(identityGrid(3, 3, true))).toBeNull();
    expect(gridFold(identityGrid(GRID_WARP_MAX, GRID_WARP_MAX, false))).toBeNull();
    const base = identityGrid(3, 3, true);
    expect(gridFold({ ...base, points: base.points.map(([x, y]) => [1 - x, y] as Point2) })).toBeNull();
  });

  it("names the folded cell when a point is dragged past its neighbour", () => {
    // The centre point dragged right past the middle-right point (1, 0.5): the left cells
    // stretch, the right cells turn inside out. Scanning bottom-up, the first folded
    // triangle is in the bottom-right cell, (1, 0), where its left edge x = 0.5 + 0.7v
    // passes its right edge x = 1 at v = 5/7.
    const fold = gridFold(moved(identityGrid(3, 3, false), 1, 1, [1.2, 0.5]));
    expect(fold?.reason).toMatch(/folds over itself/);
    expect(fold?.cell).toEqual([1, 0]);
  });

  it("refuses a point on top of its neighbour (a cell with no width)", () => {
    expect(gridFold(moved(identityGrid(3, 3, false), 1, 0, [1, 0]))?.reason).toMatch(/folds over itself/);
  });

  it("refuses a grid whose outline crosses itself while every cell turns the same way", () => {
    // An 8 × 2 strip wound one and a half times round a ring: each cell is a fine curved
    // quad, all turning one way, and the strip's far end lies over its start.
    const columns = 8;
    const points: Point2[] = [];
    for (const radius of [0.2, 0.35]) {
      for (let column = 0; column < columns; column += 1) {
        const angle = (column / (columns - 1)) * 3 * Math.PI;
        points.push([0.5 + radius * Math.cos(angle), 0.5 + radius * Math.sin(angle)]);
      }
    }
    const fold = gridFold({ columns, rows: 2, points, smooth: false });
    expect(fold?.reason).toMatch(/outline crosses itself/);
  });

  it("refuses a non-finite point by name", () => {
    expect(gridFold(moved(identityGrid(3, 3, false), 1, 1, [Number.NaN, 0.5]))?.reason).toMatch(/not a finite number/);
  });
});

describe("the Grid Warp node's plan (T1509b)", () => {
  it("registers cleanly, and a fresh node draws the 3 × 3 identity grid", () => {
    expect(validateNodeDefinition(gridWarpNode)).toEqual([]);
    const { pass, diagnostics } = compile({});
    expect(diagnostics).toEqual([]);
    expect(pass.uniforms).toMatchObject({ columns: 3, rows: 3, spline: 1, valid: 1, feather: 0 });
    // Point (c, r) is lane pair k = r·8 + c: g0 holds (0,0) and (1,0), g1 holds (2,0) and (3,0).
    expect(pass.uniforms?.["g0"]).toEqual([0, 0, 0.5, 0]);
    expect(pass.uniforms?.["g1"]).toEqual([1, 0, 0, 0]);
    // Row 1 starts at k = 8: g4 = (0, 0.5), (0.5, 0.5).
    expect(pass.uniforms?.["g4"]).toEqual([0, 0.5, 0.5, 0.5]);
  });

  it("carries a moved point to its lane, and the size and interpolation as uniforms", () => {
    const { pass } = compile({ columns: 4, rows: 2, interpolation: "linear", [pointKey(3, 1, 4, 2)]: [0.9, 0.8] });
    expect(pass.uniforms).toMatchObject({ columns: 4, rows: 2, spline: 0, valid: 1 });
    // (3, 1) is k = 11: the second half of g5.
    expect((pass.uniforms?.["g5"] as number[]).slice(2)).toEqual([0.9, 0.8]);
    // The plan's shape does not depend on the size: the same vertex count at 2 × 2 and 8 × 8.
    expect(compile({ columns: 2, rows: 2 }).pass.vertexCount).toBe(compile({ columns: 8, rows: 8 }).pass.vertexCount);
  });

  it("refuses a folded grid: transparent (valid 0), finite uniforms, a named diagnostic", () => {
    const { pass, diagnostics } = compile({ [pointKey(1, 1, 3, 3)]: [1.2, 0.5] });
    expect(pass.uniforms?.["valid"]).toBe(0);
    for (const value of Object.values(pass.uniforms ?? {})) for (const entry of [value].flat()) expect(Number.isFinite(entry)).toBe(true);
    expect(diagnostics.map((d) => [d.severity, d.code])).toEqual([["warning", "gridWarp.folded"]]);
    expect(diagnostics[0]?.message).toMatch(/right of column 2, above row 1/);
  });
});

describe("one parameter per point, per grid size (T1509b)", () => {
  const handled = (stored: Record<string, unknown>) =>
    Object.entries(effectiveParameterSchema(gridWarpNode, stored))
      .filter(([, definition]) => definition.type === "vector" && definition.handle === "picture" && definition.inactiveWhen?.({}) == null)
      .map(([key]) => key);

  it("a fresh node stores the 3 × 3 grid's nine points at the identity, each a picture handle", () => {
    const fresh = defaultParameters(effectiveParameterSchema(gridWarpNode, {}));
    expect(handled(fresh)).toEqual(["p00_3x3", "p10_3x3", "p20_3x3", "p01_3x3", "p11_3x3", "p21_3x3", "p02_3x3", "p12_3x3", "p22_3x3"]);
    expect(fresh["p11_3x3"]).toEqual([0.5, 0.5]);
  });

  it("a new size offers its own points, undistorted; the stored 3 × 3 ones stay, inactive, in Advanced", () => {
    const stored = { ...defaultParameters(effectiveParameterSchema(gridWarpNode, {})), columns: 4, p11_3x3: [0.7, 0.6] };
    const schema = effectiveParameterSchema(gridWarpNode, stored);
    expect(handled(stored)).toHaveLength(12);
    expect(handled(stored)).toContain("p31_4x3");
    expect(schema["p11_4x3"]?.type === "vector" && schema["p11_4x3"].default).toEqual([1 / 3, 0.5]);
    // The 3 × 3 point is still declared — the compile would warn about an undeclared stored
    // key — but it applies to nothing and offers no handle.
    expect(schema["p11_3x3"]?.inactiveWhen?.({})).toMatch(/3 × 3 grid/);
    expect(schema["p11_3x3"]?.group).toBe("Advanced");
  });

  it("going back to a size brings its warp back: the compile reads that size's stored points", () => {
    const stored = { columns: 3, rows: 3, p11_3x3: [0.7, 0.6], p11_4x3: [0.2, 0.2] };
    expect(compile(stored).pass.uniforms?.["g4"]).toEqual([0, 0.5, 0.7, 0.6]);
  });

  it("ignores keys that are not a point of any grid", () => {
    const schema = effectiveParameterSchema(gridWarpNode, { p33_3x3: [0, 0], p11: [0, 0] });
    expect(schema["p33_3x3"]).toBeUndefined();
    expect(schema["p11"]).toBeUndefined();
  });
});
