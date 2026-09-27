import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import type { ParameterSlot } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { BRIGHT_PASS_WGSL } from "../../furnace/post.ts";
import { CAMERA_PARAMS, DOF_WGSL, GTAO_WGSL, VIEW } from "../../furnace/screen-space.ts";
import { ENVIRONMENT_HDRI_WGSL, ENVIRONMENT_WGSL, HEADLIGHT_COOKIE_WGSL, hazeLights, hazeWgsl } from "../atmosphere.ts";
import { CRT_WGSL, GRADE_WGSL } from "../fx.ts";
import { GLOSSY_SSR_WGSL } from "../reflections.ts";
import type { Area, OnNothingFacts } from "../scene-facts.ts";
import { GLASS_COMPOSITE_WGSL, LAMP_GLASS_WGSL, OCCLUDER_WGSL, SURFACE_WGSL } from "../surface.ts";
import { Chain, type Port, cameraParams, easeOut, smooth, vec3 } from "./title-graph.ts";
import { handheld } from "./handheld.ts";
import { REACT_PROFILES, flicker } from "./react.ts";

/**
 * T1407b (title) — THE TITLE SHOT, the reference's 0:00–0:01.6, built from what its frames
 * measure (renders/on-nothing/agents/title/ holds the side-by-sides):
 *
 *  - 0.00–0.31 s (frames 1–8): a close, dark pass across the hero's headlight that WHIPS away
 *    — the camera yawing left, pitching down and rolling, faster every frame (the content
 *    travels 150, 350, 450 px a frame, then the frame is nothing but smear) — and a hard cut.
 *  - 0.33 s (frame 9) on: the chrome script held over the matte grille from a metre, a wide
 *    lens bowed hard at the edges, landing with the whip's momentum: a 6.5 % push-in that
 *    settles by frame 27, the camera sinking 4–5 cm round the grille (the roof rises 45 px
 *    against it), a slow drift right (17 px, frames 18–36), a roll through −0.5° to +1°, and
 *    from frame 30 a tilt up into the next move. Owner, 2026-09-27: much more handheld, with
 *    rotations, on top.
 *
 * The flanking white cars stand closer than the tableau's (their wheels sit at the frame's
 * edges, ~40° off axis): the title moves them there itself (a Transform per car), so the
 * tableau's layout is untouched. Streaks turn with the camera's roll (the reference's rise
 * off the headlights tilt with the frame in the whip), and the lens has depth of field.
 */

const FPS = 24;
/**
 * The switch from the whip to the title: on the boundary between frames 8 and 9, a hair before
 * frame 9's own instant, so a frame rendered as sub-frames (render.ts --final: 8 a frame, at
 * k/192 s) never mixes the two shots — every sub-frame of frame 8 is whip, of frame 9 title.
 */
const CUT = 7.99 / FPS;
/** Frame 9, where the title's own move starts (τ = 0). */
const LAND = 8 / FPS;
/** The motion blur's derivative step, seconds (the camera path is differentiated, not differenced a frame apart). */
const EPS = 0.004;

type V3 = readonly [number, number, number];

/** 0 before the cut, 1 from it on: a hard step (100 µs wide), not a blend of the two shots. */
const cutGate = (t: string): string => `clamp((${t} - ${CUT.toFixed(7)}) * 100000, 0, 1)`;
/**
 * The time the motion blur differentiates back to: EPS earlier, but never across the cut — the
 * landing's first frame differentiated into the whip read a 40° swing and smeared the grille.
 */
const PREVIOUS_T = `(abstime - ${EPS} + ${cutGate("abstime")} * max(0, ${(CUT + 1e-5).toFixed(7)} - abstime + ${EPS}))`;

/** The title's framing at τ = 0 (glTF: x right, y up, +z toward the camera; the hero's nose at z ≈ 0). */
const EYE: V3 = [0, 0.72, 0.7];
const AIM: V3 = [0, 0.87, -0.03];
/** Vertical fov of the RENDER, degrees — the lens then bows it (DISTORTION), magnifying the centre. */
const FOV = 62;
/** Where the script's strokes stand (glTF z), for the focus. */
const SCRIPT_Z = 0.04;
/** Barrel distortion of the title's lens (TITLE_LENS_WGSL `k`). */
const DISTORTION = 0.2;

/** The whip's first frame: low at the hero's nose, looking across its headlight to the right. */
const WHIP_EYE: V3 = [0.3, 0.74, 0.95];
const WHIP_HEADING = 0.42; // radians right of straight at the car
const WHIP_PITCH = 0.14;

