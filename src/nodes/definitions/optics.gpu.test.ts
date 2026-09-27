import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { TOLERANCE_CROSS_GPU_HDR, decodeComponents } from "../../tests/headless/pixel-compare.ts";
import { STREAK_LEG_STEPS } from "./optics.ts";

/**
 * The optics family on a real device (T1402b, §V147).
 *
 * Each node is fed a Custom WGSL fixture whose pixels are known exactly — a hot block on
 * black, a flat field, a uv ramp — and read back raw (linear, no display transform), so
 * each claim is about the effect's DEFINING property as a number: where the streak is and
 * is not, where the ring is and in which order its colours sit, what the vignette and the
 * distortion compute. Where a pixel must be untouched the assertion is exact equality; where
 * a value is derived analytically the bound is the rgba16float regime from pixel-compare.
 */

const W = 128;
const H = 128;

function settings(width: number, height: number): ProjectSettings {
  return {
    outputResolution: { width, height },
    workingFormat: "rgba16float",
    colorPolicy: { workingSpace: "linear", displayTransform: "none" },
    randomSeed: 1,
    previewLongEdge: 64,
    previewFps: 30,
    limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
  };
}

/** A Custom WGSL fixture: `body` computes `color: vec4f` from `p` (pixel) and `uv`. */
function fixture(body: string): string {
  return `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let p = floor(uv * vec2f(textureDimensions(inputTexture)));
  var color = vec4f(0.0, 0.0, 0.0, 1.0);
  ${body}
  return vec4f(color.rgb, max(base.a, color.a));
}`;
}

/** A block of `value` over pixels [x0, x1) x [y0, y1), on black. */
const block = (x0: number, y0: number, x1: number, y1: number, value: number): string =>
  `if (all(p >= vec2f(${x0}.0, ${y0}.0)) && all(p < vec2f(${x1}.0, ${y1}.0))) { color = vec4f(vec3f(${value.toFixed(3)}), 1.0); }`;

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

/** seed (solid) -> fixture (custom WGSL) -> the node under test, plus optional extra fixtures. */
function graph(
  type: string,
  parameters: Record<string, ParameterValue>,
  source: string,
  extra: Record<string, string> = {},
): GraphDocument {
  const nodes: Record<string, GraphNode> = {
    seed: node("seed", "solid", { color: [0, 0, 0, 1] }),
    fix: node("fix", "customWgsl", { source }),
    fx: node("fx", type, parameters),
    // The sink that keeps the chain in the plan; the readback is `fx`'s own output.
    out: node("out", "output"),
  };
  const edges: GraphDocument["edges"] = {
    e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fix", portId: "input" } },
    e2: { id: "e2", source: { nodeId: "fix", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
    e3: { id: "e3", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  };
  for (const [port, body] of Object.entries(extra)) {
    nodes[`fix_${port}`] = node(`fix_${port}`, "customWgsl", { source: body });
    edges[`s_${port}`] = { id: `s_${port}`, source: { nodeId: "seed", portId: "out" }, target: { nodeId: `fix_${port}`, portId: "input" } };
    edges[`e_${port}`] = { id: `e_${port}`, source: { nodeId: `fix_${port}`, portId: "out" }, target: { nodeId: "fx", portId: port } };
  }
  return { revision: 1, nodes, edges, groups: {} };
}

type Pixel = readonly [number, number, number, number];

async function render(document: GraphDocument, width = W, height = H): Promise<(x: number, y: number) => Pixel> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document,
    settings: settings(width, height),
    frames: 1,
    capture: [0],
    outputNodeId: "fx",
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0]!;
  expect([frame.width, frame.height]).toEqual([width, height]);
  const pixels = decodeComponents(frame.bytes, frame.format);
  return (x, y) => {
    const at = (y * width + x) * 4;
    return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!, pixels[at + 3]!];
  };
}

/** |actual - expected| within the rgba16float regime, relative, floored at the smallest normal half. */
function expectHdr(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    TOLERANCE_CROSS_GPU_HDR * Math.max(Math.abs(expected), 2 ** -14),
  );
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

