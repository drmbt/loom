import { describe, expect, it } from "vitest";

import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { defaultParameters } from "../../domain/parameters/validate.ts";
import { validateNodeDefinition } from "../registry/registry.ts";
import { GRID_WARP_MAX } from "../shaders/grid-warp.wgsl.ts";
import {
  columnKey,
  deleteGridLine,
  gridFold,
  gridWarpInverse,
  gridWarpNode,
  gridWarpPoint,
  gridWarpSource,
  identityPoint,
  insertGridLine,
  pointKey,
} from "./grid-warp.ts";
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
    // T1534b: each line's picture position rides along with the points.
    expect(Object.keys(result?.set ?? {}).sort()).toEqual(["p00", "p01", "p02", "p10", "p11", "p12", "u0", "u1", "v0", "v1", "v2"]);
    expect([...(result?.remove ?? [])].sort()).toEqual(["p20", "p21", "p21.x", "p22", "u2"]);
    // The 2-column grid spans the old picture edge to edge: its two columns carry 0 and 1.
    expect([result?.set["u0"], result?.set["u1"]]).toEqual([0, 1]);
    // The identity 3 × 3 resampled onto 2 × 3 is the identity 2 × 3: (1, 1) lands on the right edge.
    expect(result?.set[pointKey(1, 1)]).toEqual([1, 0.5]);
  });
});

