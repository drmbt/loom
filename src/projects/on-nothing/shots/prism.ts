import type { ProjectDocument } from "../../../domain/types/graph.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, GTAO_WGSL, VIEW } from "../../furnace/screen-space.ts";
import { ENVIRONMENT_WGSL } from "../atmosphere.ts";
import { GRADE_WGSL, LENS_WGSL } from "../fx.ts";
import type { Bone, OnNothingFacts } from "../scene-facts.ts";
import { SURFACE_WGSL } from "../surface.ts";
import { ShotGraph, cameraRefs } from "./chain.ts";
import { figureNodes } from "./figure.ts";
import { pistolPose } from "./hands.ts";
import { handheld as operator } from "./handheld.ts";
import { keyed, shutterClock } from "./motion.ts";

/**
 * T1407b — PRISM, the reference's 0:28.92–0:29.88 (23 frames). The look breakdown calls it a
 * triangular prism slice; the frames show something else, and this builds what they show:
 *
 *  - A white STUCCO WALL (crumpled-paper relief, 130/135/133 mid-grey under the grade, lit at
 *    a graze from low camera-right), filling the frame.
 *  - The performer's HARD SHADOW on it, thrown up and to the left at about 39° by the low key:
 *    his head tipped back and his raised arm (elbow out, hand at the temple) read as the long
 *    "gun" shape upper left, his torso as the black band running off lower right.
 *  - A SHADOW MATTE: the performer himself — black tee, chains, face tipped up into the key —
 *    shows only INSIDE his shadow; outside it the wall is clean. Where the matte holds no body
 *    it is the shadow itself, black (10–15/255). The owner read the matte as the figure being
 *    eaten, so it is a knob (the wall pass's `matte`) and off: he stands whole before his shadow.
 *  - Motion: he RISES into the frame (the shadow's head enters at the bottom at 0 s; face and
 *    arm are in by 0.5 s), the wall drifting 28 px right and 14 px up (the camera settling),
 *    and the WALL FLASHES white on the beat — frames 1–3, 9–11, 17–19 (every 0.355 s): the wall
 *    clips to 245, the shadowed wall lifts to a pale grey, the performer inside the matte does
 *    not.
 *
 * The chain: Render the figure (key-lit, alpha = coverage) from the camera and, T1414b, a
 * second Render from the same camera of the wall plane alone, the figure in it SHADOW ONLY
 * under a casting copy of the key, whose Shadow output is the figure's shadow on the wall at
 * every pixel (behind him too) → the WALL composite (the wall plane ray-cast, its relief lit
 * by the key, darkened by that matte, the figure shown inside the shadow only) → streak and
 * bloom → lens → grade.
 */

