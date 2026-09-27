import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";

/**
 * T1407b (cyc) — the WHITE LIMBO's own finish, fitted to the reference's pixels (1:17 and
 * 1:45; shots/cyc.ts has the measurements).
 *
 * The reference's cyc is not white: the lit floor lands at display 0.77–0.79 (sRGB ~200),
 * never clipping, and only jewellery goes past it. Its colour is one consistent channel curve
 * on a near-neutral picture — red = green^1.22, blue = 0.975 × green^0.95 in display — which is
 * why the lit cyc reads pale steel-cyan and the dark vignette reads deep teal. The blacks sit
 * on a small floor (sRGB 9–13). The vignette is heavy and horizontal: the frame's sides fall
 * to half their centre and the corners further, while the top and bottom barely darken.
 */

const INPUT_AND_FRAME = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
`;

export const CYC_FINISH_WGSL = `struct Params {
  exposure: f32, // @default 0  Stops; 0 puts scene linear 1.0 at Peak.
  peak: f32, // @default 0.79  Display level of scene linear 1.0 (the lit cyc).
  contrast: f32, // @default 1.4  Slope of the curve in log space (above 1 crushes the darks faster than a gamma).
  knee: f32, // @default 0.35  Scene level where the curve is halfway up (relative to the lit cyc).
  black: f32, // @default 0.035  The display floor the blacks sit on.
  saturation: f32, // @default 0.35  Chroma kept before the curve.
  redGamma: f32, // @default 1.22  Display red = green ^ this (the cyan cast, strongest in the darks).
  blueGamma: f32, // @default 0.95  Display blue = BlueGain × green ^ this.
  blueGain: f32, // @default 0.975  (the lit cyc's blue sits just under its green; the darks' just over).
  vignette: f32, // @default 0.5  How far the frame's sides fall (0 off).
  vignetteRadius: f32, // @default 1.02  Elliptical radius (1 = the frame's side) where the sides are half down.
  vignetteHardness: f32, // @default 7.5  How abruptly the vignette arrives.
  vignetteHeight: f32, // @default 0.45  How much the top and bottom count (0 = only the sides darken).
  vignetteBias: f32, // @default 0  Shifts the vignette's centre sideways (uv; + darkens the left more).
  broad: f32, // @default 0.1  A broad centre-weighted falloff under the vignette.
  grain: f32, // @default 0.004  Grain (display units, the reference's is almost gone in the encode).
};
${INPUT_AND_FRAME}
fn finishHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var c = max(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb, vec3f(0.0)) * exp2(params.exposure);
  let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3f(y), c, params.saturation), vec3f(0.0));
  // A log-space sigmoid, normalised so scene 1.0 lands on Peak; highlights run on toward
  // Peak × (1 + knee^contrast) (jewellery glints past the cyc, the cyc never clips).
  let kc = pow(params.knee, params.contrast);
  let u = pow(c, vec3f(params.contrast));
  var d = params.peak * (1.0 + kc) * u / (u + vec3f(kc));
  // The vignette, in display space (a power window as much as a lens).
  let q = (uv - vec2f(0.5 + params.vignetteBias, 0.5)) * 2.0 * vec2f(1.0, params.vignetteHeight);
  let r = length(q);
  let v = (1.0 - params.broad * r * r) / (1.0 + pow(r / params.vignetteRadius, params.vignetteHardness) * params.vignette / max(1.0 - params.vignette, 1e-3));
  d = d * clamp(v, 0.0, 1.0);
  d = clamp(d, vec3f(0.0), vec3f(1.0));
  // The channel curve: the cast lives in the darks.
  let g = d.g;
  d = vec3f(pow(g, params.redGamma) * (d.r / max(g, 1e-4)), g, params.blueGain * pow(g, params.blueGamma) * (d.b / max(g, 1e-4)));
  d = params.black + (1.0 - params.black) * d;
  let px = floor(uv * frameU.resolution);
  let n = finishHash(vec3f(px, frameU.absFrame)) + finishHash(vec3f(px + 17.0, frameU.absFrame * 1.7)) - 1.0;
  d = clamp(d + vec3f(n * params.grain), vec3f(0.0), vec3f(1.0));
  // Linear display light for the Output (tone map off): the exact inverse of its sRGB encode, so the
  // display levels above (the black floor especially) land where they were measured.
  return vec4f(select(pow((d + 0.055) / 1.055, vec3f(2.4)), d / 12.92, d <= vec3f(0.04045)), 1.0);
}`;

/**
 * DIFFUSION (a Pro-Mist in front of the lens): the picture mixed with a wide blur of itself,
 * so the white wraps round the dark silhouettes and lifts the blacks next to it — the
 * reference's soft, glowing figure edges. Input = scene, More = [the wide blur].
 */
export const CYC_MIST_WGSL = `struct Params {
  amount: f32, // @default 0.15  Share of the blur in the mix.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let now = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let wide = textureSampleLevel(inputTexture1, inputSampler, uv, 0.0).rgb;
  return vec4f(mix(now, wide, params.amount), 1.0);
}`;

/**
 * The limbo as an EQUIRECT, for the figures' reflections and sheen. A real cyc is white only
 * where the cyc is: behind the lens stands the dark studio (flags, crew), with the key's big
 * source in it. So the chains read silver — dark with white edges — not white plastic, and the
 * black clothes pick up a pale edge on the cyc side only.
 * Direction convention is the Render's: u = atan2(R.x, −R.z)/2π + 0.5, v = acos(R.y)/π.
 */
export const CYC_ENVIRONMENT_WGSL = `struct Params {
  toward: vec3f, // @default 0  Direction from the set toward the cyc wall (world).
  wall: f32, // @default 1.4  Radiance of the cyc.
  studio: f32, // @default 0.04  Radiance of the dark studio behind the lens.
  keyDir: vec3f, // @default 0  Direction toward the key's source (world; minus its travel).
  keyGain: f32, // @default 12  Radiance of the key's source.
  keySize: f32, // @default 0.12  Its angular radius (radians).
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let unused = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).a * 0.0;
  let phi = (uv.x - 0.5) * 6.2831853;
  let theta = uv.y * 3.1415927;
  let d = vec3f(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
  // The cyc: the half-space toward the wall (up to the grid), and the floor below the horizon.
  let wallSide = smoothstep(-0.25, 0.35, dot(d, normalize(params.toward))) * smoothstep(0.85, 0.5, d.y);
  let floorSide = smoothstep(0.05, -0.2, d.y);
  var radiance = mix(vec3f(params.studio), vec3f(params.wall), max(wallSide, floorSide));
  let key = smoothstep(cos(params.keySize), cos(params.keySize * 0.6), dot(d, normalize(params.keyDir)));
  radiance = radiance + vec3f(params.keyGain * key);
  return vec4f(radiance + vec3f(unused), 1.0);
}`;
