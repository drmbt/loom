import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { ENVIRONMENT_WGSL } from "../atmosphere.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { SKIN_ATTRIBUTES, skinKernel } from "../skin-kernel.ts";
import { SURFACE_WGSL } from "../surface.ts";
import { Chain, vec3 } from "./title-graph.ts";

/**
 * T1407b (closeups2) — THE END CARDS, rows 108–110 (the reference's 123.21–130.00 s):
 *
 *  - take 0 (row 108): "COCOON" in small, wide, spaced capitals on black, a thin hairline rising
 *    from each vertical stroke. Measured on the reference's 71 frames: the letters hold at 249;
 *    the C and O lines (~70/255, 145 px, climbing) fade out over the first 15 frames; the N's two lines
 *    (~150/255) climb to the top of the frame by frame 9, hold, then snap back to ~32 px at
 *    frame 16 and settle to ~11 px; the card strobes off at frames 49, 51 and 53 (52 and 54 flash
 *    the N's full lines back) and is black from 55.
 *  - take 1 (row 109): the credits. Three polaroids on dark concrete under two soft shafts of
 *    light from the top, a ten-line credit block at the right in small caps (placeholder handles,
 *    not the reference's names), the whole card floating a few pixels (±5 × ±9 px, the measured
 *    drift). The polaroids' photos are the figure, rendered here by three small Renders with a
 *    flash at the lens.
 *  - take 2 (row 110): black.
 *
 * The type is closeups2.py's `card.*` meshes (one millimetre = one pixel of the 1920 × 818 frame
 * through `shot.cocoon` / `shot.credits`), rendered white on black; the card passes compose in
 * display light and hand the Output linear light.
 */

/** A glyph run of the type: emissive white, nothing else. */
export const CARD_TYPE_WGSL = `struct Params {
  gain: f32, // @default 1  Radiance of the type.
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.emissive = vec3f(p.gain);
  o.roughness = 1.0;
  o.metallic = 0.0;
  return o;
}`;

const DISPLAY_TO_LINEAR = `fn toLinear(c: vec3f) -> vec3f {
  return select(pow((c + vec3f(0.055)) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}
fn toDisplay(c: vec3f) -> vec3f {
  return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - vec3f(0.055), c * 12.92, c <= vec3f(0.0031308));
}
fn grainAt(p: vec2f, t: f32) -> f32 {
  let q = fract(sin(dot(floor(p) + vec2f(t * 37.0, t * 91.0), vec2f(12.9898, 78.233))) * 43758.5453);
  return q - 0.5;
}`;

/**
 * COCOON: the type (Input, linear, the letters at 1), the hairlines drawn analytically over the
 * measured stroke positions, the timeline keyed on the frame, grain. Positions are reference
 * pixels (1920 × 818); the pass scales them to its own size.
 */
export const COCOON_WGSL = `struct Params {
  t: f32, // @default 0  The card's clock, seconds.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
${DISPLAY_TO_LINEAR}

// the hairlines' x (reference px): C, O (two), C, O (two), O (two), then the N's two
const LINES = array<f32, 10>(374.5, 591.5, 650.5, 811.5, 1028.5, 1087.5, 1249.5, 1307.5, 1471.0, 1524.0);
const BASE = 385.0;

fn hairline(p: vec2f, x: f32, len: f32, level: f32) -> f32 {
  let k = BASE - p.y;
  if (k < 0.0 || len <= 0.0) { return 0.0; }
  let across = exp(-(p.x - x) * (p.x - x) / (2.0 * 1.6 * 1.6));
  // brighter at the letter, easing off upward, a soft top
  let along = (0.6 + 0.4 * (1.0 - clamp(k / max(len, 1.0), 0.0, 1.0))) * smoothstep(len, len - 14.0, k);
  return level * across * along;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * vec2f(1920.0, 818.0);
  let f = floor(params.t * 24.0 + 0.001);
  // the strobe-off tail
  let off = f == 49.0 || f == 51.0 || f == 53.0 || f >= 55.0;
  var shown = select(1.0, 0.0, off);
  let type_ = toDisplay(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb).r * 0.976;
  // C and O: climbing from 145 px a little slower than the N, fading out over the first 15 frames
  let fade = clamp(1.0 - f / 15.0, 0.0, 1.0);
  var lines = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    lines = max(lines, hairline(p, LINES[i], min(145.0 + 23.0 * f, BASE), 0.29 * fade));
  }
  // N: climbing to the top by frame 9, holding, snapping back at 16 and settling;
  // the two flash frames (52, 54) throw the full lines back
  var nLen = 11.0 + 21.0 * exp(-(f - 16.0) / 7.0);
  if (f < 16.0) { nLen = min(145.0 + 27.5 * f, BASE); }
  if (f == 52.0 || f == 54.0) { nLen = BASE; }
  let nLevel = select(0.6, 0.45, f >= 16.0 && f != 52.0 && f != 54.0);
  lines = max(lines, hairline(p, LINES[8], nLen, nLevel));
  lines = max(lines, hairline(p, LINES[9], nLen, nLevel));
  let grain = grainAt(p, params.t) * 0.006;
  let display = clamp(max(type_, lines) * shown + grain + 0.002, 0.0, 1.0);
  return vec4f(toLinear(vec3f(display)), 1.0);
}`;