/** Where the flanking cars stand for the title (glTF translation of their whole area). */
/**
 * Where the flanking cars' FRONTS stand for the title (the midpoint of their headlight markers,
 * glTF x and z). The move is computed from wherever the build put the car, so a change to the
 * tableau's layout (build.py CARS) does not carry the title's cars away with it.
 */
const FRONTS: Partial<Record<Area, readonly [number, number]>> = {
  // the white SUV left: its front ~1.1 m behind the hero's, its flank ~0.9 m clear of it
  car1: [-3.85, -1.13],
  // the white saloon right, on turbine wheels (the Maybach S), pulled up from the back row
  car3: [3.72, -0.97],
};

/** The glTF translation that brings each flanking car's front to FRONTS. */
function placements(facts: OnNothingFacts): Partial<Record<Area, V3>> {
  const out: Partial<Record<Area, V3>> = {};
  for (const [area, target] of Object.entries(FRONTS) as [Area, readonly [number, number]][]) {
    const n = area.slice(3);
    const pair = [facts.markers.get(`lamp.head.${n}l`), facts.markers.get(`lamp.head.${n}r`)];
    if (pair[0] === undefined || pair[1] === undefined) throw new Error(`titleDocument: no headlight markers for ${area}.`);
    const x = (pair[0].position[0] + pair[1].position[0]) / 2;
    const z = (pair[0].position[2] + pair[1].position[2]) / 2;
    out[area] = [target[0] - x, 0, target[1] - z];
  }
  return out;
}
const TITLE_CARS: readonly Area[] = ["car0", "car1", "car3"];

/** The high-bays under the trusses behind the hero (glTF metres; the trusses run across x every 5 m of z). */
const HIGH_BAYS: readonly V3[] = [[-3.5, 6.6, -5], [3, 6.6, -5], [-1, 6.6, -10], [5.5, 6.6, -10], [-6, 6.6, -10]];
const BAY_INTENSITY = 6;
/** How much of their light the haze scatters. */
const BAY_HAZE = 0.6;

/**
 * The operator after the cut: the horizon lands tilted and eases level-ish over a second (the
 * reference's roll runs -0.5° to +1°; the owner asked for a visible tilt settling), with a
 * light shake — the camera is a metre from the grille, where the tableau's 1.0 would swing it.
 */
const OPERATOR = { tiltIn: -2.8, tilt: 0.8, settle: 1.0, shake: 0.22, creep: 0.02 } as const;

interface Path {
  readonly eye: readonly [string, string, string];
  readonly aim: readonly [string, string, string];
  readonly roll: string;
  readonly fov: string;
}

/**
 * The camera at time `t` (an expression). Evaluated twice: at `abstime` for the Camera, and a
 * hair earlier for the motion blur's previous camera, so the blur is the path's own velocity.
 */
function titlePath(t: string): Path {
  // ── The whip (frames 1–8): ψ grows 3.4 t + 60 t³ radians — 8°, 10°, 13°, 17°, 23° … a frame.
  const psi = `(2.5 * ${t} + 64 * ${t} ^ 3)`;
  const heading = `(${WHIP_HEADING} - ${psi} * 0.82)`;
  const pitch = `(${WHIP_PITCH} - ${psi} * 0.42)`;
  const whipEye = [`${WHIP_EYE[0]} - ${t} * 0.4`, `${WHIP_EYE[1]} - ${t} * 0.1`, `${WHIP_EYE[2]}`];
  const whipAim = [
    `${whipEye[0]} + sin(${heading}) * cos(${pitch})`,
    `${whipEye[1]} + sin(${pitch})`,
    `${whipEye[2]} - cos(${heading}) * cos(${pitch})`,
  ];
  const whipRoll = `(${psi} * 22)`;

  // ── The title (frame 9 on), τ from frame 9.
  const tau = `(${t} - ${LAND.toFixed(6)})`;
  const settle = easeOut(`${tau} / 0.75`);
  const drift = smooth(`(${tau} - 0.3) / 0.9`);
  const rise = smooth(`(${tau} - 0.85) / 0.5`);
  // The shared handheld operator (shots/handheld.ts: a Dutch tilt easing in, sway, wander and
  // rotational wobble), re-timed to start at the cut: its expressions read τ for abstime.
  const op = handheld(EYE, AIM, OPERATOR);
  const held = (key: string): string => {
    const slot = op[key] as ParameterSlot;
    const expression = slot.bindings.expression;
    if (expression?.kind !== "expression") throw new Error(`titlePath: handheld() gave no expression for ${key}.`);
    return `(${expression.source.replaceAll("abstime", tau)})`;
  };
  // The landing on top of it, measured: a 6.5 % push-in settling by frame 27, the eye sinking
  // 4.5 cm round the grille, a drift right from frame 18, a tilt up from frame 30.
  const eye = [
    `${held("eye.x")} - 0.03 * ${drift}`,
    `${held("eye.y")} + 0.045 * (1 - ${settle}) + 0.012 * ${rise}`,
    `${held("eye.z")} + 0.064 * (1 - ${settle})`,
  ];
  const aim = [
    `${held("lookAt.x")} + 0.007 * ${easeOut(`${tau} / 0.37`)} - 0.024 * ${drift}`,
    `${held("lookAt.y")} + 0.014 * ${rise}`,
    `${held("lookAt.z")}`,
  ];
  const roll = held("roll");

  const gate = cutGate(t);
  const pick = (a: string, b: string): string => `((${a}) * (1 - ${gate}) + (${b}) * ${gate})`;
  return {
    eye: [pick(whipEye[0]!, eye[0]!), pick(whipEye[1]!, eye[1]!), pick(whipEye[2]!, eye[2]!)],
    aim: [pick(whipAim[0]!, aim[0]!), pick(whipAim[1]!, aim[1]!), pick(whipAim[2]!, aim[2]!)],
    roll: pick(whipRoll, roll),
    fov: `${FOV}`,
  };
}

