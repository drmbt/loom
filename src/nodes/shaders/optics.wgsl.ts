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
 * `spread` widens the first leg sideways: a triangle of `taps` samples either side, `spread`
 * apart at the ends, weighted `1 - j / (taps + 1)` and normalised by `norm` = 1 / (taps + 1).
 * T1439b: `taps` is chosen on the CPU so neighbouring samples sit at most one texel apart
 * (at least 3 — the kernel it always was — and at most 32). With seven taps across, a spread
 * wider than three texels stepped PAST a thin source and drew it three times either side:
 * a barcode. Bilinear reads at most a texel apart sum to a continuous ramp instead.
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
  taps: f32,
  norm: f32,
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
    let n = i32(params.taps);
    for (var j = 1; j <= n; j = j + 1) {
      let o = params.spread * (f32(j) / params.taps);
      let w = 1.0 - f32(j) / (params.taps + 1.0);
      c = c + (textureSampleLevel(inputTexture, inputSampler, at + o, 0.0).rgb + textureSampleLevel(inputTexture, inputSampler, at - o, 0.0).rgb) * w;
    }
    // 1 + 2 x (taps - taps / 2): the weights sum to taps + 1.
    c = c * params.norm;
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

/**
 * THE ON-AXIS FLARE (T1423b), promoted from the On Nothing halo shot's three Custom WGSL passes
 * (`src/projects/on-nothing/shots/halo.ts`, T1407b), where it was measured off the reference.
 * The flare is MEASURED, not keyed: a two-stage reduction finds the bright energy near the
 * optical axis and its centroid each frame — so a figure occluding the lamp dims the flare —
 * and one analytic pass draws the veil, the dispersed ring and two ghosts from it.
 *
 * Stage 1, the GATHER: each texel of a small target (60 columns, rows to the aspect) sums an
 * 8×8 grid of the source over its block, bright-passed and weighted by how near the frame's
 * centre it sits. Means, not sums: the target is half-float and a lamp is hundreds in radiance.
 * `block` is one target texel in source uv (1 / the gather's size).
 */
export const FLARE_GATHER_WGSL = wgsl`struct Params {
  block: vec2f,
  threshold: f32,
  axis: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  let block = params.block;
  var sum = vec3f(0.0);
  for (var j = 0; j < 8; j = j + 1) {
    for (var i = 0; i < 8; i = i + 1) {
      let p = uv + ((vec2f(f32(i), f32(j)) + 0.5) / 8.0 - 0.5) * block;
      let c = textureSampleLevel(inputTexture, inputSampler, p, 0.0).rgb;
      let peak = max(c.r, max(c.g, c.b));
      let over = max(peak - params.threshold, 0.0) / max(peak, 1e-4);
      let q = (p - vec2f(0.5)) * vec2f(aspect, 1.0);
      let onAxis = exp(-dot(q, q) / (2.0 * params.axis * params.axis));
      sum = sum + c * over * onAxis;
    }
  }
  return vec4f(sum / 64.0, 1.0);
}`;

/**
 * Stage 2, the SOURCE (a 2-texel-wide target): texel 0 = the flare source's centroid (uv) and
 * its mean energy; texel 1 = its mean colour (energy per channel). Every texel reduces the
 * whole gather and keeps the half it stands for.
 */
export const FLARE_SOURCE_WGSL = wgsl`@group(0) @binding(0) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cells = vec2i(textureDimensions(inputTexture));
  var rgb = vec3f(0.0);
  var at = vec2f(0.0);
  var total = 0.0;
  for (var j = 0; j < cells.y; j = j + 1) {
    for (var i = 0; i < cells.x; i = i + 1) {
      let c = textureLoad(inputTexture, vec2i(i, j), 0).rgb;
      let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
      rgb = rgb + c;
      at = at + l * (vec2f(f32(i), f32(j)) + 0.5) / vec2f(cells);
      total = total + l;
    }
  }
  let n = f32(cells.x * cells.y);
  if (uv.x > 0.5) { return vec4f(rgb / n, 1.0); }
  let centre = select(vec2f(0.5), at / max(total, 1e-6), total > 1e-6);
  return vec4f(centre, total / n, 1.0);
}`;

/**
 * Stage 3, the FLARE, added onto the picture: every term scales with the measured energy, so
 * it breathes with the occlusion. Distances in frame heights, centred on the source; a ring
 * whose channels sit on their own radii (red outermost), stronger toward `ringAngle`; a veil
 * filling it; a core and a wide glow; a peach ghost and a small red ring riding with the source.
 * Energy zero passes the picture through bit for bit.
 */
export const FLARE_WGSL = wgsl`struct Params {
  gain: f32,
  veil: f32,
  core: f32,
  coreRadius: f32,
  radius: f32,
  width: f32,
  dispersion: f32,
  ring: f32,
  ringSaturation: f32,
  glow: f32,
  ringFacing: f32,
  ringAngle: f32,
  ghost: f32,
  ghostAt: vec2f,
  ghostRadius: f32,
  dot: f32,
  dotAt: vec2f,
  dotRadius: f32,
  tint: vec3f,
  veilTint: vec3f,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var sourceTexture: texture_2d<f32>;

fn band(d: f32, r: f32, w: f32) -> f32 {
  let x = (d - r) / w;
  return exp(-0.5 * x * x);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  let src = textureLoad(sourceTexture, vec2i(0, 0), 0);
  let energy = src.z * params.gain;
  if (energy <= 1e-5) { return base; }
  let hue = textureLoad(sourceTexture, vec2i(1, 0), 0).rgb / max(src.z, 1e-5);
  let colour = mix(vec3f(1.0), hue / max(max(hue.r, max(hue.g, hue.b)), 1e-4), 0.5) * params.tint;
  let p = (uv - src.xy) * vec2f(aspect, 1.0);
  let d = length(p);
  let veil = params.veil * (1.0 - smoothstep(params.radius * 0.25, params.radius * 1.0, d));
  let core = params.core * exp(-d / params.coreRadius) + params.glow * exp(-d / (params.radius * 0.45));
  let a = atan2(p.y, p.x);
  let facing = max(1.0 + params.ringFacing * cos(a - params.ringAngle), 0.0);
  let r = params.radius;
  var ring = vec3f(
    band(d, r * (1.0 + params.dispersion), params.width),
    band(d, r, params.width) * 0.62,
    band(d, r * (1.0 - params.dispersion), params.width) * 0.48,
  );
  ring = mix(vec3f(dot(ring, vec3f(0.2126, 0.7152, 0.0722))), ring, params.ringSaturation) * params.ring * facing;
  let g = length(p - params.ghostAt);
  let ghost = vec3f(1.0, 0.72, 0.52) * params.ghost * (1.0 - smoothstep(params.ghostRadius * 0.35, params.ghostRadius, g));
  let k = length(p - params.dotAt);
  let dotRing = vec3f(1.0, 0.22, 0.16) * params.dot * (band(k, params.dotRadius, params.dotRadius * 0.22) + 0.35 * (1.0 - smoothstep(0.0, params.dotRadius, k)));
  let flare = (vec3f(veil) * params.veilTint + vec3f(core) * colour + ring * colour + ghost + dotRing) * energy;
  return vec4f(base.rgb + flare, base.a);
}`;
