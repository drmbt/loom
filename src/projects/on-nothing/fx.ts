import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1400b — the On Nothing OPTICS AND FINISH, the reference's layers 2–6 as Custom WGSL passes:
 * the streak filter, the halo ring, the lens, the grade, the frame echo, the mirror tiles and
 * the CRT re-scan. Written here first; §T1400b's promotion row turns each into a stock node.
 *
 * All but the grade and the CRT work in linear HDR. The grade applies the tone curve and hands
 * the Output linear display light (its own tone map off), as the furnace's does.
 */

const INPUT = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
`;
const INPUT_AND_FRAME = `${SHARED_UNIFORMS_WGSL}
${INPUT}@group(0) @binding(2) var<uniform> frameU: SharedFrame;
`;

/**
 * The STREAK FILTER (layer 2). What reads as "vertical LED columns" in the reference is mostly
 * this: a clear streak glass smears every bright source UPWARD into a soft column as wide as
 * the source, fading over a third of the frame, with fine vertical striations from the glass.
 *
 * One pass is a one-sided gather of TAPS samples `step` apart, below the pixel (sources below
 * reach it), weighted by an exponential over the distance. Chained three times, each step just
 * under the span of the pass before, the first two flat and the last exponential, the passes
 * convolve into one long, smooth column with no ladder of copies, at 24 taps a pixel. The last
 * pass adds the striations and a short tail downward. Input: the glow of the bright sources
 * (a bloom level, so a column is as wide as the source's halo, as the reference's are).
 */
export const STREAK_WGSL = `struct Params {
  step: f32, // @default 0.004  Distance between taps, as a fraction of the frame height (chained passes: each step under the previous pass's span).
  decay: f32, // @default 50  1/e reach of this pass's weights, as a fraction of its span (large = a flat box).
  finish: f32, // @default 0  1 on the last pass: striations and the downward tail.
  down: f32, // @default 0.12  Downward tail reach, fraction of the frame height (last pass).
  striation: f32, // @default 0.55  Depth of the glass's vertical striations (last pass).
  striationScale: f32, // @default 140  Striations across the frame width.
  gain: f32, // @default 1  Column brightness (last pass).
  spread: f32, // @default 0  Horizontal widening, fraction of the frame width (first pass).
  compress: f32, // @default 0  First pass: roll each source off toward this radiance (0 off), so a clipped lamp smears a milky slab, not a white bar.
};
${INPUT_AND_FRAME}
const TAPS: i32 = 8;

