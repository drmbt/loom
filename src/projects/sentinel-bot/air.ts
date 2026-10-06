import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, VIEW } from "../furnace/screen-space.ts";
import { FIELD, strikeWgsl } from "./field.ts";
import { BEAM_GAIN, LAMPS_MIRRORED, LAMP_HANGS, LAMP_PARAMS_WGSL, LAMP_TONE_WGSL, NEAR_LAMPS, lampParameter } from "./tunnel.ts";

/**
 * AIR. Two things, in one pass over the lit frame and the Render's Depth:
 *
 *   haze   the far wall goes into a cold murk that is never quite black, so what stands in
 *          front of it has an outline;
 *   glow   the air itself is lit under every lamp and round the robot's face: what each pixel's
 *          ray picks up on its way to the wall, in even air. Both have a closed form, so there
 *          is no marching. The face is a point (the integral of 1/d² along a line is an
 *          arctangent): a halo. A lamp is a plate that shines down (the cube of the cosine off
 *          straight down, which integrates without an arctangent): a cone hanging from the
 *          plate, and nothing above it. No shadows in either: not shafts between the ribs.
 *
 * IN THE FIELDS (`place` 1; field.ts) the air is another air. It is thin, so a tower four hundred metres off is
 * still a shape; and what closes the view is MIST, lying low: thick at the towers' feet and thinning by e every
 * few metres up, its top in billows that drift. That has a closed form too (the integral of an exponential in
 * height along a straight ray), so there is still no marching. The mist is lit: cold, from behind, as the films'
 * is ("back light mainly the atmos"), a little by the pods, and by LIGHTNING, which also has a glow of its own
 * round where it struck and lights the cloud above. (Its glow is kept small: at three times this the owner, 2026-10-06,
 * of a still: "this weird bright spot in the background that illuminates the whole scene like hard … a bit too much".) Where nothing is drawn there is a SKY: lighter low down all
 * round, a torn ceiling of cloud overhead.
 *
 * (The owner, 2026-10-05: "volumetric light or an approximation could be neat"; "we still
 * missing some haze or something. it looks too clean".) Until a stock haze exists (§T1402b)
 * this is the piece's own; the view helpers are the furnace's.
 */
export const HAZE_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
${CAMERA_PARAMS}
  density: f32, // @default 0.04  How fast the air closes in, per metre.
  color: vec3f, // @default [0.016, 0.04, 0.044]  What the far end of the tunnel fades to: never black.
  glow: f32, // @default 0.002  How much of a light the air between throws at the lens.
${LAMP_PARAMS_WGSL}
  lamp: f32, // @default 26  The lamps' intensity, as their lights have it.
  eyesAt: vec3f, // @default [0, 0, 0.9]  Where the robot's face is.
  eyeColor: vec3f, // @default [1, 0.04, 0.04]  Its light's colour.
  eyes: f32, // @default 1.6  …and intensity, as its light has it.
  place: f32, // @default 0  0 the tunnel, 1 the fields: thin air, mist low down, a sky.
  mist: f32, // @default 1  How much mist lies low in the fields.
  podColor: vec3f, // @default [1, 0.04, 0.04]  The pods' light, which is in the mist a little.
  travel: f32, // @default 0  Distance travelled along the line, metres: the lightning is placed by it.
  strike: f32, // @default 0  Which strike of lightning (field.ts, strikeOf).
  flash: f32, // @default 0  How bright it is now, 0 to 1.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
${VIEW}
${strikeWgsl(FIELD.trunks)}${LAMP_TONE_WGSL}
// A lamp's light hangs this far under its plate (document.ts, lampAt); its lit air starts at the plate.
const LAMP_HANGS: f32 = ${LAMP_HANGS.toFixed(2)};
const BEAM_GAIN: f32 = ${BEAM_GAIN.toFixed(2)};
// How much of a point light at \`light\` the air along a ray throws back, per unit of the light and of the air's
// own share: the integral of 1/d² from the lens out to \`reach\` metres, dimmed by the air it then crosses.
fn airlight(origin: vec3f, ray: vec3f, reach: f32, light: vec3f) -> f32 {
  let q = origin - light;
  let b = dot(ray, q);
  // No nearer than a lamp is wide: a ray through the lamp itself is a bright core, not infinity.
  let c = sqrt(max(dot(q, q) - b * b, 0.03));
  let nearest = clamp(-b, 0.0, reach);
  return (atan((reach + b) / c) - atan(b / c)) / c * exp(-nearest * params.density);
}

