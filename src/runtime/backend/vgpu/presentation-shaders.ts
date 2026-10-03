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