fn stripe(x: f32) -> f32 {
  // Two incommensurate sine families, sharpened: uneven, glassy grooves.
  let a = 0.5 + 0.5 * sin(x * 6.2831853 + sin(x * 0.37) * 3.0);
  let b = 0.5 + 0.5 * sin(x * 2.618 * 6.2831853 + 1.3);
  return pow(a * 0.6 + b * 0.4, 1.6);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  var sum = vec3f(0.0);
  var norm = 0.0;
  for (var k = 0; k < TAPS; k = k + 1) {
    let w = exp(-f32(k) / (f32(TAPS) * params.decay));
    // Upward column: gather from BELOW (texture y grows downward).
    let at = uv + vec2f(0.0, f32(k) * params.step);
    if (at.y > 1.0) { break; }
    var c = textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb;
    if (params.compress > 0.0) {
      c = c / (1.0 + max(c.r, max(c.g, c.b)) / params.compress);
    }
    if (params.spread > 0.0) {
      for (var j = 1; j <= 3; j = j + 1) {
        let o = vec2f(f32(j) / 3.0 * params.spread, 0.0);
        var l = textureSampleLevel(inputTexture, inputSampler, at + o, 0.0).rgb;
        var r = textureSampleLevel(inputTexture, inputSampler, at - o, 0.0).rgb;
        if (params.compress > 0.0) {
          l = l / (1.0 + max(l.r, max(l.g, l.b)) / params.compress);
          r = r / (1.0 + max(r.r, max(r.g, r.b)) / params.compress);
        }
        c = c + (l + r) * (1.0 - f32(j) / 4.0);
      }
      c = c / 3.5;
    }
    sum = sum + c * w;
    norm = norm + w;
  }
  var color = sum / norm;
  if (params.finish > 0.5) {
    var tail = vec3f(0.0);
    for (var k = 1; k <= 8; k = k + 1) {
      let d = f32(k) / 8.0 * params.down;
      if (uv.y - d < 0.0) { break; }
      tail = tail + textureSampleLevel(inputTexture, inputSampler, uv - vec2f(0.0, d), 0.0).rgb * exp(-f32(k) / 3.0);
    }
    color = color + tail * 0.12 * step(0.0001, params.down);
    color = color * mix(1.0, stripe(uv.x * params.striationScale), params.striation) * params.gain;
  }
  return vec4f(color, 1.0);
}`;

/**
 * The HALO (layer 2): an on-axis source wears a thin concentric ring, its colours split by
 * the lens's dispersion. A ring kernel over a hot bright pass: each channel gathers the bright
 * pass on a circle of its own radius, each tap weighted by how close its source sits to the
 * frame centre — so only a light looking down the barrel rings, as in the reference, and a
 * row of headlights across the frame does not. Run at quarter size; the ring is soft.
 */
export const HALO_WGSL = `struct Params {
  radius: f32, // @default 0.14  Ring radius, as a fraction of the frame height.
  width: f32, // @default 0.012  Ring thickness, fraction of the frame height.
  dispersion: f32, // @default 0.06  Radius difference between red and blue (fraction of the radius).
  gain: f32, // @default 1  Ring brightness.
  axis: f32, // @default 0.12  On-axis window: only sources within about this distance of the frame centre (fraction of the height) ring.
};
${INPUT_AND_FRAME}
const TAPS: i32 = 160;

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
      // A ring forms only when its SOURCE sits near the optical axis: weight by where the tap is.
      let src = (uv + dir * rr - vec2f(0.5)) * vec2f(aspect, 1.0);
      let onAxis = exp(-dot(src, src) / (2.0 * params.axis * params.axis));
      sum = sum + vec3f(r, g, b) * select(0.5, 1.0, j == 0) * onAxis;
    }
  }
  return vec4f(sum / f32(TAPS) * params.gain, 1.0);
}`;

/**
 * Adds the optics back onto the picture: streak columns, halo rings and bloom, each with its
 * own gain. Input = the picture; More = [streak, halo, bloom].
 */
export const OPTICS_COMPOSITE_WGSL = `struct Params {
  streak: f32, // @default 1  Streak columns.
  halo: f32, // @default 1  Halo rings.
  bloom: f32, // @default 0.25  Bloom glow.
  streakTint: vec3f, // @default 1  Colour of the streaks (the glass is faintly cold).
};
${INPUT}@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
@group(0) @binding(6) var inputTexture3: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let s = textureSampleLevel(inputTexture1, inputSampler, uv, 0.0).rgb;
  let h = textureSampleLevel(inputTexture2, inputSampler, uv, 0.0).rgb;
  let b = textureSampleLevel(inputTexture3, inputSampler, uv, 0.0).rgb;
  return vec4f(base.rgb + s * params.streak * params.streakTint + h * params.halo + b * params.bloom, base.a);
}`;

/**
 * The LENS (layers 0 and 4): barrel distortion, the soft smeared edges of a fast wide lens
 * (a blur that grows with the square of the distance from the centre, drawn along the
 * tangent so it swirls), chromatic aberration at the edges, a snap-zoom radial blur toward
 * `zoomCentre`, and the vignette.
 */
export const LENS_WGSL = `struct Params {
  distortion: f32, // @default 0.06  Barrel distortion (positive bows lines outward).
  edgeBlur: f32, // @default 0.012  Edge blur reach at the corners, fraction of the frame width.
  swirl: f32, // @default 0.6  0 radial edge blur .. 1 tangential (swirly) edge blur.
  aberration: f32, // @default 0.0015  Lateral chromatic aberration at the corners.
  zoomBlur: f32, // @default 0  Snap-zoom radial blur reach (0 off).
  zoomCentre: vec2f, // @default 0.5  Where the snap-zoom converges (uv).
  whip: f32, // @default 0  Whip-pan blur: horizontal smear, fraction of the frame width.
  vignette: f32, // @default 0.55  Darkening toward the corners.
  vignetteRound: f32, // @default 0.75  1 = round vignette, 0 = follows the frame's shape.
};
${INPUT_AND_FRAME}
const TAPS: i32 = 12;

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
    let o = src + blurDir * t - zoomDir * (t + 0.5) + vec2f(params.whip * t, 0.0);
    let rch = textureSampleLevel(inputTexture, inputSampler, o + ca, 0.0).r;
    let gch = textureSampleLevel(inputTexture, inputSampler, o, 0.0).g;
    let bch = textureSampleLevel(inputTexture, inputSampler, o - ca, 0.0).b;
    sum = sum + vec3f(rch, gch, bch);
  }
  var color = sum / f32(TAPS);
  let q = (uv - vec2f(0.5)) * vec2f(mix(1.0, aspect, params.vignetteRound), 1.0);
  let vr = dot(q, q) / (0.25 * mix(1.0, aspect * aspect, params.vignetteRound) + 0.25);
  color = color * mix(1.0, 1.0 - smoothstep(0.12, 1.0, vr), params.vignette);
  return vec4f(color, 1.0);
}`;

/**
 * The GRADE (layer 3): the "liquid mercury" look. Exposure; a filmic shoulder; blacks crushed
 * to zero with no ambient lift; mids desaturated; a cold steel tint pushed into the upper
 * mids; a bleach-bypass layer (the picture multiplied by its own luma in overlay) that rolls
 * the highlights metallic; rare warm cast kept only where the source itself is saturated
 * (flare contamination); grain, strongest in the shadows where the reference shows it.
 * Output: linear display light for the Output node (tone map off).
 */
export const GRADE_WGSL = `struct Params {
  exposure: f32, // @default 0  Stops.
  black: f32, // @default 0.035  Display level crushed to zero (the toe cut).
  contrast: f32, // @default 1.25  S-curve slope around mid-grey.
  saturation: f32, // @default 0.28  Chroma kept (the reference keeps almost none).
  keepWarm: f32, // @default 0.5  Chroma kept on strongly saturated warm sources (flare contamination).
  bleach: f32, // @default 0.35  Bleach-bypass mix.
  steel: vec3f, // @default 1  Tint pushed into the upper mids.
  shadowTint: vec3f, // @default 1  Tint in the shadows (neutral to cool only).
  split: f32, // @default 0.5  Strength of both tints.
  grain: f32, // @default 0.03  Grain amount.
  grainSize: f32, // @default 1.3  Grain size in pixels.
  lift: f32, // @default 0  Display-level lift (the cyc's overexposed floor).
};
${INPUT_AND_FRAME}
fn gradeHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