/**
 * The shutter, as a share of a frame: a 180° shutter on the title; in the whip it opens far
 * past a frame (a post whip-transition smear), so frames 5–8 are nothing but streaked grey.
 */
const SHUTTER = `(0.5 + 9 * ${smooth(`(abstime - 0.09) / 0.12`)} * (1 - ${cutGate("abstime")}))`;

/**
 * CAMERA MOTION BLUR from the path's own velocity: each pixel's world point (from depth; the
 * far plane where there is none) is projected with the camera EPS seconds earlier, and the
 * screen displacement scaled to the shutter is the smear — linearised, so a whip turning 40°
 * a frame still blurs along its instantaneous direction instead of reprojecting behind the
 * lens. No cut test: the switch at the cut sits between two frames and EPS never spans it.
 * Custom WGSL · Multi: Input = colour, More = [depth].
 */
export const TITLE_MOTION_WGSL = `struct Params {
${CAMERA_PARAMS}
  prevEye: vec3f, // @default 0  The camera's position EPS seconds ago.
  prevAim: vec3f, // @default 0  The camera's look-at EPS seconds ago.
  prevFov: f32, // @default 50  The camera's fov EPS seconds ago.
  prevRoll: f32, // @default 0  The camera's roll EPS seconds ago, degrees.
  scale: f32, // @default 10  Shutter seconds ÷ EPS: the displacement over EPS × this is the smear.
  maxBlur: f32, // @default 1.5  Longest smear, fraction of the frame height.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
${VIEW}
const SAMPLES: u32 = 40u;

fn projectWith(eye: vec3f, aim: vec3f, fov: f32, roll: f32, aspect: f32, world: vec3f) -> vec2f {
  let forward = normalize(aim - eye);
  let right = rolledRight(forward, roll);
  let up = cross(right, forward);
  let tanHalf = tan(radians(fov) * 0.5);
  let rel = world - eye;
  let z = max(dot(rel, forward), 1e-3);
  return vec2f(dot(rel, right) / (z * tanHalf * aspect) * 0.5 + 0.5, 0.5 - dot(rel, up) / (z * tanHalf) * 0.5);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centre = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let v = makeView();
  var z = viewDepth(uv);
  if (z < 0.0) { z = 60.0; }
  let world = worldAt(v, uv, z);
  let previous = projectWith(params.prevEye, params.prevAim, params.prevFov, params.prevRoll, v.aspect, world);
  var velocity = (uv - previous) * params.scale;
  // In frame heights: cap the smear's length.
  let tall = velocity * vec2f(v.aspect, 1.0);
  let reach = length(tall);
  if (reach > params.maxBlur) { velocity = velocity * (params.maxBlur / reach); }
  if (length(velocity * frameU.resolution) < 0.75) { return centre; }
  let jitter = ignHash(uv * frameU.resolution + vec2f(frameU.absFrame * 1.7, 0.0)) - 0.5;
  var sum = vec3f(0.0);
  for (var i = 0u; i < SAMPLES; i = i + 1u) {
    let t = (f32(i) + 0.5 + jitter) / f32(SAMPLES) - 0.5;
    // Mirror at the border so a long smear keeps the frame's own light instead of a clamped edge.
    var at = uv + velocity * t;
    at = 1.0 - abs(1.0 - abs(at) % 2.0);
    sum = sum + textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb;
  }
  return vec4f(sum / f32(SAMPLES), centre.a);
}`;

