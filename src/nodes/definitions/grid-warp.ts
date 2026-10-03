import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { ParameterSchema, VectorParameter } from "../../domain/types/parameters.ts";
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
 * This is that job as one node, its points dragged on its own preview. Not attempted:
 * matching Stoner's own editing tools — here the surface between the points is Catmull-Rom
 * or bilinear, and the grid stops at 8 × 8. Product names stay out of `description` (the
 * copy guard, T424), so the comparison lives here.
 *
 * ## Storage: one `vector`/2 parameter per point, per grid size: `p{c}{r}_{C}x{R}`
 *
 * Every point is an ordinary parameter, declared `handle: "picture"`, so the T935 gizmo
 * drags it on the node's preview tile exactly as it drags Corner Pin's pins: one key per
 * drag, one `setParameters` patch, one undo group, autosaved, diffable, and writable by an
 * agent (`p11_3x3 = [0.4, 0.6]` moves the 3 × 3 grid's centre). A JSON blob in a `code`
 * parameter (the MIDI map's and the preset bank's storage) would have needed a second
 * gizmo kind that edits INTO a value — the existing one writes a whole parameter per key.
 *
 * The key carries the GRID SIZE because a fresh node stores every default (apply-patch's
 * `defaultParameters`): with plain `p{c}{r}` keys, going from 3 to 4 columns would read the
 * stored 3-column positions as 4-column ones — two points on the right edge, a zero-width
 * cell, a refused grid. With the size in the key, each size is its own grid: a new size
 * starts undistorted, and going back to a size brings its warp back. The set of points
 * follows Columns × Rows through `parametersFor` (§T880's per-instance schema), so the
 * inspector shows, and the tile offers handles for, exactly the current grid. Points of
 * other sizes the node stores (the default 3 × 3 ones always) stay in the schema INACTIVE
 * (§V146) — no handle, no effect — in the collapsed Advanced group, so their values keep a
 * home and validate.
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
 * - Changing Columns or Rows does NOT carry the warp's shape to the new size: the new
 *   size's grid starts undistorted. Resampling needs the size edit and the new size's
 *   points in ONE patch, and no write path makes that from a single parameter edit today
 *   (T1509b's report names the missing seam). `gridWarpPoint` is the evaluation such a
 *   resample would sample at the new size's identity points.
 */

export type Point2 = readonly [number, number];

export const GRID_WARP_MIN = 2;
export const GRID_WARP_DEFAULT = 3;

/** One parameter key per point of one grid size: column, row, then the size (the cap keeps each a digit). */
export const pointKey = (column: number, row: number, columns: number, rows: number): string =>
  `p${String(column)}${String(row)}_${String(columns)}x${String(rows)}`;
const POINT_KEY = /^p([0-7])([0-7])_([2-8])x([2-8])$/;

/** Where point (column, row) sits on an undistorted grid: the identity. y up, (0, 0) bottom left. */
export const identityPoint = (column: number, row: number, columns: number, rows: number): Point2 => [
  column / (columns - 1),
  row / (rows - 1),
];

/** A grid of control points, row-major from the bottom left: point (c, r) is `points[r * columns + c]`. */
export interface WarpGrid {
  readonly columns: number;
  readonly rows: number;
  readonly points: readonly Point2[];
  readonly smooth: boolean;
}

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
  const nu = (grid.columns - 1) * S + 1;
  const nv = (grid.rows - 1) * S + 1;
  const lattice: Point2[] = [];
  for (let b = 0; b < nv; b += 1) for (let a = 0; a < nu; a += 1) lattice.push(gridWarpPoint(grid, a / S, b / S));
  const at = (a: number, b: number): Point2 => lattice[b * nu + a] as Point2;

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
  description: `How many control points ${what}, ${String(GRID_WARP_MIN)} to ${String(GRID_WARP_MAX)}. Each grid size keeps its own points: a new size starts undistorted, and going back to a size brings its warp back.`,
});

function pointParameter(column: number, row: number, columns: number, rows: number, current: boolean): VectorParameter {
  const size = `${String(columns)} × ${String(rows)}`;
  const name = `Point ${String(column + 1)},${String(row + 1)}`;
  return {
    type: "vector",
    size: 2,
    label: current ? name : `${name} (${size})`,
    default: identityPoint(column, row, columns, rows),
    // Soft past both ends, as Corner Pin's pins: a point beyond the frame is overscan.
    min: -1,
    max: 2,
    range: "soft",
    // T1512b's collapsed group: another size's points are kept, not shown first.
    group: current ? "Points" : "Advanced",
    description: `Where the ${size} grid's point in column ${String(column + 1)} (from the left), row ${String(row + 1)} (from the bottom) lands, 0..1 with (0, 0) at the bottom left.`,
    handle: "picture",
    ...(current
      ? {}
      : { inactiveWhen: () => `A point of the ${size} grid: it applies when Columns × Rows is ${size}.` }),
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

/** The current grid's point parameters, plus any other size's point `keys`, kept inactive (no handle). */
function pointParameters(columns: number, rows: number, keys: Iterable<string>): Record<string, VectorParameter> {
  const schema: Record<string, VectorParameter> = {};
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      schema[pointKey(column, row, columns, rows)] = pointParameter(column, row, columns, rows, true);
    }
  }
  for (const key of keys) {
    const match = POINT_KEY.exec(key);
    if (match === null || key in schema) continue;
    const [column, row, ofColumns, ofRows] = match.slice(1).map(Number) as [number, number, number, number];
    if (column >= ofColumns || row >= ofRows) continue;
    schema[key] = pointParameter(column, row, ofColumns, ofRows, false);
  }
  return schema;
}

const DEFAULT_POINT_KEYS = Object.keys(pointParameters(GRID_WARP_DEFAULT, GRID_WARP_DEFAULT, []));

/** A stored grid size: the document's static value (a driven one has no answer at schema time). */
function storedGridSize(stored: Readonly<Record<string, unknown>>, key: string): number {
  const value = storedStaticValue(stored[key] as Parameters<typeof storedStaticValue>[0]);
  return clampGridSize(typeof value === "number" ? value : GRID_WARP_DEFAULT);
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

export const gridWarpNode: NodeDefinition = {
  type: "gridWarp",
  version: 1,
  title: "Grid Warp",
  category: "filter",
  description:
    "Warps the image through a grid of control points, to map it onto a curved or irregular surface: drag each point to where that part of the picture must land, and the picture follows a smooth (or bilinear) surface between them. Up to 8 × 8 points, each grid size keeping its own; outside the grid is transparent, and a folded grid renders nothing and says where. Drag the points on the node's own preview.",
  tags: ["mapping", "projection", "warp", "mesh warp", "grid warp", "curved surface"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: { ...STATIC_PARAMETERS, ...pointParameters(GRID_WARP_DEFAULT, GRID_WARP_DEFAULT, []) },
  /**
   * PER-INSTANCE schema (§T880): one point parameter per grid point. Composed from the
   * hoisted static block, never from `gridWarpNode.parameters` (osc.ts's shape).
   */
  parametersFor(stored) {
    const columns = storedGridSize(stored, "columns");
    const rows = storedGridSize(stored, "rows");
    return { ...STATIC_PARAMETERS, ...pointParameters(columns, rows, [...DEFAULT_POINT_KEYS, ...Object.keys(stored)]) };
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
    const points: Point2[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const fallback = identityPoint(column, row, columns, rows);
        points.push(readVector(parameters, pointKey(column, row, columns, rows), fallback) as unknown as Point2);
      }
    }
    const smooth = readEnumIndex(parameters, "interpolation", INTERPOLATION_OPTIONS, "smooth") === 1;
    const grid: WarpGrid = { columns, rows, points, smooth };
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
