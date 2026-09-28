import type { ProjectDocument } from "../../../domain/types/graph.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, VIEW } from "../../furnace/screen-space.ts";
import { GRADE_WGSL, LENS_WGSL } from "../fx.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { yawFor } from "../skin-kernel.ts";
import { SURFACE_WGSL } from "../surface.ts";
import { ShotGraph, cameraRefs } from "./chain.ts";
import { figureNodes } from "./figure.ts";
import { handheld, keyed } from "./motion.ts";

/**
 * T1407b — QUAD, the silhouette quadruplet (reference 1:47.75–1:49.71, 47 frames).
 *
 * Measured off the reference, frame by frame (1920×818):
 *  - ONE profile take, mirrored about THREE vertical seams at x = 549, 944.5 and 1340 px
 *    (uv 0.2859 / 0.4919 / 0.6979): strips 395.5 px wide, a residual under 1 grey level at
 *    the seams, so a hard mirror with no blend. The outer strips are NOT folded again: they
 *    run on to the frame edges. Strips 2|3 face each other (their hands meet at the centre
 *    seam), 1|2 and 3|4 stand back to back. The seams hold still for the whole shot.
 *  - In a strip, the chest front sits 35 % and the back 86 % of the way from the face-side
 *    seam; the head is 150 px front to back, the torso 202 px, the head top 122–165 px from
 *    the top; the frame ends at the hips. About 700 px a metre: a long lens, level, at chest
 *    height.
 *  - The silhouette is black at 6–7/255, neutral; the rim is a clipped white line
 *    (250, 255, 255), 3–8 px, strong round the head, the nape, the shoulder and the upper
 *    back, fading down the back; the beard, the chain along the chest and the upturned palms
 *    catch it too.
 *  - The haze is teal, rgb ratio 0.55 : 0.90 : 1.00, peaking at (56, 94, 103) just in front
 *    of the face at head height, ~90 luma between the facing pair, ~30–40 at the back-to-back
 *    seams, falling to (6, 8, 10) in the top corners and (12, 18, 21) at the bottom: one
 *    source behind the figure, a little toward the way it faces, at shoulder height.
 *  - Motion (strip 3's head): the chin JUTS forward 32 px over 0.42 s and SNAPS back in two
 *    frames, again (35 px, 0.5 s), then eases back and the figure straightens, the head top
 *    rising 40 px over the last second. A few thin vertical streak lines rise from the rim.
 *
 * The chain: Render (figure only, background alpha 0 so its alpha is coverage) → haze (one
 * backlight, shadowed by the figure as the light sees it: T1417b, a second Render's Light
 * Depth, the backlight's own cube map) →
 * composite (haze behind, the rim as light wrap of the haze onto the silhouette's edge) →
 * streak and bloom → the four-way mirror → lens → grade.
 */

/** Seams in uv and the strip width, measured; the source window is placed by `face`. */
const AXIS = 944.5 / 1920;
const STRIP = 395.5 / 1920;

/**
 * The HAZE of the quad: one spot behind the figure aimed at the lens, in-scattered along each
 * view ray (Henyey-Greenstein, forward-peaked) through slowly rising, vertically stretched
 * billows. Each sample asks the backlight's own shadow map whether the figure stands between
 * it and the light (T1417b: `// @use light-depth`, where it used to march the segment through
 * the CAMERA's depth buffer, blind to anything the lens did not see), so the haze in front of
 * the silhouette sits in its shadow (the reference's black at 6/255) and god rays fan off its
 * edges. Output: rgb = the haze along the whole ray (what the background shows), a = the part
 * in front of the figure (in units of `color`). Input = the Render (unused), More = [depth,
 * the backlight's Light Depth].
 */
