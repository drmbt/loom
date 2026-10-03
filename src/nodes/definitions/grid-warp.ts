import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { ParameterSchema, StoredParameter, VectorParameter } from "../../domain/types/parameters.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readEnumIndex, readNumber, readVector } from "./parameter-readers.ts";
import {
  GRID_WARP_MAX,
  GRID_WARP_SUBDIVISIONS,
  GRID_WARP_VERTEX_COUNT,
  GRID_WARP_WGSL,
} from "../shaders/grid-warp.wgsl.ts";

/**
 * Grid Warp — mapping onto a CURVED or IRREGULAR surface (T1509b), the next mapping node
 * after Corner Pin (T1491b).
 *
 * Corner Pin is exact for a flat surface seen in perspective, and only for that. A column,
 * a dome, a draped cloth or a wall with a step in it is not one plane, so no single
 * homography fits it. A grid of control points does: each point is dragged to where that
 * part of the picture must land, and the picture between the points follows a smooth (or
 * piecewise bilinear) surface through them.
 *
 * PARITY: TouchDesigner has no grid-warp TOP. The job is done there by the palette's Stoner
 * component — a grid of draggable points warping a texture, built from several operators.
 * This is that job as one node, its points dragged on its own preview, with Stoner's Add /
 * Delete Row and Column (T1534b; MadMapper's Alt-click and Remove Horizontal / Vertical).
 * Not attempted: the rest of Stoner's editing tools — here the surface between the points
 * is Catmull-Rom or bilinear, and the grid stops at 8 × 8. Product names stay out of `description` (the
 * copy guard, T424), so the comparison lives here.
 *
 * ## Storage: one `vector`/2 parameter per point of the CURRENT grid: `p{c}{r}`
 *
 * Every point is an ordinary parameter, declared `handle: "picture"`, so the T935 gizmo
 * drags it on the node's preview tile exactly as it drags Corner Pin's pins: one key per
 * drag, one `setParameters` patch, one undo group, autosaved, diffable, and writable by an
 * agent (`p11 = [0.4, 0.6]` moves a 3 × 3 grid's centre). A JSON blob in a `code`
 * parameter (the MIDI map's and the preset bank's storage) would have needed a second
 * gizmo kind that edits INTO a value — the existing one writes a whole parameter per key.
 * The set of points follows Columns × Rows through `parametersFor` (§T880's per-instance
 * schema), so the inspector shows, and the tile offers handles for, exactly the current grid.
 *
 * ## Changing Columns or Rows RESAMPLES the warp (T1532b)
 *
 * The mapping workflow is: fit the corners at 2 × 2, then go to 3 × 3 or 4 × 4 to bend the
 * middle. So a size change keeps the picture where it is: the new grid's points are the
 * CURRENT surface (`gridWarpPoint`, with the current Interpolation) evaluated at the new
 * grid's identity points, and points the new grid does not have are deleted — nothing of
 * another size stays stored (T1509b kept each size's points; no mapping tool does, and the
 * owner ruled them out). A point both grids share keeps its value exactly; an affine grid
 * resamples to the same affine grid, so the picture does not move at all.
 *
 * That is a write to many keys from one edit of Columns, so it is `coupledParameters`, the
 * hook `graph.applyPatch` applies inside the `setParameters` operation: the inspector, the
 * agent's `set_parameters`, a preset recall and a paste onto the node all get it, and one
 * undo restores the old size and its points together. An edit that names points too (a
 * preset holding a 4 × 4 grid) has its own points win over the resampled ones.
 *
 * A DRIVEN size (an expression on Columns) cannot rewrite the document every frame, so the
 * compile does the same resample: the stored points are the grid the schema declares (the
 * static size), and a resolved size that differs samples that surface at its own identity
 * points. The compile sees resolved values only, so it reads the stored grid's size off
 * the point keys it was handed — every key of the static grid, the resolver's contract.
 *
 * ## Each grid line also says WHERE IN THE PICTURE it sits (T1534b)
 *
 * A row or column can be inserted at a clicked point, and deleted, and neither may move the
 * picture. On a grid whose lines are evenly spread over the picture that is impossible:
 * inserting a column a quarter of the way across a 3-column grid would re-spread the picture
 * over four even columns, sliding everything the user had pinned. So every column carries
 * its picture position `u{c}` and every row `v{r}` (Advanced, 0..1, evenly spread by
 * default, so a grid nobody inserted into is exactly the T1509b grid), and the picture
 * coordinate between lines is interpolated from them with the SAME weights as the points
 * (`gridWarpSource`). Same weights is what keeps an affine grid affine after an insert, under
 * either interpolation: output and picture coordinate are one affine function of each other
 * at every control point, and an affine combination of them preserves that.
 *
 *  - INSERT (`insertGridLine`): the new line's points are the current surface at the clicked
 *    grid coordinate, and its picture position is the current one there. Every other point
 *    and line keeps its value bit for bit. Under Linear the drawn map is then unchanged
 *    everywhere (a bilinear cell split along a line is two bilinear cells); under Smooth it
 *    is unchanged on every line and moves slightly between them, since the spline now
 *    passes through more points.
 *  - DELETE (`deleteGridLine`): the line goes, every other point and line keeps its value,
 *    and the surface between re-forms. Deleting an EDGE line crops the picture to the next
 *    line's position rather than stretching it back over the new edge: the picture stays
 *    where it was pinned. The edge's position is an Advanced field to set back by hand.
 *
 * Both are one write of the size, every point and every line position: the
 * `gridWarp.insertLine` / `gridWarp.deleteLine` commands (`domain/commands/grid-warp-commands.ts`).
 *
 * ## The cap is 8 × 8
 *
 * 64 points is 32 flat `vec4f` uniform members (the plan cannot fill a uniform array) and a
 * 75 270-vertex mesh, both fine; it is the HANDLES that stop scaling: 64 handles on a
 * preview tile are a few pixels apart, and 64 inspector rows are already a list nobody
 * reads. A warp finer than that is a picture of where every pixel goes, which is Remap's
 * job (a UV map input), not a grid's. The minimum is 2 × 2: the four corners, warped
 * bilinearly.
 *
 * ## The warp is DRAWN, so its inverse is exact (`grid-warp.wgsl.ts`)
 *
 * Each cell is drawn as 16 × 16 sub-quads whose vertices sit on the chosen interpolation,
 * and the rasteriser carries each vertex's undistorted coordinate to every pixel. So the
 * per-pixel inverse is exact for the piecewise-linear mesh (up to the rasteriser's
 * sub-pixel vertex snap, measured at ≤ 6e-5 of the surface on a 64-pixel target and
 * smaller in proportion on a larger one), and the mesh converges on the smooth
 * surface with the square of the subdivision (a bilinear cell's sub-triangles miss it by at
 * most a quarter of the cell's twist over 16², ~1/1000 of it). An AFFINE grid — every
 * Corner Pin parallelogram — is reproduced exactly, and every control point maps exactly to
 * its own picture point.
 *
 * ## A folded grid renders nothing, and says where
 *
 * Drag a point past its neighbour and the cell turns inside out: two parts of the picture
 * claim the same output pixels and neither is "the" picture. The same goes for a grid
 * whose outline crosses itself. Both are refused, by the mesh that would be drawn (the same
 * formulas, evaluated here): every triangle must turn the same way — either way, so a
 * mirrored grid for rear projection is fine — and the outline must not cross itself. A
 * refused grid renders transparent with a `gridWarp.folded` diagnostic naming the cell.
 *
 * ## What it does not do (yet)
 *
 * - No Outside menu. Corner Pin's Hold / Repeat / Mirror continue the pinned PLANE past
 *   its quad; a mesh has no continuation past its outline, so outside is transparent.
 * - No perspective of its own. A grid is not a projective map; for the outer perspective
 *   layer chain Grid Warp → Corner Pin, and moving the corners carries the warp.
 * - A picture position out of order (a column whose `u` is left of its left neighbour's) is
 *   drawn as asked — the picture folds across the surface — and not refused: the surface
 *   itself does not fold, and the fold check is about the surface.
 */

