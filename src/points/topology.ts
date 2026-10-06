/**
 * The analytic-topology vocabulary (T302, consumed by T301).
 *
 * Topology travels on the pointset EDGE as a string (T296) because it is a CLAIM the
 * producer makes about index structure, not data: `points` (no connectivity), or
 * `grid:{cols}x{rows}` with optional wrap flags — `:wrapU` closes the column seam
 * (tube), `:wrapUV` closes both (torus). ONE parser and ONE formatter so the grammar
 * cannot fork: producers format, consumers parse, and a string neither understands is
 * an explicit `null` rather than a guessed shape.
 *
 * T1587b: a grid may be several SHEETS, `grid:{cols}x{rows}x{sheets}` — ten tubes swept
 * from ten strips, one pointset, one draw. A claim without the third number is one sheet
 * and is written without it, so no claim that shipped reads or formats differently.
 */

export interface GridTopology {
  readonly kind: "grid";
  readonly cols: number;
  readonly rows: number;
  /** Column seam closed: cell (cols-1, y) connects back to column 0 — a tube. */
  readonly wrapU: boolean;
  /** Row seam closed too: with wrapU, a torus. */
  readonly wrapV: boolean;
  /**
   * T1587b — separate sheets of `cols × rows` points, one after another in the buffer:
   * sheet `s`, row `y`, column `x` is slot `(s × rows + y) × cols + x`. `rows` and both
   * wraps are ONE sheet's, and no cell joins two sheets. Absent is one sheet.
   */
  readonly sheets?: number;
}

export interface PointsTopology {
  readonly kind: "points";
}

/**
 * T1353b — INDEXED triangles: the connectivity a decoded mesh carries. Unlike a grid it
 * is not analytic — it lives in an index buffer the producer owns, and the claim names
 * that buffer's resource id so a renderer can bind it without a naming convention
 * (§V197's rule for attributes, applied to connectivity). `triangles × 3` indices.
 */
export interface MeshTopology {
  readonly kind: "mesh";
  readonly triangles: number;
  readonly indexBuffer: string;
}

/**
 * T1586b — STRIPS: `rows` curves of `cols` slots each. Strip `j`, station `i` is slot
 * `j × cols + i`, the index a grid uses. The claim is connectivity ALONG a strip only: a
 * strip's neighbours in the buffer are other curves, not a sheet, so a surface cannot be
 * skinned over it (a grid claim for ten tentacles would draw a membrane between them).
 * `closed` joins each strip's last slot back to its first.
 *
 * A strip shorter than its slots is padded with copies of its nearest live point, and a
 * per-point `live` attribute says which slots are padding (§V788): the claim's `cols` is
 * the allocation, never a count.
 */
export interface StripsTopology {
  readonly kind: "strips";
  /** Slots per strip. */
  readonly cols: number;
  /** Strips. */
  readonly rows: number;
  readonly closed: boolean;
}

export type PointTopology = GridTopology | PointsTopology | MeshTopology | StripsTopology;

const GRID = /^grid:(\d+)x(\d+)(?:x(\d+))?(?::(wrapU|wrapV|wrapUV))?$/;
const MESH = /^mesh:(\d+)@(.+)$/;
const STRIPS = /^strips:(\d+)x(\d+)(?::(closed))?$/;

export function parseTopology(value: string | undefined): PointTopology | null {
  if (value === undefined || value === "points") return { kind: "points" };
  const mesh = MESH.exec(value);
  if (mesh !== null) {
    const triangles = Number(mesh[1]);
    if (!Number.isInteger(triangles) || triangles < 1) return null;
    return { kind: "mesh", triangles, indexBuffer: mesh[2] as string };
  }
  const strips = STRIPS.exec(value);
  if (strips !== null) {
    const cols = Number(strips[1]);
    const rows = Number(strips[2]);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
    return { kind: "strips", cols, rows, closed: strips[3] === "closed" };
  }
  const match = GRID.exec(value);
  if (match === null) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  const sheets = match[3] === undefined ? 1 : Number(match[3]);
  if (!Number.isInteger(sheets) || sheets < 1) return null;
  const wrap = match[4];
  return {
    kind: "grid",
    cols,
    rows,
    wrapU: wrap === "wrapU" || wrap === "wrapUV",
    wrapV: wrap === "wrapV" || wrap === "wrapUV",
    ...(sheets > 1 ? { sheets } : {}),
  };
}