// A filmic shoulder (Hable's) on scene-linear light, normalised to white at 11.2.
fn hable(x: vec3f) -> vec3f {
  let a = 0.15; let b = 0.5; let c = 0.1; let d = 0.2; let e = 0.02; let f = 0.3;
  return ((x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f)) - e / f;
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let hdr = max(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb, vec3f(0.0)) * exp2(params.exposure);
  // Chroma decision BEFORE the curve: a strongly saturated warm source keeps some colour.
  let hl = luma(hdr);
  let chroma = (max(hdr.r, max(hdr.g, hdr.b)) - min(hdr.r, min(hdr.g, hdr.b))) / max(max(hdr.r, max(hdr.g, hdr.b)), 1e-4);
  let warm = smoothstep(0.35, 0.8, chroma) * step(hdr.b, hdr.r);
  let keep = mix(params.saturation, max(params.saturation, params.keepWarm), warm);
  var c = hable(hdr * 2.0) / hable(vec3f(11.2));
  // display-ish space for the grade
  c = pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
  let y0 = luma(c);
  c = mix(vec3f(y0), c, keep);
  // bleach bypass: overlay the picture with its own luma
  let y = luma(c);
  let overlay = select(1.0 - 2.0 * (1.0 - c) * (1.0 - y), 2.0 * c * y, c < vec3f(0.5));
  c = mix(c, overlay, params.bleach);
  // contrast S around mid-grey, then the black crush
  c = clamp((c - 0.45) * params.contrast + 0.45, vec3f(0.0), vec3f(1.0));
  c = clamp((c - params.black) / (1.0 - params.black), vec3f(0.0), vec3f(1.0));
  // split: cool steel into the upper mids, neutral-to-cool shadows
  let yl = luma(c);
  let upper = smoothstep(0.35, 0.8, yl) * (1.0 - smoothstep(0.9, 1.0, yl));
  let low = 1.0 - smoothstep(0.0, 0.3, yl);
  c = c * mix(vec3f(1.0), params.steel, upper * params.split) * mix(vec3f(1.0), params.shadowTint, low * params.split);
  c = c + vec3f(params.lift) * (1.0 - c);
  // grain: luma-weighted, heavier in the blacks, a new pattern each frame
  let px = floor(uv * frameU.resolution / max(params.grainSize, 0.5));
  let n = gradeHash(vec3f(px, frameU.absFrame)) + gradeHash(vec3f(px + 17.0, frameU.absFrame * 1.7)) - 1.0;
  c = c + vec3f(n) * params.grain * (0.35 + 0.65 * (1.0 - luma(c)));
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  return vec4f(pow(c, vec3f(2.2)), 1.0);
}`;

/**
 * FRAME ECHO (layer 5): the picture laid over its own past — a trail whose opacity steps
 * down with age, so a moving dark limb on the white cyc leaves a kinetic smear. The history
 * is this pass's own output a frame ago (Feedback); `delay` frames hold one sample before it
 * joins the trail. Input = picture, More = [history].
 */
export const ECHO_WGSL = `struct Params {
  amount: f32, // @default 0.4  How much of the past stays in each frame (the trail's length).
  darken: f32, // @default 0.6  0 blends the trail; 1 keeps only what is darker (dark smear on white).
};
${INPUT}@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let now = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let past = textureSampleLevel(inputTexture1, inputSampler, uv, 0.0).rgb;
  let blended = mix(now, past, params.amount);
  // Darken: the trail only ever darkens what is there now, so a dark limb smears across the
  // white and the figure itself stays as dark as it is.
  let darker = min(now, blended);
  return vec4f(mix(blended, darker, params.darken), 1.0);
}`;

/**
 * MIRROR TILES (layer 5): the frame cut into `tiles` vertical strips, each showing the same
 * central slice of the source, alternate strips flipped — the silhouette quadruplet at 4,
 * the bilateral mirror at 2. `crop` is how much of the source width one strip shows.
 */
export const MIRROR_WGSL = `struct Params {
  tiles: f32, // @default 4  Vertical strips (1 = off).
  crop: f32, // @default 0.3  Share of the source width each strip shows.
  centre: f32, // @default 0.5  Centre of the slice in the source (uv x).
  flip: f32, // @default 1  1 flips alternate strips.
  phase: f32, // @default 0  1 flips the even strips instead of the odd ones (back-to-back instead of face-to-face).
  seam: f32, // @default 0.0  Soft blend width at the seams (fraction of a strip).
};
${INPUT}
fn slice(t: f32, index: f32) -> f32 {
  let flipped = params.flip > 0.5 && ((i32(index) + i32(params.phase)) % 2) == 1;
  let local = select(t, 1.0 - t, flipped);
  return params.centre + (local - 0.5) * params.crop;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let n = max(round(params.tiles), 1.0);
  if (n <= 1.0) { return textureSampleLevel(inputTexture, inputSampler, uv, 0.0); }
  let x = uv.x * n;
  let index = floor(x);
  let t = x - index;
  var color = textureSampleLevel(inputTexture, inputSampler, vec2f(slice(t, index), uv.y), 0.0).rgb;
  if (params.seam > 0.0) {
    let edge = min(t, 1.0 - t);
    let neighbour = select(index + 1.0, index - 1.0, t < 0.5);
    let other = textureSampleLevel(inputTexture, inputSampler, vec2f(slice(select(t - 1.0, t + 1.0, t < 0.5), neighbour), uv.y), 0.0).rgb;
    color = mix(mix(color, other, 0.5), color, smoothstep(0.0, params.seam, edge));
  }
  return vec4f(color, 1.0);
}`;

/**
 * The CRT RE-SCAN (layer 6), on display light after the grade: the tube's curvature and
 * black corners, an aperture grille of RGB phosphor stripes, scanlines whose width swells
 * with brightness, interlace jitter (odd fields shift a line each frame), phosphor bloom and
 * a slow flicker. `amount` fades it in (0 bypasses).
 */
export const CRT_WGSL = `struct Params {
  amount: f32, // @default 1  0 bypasses the tube.
  lines: f32, // @default 540  Scanlines over the frame height.
  curvature: f32, // @default 0.08  Tube curvature.
  mask: f32, // @default 0.5  Phosphor stripe depth.
  maskPitch: f32, // @default 3  Pixels per RGB triad.
  bloom: f32, // @default 0.5  Phosphor glow.
  jitter: f32, // @default 0.4  Interlace jitter, in lines.
  gain: f32, // @default 1.25  Brightness makeup for the mask and scanlines.
};
${INPUT_AND_FRAME}
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
  if (any(w < vec2f(0.0)) || any(w > vec2f(1.0))) { return vec4f(mix(direct.rgb, vec3f(0.0), params.amount), 1.0); }
  let field = f32(u32(frameU.absFrame) % 2u);
  let line = w.y * params.lines + field * params.jitter;
  let src = vec2f(w.x, (floor(line) + 0.5 - field * params.jitter) / params.lines);
  let size = vec2f(textureDimensions(inputTexture));
  let px = 1.0 / size;
  var c = textureSampleLevel(inputTexture, inputSampler, src, 0.0).rgb;
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
  // Aperture grille: R, G, B stripes by pixel column.
  let stripe = u32(floor(uv.x * size.x / max(params.maskPitch / 3.0, 0.34))) % 3u;
  var m = vec3f(1.0 - params.mask);
  m[stripe] = 1.0;
  let flicker = 1.0 - 0.015 * sin(frameU.absTime * 60.0);
  let tube = (c * beam * m * params.gain + glow * params.bloom * 0.5) * flicker;
  let corner = smoothstep(0.0, 0.02, min(min(w.x, 1.0 - w.x), min(w.y, 1.0 - w.y)));
  return vec4f(mix(direct.rgb, tube * corner, params.amount), 1.0);
}`;

/**
 * The PRISM SLICE (layer 5, the reference's 0:29): a triangular glass prism held before the
 * lens. Inside a central triangle the picture passes straight through; outside, each point is
 * folded back into the triangle by reflecting it across the edge it lies beyond (up to three
 * folds), so the frame fills with mirrored copies of the face meeting at bright, slightly
 * dispersed seams. Each fold loses a little light, as a real mirror does.
 */
export const PRISM_WGSL = `struct Params {
  amount: f32, // @default 1  0 bypasses the prism.
  centre: vec2f, // @default 0.5  Centre of the clear triangle (uv).
  radius: f32, // @default 0.32  Circumradius of the triangle, fraction of the frame height.
  rotation: f32, // @default 0  Turn of the triangle, radians.
  loss: f32, // @default 0.18  Light lost per reflection.
  seam: f32, // @default 0.6  Brightness of the seams where the glass faces meet.
  seamWidth: f32, // @default 0.004  Width of a seam, fraction of the frame height.
  depth: f32, // @default 1  Reflections deep: 1 = each face mirrors once (a real prism), 3 = a kaleidoscope.
};
${INPUT_AND_FRAME}
fn edgeNormal(k: i32) -> vec2f {
  let a = params.rotation + 1.5707963 + f32(k) * 2.0943951;
  return vec2f(cos(a), sin(a));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let direct = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  if (params.amount <= 0.0) { return direct; }
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  // Work in height units, centred on the triangle; y up.
  var p = (uv - params.centre) * vec2f(aspect, -1.0);
  let d = params.radius * 0.5; // inradius of an equilateral triangle
  var folds = 0.0;
  for (var i = 0; i < i32(params.depth); i = i + 1) {
    for (var k = 0; k < 3; k = k + 1) {
      // Edge k: points with dot(p, -n) > d are beyond it (n points to the edge's far vertex side).
      let n = -edgeNormal(k);
      let s = dot(p, n);
      if (s > d) {
        p = p - 2.0 * (s - d) * n;
        folds = folds + 1.0;
      }
    }
  }
  let src = params.centre + p * vec2f(1.0 / aspect, -1.0);
  var color = textureSampleLevel(inputTexture, inputSampler, clamp(src, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  color = color * pow(1.0 - params.loss, folds);
  // Seams: nearness to any edge of the triangle, measured in the ORIGINAL frame.
  let q = (uv - params.centre) * vec2f(aspect, -1.0);
  var near = 1e3;
  for (var k = 0; k < 3; k = k + 1) {
    near = min(near, abs(dot(q, -edgeNormal(k)) - d));
  }
  let ridge = exp(-(near * near) / (2.0 * params.seamWidth * params.seamWidth));
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = color + vec3f(1.0, 0.98, 0.95) * ridge * params.seam * (0.2 + luma);
  return vec4f(mix(direct.rgb, color, params.amount), 1.0);
}`;