export type Point2 = readonly [number, number];

export const GRID_WARP_MIN = 2;
export const GRID_WARP_DEFAULT = 3;

/** One parameter key per point of the current grid: column, then row (the cap keeps each a digit). */
export const pointKey = (column: number, row: number): string => `p${String(column)}${String(row)}`;
const POINT_KEY = /^p([0-7])([0-7])$/;

/** Where point (column, row) sits on an undistorted grid: the identity. y up, (0, 0) bottom left. */
export const identityPoint = (column: number, row: number, columns: number, rows: number): Point2 => [
  column / (columns - 1),
  row / (rows - 1),
];

/** T1534b: one parameter key per grid line — where in the picture column c (`u{c}`) and row r (`v{r}`) sit. */
export const columnKey = (column: number): string => `u${String(column)}`;
export const rowKey = (row: number): string => `v${String(row)}`;
const LINE_KEY = /^[uv]([0-7])$/;

/** A point key's column and row, or null for any other key. */
export function parsePointKey(key: string): { readonly column: number; readonly row: number } | null {
  const match = POINT_KEY.exec(key);
  return match === null ? null : { column: Number(match[1]), row: Number(match[2]) };
}

/**
 * A grid of control points, row-major from the bottom left: point (c, r) is `points[r * columns + c]`.
 * `us` / `vs` are each column's and row's picture position (T1534b); absent, they are evenly
 * spread — the identity.
 */
export interface WarpGrid {
  readonly columns: number;
  readonly rows: number;
  readonly points: readonly Point2[];
  readonly smooth: boolean;
  readonly us?: readonly number[] | undefined;
  readonly vs?: readonly number[] | undefined;
}

/** Evenly spread picture positions for `count` lines: line k at k / (count − 1). */
export const evenLines = (count: number): number[] => Array.from({ length: count }, (_, k) => k / (count - 1));

const columnsOf = (grid: WarpGrid): readonly number[] => grid.us ?? evenLines(grid.columns);
const rowsOf = (grid: WarpGrid): readonly number[] => grid.vs ?? evenLines(grid.rows);

/** A grid size from any number: rounded, then clamped to 2..8. */
export const clampGridSize = (value: number): number =>
  Math.min(GRID_WARP_MAX, Math.max(GRID_WARP_MIN, Math.round(Number.isFinite(value) ? value : GRID_WARP_DEFAULT)));

