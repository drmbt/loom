import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { edge, node as buildNode } from "../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1407b (grade) — THE FINISH: one small last pass every shot gets, so the whole film sits in
 * the reference's look — hazier and more washed than a clean render: lifted grey blacks, a
 * softer curve, a mist of glow round the lights, a neutral-to-cyan cast in the shadows and
 * mids, and one grain.
 *
 * Measured per part against the reference over the first minute (rows 1-62), see
 * docs/on-nothing-grade-2026-09-28.md; `FINISH` below is the fit. It runs AFTER each shot's
 * own grade (which tone maps), on linear display light, so it cannot be a second Film Grade:
 * the stock node always applies its Hable curve, which would tone map twice. Stock Blur does
 * the glow; the rest is one Custom WGSL pass.
 *
 *   frame ─┬──────────────────────────────────┐
 *          └─ finishDown (480 wide) ─ finishNear (Blur) ─ finishWide (Blur)
 *                                         │                  │
 *                                   finish (mist, curve, band tint, saturation, grain) ─ out
 *
 * The glow runs at a FIXED 480 × 204, so its reach is the same share of the frame at a 960
 * draft and a 3840 --final (a Blur's size is in pixels of its input).
 *
 * GRAIN: the finish owns the film's grain. Every other grain in the graph (the shot grades'
 * own) is set to 0 here, and `grain` / `grainSize` on the finish follow the grade's formula,
 * so render.ts lifts it after the accumulation under --final (T1432b) exactly as it did theirs.
 *
 * `withFinish` is applied once, by onNothingDocument's dispatch; a plate (another shot's
 * graph built for a composite) is finished by the shot that composites it, never on its own.
 * Per-row overrides: edl.json `args`, `--set finish.lift=0.04`.
 */

/** Downsample to this node's own (fixed) size: a 4 × 4 bilinear box over each output texel's footprint. */
export const FINISH_DOWN_WGSL = `struct Params {
  gain: f32, // @default 1  Scales the downsampled picture.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  // one output texel's footprint in uv
  let foot = vec2f(abs(dpdx(uv).x), abs(dpdy(uv).y));
  var sum = vec3f(0.0);
  for (var j = 0; j < 4; j = j + 1) {
    for (var i = 0; i < 4; i = i + 1) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / 4.0 - 0.5;
      sum = sum + max(textureSampleLevel(inputTexture, inputSampler, uv + o * foot, 0.0).rgb, vec3f(0.0));
    }
  }
  return vec4f(sum / 16.0 * params.gain, 1.0);
}`;

