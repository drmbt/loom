import { wgsl } from "../../runtime/backend/wgsl.ts";

/** The most control points per side (T1509b). The uniform block below holds 8 × 8. */
export const GRID_WARP_MAX = 8;
/** Each grid cell is drawn as SUBDIVISIONS × SUBDIVISIONS quads (two triangles each). */
export const GRID_WARP_SUBDIVISIONS = 16;
/** Six background vertices, then six per sub-quad of every cell the largest grid has. */
export const GRID_WARP_VERTEX_COUNT =
  6 + (GRID_WARP_MAX - 1) * (GRID_WARP_MAX - 1) * GRID_WARP_SUBDIVISIONS * GRID_WARP_SUBDIVISIONS * 6;

const members = Array.from({ length: (GRID_WARP_MAX * GRID_WARP_MAX) / 2 }, (_, index) => `g${String(index)}`);

/**
 * Grid Warp's draw shader (T1509b) — the warped grid DRAWN AS A MESH.
 *
 * A grid warp is a FORWARD map: each control point says where a point of the picture goes.
 * Rendering it as an effect would need the inverse at every output pixel, which has no
 * closed form for a smooth (Catmull-Rom) surface and needs a cell search even for a
 * bilinear one. Drawing the mesh needs neither: every vertex is placed by the forward map
 * and carries its UNDISTORTED grid coordinate `st`, the rasteriser interpolates `st`
 * across each triangle, and the fragment reads the input at `st`. That is the exact
 * inverse of the piecewise-linear mesh, at every pixel, by construction.
 *
 * The mesh: each grid cell is split into GRID_WARP_SUBDIVISIONS² quads, and every vertex
 * position is the chosen interpolation (bilinear, or tensor Catmull-Rom) evaluated at that
 * sub-grid point. The vertex count is the LARGEST grid's, always, so Columns and Rows are
 * uniforms rather than plan structure: vertices past the current grid collapse to one
 * point and draw nothing. `definitions/grid-warp.ts` evaluates the same formulas on the CPU
 * to refuse a folded mesh.
 *
 * The first six vertices are a full-frame quad drawn TRANSPARENT before the mesh. A draw
 * clears its target to the target's clear colour, which is opaque black (B186's finding),
 * and outside the mesh must be transparent; triangles of one draw land in submission
 * order, so the mesh overwrites the background wherever it covers it.
 *
 * Control points are 32 flat `vec4f` members, two points each (x0, y0, x1, y1), point
 * k = row × 8 + column: the plan carries a uniform as a flat number list, which cannot
 * fill an array member (the Ramp's reason, `generators.wgsl.ts`). They are copied into a
 * private array once per vertex.
 *
 * Coordinates are y UP (TD's, and the parameters'), so clip y is `2y - 1` and the input
 * row is read at `1 - st.y`. The input is read by textureLoad with bilinear filtering and
 * clamp-to-edge done here: a draw pass binds no sampler, and these are the shared
 * sampler's settings (linear, clamp-to-edge), so a Grid Warp reads the input the way a
 * Corner Pin does.
 *
 * T1534b — each grid line also has a PICTURE POSITION, and `st` is interpolated from those
 * with the points' own weights (`gridWarpSource` in the definition). They arrive as each
 * line's offset from the even spread, in cells (`lu0`/`lu1` per column, `lv0`/`lv1` per
 * row), so an evenly spread grid adds exact zeros and its `st` is `gu / (columns − 1)` to the
 * bit, as it was before lines had positions.
 *
 * FEATHER fades every channel, as Corner Pin's does and for its reason: the picture goes
 * to a projector, which shows rgb, so a soft edge carried in alpha only would be a hard
 * edge on the wall. It is measured in the grid's own coordinates (`edge`, 0..1 across the
 * surface), so it follows the surface's edges — which, after an edge line is deleted, are
 * not the picture's 0 and 1.
 *
 * `valid` is 0 when the definition refused a folded mesh: every mesh vertex collapses and
 * only the transparent background is drawn — never NaN, never a doubled picture.
 */