/**
 * Control point (i, j) for any i in -1..columns, j in -1..rows: past an edge the grid is
 * continued in a straight line, so Catmull-Rom keeps a straight grid straight and the
 * identity grid is the identity. The shader's `control()`.
 */
function control(grid: WarpGrid, i: number, j: number): Point2 {
  const { columns, rows, points } = grid;
  const stored = (c: number, r: number): Point2 => points[r * columns + c] as Point2;
  const alongColumns = (c: number, r: number): Point2 => {
    if (c < 0) return extend(stored(0, r), stored(1, r));
    if (c > columns - 1) return extend(stored(columns - 1, r), stored(columns - 2, r));
    return stored(c, r);
  };
  if (j < 0) return extend(alongColumns(i, 0), alongColumns(i, 1));
  if (j > rows - 1) return extend(alongColumns(i, rows - 1), alongColumns(i, rows - 2));
  return alongColumns(i, j);
}

/** `edge` continued one step away from `inner`: 2·edge − inner. */
const extend = (edge: Point2, inner: Point2): Point2 => [2 * edge[0] - inner[0], 2 * edge[1] - inner[1]];

const catmullRom = (t: number): readonly [number, number, number, number] => {
  const t2 = t * t;
  const t3 = t2 * t;
  return [0.5 * (-t + 2 * t2 - t3), 0.5 * (2 - 5 * t2 + 3 * t3), 0.5 * (t + 4 * t2 - 3 * t3), 0.5 * (t3 - t2)];
};

/**
 * THE FORWARD MAP: where grid coordinate (gu, gv) — 0..columns-1 by 0..rows-1, so control
 * point (c, r) is at (c, r) — lands on the output. Bilinear within the cell, or the tensor
 * Catmull-Rom spline through the points. Both pass through every control point. The
 * shader's `warp()`, in f64.
 */
export function gridWarpPoint(grid: WarpGrid, gu: number, gv: number): Point2 {
  const i = Math.min(Math.floor(gu), grid.columns - 2);
  const j = Math.min(Math.floor(gv), grid.rows - 2);
  const t = gu - i;
  const s = gv - j;
  if (!grid.smooth) {
    const mix = (a: Point2, b: Point2, w: number): Point2 => [a[0] * (1 - w) + b[0] * w, a[1] * (1 - w) + b[1] * w];
    const bottom = mix(control(grid, i, j), control(grid, i + 1, j), t);
    const top = mix(control(grid, i, j + 1), control(grid, i + 1, j + 1), t);
    return mix(bottom, top, s);
  }
  const wu = catmullRom(t);
  const wv = catmullRom(s);
  let x = 0;
  let y = 0;
  for (let b = 0; b < 4; b += 1) {
    for (let a = 0; a < 4; a += 1) {
      const point = control(grid, i - 1 + a, j - 1 + b);
      const weight = (wu[a] as number) * (wv[b] as number);
      x += weight * point[0];
      y += weight * point[1];
    }
  }
  return [x, y];
}

/**
 * One line position at grid coordinate g along its axis, with the forward map's own weights
 * (and its straight continuation past each end), so position and point stay one map (T1534b).
 */
function alongLines(lines: readonly number[], g: number, smooth: boolean): number {
  const n = lines.length;
  const at = (k: number): number =>
    k < 0
      ? 2 * (lines[0] as number) - (lines[1] as number)
      : k > n - 1
        ? 2 * (lines[n - 1] as number) - (lines[n - 2] as number)
        : (lines[k] as number);
  const i = Math.min(Math.floor(g), n - 2);
  const t = g - i;
  if (!smooth) return at(i) * (1 - t) + at(i + 1) * t;
  const w = catmullRom(t);
  return w[0] * at(i - 1) + w[1] * at(i) + w[2] * at(i + 1) + w[3] * at(i + 2);
}

/**
 * T1534b — WHICH PICTURE POINT grid coordinate (gu, gv) shows: the line positions
 * interpolated as the points are. On an evenly spread grid, (gu / (columns − 1), gv / (rows − 1)).
 * The shader's `st`.
 */
export function gridWarpSource(grid: WarpGrid, gu: number, gv: number): Point2 {
  return [alongLines(columnsOf(grid), gu, grid.smooth), alongLines(rowsOf(grid), gv, grid.smooth)];
}

/**
 * T1532b: `grid` RESAMPLED onto a columns × rows grid — each new point is the current
 * surface at that point's identity position, so the picture does not move. The grid
 * coordinate is computed as (c · (old − 1)) / (new − 1), exact wherever the two grids share
 * a point, and the forward map's weights there are exactly 0 and 1: shared points keep
 * their values bit for bit.
 */
export function resampleGrid(grid: WarpGrid, columns: number, rows: number): WarpGrid {
  const points: Point2[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push(gridWarpPoint(grid, (column * (grid.columns - 1)) / (columns - 1), (row * (grid.rows - 1)) / (rows - 1)));
    }
  }
  // T1534b: and each new line's picture position is the old one there, so the picture stays put.
  const us = evenLines(columns).map((_, column) => alongLines(columnsOf(grid), (column * (grid.columns - 1)) / (columns - 1), grid.smooth));
  const vs = evenLines(rows).map((_, row) => alongLines(rowsOf(grid), (row * (grid.rows - 1)) / (rows - 1), grid.smooth));
  return { columns, rows, points, smooth: grid.smooth, us, vs };
}

