import { wgsl } from "../../runtime/backend/wgsl.ts";

/**
 * Fragment shaders for the optics family: Streak, Halo and Lens (T1402b).
 *
 * Promoted from the On Nothing project's Custom WGSL passes (`src/projects/on-nothing/fx.ts`,
 * T1400b) so the look can be built in the app with no code. Streak and Halo share their
 * first and last passes — a bright extract at reduced size, and an add back onto the
 * picture — and differ only in the kernel between them.
 */

/**
 * The BRIGHT EXTRACT: what the glow nodes smear. A soft-knee threshold on the brightest
 * channel (the furnace's bright pass), taken PER TAP and then box-averaged over the
 * block of input texels one target texel covers.
 *
 * Four bilinear taps a quarter of a target texel either side of centre are an exact box
 * over that block at half size (each tap lands on one input texel) and at quarter size
 * (each tap lands between four). Thresholding before the average is the point: a small hot
 * source averaged with the black around it first would fall under the threshold and
 * vanish at reduced size.
 *
 * `useBright` = 1 when the node's Bright input is wired: that image IS the source, and is
 * passed through without a threshold.
 *
 * THE SOURCE-SIZE GATE (T1422b). A threshold per pixel streaks a one-pixel chrome glint
 * exactly like a lamp. `minSize` > 0 (pixels of the input) judges each tap over AREA: the
 * soft-threshold mask (0 below the knee, 1 above it) is box-averaged over a `minSize`-wide
 * square around the tap — the share of that square the source fills — and the tap's
 * extract is scaled by smoothstep(0.5, 1, share). A source at least `minSize` across fills
 * the square around its inner pixels and passes whole; a thinner one never fills more than
 * (minSize - 1) / minSize of it, and a one-pixel line at minSize 3 fills a third: nothing.
 * The share is of the MASK, not of radiance, so a glint cannot buy its way through by
 * being hot. The square is sampled on a grid of ceil(minSize) taps a side (at most 8: past
 * 8 px the grid spreads out and the bilinear reads fill between). `minSize` 0 skips it:
 * the extract is the per-pixel threshold, bit for bit. Ignored while `useBright` is on.
 */
export const BRIGHT_EXTRACT_WGSL = wgsl`struct Params {
  texel: vec2f,
  threshold: f32,
  knee: f32,
  useBright: f32,
  minSize: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

fn bright(c: vec3f) -> vec3f {
  let color = max(c, vec3f(0.0));
  if (params.useBright > 0.5) { return color; }
  let brightness = max(color.r, max(color.g, color.b));
  let knee = max(params.knee, 0.0);
  let soft = clamp(brightness - params.threshold + knee, 0.0, 2.0 * knee);
  let weight = max(soft * soft / (4.0 * knee + 1e-4), brightness - params.threshold) / max(brightness, 1e-4);
  return color * max(weight, 0.0);
}

// 0 below the knee, 1 above it: whether a texel counts as source, whatever its radiance.
fn sourceMask(c: vec3f) -> f32 {
  let color = max(c, vec3f(0.0));
  let brightness = max(color.r, max(color.g, color.b));
  let knee = max(params.knee, 0.0);
  return clamp((brightness - params.threshold + knee) / max(2.0 * knee, 1e-4), 0.0, 1.0);
}

// The tap's extract, gated by the share of a minSize-wide square around it that is source.
fn gated(at: vec2f) -> vec3f {
  let own = bright(textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb);
  if (params.minSize <= 0.0 || params.useBright > 0.5) { return own; }
  let pixel = 1.0 / vec2f(textureDimensions(inputTexture));
  let n = i32(min(ceil(params.minSize), 8.0));
  var share = 0.0;
  for (var j = 0; j < n; j = j + 1) {
    for (var i = 0; i < n; i = i + 1) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / f32(n) - 0.5;
      share = share + sourceMask(textureSampleLevel(inputTexture, inputSampler, at + o * params.minSize * pixel, 0.0).rgb);
    }
  }
  return own * smoothstep(0.5, 1.0, share / f32(n * n));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let q = params.texel * 0.25;
  var sum = gated(uv + vec2f(-q.x, -q.y));
  sum = sum + gated(uv + vec2f(q.x, -q.y));
  sum = sum + gated(uv + vec2f(-q.x, q.y));
  sum = sum + gated(uv + vec2f(q.x, q.y));
  return vec4f(sum * 0.25, 1.0);
}`;