export const FINISH_WGSL = `struct Params {
  mist: f32, // @default 0  Share of the near glow mixed into the picture (halation, bloom), in linear light.
  mistWide: f32, // @default 0  Share of the wide glow mixed in: the haze veil that lifts the dark round every light.
  toe: f32, // @default 1  Gamma on display level before the curve (< 1 opens the shadows).
  contrast: f32, // @default 1  Slope around the pivot (< 1 is flatter).
  pivot: f32, // @default 0.45  Display level the contrast turns about.
  lift: f32, // @default 0  Where black lands (display level): the flat veil.
  white: f32, // @default 1  Where white lands (display level): the washed top.
  saturation: f32, // @default 1  Chroma kept in the mids and highlights.
  shadowSaturation: f32, // @default 1  Chroma kept in the shadows.
  shadowTint: vec3f, // @default 0  Added to the shadows (display level).
  midTint: vec3f, // @default 0  Added to the mids.
  highlightTint: vec3f, // @default 0  Added to the highlights.
  grain: f32, // @default 0  Grain amount (the grade's formula: heavier in the blacks, a new pattern every frame).
  grainSize: f32, // @default 1.3  Grain cell size in pixels of the render.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;

// More textures are bound unfilterable: bilinear by hand.
fn bilerp(t: texture_2d<f32>, uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(t));
  let p = uv * size - 0.5;
  let i = floor(p);
  let f = p - i;
  let hi = vec2i(size) - vec2i(1);
  let a = vec2i(i);
  let c00 = textureLoad(t, clamp(a, vec2i(0), hi), 0).rgb;
  let c10 = textureLoad(t, clamp(a + vec2i(1, 0), vec2i(0), hi), 0).rgb;
  let c01 = textureLoad(t, clamp(a + vec2i(0, 1), vec2i(0), hi), 0).rgb;
  let c11 = textureLoad(t, clamp(a + vec2i(1, 1), vec2i(0), hi), 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

// The Output encodes sRGB, so "display level" here is exactly the sRGB value the viewer sees
// (a 2.2 power instead put a 0.022 lift at level 1 of 255, not 5.6: the toes part ways near black).
fn toDisplay(l: vec3f) -> vec3f {
  return select(1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, 12.92 * l, l <= vec3f(0.0031308));
}

fn toLinear(d: vec3f) -> vec3f {
  return select(pow((d + 0.055) / 1.055, vec3f(2.4)), d / 12.92, d <= vec3f(0.04045));
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn grainHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let lin = max(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb, vec3f(0.0));
  let near = bilerp(inputTexture1, uv);
  let wide = bilerp(inputTexture2, uv);
  // the mist, in linear light: the lights' glow and the veil round them
  let m = lin * (1.0 - params.mist - params.mistWide) + near * params.mist + wide * params.mistWide;
  // the curve, on display level: toe, contrast about the pivot, then black and white land
  var c = pow(clamp(toDisplay(max(m, vec3f(0.0))), vec3f(0.0), vec3f(1.0)), vec3f(params.toe));
  c = clamp(params.pivot + (c - params.pivot) * params.contrast, vec3f(0.0), vec3f(1.0));
  c = params.lift + (params.white - params.lift) * c;
  // tone bands: a tint added to each
  let y0 = luma(c);
  let ws = 1.0 - smoothstep(0.04, 0.22, y0);
  let wh = smoothstep(0.35, 0.75, y0);
  let wm = clamp(1.0 - ws - wh, 0.0, 1.0);
  c = c + ws * params.shadowTint + wm * params.midTint + wh * params.highlightTint;
  let y = luma(c);
  c = vec3f(y) + (c - vec3f(y)) * mix(params.saturation, params.shadowSaturation, ws);
  // the film's one grain (render.ts adds it after the accumulation under --final, T1432b)
  let px = floor(uv * frameU.resolution / max(params.grainSize, 0.5));
  let n = grainHash(vec3f(px, frameU.absFrame)) + grainHash(vec3f(px + 17.0, frameU.absFrame * 1.7)) - 1.0;
  c = c + vec3f(n) * params.grain * (0.35 + 0.65 * (1.0 - luma(c)));
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  return vec4f(toLinear(c), 1.0);
}`;

/** The glow's working size: a fixed share of the frame at any render width. */
const GLOW_SIZE = { width: 480, height: 204 } as const;

/** The global finish, fitted to the reference (docs/on-nothing-grade-2026-09-28.md). */
export const FINISH = {
  // the glows' Blur sizes, in pixels of the 480-wide glow (a Blur's sigma is half its size): ~16 and ~100 px at 1920
  near: 4,
  wide: 24,
  // the ring 8-24 px round the highlights, as a share of their level: ref 0.35, ours 0.40 before and 0.44
  // with the toe alone (a dim ring gains more than its hot core), so no near mist; 24-56 px: ref 0.26,
  // ours 0.17 before, 0.27 with this wide veil
  mist: 0,
  mistWide: 0.02,
  // p2 / p10 / p50 / p90 / p98 over the non-flash parts: ref 7 / 9 / 23 / 127 / 196, ours 0.9 / 1 / 2.5 / 74 / 159.
  // The blacks and the dark voids go most of the way (the lift lands ~2.5 levels lower after the grain
  // and the H.264 encode); the mids only part way, and the whites come DOWN: the quantile fit's full
  // mid gain (toe 0.55) brightened the car bodies the owner wants murkier.
  toe: 0.8,
  contrast: 0.95,
  pivot: 0.45,
  lift: 0.023,
  white: 0.9,
  // band chroma and (Cb, Cr): shadows ref 2.4 (+0.3, -0.5), mids 9.4 (+0.7, -1.4), highlights 9.7 (-0.7, -2.8)
  saturation: 1.45,
  shadowSaturation: 1.5,
  shadowTint: [-0.005, 0.0012, 0.0032],
  midTint: [-0.0111, 0.0026, 0.0074],
  highlightTint: [-0.0065, 0.0034, -0.0147],
  // one grain, coarser and far lighter than the shot grades' 0.03 at 1.3 px: the reference's own
  // high-pass texture is 0.3 levels (fine) and 0.3 (coarse) against ours 2.4 and 1.6
  grain: 0.006,
  grainSize: 4,
} as const;

