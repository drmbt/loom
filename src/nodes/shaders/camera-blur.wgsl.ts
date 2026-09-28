import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";

/**
 * CAMERA BLUR (T1421b): the smear a moving camera's shutter leaves, from the camera path's
 * DERIVATIVE rather than a frame-to-frame difference.
 *
 * Each pixel's point in the world is rebuilt from the current camera (the Depth input's
 * view-plane distance, or a point at infinity where there is no surface or no depth), taken
 * into the camera a hair along its path (`prev*`, the pose `dt` seconds away, laid out by the
 * CPU relative to the current eye, so nothing cancels in f32), and projected: the screen
 * displacement over `dt`, scaled by the shutter (`scale` = shutter seconds ÷ dt), is the
 * smear. Linearised at the instantaneous direction, so a whip turning 40° a frame smears
 * along its turn instead of reprojecting from behind the lens. The smear is centred on the
 * pixel (a shutter centred on the frame), capped at `maxBlur` frame heights, and gathered in
 * 32 samples jittered per pixel and frame; reads that leave the frame mirror at its edge.
 * Enabled 0 (no camera, an orthographic one) passes the input through.
 *
 * Basis vectors ride in vec4s: `right.w` = tan(fov/2), `up.w` = aspect, `forward.w` = far.
 */
export const CAMERA_BLUR_WGSL = wgsl`${SHARED_UNIFORMS_WGSL}

struct Params {
  right: vec4f,
  up: vec4f,
  forward: vec4f,
  prevRight: vec4f,
  prevUp: vec4f,
  prevForward: vec4f,
  prevEye: vec4f,
  scale: f32,
  maxBlur: f32,
  useDepth: f32,
  enabled: f32,
};
@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var inputSampler: sampler;
@group(0) @binding(3) var inputTexture: texture_2d<f32>;
@group(0) @binding(4) var depthTexture: texture_2d<f32>;

const SAMPLES: i32 = 32;
// A point with no surface behind it: far enough that the eye's own travel moves it by nothing.
const INFINITY: f32 = 1e6;

fn ignHash(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centre = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  if (params.enabled < 0.5) { return centre; }
  let size = vec2f(textureDimensions(inputTexture));
  let tanHalf = params.right.w;
  let aspect = params.up.w;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  // The view ray with a forward component of 1, so ray * z lands at view-plane distance z.
  let ray = params.forward.xyz + params.right.xyz * ndc.x * tanHalf * aspect + params.up.xyz * ndc.y * tanHalf;
  var z = INFINITY;
  if (params.useDepth > 0.5) {
    let dsize = vec2f(textureDimensions(depthTexture));
    let d = textureLoad(depthTexture, clamp(vec2i(uv * dsize), vec2i(0), vec2i(dsize) - vec2i(1)), 0).r;
    if (d > 0.0 && d < 0.9999) { z = d * params.forward.w; }
  }
  // The point relative to the camera a hair along its path.
  let rel = ray * z - params.prevEye.xyz;
  let zp = dot(rel, params.prevForward.xyz);
  if (zp <= 1e-6) { return centre; }
  let prevTan = params.prevRight.w;
  let prev = vec2f(
    dot(rel, params.prevRight.xyz) / (zp * prevTan * aspect) * 0.5 + 0.5,
    0.5 - dot(rel, params.prevUp.xyz) / (zp * prevTan) * 0.5,
  );
  var velocity = (uv - prev) * params.scale;
  // In frame heights: cap the smear's length.
  let reach = length(velocity * vec2f(aspect, 1.0));
  if (reach > params.maxBlur) { velocity = velocity * (params.maxBlur / reach); }
  if (length(velocity * size) < 0.5) { return centre; }
  let jitter = ignHash(uv * size + vec2f(frameU.absFrame * 1.7, 0.0)) - 0.5;
  var sum = vec3f(0.0);
  for (var i = 0; i < SAMPLES; i = i + 1) {
    let t = (f32(i) + 0.5 + jitter) / f32(SAMPLES) - 0.5;
    var at = uv + velocity * t;
    at = 1.0 - abs(1.0 - abs(at) % 2.0);
    sum = sum + textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb;
  }
  return vec4f(sum / f32(SAMPLES), centre.a);
}`;