/**
 * ONE LEG of the streak: a one-sided gather of TAPS samples `gather` apart, TOWARD the
 * sources, weighted by an exponential over the tap index. The node chains three legs, each
 * step just under the span of the leg before, so they convolve into one long, smooth column
 * with no ladder of copies (24 taps a pixel instead of hundreds).
 *
 * `spread` widens the first leg sideways (seven taps across, triangle-weighted, normalised).
 * `back` is the short tail on the FAR side of the source, which only the last leg carries.
 * A zero vector switches either off. Taps that leave the frame stop the walk, as the
 * project's pass did.
 */
export const STREAK_GATHER_WGSL = wgsl`const TAPS: i32 = 8;

struct Params {
  gather: vec2f,
  spread: vec2f,
  back: vec2f,
  decay: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

fn outside(at: vec2f) -> bool {
  return any(at < vec2f(0.0)) || any(at > vec2f(1.0));
}

fn widened(at: vec2f) -> vec3f {
  var c = textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb;
  if (any(params.spread != vec2f(0.0))) {
    for (var j = 1; j <= 3; j = j + 1) {
      let o = params.spread * (f32(j) / 3.0);
      let w = 1.0 - f32(j) / 4.0;
      c = c + (textureSampleLevel(inputTexture, inputSampler, at + o, 0.0).rgb + textureSampleLevel(inputTexture, inputSampler, at - o, 0.0).rgb) * w;
    }
    // 1 + 2 x (0.75 + 0.5 + 0.25): the weights sum to four.
    c = c * 0.25;
  }
  return c;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var sum = vec3f(0.0);
  var norm = 0.0;
  let decay = max(params.decay, 1e-4);
  for (var k = 0; k < TAPS; k = k + 1) {
    let at = uv + params.gather * f32(k);
    if (outside(at)) { break; }
    let w = exp(-f32(k) / (f32(TAPS) * decay));
    sum = sum + widened(at) * w;
    norm = norm + w;
  }
  var color = sum / max(norm, 1e-6);
  if (any(params.back != vec2f(0.0))) {
    var tail = vec3f(0.0);
    for (var k = 1; k <= 8; k = k + 1) {
      let at = uv + params.back * (f32(k) / 8.0);
      if (outside(at)) { break; }
      tail = tail + textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb * exp(-f32(k) / 3.0);
    }
    color = color + tail * 0.12;
  }
  return vec4f(color, 1.0);
}`;

/**
 * The ADD BACK both glow nodes end on: the picture plus the glow layer, times gain and
 * tint, modulated by the streak glass's striations (grooves ACROSS the streak direction;
 * `across` projects uv onto that axis in frame widths). Striation 0 is an exact 1, and a
 * zero glow adds an exact 0, so where nothing is bright the picture passes through
 * bit-for-bit. Alpha is the picture's.
 */
export const GLOW_ADD_WGSL = wgsl`struct Params {
  tint: vec4f,
  across: vec2f,
  striation: f32,
  striationScale: f32,
  gain: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var glowTexture: texture_2d<f32>;

fn stripe(x: f32) -> f32 {
  // Two incommensurate sine families, sharpened: uneven, glassy grooves.
  let a = 0.5 + 0.5 * sin(x * 6.2831853 + sin(x * 0.37) * 3.0);
  let b = 0.5 + 0.5 * sin(x * 2.618 * 6.2831853 + 1.3);
  return pow(a * 0.6 + b * 0.4, 1.6);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let glow = textureSampleLevel(glowTexture, inputSampler, uv, 0.0).rgb;
  let grooves = mix(1.0, stripe(dot(uv, params.across) * params.striationScale), params.striation);
  return vec4f(base.rgb + glow * (grooves * params.gain) * params.tint.rgb, base.a);
}`;

/**
 * The HALO RING: an on-axis source wears a thin concentric ring, its colours split by the
 * lens's dispersion. Each channel gathers the bright pass on a circle of its own radius
 * (red wider, blue tighter), three radii across the ring's width. Run at quarter size; the
 * ring is soft by nature.
 */
