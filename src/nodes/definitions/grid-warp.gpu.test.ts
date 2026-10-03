import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { TOLERANCE_CROSS_GPU_HDR, decodeComponents } from "../../tests/headless/pixel-compare.ts";

/**
 * Grid Warp on a real device (T1509b, §V147).
 *
 * The fixture writes its own uv into red and green (Corner Pin's fixture), so every output
 * pixel SAYS where in the input it was read from. The expected source of each pixel comes
 * from a mesh built IN THIS FILE by a different route from the node's: Catmull-Rom in its
 * HERMITE form (tangents (P[k+1] − P[k−1]) / 2, applied along each row, then down the
 * columns) rather than the node's tensor weights, bilinear written out per cell, and the
 * inverse found by brute force — every pixel centre tested against every triangle of the
 * 16 × 16-per-cell mesh, barycentric coordinates by Cramer's rule. A missing subdivision, a
 * swapped corner, a flipped y or a wrong spline all fail interior pixels in bulk.
 *
 * Tolerance: TOLERANCE_CROSS_GPU_HDR, Corner Pin's regime — the fixture is written to
 * rgba16float and the warp's output is too, one half-float rounding each. The fixture
 * writes HALF its uv, so every value sits below 0.5 where a half's step is 2^-12 or finer:
 * both roundings together then take at most half the tolerance, and the rest is left for
 * the one thing a mesh adds over Corner Pin's per-pixel solve — the rasteriser snapping
 * vertices to its sub-pixel grid, measured on Dawn/Metal at ≤ 6e-5 in the surface's own
 * coordinates at this size. At the full uv range the two roundings alone (Metal's half
 * conversion was seen to land a full step low) reach the tolerance, and a correct mesh
 * passed by 1e-5. A pixel sampled half a pixel off misses by ~0.004 either way.
 */

const W = 64;
const H = 48;
/** The node's subdivision, restated: a different count is a different mesh, and fails here. */
const S = 16;

