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
 * Film Grade and CRT on a real device (T1402b, §V147).
 *
 * The grade is checked END TO END against its own arithmetic run in double precision here:
 * every pixel of a fixture spanning three hues and an HDR exposure ramp, with every knob
 * off its default, so a term that moved (a curve constant, the warm test, the split's
 * weights) moves pixels this test reads. The input values are READ BACK from the fixture
 * rather than recomputed, so the only rounding between the two sides is the grade's own.
 * The CRT's claims are its defining ones: bypass is bitwise, the grille lights one channel
 * per column, the scanline profile is the stated Gaussian, and interlace shifts it.
 */

const W = 96;
const H = 60;
const FPS = 60;

const settings: ProjectSettings = {
  outputResolution: { width: W, height: H },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

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

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

function graph(type: string, parameters: Record<string, ParameterValue>, source: string): GraphDocument {
  return {
    revision: 1,
    nodes: {
      seed: node("seed", "solid", { color: [0, 0, 0, 1] }),
      fix: node("fix", "customWgsl", { source }),
      fx: node("fx", type, parameters),
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
type Frame = (x: number, y: number) => Pixel;

/** Renders `frames` frames and reads `nodeId`'s output on each. */
async function render(document: GraphDocument, nodeId: string, frames = 1): Promise<Frame[]> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document,
    settings,
    fps: FPS,
    frames,
    capture: Array.from({ length: frames }, (_, index) => index),
    outputNodeId: nodeId,
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.frames.map((frame) => {
    const pixels = decodeComponents(frame.bytes, frame.format);
    return (x: number, y: number): Pixel => {
      const at = (y * W + x) * 4;
      return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!, pixels[at + 3]!];
    };
  });
}

function expectHdr(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    TOLERANCE_CROSS_GPU_HDR * Math.max(Math.abs(expected), 2 ** -14),
  );
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t;
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const luma = (c: readonly number[]): number => c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);
const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

/*
 * FILM GRADE. Three bands of hue — neutral, a saturated warm (flare orange) and a saturated
 * cool — each over an exposure ramp from black to 6.0 linear.
 */
const GRADE = {
  exposure: 0.5,
  black: 0.05,
  contrast: 1.3,
  lift: 0.02,
  saturation: 0.3,
  keepWarm: 0.8,
  bleach: 0.5,
  highlightTint: [0.9, 1, 1.1, 1],
  shadowTint: [1.05, 1, 0.9, 1],
  split: 0.8,
  grain: 0,
};
const BANDS = `
  let v = (p.x + 0.5) / ${W}.0 * 6.0;
  let band = u32(p.y) / 20u;
  var hue = vec3f(1.0);
  if (band == 1u) { hue = vec3f(1.0, 0.35, 0.08); }
  if (band == 2u) { hue = vec3f(0.08, 0.4, 1.0); }
  color = vec4f(hue * v, 1.0);`;

/** FILM_GRADE_WGSL with grain 0, in double precision. */
function grade(input: Pixel, k: typeof GRADE): number[] {
  const hdr = [0, 1, 2].map((i) => Math.max(input[i]!, 0) * 2 ** k.exposure);
  const top = Math.max(...hdr);
  const chroma = (top - Math.min(...hdr)) / Math.max(top, 1e-4);
  const warm = smoothstep(0.35, 0.8, chroma) * (hdr[0]! >= hdr[2]! ? 1 : 0);
  const keep = mix(k.saturation, Math.max(k.saturation, k.keepWarm), warm);
  const hable = (x: number): number => {
    const [a, b, c, d, e, f] = [0.15, 0.5, 0.1, 0.2, 0.02, 0.3];
    return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f;
  };
  let c = hdr.map((x) => clamp01(hable(x * 2) / hable(11.2)) ** (1 / 2.2));
  const y0 = luma(c);
  c = c.map((v) => mix(y0, v, keep));
  const y = luma(c);
  c = c.map((v) => mix(v, v < 0.5 ? 2 * v * y : 1 - 2 * (1 - v) * (1 - y), k.bleach));
  c = c.map((v) => clamp01((v - 0.45) * k.contrast + 0.45));
  c = c.map((v) => clamp01((v - k.black) / Math.max(1 - k.black, 1e-4)));
  const yl = luma(c);
  const upper = smoothstep(0.35, 0.8, yl) * (1 - smoothstep(0.9, 1, yl));
  const low = 1 - smoothstep(0, 0.3, yl);
  c = c.map((v, i) => v * mix(1, k.highlightTint[i]!, upper * k.split) * mix(1, k.shadowTint[i]!, low * k.split));
  c = c.map((v) => v + k.lift * (1 - v));
  return c.map((v) => clamp01(v) ** 2.2);
}

describe("Film Grade on a real device (T1402b)", () => {
  it("grades every pixel as its arithmetic says: curve, crush, keep-warm, bleach, split, lift", async () => {
    requireDawn();
    const document = graph("filmGrade", GRADE, fixture(BANDS));
    const [input] = await render(document, "fix");
    const [output] = await render(document, "fx");
    for (let y = 5; y < H; y += 20) {
      for (let x = 0; x < W; x += 1) {
        const expected = grade(input!(x, y), GRADE);
        const pixel = output!(x, y);
        for (let channel = 0; channel < 3; channel += 1) expectHdr(pixel[channel]!, expected[channel]!, `${x},${y}[${channel}]`);
        expect(pixel[3]).toBe(1);
      }
    }
    // The property the knob exists for, read off the same pixels: at equal exposure the warm
    // flare keeps its colour and the cool source goes grey.
    const warm = output!(70, 25);
    const cool = output!(70, 45);
    expect((warm[0] - warm[2]) / warm[1]).toBeGreaterThan(2 * ((cool[2] - cool[0]) / cool[1]));
  }, 60_000);

  it("grains a new pattern every frame, and none at all at zero", async () => {
    requireDawn();
    const grey = fixture("color = vec4f(vec3f(0.4), 1.0);");
    const still = await render(graph("filmGrade", { ...GRADE, grain: 0 }, grey), "fx", 2);
    const grainy = await render(graph("filmGrade", { ...GRADE, grain: 0.1 }, grey), "fx", 2);
    let changed = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        expect(still[1]!(x, y)).toEqual(still[0]!(x, y));
        if (grainy[1]!(x, y)[0] !== grainy[0]!(x, y)[0]) changed += 1;
      }
    }
    // A fresh hash per frame moves nearly every grain; a frozen pattern would move none.
    expect(changed).toBeGreaterThan((W * H) / 2);
  }, 60_000);
});