/*
 * THE STREAK. A 4x4 block of 4.0 at columns 62..65, rows 96..99, on black; threshold 1
 * extracts 3.0 of it. Length 0.5 at angle 0: the column rises. Tail and spread off, so the
 * claim is strictly one-sided.
 *
 * Where energy CAN reach is derived, not guessed: the legs' taps span
 * 7 × (1/160 + 1/48 + 1/10) × length of the frame height upward, and every resampling
 * between the half-size legs and the full-size add can smear by one half-size texel (two
 * pixels) — four of them (extract, three legs) plus the add's bilinear read.
 */
const DOT = { x0: 62, y0: 96, x1: 66, y1: 100 };
const LENGTH = 0.5;
const REACH_PX = 7 * (STREAK_LEG_STEPS[0] + STREAK_LEG_STEPS[1] + STREAK_LEG_STEPS[2]) * LENGTH * H;
const SMEAR_PX = 5 * 2;
const quiet = { threshold: 1, knee: 0.5, length: LENGTH, falloff: 1.2, spread: 0, tail: 0, striation: 0, gain: 1 };

describe("Streak on a real device (T1402b)", () => {
  it("rises ABOVE the source, and nothing lands below it, beside it, or past its length", async () => {
    requireDawn();
    const at = await render(graph("streak", quiet, fixture(block(DOT.x0, DOT.y0, DOT.x1, DOT.y1, 4))));

    // Above, all the way up the column: energy where the input is black.
    for (const y of [92, 80, 64, 50]) expect(at(63, y)[0], `row ${y}`).toBeGreaterThan(0);
    // It fades with distance from the source (the last leg's weights fall off).
    expect(at(63, 90)[0]).toBeGreaterThan(at(63, 50)[0]);

    // Below the source (no tail): the input, exactly, on every row past the resampling smear.
    for (let y = DOT.y1 + 4; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) expect(at(x, y), `below ${x},${y}`).toEqual([0, 0, 0, 1]);
    }
    // Past the column's reach above: exactly nothing.
    const top = Math.floor(DOT.y0 - REACH_PX - SMEAR_PX);
    expect(top).toBeGreaterThan(8);
    for (let y = 0; y < top; y += 1) {
      for (let x = 0; x < W; x += 1) expect(at(x, y), `past the length ${x},${y}`).toEqual([0, 0, 0, 1]);
    }
    // Beside it: the column is as wide as its source.
    for (let y = 0; y < H; y += 1) {
      for (const x of [40, 52, 76, 90]) expect(at(x, y), `beside ${x},${y}`).toEqual([0, 0, 0, 1]);
    }
  }, 60_000);

  it("turns with Angle: at 90 it runs to the right, and nothing rises", async () => {
    requireDawn();
    const at = await render(graph("streak", { ...quiet, angle: 90 }, fixture(block(30, 62, 34, 66, 4))));
    expect(at(70, 63)[0]).toBeGreaterThan(0);
    for (let x = 0; x < 26; x += 1) expect(at(x, 63), `left ${x}`).toEqual([0, 0, 0, 1]);
    for (const y of [30, 50, 80, 100]) expect(at(40, y), `off-axis ${y}`).toEqual([0, 0, 0, 1]);
  }, 60_000);

  it("streaks the Bright input when one is wired, and ignores its own threshold", async () => {
    requireDawn();
    // The picture carries a hot block on the LEFT; the Bright input carries a 0.5 block on the
    // RIGHT — under the threshold, so only a wired Bright input can make it streak.
    const at = await render(
      graph("streak", quiet, fixture(block(20, 96, 24, 100, 4)), { bright: fixture(block(100, 96, 104, 100, 0.5)) }),
    );
    expect(at(101, 70)[0]).toBeGreaterThan(0);
    for (let y = 0; y < 96; y += 1) expect(at(21, y), `left column ${y}`).toEqual([0, 0, 0, 1]);
  }, 60_000);

  /*
   * THE SOURCE-SIZE GATE (T1422b). A one-pixel line and a 6 px disc of the same (hot)
   * radiance, far enough apart that the disc's column (its 6 px plus the resampling smear)
   * cannot reach the line's. Per pixel both clear the threshold and both streak; at Min Size
   * 3 the line fills a third of every 3 px square it touches and must vanish, while the
   * disc's inner pixels fill theirs and must still rise. 64 is sixteen times the dot above:
   * the gate counts area, so heat alone must not get a glint through.
   */
  const LINE = { x0: 16, x1: 32, y: 96 };
  const LINE_COLUMN = { x0: LINE.x0 - SMEAR_PX, x1: LINE.x1 + SMEAR_PX };
  const lineAndDisc = fixture(
    `${block(LINE.x0, LINE.y, LINE.x1, LINE.y + 1, 64)}
  if (distance(p + 0.5, vec2f(96.0, 96.0)) <= 3.0) { color = vec4f(vec3f(64.0), 1.0); }`,
  );

  it("Min Size 3: a one-pixel line does not streak, a 6 px disc of the same radiance does", async () => {
    requireDawn();
    const open = await render(graph("streak", { ...quiet, minSize: 0 }, lineAndDisc));
    const gated = await render(graph("streak", { ...quiet, minSize: 3 }, lineAndDisc));
    // Ungated, both rise: the gate, not the fixture, is what removes the line's column.
    expect(open(24, 80)[0]).toBeGreaterThan(0);
    expect(open(96, 80)[0]).toBeGreaterThan(0);
    // Gated: above the line, exactly the input (black) on every row, across its whole column.
    for (let y = 0; y < LINE.y; y += 1) {
      for (let x = LINE_COLUMN.x0; x < LINE_COLUMN.x1; x += 1) expect(gated(x, y), `above the line ${x},${y}`).toEqual([0, 0, 0, 1]);
    }
    // ...and the line itself is the picture, untouched by any glow of its own.
    for (let x = LINE.x0; x < LINE.x1; x += 1) expect(gated(x, LINE.y), `line ${x}`).toEqual([64, 64, 64, 1]);
    // The disc still streaks up its column.
    for (const y of [88, 80, 64]) expect(gated(96, y)[0], `disc column ${y}`).toBeGreaterThan(0);
  }, 60_000);

  it("Min Size 0 is the per-pixel threshold, bit for bit: the old extract", async () => {
    requireDawn();
    // The old extract, spelled independently: the picture thresholded per pixel in a fixture
    // and wired as the Bright input (which passes through untouched). 4 over threshold 1
    // extracts 4 x 3/4 = 3, exact in every float involved, so the two graphs must agree on
    // every pixel if Min Size 0 leaves the extract as it was.
    const picture = `${block(DOT.x0, DOT.y0, DOT.x1, DOT.y1, 4)}
  ${block(LINE.x0, LINE.y, LINE.x1, LINE.y + 1, 4)}`;
    const perPixel = `${block(DOT.x0, DOT.y0, DOT.x1, DOT.y1, 3)}
  ${block(LINE.x0, LINE.y, LINE.x1, LINE.y + 1, 3)}`;
    const now = await render(graph("streak", { ...quiet, minSize: 0 }, fixture(picture)));
    const old = await render(graph("streak", quiet, fixture(picture), { bright: fixture(perPixel) }));
    let lit = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        expect(now(x, y), `${x},${y}`).toEqual(old(x, y));
        if (now(x, y)[0] > 0) lit += 1;
      }
    }
    // Not vacuous: both columns are there to compare.
    expect(now(24, 80)[0]).toBeGreaterThan(0);
    expect(lit).toBeGreaterThan(500);
  }, 60_000);

  it("cuts striations across the column as the stripe function says, and tints it exactly", async () => {
    requireDawn();
    // A full-width bar, so the column covers every x and the grooves can be read along a row.
    const bar = fixture(block(0, 100, W, 104, 4));
    const tint = [1, 0.5, 0.25, 1];
    const flat = await render(graph("streak", { ...quiet, tint }, bar));
    const grooved = await render(graph("streak", { ...quiet, tint, striation: 1, striationScale: 9 }, bar));
    const stripe = (x: number): number => {
      const a = 0.5 + 0.5 * Math.sin(x * 6.2831853 + Math.sin(x * 0.37) * 3);
      const b = 0.5 + 0.5 * Math.sin(x * 2.618 * 6.2831853 + 1.3);
      return (a * 0.6 + b * 0.4) ** 1.6;
    };
    const y = 80;
    for (let x = 0; x < W; x += 1) {
      const plain = flat(x, y);
      const cut = grooved(x, y);
      // Tint is a per-channel multiply by a power of two: exact in half floats.
      expect(plain[1]).toBe(plain[0] / 2);
      expect(plain[2]).toBe(plain[0] / 4);
      // Groove depth: two half-float roundings (2^-11 each) plus f32 trig, so twice the regime.
      const expected = stripe(((x + 0.5) / W) * 9);
      expect(Math.abs(cut[0] / plain[0] - expected), `x ${x}`).toBeLessThanOrEqual(2 * TOLERANCE_CROSS_GPU_HDR);
    }
  }, 60_000);
});

