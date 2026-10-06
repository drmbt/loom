import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1561b — A GLITCH: the picture tears, for a few frames.
 *
 * The owner, 2026-10-06: "Maybe we can even introduce some statics and glitches, very occasionally, as one
 * highlight." So it is not a texture laid over the piece: it happens when the PLACE changes (document.ts: a
 * pulse a third of a second long on the change, four or five times in a track), where it is also the seam
 * between two worlds, and when the panel's Glitch is pushed by hand.
 *
 * What it does, all of it scaled by `amount` and redrawn thirty times a second: bands of the picture (of two
 * sizes laid over each other, most of them left alone so the picture holds) slide sideways and wrap; the three
 * colours come apart sideways, more in a torn band; and a few thin bands are snow. At 0 the picture goes through
 * untouched, to the bit.
 */
export const GLITCH_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  amount: f32, // @default 0  How much, 0 to 1. At 0 the picture goes through untouched.
  bands: f32, // @default 26  How many thin bands the picture tears into, top to bottom.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

fn glitchLot(a: f32, b: f32) -> f32 {
  let n = (u32(i32(a) + 65536) * 73856093u) ^ (u32(i32(b) + 65536) * 19349663u);
  let m = (n ^ (n >> 15u)) * 2246822519u;
  return f32((m ^ (m >> 13u)) >> 8u) / 16777216.0;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let amount = clamp(params.amount, 0.0, 1.0);
  if (amount <= 0.0) { return textureSampleLevel(inputTexture, inputSampler, uv, 0.0); }
  let tick = floor(frameU.absTime * 30.0);
  // Bands of two sizes, each set of them moved up or down a little every tick.
  let wide = floor(uv.y * params.bands * 0.3 + glitchLot(tick, 1.0) * 7.0);
  let thin = floor(uv.y * params.bands + glitchLot(tick, 2.0) * 13.0);
  // A band tears if its lot is under the amount: at the most half the wide ones and a third of the thin.
  let tornWide = step(glitchLot(wide, tick + 11.0), amount * 0.5);
  let tornThin = step(glitchLot(thin, tick + 23.0), amount * 0.35);
  let slide = ((glitchLot(wide, tick + 3.0) - 0.5) * 0.24 * tornWide + (glitchLot(thin, tick + 5.0) - 0.5) * 0.08 * tornThin) * amount;
  let at = vec2f(fract(uv.x + slide), uv.y);
  // The colours come apart sideways.
  let apart = 0.012 * amount * (0.4 + tornWide + tornThin);
  let red = textureSampleLevel(inputTexture, inputSampler, vec2f(fract(at.x + apart), at.y), 0.0).r;
  let middle = textureSampleLevel(inputTexture, inputSampler, at, 0.0);
  let blue = textureSampleLevel(inputTexture, inputSampler, vec2f(fract(at.x - apart), at.y), 0.0).b;
  var colour = vec3f(red, middle.g, blue);
  // Snow: in a few of the thin bands, two pixels to a grain.
  let snowy = step(glitchLot(thin, tick + 41.0), amount * 0.16);
  let grain = floor(uv * frameU.resolution * 0.5);
  // (Dim snow: this piece is dark, and at 0.8 a band of it was the brightest thing in the frame.)
  colour = mix(colour, vec3f(glitchLot(grain.x + grain.y * 4099.0, tick + 7.0)) * 0.3, snowy * 0.85);
  return vec4f(colour, middle.a);
}`;