export const QUAD_HAZE_WGSL = `${SHARED_UNIFORMS_WGSL}
// @use light-depth
struct Params {
${CAMERA_PARAMS}
  light: vec3f, // @default 0  The backlight's position (world metres).
  lightDir: vec3f, // @default 0  The way the backlight points.
  cosOuter: f32, // @default 0.5  cos of the cone's outer half-angle.
  cosInner: f32, // @default 0.85  cos of the cone's inner half-angle.
  color: vec3f, // @default 1  Light colour.
  intensity: f32, // @default 1  Light power.
  density: f32, // @default 0.1  Scattering per metre.
  anisotropy: f32, // @default 0.75  Henyey-Greenstein g.
  core: f32, // @default 0.25  Soft core radius round the source, metres.
  reach: f32, // @default 8  March length, metres.
  billow: f32, // @default 0.6  Depth of the density variation.
  billowScale: f32, // @default 1.6  Billows per metre.
  rise: f32, // @default 0.08  Upward drift of the billows, metres a second.
  range: f32, // @default 8  The backlight's shadow range (its Light Depth's Shadow Extent), metres.
  shadowBias: f32, // @default 0.03  Shadow-test allowance along the light, metres.
  plane: f32, // @default 5  View distance of the figure, metres.
  wash: f32, // @default 0  A broad, unpeaked share of the light (the room the haze fills), relative to the beam.
  washCore: f32, // @default 2  Metres over which the wash falls off round the source.
  ceiling: f32, // @default 2  Height where the haze thins out (it hangs low, as haze does), metres.
  frontShare: f32, // @default 0.2  Haze density in front of the figure, relative to behind it.
  depth: f32, // @default 2  How far the haze bank reaches behind the figure, metres.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
${VIEW}
const STEPS: u32 = 48u;

fn hash3(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y);
  let b = mix(mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}

fn smoke(p: vec3f, t: f32) -> f32 {
  // Stretched upward: haze hangs in soft vertical sheets.
  var q = (p - vec3f(0.0, t * params.rise, 0.0)) * params.billowScale * vec3f(1.0, 0.3, 1.0);
  var n = 0.0;
  var amp = 0.5;
  for (var o = 0; o < 3; o = o + 1) {
    n = n + vnoise(q) * amp;
    q = q * 2.03 + vec3f(3.1, 1.7, 5.3);
    amp = amp * 0.5;
  }
  return max(1.0 + (n / 0.875 - 0.5) * 2.0 * params.billow, 0.0);
}

fn hg(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (12.566371 * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let v = makeView();
  let ray = rayAt(v, uv);
  let z = viewDepth(uv);
  let hit = select(1e9, z / max(dot(ray, v.forward), 1e-4), z > 0.0);
  let jitter = ignHash(uv * frameU.resolution + vec2f(frameU.absFrame * 5.3, 0.0));
  let dt = params.reach / f32(STEPS);
  var all = 0.0;
  var inFront = 0.0;
  var optical = 0.0;
  for (var i = 0u; i < STEPS; i = i + 1u) {
    let travel = (f32(i) + jitter) * dt;
    let p = params.eye + ray * travel;
    // The haze hangs behind the figure; the air between it and the lens is thin, so the blacks hold.
    let along = dot(p - params.eye, v.forward);
    let behind = smoothstep(params.plane - 0.6, params.plane + 0.2, along) * (1.0 - smoothstep(params.plane + params.depth - 0.5, params.plane + params.depth, along));
    let hang = 1.0 - smoothstep(params.ceiling - 0.5, params.ceiling + 0.4, p.y);
    let sigma = params.density * smoke(p, frameU.absTime) * mix(params.frontShare, 1.0, behind) * hang;
    let toP = p - params.light;
    let d2 = dot(toP, toP);
    let l = toP * inverseSqrt(max(d2, 1e-6));
    let cone = smoothstep(params.cosOuter, params.cosInner, dot(l, normalize(params.lightDir)));
    let spill = params.wash / (12.566371 * (d2 + params.washCore * params.washCore));
    if (cone > 0.0 || spill > 0.0) {
      // 1 when the light reaches p, 0 when the figure stands between (the light's own view).
      let visible = lightDepthPointVisible(inputTexture2, params.light, params.range, p, params.shadowBias);
      let inscatter = (cone * hg(dot(l, -ray), params.anisotropy) / (d2 + params.core * params.core) + spill) * visible;
      let add = inscatter * sigma * exp(-optical) * dt;
      all = all + add;
      inFront = inFront + select(0.0, add, travel < hit);
    }
    optical = optical + sigma * dt;
  }
  return vec4f(params.color * params.intensity * all, inFront * params.intensity);
}`;

