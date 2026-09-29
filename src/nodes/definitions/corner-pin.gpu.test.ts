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
 * Corner Pin on a real device (T1491b, §V147).
 *
 * The fixture writes its own uv into red and green, so every output pixel SAYS where in the
 * input it was read from. The expected source of each pixel comes from a homography solved
 * IN THIS FILE by a different method — the 8×8 direct linear transform, by Gaussian
 * elimination, straight from the four corner correspondences — never from the node's own
 * Heckbert solver or its inverse. So the whole grid is compared against an independent
 * statement of the geometry: a two-triangle or bilinear warp, a missing perspective
 * division or a flipped y fails every interior pixel, not one.
 *
 * Tolerance: the fixture's uv is written to rgba16float and read back through a bilinear
 * sampler, one half-float rounding each way (the Tile test's regime, TOLERANCE_CROSS_GPU_HDR).
 * The shader's f32 homography differs from this file's f64 one by ~1e-6, far inside it.
 */

const W = 64;
const H = 48;

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
  return vec4f(uv, 0.0, max(base.a, 1.0));
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
      pin: node("pin", "cornerPin", parameters),
      out: node("out", "output"),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fix", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fix", portId: "out" }, target: { nodeId: "pin", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "pin", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

type Pixel = readonly [number, number, number, number];
interface Rendered {
  readonly at: (x: number, y: number) => Pixel;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

async function render(parameters: Record<string, ParameterValue>, nodeId = "pin"): Promise<Rendered> {
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
type Corners = readonly [P, P, P, P];
const SQUARE: Corners = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * THE INDEPENDENT SOLVER: the homography taking `from[i]` to `to[i]`, h33 = 1, by the direct
 * linear transform — two rows per correspondence,
 *   [x y 1 0 0 0 -x·X -y·X] h = X,   [0 0 0 x y 1 -x·Y -y·Y] h = Y,
 * solved by Gaussian elimination with partial pivoting. Returns the map itself.
 */
function dlt(from: Corners, to: Corners): (point: P) => P {
  const rows: number[][] = [];
  from.forEach(([x, y], index) => {
    const [X, Y] = to[index]!;
    rows.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
    rows.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
  });
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let r = column + 1; r < 8; r += 1) if (Math.abs(rows[r]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = r;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const lead = rows[column]!;
    for (let r = 0; r < 8; r += 1) {
      if (r === column) continue;
      const factor = rows[r]![column]! / lead[column]!;
      for (let c = column; c < 9; c += 1) rows[r]![c]! -= factor * lead[c]!;
    }
  }
  const h = rows.map((r, index) => r[8]! / r[index]!);
  return ([x, y]) => {
    const w = h[6]! * x + h[7]! * y + 1;
    return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
  };
}

/** Pixel (x, y) (row 0 at the top) as the node's y-up output point. */
const outputPoint = (x: number, y: number): P => [(x + 0.5) / W, 1 - (y + 0.5) / H];

/**
 * What the fixture holds at y-up input point `source`: its y-down uv, clamped to the
 * outermost texel centres (the sampler's clamp-to-edge, stated rather than avoided).
 */
const fixtureAt = ([sx, sy]: P): P => [
  Math.min(Math.max(sx, 0.5 / W), 1 - 0.5 / W),
  Math.min(Math.max(1 - sy, 0.5 / H), 1 - 0.5 / H),
];

function expectNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
}

const pinParameters = (quad: Corners): Record<string, ParameterValue> => ({
  pinbl: [...quad[0]],
  pinbr: [...quad[1]],
  pintr: [...quad[2]],
  pintl: [...quad[3]],
});

/** A general (no two sides parallel) pin quad, well inside the frame. */
const PINS: Corners = [
  [0.1, 0.05],
  [0.95, 0.2],
  [0.8, 0.9],
  [0.2, 0.7],
];

/**
 * f32 in the shader and f64 here can disagree on which side of the quad's edge a pixel
 * centre is only when it is within rounding of it; those pixels are left out, and every
 * other pixel is claimed.
 */
const EDGE_MARGIN = 1e-4;

describe("Corner Pin on a real device (T1491b)", () => {
  it("is the identity, bit for bit, at its defaults (a fresh node moves nothing)", async () => {
    requireDawn();
    const input = await render({}, "fix");
    const pinned = await render({});
    expect(pinned.diagnostics.map((d) => d.code)).toEqual([]);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) expect(pinned.at(x, y), `${x},${y}`).toEqual(input.at(x, y));
  }, 60_000);

  it("maps every pixel through the perspective homography of a general quad; outside is exactly transparent", async () => {
    requireDawn();
    const { at } = await render(pinParameters(PINS));
    const toSquare = dlt(PINS, SQUARE);
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const [s, t] = toSquare(outputPoint(x, y));
        const distance = Math.min(s, 1 - s, t, 1 - t);
        if (Math.abs(distance) < EDGE_MARGIN) continue;
        const pixel = at(x, y);
        if (distance < 0) {
          expect(pixel, `outside ${x},${y}`).toEqual([0, 0, 0, 0]);
          outside += 1;
          continue;
        }
        // Identity extract: the square point IS the input point.
        const [u, v] = fixtureAt([s, t]);
        expectNear(pixel[0], u, `u at ${x},${y}`);
        expectNear(pixel[1], v, `v at ${x},${y}`);
        expect(pixel[3], `alpha at ${x},${y}`).toBe(1);
        inside += 1;
      }
    }
    // The claim reaches both regions in bulk — a render of all-transparent cannot pass.
    expect(inside).toBeGreaterThan(W * H * 0.4);
    expect(outside).toBeGreaterThan(W * H * 0.2);
  }, 60_000);

  it("pins an extract SUB-QUAD of the input: the output reads only that quad, in perspective", async () => {
    requireDawn();
    const extract: Corners = [
      [0.2, 0.1],
      [0.9, 0.3],
      [0.7, 0.8],
      [0.1, 0.6],
    ];
    const { at } = await render({
      extractbl: [...extract[0]],
      extractbr: [...extract[1]],
      extracttr: [...extract[2]],
      extracttl: [...extract[3]],
    });
    const toInput = dlt(SQUARE, extract);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const [u, v] = fixtureAt(toInput(outputPoint(x, y)));
        const pixel = at(x, y);
        expectNear(pixel[0], u, `u at ${x},${y}`);
        expectNear(pixel[1], v, `v at ${x},${y}`);
      }
    }
  }, 60_000);

  it("moving ONE corner changes the picture where that corner's quad changed (the driven-parameter diff)", async () => {
    requireDawn();
    const before = await render({});
    const after = await render({ pintr: [0.6, 0.6] });
    // Top-right pixel: inside the full frame before, outside the pulled-in quad after.
    expect(before.at(W - 1, 0)[3]).toBe(1);
    expect(after.at(W - 1, 0)).toEqual([0, 0, 0, 0]);
    // And the moved quad is the independent solver's, not merely "different".
    const moved: Corners = [SQUARE[0], SQUARE[1], [0.6, 0.6], SQUARE[3]];
    const toSquare = dlt(moved, SQUARE);
    const [s, t] = toSquare(outputPoint(20, 30));
    const [u, v] = fixtureAt([s, t]);
    expectNear(after.at(20, 30)[0], u, "u at 20,30");
    expectNear(after.at(20, 30)[1], v, "v at 20,30");
    expect(Math.abs(after.at(20, 30)[0] - before.at(20, 30)[0])).toBeGreaterThan(0.01);
  }, 60_000);

  it("Outside = Repeat continues the pinned surface as tiles of the input", async () => {
    requireDawn();
    const half: Corners = [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.75, 0.75],
      [0.25, 0.75],
    ];
    const { at } = await render({ ...pinParameters(half), extend: "repeat" });
    for (const [x, y] of [
      [2, 2],
      [60, 3],
      [5, 45],
      [33, 20],
    ] as const) {
      const [px, py] = outputPoint(x, y);
      // Affine pins: s = 2(p - 0.25), then repeat's fract.
      const s = 2 * (px - 0.25);
      const t = 2 * (py - 0.25);
      const [u, v] = fixtureAt([s - Math.floor(s), t - Math.floor(t)]);
      expectNear(at(x, y)[0], u, `u at ${x},${y}`);
      expectNear(at(x, y)[1], v, `v at ${x},${y}`);
      expect(at(x, y)[3]).toBe(1);
    }
  }, 60_000);

  it("feathers the edge: every channel scales by the linear ramp to the nearest edge", async () => {
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
   * The cases are chosen so that WITHOUT the refusal they would put pixels on screen. A
   * bow-tie of the frame's own corners does not qualify, and was the first draft's case:
   * its homography sends the whole unit square outside the visible frame, so it rendered
   * transparent with the guard deleted (found by red-verifying). A dent's homography runs
   * through infinity INSIDE the frame; three corners in a line have no inverse at all.
   */
  it.each([
    ["a dent (one corner pushed inside)", { pintr: [0.3, 0.3] }],
    ["three corners in a line (zero area)", { pinbr: [0.5, 0], pintr: [1, 0] }],
  ] as const)("a degenerate pin quad — %s — renders transparent everywhere and names itself", async (_name, pins) => {
    requireDawn();
    const { at, diagnostics } = await render(pins as unknown as Record<string, ParameterValue>);
    expect(diagnostics.filter((d) => d.code === "cornerPin.pin.degenerate").map((d) => d.nodeId)).toEqual(["pin"]);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) expect(at(x, y), `${x},${y}`).toEqual([0, 0, 0, 0]);
  }, 60_000);
});