export type GridAxis = "column" | "row";

/** Why a line edit cannot be made: a diagnostic code and a sentence (T1534b). */
export interface GridLineRefusal {
  readonly code: string;
  readonly reason: string;
}

export type GridLineEdit = { readonly ok: true; readonly grid: WarpGrid } | ({ readonly ok: false } & GridLineRefusal);

/** Columns become rows: point (c, r) moves to (r, c), and the line positions swap. */
function transpose(grid: WarpGrid): WarpGrid {
  const points: Point2[] = [];
  for (let column = 0; column < grid.columns; column += 1) {
    for (let row = 0; row < grid.rows; row += 1) points.push(grid.points[row * grid.columns + column] as Point2);
  }
  return { columns: grid.rows, rows: grid.columns, points, smooth: grid.smooth, us: rowsOf(grid), vs: columnsOf(grid) };
}

/** Closer than this to an existing line (in cells), an insert is refused: it would be that line. */
const LINE_EPSILON = 1e-3;

/**
 * T1534b — `grid` with a new column (or row) at `at`, 0..1 along the surface as the grid lies
 * (0 the first line, 1 the last; on an evenly spread grid, the picture's own u or v). The new
 * line's points are the CURRENT surface there and its picture position the current one;
 * every other point and line keeps its value exactly. Refused at 8 lines, outside the
 * surface, and on top of an existing line.
 */
export function insertGridLine(grid: WarpGrid, axis: GridAxis, at: number): GridLineEdit {
  if (axis === "row") {
    const edit = insertGridLine(transpose(grid), "column", at);
    return edit.ok ? { ok: true, grid: transpose(edit.grid) } : { ...edit, reason: edit.reason.replaceAll("column", "row") };
  }
  if (grid.columns >= GRID_WARP_MAX) {
    return { ok: false, code: "gridWarp.line.max", reason: `the grid already has ${String(GRID_WARP_MAX)} columns, the most it can have` };
  }
  if (!(Number.isFinite(at) && at > 0 && at < 1)) {
    return { ok: false, code: "gridWarp.line.outside", reason: `a new column must lie inside the surface (0 < at < 1), not at ${String(at)}` };
  }
  const g = at * (grid.columns - 1);
  const cell = Math.min(Math.floor(g), grid.columns - 2);
  const t = g - cell;
  if (t < LINE_EPSILON || t > 1 - LINE_EPSILON) {
    return { ok: false, code: "gridWarp.line.exists", reason: `column ${String(t < 0.5 ? cell + 1 : cell + 2)} is already there` };
  }
  const columns = grid.columns + 1;
  const points: Point2[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (column === cell + 1) points.push(gridWarpPoint(grid, g, row));
      else points.push(grid.points[row * grid.columns + (column <= cell ? column : column - 1)] as Point2);
    }
  }
  const lines = columnsOf(grid);
  const us = [...lines.slice(0, cell + 1), alongLines(lines, g, grid.smooth), ...lines.slice(cell + 1)];
  return { ok: true, grid: { columns, rows: grid.rows, points, smooth: grid.smooth, us, vs: rowsOf(grid) } };
}

/**
 * T1534b — `grid` without column (or row) `index`. Every other point and line keeps its value
 * exactly; the surface between re-forms. Refused at 2 lines and for an index the grid lacks.
 */
export function deleteGridLine(grid: WarpGrid, axis: GridAxis, index: number): GridLineEdit {
  if (axis === "row") {
    const edit = deleteGridLine(transpose(grid), "column", index);
    return edit.ok ? { ok: true, grid: transpose(edit.grid) } : { ...edit, reason: edit.reason.replaceAll("column", "row") };
  }
  if (!(Number.isInteger(index) && index >= 0 && index < grid.columns)) {
    return { ok: false, code: "gridWarp.line.missing", reason: `the grid has no column ${String(index + 1)}; it has ${String(grid.columns)}` };
  }
  if (grid.columns <= GRID_WARP_MIN) {
    return { ok: false, code: "gridWarp.line.min", reason: `the grid has ${String(GRID_WARP_MIN)} columns, the fewest it can have` };
  }
  const points = grid.points.filter((_, k) => k % grid.columns !== index);
  const us = columnsOf(grid).filter((_, k) => k !== index);
  return { ok: true, grid: { columns: grid.columns - 1, rows: grid.rows, points, smooth: grid.smooth, us, vs: rowsOf(grid) } };
}

/** Below this a sub-triangle's turn counts as none: a guard against an exact zero, as in Corner Pin. */
const TURN_EPSILON = 1e-12;