// The same for a LAMP, which is not a point: it is a plate in the crown that shines down, most straight down
// and nothing above its own height (the cube of the cosine off straight down). So its lit air is a cone
// hanging from the plate, not a ball round a point under it. That integral is closed too, and has no
// arctangent in it: with s the distance along the ray from its nearest point to the plate, c that nearest
// distance, and the depth under the plate there under + sink * s, it is the integral of
// (under + sink * s)³ / (s² + c²)^(5/2), taken over the part of the ray that is below the plate.
// A hall's lamp is the bigger lamp, by how much higher it hangs (document.ts, lampAt).
fn hallLamp(z: f32) -> f32 {
  return 1.0 + CHAMBER_SWELL * chamberAt(z);
}

fn beamUpTo(s: f32, c2: f32, under: f32, sink: f32) -> f32 {
  let r2 = s * s + c2;
  let r3 = r2 * sqrt(r2);
  let j0 = s / (3.0 * c2 * r3) + 2.0 * s / (3.0 * c2 * c2 * sqrt(r2));
  let j1 = -1.0 / (3.0 * r3);
  let j2 = s * s * s / (3.0 * c2 * r3);
  let j3 = -(3.0 * s * s + 2.0 * c2) / (3.0 * r3);
  return under * under * under * j0 + 3.0 * under * under * sink * j1 + 3.0 * under * sink * sink * j2 + sink * sink * sink * j3;
}

fn beamlight(origin: vec3f, ray: vec3f, reach: f32, plate: vec3f) -> f32 {
  let q = origin - plate;
  let b = dot(ray, q);
  let c2 = max(dot(q, q) - b * b, 0.03);
  let sink = -ray.y;
  let under = b * ray.y - q.y;
  var s0 = b;
  var s1 = reach + b;
  if (sink > 1e-4) {
    s0 = max(s0, -under / sink);
  } else if (sink < -1e-4) {
    s1 = min(s1, -under / sink);
  } else if (under <= 0.0) {
    return 0.0;
  }
  if (s1 <= s0) { return 0.0; }
  let nearest = clamp(-b, s0 - b, s1 - b);
  return max(beamUpTo(s1, c2, under, sink) - beamUpTo(s0, c2, under, sink), 0.0) * BEAM_GAIN * exp(-nearest * params.density);
}

// ── THE FIELDS' AIR ──
const MIST_TOP: f32 = ${FIELD.mistTop.toFixed(1)};
const MIST_FADE: f32 = ${FIELD.mistFade.toFixed(1)};
// How thick the mist is at its top, per metre.
const MIST_THICK: f32 = 0.035;
const STRIKE_TONE = vec3f(0.56, 0.74, 1.0);

fn airHash(p: vec2f) -> f32 {
  var q = fract(p * vec2f(0.1031, 0.1030));
  q += dot(q, q.yx + 33.33);
  return fract((q.x + q.y) * q.x);
}

fn airNoise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(airHash(cell), airHash(cell + vec2f(1.0, 0.0)), u.x), mix(airHash(cell + vec2f(0.0, 1.0)), airHash(cell + vec2f(1.0, 1.0)), u.x), u.y);
}

fn airBillow(p: vec2f) -> f32 {
  return 0.5 * airNoise(p) + 0.3 * airNoise(p * 2.13 + 7.1) + 0.2 * airNoise(p * 4.37 + 3.7);
}