/**
 * The CREDITS card: Input = the credit type (linear white on black); More = the three photos.
 * Everything placed in reference pixels, measured on the reference's frame 30 of row 109.
 */
export const CREDITS_WGSL = `struct Params {
  t: f32, // @default 0  The card's clock, seconds.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
@group(0) @binding(6) var inputTexture3: texture_2d<f32>;
${DISPLAY_TO_LINEAR}

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 5; i = i + 1) {
    s = s + a * vnoise(q);
    q = q * 2.07 + vec2f(3.1, 1.7);
    a = a * 0.5;
  }
  return s;
}

// A polaroid: centre, half size, turn (radians). Returns the local point (px, the frame's own axes).
fn local(p: vec2f, c: vec2f, turn: f32) -> vec2f {
  let d = p - c;
  let cs = cos(turn);
  let sn = sin(turn);
  return vec2f(cs * d.x + sn * d.y, -sn * d.x + cs * d.y);
}
fn boxDist(q: vec2f, h: vec2f) -> f32 {
  let d = abs(q) - h;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

struct Layer {
  colour: vec3f,
  cover: f32,
  shadow: f32,
};

// the print: the white frame (a 21 px border, an 84 px chin), the photo in its window, washed
// toward the print's milky blacks; the sheen of the light shafts over its upper part
fn polaroid(p: vec2f, c: vec2f, half: vec2f, turn: f32, which: i32) -> Layer {
  var l: Layer;
  let q = local(p, c, turn);
  let d = boxDist(q, half);
  l.cover = clamp(0.5 - d, 0.0, 1.0);
  l.shadow = (1.0 - smoothstep(-4.0, 22.0, boxDist(q - vec2f(6.0, 10.0), half))) * 0.65;
  // the window, from the frame's top-left
  let tl = q + half;
  let win = vec2f(half.x * 2.0 - 42.0, half.x * 2.0 - 42.0);
  let wuv = (tl - vec2f(21.0, 21.0)) / win;
  let inWin = all(wuv >= vec2f(0.0)) && all(wuv <= vec2f(1.0));
  var paper = vec3f(0.5, 0.54, 0.555) * (0.92 + 0.08 * vnoise(p * 0.05));
  paper = paper * (0.85 + 0.25 * (1.0 - clamp(tl.y / (half.y * 2.0), 0.0, 1.0)));
  var colour = paper;
  if (inWin) {
    var photo = vec3f(0.0);
    if (which == 0) { photo = textureSampleLevel(inputTexture1, inputSampler, wuv, 0.0).rgb; }
    else if (which == 1) { photo = textureSampleLevel(inputTexture2, inputSampler, wuv, 0.0).rgb; }
    else { photo = textureSampleLevel(inputTexture3, inputSampler, wuv, 0.0).rgb; }
    let shown = toDisplay(photo);
    // a print: lifted blacks, softened whites, a cool cast
    colour = vec3f(0.085, 0.095, 0.105) + shown * vec3f(0.82, 0.86, 0.88);
  }
  l.colour = colour;
  return l;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(1920.0, 818.0);
  // the whole card floats: the measured drift, ±5 px across, ±9 px up and down
  let drift = vec2f(3.0 + 5.0 * sin(params.t * 2.9), 5.0 + 8.0 * sin(params.t * 3.2 - 0.1));
  let p = uv * size - drift;
  // concrete: mottled, flecked, a few cracks; lit from the left, falling to near black at the right
  let n = fbm(p * 0.012);
  let fleck = smoothstep(0.72, 0.9, vnoise(p * 0.35)) * 0.05 - smoothstep(0.75, 0.95, vnoise(p * 0.21 + vec2f(9.0))) * 0.05;
  let crack = smoothstep(0.012, 0.0, abs(fbm(p * 0.004 + vec2f(2.0, 5.0)) - 0.5)) * 0.06;
  let light = mix(0.2, 0.055, smoothstep(700.0, 1850.0, p.x)) * (1.0 - 0.35 * smoothstep(500.0, 818.0, p.y) * (1.0 - smoothstep(0.0, 600.0, p.x)));
  var colour = vec3f(0.93, 0.97, 1.02) * light * (0.78 + 0.45 * n) + vec3f(fleck) - vec3f(crack);
  // the polaroids, bottom to top: the right one, the left one, the front one
  let order = array<vec4f, 3>(vec4f(732.0, 273.0, 156.0, 190.0), vec4f(415.0, 288.0, 160.0, 196.0), vec4f(588.0, 548.0, 167.0, 190.0));
  let turns = array<f32, 3>(-0.14, 0.17, 0.0);
  let which = array<i32, 3>(1, 0, 2);
  for (var i = 0; i < 3; i = i + 1) {
    let pl = polaroid(p, order[i].xy, order[i].zw, turns[i], which[i]);
    colour = colour * (1.0 - pl.shadow * (1.0 - pl.cover));
    colour = mix(colour, pl.colour, pl.cover);
  }
  // two soft shafts of light from the top edge, fading down over the upper polaroids
  let shaft = exp(-pow((p.x - 300.0) / 55.0, 2.0)) + 0.8 * exp(-pow((p.x - 600.0) / 60.0, 2.0));
  colour = colour + vec3f(0.85, 0.92, 0.95) * shaft * 0.45 * (1.0 - smoothstep(0.0, 460.0, p.y)) * (0.9 + 0.1 * sin(params.t * 5.0));
  // the credit type: a cool grey, a touch of glow
  let type_ = toDisplay(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb).r;
  colour = mix(colour, vec3f(0.53, 0.54, 0.55), clamp(type_, 0.0, 1.0));
  // a faint vertical scratch down the block's left edge
  colour = colour + vec3f(0.03) * exp(-pow((p.x - 1070.0) / 1.2, 2.0)) * smoothstep(60.0, 200.0, p.y) * (1.0 - smoothstep(600.0, 760.0, p.y));
  // vignette, grain
  let v = uv - vec2f(0.5);
  colour = colour * (1.0 - 0.45 * dot(v * vec2f(1.0, 1.4), v * vec2f(1.0, 1.4)));
  colour = colour + vec3f(grainAt(uv * size, params.t) * 0.02);
  return vec4f(toLinear(clamp(colour, vec3f(0.0), vec3f(1.0))), 1.0);
}`;

