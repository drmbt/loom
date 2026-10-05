/**
 * The analytic-topology vocabulary (T302, consumed by T301).
 *
 * Topology travels on the pointset EDGE as a string (T296) because it is a CLAIM the
 * producer makes about index structure, not data: `points` (no connectivity), or
 * `grid:{cols}x{rows}` with optional wrap flags — `:wrapU` closes the column seam
 * (tube), `:wrapUV` closes both (torus). ONE parser and ONE formatter so the grammar
 * cannot fork: producers format, consumers parse, and a string neither understands is
 * an explicit `null` rather than a guessed shape.
 */

export interface GridTopology {
  readonly kind: "grid";
  readonly cols: number;
  readonly rows: number;
  /** Column seam closed: cell (cols-1, y) connects back to column 0 — a tube. */
  readonly wrapU: boolean;
  /** Row seam closed too: with wrapU, a torus. */
  readonly wrapV: boolean;
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

const GRID = /^grid:(\d+)x(\d+)(?::(wrapU|wrapV|wrapUV))?$/;
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
  const wrap = match[3];
  return {
    kind: "grid",
    cols,
    rows,
    wrapU: wrap === "wrapU" || wrap === "wrapUV",
    wrapV: wrap === "wrapV" || wrap === "wrapUV",
  };
}

export function formatTopology(topology: PointTopology): string {
  if (topology.kind === "points") return "points";
  if (topology.kind === "mesh") return `mesh:${topology.triangles}@${topology.indexBuffer}`;
  if (topology.kind === "strips") return `strips:${topology.cols}x${topology.rows}${topology.closed ? ":closed" : ""}`;
  const wrap = topology.wrapU && topology.wrapV ? ":wrapUV" : topology.wrapU ? ":wrapU" : topology.wrapV ? ":wrapV" : "";
  return `grid:${topology.cols}x${topology.rows}${wrap}`;
}

/** Points a grid topology addresses — what a consumer checks against edge capacity. */
export function gridPointCount(topology: GridTopology): number {
  return topology.cols * topology.rows;
}

/** Cells along each axis: a wrapped axis has as many cells as points (the seam cell). */
export function gridCellCounts(topology: GridTopology): { cellsU: number; cellsV: number } {
  return {
    cellsU: topology.wrapU ? topology.cols : topology.cols - 1,
    cellsV: topology.wrapV ? topology.rows : topology.rows - 1,
  };
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
 *    cloth solve on one layout;
 *  - `points` and `mesh` carry none, and so does a string nobody understands (`null`).
 */
export function stripsOf(topology: PointTopology | null | undefined): StripSet | undefined {
  if (topology === null || topology === undefined) return undefined;
  if (topology.kind === "strips") return { cols: topology.cols, rows: topology.rows, closed: topology.closed };
  if (topology.kind === "grid") return { cols: topology.cols, rows: topology.rows, closed: topology.wrapU };
  return undefined;
}

/** Slots a strip set addresses — what a consumer checks against edge capacity. */
export function stripsPointCount(strips: StripSet): number {
  return strips.cols * strips.rows;
}
