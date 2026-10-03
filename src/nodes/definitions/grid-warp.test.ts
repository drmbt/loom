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
 * written mesh); this file pins the forward map, the fold verdict, the schema and the resample (T1532b).
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

/** The plan for these stored values, handed over as the resolver hands them: every schema key, defaults filled in. */
function compile(stored: Record<string, unknown>) {
  return compileHanded({ ...defaultParameters(effectiveParameterSchema(gridWarpNode, stored)), ...stored });
}

/** The plan for exactly these resolved values (a driven size is one the schema did not see). */
function compileHanded(parameters: Record<string, unknown>) {
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

describe("the Grid Warp node's plan (T1509b, T1532b)", () => {
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
    const { pass } = compile({ columns: 4, rows: 2, interpolation: "linear", [pointKey(3, 1)]: [0.9, 0.8] });
    expect(pass.uniforms).toMatchObject({ columns: 4, rows: 2, spline: 0, valid: 1 });
    // (3, 1) is k = 11: the second half of g5.
    expect((pass.uniforms?.["g5"] as number[]).slice(2)).toEqual([0.9, 0.8]);
    // The plan's shape does not depend on the size: the same vertex count at 2 × 2 and 8 × 8.
    expect(compile({ columns: 2, rows: 2 }).pass.vertexCount).toBe(compile({ columns: 8, rows: 8 }).pass.vertexCount);
  });

  it("refuses a folded grid: transparent (valid 0), finite uniforms, a named diagnostic", () => {
    const { pass, diagnostics } = compile({ [pointKey(1, 1)]: [1.2, 0.5] });
    expect(pass.uniforms?.["valid"]).toBe(0);
    for (const value of Object.values(pass.uniforms ?? {})) for (const entry of [value].flat()) expect(Number.isFinite(entry)).toBe(true);
    expect(diagnostics.map((d) => [d.severity, d.code])).toEqual([["warning", "gridWarp.folded"]]);
    expect(diagnostics[0]?.message).toMatch(/right of column 2, above row 1/);
  });

  it("a DRIVEN size the stored points were not made for samples their surface (T1532b)", () => {
    // The document stores a 3 × 3 grid, centre raised by d = (0.2, 0.1); an expression drives
    // Columns to 4. The new middle-row point (1, 1) sits at grid coordinate 2/3, where
    // Catmull-Rom weighs the displacements −d (the continuation), 0, d, 0 by −1/27, 9/27,
    // 21/27, −2/27: 22/27 of d on top of the identity (1/3, 1/2).
    const stored = { ...defaultParameters(effectiveParameterSchema(gridWarpNode, {})), [pointKey(1, 1)]: [0.7, 0.6] };
    const { pass } = compileHanded({ ...stored, columns: 4 });
    expect(pass.uniforms).toMatchObject({ columns: 4, rows: 3, valid: 1 });
    // (1, 1) is k = 9: the second half of g4.
    const [x, y] = (pass.uniforms?.["g4"] as number[]).slice(2) as [number, number];
    expect(x).toBeCloseTo(1 / 3 + (22 / 27) * 0.2, 14);
    expect(y).toBeCloseTo(0.5 + (22 / 27) * 0.1, 14);
    // The corners are shared by both grids and stay exactly where they were: (3, 2) is k = 19.
    expect((pass.uniforms?.["g9"] as number[]).slice(2)).toEqual([1, 1]);
  });
});

describe("one parameter per point of the CURRENT grid (T1532b)", () => {
  const handled = (stored: Record<string, unknown>) =>
    Object.entries(effectiveParameterSchema(gridWarpNode, stored))
      .filter(([, definition]) => definition.type === "vector" && definition.handle === "picture")
      .map(([key]) => key);

  it("a fresh node stores the 3 × 3 grid's nine points at the identity, each a picture handle", () => {
    const fresh = defaultParameters(effectiveParameterSchema(gridWarpNode, {}));
    expect(handled(fresh)).toEqual(["p00", "p10", "p20", "p01", "p11", "p21", "p02", "p12", "p22"]);
    expect(fresh["p11"]).toEqual([0.5, 0.5]);
  });

  it("the schema declares exactly the stored size's points, and no other size's", () => {
    const schema = effectiveParameterSchema(gridWarpNode, { columns: 4, rows: 2 });
    expect(handled({ columns: 4, rows: 2 })).toEqual(["p00", "p10", "p20", "p30", "p01", "p11", "p21", "p31"]);
    expect(schema["p11"]?.type === "vector" && schema["p11"].default).toEqual([1 / 3, 1]);
    expect(schema["p02"]).toBeUndefined();
    // T1509b's per-size spelling is gone: a document saved by fcd482c6 holds undeclared keys.
    expect(effectiveParameterSchema(gridWarpNode, { p11_3x3: [0, 0] })["p11_3x3"]).toBeUndefined();
  });
});

describe("a size change is coupled to the points (T1532b)", () => {
  const fresh = defaultParameters(effectiveParameterSchema(gridWarpNode, {}));
  const coupled = gridWarpNode.coupledParameters;
  if (coupled === undefined) throw new Error("Grid Warp declares no coupled parameters");

  it("an edit that leaves the size alone couples nothing", () => {
    expect(coupled(fresh, { [pointKey(1, 1)]: [0.7, 0.6] })).toBeNull();
    expect(coupled(fresh, { interpolation: "linear" })).toBeNull();
    expect(coupled(fresh, { columns: 3 })).toBeNull();
  });

  it("LINEAR resamples bilinearly: the raised centre puts 2/3 of its lift on each new middle point", () => {
    // Linear interpolation, and one point moved: bilinear in the cell, so the new middle-row
    // points at grid coordinates 2/3 and 4/3 each carry 2/3 of d = (0.2, 0.1).
    const stored = { ...fresh, interpolation: "linear", [pointKey(1, 1)]: [0.7, 0.6] };
    const result = coupled(stored, { columns: 4 });
    const at = (column: number, row: number) => result?.set[pointKey(column, row)] as [number, number];
    for (const column of [1, 2]) {
      expect(at(column, 1)[0]).toBeCloseTo(column / 3 + (2 / 3) * 0.2, 14);
      expect(at(column, 1)[1]).toBeCloseTo(0.5 + (2 / 3) * 0.1, 14);
    }
    expect(result?.remove).toEqual([]);
  });

  it("shrinking deletes the points the smaller grid lacks, component slots included", () => {
    const stored = { ...fresh, "p21.x": 0.9 };
    const result = coupled(stored, { columns: 2 });
    expect(Object.keys(result?.set ?? {}).sort()).toEqual(["p00", "p01", "p02", "p10", "p11", "p12"]);
    expect([...(result?.remove ?? [])].sort()).toEqual(["p20", "p21", "p21.x", "p22"]);
    // The identity 3 × 3 resampled onto 2 × 3 is the identity 2 × 3: (1, 1) lands on the right edge.
    expect(result?.set[pointKey(1, 1)]).toEqual([1, 0.5]);
  });
});