/*
 * THE HALO. A 4x4 block of 8.0 centred at (64, 64). Radius 0.25 of the frame height is 32
 * pixels; width 0.03 is ±1.92 pixels. The ring is drawn at quarter size (a quarter texel is 4
 * pixels), so where it can land is smeared by: the dot's own footprint in the quarter-size
 * extract (it straddles four texels, half a texel from their centre each way: 0.71), the
 * ring's bilinear read (up to a texel each way: 1.41) and the add's bilinear read (1.41).
 */
const HALO = { threshold: 1, knee: 0.5, radius: 0.25, width: 0.03, dispersion: 0, gain: 1 };
const HALO_DOT = block(62, 62, 66, 66, 8);
const HALO_SMEAR_PX = (Math.SQRT1_2 + 2 * Math.SQRT2) * 4;
const HALO_INNER = Math.floor(32 - 0.015 * H - HALO_SMEAR_PX);
const HALO_OUTER = Math.ceil(32 + 0.015 * H + HALO_SMEAR_PX);
const distance = (x: number, y: number): number => Math.hypot(x + 0.5 - 64, y + 0.5 - 64);

describe("Halo on a real device (T1402b)", () => {
  it("draws a ring at the radius, and nothing inside it or beyond it", async () => {
    requireDawn();
    const at = await render(graph("halo", HALO, fixture(HALO_DOT)));
    const [inner, outer] = [HALO_INNER, HALO_OUTER];
    expect([inner, outer]).toEqual([15, 49]);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const d = distance(x, y);
        const inDot = x >= 62 && x < 66 && y >= 62 && y < 66;
        if (inDot) expect(at(x, y), `dot ${x},${y}`).toEqual([8, 8, 8, 1]);
        else if (d < inner || d > outer) expect(at(x, y), `off the ring ${x},${y}`).toEqual([0, 0, 0, 1]);
      }
    }
    // On the ring, in all four directions.
    for (const [x, y] of [[63, 31], [63, 96], [31, 63], [96, 63]] as const) expect(at(x, y)[1], `${x},${y}`).toBeGreaterThan(0);
  }, 60_000);

  it("splits the ring by dispersion: red peaks outside green, blue inside", async () => {
    requireDawn();
    const at = await render(graph("halo", { ...HALO, dispersion: 0.5 }, fixture(HALO_DOT)));
    // Walk straight up from the centre; each channel's ring peaks at its own radius.
    const peak = (channel: number): number => {
      let best = -1;
      let where = -1;
      for (let y = 0; y < 60; y += 1) {
        const value = at(63, y)[channel]!;
        if (value > best) {
          best = value;
          where = y;
        }
      }
      return 64 - where;
    };
    const [red, green, blue] = [peak(0), peak(1), peak(2)];
    expect(red).toBeGreaterThan(green);
    expect(green).toBeGreaterThan(blue);
    // At the red radius (1.25 r = 40 px) red outshines blue; at the blue radius (24 px) the reverse.
    expect(at(63, 64 - 40)[0]).toBeGreaterThan(at(63, 64 - 40)[2]);
    expect(at(63, 64 - 24)[2]).toBeGreaterThan(at(63, 64 - 24)[0]);
  }, 60_000);
});