/**
 * The quad's COMPOSITE: the lit figure (alpha = coverage), the haze behind it where it does
 * not cover, the haze in front of it where it does, and the RIM on every covered pixel within
 * `rimWidth` of the open background (weighted by nearness): the RIM LIGHT, a hard source
 * behind the figure on its back side, grazing the edge (its surface normal against the light,
 * inverse-square) — the clipped white line on the nape, the back of the head and the shoulder
 * that fades down the back — plus the GLOW behind the edge wrapping onto it (the haze's
 * luminance to a power), which lights the beard and the chain on the face side.
 * Input = the Render; More = [depth, haze, normal].
 */
export const QUAD_COMPOSITE_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
${CAMERA_PARAMS}
  color: vec3f, // @default 1  The backlight's colour (the haze-in-front term).
  rimLight: vec3f, // @default 0  The rim light's position (world metres).
  rimColor: vec3f, // @default 1  The rim light's colour.
  rimIntensity: f32, // @default 1  The rim light's power.
  rimWrap: f32, // @default 0.2  How far round the edge the rim light reaches.
  rimAim: vec3f, // @default 0  Where the rim light points (a spot: the head and the shoulders).
  rimCosOuter: f32, // @default 0.8  cos of the rim spot's outer half-angle.
  rimCosInner: f32, // @default 0.95  cos of the rim spot's inner half-angle.
  rimWidth: f32, // @default 0.006  Rim reach inside the silhouette, fraction of the frame height.
  glowGain: f32, // @default 1  The glow's wrap onto the edge.
  glowPower: f32, // @default 2  The wrap follows the glow behind the edge to this power.
  glowNorm: f32, // @default 0.1  Glow luminance at which the wrap is glowGain.
  rimWhite: f32, // @default 0.6  How far the wrap desaturates toward white.
  rimFuzz: f32, // @default 0.4  Breaks the rim up like hair and fabric fuzz.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