/** A node that carries grain of its own: a Film Grade, or a Custom WGSL grade declaring `grain`. */
function carriesGrain(entry: GraphNode): boolean {
  if (entry.type === "filmGrade") return true;
  const source = entry.parameters["source"];
  return (entry.type === "customWgsl" || entry.type === "customWgslMulti") && typeof source === "string" && /\bgrain\s*:\s*f32/.test(source);
}

/** The document with THE FINISH between its last pass and its Output (`out`). */
export function withFinish(document: ProjectDocument): ProjectDocument {
  const nodes: Record<string, GraphNode> = { ...document.graph.nodes };
  const edges: Record<string, GraphEdge> = { ...document.graph.edges };
  if (nodes["look"] !== undefined) throw new Error("withFinish: this document is finished already.");
  const out = nodes["out"];
  const into = Object.values(edges).find((entry) => entry.target.nodeId === "out" && entry.target.portId === "input");
  if (out === undefined || into === undefined) throw new Error("withFinish: the document has no Output `out` fed on its input.");
  // the finish owns the grain: every other grain in the graph goes to 0
  for (const [id, entry] of Object.entries(nodes)) {
    if (carriesGrain(entry)) nodes[id] = { ...entry, parameters: { ...entry.parameters, grain: 0 } };
  }
  const { x, y } = out.position;
  const from = [into.source.nodeId, into.source.portId] as const;
  const { near, wide, ...look } = FINISH;
  const params: Record<string, StoredParameter> = { source: FINISH_WGSL, ...Object.fromEntries(Object.entries(look).map(([key, value]) => [key, Array.isArray(value) ? [...(value as readonly number[])] : value])) };
  const add = (entry: GraphNode): void => {
    nodes[entry.id] = entry;
  };
  add(buildNode("lookDown", "customWgsl", [x, y + 300], { source: FINISH_DOWN_WGSL }, { label: "wgsl_lookdown", resolution: { mode: "fixed", ...GLOW_SIZE } }));
  add(buildNode("lookNear", "blur", [x + 250, y + 300], { size: near }, { label: "blur_looknear" }));
  add(buildNode("lookWide", "blur", [x + 500, y + 300], { size: wide }, { label: "blur_lookwide" }));
  add(buildNode("look", "customWgslMulti", [x + 750, y], {}, { label: "wgsl_look", resolution: { mode: "project" }, parameters: params }));
  nodes["out"] = { ...out, position: { x: x + 1050, y } };
  delete edges[into.id];
  for (const entry of [
    edge("look-down", from, ["lookDown", "input"]),
    edge("look-near", ["lookDown", "out"], ["lookNear", "input"]),
    edge("look-wide", ["lookNear", "out"], ["lookWide", "input"]),
    edge("look-in", from, ["look", "input"]),
    edge("look-more-near", ["lookNear", "out"], ["look", "more"], 0),
    edge("look-more-wide", ["lookWide", "out"], ["look", "more"], 1),
    edge("look-out", ["look", "out"], ["out", "input"]),
  ]) {
    edges[entry.id] = entry;
  }
  return { ...document, graph: { ...document.graph, nodes, edges } };
}
