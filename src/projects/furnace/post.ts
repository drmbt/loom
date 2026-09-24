import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1354b — the furnace's post: a bright pass for the bloom chain, and the GRADE that turns
 * linear HDR into the film look — exposure, a filmic shoulder, a teal-shadow / warm-highlight
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

/** Keeps only what is brighter than the threshold, with a soft knee. Run at half resolution. */
export const BRIGHT_PASS_WGSL = `struct Params {
  threshold: f32, // @default 1.2  Linear radiance where bloom starts.
  knee: f32, // @default 0.8  Softness of the threshold.
};
${INPUT}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let brightness = max(color.r, max(color.g, color.b));
  let soft = clamp(brightness - params.threshold + params.knee, 0.0, 2.0 * params.knee);
  let weight = max(soft * soft / (4.0 * params.knee + 1e-4), brightness - params.threshold) / max(brightness, 1e-4);
  return vec4f(color * weight, 1.0);
}`;

export const GRADE_WGSL = `struct Params {
  exposure: f32, // @default 0  Exposure in stops.
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

// Narkowicz's ACES fit with the input pre-scaled, so 1.0 in lands near 0.8 out.
fn filmic(x: vec3f) -> vec3f {
  let a = x * 0.6;
  return clamp((a * (2.51 * a + 0.03)) / (a * (2.43 * a + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centre = uv - vec2f(0.5);
  let edge = dot(centre, centre);
  let shift = centre * params.aberration * (1.0 + edge * 4.0);
  let r = textureSampleLevel(inputTexture, inputSampler, uv + shift, 0.0).r;
  let g = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).g;
  let b = textureSampleLevel(inputTexture, inputSampler, uv - shift, 0.0).b;
  var color = vec3f(r, g, b) * exp2(params.exposure);
  color = filmic(color);
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