const settings: ProjectSettings = {
  outputResolution: { width: W, height: H },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const UV = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  return vec4f(uv * 0.5, 0.0, max(base.a, 1.0));
}`;

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

function graph(parameters: Record<string, ParameterValue>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      seed: node("seed", "solid", { color: [0, 0, 0, 1] }),
      fix: node("fix", "customWgsl", { source: UV }),
      warp: node("warp", "gridWarp", parameters),
      out: node("out", "output"),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fix", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fix", portId: "out" }, target: { nodeId: "warp", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "warp", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

type Pixel = readonly [number, number, number, number];
interface Rendered {
  readonly at: (x: number, y: number) => Pixel;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

async function render(parameters: Record<string, ParameterValue>, nodeId = "warp"): Promise<Rendered> {
  const result = await renderHeadless({ host: nodeGpuHost(), graph: graph(parameters), settings, frames: 1, capture: [0], outputNodeId: nodeId });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const pixels = decodeComponents(result.frames[0]!.bytes, result.frames[0]!.format);
  return {
    at: (x, y) => {
      const index = (y * W + x) * 4;
      return [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!, pixels[index + 3]!];
    },
    diagnostics: result.diagnostics,
  };
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);
const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

type P = readonly [number, number];

/** Pixel (x, y) (row 0 at the top) as the node's y-up output point. */
const outputPoint = (x: number, y: number): P => [(x + 0.5) / W, 1 - (y + 0.5) / H];

/** What the fixture holds at y-up input point `source`: half its y-down uv, clamped to the outermost texel centres. */
const fixtureAt = ([sx, sy]: P): P => [
  0.5 * Math.min(Math.max(sx, 0.5 / W), 1 - 0.5 / W),
  0.5 * Math.min(Math.max(1 - sy, 0.5 / H), 1 - 0.5 / H),
];

function expectNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
}

/** `p{c}{r}_{C}x{R}` for every point of a columns × rows grid, from a function of the point's identity position. */
function gridParameters(columns: number, rows: number, place: (u: number, v: number) => P): Record<string, ParameterValue> {
  const parameters: Record<string, ParameterValue> = { columns, rows };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) parameters[`p${c}${r}_${columns}x${rows}`] = [...place(c / (columns - 1), r / (rows - 1))];
  }
  return parameters;
}

/**
 * THE INDEPENDENT MESH: vertex positions on the (columns−1)·16+1 × (rows−1)·16+1 lattice,
 * each with its undistorted coordinate.
 */
function referenceLattice(columns: number, rows: number, points: (c: number, r: number) => P, smooth: boolean) {
  // Past an edge: the line through the last two points, one step further.
  const ext = (k: number, n: number, get: (k: number) => P): P => {
    if (k < 0) return [2 * get(0)[0] - get(1)[0], 2 * get(0)[1] - get(1)[1]];
    if (k > n - 1) return [2 * get(n - 1)[0] - get(n - 2)[0], 2 * get(n - 1)[1] - get(n - 2)[1]];
    return get(k);
  };
  // One axis: Hermite between P[k] and P[k+1] with Catmull-Rom tangents, or a straight line.
  const along = (n: number, get: (k: number) => P, g: number): P => {
    const k = Math.min(Math.floor(g), n - 2);
    const t = g - k;
    const p0 = ext(k, n, get);
    const p1 = ext(k + 1, n, get);
    if (!smooth) return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    const before = ext(k - 1, n, get);
    const after = ext(k + 2, n, get);
    const m0: P = [(p1[0] - before[0]) / 2, (p1[1] - before[1]) / 2];
    const m1: P = [(after[0] - p0[0]) / 2, (after[1] - p0[1]) / 2];
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;
    return [
      h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0],
      h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1],
    ];
  };
  const nu = (columns - 1) * S + 1;
  const nv = (rows - 1) * S + 1;
  const position: P[] = [];
  const st: P[] = [];
  for (let b = 0; b < nv; b += 1) {
    for (let a = 0; a < nu; a += 1) {
      const gu = a / S;
      const gv = b / S;
      // Along every row (with the continued rows above and below), then down the column.
      position.push(along(rows, (r) => along(columns, (c) => points(c, r), gu), gv));
      st.push([gu / (columns - 1), gv / (rows - 1)]);
    }
  }
  const triangles: Array<readonly [number, number, number]> = [];
  for (let b = 0; b < nv - 1; b += 1) {
    for (let a = 0; a < nu - 1; a += 1) {
      const i = b * nu + a;
      triangles.push([i, i + 1, i + nu], [i + nu, i + 1, i + nu + 1]);
    }
  }
  return { position, st, triangles };
}

const EDGE_MARGIN = 1e-4;

/**
 * Where pixel point `p` reads the input under the reference mesh: `{ st }` well inside a
 * triangle, `"outside"` well outside every one, `null` within rounding of an edge (left
 * out, as Corner Pin's test leaves out pixels on its quad's edge).
 */
function referenceSource(mesh: ReturnType<typeof referenceLattice>, p: P): { readonly st: P } | "outside" | null {
  let best = -Infinity;
  let bestSt: P | null = null;
  for (const [i, j, k] of mesh.triangles) {
    const a = mesh.position[i]!;
    const b = mesh.position[j]!;
    const c = mesh.position[k]!;
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    const l1 = ((p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])) / det;
    const l2 = ((b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])) / det;
    const l0 = 1 - l1 - l2;
    const worst = Math.min(l0, l1, l2);
    if (worst <= best) continue;
    best = worst;
    const [sa, sb, sc] = [mesh.st[i]!, mesh.st[j]!, mesh.st[k]!];
    bestSt = [l0 * sa[0] + l1 * sb[0] + l2 * sc[0], l0 * sa[1] + l1 * sb[1] + l2 * sc[1]];
  }
  if (best >= EDGE_MARGIN && bestSt !== null) return { st: bestSt };
  if (best <= -EDGE_MARGIN) return "outside";
  return null;
}

/** Every pixel against the reference mesh; returns how many were claimed inside and outside. */
function expectMesh(rendered: Rendered, mesh: ReturnType<typeof referenceLattice>): { inside: number; outside: number } {
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const source = referenceSource(mesh, outputPoint(x, y));
      if (source === null) continue;
      const pixel = rendered.at(x, y);
      if (source === "outside") {
        expect(pixel, `outside ${x},${y}`).toEqual([0, 0, 0, 0]);
        outside += 1;
        continue;
      }
      const [u, v] = fixtureAt(source.st);
      expectNear(pixel[0], u, `u at ${x},${y}`);
      expectNear(pixel[1], v, `v at ${x},${y}`);
      expect(pixel[3], `alpha at ${x},${y}`).toBe(1);
      inside += 1;
    }
  }
  return { inside, outside };
}

/** The pixel centre (44, 18): (0.6953125, 0.6145833…), y up. */
const TARGET_PIXEL = [44, 18] as const;
const TARGET = outputPoint(...TARGET_PIXEL);

describe("Grid Warp on a real device (T1509b)", () => {
  it("is the identity, bit for bit, on an undistorted grid — smooth, linear, and at 4 × 3", async () => {
    requireDawn();
    const input = await render({}, "fix");
    for (const parameters of [{}, { interpolation: "linear" }, { columns: 4 }] as const) {
      const warped = await render(parameters);
      expect(warped.diagnostics.map((d) => d.code)).toEqual([]);
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) expect(warped.at(x, y), `${JSON.stringify(parameters)} ${x},${y}`).toEqual(input.at(x, y));
    }
  }, 60_000);

  it.each(["linear", "smooth"] as const)(
    "an AFFINE grid (a Corner Pin parallelogram) maps every pixel by the analytic inverse; outside is exactly transparent (%s)",
    async (interpolation) => {
      requireDawn();
      // p = A·q + b with A = [[0.6, 0.2], [0.1, 0.7]], b = (0.15, 0.1): q = A⁻¹(p − b).
      const forward = (u: number, v: number): P => [0.6 * u + 0.2 * v + 0.15, 0.1 * u + 0.7 * v + 0.1];
      const det = 0.6 * 0.7 - 0.2 * 0.1;
      const inverse = ([px, py]: P): P => {
        const [dx, dy] = [px - 0.15, py - 0.1];
        return [(0.7 * dx - 0.2 * dy) / det, (-0.1 * dx + 0.6 * dy) / det];
      };
      const { at, diagnostics } = await render({ ...gridParameters(4, 3, forward), interpolation });
      expect(diagnostics.map((d) => d.code)).toEqual([]);
      let inside = 0;
      let outside = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const [s, t] = inverse(outputPoint(x, y));
          const distance = Math.min(s, 1 - s, t, 1 - t);
          if (Math.abs(distance) < EDGE_MARGIN) continue;
          if (distance < 0) {
            expect(at(x, y), `outside ${x},${y}`).toEqual([0, 0, 0, 0]);
            outside += 1;
            continue;
          }
          const [u, v] = fixtureAt([s, t]);
          expectNear(at(x, y)[0], u, `u at ${x},${y}`);
          expectNear(at(x, y)[1], v, `v at ${x},${y}`);
          expect(at(x, y)[3]).toBe(1);
          inside += 1;
        }
      }
      // Both regions in bulk: an all-transparent or all-identity render cannot pass.
      expect(inside).toBeGreaterThan(W * H * 0.3);
      expect(outside).toBeGreaterThan(W * H * 0.2);
    },
    60_000,
  );

  it.each(["linear", "smooth"] as const)(
    "a displaced interior point takes the picture with it: its own picture point lands there, every pixel follows the mesh (%s)",
    async (interpolation) => {
      requireDawn();
      const before = await render({ interpolation });
      const after = await render({ interpolation, p11_3x3: [...TARGET] });
      expect(after.diagnostics.map((d) => d.code)).toEqual([]);

      // The control point carries the picture's centre: the target pixel now reads (0.5, 0.5).
      const [cx, cy] = fixtureAt([0.5, 0.5]);
      expectNear(after.at(...TARGET_PIXEL)[0], cx, "u at the moved point");
      expectNear(after.at(...TARGET_PIXEL)[1], cy, "v at the moved point");
      // ...where the undistorted grid showed the picture's own (0.695, 0.615): the edit is
      // what moved it (the driven-parameter diff).
      expect(Math.abs(before.at(...TARGET_PIXEL)[0] - after.at(...TARGET_PIXEL)[0])).toBeGreaterThan(0.05);

      // And every other pixel is the independently built mesh's.
      const identity = (c: number, r: number): P => (c === 1 && r === 1 ? TARGET : [c / 2, r / 2]);
      const { inside } = expectMesh(after, referenceLattice(3, 3, identity, interpolation === "smooth"));
      expect(inside).toBeGreaterThan(W * H * 0.9);
    },
    60_000,
  );

  it("a MIRRORED grid (rear projection) is drawn, not refused", async () => {
    requireDawn();
    const { at, diagnostics } = await render(gridParameters(3, 3, (u, v) => [1 - u, v]));
    expect(diagnostics.map((d) => d.code)).toEqual([]);
    for (const [x, y] of [[3, 4], [40, 20], [60, 44]] as const) {
      const [px, py] = outputPoint(x, y);
      const [u, v] = fixtureAt([1 - px, py]);
      expectNear(at(x, y)[0], u, `u at ${x},${y}`);
      expectNear(at(x, y)[1], v, `v at ${x},${y}`);
    }
  }, 60_000);

  it("feathers the edge: every channel scales by the linear ramp to the nearest edge of the surface", async () => {
    requireDawn();
    const feather = 0.25;
    const { at } = await render({ feather });
    for (let y = 0; y < H; y += 3) {
      for (let x = 0; x < W; x += 3) {
        const [s, t] = outputPoint(x, y);
        const mask = Math.min(Math.min(s, 1 - s) / feather, 1) * Math.min(Math.min(t, 1 - t) / feather, 1);
        const [u, v] = fixtureAt([s, t]);
        const pixel = at(x, y);
        expectNear(pixel[3], mask, `alpha at ${x},${y}`);
        expectNear(pixel[0], u * mask, `r at ${x},${y}`);
        expectNear(pixel[1], v * mask, `g at ${x},${y}`);
      }
    }
  }, 60_000);

  /*
   * Without the refusal this grid WOULD put pixels on screen — most of the frame is still
   * an ordinary warp, and the folded cells would draw the picture twice over the right
   * side. Refused, it is transparent everywhere and never NaN.
   */
  it("a folded grid renders transparent everywhere and names itself", async () => {
    requireDawn();
    const { at, diagnostics } = await render({ p11_3x3: [1.2, 0.5] });
    expect(diagnostics.filter((d) => d.code === "gridWarp.folded").map((d) => d.nodeId)).toEqual(["warp"]);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) expect(at(x, y), `${x},${y}`).toEqual([0, 0, 0, 0]);
  }, 60_000);
});