export function formatTopology(topology: PointTopology): string {
  if (topology.kind === "points") return "points";
  if (topology.kind === "mesh") return `mesh:${topology.triangles}@${topology.indexBuffer}`;
  if (topology.kind === "strips") return `strips:${topology.cols}x${topology.rows}${topology.closed ? ":closed" : ""}`;
  const wrap = topology.wrapU && topology.wrapV ? ":wrapUV" : topology.wrapU ? ":wrapU" : topology.wrapV ? ":wrapV" : "";
  return `grid:${topology.cols}x${topology.rows}${gridSheets(topology) > 1 ? `x${gridSheets(topology)}` : ""}${wrap}`;
}

/** Sheets a grid claims: one unless it says more. */
export function gridSheets(topology: GridTopology): number {
  return topology.sheets ?? 1;
}

/** Points a grid topology addresses — what a consumer checks against edge capacity. */
export function gridPointCount(topology: GridTopology): number {
  return topology.cols * topology.rows * gridSheets(topology);
}

/** Cells along each axis of ONE sheet: a wrapped axis has as many cells as points (the seam cell). */
export function gridCellCounts(topology: GridTopology): { cellsU: number; cellsV: number } {
  return {
    cellsU: topology.wrapU ? topology.cols : topology.cols - 1,
    cellsV: topology.wrapV ? topology.rows : topology.rows - 1,
  };
}

/**
 * T1587b — the vertices of the ONE draw that draws a grid: six a cell, every sheet's cells,
 * and none between two sheets. Every reader that sizes a grid draw takes it from here (the
 * Render's lit, depth and glass draws, the preview tile, Render Surface), so a sheet cannot
 * be counted in one of them and not in another.
 */
export function gridVertexCount(topology: GridTopology): number {
  const { cellsU, cellsV } = gridCellCounts(topology);
  return cellsU * cellsV * 6 * gridSheets(topology);
}

/** The strips an edge carries: slots per strip, strips, and whether each one closes. */
export interface StripSet {
  readonly cols: number;
  readonly rows: number;
  readonly closed: boolean;
}

/**
 * T1586b — WHAT STRIPS DOES THIS EDGE CARRY? The one answer every curve node, the rope
 * and `ctx.dim` read, so nobody re-derives the rule:
 *
 *  - a `strips` claim is its own answer;
 *  - a `grid`'s ROWS are strips too (a grid claims the U edges and the V edges; a strip is
 *    the U edges alone), closed when the grid wraps U — which is what lets a rope and a
 *    cloth solve on one layout. Every row of every sheet is one (T1587b);
 *  - `points` and `mesh` carry none, and so does a string nobody understands (`null`).
 */
export function stripsOf(topology: PointTopology | null | undefined): StripSet | undefined {
  if (topology === null || topology === undefined) return undefined;
  if (topology.kind === "strips") return { cols: topology.cols, rows: topology.rows, closed: topology.closed };
  if (topology.kind === "grid") return { cols: topology.cols, rows: topology.rows * gridSheets(topology), closed: topology.wrapU };
  return undefined;
}

/**
 * T1587b — WHAT A KERNEL'S `ctx.dim` READS OFF AN EDGE: the columns and rows of ONE sheet,
 * and how many sheets. A kernel written for one tube then runs the same on each of ten:
 * `i` and `j` are its place in its own sheet. Strips are one sheet of `rows` curves.
 */
export function kernelDimOf(topology: PointTopology | null | undefined): { readonly cols: number; readonly rows: number; readonly sheets: number } | undefined {
  if (topology === null || topology === undefined) return undefined;
  if (topology.kind === "strips") return { cols: topology.cols, rows: topology.rows, sheets: 1 };
  if (topology.kind === "grid") return { cols: topology.cols, rows: topology.rows, sheets: gridSheets(topology) };
  return undefined;
}

/** Slots a strip set addresses — what a consumer checks against edge capacity. */
export function stripsPointCount(strips: StripSet): number {
  return strips.cols * strips.rows;
}
