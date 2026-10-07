/** Shared clockless HDR bloom filters. Graph recipes own their passes and image addition stays downstream. */

const INPUT = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
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

/**
 * The BLOOM PYRAMID's downsample (Jimenez, "Next Generation Post Processing in Call of Duty:
 * Advanced Warfare"): 13 bilinear taps in five overlapping boxes, weighted so a lamp a few
 * pixels wide spreads as a round, energy-preserving blob instead of landing whole in one
 * low-resolution texel — the texel that, blurred and stretched back up, was a SQUARE halo.
 * Run each level at half the resolution of its input.
 */
export const BLOOM_DOWN_WGSL = `struct Params {
  clampLuma: f32, // @default 0  Above 0: the first level's firefly clamp (Karis average weight).
};
${INPUT}
fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
}

fn karis(c: vec3f) -> f32 {
  return select(1.0, 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722))), params.clampLuma > 0.0);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(inputTexture));
  let a = tap(uv + t * vec2f(-2.0, -2.0)); let b = tap(uv + t * vec2f(0.0, -2.0)); let c = tap(uv + t * vec2f(2.0, -2.0));
  let d = tap(uv + t * vec2f(-2.0, 0.0));  let e = tap(uv);                          let f = tap(uv + t * vec2f(2.0, 0.0));
  let g = tap(uv + t * vec2f(-2.0, 2.0));  let h = tap(uv + t * vec2f(0.0, 2.0));  let i = tap(uv + t * vec2f(2.0, 2.0));
  let j = tap(uv + t * vec2f(-1.0, -1.0)); let k = tap(uv + t * vec2f(1.0, -1.0));
  let l = tap(uv + t * vec2f(-1.0, 1.0));  let m = tap(uv + t * vec2f(1.0, 1.0));
  // Five boxes: the centre one weighted 0.5, the four corner ones 0.125 each.
  let b0 = (j + k + l + m) * 0.25;
  let b1 = (a + b + d + e) * 0.25;
  let b2 = (b + c + e + f) * 0.25;
  let b3 = (d + e + g + h) * 0.25;
  let b4 = (e + f + h + i) * 0.25;
  let w0 = 0.5 * karis(b0);
  let w1 = 0.125 * karis(b1); let w2 = 0.125 * karis(b2); let w3 = 0.125 * karis(b3); let w4 = 0.125 * karis(b4);
  let sum = (b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + b4 * w4) / max(w0 + w1 + w2 + w3 + w4, 1e-6);
  return vec4f(sum, 1.0);
}`;

/**
 * The pyramid's upsample: the LOWER level (the sampled input) read through a 3×3 tent,
 * added to this level's own downsample (More, same resolution). Chained from the smallest
 * level up, each step widens the glow by a factor of two with no visible texel anywhere.
 */
export const BLOOM_UP_WGSL = `struct Params {
  radius: f32, // @default 1  Tent radius, in texels of the lower level.
  lower: f32, // @default 1  Weight of the wider glow coming up from below.
};
${INPUT}@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.radius / vec2f(textureDimensions(inputTexture));
  var wide = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb * 4.0;
  wide = wide + (textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-t.x, 0.0), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(t.x, 0.0), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(0.0, -t.y), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  wide = wide + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-t.x, -t.y), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(t.x, -t.y), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-t.x, t.y), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(t.x, t.y), 0.0).rgb;
  let size = vec2f(textureDimensions(inputTexture1));
  let own = textureLoad(inputTexture1, clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1)), 0).rgb;
  // An AVERAGE, not a sum: summing every level multiplied the bright pass's energy about 7×
  // on its way up, and the glow washed the frame.
  return vec4f(mix(own, wide / 16.0, params.lower * 0.5), 1.0);
}`;