const cross = (o: Point2, a: Point2, b: Point2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * Why a grid cannot be drawn as one picture, or null when it can — judged on the MESH the
 * shader draws (every vertex of every sub-quad), so the verdict is about the pixels:
 *
 *  - a non-finite point;
 *  - a sub-triangle that turns the other way from the rest, or not at all: that cell is
 *    folded (or flattened) and two parts of the picture would claim one place;
 *  - an outline that crosses itself: every cell is fine, and still the grid lies over
 *    itself somewhere.
 *
 * Consistent turning plus a simple outline is exactly a one-to-one map (a local
 * homeomorphism whose boundary winds once), so nothing else can double a pixel.
 */
export function gridFold(grid: WarpGrid): { readonly reason: string; readonly cell?: readonly [number, number] } | null {
  if (grid.points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    return { reason: "a point is not a finite number" };
  }
  const S = GRID_WARP_SUBDIVISIONS;
  const { nu, nv, at } = meshLattice(grid);

  // The shader's two triangles per sub-quad, in its corner order.
  const turns: Array<{ readonly turn: number; readonly cell: readonly [number, number] }> = [];
  let total = 0;
  for (let b = 0; b < nv - 1; b += 1) {
    for (let a = 0; a < nu - 1; a += 1) {
      const cell = [Math.floor(a / S), Math.floor(b / S)] as const;
      for (const turn of [cross(at(a, b), at(a + 1, b), at(a, b + 1)), cross(at(a, b + 1), at(a + 1, b), at(a + 1, b + 1))]) {
        turns.push({ turn, cell });
        total += turn;
      }
    }
  }
  const sign = total >= 0 ? 1 : -1;
  const bad = turns.find(({ turn }) => turn * sign <= TURN_EPSILON);
  if (bad !== undefined) return { reason: "it folds over itself (a point is past its neighbour)", cell: bad.cell };

  // The outline, once round: bottom row, right column, top row back, left column down.
  const outline: Point2[] = [];
  for (let a = 0; a < nu - 1; a += 1) outline.push(at(a, 0));
  for (let b = 0; b < nv - 1; b += 1) outline.push(at(nu - 1, b));
  for (let a = nu - 1; a > 0; a -= 1) outline.push(at(a, nv - 1));
  for (let b = nv - 1; b > 0; b -= 1) outline.push(at(0, b));
  if (outlineCrosses(outline)) return { reason: "its outline crosses itself, so the grid lies over itself" };
  return null;
}

/** The mesh the shader draws: every sub-quad vertex, placed by the forward map. Vertex (a, b) sits at grid coordinate (a / 16, b / 16). */
function meshLattice(grid: WarpGrid): { readonly nu: number; readonly nv: number; readonly at: (a: number, b: number) => Point2 } {
  const S = GRID_WARP_SUBDIVISIONS;
  const nu = (grid.columns - 1) * S + 1;
  const nv = (grid.rows - 1) * S + 1;
  const lattice: Point2[] = [];
  for (let b = 0; b < nv; b += 1) for (let a = 0; a < nu; a += 1) lattice.push(gridWarpPoint(grid, a / S, b / S));
  return { nu, nv, at: (a, b) => lattice[b * nu + a] as Point2 };
}

/** Within this of a triangle's edge (in barycentric weight), a point counts as inside it. */
const INSIDE_EPSILON = 1e-9;

/**
 * T1534b — THE GRID COORDINATE UNDER OUTPUT POINT `point`, or null where nothing is drawn
 * (outside the surface, or a folded grid, which draws nothing). The inverse of the DRAWN
 * mesh, exactly: the triangle holding the point, by the same triangulation the shader draws,
 * and the grid coordinate interpolated across it as the rasteriser interpolates `st`. A
 * click in output space lands on the line it looks like it lands on.
 */
export function gridWarpInverse(grid: WarpGrid, point: Point2): { readonly gu: number; readonly gv: number } | null {
  if (cachedGridFold(grid) !== null) return null;
  const S = GRID_WARP_SUBDIVISIONS;
  const { nu, nv, at } = meshLattice(grid);
  for (let b = 0; b < nv - 1; b += 1) {
    for (let a = 0; a < nu - 1; a += 1) {
      const corners: ReadonlyArray<readonly [number, number]> = [[a, b], [a + 1, b], [a, b + 1], [a, b + 1], [a + 1, b], [a + 1, b + 1]];
      for (let k = 0; k < 6; k += 3) {
        const [i, j, l] = [corners[k], corners[k + 1], corners[k + 2]] as [readonly [number, number], readonly [number, number], readonly [number, number]];
        const p0 = at(i[0], i[1]);
        const p1 = at(j[0], j[1]);
        const p2 = at(l[0], l[1]);
        const det = cross(p0, p1, p2);
        if (det === 0) continue;
        const w1 = cross(p0, point, p2) / det;
        const w2 = cross(p0, p1, point) / det;
        const w0 = 1 - w1 - w2;
        if (w0 < -INSIDE_EPSILON || w1 < -INSIDE_EPSILON || w2 < -INSIDE_EPSILON) continue;
        return {
          gu: (w0 * i[0] + w1 * j[0] + w2 * l[0]) / S,
          gv: (w0 * i[1] + w1 * j[1] + w2 * l[1]) / S,
        };
      }
    }
  }
  return null;
}

/** True when two non-adjacent edges of the closed polygon properly cross. */
function outlineCrosses(polygon: readonly Point2[]): boolean {
  const n = polygon.length;
  const edges = polygon.map((start, index) => {
    const end = polygon[(index + 1) % n] as Point2;
    return {
      start,
      end,
      minX: Math.min(start[0], end[0]),
      maxX: Math.max(start[0], end[0]),
      minY: Math.min(start[1], end[1]),
      maxY: Math.max(start[1], end[1]),
    };
  });
  for (let i = 0; i < n; i += 1) {
    const e = edges[i] as (typeof edges)[number];
    for (let k = i + 2; k < n; k += 1) {
      if (i === 0 && k === n - 1) continue;
      const f = edges[k] as (typeof edges)[number];
      if (f.minX > e.maxX || f.maxX < e.minX || f.minY > e.maxY || f.maxY < e.minY) continue;
      const d1 = cross(e.start, e.end, f.start);
      const d2 = cross(e.start, e.end, f.end);
      const d3 = cross(f.start, f.end, e.start);
      const d4 = cross(f.start, f.end, e.end);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/**
 * `gridFold` is a few tens of thousands of products for the largest grid, and a node
 * compiles whenever the plan does. The verdict is a pure function of the grid, so the last
 * few are kept; a drag produces a new key per frame and evicts the oldest.
 */
const FOLD_CACHE_LIMIT = 8;
const foldCache = new Map<string, ReturnType<typeof gridFold>>();

function cachedGridFold(grid: WarpGrid): ReturnType<typeof gridFold> {
  const key = JSON.stringify(grid);
  const hit = foldCache.get(key);
  if (hit !== undefined || foldCache.has(key)) return hit ?? null;
  const verdict = gridFold(grid);
  foldCache.set(key, verdict);
  if (foldCache.size > FOLD_CACHE_LIMIT) {
    const oldest = foldCache.keys().next();
    if (oldest.done !== true) foldCache.delete(oldest.value);
  }
  return verdict;
}

export const INTERPOLATION_OPTIONS = [
  { value: "linear", label: "Linear" },
  { value: "smooth", label: "Smooth" },
] as const;

const gridSizeParameter = (label: string, what: string): ParameterSchema[string] => ({
  type: "number",
  label,
  default: GRID_WARP_DEFAULT,
  min: GRID_WARP_MIN,
  max: GRID_WARP_MAX,
  range: "bounded",
  step: 1,
  group: "Grid",
  description: `How many control points ${what}, ${String(GRID_WARP_MIN)} to ${String(GRID_WARP_MAX)}. Changing it keeps the warp: the new grid's points are placed on the current surface, so the picture stays where it is.`,
});

function pointParameter(column: number, row: number, columns: number, rows: number): VectorParameter {
  return {
    type: "vector",
    size: 2,
    label: `Point ${String(column + 1)},${String(row + 1)}`,
    default: identityPoint(column, row, columns, rows),
    // Soft past both ends, as Corner Pin's pins: a point beyond the frame is overscan.
    min: -1,
    max: 2,
    range: "soft",
    group: "Points",
    description: `Where the grid's point in column ${String(column + 1)} (from the left), row ${String(row + 1)} (from the bottom) lands, 0..1 with (0, 0) at the bottom left.`,
    handle: "picture",
  };
}

const STATIC_PARAMETERS: ParameterSchema = {
  columns: gridSizeParameter("Columns", "across"),
  rows: gridSizeParameter("Rows", "up"),
  interpolation: {
    type: "enum",
    label: "Interpolation",
    default: "smooth",
    options: [...INTERPOLATION_OPTIONS],
    group: "Grid",
    description:
      "How the picture bends between the points: Smooth runs a Catmull-Rom surface through them (no creases at the points), Linear warps each cell bilinearly (straight cell edges, a crease at every point).",
  },
  feather: {
    type: "number",
    label: "Edge Feather",
    default: 0,
    min: 0,
    max: 0.5,
    range: "bounded",
    description:
      "Softens the warped picture's edges, as a fraction of its width and height measured along the surface. 0 is a hard edge.",
  },
};

/** T1534b: where in the picture one grid line sits — evenly spread by default, moved only by an insert or a delete. */
function lineParameter(axis: GridAxis, index: number, count: number): ParameterSchema[string] {
  const [label, across] = axis === "column" ? [`Column ${String(index + 1)} u`, "from the left"] : [`Row ${String(index + 1)} v`, "from the bottom"];
  return {
    type: "number",
    label,
    default: index / (count - 1),
    min: 0,
    max: 1,
    range: "bounded",
    group: "Advanced",
    description: `Which part of the picture the grid's ${axis} ${String(index + 1)} carries, 0..1 ${across}. Evenly spread unless a ${axis} was inserted or deleted, which keeps the picture where it was.`,
  };
}

/** One point parameter per point of a columns × rows grid (the identity), then each line's picture position (evenly spread). */
function pointParameters(columns: number, rows: number): ParameterSchema {
  const schema: ParameterSchema = {};
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) schema[pointKey(column, row)] = pointParameter(column, row, columns, rows);
  }
  for (let column = 0; column < columns; column += 1) schema[columnKey(column)] = lineParameter("column", column, columns);
  for (let row = 0; row < rows; row += 1) schema[rowKey(row)] = lineParameter("row", row, rows);
  return schema;
}

/** A stored grid size: the document's static value (a driven one has no answer at schema time). */
function storedGridSize(stored: Readonly<Record<string, unknown>>, key: string): number {
  const value = storedStaticValue(stored[key] as Parameters<typeof storedStaticValue>[0]);
  return clampGridSize(typeof value === "number" ? value : GRID_WARP_DEFAULT);
}

/** A point's value, or the identity when it is missing or not two finite numbers. */
function pointValue(value: unknown, column: number, row: number, columns: number, rows: number): Point2 {
  if (Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return [value[0] as number, value[1] as number];
  }
  return identityPoint(column, row, columns, rows);
}

/** A line position's value, or the even spread's when it is missing or not a finite number. */
function lineValue(value: unknown, index: number, count: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : index / (count - 1);
}

/**
 * The grid a node's parameters describe: its static size, interpolation, points and line
 * positions (T1532b, T1534b). Takes stored parameters or resolved values alike (a bare value
 * is its own static value).
 */
export function gridOf(stored: Readonly<Record<string, StoredParameter>>): WarpGrid {
  const columns = storedGridSize(stored, "columns");
  const rows = storedGridSize(stored, "rows");
  const points: Point2[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push(pointValue(storedStaticValue(stored[pointKey(column, row)]), column, row, columns, rows));
    }
  }
  const us = evenLines(columns).map((_, column) => lineValue(storedStaticValue(stored[columnKey(column)]), column, columns));
  const vs = evenLines(rows).map((_, row) => lineValue(storedStaticValue(stored[rowKey(row)]), row, rows));
  return { columns, rows, points, smooth: storedStaticValue(stored["interpolation"]) !== "linear", us, vs };
}

/** T1534b: every point and line position of `grid`, keyed as the node stores them. */
export function gridPointWrites(grid: WarpGrid): Record<string, StoredParameter> {
  const writes: Record<string, StoredParameter> = {};
  grid.points.forEach((point, index) => {
    writes[pointKey(index % grid.columns, Math.floor(index / grid.columns))] = [point[0], point[1]];
  });
  columnsOf(grid).forEach((u, column) => {
    writes[columnKey(column)] = u;
  });
  rowsOf(grid).forEach((v, row) => {
    writes[rowKey(row)] = v;
  });
  return writes;
}

/** True for a key that belongs to one point or line of the grid (a component slot `p11.x` included), and its column/row. */
function gridKeyPlace(key: string): { readonly column?: number; readonly row?: number } | null {
  const base = key.split(".")[0] ?? "";
  const point = POINT_KEY.exec(base);
  if (point !== null) return { column: Number(point[1]), row: Number(point[2]) };
  const line = LINE_KEY.exec(base);
  if (line === null) return null;
  return base.startsWith("u") ? { column: Number(line[1]) } : { row: Number(line[1]) };
}

/** Every stored key of a point or line the columns × rows grid does not have — component slots included. */
export function keysPastGrid(stored: Readonly<Record<string, unknown>>, columns: number, rows: number): string[] {
  return Object.keys(stored).filter((key) => {
    const place = gridKeyPlace(key);
    return place !== null && ((place.column ?? 0) >= columns || (place.row ?? 0) >= rows);
  });
}

/** True for a key that is one of the grid's points or line positions (or a component slot of one). */
export const isGridKey = (key: string): boolean => gridKeyPlace(key) !== null;

/**
 * The size of the grid whose points the compile was handed: one past the highest column and
 * row among the point keys (the resolver hands over every key of the static grid), or null
 * when there are none.
 */
function handedGridSize(parameters: Readonly<Record<string, unknown>>): { readonly columns: number; readonly rows: number } | null {
  let columns = 0;
  let rows = 0;
  for (const key of Object.keys(parameters)) {
    const match = POINT_KEY.exec(key);
    if (match === null) continue;
    columns = Math.max(columns, Number(match[1]) + 1);
    rows = Math.max(rows, Number(match[2]) + 1);
  }
  return columns >= GRID_WARP_MIN && rows >= GRID_WARP_MIN ? { columns, rows } : null;
}

/** Two points per `vec4f`, point k = row × 8 + column (the shader's `stored()`). */
function packPoints(grid: WarpGrid): Record<string, number[]> {
  const lanes = new Array<number>(GRID_WARP_MAX * GRID_WARP_MAX * 2).fill(0);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const [x, y] = grid.points[row * grid.columns + column] as Point2;
      const k = row * GRID_WARP_MAX + column;
      lanes[k * 2] = x;
      lanes[k * 2 + 1] = y;
    }
  }
  const members: Record<string, number[]> = {};
  for (let index = 0; index < lanes.length / 4; index += 1) members[`g${String(index)}`] = lanes.slice(index * 4, index * 4 + 4);
  return members;
}