export interface CardsOptions {
  readonly take?: number;
  readonly width?: number;
  readonly height?: number;
}

/** A still flash photo of the figure: a small Render of its own. Returns the Render's id. */
function photo(chain: Chain, facts: OnNothingFacts, id: string, y: number, spec: { readonly eye: readonly [number, number, number]; readonly aim: readonly [number, number, number]; readonly fov: number; readonly car: boolean; readonly bones: Readonly<Record<string, readonly [number, number, number]>> }): string {
  const fig = facts.areas.get("fig");
  if (fig === undefined) throw new Error("cardsDocument: no figure in the GLB.");
  const place: [number, number, number] = [0, 0, 1.3];
  const knobs: Record<string, StoredParameter> = {};
  for (const [bone, angles] of Object.entries(spec.bones)) knobs[bone] = [angles[0], angles[1], angles[2]];
  chain.add(`${id}Fig`, "meshFileIn", [-3600, y], { file: facts.glbUrl, select: fig.select, vertices: fig.vertices, triangles: fig.triangles, parts: fig.parts, joints: fig.joints });
  chain.add(`${id}Skin`, "pointKernel", [-3400, y], { capacity: fig.vertices, attributes: SKIN_ATTRIBUTES, kernel: skinKernel(facts), yaw: 0, place: vec3(place), ...knobs });
  chain.add(`${id}Geo`, "geometry", [-3200, y], { mode: "surface", material: "material_photosurf" }, { label: `geometry_${id.toLowerCase()}` });
  chain.link([`${id}Fig`, "out"], [`${id}Skin`, "in"]);
  chain.link([`${id}Skin`, "out"], [`${id}Geo`, "points"]);
  const scenes = [`geometry_${id.toLowerCase()}`];
  if (spec.car) {
    const car = facts.areas.get("car0");
    if (car === undefined) throw new Error("cardsDocument: no car0 in the GLB.");
    chain.add(`${id}Car`, "meshFileIn", [-3600, y + 100], { file: facts.glbUrl, select: car.select, vertices: car.vertices, triangles: car.triangles, parts: car.parts });
    chain.add(`${id}CarGeo`, "geometry", [-3200, y + 100], { mode: "surface", material: "material_photosurf" }, { label: `geometry_${id.toLowerCase()}car` });
    chain.link([`${id}Car`, "out"], [`${id}CarGeo`, "points"]);
    scenes.push(`geometry_${id.toLowerCase()}car`);
  }
  chain.add(`${id}Cam`, "camera", [-3000, y], { eye: vec3(spec.eye), lookAt: vec3(spec.aim), fov: spec.fov, near: 0.05, far: 60 }, { label: `camera_${id.toLowerCase()}` });
  // the flash: at the lens, a little above
  chain.add(`${id}Flash`, "light", [-3000, y + 50], { kind: "point", position: [spec.eye[0] + 0.1, spec.eye[1] + 0.15, spec.eye[2]], color: [1, 0.97, 0.94, 1], intensity: 3 });
  chain.add(`${id}Shot`, "render", [-2800, y], {
    scenes: scenes.join(" "),
    camera: `camera_${id.toLowerCase()}`,
    lights: `light_${id.toLowerCase()}flash`,
    projectors: "",
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: 0.02,
    background: [0.01, 0.01, 0.012, 1],
    antialias: "msaa",
    environmentIntensity: 0.15,
    environmentTaps: 16,
  }, { resolution: { mode: "fixed", width: 512, height: 512 } });
  chain.link(["photoEnv", "out"], [`${id}Shot`, "environment"]);
  return `${id}Shot`;
}