/*
 * CRT. Left half 1.0, right half 0.25: the scanline profile depends on brightness, so both
 * widths are read. Everything not under test is off.
 */
const CRT_OFF = { amount: 1, lines: 15, curvature: 0, mask: 0, maskPitch: 3, glow: 0, jitter: 0, gain: 1 };
const HALVES = `color = vec4f(vec3f(select(0.25, 1.0, p.x < ${W / 2}.0)), 1.0);`;

/** CRT_WGSL's tube on a flat field with mask and glow off: c × beam × corner × flicker. */
function scan(x: number, y: number, c: number, lines: number, jitter: number, frame: number): number {
  const u = (x + 0.5) / W;
  const v = (y + 0.5) / H;
  const field = frame % 2;
  const line = v * lines + field * jitter;
  const off = line - Math.floor(line) - 0.5;
  const sigma = mix(0.18, 0.42, Math.sqrt(clamp01(c)));
  const beam = Math.exp(-(off * off) / (2 * sigma * sigma));
  const flicker = 1 - 0.015 * Math.sin((frame / FPS) * 60);
  const corner = smoothstep(0, 0.02, Math.min(u, 1 - u, v, 1 - v));
  return c * beam * flicker * corner;
}

describe("CRT on a real device (T1402b)", () => {
  it("at amount 0 hands the input through bit for bit", async () => {
    requireDawn();
    const document = graph("crt", { ...CRT_OFF, amount: 0, curvature: 0.3, mask: 1 }, fixture(HALVES));
    const [input] = await render(document, "fix");
    const [output] = await render(document, "fx");
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) expect(output!(x, y)).toEqual(input!(x, y));
  }, 60_000);

  it("draws scanlines whose Gaussian widens with brightness, exactly as stated", async () => {
    requireDawn();
    const [output] = await render(graph("crt", CRT_OFF, fixture(HALVES)), "fx");
    for (let y = 0; y < H; y += 1) {
      for (const [x, c] of [[10, 1], [30, 1], [60, 0.25], [85, 0.25]] as const) {
        expectHdr(output!(x, y)[1]!, scan(x, y, c, 15, 0, 0), `${x},${y}`);
      }
    }
  }, 60_000);

  it("shifts the lines on the odd field by the jitter", async () => {
    requireDawn();
    const frames = await render(graph("crt", { ...CRT_OFF, jitter: 0.5 }, fixture(HALVES)), "fx", 2);
    let moved = 0;
    for (let y = 0; y < H; y += 1) {
      for (const frame of [0, 1]) expectHdr(frames[frame]!(20, y)[1]!, scan(20, y, 1, 15, 0.5, frame), `frame ${frame} row ${y}`);
      if (Math.abs(frames[1]!(20, y)[1]! / frames[0]!(20, y)[1]! - 1) > 0.05) moved += 1;
    }
    // Not only the flicker (a percent or so on every row): the profile itself moved.
    expect(moved).toBeGreaterThan(H / 4);
  }, 60_000);

  it("lights one phosphor per column through a full-depth grille, and bends the corners to black", async () => {
    requireDawn();
    const [output] = await render(graph("crt", { ...CRT_OFF, mask: 1, curvature: 0.2 }, fixture("color = vec4f(1.0);")), "fx");
    for (let x = 10; x < W - 10; x += 1) {
      const pixel = output!(x, H / 2);
      const lit = x % 3;
      for (let channel = 0; channel < 3; channel += 1) {
        if (channel === lit) expect(pixel[channel], `x ${x} lit`).toBeGreaterThan(0.5);
        else expect(pixel[channel], `x ${x} dark ${channel}`).toBe(0);
      }
    }
    expect(output!(0, 0).slice(0, 3)).toEqual([0, 0, 0]);
  }, 60_000);
});

