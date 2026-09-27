import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import { WGSL_LUMA } from "./common.wgsl.ts";

/**
 * Fragment shaders for the finishing family: Film Grade and CRT (T1402b).
 *
 * Promoted from the On Nothing project's GRADE and CRT passes
 * (`src/projects/on-nothing/fx.ts`, T1400b). Both read the shared frame block for their
 * per-frame noise — the grain's pattern, the tube's interlace field and flicker — and both
 * take the pixel grid from their own INPUT's size, never from `frameU.resolution`, which is
 * the presentation surface's rather than this pass's.
 */

/**
 * FILM GRADE: exposure; chroma kept only where the source is strongly saturated and warm
 * (flare contamination survives a desaturated grade); a filmic shoulder (Hable's, white at
 * 11.2); desaturation; a bleach-bypass overlay of the picture with its own luma; an
 * S-curve around mid-grey; the black crush; a split tint (upper mids, shadows); a lift; and
 * grain, heavier in the blacks, new every frame.
 *
 * It TONE MAPS: the result is linear display light in 0..1, meant for an Output whose own
 * tone map is off.
 */
export const FILM_GRADE_WGSL = wgsl`${SHARED_UNIFORMS_WGSL}
${WGSL_LUMA}

struct Params {
  highlightTint: vec4f,
  shadowTint: vec4f,
  exposure: f32,
  black: f32,
  contrast: f32,
  saturation: f32,
  keepWarm: f32,
  bleach: f32,
  split: f32,
  lift: f32,
  grain: f32,
  grainSize: f32,
};
@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var inputSampler: sampler;
@group(0) @binding(3) var inputTexture: texture_2d<f32>;

fn gradeHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Hable's filmic curve on scene-linear light.
fn hable(x: vec3f) -> vec3f {
  let a = 0.15; let b = 0.5; let c = 0.1; let d = 0.2; let e = 0.02; let f = 0.3;
  return ((x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f)) - e / f;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let hdr = max(source.rgb, vec3f(0.0)) * exp2(params.exposure);
  // The chroma decision comes BEFORE the curve: a strongly saturated warm source keeps some.
  let top = max(hdr.r, max(hdr.g, hdr.b));
  let chroma = (top - min(hdr.r, min(hdr.g, hdr.b))) / max(top, 1e-4);
  let warm = smoothstep(0.35, 0.8, chroma) * step(hdr.b, hdr.r);
  let keep = mix(params.saturation, max(params.saturation, params.keepWarm), warm);
  var c = hable(hdr * 2.0) / hable(vec3f(11.2));
  // The grade itself works on display-encoded values.
  c = pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
  c = mix(vec3f(luma(c)), c, keep);
  // Bleach bypass: overlay the picture with its own luma.
  let y = luma(c);
  let overlay = select(1.0 - 2.0 * (1.0 - c) * (1.0 - y), 2.0 * c * y, c < vec3f(0.5));
  c = mix(c, overlay, params.bleach);
  // Contrast around mid-grey, then the black crush.
  c = clamp((c - 0.45) * params.contrast + 0.45, vec3f(0.0), vec3f(1.0));
  c = clamp((c - params.black) / max(1.0 - params.black, 1e-4), vec3f(0.0), vec3f(1.0));
  // The split: one tint into the upper mids, another into the shadows.
  let yl = luma(c);
  let upper = smoothstep(0.35, 0.8, yl) * (1.0 - smoothstep(0.9, 1.0, yl));
  let low = 1.0 - smoothstep(0.0, 0.3, yl);
  c = c * mix(vec3f(1.0), params.highlightTint.rgb, upper * params.split) * mix(vec3f(1.0), params.shadowTint.rgb, low * params.split);
  c = c + vec3f(params.lift) * (1.0 - c);
  // Grain: a new pattern each frame, on this image's own pixel grid.
  let px = floor(uv * vec2f(textureDimensions(inputTexture)) / max(params.grainSize, 0.5));
  let n = gradeHash(vec3f(px, frameU.absFrame)) + gradeHash(vec3f(px + 17.0, frameU.absFrame * 1.7)) - 1.0;
  c = c + vec3f(n) * params.grain * (0.35 + 0.65 * (1.0 - luma(c)));
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  return vec4f(pow(c, vec3f(2.2)), source.a);
}`;

/**
 * The CRT RE-SCAN, on display light: the tube's curvature and black corners, an aperture
 * grille of RGB phosphor stripes, scanlines whose width swells with the beam's brightness,
 * interlace jitter (odd fields shift by `jitter` lines), phosphor glow and a slow flicker.
 * `amount` fades it in; 0 returns the input sample untouched.
 */
export const CRT_WGSL = wgsl`${SHARED_UNIFORMS_WGSL}

struct Params {
  amount: f32,
  lines: f32,
  curvature: f32,
  mask: f32,
  maskPitch: f32,
  glow: f32,
  jitter: f32,
  gain: f32,
};
@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var inputSampler: sampler;
@group(0) @binding(3) var inputTexture: texture_2d<f32>;

fn warp(uv: vec2f) -> vec2f {
  var c = uv * 2.0 - 1.0;
  c = c * (1.0 + params.curvature * vec2f(c.y * c.y, c.x * c.x));
  return c * 0.5 + 0.5;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let direct = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  if (params.amount <= 0.0) { return direct; }
  let w = warp(uv);
  if (any(w < vec2f(0.0)) || any(w > vec2f(1.0))) {
    return vec4f(mix(direct.rgb, vec3f(0.0), params.amount), direct.a);
  }
  let lines = max(params.lines, 1.0);
  let field = f32(u32(frameU.absFrame) % 2u);
  let line = w.y * lines + field * params.jitter;
  let src = vec2f(w.x, (floor(line) + 0.5 - field * params.jitter) / lines);
  let size = vec2f(textureDimensions(inputTexture));
  let px = 1.0 / size;
  let c = textureSampleLevel(inputTexture, inputSampler, src, 0.0).rgb;
  var glow = vec3f(0.0);
  for (var k = -3; k <= 3; k = k + 1) {
    glow = glow + textureSampleLevel(inputTexture, inputSampler, w + vec2f(f32(k) * px.x * 3.0, 0.0), 0.0).rgb;
    glow = glow + textureSampleLevel(inputTexture, inputSampler, w + vec2f(0.0, f32(k) * px.y * 3.0), 0.0).rgb;
  }
  glow = glow / 14.0;
  // Scanline: a Gaussian across the line whose width grows with the beam's brightness.
  let y = fract(line) - 0.5;
  let bright = max(c.r, max(c.g, c.b));
  let sigma = mix(0.18, 0.42, sqrt(clamp(bright, 0.0, 1.0)));
  let beam = exp(-(y * y) / (2.0 * sigma * sigma));
  // Aperture grille: R, G, B stripes by pixel column, maskPitch pixels to a triad.
  let stripe = u32(floor(uv.x * size.x / max(params.maskPitch / 3.0, 0.34))) % 3u;
  var m = vec3f(1.0 - params.mask);
  m[stripe] = 1.0;
  let flicker = 1.0 - 0.015 * sin(frameU.absTime * 60.0);
  let tube = (c * beam * m * params.gain + glow * params.glow * 0.5) * flicker;
  let corner = smoothstep(0.0, 0.02, min(min(w.x, 1.0 - w.x), min(w.y, 1.0 - w.y)));
  return vec4f(mix(direct.rgb, tube * corner, params.amount), direct.a);
}`;