export function cardsDocument(facts: OnNothingFacts, options: CardsOptions): ProjectDocument {
  const take = options.take ?? 0;
  const width = options.width ?? 1920;
  const height = options.height ?? 818;
  const clock: StoredParameter = expressionSlot("abstime", 0);
  if (take === 2) {
    // row 110: black
    const chain = new Chain(["seed", "out"]);
    chain.add("seed", "ramp", [-600, 0], {}, { resolution: { mode: "fixed", width: 16, height: 16 } });
    // (a pass must bind the input it is handed; the seed is multiplied away)
    chain.pass("black", "@group(0) @binding(0) var inputSampler: sampler;\n@group(0) @binding(1) var inputTexture: texture_2d<f32>;\n@fragment\nfn fs(@location(0) uv: vec2f) -> @location(0) vec4f {\n  return vec4f(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb * 0.0, 1.0);\n}", {}, [], [-300, 0]);
    chain.add("out", "output", [0, 0], { toneMap: "none" }, { label: "output1" });
    chain.link(chain.last, ["out", "input"]);
    return chain.document("cards", width, height);
  }
  if (take !== 0 && take !== 1) throw new Error(`cardsDocument: no take ${take} (0 title, 1 credits, 2 black).`);
  const cameraName = take === 0 ? "shot.cocoon" : "shot.credits";
  const camera = facts.cameras.get(cameraName);
  const card = facts.areas.get("card");
  if (camera === undefined || card === undefined) throw new Error(`cardsDocument: the GLB has no ${cameraName} or card area (rebuild it with closeups2.py).`);
  const chain = new Chain(["type", "out"]);
  // the type, white on black, one millimetre to the pixel
  chain.add("typesurf", "materialWgsl", [-3000, -600], { model: "pbr", source: CARD_TYPE_WGSL, gain: 1 });
  chain.add("cardMesh", "meshFileIn", [-3600, 0], { file: facts.glbUrl, select: card.select, vertices: card.vertices, triangles: card.triangles, parts: card.parts }, { label: "mesh_card" });
  chain.add("cardGeo", "geometry", [-3200, 0], { mode: "surface", material: "material_typesurf" }, { label: "geometry_card" });
  chain.link(["cardMesh", "out"], ["cardGeo", "points"]);
  const d = 1.92 / 0.36;
  const aim = [camera.eye[0] + camera.forward[0] * d, camera.eye[1] + camera.forward[1] * d, camera.eye[2] + camera.forward[2] * d];
  chain.add("cam", "camera", [-2800, -300], { eye: vec3(camera.eye), lookAt: aim, fov: camera.fovDeg, near: 1, far: 20 }, { label: "camera1" });
  chain.add("envSeed", "ramp", [-3000, 300], {}, { resolution: { mode: "fixed", width: 64, height: 32 } });
  chain.add("typeEnv", "customWgsl", [-2800, 300], { source: ENVIRONMENT_WGSL, bars: 0, roof: 0, floor: 0 }, { resolution: { mode: "fixed", width: 64, height: 32 } });
  chain.link(["envSeed", "out"], ["typeEnv", "input"]);
  chain.add("type", "render", [-2600, 0], {
    scenes: "geometry_card",
    camera: "camera1",
    lights: "",
    projectors: "",
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: 0,
    background: [0, 0, 0, 1],
    antialias: "msaa",
    environmentIntensity: 0,
    environmentTaps: 4,
  }, { resolution: { mode: "project" } });
  chain.link(["typeEnv", "out"], ["type", "environment"]);
  if (take === 0) {
    chain.pass("cocoon", COCOON_WGSL, { t: clock }, [], [-2300, 0]);
  } else {
    // the three photos: the figure by flash, MCU with an arm up (left print), the chest and the
    // chain (right print), the full figure before the silver car's grille (front print)
    chain.add("photosurf", "materialWgsl", [-3000, 900], { model: "pbr", source: SURFACE_WGSL, headGain: 0.3 });
    chain.add("photoEnvSeed", "ramp", [-3000, 1000], {}, { resolution: { mode: "fixed", width: 256, height: 128 } });
    chain.add("photoEnv", "customWgsl", [-2800, 1000], { source: ENVIRONMENT_WGSL, bars: 1.5, roof: 0.01 }, { resolution: { mode: "fixed", width: 256, height: 128 } });
    chain.link(["photoEnvSeed", "out"], ["photoEnv", "input"]);
    const down = { upperarmL: [0, 0, -0.62], upperarmR: [0, 0, 0.62], forearmL: [-0.35, 0, 0], forearmR: [-0.35, 0, 0] } as const;
    const a = photo(chain, facts, "photoA", 1200, { eye: [0.35, 1.55, 2.3], aim: [0.0, 1.5, 1.3], fov: 32, car: false, bones: { ...down, upperarmR: [-0.6, 0, -1.4], forearmR: [-1.2, 0, 0], neck: [0.05, 0.3, 0], head: [-0.1, 0.2, 0] } });
    const b = photo(chain, facts, "photoB", 1600, { eye: [-0.1, 1.25, 2.1], aim: [0.0, 1.2, 1.3], fov: 34, car: false, bones: { ...down } });
    const c = photo(chain, facts, "photoC", 2000, { eye: [0.0, 1.2, 4.3], aim: [0.0, 1.0, 1.3], fov: 34, car: true, bones: { ...down, upperarmR: [-1.0, 0, -0.9], forearmR: [-1.9, 0, 0] } });
    chain.pass("credits", CREDITS_WGSL, { t: clock }, [[a, "out"], [b, "out"], [c, "out"]], [-2300, 0]);
  }
  chain.add("out", "output", [0, 0], { toneMap: "none" }, { label: "output1" });
  chain.link(chain.last, ["out", "input"]);
  return chain.document("cards", width, height);
}