/**
 * The title's LENS: a fast wide prime. Barrel distortion normalised so the frame's side
 * edges stay put (the centre is magnified, the corners gather more), a soft smear outside the
 * centre third that turns round the centre (the swirl of an old fast lens), colour fringing
 * at the edges, and the vignette.
 */
export const TITLE_LENS_WGSL = `struct Params {
  k: f32, // @default 0.13  Barrel distortion (height units², normalised at the side edges).
  edgeBlur: f32, // @default 0.018  Edge smear at the side edges, fraction of the frame height.
  swirl: f32, // @default 0.7  0 radial .. 1 tangential edge smear.
  aberration: f32, // @default 0.004  Lateral colour at the side edges, fraction of the radius.
  vignette: f32, // @default 0.5  Darkening at the corners.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
const TAPS: i32 = 16;

fn ignHash(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  let scaleXY = vec2f(aspect, 1.0);
  let c = (uv - vec2f(0.5)) * scaleXY;
  let r2 = dot(c, c);
  let e2 = aspect * aspect * 0.25;
  let src = c * (1.0 + params.k * r2) / (1.0 + params.k * e2);
  // Edge smear: nothing in the centre third, growing to edgeBlur at the side edges.
  let edge = smoothstep(0.08, 1.0, r2 / e2);
  let radial = normalize(src + vec2f(1e-5));
  let tangent = vec2f(-radial.y, radial.x);
  let dir = normalize(mix(radial, tangent, params.swirl)) * params.edgeBlur * edge * edge;
  let jitter = ignHash(uv * size) - 0.5;
  var sum = vec3f(0.0);
  for (var i = 0; i < TAPS; i = i + 1) {
    let t = (f32(i) + 0.5 + jitter) / f32(TAPS) - 0.5;
    let p = src + dir * t;
    let ca = p * params.aberration * edge;
    let rch = textureSampleLevel(inputTexture, inputSampler, (p + ca) / scaleXY + 0.5, 0.0).r;
    let gch = textureSampleLevel(inputTexture, inputSampler, p / scaleXY + 0.5, 0.0).g;
    let bch = textureSampleLevel(inputTexture, inputSampler, (p - ca) / scaleXY + 0.5, 0.0).b;
    sum = sum + vec3f(rch, gch, bch);
  }
  var color = sum / f32(TAPS);
  let q = (uv - vec2f(0.5)) * 2.0;
  let vr = dot(q * vec2f(1.0, 0.8), q * vec2f(1.0, 0.8));
  color = color * mix(1.0, 1.0 - smoothstep(0.35, 1.6, vr), params.vignette);
  return vec4f(color, 1.0);
}`;

/** A box average over the input texels this (smaller) output texel covers, each clipped at 8: an area mean, so one hot glint cannot pass for a lamp. */
const AREA_AVERAGE_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(inputTexture));
  var sum = vec3f(0.0);
  for (var y = -2; y < 2; y = y + 1) {
    for (var x = -2; x < 2; x = x + 1) {
      sum = sum + min(textureSampleLevel(inputTexture, inputSampler, uv + (vec2f(f32(x), f32(y)) + 0.5) * texel * 2.0, 0.0).rgb, vec3f(8.0));
    }
  }
  return vec4f(sum / 16.0, 1.0);
}`;

/**
 * The shared surface with the title's own finish on top:
 *
 * - `floorGain` scales the floor's albedo: in the reference's title the floor at the frame's
 *   bottom corners is near black while the car's matte paint beside it reads mid-grey under the
 *   same soft key; one albedo cannot do both.
 * - The hero's paint (class 11 or 12, whichever the build gives it) is the reference's SATIN MID-GREY: a neutral albedo
 *   (`matteAlbedo`), a broad sheen (`matteRoughness`), barely metallic — in place of the shared
 *   dark semi-metallic coat, which read glossy near-black.
 * - GEOMETRIC SPECULAR ANTIALIASING on every surface: where the normal turns within a pixel
 *   (a grille bar's round edge, the script's tube, seen from a metre) the roughness widens by
 *   that turn, so a highlight too thin for the pixel spreads to its width instead of crawling
 *   and stair-stepping (Kaplanyan & Hoffman's normal-variance filter). `specularAA` scales it.
 */
function titleSurface(): string {
  const anchors = ["  cycAlbedo: f32,", "  r.metallic = 0.0;\n  r.normal = detailBump(s.normal, grit.gradient", "fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {"];
  for (const anchor of anchors) {
    if (!SURFACE_WGSL.includes(anchor)) throw new Error(`titleSurface: surface.ts no longer has "${anchor.split("\n")[0]}" — re-anchor the title's finish.`);
  }
  return `${SURFACE_WGSL
    .replace(anchors[0]!, `  floorGain: f32, // @default 1  The title's floor albedo scale.
  matteAlbedo: f32, // @default 0.2  The hero's matte paint albedo (linear).
  matteRoughness: f32, // @default 0.5  The hero's matte paint roughness (satin).
  specularAA: f32, // @default 1  Geometric specular antialiasing strength.