export const GRID_WARP_WGSL = wgsl`const MAX_GRID: u32 = ${String(GRID_WARP_MAX)}u;
const SUBDIVISIONS: u32 = ${String(GRID_WARP_SUBDIVISIONS)}u;

struct Params {
  ${members.map((name) => `${name}: vec4f,`).join("\n  ")}
  lu0: vec4f,
  lu1: vec4f,
  lv0: vec4f,
  lv1: vec4f,
  columns: f32,
  rows: f32,
  spline: f32,
  valid: f32,
  feather: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) st: vec2f,
  @location(1) @interpolate(flat) inside: u32,
  @location(2) edge: vec2f,
};

var<private> grid: array<vec4f, ${String(members.length)}>;

fn loadGrid() {
  grid = array<vec4f, ${String(members.length)}>(${members.map((name) => `params.${name}`).join(", ")});
}

fn stored(i: i32, j: i32) -> vec2f {
  let k = u32(j) * MAX_GRID + u32(i);
  let pair = grid[k / 2u];
  return select(pair.xy, pair.zw, (k & 1u) == 1u);
}

/* One step past an edge is the edge continued in a straight line, so a straight grid
   stays straight under Catmull-Rom and the identity grid is the identity. */
fn alongColumns(i: i32, j: i32, columns: i32) -> vec2f {
  if (i < 0) { return 2.0 * stored(0, j) - stored(1, j); }
  if (i > columns - 1) { return 2.0 * stored(columns - 1, j) - stored(columns - 2, j); }
  return stored(i, j);
}

fn control(i: i32, j: i32, columns: i32, rows: i32) -> vec2f {
  if (j < 0) { return 2.0 * alongColumns(i, 0, columns) - alongColumns(i, 1, columns); }
  if (j > rows - 1) { return 2.0 * alongColumns(i, rows - 1, columns) - alongColumns(i, rows - 2, columns); }
  return alongColumns(i, j, columns);
}

fn catmullRom(t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return 0.5 * vec4f(-t + 2.0 * t2 - t3, 2.0 - 5.0 * t2 + 3.0 * t3, t + 4.0 * t2 - 3.0 * t3, t3 - t2);
}

/* The forward map at grid coordinate (gu, gv), 0..columns-1 by 0..rows-1. */
fn warp(gu: f32, gv: f32, columns: i32, rows: i32, spline: bool) -> vec2f {
  let i = min(i32(floor(gu)), columns - 2);
  let j = min(i32(floor(gv)), rows - 2);
  let t = gu - f32(i);
  let s = gv - f32(j);
  if (!spline) {
    let bottom = mix(control(i, j, columns, rows), control(i + 1, j, columns, rows), t);
    let top = mix(control(i, j + 1, columns, rows), control(i + 1, j + 1, columns, rows), t);
    return mix(bottom, top, s);
  }
  let wu = catmullRom(t);
  let wv = catmullRom(s);
  var result = vec2f(0.0);
  for (var b = 0; b < 4; b += 1) {
    let row = j - 1 + b;
    let along = wu.x * control(i - 1, row, columns, rows) + wu.y * control(i, row, columns, rows) +
      wu.z * control(i + 1, row, columns, rows) + wu.w * control(i + 2, row, columns, rows);
    result += wv[b] * along;
  }
  return result;
}

/* T1534b: line k's offset from the even spread, along columns (axis 0) or rows (axis 1). */
fn lineOffset(axis: u32, k: i32) -> f32 {
  let index = u32(k);
  var lane: vec4f;
  if (axis == 0u) {
    lane = select(params.lu0, params.lu1, index >= 4u);
  } else {
    lane = select(params.lv0, params.lv1, index >= 4u);
  }
  return lane[index % 4u];
}

/* Past an end, the line continued straight on, as control() continues the points. */
fn lineAlong(axis: u32, k: i32, n: i32) -> f32 {
  if (k < 0) { return 2.0 * lineOffset(axis, 0) - lineOffset(axis, 1); }
  if (k > n - 1) { return 2.0 * lineOffset(axis, n - 1) - lineOffset(axis, n - 2); }
  return lineOffset(axis, k);
}

/* The picture coordinate at grid coordinate g along one axis of n lines: the line offsets
   interpolated with the points' weights, added to the even spread. */
fn pictureAt(axis: u32, g: f32, n: i32, spline: bool) -> f32 {
  let i = min(i32(floor(g)), n - 2);
  let t = g - f32(i);
  var offset: f32;
  if (spline) {
    offset = dot(catmullRom(t), vec4f(lineAlong(axis, i - 1, n), lineAlong(axis, i, n), lineAlong(axis, i + 1, n), lineAlong(axis, i + 2, n)));
  } else {
    offset = mix(lineAlong(axis, i, n), lineAlong(axis, i + 1, n), t);
  }
  return (g + offset) / f32(n - 1);
}

fn quadCorner(v: u32) -> vec2u {
  var corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  return corners[v];
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  var out: VertexOut;
  if (vertex < 6u) {
    let corner = vec2f(quadCorner(vertex));
    out.position = vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
    out.st = corner;
    out.edge = corner;
    out.inside = 0u;
    return out;
  }
  let columns = i32(params.columns + 0.5);
  let rows = i32(params.rows + 0.5);
  let cellsX = u32(columns - 1);
  let cellsY = u32(rows - 1);
  let perCell = SUBDIVISIONS * SUBDIVISIONS * 6u;
  let m = vertex - 6u;
  let cell = m / perCell;
  out.inside = 1u;
  if (params.valid < 0.5 || cell >= cellsX * cellsY) {
    out.position = vec4f(0.0, 0.0, 0.0, 1.0);
    out.st = vec2f(0.0);
    out.edge = vec2f(0.0);
    return out;
  }
  let within = m % perCell;
  let sub = within / 6u;
  let corner = quadCorner(within % 6u);
  let su = (cell % cellsX) * SUBDIVISIONS + sub % SUBDIVISIONS + corner.x;
  let sv = (cell / cellsX) * SUBDIVISIONS + sub / SUBDIVISIONS + corner.y;
  let gu = f32(su) / f32(SUBDIVISIONS);
  let gv = f32(sv) / f32(SUBDIVISIONS);
  loadGrid();
  let spline = params.spline > 0.5;
  let p = warp(gu, gv, columns, rows, spline);
  out.position = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.st = vec2f(pictureAt(0u, gu, columns, spline), pictureAt(1u, gv, rows, spline));
  out.edge = vec2f(gu / f32(columns - 1), gv / f32(rows - 1));
  return out;
}

fn sampleInput(st: vec2f) -> vec4f {
  let size = vec2i(textureDimensions(inputTexture));
  let texel = vec2f(st.x, 1.0 - st.y) * vec2f(size) - 0.5;
  let base = floor(texel);
  // The sub-texel weight at 8 bits, the precision WebGPU grants a hardware linear sampler:
  // a read within 1/512 texel of a texel centre returns that texel exactly, as the sampler
  // Corner Pin reads through does. In full f32 the rasteriser's interpolation noise left an
  // undistorted grid one half-float step off on half its pixels (measured on Dawn/Metal).
  let f = round((texel - base) * 256.0) / 256.0;
  let lo = clamp(vec2i(base), vec2i(0), size - 1);
  let hi = clamp(vec2i(base) + 1, vec2i(0), size - 1);
  let a = textureLoad(inputTexture, vec2i(lo.x, lo.y), 0);
  let b = textureLoad(inputTexture, vec2i(hi.x, lo.y), 0);
  let c = textureLoad(inputTexture, vec2i(lo.x, hi.y), 0);
  let d = textureLoad(inputTexture, vec2i(hi.x, hi.y), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  if (input.inside == 0u) {
    return vec4f(0.0);
  }
  let value = sampleInput(input.st);
  if (params.feather <= 0.0) {
    return value;
  }
  let edge = min(input.edge, vec2f(1.0) - input.edge) / params.feather;
  let mask = clamp(edge.x, 0.0, 1.0) * clamp(edge.y, 0.0, 1.0);
  return value * mask;
}`;