describe("inserting and deleting a row or column keeps the picture where it is (T1534b)", () => {
  /** x = 0.6u + 0.2v + 0.1, y = 0.1u + 0.7v + 0.05: a Corner Pin parallelogram. */
  const affine = ([u, v]: Point2): Point2 => [0.6 * u + 0.2 * v + 0.1, 0.1 * u + 0.7 * v + 0.05];
  const affineGrid = (columns: number, rows: number, smooth: boolean): WarpGrid => {
    const base = identityGrid(columns, rows, smooth);
    return { ...base, points: base.points.map(affine) };
  };
  /** A grid nobody would call flat: centre raised, one corner and one edge point pulled. */
  const warped = (smooth: boolean): WarpGrid =>
    moved(moved(moved(identityGrid(3, 3, smooth), 1, 1, [0.62, 0.58]), 2, 2, [0.93, 1.04]), 0, 1, [0.05, 0.47]);
  const inserted = (grid: WarpGrid, axis: "column" | "row", at: number): WarpGrid => {
    const edit = insertGridLine(grid, axis, at);
    if (!edit.ok) throw new Error(edit.reason);
    return edit.grid;
  };
  /** Old grid coordinate g on an axis split at g* (cell i, fraction t*) → the new grid's coordinate of the same place. */
  const split = (g: number, cell: number, t: number): number => {
    if (g <= cell) return g;
    if (g >= cell + 1) return g + 1;
    const f = g - cell;
    return f <= t ? cell + f / t : cell + 1 + (f - t) / (1 - t);
  };
  const SAMPLES = [0, 0.13, 0.5, 0.61, 0.97, 1, 1.25, 1.5, 1.8, 2];

  it("an evenly spread grid shows the picture at gu / (columns − 1): the T1509b grid exactly", () => {
    for (const smooth of [false, true]) {
      const grid = identityGrid(4, 3, smooth);
      for (const [gu, gv] of [[0, 0], [0.4375, 1.5], [3, 2], [2.25, 0.0625]] as const) {
        const [s, t] = gridWarpSource(grid, gu, gv);
        expect(s).toBeCloseTo(gu / 3, 14);
        expect(t).toBeCloseTo(gv / 2, 14);
      }
    }
  });

  it.each([false, true])("a column inserted at u = 0.3 of an AFFINE grid lands exactly on the affine map, and the map stays that map (smooth: %s)", (smooth) => {
    const before = affineGrid(3, 3, smooth);
    const after = inserted(before, "column", 0.3);
    expect([after.columns, after.rows]).toEqual([4, 3]);
    // The new column carries picture u = 0.3, its points the affine map there, hand-derived.
    expect(after.us?.[1]).toBeCloseTo(0.3, 15);
    for (let r = 0; r < 3; r += 1) {
      const [x, y] = after.points[r * 4 + 1] as Point2;
      const [ex, ey] = affine([0.3, r / 2]);
      expect(x).toBeCloseTo(ex, 14);
      expect(y).toBeCloseTo(ey, 14);
    }
    // Every old point and line keeps its value bit for bit, shifted one column right past the new one.
    for (let r = 0; r < 3; r += 1) {
      expect(after.points[r * 4 + 0]).toBe(before.points[r * 3 + 0]);
      expect(after.points[r * 4 + 2]).toBe(before.points[r * 3 + 1]);
      expect(after.points[r * 4 + 3]).toBe(before.points[r * 3 + 2]);
    }
    expect([after.us?.[0], after.us?.[2], after.us?.[3], ...(after.vs ?? [])]).toEqual([0, 0.5, 1, 0, 0.5, 1]);
    // And the drawn map is still the affine one everywhere: the output is the affine image
    // of the picture point shown there, under either interpolation.
    for (const gu of [0.2, 0.9, 1.5, 2.4, 3]) {
      for (const gv of [0.1, 1, 1.7]) {
        const [x, y] = gridWarpPoint(after, gu, gv);
        const [ex, ey] = affine(gridWarpSource(after, gu, gv));
        expect(x).toBeCloseTo(ex, 13);
        expect(y).toBeCloseTo(ey, 13);
      }
    }
  });

  it("LINEAR: inserting into a warped grid leaves the drawn map unchanged everywhere, picture point for picture point", () => {
    const before = warped(false);
    // at 0.3 is grid coordinate 0.6: cell 0, fraction 0.6.
    const after = inserted(before, "column", 0.3);
    for (const gu of SAMPLES) {
      for (const gv of SAMPLES) {
        const there = split(gu, 0, 0.6);
        const [x, y] = gridWarpPoint(after, there, gv);
        const [ox, oy] = gridWarpPoint(before, gu, gv);
        expect(x, `x at ${gu},${gv}`).toBeCloseTo(ox, 13);
        expect(y, `y at ${gu},${gv}`).toBeCloseTo(oy, 13);
        const [s, t] = gridWarpSource(after, there, gv);
        const [os, ot] = gridWarpSource(before, gu, gv);
        expect(s, `u at ${gu},${gv}`).toBeCloseTo(os, 13);
        expect(t, `v at ${gu},${gv}`).toBeCloseTo(ot, 13);
      }
    }
  });

  it("SMOOTH: a row inserted into a warped grid passes through every old point and lies on the old surface", () => {
    const before = warped(true);
    // at 0.75 is grid coordinate 1.5: cell 1, half way.
    const after = inserted(before, "row", 0.75);
    expect([after.columns, after.rows]).toEqual([3, 4]);
    for (let c = 0; c < 3; c += 1) {
      // Old rows 0 and 1 stay, old row 2 is now row 3 — the same objects.
      expect(after.points[0 * 3 + c]).toBe(before.points[0 * 3 + c]);
      expect(after.points[1 * 3 + c]).toBe(before.points[1 * 3 + c]);
      expect(after.points[3 * 3 + c]).toBe(before.points[2 * 3 + c]);
      // The new row's points are the old surface at gv = 1.5.
      const [x, y] = after.points[2 * 3 + c] as Point2;
      const [ox, oy] = gridWarpPoint(before, c, 1.5);
      expect(x).toBe(ox);
      expect(y).toBe(oy);
    }
    expect(after.vs?.[2]).toBeCloseTo(gridWarpSource(before, 0, 1.5)[1], 15);
    // Between the lines the spline now runs through more points (and its tangents at row 1
    // change with the closer neighbour), so it moves — but not far: measured 0.017 of the
    // frame at most, at the left edge beside the pulled edge point, so under 1/40 anywhere.
    for (const gu of SAMPLES) {
      for (const gv of SAMPLES) {
        const there = split(gv, 1, 0.5);
        const [x, y] = gridWarpPoint(after, gu, there);
        const [ox, oy] = gridWarpPoint(before, gu, gv);
        expect(Math.hypot(x - ox, y - oy), `${gu},${gv}`).toBeLessThan(0.025);
      }
    }
  });

  it("deleting a column removes exactly that column; every other point and line keeps its value bit for bit", () => {
    const before = inserted(warped(false), "column", 0.3);
    const edit = deleteGridLine(before, "column", 2);
    if (!edit.ok) throw new Error(edit.reason);
    const after = edit.grid;
    expect([after.columns, after.rows]).toEqual([3, 3]);
    for (let r = 0; r < 3; r += 1) {
      expect(after.points[r * 3 + 0]).toBe(before.points[r * 4 + 0]);
      expect(after.points[r * 3 + 1]).toBe(before.points[r * 4 + 1]);
      expect(after.points[r * 3 + 2]).toBe(before.points[r * 4 + 3]);
    }
    expect(after.us).toEqual([before.us?.[0], before.us?.[1], before.us?.[3]]);
    expect(after.vs).toEqual(before.vs);
    // A row likewise: row 1 of the 3 × 3 goes, rows 0 and 2 stay.
    const rowEdit = deleteGridLine(warped(true), "row", 1);
    if (!rowEdit.ok) throw new Error(rowEdit.reason);
    expect(rowEdit.grid.points).toEqual([...warped(true).points.slice(0, 3), ...warped(true).points.slice(6)]);
    expect(rowEdit.grid.vs).toEqual([0, 1]);
  });

  it("refuses past the caps, on top of a line and outside the surface, each with a named reason", () => {
    const full = identityGrid(GRID_WARP_MAX, 3, true);
    expect(insertGridLine(full, "column", 0.5)).toMatchObject({ ok: false, code: "gridWarp.line.max" });
    expect(insertGridLine(full, "row", 0.3)).toMatchObject({ ok: true });
    const smallest = identityGrid(2, 2, false);
    expect(deleteGridLine(smallest, "row", 0)).toMatchObject({ ok: false, code: "gridWarp.line.min", reason: "the grid has 2 rows, the fewest it can have" });
    expect(deleteGridLine(identityGrid(3, 3, false), "column", 3)).toMatchObject({ ok: false, code: "gridWarp.line.missing" });
    expect(insertGridLine(identityGrid(3, 3, false), "column", 0.5)).toMatchObject({ ok: false, code: "gridWarp.line.exists", reason: "column 2 is already there" });
    expect(insertGridLine(identityGrid(3, 3, false), "row", 1)).toMatchObject({ ok: false, code: "gridWarp.line.outside" });
  });

  it("the inverse of the drawn mesh finds the grid coordinate under an output point; outside and folded find nothing", () => {
    // An affine grid's mesh IS the affine map, so the inverse is exact anywhere inside.
    const grid = affineGrid(4, 3, true);
    for (const [gu, gv] of [[0.3, 0.2], [1.5, 1.75], [2.9, 0.1], [1, 1]] as const) {
      const found = gridWarpInverse(grid, gridWarpPoint(grid, gu, gv));
      expect(found?.gu).toBeCloseTo(gu, 9);
      expect(found?.gv).toBeCloseTo(gv, 9);
    }
    expect(gridWarpInverse(grid, [0.02, 0.98])).toBeNull();
    expect(gridWarpInverse(moved(identityGrid(3, 3, false), 1, 1, [1.2, 0.5]), [0.3, 0.3])).toBeNull();
  });

  it("the plan carries each line's offset from the even spread, zero on a fresh node", () => {
    const fresh = compile({});
    for (const lane of ["lu0", "lu1", "lv0", "lv1"]) expect(fresh.pass.uniforms?.[lane]).toEqual([0, 0, 0, 0]);
    // Column 1 of a 4-column grid at u = 0.3 is 0.3 · 3 − 1 = −0.1 cells from even.
    const { pass } = compile({ columns: 4, [columnKey(1)]: 0.3 });
    expect((pass.uniforms?.["lu0"] as number[])[1]).toBeCloseTo(-0.1, 15);
    expect((pass.uniforms?.["lu0"] as number[]).filter((_, k) => k !== 1)).toEqual([0, 0, 0]);
  });
});
