import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, VIEW } from "../furnace/screen-space.ts";

/**
 * T1407b — DIGITAL GLYPHS TRACKED TO A PLANE (the reference's 2:00): counter digits floating
 * beside a moving car, locked to the perspective plane of its door.
 *
 * Not a sticker in screen space: each pixel's view ray is intersected with a WORLD plane
 * (`origin`, spanned by unit `axisU` along the car and `axisV` up), which the document moves
 * with the car, so the digits hold their place on the door as the camera tracks. Where the
 * scene is nearer than the plane the digits hide behind it. The digits are seven-segment
 * outlines (a stroke around each lit segment), ghosted, with a split of the colour channels and
 * a flicker of scanlines, as the reference's are.
 * Custom WGSL · Multi: Input = the frame, More = [depth].
 */
export const GLYPHS_WGSL = `struct Params {
${CAMERA_PARAMS}
  origin: vec3f, // @default 0  World position of the glyph row's lower-left corner.
  axisU: vec3f, // @default 0  Unit direction along the row (the car's forward).
  axisV: vec3f, // @default 0  Unit direction up the glyphs.
  value: f32, // @default 0  The number shown (its last digits).
  digits: f32, // @default 3  How many digits.
  height: f32, // @default 0.5  Glyph height, metres.
  stroke: f32, // @default 0.012  Outline half-width, metres.
  gain: f32, // @default 2  Glyph radiance.
  ghost: f32, // @default 0.55  Opacity.
  split: f32, // @default 0.01  Channel split, metres.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
${VIEW}
// Segment masks for 0-9: bits a b c d e f g (a top, then clockwise, g middle).
const SEGMENTS = array<u32, 10>(0x3fu, 0x06u, 0x5bu, 0x4fu, 0x66u, 0x6du, 0x7du, 0x07u, 0x7fu, 0x6fu);

fn boxDistance(p: vec2f, centre: vec2f, half: vec2f) -> f32 {
  let d = abs(p - centre) - half;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

// Signed distance to the lit segments of digit n in a cell of width w and height h (origin lower-left).
fn digitDistance(p: vec2f, n: u32, w: f32, h: f32) -> f32 {
  let mask = SEGMENTS[n % 10u];
  let t = h * 0.07;
  let hw = w * 0.5 - t;
  let hh = h * 0.25 - t * 0.5;
  var d = 1e3;
  let cx = w * 0.5;
  // horizontal: a (top), g (middle), d (bottom); vertical: f, b (upper), e, c (lower)
  if ((mask & 0x01u) != 0u) { d = min(d, boxDistance(p, vec2f(cx, h - t), vec2f(hw, t))); }
  if ((mask & 0x40u) != 0u) { d = min(d, boxDistance(p, vec2f(cx, h * 0.5), vec2f(hw, t))); }
  if ((mask & 0x08u) != 0u) { d = min(d, boxDistance(p, vec2f(cx, t), vec2f(hw, t))); }
  if ((mask & 0x20u) != 0u) { d = min(d, boxDistance(p, vec2f(t, h * 0.75), vec2f(t, hh))); }
  if ((mask & 0x02u) != 0u) { d = min(d, boxDistance(p, vec2f(w - t, h * 0.75), vec2f(t, hh))); }
  if ((mask & 0x10u) != 0u) { d = min(d, boxDistance(p, vec2f(t, h * 0.25), vec2f(t, hh))); }
  if ((mask & 0x04u) != 0u) { d = min(d, boxDistance(p, vec2f(w - t, h * 0.25), vec2f(t, hh))); }
  return d - t * 0.35;
}

fn glyphAt(local: vec2f) -> f32 {
  let h = params.height;
  let w = h * 0.55;
  let pitch = w * 1.35;
  let count = max(round(params.digits), 1.0);
  if (local.y < -h * 0.1 || local.y > h * 1.1 || local.x < -pitch * 0.2 || local.x > pitch * count) { return 0.0; }
  let cell = clamp(floor(local.x / pitch), 0.0, count - 1.0);
  let place = count - 1.0 - cell;
  let digit = u32(floor(abs(params.value) / pow(10.0, place))) % 10u;
  let d = digitDistance(vec2f(local.x - cell * pitch, local.y), digit, w, h);
  // An outline: a stroke around the lit segments' edge.
  return 1.0 - smoothstep(params.stroke * 0.6, params.stroke, abs(d));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let v = makeView();
  let ray = rayAt(v, uv);
  let normal = normalize(cross(params.axisU, params.axisV));
  let denom = dot(ray, normal);
  if (abs(denom) < 1e-4) { return base; }
  let t = dot(params.origin - params.eye, normal) / denom;
  if (t <= 0.0) { return base; }
  let hit = params.eye + ray * t;
  // Hidden where the scene is nearer than the plane.
  let z = viewDepth(uv);
  let planeZ = t * dot(ray, v.forward);
  if (z > 0.0 && z < planeZ) { return base; }
  let rel = hit - params.origin;
  let local = vec2f(dot(rel, params.axisU), dot(rel, params.axisV));
  let r = glyphAt(local + vec2f(params.split, 0.0));
  let g = glyphAt(local);
  let b = glyphAt(local - vec2f(params.split, 0.0));
  let scan = 0.75 + 0.25 * sin(uv.y * frameU.resolution.y * 1.2 + frameU.absTime * 40.0);
  let flicker = 0.85 + 0.15 * step(0.5, fract(sin(floor(frameU.absTime * 18.0) * 12.9898) * 43758.5453));
  let glyph = vec3f(r, g, b) * params.gain * params.ghost * scan * flicker;
  return vec4f(base.rgb * (1.0 - max(g, max(r, b)) * params.ghost * 0.4) + glyph, base.a);
}`;