/*
 * CRT TUBE (T1423b). A white picture on a nearly flat tube (curvature radius 1e6 mm) faced
 * square-on by a pinhole (aperture 0), 400 mm away, with a 10.71° field: the visible face is
 * 2 · 400 · tan(5.355°) · 1.6 = 120 mm wide at the glass, and the phosphor 12 mm behind the
 * faceplate is seen through it, so about (400 + 12 / 1.52) / 400 × 120 = 122.4 mm of phosphor
 * fills the 96 columns. At 40 triads across the 400 mm face that is 12.24 triads: the red
 * stripes repeat every 7.84 px, and the red channel's strongest frequency along a row is bin
 * 12 of a 96-point DFT. The picture is shown as itself (invert 0), then as a negative, where a
 * white picture lights nothing but the unlit glow.
 */
const TUBE = {
  tubeSize: [400, 300],
  curvature: 1_000_000,
  glass: 12,
  lines: 480,
  triads: 40,
  aim: [0.5, 0.5],
  distance: 400,
  pitch: 0,
  yaw: 0,
  roll: 0,
  fov: 2 * Math.atan(0.09375) * (180 / Math.PI),
  aperture: 0,
  focus: 0,
  grille: 0.75,
  halation: 0,
  invert: 0,
  contrast: 1,
  pivot: 0.5,
  unlit: 0,
  reflection: 0,
  lift: 0,
  grain: 0,
};
const WHITE = `color = vec4f(1.0);`;

/** |DFT| of a row, bins 1 .. n/2 (the DC term dropped). */
function spectrum(row: readonly number[]): number[] {
  const n = row.length;
  const out: number[] = [];
  for (let k = 1; k <= n / 2; k += 1) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      re += row[i]! * Math.cos((2 * Math.PI * k * i) / n);
      im -= row[i]! * Math.sin((2 * Math.PI * k * i) / n);
    }
    out.push(Math.hypot(re, im));
  }
  return out;
}

describe("CRT Tube on a real device (T1423b)", () => {
  it("draws the aperture grille at the pitch the tube's triads and the lens's field say", async () => {
    requireDawn();
    const [at] = await render(graph("crtTube", TUBE, fixture(WHITE)), "fx");
    for (const channel of [0, 1, 2] as const) {
      const row = Array.from({ length: W }, (_, x) => at!(x, H / 2)[channel]);
      const power = spectrum(row);
      const strongest = power.indexOf(Math.max(...power)) + 1;
      expect(strongest, `channel ${channel}`).toBe(12);
    }
  }, 60_000);

  it("shows a white picture as white, and as a negative lights nothing but the unlit glow", async () => {
    requireDawn();
    const mean = (frame: Frame): number => {
      let sum = 0;
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) sum += luma(frame(x, y));
      return sum / (W * H);
    };
    const [positive] = await render(graph("crtTube", TUBE, fixture(WHITE)), "fx");
    const [negative] = await render(graph("crtTube", { ...TUBE, invert: 1 }, fixture(WHITE)), "fx");
    const [glowing] = await render(graph("crtTube", { ...TUBE, invert: 1, unlit: 0.05 }, fixture(WHITE)), "fx");
    expect(mean(positive!)).toBeGreaterThan(0.1);
    // Inverted white is black on the tube: no phosphor lit, no halation, no room, no grain, no lift.
    expect(mean(negative!)).toBe(0);
    // ...and the unlit glow is all that shows.
    expect(mean(glowing!)).toBeGreaterThan(0);
    expect(mean(glowing!)).toBeLessThan(mean(positive!));
  }, 60_000);
});