export const HALO_RING_WGSL = wgsl`const TAPS: i32 = 96;

struct Params {
  radius: f32,
  width: f32,
  dispersion: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  var sum = vec3f(0.0);
  for (var k = 0; k < TAPS; k = k + 1) {
    let a = (f32(k) + 0.5) / f32(TAPS) * 6.2831853;
    let dir = vec2f(cos(a) / aspect, sin(a));
    for (var j = -1; j <= 1; j = j + 1) {
      let rr = params.radius + f32(j) * params.width * 0.5;
      let r = textureSampleLevel(inputTexture, inputSampler, uv + dir * rr * (1.0 + params.dispersion * 0.5), 0.0).r;
      let g = textureSampleLevel(inputTexture, inputSampler, uv + dir * rr, 0.0).g;
      let b = textureSampleLevel(inputTexture, inputSampler, uv + dir * rr * (1.0 - params.dispersion * 0.5), 0.0).b;
      sum = sum + vec3f(r, g, b) * select(0.5, 1.0, j == 0);
    }
  }
  return vec4f(sum / f32(TAPS), 1.0);
}`;

/**
 * The LENS: barrel distortion, the soft smeared edges of a fast wide lens (a blur growing
 * with the square of the distance from the centre, drawn between radial and tangential by
 * `swirl`), lateral chromatic aberration at the edges, a snap-zoom radial blur toward
 * `zoomCentre`, and the vignette. Twelve taps; with blur, zoom and aberration at zero they
 * all land on one point, so the picture is the distorted, vignetted input.
 */
export const LENS_WGSL = wgsl`const TAPS: i32 = 12;

struct Params {
  zoomCentre: vec2f,
  distortion: f32,
  edgeBlur: f32,
  swirl: f32,
  aberration: f32,
  zoomBlur: f32,
  vignette: f32,
  vignetteRound: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

fn distort(uv: vec2f, k: f32, aspect: f32) -> vec2f {
  let c = (uv - vec2f(0.5)) * vec2f(aspect, 1.0);
  let r2 = dot(c, c);
  let f = 1.0 + k * r2;
  return c * f / vec2f(aspect, 1.0) / (1.0 + k * 0.25) + vec2f(0.5);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  let src = distort(uv, params.distortion, aspect);
  let c = (src - vec2f(0.5)) * vec2f(aspect, 1.0);
  let r2 = dot(c, c) / (0.25 * aspect * aspect + 0.25);
  let radial = normalize(c + vec2f(1e-5)) / vec2f(aspect, 1.0);
  let tangent = vec2f(-radial.y, radial.x);
  let blurDir = normalize(mix(radial, normalize(tangent), params.swirl)) * params.edgeBlur * r2 * r2 * 2.0;
  let zoomDir = (src - params.zoomCentre) * params.zoomBlur;
  let ca = (src - vec2f(0.5)) * params.aberration * r2 * 4.0;
  var sum = vec3f(0.0);
  for (var k = 0; k < TAPS; k = k + 1) {
    let t = (f32(k) + 0.5) / f32(TAPS) - 0.5;
    let o = src + blurDir * t - zoomDir * (t + 0.5);
    let rch = textureSampleLevel(inputTexture, inputSampler, o + ca, 0.0).r;
    let gch = textureSampleLevel(inputTexture, inputSampler, o, 0.0).g;
    let bch = textureSampleLevel(inputTexture, inputSampler, o - ca, 0.0).b;
    sum = sum + vec3f(rch, gch, bch);
  }
  var color = sum / f32(TAPS);
  let q = (uv - vec2f(0.5)) * vec2f(mix(1.0, aspect, params.vignetteRound), 1.0);
  let vr = dot(q, q) / (0.25 * mix(1.0, aspect * aspect, params.vignetteRound) + 0.25);
  color = color * mix(1.0, 1.0 - smoothstep(0.12, 1.0, vr), params.vignette);
  let alpha = textureSampleLevel(inputTexture, inputSampler, src, 0.0).a;
  return vec4f(color, alpha);
}`;
