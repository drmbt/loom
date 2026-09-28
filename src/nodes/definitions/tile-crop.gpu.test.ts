import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { TOLERANCE_CROSS_GPU_HDR, decodeComponents } from "../../tests/headless/pixel-compare.ts";

/**
 * Tile's crop window on a real device (T1402b, §V147) — the On Nothing silhouette
 * quadruplet (four strips of one central slice, alternately flipped) as a stock node.
 *
 * The fixture writes its own uv into red and green, so every output pixel SAYS where in the
 * source it was read from. Three claims: each strip reads the window, flipped where the
 * offset says; strip k is strip k+1 mirrored, bit for bit; and at the default window the
 * node is the old arithmetic exactly (a 1x1 tile is the input, bit for bit).
 */

const W = 128;
const H = 32;

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
      fx: node("fx", "tile", parameters),
      out: node("out", "output"),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fix", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fix", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

type Pixel = readonly [number, number, number, number];

async function render(parameters: Record<string, ParameterValue>, nodeId = "fx"): Promise<(x: number, y: number) => Pixel> {
  const result = await renderHeadless({ host: nodeGpuHost(), graph: graph(parameters), settings, frames: 1, capture: [0], outputNodeId: nodeId });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const pixels = decodeComponents(result.frames[0]!.bytes, result.frames[0]!.format);
  return (x, y) => {
    const at = (y * W + x) * 4;
    return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!, pixels[at + 3]!];
  };
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);
const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

/** The project's quadruplet: 4 strips of the slice 0.377..0.677, the even strips flipped. */
const QUAD = { repeat: [4, 1], offset: [1, 0], mirrorx: true, cropleft: 0.377, cropright: 0.677, cropbottom: 0.2, croptop: 0.7 };
const STRIP = W / 4;

describe("Tile's crop window on a real device (T1402b)", () => {
  it("every strip reads the window, the even strips flipped (an odd offset swaps which)", async () => {
    requireDawn();
    const at = await render(QUAD);
    // A linear ramp read through a bilinear sampler: one half-float rounding in the fixture
    // and one in the output (2^-12 each below 1), so the absolute regime bounds it.
    for (let x = 0; x < W; x += 1) {
      const strip = Math.floor(x / STRIP);
      const t = (x % STRIP + 0.5) / STRIP;
      const local = strip % 2 === 0 ? 1 - t : t;
      for (const y of [0, 9, 31]) {
        const ty = (y + 0.5) / H;
        const pixel = at(x, y);
        expect(Math.abs(pixel[0] - (0.377 + local * 0.3)), `u at ${x},${y}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
        expect(Math.abs(pixel[1] - (1 - 0.7 + ty * 0.5)), `v at ${x},${y}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
      }
    }
  }, 60_000);

  it("strip k is strip k+1 mirrored, bit for bit", async () => {
    requireDawn();
    const at = await render(QUAD);
    for (let strip = 0; strip < 3; strip += 1) {
      for (let i = 0; i < STRIP; i += 1) {
        for (const y of [3, 17]) {
          expect(at(strip * STRIP + i, y), `strip ${strip} px ${i}`).toEqual(at((strip + 1) * STRIP + (STRIP - 1 - i), y));
        }
      }
    }
  }, 60_000);

  it("at the default window a single tile is the input, bit for bit (old documents keep their pixels)", async () => {
    requireDawn();
    const input = await render({}, "fix");
    const tiled = await render({ repeat: [1, 1] });
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) expect(tiled(x, y)).toEqual(input(x, y));
  }, 60_000);
});

/**
 * T1413b — the seams layout and unfolded outer tiles: the On Nothing quad's composite (one
 * window mirrored about three seams, the two strips the frame edges cut running on instead
 * of folding again) as a stock node. Seam at 60 px, tiles 24 px wide on a 128 px frame, so
 * both edges cut a tile: tiles -3 and 2 are the cut ones, and unfolding hands them to -2 and 1.
 */
const SEAMS = {
  layout: "seams",
  seam: [60 / W, 0],
  tilesize: [24 / W, 1],
  mirrorx: true,
  cropleft: 0.4,
  cropright: 0.5,
};

/** The source u a column must read: the grid by hand, the index clamped when unfolding. */
function expectedU(x: number, unfold: boolean): number {
  const t = (x + 0.5 - 60) / 24;
  const index = unfold ? Math.min(Math.max(Math.floor(t), -2), 1) : Math.floor(t);
  const f = t - index;
  const local = Math.abs(index) % 2 === 1 ? 1 - f : f;
  return 0.4 + local * 0.1;
}

describe("Tile's seams layout and unfolded outer tiles on a real device (T1413b)", () => {
  it("mirrors about the seams and runs the edge-cut tiles on from their neighbours", async () => {
    requireDawn();
    const at = await render({ ...SEAMS, unfoldx: true });
    for (let x = 0; x < W; x += 1) {
      for (const y of [0, 17, 31]) {
        const pixel = at(x, y);
        expect(Math.abs(pixel[0] - expectedU(x, true)), `u at ${x},${y}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
        // One tile tall from the bottom seam: y is the frame's own.
        expect(Math.abs(pixel[1] - (y + 0.5) / H), `v at ${x},${y}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
      }
    }
    // The outer strips run on PAST the window: the left edge reads 0.352, the right 0.323,
    // both outside 0.4..0.5 — which is what "does not fold again" means in pixels.
    expect(expectedU(0, true)).toBeLessThan(0.4);
    expect(expectedU(W - 1, true)).toBeLessThan(0.4);
  }, 60_000);

  it("without unfold the edge-cut tiles fold like every other (the seams layout alone)", async () => {
    requireDawn();
    const at = await render(SEAMS);
    for (let x = 0; x < W; x += 1) {
      expect(Math.abs(at(x, 9)[0] - expectedU(x, false)), `u at ${x}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
    }
    // The two layouts differ exactly in the edge strips (x < 12 and x >= 108).
    expect(Math.abs(expectedU(0, false) - expectedU(0, true))).toBeGreaterThan(0.05);
  }, 60_000);

  it("unfold leaves a grid with no tile between its edge tiles alone, bit for bit", async () => {
    requireDawn();
    // Two whole tiles: each is an edge tile and nothing lies between, so there is no inner
    // neighbour to run on from — the frame must be the plain mirrored repeat.
    const plain = await render({ repeat: [2, 1], mirrorx: true, cropleft: 0.2, cropright: 0.6 });
    const unfolded = await render({ repeat: [2, 1], mirrorx: true, cropleft: 0.2, cropright: 0.6, unfoldx: true });
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) expect(unfolded(x, y)).toEqual(plain(x, y));
  }, 60_000);

  it("places the y seam bottom-up with tile 0 above it, as the crop window is", async () => {
    requireDawn();
    // Seam 0.25 up, tiles half the frame tall: tile 0 is rows 8..23 (top-down) and reads the
    // window unflipped; rows 0..7 are tile 1 and 24..31 tile -1, both mirrored.
    const at = await render({ layout: "seams", seam: [0, 0.25], tilesize: [1, 0.5], mirrory: true, cropbottom: 0.2, croptop: 0.7 });
    for (let y = 0; y < H; y += 1) {
      const scaled = (2 * (y + 0.5)) / H - 0.5;
      const index = Math.floor(scaled);
      const f = scaled - index;
      const local = Math.abs(index) % 2 === 1 ? 1 - f : f;
      expect(Math.abs(at(40, y)[1] - (0.3 + local * 0.5)), `v at row ${y}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
    }
  }, 60_000);
});