/** Below this (in cells) a line's offset from the even spread is none: f64 noise from a resample, not a moved line. */
const LINE_OFFSET_EPSILON = 1e-9;

/**
 * T1534b — the line positions as the shader takes them: each line's OFFSET from the even
 * spread, in cells (u·(columns − 1) − c), eight per axis in two `vec4f`s (`lu0`, `lu1`,
 * `lv0`, `lv1`). An offset rather than the position, so an evenly spread grid hands the
 * shader exact zeros and its `st` is `gu / (columns − 1)` to the bit, as before lines had
 * positions — the identity stays bit-exact on the device.
 */
function packLines(grid: WarpGrid): Record<string, number[]> {
  const offsets = (lines: readonly number[]): number[] => {
    const lanes = new Array<number>(GRID_WARP_MAX).fill(0);
    lines.forEach((value, index) => {
      const offset = value * (lines.length - 1) - index;
      lanes[index] = Math.abs(offset) < LINE_OFFSET_EPSILON ? 0 : offset;
    });
    return lanes;
  };
  const u = offsets(columnsOf(grid));
  const v = offsets(rowsOf(grid));
  return { lu0: u.slice(0, 4), lu1: u.slice(4), lv0: v.slice(0, 4), lv1: v.slice(4) };
}

export const gridWarpNode: NodeDefinition = {
  type: "gridWarp",
  version: 1,
  title: "Grid Warp",
  category: "filter",
  description:
    "Warps the image through a grid of control points, to map it onto a curved or irregular surface: drag each point to where that part of the picture must land, and the picture follows a smooth (or bilinear) surface between them. Up to 8 × 8 points; changing the grid size keeps the warp, placing the new points on the current surface. Outside the grid is transparent, and a folded grid renders nothing and says where. Drag the points on the node's own preview. For a surface also seen in perspective, follow it with a Corner Pin: moving the corners there carries the whole warp.",
  tags: ["mapping", "projection", "warp", "mesh warp", "grid warp", "curved surface"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: { ...STATIC_PARAMETERS, ...pointParameters(GRID_WARP_DEFAULT, GRID_WARP_DEFAULT) },
  /**
   * PER-INSTANCE schema (§T880): one point parameter per point of the stored grid. Composed
   * from the hoisted static block, never from `gridWarpNode.parameters` (osc.ts's shape).
   */
  parametersFor(stored) {
    return { ...STATIC_PARAMETERS, ...pointParameters(storedGridSize(stored, "columns"), storedGridSize(stored, "rows")) };
  },
  /**
   * T1532b: a size change resamples the current warp onto the new grid, in the same
   * operation: every point of the new grid is the current surface at its identity position,
   * and points the new grid lacks (and any component slot of theirs) are deleted. T1534b:
   * the line positions likewise, so the picture stays where it was pinned.
   */
  coupledParameters(stored, written) {
    if (!("columns" in written) && !("rows" in written)) return null;
    const from = gridOf(stored);
    const after = { ...stored, ...written };
    const columns = storedGridSize(after, "columns");
    const rows = storedGridSize(after, "rows");
    if (columns === from.columns && rows === from.rows) return null;
    return { set: gridPointWrites(resampleGrid(from, columns, rows)), remove: keysPastGrid(stored, columns, rows) };
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const columns = clampGridSize(readNumber(parameters, "columns", GRID_WARP_DEFAULT));
    const rows = clampGridSize(readNumber(parameters, "rows", GRID_WARP_DEFAULT));
    const smooth = readEnumIndex(parameters, "interpolation", INTERPOLATION_OPTIONS, "smooth") === 1;
    // The points are the STORED grid's; a driven size that differs samples its surface (T1532b).
    const handed = handedGridSize(parameters) ?? { columns, rows };
    const points: Point2[] = [];
    for (let row = 0; row < handed.rows; row += 1) {
      for (let column = 0; column < handed.columns; column += 1) {
        const fallback = identityPoint(column, row, handed.columns, handed.rows);
        points.push(readVector(parameters, pointKey(column, row), fallback) as unknown as Point2);
      }
    }
    const us = evenLines(handed.columns).map((even, column) => readNumber(parameters, columnKey(column), even));
    const vs = evenLines(handed.rows).map((even, row) => readNumber(parameters, rowKey(row), even));
    const stored: WarpGrid = { columns: handed.columns, rows: handed.rows, points, smooth, us, vs };
    const grid = handed.columns === columns && handed.rows === rows ? stored : resampleGrid(stored, columns, rows);
    const fold = cachedGridFold(grid);
    const where = fold?.cell === undefined ? "" : ` at the cell right of column ${String(fold.cell[0] + 1)}, above row ${String(fold.cell[1] + 1)}`;
    const diagnostics =
      fold === null
        ? []
        : [
            {
              severity: "warning" as const,
              code: "gridWarp.folded",
              message: `Grid Warp's grid cannot be drawn${where}: ${fold.reason}. The output is transparent.`,
              nodeId,
              suggestion: "Move the points back so each one stays between its neighbours, left to right and bottom to top.",
            },
          ];
    // A refused grid still renders — transparent, through the same pass — so the plan's
    // shape does not depend on where a point is dragged (Corner Pin's rule).
    const pass: DrawPassDescriptor = {
      kind: "draw",
      id: `${nodeId}:gridWarp`,
      nodeId,
      shader: GRID_WARP_WGSL,
      target,
      topology: "triangle-list",
      instances: 1,
      vertexCount: GRID_WARP_VERTEX_COUNT,
      textures: [{ binding: "inputTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniformBinding: "params",
      uniforms: {
        ...packPoints(grid),
        ...packLines(grid),
        columns,
        rows,
        spline: smooth ? 1 : 0,
        valid: fold === null ? 1 : 0,
        feather: readNumber(parameters, "feather", 0),
      },
    };
    return diagnostics.length === 0 ? { passes: [pass] } : { passes: [pass], diagnostics };
  },
};