@group(0) @binding(6) var inputTexture3: texture_2d<f32>;
${VIEW}
fn fuzzHash(p: vec2f) -> f32 {
  var q = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let lit = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let haze = textureSampleLevel(inputTexture2, inputSampler, uv, 0.0);
  let mask = clamp(lit.a, 0.0, 1.0);
  var c = lit.rgb + haze.rgb * (1.0 - mask) + params.color * haze.a * mask;
  if (mask > 0.01) {
    let reach = max(params.rimWidth * size.y, 1.0);
    let n = i32(ceil(reach));
    var edge = 0.0;
    var best = vec3f(0.0);
    for (var dy = -n; dy <= n; dy = dy + 1) {
      for (var dx = -n; dx <= n; dx = dx + 1) {
        let d = length(vec2f(f32(dx), f32(dy)));
        if (d > reach) { continue; }
        let q = uv + vec2f(f32(dx), f32(dy)) / size;
        let open = 1.0 - clamp(textureSampleLevel(inputTexture, inputSampler, q, 0.0).a, 0.0, 1.0);
        if (open <= 0.0) { continue; }
        let w = (1.0 - d / reach) * open;
        edge = max(edge, w);
        best = max(best, textureSampleLevel(inputTexture2, inputSampler, q, 0.0).rgb * w);
      }
    }
    if (edge > 0.0) {
      let fuzz = mix(1.0, 0.4 + 1.2 * fuzzHash(floor(uv * size)), params.rimFuzz);
      // The rim light grazing the edge.
      var direct = 0.0;
      let v = makeView();
      let z = viewDepth(uv);
      if (z > 0.0) {
        let p = worldAt(v, uv, z);
        let nrm = normalize(textureLoad(inputTexture3, depthTexel(uv), 0).rgb * 2.0 - 1.0);
        let toL = params.rimLight - p;
        let dl = length(toL);
        let spot = smoothstep(params.rimCosOuter, params.rimCosInner, dot(-toL / dl, normalize(params.rimAim - params.rimLight)));
        direct = params.rimIntensity * spot * clamp((dot(nrm, toL / dl) + params.rimWrap) / (1.0 + params.rimWrap), 0.0, 1.0) / (dl * dl);
      }
      // The glow behind the edge, wrapping onto it.
      let behind = dot(best, vec3f(0.2126, 0.7152, 0.0722));
      let wrap = pow(behind / params.glowNorm, params.glowPower) * params.glowGain;
      let tint = mix(best / max(behind, 1e-5), vec3f(1.0), params.rimWhite);
      c = c + (params.rimColor * direct * edge + tint * wrap) * fuzz * mask;
    }
  }
  return vec4f(c, 1.0);
}`;

export interface QuadOptions {
  readonly width?: number;
  readonly height?: number;
}

/**
 * The performance, keyed to the reference's strip-3 head track (t = seconds into the shot;
 * crown x / y in px, 700 px a metre): the chin JUTS forward and up (−31, −11 by 0.42 s),
 * SNAPS back in two frames, juts again (−38, −16 by 1.0 s), then the figure TURNS its back a
 * little toward the lens (the shoulder blade swells into the frame, the glasses go), the head
 * easing back and down (+30, +25 by 1.6 s) while the near hand lifts to the chest and drops.
 */
const PERFORMANCE_T = "abstime";
const JUT = keyed(PERFORMANCE_T, [[0, 0.05], [0.42, 1], [0.5, 0, "snap"], [1.0, 1], [1.6, 0.15]]);
const TURN = keyed(PERFORMANCE_T, [[1.0, 0], [1.75, 1]]);
const LIFT = keyed(PERFORMANCE_T, [[1.02, 0], [1.34, 1], [1.8, 0.25]]);

function performance(): Record<string, string> {
  const t = PERFORMANCE_T;
  return {
    // Arms: down from the A-pose, elbows bent, forearms forward, hands open at the hips. The
    // near (left) hand lifts to the chest as the figure turns.
    "upperarmL.z": "-0.66",
    "upperarmR.z": "0.66",
    "upperarmL.x": `0.2 - 0.45 * (${LIFT})`,
    "upperarmR.x": "0.22",
    "forearmL.x": `-0.5 - 1.0 * (${LIFT})`,
    "forearmR.x": "-0.45",
    "handL.z": "1.3",
    "handR.z": "-1.3",
    "spine.x": "0",
    "chest.x": `0.05 + 0.04 * (${TURN})`,
    "neck.x": `0.14 + 0.3 * (${JUT}) + 0.14 * (${TURN})`,
    "head.x": `-0.2 - 0.08 * (${JUT}) + 0.18 * (${TURN})`,
    "head.y": `-0.25 * (${TURN})`,
    "pelvis.y": handheld(t, 0.01, 3, 0.8),
  };
}

export function quadDocument(facts: OnNothingFacts, options: QuadOptions): ProjectDocument {
  const width = options.width ?? 1920;
  const height = options.height ?? 818;
  const stage = facts.stages.get("quad");
  if (stage === undefined) throw new Error("quadDocument: the GLB has no stage \"stage.quad\".");
  const [fx, , fz] = stage.facing;
  const at = stage.position;
  // The camera stands off the figure's side so it faces screen-LEFT (strip 3 unflipped): the
  // view axis is the facing turned a quarter clockwise seen from above.
  const side: [number, number, number] = [-fz, 0, fx];
  const toward = (d: number, along = 0): [number, number, number] => [at[0] - side[0] * d + fx * along, 0, at[2] - side[2] * d + fz * along];
  const distance = 4.55;
  const camHeight = 1.448;
  const eyeFloor = toward(distance, 0.03);
  const aimFloor = toward(0, 0.03);
  const eye: [number, number, number] = [eyeFloor[0], camHeight, eyeFloor[2]];
  const aim: [number, number, number] = [aimFloor[0], camHeight, aimFloor[2]];
  // A long lens: 1.17 m of frame height at 5 m, the figure a little nearer (its 0.28 m chest
  // fills the reference's 198 px).
  const fov = (2 * Math.atan(0.585 / 5) * 180) / Math.PI;
  // The haze light: behind the head and a little toward the way the figure faces, its beam
  // down the lens — an aura round the head and the shoulder, brighter before the face (80)
  // than at the back-to-back seam (40). Position, phase and power were fitted to the
  // reference's background luminance on a 24 × 10 grid (log-RMS 0.21).
  const behind = toward(-1.3, 0.3);
  const light: [number, number, number] = [behind[0], 1.65, behind[2]];
  const lightDir: [number, number, number] = [side[0], -0.05, side[2]];
  const lightColor: [number, number, number] = [0.52, 0.9, 1];
  // The rim light: a hard source behind the figure on its BACK side, at head height — the
  // reference's rim is on the nape, the back of the head and the shoulder, not the face.
  const rimAt = toward(-0.3, -0.5);
  const rimLight: [number, number, number] = [rimAt[0], 2.0, rimAt[2]];

  const g = new ShotGraph();
  g.node("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: SURFACE_WGSL }, { label: "surf1" });
  // The jut lifts the whole figure a little (a bounce in the knees); the turn yaws it away.
  const figure = figureNodes(facts, {
    area: "fignocap",
    material: "surf1",
    yaw: `${yawFor(stage.facing).toFixed(5)} - 0.5 * (${TURN})`,
    place: [at[0], `${at[1]} + 0.03 * (${JUT})`, at[2]],
    pose: performance(),
  });
  g.nodes.push(...figure.nodes);
  g.edges.push(...figure.edges);

  // A breath of handheld on a locked-off long lens: a few millimetres, a tenth of a degree.
  const t = "abstime";
  const handX = handheld(t, 0.004, 1);
  const handY = handheld(t, 0.003, 2);
  g.node("cam", "camera", [-2700, -900], {
    eye,
    lookAt: aim,
    "eye.x": expressionSlot(`${eye[0]} + ${handX}`, eye[0]),
    "eye.y": expressionSlot(`${eye[1]} + ${handY}`, eye[1]),
    "lookAt.x": expressionSlot(`${aim[0]} + ${handX}`, aim[0]),
    "lookAt.y": expressionSlot(`${aim[1]} + ${handY}`, aim[1]),
    fov,
    roll: expressionSlot(handheld(t, -0.12, 4, 0.7), 0),
    near: 0.1,
    far: 60,
  }, { label: "cam1" });
  const cameraParams = cameraRefs("cam1", eye, aim, fov, 60);

  // The backlight lights what faces it — the upturned palms, the tops of the shoulders.
  g.node("back", "light", [-2600, 1000], { kind: "point", color: [...lightColor, 1], intensity: 6, position: light }, { label: "back1" });
  // T1417b: the backlight's own view of the figure, for the haze's shadow — a zero-intensity
  // casting copy (it lights nothing) and a Render that exports its cube map as Light Depth.
  // 512-texel faces: a centimetre at the figure, 1.3 m off.
  const shadowRange = 8;
  g.node("backShadow", "light", [-2600, 1100], { kind: "point", color: [...lightColor, 1], intensity: 0, position: light, shadows: true, shadowExtent: shadowRange, shadowSoftness: 0 }, { label: "backshadow1" });
  g.node("backView", "render", [-2400, 300], {
    scenes: figure.scene,
    camera: "cam1",
    lights: "backshadow1",
    ambientIntensity: 0,
    background: [0, 0, 0, 0],
    environmentIntensity: 0,
    lightDepthOutput: true,
  }, { label: "backview1", resolution: { mode: "fixed", width: 1536, height: 1024 } });
  g.node("shot", "render", [-2400, 0], {
    scenes: figure.scene,
    camera: "cam1",
    lights: "back1",
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: 0,
    // Alpha 0 behind the figure: the resolved alpha is the silhouette's coverage.
    background: [0, 0, 0, 0],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    environmentIntensity: 0,
  }, { label: "shot1" });

  const depth = ["shot", "depth"] as const;
  g.pass("haze", QUAD_HAZE_WGSL, {
    ...cameraParams,
    light,
    lightDir,
    cosOuter: Math.cos((32 * Math.PI) / 180),
    cosInner: Math.cos((8 * Math.PI) / 180),
    color: [...lightColor, 1],
    intensity: 400,
    density: 0.09,
    anisotropy: 0.4,
    core: 0.6,
    reach: distance + 3,
    billow: 0.9,
    billowScale: 2.2,
    rise: 0.09,
    range: shadowRange,
    shadowBias: 0.03,
    plane: distance,
    frontShare: 0.15,
    depth: 1.6,
    wash: 0.04,
    washCore: 0.9,
    ceiling: 1.85,
  }, ["shot", "out"], [depth, ["backView", "lightDepth"]], [-2100, 0]);
  g.pass("comp", QUAD_COMPOSITE_WGSL, {
    ...cameraParams,
    color: [...lightColor, 1],
    rimLight,
    rimColor: [0.85, 0.97, 1, 1],
    rimIntensity: 8,
    rimWrap: 0.4,
    // Aimed at the nape: the head and shoulders in the cone, the rim fading down the back.
    rimAim: [at[0], 1.6, at[2]],
    rimCosOuter: Math.cos((26 * Math.PI) / 180),
    rimCosInner: Math.cos((8 * Math.PI) / 180),
    rimWidth: 0.006,
    glowGain: 0.5,
    glowNorm: 0.1,
    glowPower: 3,
    rimWhite: 0.65,
    rimFuzz: 0.35,
  }, ["shot", "out"], [depth, ["haze", "out"], ["shot", "normal"]], [-1900, 0]);
  // ── Optics: the thin streak lines off the rim, a soft bloom ──
  g.optics(g.last, { threshold: 1.2, knee: 0.6, reach: 0.45, streak: 0.02, bloom: 0.15 });

  // ── The four-way mirror, then the lens and the grade over the composite ──
  // Placed so strip 3 matches the reference at the start: crown centre x 1120 px, chest
  // 1086–1284 px at row 500 (the Render centres the figure; the window starts 9 px early).
  // Tile's seams layout with the outer tiles unfolded (T1413b): the seam at AXIS, strips STRIP
  // wide, the tile right of it unflipped, the two strips the frame edges cut running on.
  const window = 0.5 - 0.605 * STRIP - 9 / 1920;
  g.node("mirror", "tile", [-300, 0], { layout: "seams", seam: [AXIS, 0], tilesize: [STRIP, 1], mirrorx: true, unfoldx: true, cropleft: window, cropright: window + STRIP }, { label: "mirror1" });
  g.edge("optics-mirror", g.last, ["mirror", "input"]);
  g.last = ["mirror", "out"];
  g.pass("lens", LENS_WGSL, { distortion: 0.02, edgeBlur: 0.01, aberration: 0.001, vignette: 0.55, vignetteRound: 0.6 }, g.last, [], [-100, 0]);
  g.pass("grade", GRADE_WGSL, { exposure: 0, black: 0.02, contrast: 1.15, saturation: 0.85, keepWarm: 0.5, bleach: 0.2, steel: [0.94, 1.0, 1.03], shadowTint: [0.96, 1.0, 1.04, 1], split: 0.3, lift: 0.06, grain: 0.025 }, g.last, [], [100, 0]);
  return g.document("quad", width, height);
}