/** The wall composite. Input = the camera Render; More = [camera depth, the wall Render's shadow matte]. */
export const PRISM_WALL_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
${CAMERA_PARAMS}
  wallPoint: vec3f, // @default 0  A point on the wall.
  wallNormal: vec3f, // @default 0  The wall's normal (toward the camera).
  key: vec3f, // @default 0  The key light's position.
  keyColor: vec3f, // @default 1  The key light's colour.
  keyIntensity: f32, // @default 1  The key light's power.
  ambient: f32, // @default 0.02  The wall's fill (what the shadow keeps).
  albedo: vec3f, // @default 0.8  The wall's colour.
  relief: f32, // @default 1  Depth of the stucco relief.
  reliefScale: f32, // @default 18  Stucco features per metre.
  flash: f32, // @default 1  The wall's exposure (the beat flashes).
  matte: f32, // @default 1  1 shows the performer only inside his shadow; 0 shows all of him.
  clip: f32, // @default 4  The plate's highlights roll off toward this (the camera's sensor clips; a glinting pendant does not bloom the frame).
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
${VIEW}
fn h2(p: vec2f) -> f32 {
  var q = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn vnoise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2f(1.0, 0.0)), u.x), mix(h2(i + vec2f(0.0, 1.0)), h2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

// Crumpled-paper stucco: ridged octaves, each turned against the last so no grain lines up.
fn stucco(p: vec2f) -> f32 {
  var q = p;
  var h = 0.0;
  var amp = 0.5;
  for (var o = 0; o < 5; o = o + 1) {
    let ridge = 1.0 - abs(vnoise2(q) * 2.0 - 1.0);
    h = h + ridge * ridge * amp;
    q = mat2x2f(0.8, 0.6, -0.6, 0.8) * q * 2.07 + vec2f(1.7, 9.2);
    amp = amp * 0.5;
  }
  return h;
}

// 1 where the figure stands between the wall and the key: the wall Render's shadow matte
// (T1414b), the same camera, so the pixel is the pixel.
fn shadowAt(uv: vec2f) -> f32 {
  let size = vec2f(textureDimensions(inputTexture2));
  return textureLoad(inputTexture2, clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1)), 0).r;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let v = makeView();
  let ray = rayAt(v, uv);
  let nw = normalize(params.wallNormal);
  let t = dot(params.wallPoint - params.eye, nw) / min(dot(ray, nw), -1e-4);
  let w = params.eye + ray * t;
  // The relief, in the wall's own coordinates.
  let wu = normalize(cross(vec3f(0.0, 1.0, 0.0), nw));
  let wv = cross(nw, wu);
  let p = vec2f(dot(w, wu), dot(w, wv)) * params.reliefScale;
  let e = 0.35;
  let h0 = stucco(p);
  let gx = (stucco(p + vec2f(e, 0.0)) - h0) / e;
  let gy = (stucco(p + vec2f(0.0, e)) - h0) / e;
  let n = normalize(nw - (wu * gx + wv * gy) * params.relief * 0.25);
  let toKey = params.key - w;
  let dk = length(toKey);
  let lambert = max(dot(n, toKey / dk), 0.0);
  let shade = 0.94 + 0.12 * h0;
  let albedo = params.albedo * shade;
  let shadow = shadowAt(uv);
  let lit = albedo * (params.keyColor * params.keyIntensity * lambert / (dk * dk) * (1.0 - shadow) + vec3f(params.ambient));
  let dark = albedo * params.ambient;
  // Inside the shadow: the figure, and the shadowed wall where it does not cover.
  let raw = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let fig = vec4f(raw.rgb / (1.0 + max(raw.r, max(raw.g, raw.b)) / params.clip), raw.a);
  let inside = fig.rgb + (1.0 - clamp(fig.a, 0.0, 1.0)) * dark * params.flash;
  let cover = mix(clamp(fig.a, 0.0, 1.0), shadow, params.matte);
  let behind = mix(lit * params.flash, dark * params.flash, shadow);
  return vec4f(mix(behind, mix(inside, fig.rgb + (1.0 - clamp(fig.a, 0.0, 1.0)) * behind, 1.0 - params.matte), cover), 1.0);
}`;

export interface PrismOptions {
  readonly width?: number;
  readonly height?: number;
}

/** The beat the wall flashes on: every 0.355 s from 0.04 s, three frames held (frames 1–3, 9–11, 17–19). */
function flashCurve(t: string): string {
  const pulses = [0.04, 0.395, 0.75].map((start) => `clamp((${t} - ${start}) / 0.02, 0, 1) * clamp((${start + 0.125} - ${t}) / 0.02, 0, 1)`);
  return `1 + 6 * min(${pulses.join(" + ")}, 1)`;
}

/**
 * The performance: rising into the key (the pelvis lifts 0.42 m, eased out, by 0.55 s), the head
 * tipped back to look up past the lens, the right hand at the temple with the elbow out.
 */
function performance(t: string, bones: readonly Bone[]): Record<string, string> {
  const tip = keyed(t, [[0, 0.6], [0.6, 1]]);
  return {
    "upperarmL.z": "-0.35",
    "upperarmL.x": "-0.45",
    "forearmL.x": "-0.2",
    // T1407b (hands): the reference's hand is a PISTOL raised beside the head, the barrel out and
    // up, so the key throws a big pistol shadow up the cyc (shots/hands.ts pistolPose)
    // (the reference: the barrel level and a touch down, out to his right; the grip down; the back
    // of the hand to the lens; the forearm rising from below, so gun and shadow read as one pistol)
    ...pistolPose(bones, { wrist: [-0.24, 1.6, 0.22], point: [-1, -0.25, 0.1], palm: [0, 0.15, -1], elbow: [-0.26, 1.33, 0.12] }),
    "neck.x": `-0.1 * (${tip})`,
    "head.x": `-0.25 * (${tip})`,
    "head.y": "0.15",
  };
}

export function prismDocument(facts: OnNothingFacts, options: PrismOptions): ProjectDocument {
  const width = options.width ?? 1920;
  const height = options.height ?? 818;
  const stage = facts.stages.get("quad");
  if (stage === undefined) throw new Error("prismDocument: the GLB has no stage \"stage.quad\" (the void the prism borrows).");
  // In the empty void by the quad's mark, facing -Z (the camera's side).
  const [ax, , az] = stage.position;
  // T1407b (prism): the reference's narrow shutter — the fast rise reads crisp at --final,
  // where a 360° clock smeared the figure and its shadow into ghosts (motion.ts shutterClock)
  const t = shutterClock(90);
  const rise = keyed(t, [[0, -0.75], [0.55, 0, "snap"], [0.96, 0.02]]);

  const g = new ShotGraph();
  g.node("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: SURFACE_WGSL }, { label: "material_surf" });
  const figure = figureNodes(facts, { area: "fig", material: "material_surf", yaw: Math.PI, place: [ax, rise, az], pose: performance(t, facts.bones), gun: facts.areas.has("figgun") });
  g.nodes.push(...figure.nodes);
  g.edges.push(...figure.edges);

  // The camera: at chest height, a metre off, tipped up at the face (1560 px a metre at the
  // face: 0.52 m of frame height). It settles with the rise — the wall drifts up and right.
  const eye: [number, number, number] = [ax + 0.05, 1.15, az - 1.05];
  const aim: [number, number, number] = [ax - 0.04, 1.56, az];
  const fov = 31;
  // The shared handheld operator (shots/handheld.ts): a Dutch tilt easing in as he rises, a
  // close operator's sway — scaled down, the lens is a metre from him.
  g.node("cam", "camera", [-2700, -900], {
    eye,
    lookAt: aim,
    ...operator(eye, aim, { tiltIn: 4, tilt: 2.5, settle: 0.7, shake: 0.3, creep: 0 }),
    fov,
    near: 0.05,
    far: 20,
  }, { label: "camera1" });

  // The key: a hard lamp 2.7 m off, low and to camera-right, so every shadow lands up-left of
  // what casts it along the reference's 39° (its rise over its run, 1.2 over 1.5), shifted
  // about a head's width: the raised arm's is the "gun" upper left, the near arm reaching
  // down toward the lamp throws the long black band lower right while the arm itself, off
  // its own shadow, is matted away.
  const key: [number, number, number] = [ax - 1.5, 0.35, az - 2.2];
  g.node("key", "light", [-2600, 1000], { kind: "point", color: [1, 0.98, 0.95, 1], intensity: 16, position: key }, { label: "light_key1" });
  g.node("fill", "light", [-2600, 1100], { kind: "point", color: [0.9, 0.95, 1, 1], intensity: 0.4, position: [ax + 0.8, 1.9, az - 1.2] }, { label: "light_fill1" });
  // The chains need a bright room to mirror: the white cyc environment.
  g.node("envSeed", "ramp", [-2700, 300], {}, { label: "ramp_envseed", resolution: { mode: "fixed", width: 1024, height: 512 } });
  g.node("env", "customWgsl", [-2700, 500], { source: ENVIRONMENT_WGSL, white: 1 }, { label: "wgsl_env", resolution: { mode: "fixed", width: 1024, height: 512 } });
  g.edge("seed-env", ["envSeed", "out"], ["env", "input"]);
  g.node("shot", "render", [-2400, 0], {
    scenes: figure.scene,
    camera: "camera1",
    lights: "light_key1 light_fill1",
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: 0.02,
    background: [0, 0, 0, 0],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    environmentIntensity: 0.22,
    environmentTaps: 16,
  }, { label: "render_shot" });
  g.edge("env-shot", ["env", "out"], ["shot", "environment"]);
  // The shadow on the wall (T1414b): the wall plane and the figure SHADOW ONLY, seen by the
  // shot's own camera under a casting copy of the key; its Shadow output is the matte the
  // wall composite darkens by. Twice the frame, so the key's cube map (1.5x its Render per
  // face tile) keeps the shadow's edge near the old 2048-texel map's.
  g.node("figCast", "geometry", [-3000, 1400], { mode: "surface", material: "material_surf", shadowOnly: true }, { label: "geometry_figcast" });
  g.edge("skin-figcast", ["skin", "out"], ["figCast", "points"]);
  g.node("wallGrid", "pointGrid", [-3300, 1600], { cols: 2, rows: 2, count: 4, sizeX: 8, sizeY: 6 }, { label: "grid_wall" });
  g.node("wallPlace", "pointTransform", [-3150, 1600], { translate: [ax, 1.5, az + 0.12] }, { label: "transform_wallplace" });
  g.node("wallGeo", "geometry", [-3000, 1600], { mode: "surface" }, { label: "geometry_wall" });
  g.edge("wallgrid-place", ["wallGrid", "out"], ["wallPlace", "points"]);
  g.edge("wallplace-geo", ["wallPlace", "out"], ["wallGeo", "points"]);
  g.node("keyShadow", "light", [-2600, 1200], { kind: "point", color: [1, 0.98, 0.95, 1], intensity: 16, position: key, shadows: true, shadowExtent: 6, shadowSoftness: 2 }, { label: "light_keyshadow" });
  g.node("wallShot", "render", [-2400, 300], {
    scenes: "geometry_figcast geometry_wall",
    camera: "camera1",
    lights: "light_keyshadow",
    background: [0, 0, 0, 0],
    ambientIntensity: 0,
    environmentIntensity: 0,
    shadowOutput: true,
  }, { label: "render_wallshot", resolution: { mode: "fixed", width: width * 2, height: height * 2 } });

  // Occlusion on the figure itself: its creases, the arm against the head, the chain on the
  // tee — a small radius, this is a close-up (a hand's width is 0.1 m).
  g.pass("occlusion", GTAO_WGSL, { ...cameraRefs("camera1", eye, aim, fov, 20), radius: 0.2, strength: 0.85, power: 1.4 }, ["shot", "out"], [["shot", "depth"], ["shot", "normal"]], [-2250, 0]);

  const wallZ = az + 0.12;
  g.pass("wall", PRISM_WALL_WGSL, {
    ...cameraRefs("camera1", eye, aim, fov, 20),
    wallPoint: [ax, 0, wallZ],
    wallNormal: [0, 0, -1],
    key,
    keyColor: [1, 0.98, 0.95, 1],
    keyIntensity: 5.5,
    ambient: 0.012,
    albedo: [0.76, 0.82, 0.8, 1],
    relief: 1.1,
    reliefScale: 55,
    flash: expressionSlot(flashCurve(t), 1),
    // The reference mattes him to his own shadow; the owner reads that as the figure being
    // eaten (2026-09-27), so he stands whole in front of it. matte: 1 restores the matte.
    matte: 0,
    clip: 3,
  }, ["occlusion", "out"], [["shot", "depth"], ["wallShot", "shadow"]], [-2100, 0]);

  g.optics(g.last, { threshold: 1.6, knee: 0.8, reach: 0.4, streak: 0.12, bloom: 0.1, compress: 3 });
  g.pass("lens", LENS_WGSL, { distortion: 0.02, edgeBlur: 0.012, aberration: 0.0012, vignette: 0.5, vignetteRound: 0.7 }, g.last, [], [-100, 0]);
  g.pass("grade", GRADE_WGSL, { exposure: 0, black: 0.03, contrast: 1.1, saturation: 0.55, keepWarm: 0.4, bleach: 0.25, steel: [0.96, 1.01, 1.0], shadowTint: [0.97, 1.0, 1.01, 1], split: 0.3, lift: 0.03, grain: 0.03 }, g.last, [], [100, 0]);
  return g.document("prism", width, height);
}
