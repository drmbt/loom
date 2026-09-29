import { WGSL_EXTEND } from "./common.wgsl.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";

/**
 * Corner Pin's fragment shader (T1491b) — a per-pixel inverse homography.
 *
 * `pin0..2` are the rows of the OUTPUT → UNIT-SQUARE map (the inverse of the pin quad's
 * homography, signed so w is positive on the pinned surface); `ext0..2` the rows of the
 * UNIT-SQUARE → INPUT map (the extract quad's homography). Both are solved on the CPU in the
 * definition, so this is two 3×3 products and two divisions — perspective-correct at every
 * pixel, with no triangle seam.
 *
 * Coordinates are y UP (TD's and the parameters'), while the fragment `uv` runs down, so the
 * output point is `(uv.x, 1 - uv.y)` and the input sample is flipped back the same way.
 *
 * `w <= 0` is past the pinned plane's horizon: there is no surface there in any extend mode,
 * and dividing would hand the sampler an infinity. `valid` is 0 when the definition refused
 * a degenerate quad — the output is then transparent everywhere, never NaN.
 *
 * FEATHER fades every channel, colour included, not alpha alone — the one place this node
 * departs from the catalogue's straight-alpha rule (composite.wgsl.ts), for Mask's B189
 * reason: this node's picture goes to a projector, and a projector shows rgb. A soft edge
 * carried only in alpha would be a hard edge on the wall. It is a crossfade to the outside
 * value, which is transparent black, so the ramp meets the outside with no step.
 *
 * COLOUR (§V56): it moves pixels and never changes their values (the feather aside).
 */
export const CORNER_PIN_FRAGMENT_WGSL = wgsl`${WGSL_EXTEND}

struct Params {
  pin0: vec4f,
  pin1: vec4f,
  pin2: vec4f,
  ext0: vec4f,
  ext1: vec4f,
  ext2: vec4f,
  extend: f32,
  feather: f32,
  valid: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (params.valid < 0.5) {
    return vec4f(0.0);
  }
  let p = vec3f(uv.x, 1.0 - uv.y, 1.0);
  let h = vec3f(dot(params.pin0.xyz, p), dot(params.pin1.xyz, p), dot(params.pin2.xyz, p));
  if (h.z <= 0.0) {
    return vec4f(0.0);
  }
  let st = h.xy / h.z;
  let transparent = u32(params.extend + 0.5) == 3u;
  let inside = all(st >= vec2f(0.0)) && all(st <= vec2f(1.0));
  if (transparent && !inside) {
    return vec4f(0.0);
  }
  let local = extendCoord(st, params.extend);
  let e = vec3f(local, 1.0);
  let q = vec3f(dot(params.ext0.xyz, e), dot(params.ext1.xyz, e), dot(params.ext2.xyz, e));
  let source = q.xy / q.z;
  let value = textureSampleLevel(inputTexture, inputSampler, vec2f(source.x, 1.0 - source.y), 0.0);
  if (!transparent || params.feather <= 0.0) {
    return value;
  }
  // Distance to the nearest edge of the pinned surface, in its own unit square.
  let edge = min(st, vec2f(1.0) - st) / params.feather;
  let mask = clamp(edge.x, 0.0, 1.0) * clamp(edge.y, 0.0, 1.0);
  return value * mask;
}`;
