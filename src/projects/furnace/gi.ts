import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, VIEW } from "./screen-space.ts";

/**
 * T1354b / T1373b — SCREEN-SPACE GLOBAL ILLUMINATION, one bounce: what makes a hot thing
 * belong to its surroundings. Molten slag lights the trough it runs in, the ladle throws
 * orange up its own rim, the door glow spills over the deck — which is the difference between
 * an engine's GI and a scene of glowing objects on black.
 *
 * Per pixel (half resolution): gather the lit frame (a quarter-resolution copy, so one sample
 * stands for a patch of surface) at points spread over a world-space disc around it, and add
 * each as a small area light — its radiance × both cosines × its patch area over distance².
 * The lit frame includes every emissive surface AND everything already lit, so this is one
 * bounce of both. No occlusion between points (GTAO, which runs after, takes care of the
 * contact darkening). Noise from the sample rotation is blurred and composited by GI_COMPOSITE.
 *
 * Inputs: Input = the lit frame at quarter resolution, More = [Depth, Normal].
 */
export const SSGI_WGSL = `struct Params {
${CAMERA_PARAMS}
  radius: f32, // @default 6  Gather radius, metres.
  strength: f32, // @default 1  Bounce strength.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
${VIEW}
const SAMPLES: u32 = 24u;

fn normalAt(uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(inputTexture2));
  return textureLoad(inputTexture2, clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1)), 0);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let z = viewDepth(uv);
  let n4 = normalAt(uv);
  if (z < 0.0 || n4.a <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let v = makeView();
  let p = worldAt(v, uv, z);
  let n = normalize(n4.rgb * 2.0 - 1.0);
  // The disc's radius on screen, in uv, at this depth.
  let reach = params.radius / (z * 2.0 * v.tanHalf);
  let spin = fract(52.9829189 * fract(dot(uv * frameU.resolution, vec2f(0.06711056, 0.00583715)))) * 6.2831853;
  let patchArea = 3.1415927 * params.radius * params.radius / f32(SAMPLES);
  var gathered = vec3f(0.0);
  for (var i = 0u; i < SAMPLES; i = i + 1u) {
    let a = f32(i) * 2.3999632 + spin;
    let r = sqrt((f32(i) + 0.5) / f32(SAMPLES)) * reach;
    let s = uv + vec2f(cos(a) / v.aspect, sin(a)) * r;
    if (any(s < vec2f(0.0)) || any(s > vec2f(1.0))) { continue; }
    let zs = viewDepth(s);
    let ns4 = normalAt(s);
    if (zs < 0.0 || ns4.a <= 0.0) { continue; }
    let q = worldAt(v, s, zs);
    let d = q - p;
    let d2 = max(dot(d, d), 1e-4);
    let dir = d * inverseSqrt(d2);
    let cosHere = max(dot(n, dir), 0.0);
    // The emitting patch: its facing matters, but a glowing surface radiates wide.
    let cosThere = max(dot(normalize(ns4.rgb * 2.0 - 1.0), -dir), 0.0) * 0.75 + 0.25;
    let radiance = textureSampleLevel(inputTexture, inputSampler, s, 0.0).rgb;
    gathered = gathered + radiance * cosHere * cosThere * patchArea / (3.1415927 * d2 + patchArea);
  }
  return vec4f(gathered * params.strength, 1.0);
}`;

/**
 * Full resolution: lit + the bounce × the surface's albedo (metals take less — a mirror has no
 * diffuse to relight). Inputs: Input = the lit frame, More = [GI (blurred, half res), Albedo].
 */
export const GI_COMPOSITE_WGSL = `struct Params {
  amount: f32, // @default 1  Master level of the bounce.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;

fn at(tex: texture_2d<f32>, p: vec2i) -> vec4f {
  let size = vec2i(textureDimensions(tex));
  return textureLoad(tex, clamp(p, vec2i(0), size - vec2i(1)), 0);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let lit = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let size = vec2f(textureDimensions(inputTexture1));
  let g = uv * size - 0.5;
  let b = vec2i(floor(g));
  let f = fract(g);
  let gi = mix(mix(at(inputTexture1, b), at(inputTexture1, b + vec2i(1, 0)), f.x), mix(at(inputTexture1, b + vec2i(0, 1)), at(inputTexture1, b + vec2i(1, 1)), f.x), f.y).rgb;
  let base = at(inputTexture2, vec2i(uv * vec2f(textureDimensions(inputTexture2))));
  let diffuse = base.rgb * (1.0 - base.a * 0.7);
  return vec4f(lit.rgb + diffuse * gi * params.amount, lit.a);
}`;
