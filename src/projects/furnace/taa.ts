import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, VIEW } from "./screen-space.ts";

/**
 * T1354b / T1374b — TEMPORAL ANTI-ALIASING: the crawl on gratings, rails and cables is what
 * reads cheapest. Each frame the camera sits a sub-pixel away from the last (the handheld
 * drift plus a per-frame jitter in camera-path.ts), so the history holds other samples of the
 * same surfaces. Reproject last frame's result through the previous camera (from depth, the
 * motion blur's arithmetic), clamp it to this frame's 3×3 neighbourhood so nothing ghosts, and
 * blend a little of the new frame in. On a cut the history is dropped.
 *
 * Inputs: Input = this frame, More = [Depth, history (a Feedback of this pass)].
 */
export const TAA_WGSL = `struct Params {
${CAMERA_PARAMS}
  prevEye: vec3f, // @default 0  The camera's position one frame ago.
  prevAim: vec3f, // @default 0  The camera's look-at one frame ago.
  prevFov: f32, // @default 50  The camera's fov one frame ago.
  prevRoll: f32, // @default 0  The camera's roll one frame ago, degrees.
  blend: f32, // @default 0.12  Share of the new frame each frame.
  reset: f32, // @default 0  Above 0.5 the history is dropped (a cut).
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
${VIEW}

fn projectWith(eye: vec3f, aim: vec3f, fov: f32, roll: f32, aspect: f32, world: vec3f) -> vec2f {
  let forward = normalize(aim - eye);
  let right = rolledRight(forward, roll);
  let up = cross(right, forward);
  let tanHalf = tan(radians(fov) * 0.5);
  let rel = world - eye;
  let z = max(dot(rel, forward), 1e-4);
  return vec2f(dot(rel, right) / (z * tanHalf * aspect) * 0.5 + 0.5, 0.5 - dot(rel, up) / (z * tanHalf) * 0.5);
}

fn historyAt(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(inputTexture2));
  let g = uv * size - 0.5;
  let b = vec2i(floor(g));
  let f = fract(g);
  let lim = vec2i(size) - vec2i(1);
  let h00 = textureLoad(inputTexture2, clamp(b, vec2i(0), lim), 0).rgb;
  let h10 = textureLoad(inputTexture2, clamp(b + vec2i(1, 0), vec2i(0), lim), 0).rgb;
  let h01 = textureLoad(inputTexture2, clamp(b + vec2i(0, 1), vec2i(0), lim), 0).rgb;
  let h11 = textureLoad(inputTexture2, clamp(b + vec2i(1, 1), vec2i(0), lim), 0).rgb;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let px = vec2i(uv * size);
  let current = textureLoad(inputTexture, px, 0);
  if (params.reset > 0.5) { return current; }
  // The 3×3 neighbourhood's range (in a tone-compressed space, so a spark does not blow it open).
  var lo = vec3f(1e9);
  var hi = vec3f(-1e9);
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let c = textureLoad(inputTexture, clamp(px + vec2i(x, y), vec2i(0), vec2i(size) - vec2i(1)), 0).rgb;
      let t = c / (1.0 + c);
      lo = min(lo, t);
      hi = max(hi, t);
    }
  }
  let v = makeView();
  var z = viewDepth(uv);
  if (z < 0.0) { z = params.far * 0.5; }
  let previous = projectWith(params.prevEye, params.prevAim, params.prevFov, params.prevRoll, v.aspect, worldAt(v, uv, z));
  if (any(previous < vec2f(0.0)) || any(previous > vec2f(1.0))) { return current; }
  let h = historyAt(previous);
  let ht = clamp(h / (1.0 + h), lo, hi);
  let clamped = ht / max(vec3f(1.0) - ht, vec3f(1e-4));
  return vec4f(mix(clamped, current.rgb, params.blend), current.a);
}`;