// What is there where nothing is. Lighter low down all round (the air between here and the limit of sight),
// dark overhead but for a ceiling of cloud, torn, that drifts; and lightning lights the cloud over where it struck.
fn skyAt(ray: vec3f, toStrike: vec2f, live: f32) -> vec3f {
  let band = exp(-abs(ray.y) * 4.0);
  let ceiling = ray.xz / (max(ray.y, 0.0) + 0.22);
  let cloud = airBillow(ceiling * 0.55 + vec2f(frameU.absTime * 0.012, 0.0));
  let torn = smoothstep(0.42, 0.78, cloud) * smoothstep(0.0, 0.25, ray.y);
  let toward = max(dot(normalize(ray.xz + vec2f(1e-5)), toStrike), 0.0);
  return params.color * (0.3 + 0.75 * band + 0.9 * torn) + STRIKE_TONE * (live * (0.03 + 0.2 * cloud) * toward * toward * smoothstep(-0.05, 0.3, ray.y));
}

struct Air {
  clear: f32, // how much of what is drawn comes through
  light: vec3f, // what the air itself sends
};

fn fieldAir(origin: vec3f, ray: vec3f, reach: f32) -> Air {
  let strike = strikeOf(params.strike, params.travel);
  let struck = mix(strike.start, strike.end, 0.5);
  let live = params.flash * strike.live;
  // Where this ray meets the mist's top (or, if it never does, where it ends): the top is in billows there.
  let level = pathAt(origin.z).y + MIST_TOP;
  var meets = min(reach, 300.0);
  if (abs(ray.y) > 1e-4) {
    let t = (level - origin.y) / ray.y;
    if (t > 0.0) { meets = min(t, meets); }
  }
  let there = origin + ray * meets;
  let billow = airBillow(there.xz * 0.02 + vec2f(frameU.absTime * 0.02, frameU.absTime * 0.013));
  let top = level + (billow - 0.5) * 16.0;
  // How much air the ray crosses: the thin air everywhere, and the mist, which is thicker by e every MIST_FADE
  // metres down. Along a straight ray that is the integral of an exponential: closed.
  let thin = reach * params.density;
  let under = exp(clamp(-(origin.y - top) / MIST_FADE, -30.0, 3.0));
  let sinks = ray.y / MIST_FADE;
  var along = reach;
  if (abs(sinks) > 1e-5) { along = (1.0 - exp(clamp(-sinks * reach, -30.0, 30.0))) / sinks; }
  let thick = min(MIST_THICK * params.mist * under * along, 20.0);
  var air: Air;
  air.clear = exp(-(thin + thick));
  // The mist is lit from behind and within: cold, more where it is piled up, a little by the pods, and by
  // lightning, most near where it struck.
  let near = 22.0 / (22.0 + distance(there, struck));
  let mist = params.color * (0.4 + 2.3 * billow * billow) + params.podColor * (0.008 + 0.022 * billow) + STRIKE_TONE * (live * 0.6 * near * near);
  let toStrike = normalize(struck.xz - origin.xz + vec2f(1e-4));
  air.light = mix(skyAt(ray, toStrike, live), mist, thick / max(thin + thick, 1e-5)) * (1.0 - air.clear)
    + STRIKE_TONE * (live * 0.4 * airlight(origin, ray, reach, struck));
  return air;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let lit = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let view = makeView();
  let ray = rayAt(view, uv);
  let z = viewDepth(uv);
  // Nothing drawn here: the tunnel's own dark, all haze.
  let reach = select(z / max(dot(ray, view.forward), 1e-4), params.far, z < 0.0);
  let clear = exp(-reach * params.density);
  var air = params.eyeColor * params.eyes * airlight(params.eye, ray, reach, params.eyesAt);
${NEAR_LAMPS.map((index) => `  air = air + lampTone(params.station + ${(index - LAMPS_MIRRORED).toFixed(1)}) * params.lamp * hallLamp(params.${lampParameter(index)}.z) * beamlight(params.eye, ray, reach, params.${lampParameter(index)} + vec3f(0.0, LAMP_HANGS, 0.0));`).join("\n")}
  if (params.place > 0.5) {
    let field = fieldAir(params.eye, ray, reach);
    return vec4f(lit.rgb * field.clear + field.light + air * params.glow, lit.a);
  }
  return vec4f(mix(params.color, lit.rgb, clear) + air * params.glow, lit.a);
}`;