${anchors[0]!}`)
    .replace(anchors[1]!, `  r.albedo = vec4f(r.albedo.rgb * p.floorGain, 1.0);\n${anchors[1]!}`)
    .replace(anchors[2]!, "fn sharedSurface(s: SurfaceIn, p: Params) -> SurfaceOut {")}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = sharedSurface(s, p);
  // the hero wears the silver (11) in the tableau build, the matte (12) before it: both are the hero
  let paint = classOf(s);
  if (paint == 11u || paint == 12u) {
    o.albedo = vec4f(vec3f(p.matteAlbedo) * vec3f(0.98, 1.0, 1.02), 1.0);
    o.roughness = p.matteRoughness;
    o.metallic = 0.08;
  }
  // The normal's turn across this pixel, as a slope variance, added to alpha squared.
  let turn = s.curvature * s.footprint;
  let variance = min(turn * turn * 0.5 * p.specularAA, 0.25);
  o.roughness = sqrt(clamp(o.roughness * o.roughness + variance, 0.0, 1.0));
  return o;
}`;
}

export interface TitleOptions {
  readonly width?: number;
  readonly height?: number;
  readonly crt?: boolean;
  readonly hdri?: boolean;
}

export function titleDocument(facts: OnNothingFacts, options: TitleOptions): ProjectDocument {
  const PLACEMENT = placements(facts);
  const chain = new Chain(["shot", "out"]);
  const scenes: string[] = [];
  const path = titlePath("abstime");
  const before = titlePath(PREVIOUS_T);

  chain.add("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: titleSurface(), floorGain: 0.35, matteAlbedo: 0.2, matteRoughness: 0.5, specularAA: 1, headGain: 0.06, tailGain: 1, wet: 0, wetGloss: 0.32, dryGloss: 0.6, peel: 0 }, { label: "surf1" });

  // ── Meshes: the warehouse, the hero and the two white cars beside it, the title ──
  /** A Mesh File In of `select` (sized by `area`'s facts), moved by `move`: its points port. */
  const load = (id: string, area: Area, select: string, move: V3 | undefined, y: number): Port => {
    const mesh = facts.areas.get(area);
    if (mesh === undefined) throw new Error(`titleDocument: no "${area}" area in the GLB.`);
    chain.add(`mesh_${id}`, "meshFileIn", [-3600, y], { file: facts.glbUrl, select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts });
    if (move === undefined) return [`mesh_${id}`, "out"];
    chain.add(`place_${id}`, "pointTransform", [-3450, y], { translate: vec3(move), pivot: "origin" });
    chain.link([`mesh_${id}`, "out"], [`place_${id}`, "points"]);
    return [`place_${id}`, "out"];
  };
  const cars = TITLE_CARS.filter((area) => facts.areas.has(area));
  const carPoints = new Map<Area, Port>();
  const areas: Area[] = ["wh", ...cars, "title"];
  areas.forEach((area, index) => {
    const points = load(area, area, facts.areas.get(area)?.select ?? `${area}.*`, PLACEMENT[area], index * 250);
    if (area.startsWith("car")) carPoints.set(area, points);
    chain.add(`geo_${area}`, "geometry", [-3300, index * 250], { mode: "surface", material: "surf1" });
    chain.link(points, [`geo_${area}`, "points"]);
    scenes.push(`geo_${area.toLowerCase()}1`);
  });
  // Lamp glass: its OWN Render (surface.ts LAMP_GLASS_WGSL), every title car a black depth
  // occluder where the title put it, composited additively after the occlusion pass, as
  // document.ts does. The glass is one area (its facts are per area), so it stays where the
  // tableau has it: the hero's sits on the hero; the moved cars' shells end up inside a car
  // body or behind the hero, where the occluders hide them.
  const glassScenes: string[] = [];
  const glassArea = facts.areas.get("lampglass");
  if (glassArea !== undefined) {
    chain.add("glassMat", "materialWgsl", [-3300, 1900], { model: "unlit", source: LAMP_GLASS_WGSL, roughness: 0.02, glint: 0.8, sheen: 0.03 }, { label: "glassmat1" });
    chain.add("occMat", "materialWgsl", [-3300, 2000], { model: "unlit", source: OCCLUDER_WGSL, roughness: 1 }, { label: "occmat1" });
    const glass = load("lampglass", "lampglass", glassArea.select, undefined, 2100);
    chain.add("geo_lampglass", "geometry", [-3000, 2100], { mode: "surface", material: "glassmat1" });
    chain.link(glass, ["geo_lampglass", "points"]);
    glassScenes.push("geo_lampglass1");
    cars.forEach((area, index) => {
      chain.add(`occ_${area}`, "geometry", [-3000, 2200 + index * 100], { mode: "surface", material: "occmat1" });
      chain.link(carPoints.get(area)!, [`occ_${area}`, "points"]);
      glassScenes.push(`occ_${area}1`);
    });
  }

  // ── Light ──
  // The hero's low beams: one projector between its headlights, toward the lens.
  const lights: string[] = [];
  const projectors: string[] = [];
  const heads = [...facts.markers.values()].filter((marker) => /^lamp\.head\.0[lr]$/.test(marker.name));
  if (heads.length === 2) {
    const centre = [0, 1, 2].map((axis) => (heads[0]!.position[axis]! + heads[1]!.position[axis]!) / 2) as [number, number, number];
    const dir = (heads[0]!.extras?.["loom_light_dir"] as number[] | undefined) ?? [0, 0, 1];
    chain.add("cookieSeed", "ramp", [-3000, 1600], {}, { resolution: { mode: "fixed", width: 256, height: 128 } });
    chain.add("cookie", "customWgsl", [-2800, 1600], { source: HEADLIGHT_COOKIE_WGSL }, { resolution: { mode: "fixed", width: 256, height: 128 } });
    chain.link(["cookieSeed", "out"], ["cookie", "input"]);
    chain.add("head0", "projector", [-2600, 1400], {
      eye: vec3(centre),
      lookAt: [centre[0] + dir[0]! * 2, centre[1] + dir[1]! * 2, centre[2] + dir[2]! * 2],
      throwRatio: 0.5,
      aspect: 2.4,
      brightness: 1.2,
      color: [0.78, 0.92, 1, 1],
      falloff: true,
      occlusion: true,
    });
    chain.link(["cookie", "out"], ["head0", "cookie"]);
    projectors.push("head01");
  }
  // The room's practicals: old sodium high-bays warming the trusses and the brick, and a soft
  // key high behind the lens that gives the matte paint its sheen and the chrome its top light.
  const point = (id: string, position: V3, color: readonly number[], intensity: number, shadow?: { extent: number; softness: number }): void => {
    const casts = shadow === undefined ? {} : { shadows: true, shadowExtent: shadow.extent, shadowSoftness: shadow.softness };
    chain.add(id, "light", [-2600, 1800 + lights.length * 80], { kind: "point", position: vec3(position), color: [...color], intensity, ...casts });
    lights.push(`${id.toLowerCase()}1`);
  };
  const warm = [1, 0.72, 0.5, 1];
  point("sodiumL", [-6, 5.5, -7], warm, 16);
  point("sodiumC", [0.5, 6.2, -11], warm, 22, { extent: 20, softness: 2 });
  point("sodiumR", [7, 5.5, -9], warm, 12);
  point("sodiumW", [-12, 4, -2], warm, 7);
  // High-bays hung just under the trusses (their bottom chord is at 7 m): in the reference the
  // trusses and the roof over the hero read warm, lit from below by old lamps, and the haze
  // glows round them. Each lights the steel near it; the haze catches them (HIGH_BAYS below).
  HIGH_BAYS.forEach((position, index) => point(`bay${index}`, position, warm, BAY_INTENSITY));
  // The key and the flank lamps CAST (owner: the cars floated): each car sits in its own dark.
  point("key", [0.2, 2.6, 2.4], [0.95, 0.97, 1, 1], 3.5, { extent: 10, softness: 2 });
  point("under", [0, 0.35, 2.2], [0.9, 0.95, 1, 1], 0.25);
  // Hard cool lamps on the white cars' flanks: their paint clips, and the streak glass smears
  // it into the tall milky slabs at the frame's edges (the reference's "light columns").
  point("flankL", [-1.95, 1.1, -0.9], [0.92, 0.97, 1, 1], 5, { extent: 8, softness: 1.5 });
  point("flankR", [1.95, 1.1, -0.9], [0.92, 0.97, 1, 1], 5, { extent: 8, softness: 1.5 });

  // ── Environment (what the chrome reflects) ──
  chain.add("envSeed", "ramp", [-2700, 300], {}, { resolution: { mode: "fixed", width: 1024, height: 512 } });
  chain.add("env", "customWgsl", [-2700, 500], { source: ENVIRONMENT_WGSL, bars: 6, roof: 0.3 }, { resolution: { mode: "fixed", width: 1024, height: 512 } });
  chain.link(["envSeed", "out"], ["env", "input"]);
  if (options.hdri === true) {
    chain.add("hdri", "movieFileIn", [-2900, 700], { file: "media/on-nothing/hdri.png" }, { resolution: { mode: "fixed", width: 2048, height: 1024 } });
    chain.add("envHdri", "customWgsl", [-2700, 700], { source: ENVIRONMENT_HDRI_WGSL, gain: 0.4, crush: 0.25, desaturate: 0.35 }, { resolution: { mode: "fixed", width: 1024, height: 512 } });
    chain.link(["hdri", "out"], ["envHdri", "input"]);
    // A soft pre-blur: the Render's 32 taps over a sharp HDRI streak on the satin paint.
    chain.add("envBlur", "blur", [-2500, 700], { size: 3, filter: "gaussian", extend: "repeat" });
    chain.link(["envHdri", "out"], ["envBlur", "input"]);
  }

  // ── Camera and the Render ──
  const slot = (source: string, fallback: number): StoredParameter => expressionSlot(source, fallback);
  chain.add("cam", "camera", [-2700, -900], {
    eye: vec3(EYE),
    lookAt: vec3(AIM),
    fov: slot(path.fov, FOV),
    near: 0.05,
    far: 200,
    "eye.x": slot(path.eye[0], EYE[0]),
    "eye.y": slot(path.eye[1], EYE[1]),
    "eye.z": slot(path.eye[2], EYE[2]),
    "lookAt.x": slot(path.aim[0], AIM[0]),
    "lookAt.y": slot(path.aim[1], AIM[1]),
    "lookAt.z": slot(path.aim[2], AIM[2]),
    roll: slot(path.roll, 0),
  }, { label: "cam1" });
  chain.add("shot", "render", [-2400, 0], {
    scenes: scenes.join(" "),
    camera: "cam1",
    lights: lights.join(" "),
    projectors: projectors.join(" "),
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: 0,
    background: [0, 0, 0, 1],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    albedoOutput: true,
    environmentIntensity: 1,
    environmentTaps: 32,
  }, { label: "shot1" });
  chain.link([options.hdri === true ? "envBlur" : "env", "out"], ["shot", "environment"]);

  // ── Screen space: reflections, contact occlusion, haze, depth of field ──
  const cam = cameraParams(EYE, AIM, FOV);
  const depth = ["shot", "depth"] as const;
  const normal = ["shot", "normal"] as const;
  chain.pass("reflections", GLOSSY_SSR_WGSL, { ...cam, strength: 1.1, maxDistance: 30, roughnessCutoff: 0.55, thickness: 0.4, blur: 1.6, stretch: 4, keepBright: 4, dimShare: 0.1 }, [depth, normal], [-2100, 0]);
  chain.pass("occlusion", GTAO_WGSL, { ...cam, radius: 1.3, strength: 0.95, power: 1.6 }, [depth, normal], [-1900, 0]);
  if (glassScenes.length > 0) {
    chain.add("glassShot", "render", [-2400, 700], { scenes: glassScenes.join(" "), camera: "cam1", lights: "", ambientIntensity: 0, background: [0, 0, 0, 1], antialias: "msaa", normalOutput: true }, { label: "glassshot1" });
    chain.pass("glass", GLASS_COMPOSITE_WGSL, {}, [["glassShot", "out"], ["glassShot", "normal"]], [-1800, 0]);
  }
  // The haze sees the hero's lamps and the moved cars' lamps where the title put them.
  const markers = new Map([...facts.markers].flatMap(([name, marker]) => {
    const match = /^lamp\.head\.(\d+)[lr]$/.exec(name);
    if (match === null) return [[name, marker] as const];
    const area = `car${match[1]}` as Area;
    if (!TITLE_CARS.includes(area)) return [];
    const move = PLACEMENT[area] ?? [0, 0, 0];
    return [[name, { ...marker, position: [marker.position[0] + move[0], marker.position[1] + move[1], marker.position[2] + move[2]] as [number, number, number] }] as const];
  }));
  HIGH_BAYS.forEach((position, index) => {
    const name = `lamp.tube.bay${index}`;
    markers.set(name, { name, position: [...position] as [number, number, number], direction: [0, -1, 0], extras: { loom_light_kind: "tube", loom_light_color: [1, 0.72, 0.5], loom_light_lumens: 1000, loom_light_cone_deg: 360 } });
  });
  chain.pass("haze", hazeWgsl(hazeLights({ ...facts, markers }, ["head", "tube"])), { ...cam, density: 0.02, ambient: [0.006, 0.0055, 0.005], anisotropy: 0.72, head: 0.02, tube: BAY_HAZE, core: 0.4 }, [depth], [-1700, 0]);
  // Focus rides the script (its strokes stand ~4 cm in front of the grille, z ≈ 0.04): the focus
  // puller follows the push-in, so the title stays sharp while the flanks and the room go soft.
  chain.pass("dof", DOF_WGSL, { ...cam, focusDistance: slot(`op('cam1').par.eye.z - ${SCRIPT_Z}`, EYE[2] - SCRIPT_Z), aperture: 0.18, maxRadius: 5 }, [depth], [-1500, 0]);

  // ── Optics: the streak glass (turning with the roll), bloom ──
  // What the glass smears is judged over AREA (a quarter-size box average, then the threshold):
  // a lamp and a clipped white flank qualify; a chrome bar's pinpoint glint of a lamp does not
  // (it smeared every grille bar into a column of its own).
  chain.add("streakArea", "customWgsl", [-1500, 300], { source: AREA_AVERAGE_WGSL }, { resolution: { mode: "scale", factor: 0.25 } });
  chain.link(chain.last, ["streakArea", "input"]);
  chain.add("streakBright", "customWgsl", [-1400, 300], { source: BRIGHT_PASS_WGSL, threshold: 0.7, knee: 0.25 }, { resolution: { mode: "scale", factor: 1 } });
  chain.link(["streakArea", "out"], ["streakBright", "input"]);
  chain.stock("streak", "streak", {
    threshold: 0.75,
    knee: 0.25,
    length: 0.55,
    angle: slot(`-(${path.roll})`, 0),
    falloff: 1.4,
    spread: 0.006,
    tail: 0.05,
    striation: 0.45,
    striationScale: 150,
    gain: flicker(0.8, REACT_PROFILES.title.lamp), // T1407b: the lamps' measured flicker (shots/react.ts)
    tint: [0.92, 0.97, 1, 1],
  }, [-1300, 0]);
  chain.link(["streakBright", "out"], ["streak", "bright"]);
  const scene = chain.last;
  const glow = chain.bloom(scene, 1.6, -1300);
  chain.pass("optics", `struct Params {
  bloom: f32, // @default 0.12  Bloom glow added back.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let b = textureSampleLevel(inputTexture1, inputSampler, uv, 0.0).rgb;
  return vec4f(base.rgb + b * params.bloom, base.a);
}`, { bloom: 0.14 }, [glow], [-700, 0]);

  // ── Camera motion blur, lens, grade ──
  chain.pass("motion", TITLE_MOTION_WGSL, {
    ...cam,
    prevEye: vec3(EYE),
    prevAim: vec3(AIM),
    "prevEye.x": slot(before.eye[0], EYE[0]),
    "prevEye.y": slot(before.eye[1], EYE[1]),
    "prevEye.z": slot(before.eye[2], EYE[2]),
    "prevAim.x": slot(before.aim[0], AIM[0]),
    "prevAim.y": slot(before.aim[1], AIM[1]),
    "prevAim.z": slot(before.aim[2], AIM[2]),
    prevFov: slot(before.fov, FOV),
    prevRoll: slot(before.roll, 0),
    scale: slot(`${SHUTTER} / ${FPS} / ${EPS}`, 0.5 / FPS / EPS),
    maxBlur: 1.6,
  }, [depth], [-500, 0]);
  chain.pass("lens", TITLE_LENS_WGSL, { k: DISTORTION, edgeBlur: 0.02, swirl: 0.7, aberration: 0.004, vignette: 0.55 }, [], [-300, 0]);
  chain.pass("grade", GRADE_WGSL, { exposure: 0.45, black: 0.05, contrast: 1.22, saturation: 0.7, keepWarm: 0.9, bleach: 0.25, steel: [0.97, 1.0, 1.02], shadowTint: [0.97, 1.01, 1.02, 1], split: 0.3, grain: 0.028 }, [], [-100, 0]);
  if (options.crt === true) chain.pass("crt", CRT_WGSL, { amount: 1 }, [], [500, 0]);
  chain.add("out", "output", [700, 0], { toneMap: "none" }, { label: "out1" });
  chain.link(chain.last, ["out", "input"]);
  return chain.document("title", options.width ?? 1920, options.height ?? 818);
}
