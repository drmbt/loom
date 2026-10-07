import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1354b — the furnace's GRADE turns
 * linear HDR into the film look — exposure, AgX, a teal-shadow / warm-highlight
 * split, saturation, lateral chromatic aberration, vignette and moving grain. The Output then
 * runs with its tone map OFF: the curve lives here, where the grade can sit on either side
 * of it.
 */

const INPUT = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
`;
const INPUT_AND_FRAME = `${SHARED_UNIFORMS_WGSL}
${INPUT}@group(0) @binding(2) var<uniform> frameU: SharedFrame;
`;

export const GRADE_WGSL = `struct Params {
  exposure: f32, // @default 0  Exposure compensation in stops, on top of the adaptation.
  adapt: f32, // @default 1  Auto-exposure gain (driven by the meter: key ÷ metered log-average).
  punch: f32, // @default 1.15  AgX look: contrast slope (1 = the base curve).
  punchSaturation: f32, // @default 1.2  AgX look: saturation in the curve.
  contrast: f32, // @default 1.08  Contrast around mid-grey after the curve.
  saturation: f32, // @default 0.92  1 keeps colour; lower desaturates the steel.
  shadowTint: vec3f, // @default 0.9  Colour pushed into the shadows (teal-steel).
  highlightTint: vec3f, // @default 1  Colour pushed into the highlights (warm).
  split: f32, // @default 0.35  Strength of the shadow / highlight split.
  aberration: f32, // @default 0.0025  Lateral chromatic aberration at the frame edge.
  vignette: f32, // @default 0.45  Darkening toward the corners.
  grain: f32, // @default 0.035  Film grain amount.
};
${INPUT_AND_FRAME}
fn gradeHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

// AgX (Troy Sobotka's, via Benjamin Wrensch's minimal fit): a log encoding into a
// sigmoid, so hot sources roll toward white through their own hue instead of clipping or
// skewing salmon — what separates molten steel from an orange lamp at the top of the range.
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agx(color: vec3f) -> vec3f {
  let inset = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let outset = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var v = inset * max(color, vec3f(1e-10));
  v = clamp(log2(v), vec3f(minEv), vec3f(maxEv));
  v = (v - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  // The "punchy" look: a touch more slope and saturation before leaving the log space.
  let luma = dot(v, vec3f(0.2126, 0.7152, 0.0722));
  v = pow(max(v, vec3f(0.0)), vec3f(params.punch));
  v = luma + (v - luma) * params.punchSaturation;
  v = outset * v;
  // Back to linear display light; the Output encodes it.
  return pow(clamp(v, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centre = uv - vec2f(0.5);
  let edge = dot(centre, centre);
  let shift = centre * params.aberration * (1.0 + edge * 4.0);
  let r = textureSampleLevel(inputTexture, inputSampler, uv + shift, 0.0).r;
  let g = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).g;
  let b = textureSampleLevel(inputTexture, inputSampler, uv - shift, 0.0).b;
  var color = vec3f(r, g, b) * params.adapt * exp2(params.exposure);
  color = agx(color);
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(vec3f(luma), color, params.saturation);
  let shadowWeight = (1.0 - smoothstep(0.0, 0.45, luma)) * params.split;
  let highlightWeight = smoothstep(0.4, 1.0, luma) * params.split;
  color = color * mix(vec3f(1.0), params.shadowTint, shadowWeight) * mix(vec3f(1.0), params.highlightTint, highlightWeight);
  color = clamp((color - 0.18) * params.contrast + 0.18, vec3f(0.0), vec3f(1.0));
  color = color * (1.0 - params.vignette * smoothstep(0.08, 0.5, edge));
  let noise = gradeHash(vec3f(uv * frameU.resolution, frameU.absFrame)) - 0.5;
  color = color + noise * params.grain * (0.4 + 0.6 * (1.0 - luma));
  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}`;