/*
 * THE LENS. Analytic: the shader's own arithmetic, run in double precision here, against the
 * pixels. Everything but the knob under test is off, so each claim isolates one term.
 */
const LENS_OFF = { distortion: 0, edgeBlur: 0, swirl: 0, aberration: 0, zoomBlur: 0, vignette: 0, vignetteRound: 0 };
const LW = 160;
const LH = 100;
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

describe("Lens on a real device (T1402b)", () => {
  it("vignettes by the formula: centre untouched, corners darkened by the stated curve", async () => {
    requireDawn();
    const at = await render(graph("lens", { ...LENS_OFF, vignette: 0.8, vignetteRound: 0.9 }, fixture("color = vec4f(1.0);")), LW, LH);
    const aspect = LW / LH;
    const sx = 1 + (aspect - 1) * 0.9;
    const denom = 0.25 * (1 + (aspect * aspect - 1) * 0.9) + 0.25;
    for (let y = 0; y < LH; y += 9) {
      for (let x = 0; x < LW; x += 7) {
        const qx = ((x + 0.5) / LW - 0.5) * sx;
        const qy = (y + 0.5) / LH - 0.5;
        const expected = 1 * (1 + (1 - smoothstep(0.12, 1, (qx * qx + qy * qy) / denom) - 1) * 0.8);
        expectHdr(at(x, y)[0], expected, `vignette ${x},${y}`);
        expect(at(x, y)[3]).toBe(1);
      }
    }
    expect(at(0, 0)[0]).toBeLessThan(0.5);
  }, 60_000);

  it("barrel-distorts by the formula: each pixel reads the source at distort(uv)", async () => {
    requireDawn();
    const k = 0.2;
    const at = await render(graph("lens", { ...LENS_OFF, distortion: k }, fixture("color = vec4f(uv, 0.0, 1.0);")), LW, LH);
    const aspect = LW / LH;
    // The sampler clamps to the edge texels, whose centres hold the fixture's extreme values.
    const clamp = (v: number, n: number): number => Math.min(Math.max(v, 0.5 / n), 1 - 0.5 / n);
    let moved = 0;
    for (let y = 0; y < LH; y += 3) {
      for (let x = 0; x < LW; x += 3) {
        const u = (x + 0.5) / LW;
        const v = (y + 0.5) / LH;
        const cx = (u - 0.5) * aspect;
        const cy = v - 0.5;
        const f = 1 + k * (cx * cx + cy * cy);
        const sx = clamp((cx * f) / aspect / (1 + k * 0.25) + 0.5, LW);
        const sy = clamp((cy * f) / (1 + k * 0.25) + 0.5, LH);
        const pixel = at(x, y);
        // Absolute, against full scale: a linear ramp read through a bilinear sampler, with
        // one half-float rounding in the fixture and one in the output (2^-12 each, here).
        expect(Math.abs(pixel[0] - sx), `u at ${x},${y}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
        expect(Math.abs(pixel[1] - sy), `v at ${x},${y}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
        if (Math.abs(sx - u) > 0.01) moved += 1;
      }
    }
    // The claim is not vacuous: the corners really moved.
    expect(moved).toBeGreaterThan(100);
  }, 60_000);

  it("fringes the edges: red reads further out than blue, and the centre does not split", async () => {
    requireDawn();
    const at = await render(graph("lens", { ...LENS_OFF, aberration: 0.01 }, fixture("color = vec4f(vec3f(uv.x), 1.0);")), LW, LH);
    const right = at(150, 50);
    const left = at(9, 50);
    // uv.x grows to the right, so reading further OUT is larger on the right, smaller on the left.
    expect(right[0]).toBeGreaterThan(right[1]);
    expect(right[1]).toBeGreaterThan(right[2]);
    expect(left[0]).toBeLessThan(left[1]);
    expect(left[1]).toBeLessThan(left[2]);
    const centre = at(80, 50);
    expect(Math.abs(centre[0] - centre[2])).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR * centre[1]);
  }, 60_000);

  it("blurs the edges and not the centre, and zoom-blurs away from the zoom centre", async () => {
    requireDawn();
    // One-pixel vertical stripes: full contrast wherever nothing blurs.
    const stripes = fixture("color = vec4f(vec3f(f32(u32(p.x) % 2u)), 1.0);");
    const contrast = (at: (x: number, y: number) => Pixel, x: number, y: number): number =>
      Math.abs(at(x, y)[1] - at(x + 1, y)[1]);
    const edges = await render(graph("lens", { ...LENS_OFF, edgeBlur: 0.05, swirl: 0 }, stripes), LW, LH);
    expect(contrast(edges, 80, 50)).toBeGreaterThan(0.99);
    expect(contrast(edges, 2, 50)).toBeLessThan(0.5);
    // The zoom converges on pixel (80, 50)'s centre: that pixel keeps its exact value (0, an
    // even column), where anything smeared into it would lift it off zero.
    const zoom = await render(
      graph("lens", { ...LENS_OFF, zoomBlur: 0.2, zoomCentre: [80.5 / LW, 50.5 / LH] }, stripes),
      LW,
      LH,
    );
    expect(zoom(80, 50)[1]).toBe(0);
    expect(contrast(zoom, 140, 50)).toBeLessThan(0.5);
  }, 60_000);
});
