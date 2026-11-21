import { SRGB_TRANSFER_WGSL } from "../../../domain/color/display.ts";
import { ALPHA_DISPLAY_WGSL } from "../alpha-display.wgsl.ts";
import { wgsl } from "../wgsl.ts";

const BINDINGS = wgsl`@group(0) @binding(0) var blitSampler: sampler;
@group(0) @binding(1) var blitSource: texture_2d<f32>;`;

/** Raw payload copy: perform surfaces, export transports, and already-opaque preview tiles. */
export const BLIT_WGSL = wgsl`${BINDINGS}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(blitSource, blitSampler, uv);
}`;

/**
 * VN132 — a premultiplied surface (a native output that keeps alpha): the payload as it is,
 * clamped to [0, 1] so arithmetic alpha (T674: ±65504 from a feedback loop) cannot reach the
 * compositor as an out-of-range premultiplied pixel.
 */
export const PREMULTIPLIED_BLIT_WGSL = wgsl`${BINDINGS}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return clamp(textureSample(blitSource, blitSampler, uv), vec4f(0.0), vec4f(1.0));
}`;

/** Viewer inspection of display-encoded RGB with straight alpha; never an output transform. */
export const RGBA_BLIT_WGSL = wgsl`${BINDINGS}
${SRGB_TRANSFER_WGSL}
${ALPHA_DISPLAY_WGSL}
@fragment
fn fs(@builtin(position) fragment: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let raw = textureSampleLevel(blitSource, blitSampler, uv, 0.0);
  // Preserve opaque and arithmetic-alpha RGB exactly: no decode/encode round trip.
  if (!(raw.a >= 0.0 && raw.a < 1.0)) { return vec4f(raw.rgb, 1.0); }
  let over = compositeCoverageLinear(decodeDisplay(raw.rgb), raw.a, fragment.xy, 8.0);
  return vec4f(encodeDisplay(over), 1.0);
}`;
