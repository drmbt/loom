import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, VIEW } from "../../furnace/screen-space.ts";

/**
 * T1407b (closeups) — the LENS'S DEPTH OF FIELD, from the thin-lens equation, for the close-ups.
 *
 * The furnace's DOF (screen-space.ts) blurs by a "strength" in pixels and tops out at 16 px: a
 * macro at f/2.8 needs discs a tenth of the frame wide, and the reference's bokeh — every stone
 * of the pendant a bright disc, rimmed, clipped to a cat's eye at the frame's edge, fringed
 * green behind focus and magenta in front — is the look. So the circle of confusion here is the
 * LENS'S: c = f²/N · |z − s| / (z · (s − f)) on a 36 mm-wide sensor, as a fraction of the frame
 * width, so a render at twice the size (render.ts --final) blurs exactly as much.
 *
 * Scatter-as-gather: each pixel gathers TAPS samples over the largest disc it could receive
 * (golden-angle spiral, turned and jittered per pixel and per frame so the sampling noise is
 * uncorrelated and averages away in the sub-frames). A sample adds to this pixel if ITS disc
 * reaches here — so a bright stone behind focus paints its whole disc — weighted by 1/area (a
 * disc spreads its light), which keeps the energy: a highlight grows dimmer as it grows. A
 * sample behind this pixel may not spread wider than this pixel's own disc (the sharp
 * foreground occludes the blurred background); a sample in front spreads over it (the near
 * blur veils what is behind it). Two refinements of a real lens: the disc is the intersection
 * with a second disc slid toward the frame centre (optical vignetting: cat's-eye bokeh at the
 * edges), and red and blue get slightly different discs on either side of focus
 * (longitudinal chromatic aberration). The noisy result is cleaned by DOF_FILL_WGSL.
 * Custom WGSL · Multi: Input = the lit frame (linear HDR), More = [depth].
 */
const BINDINGS = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
`;

const LENS_PARAMS = `${CAMERA_PARAMS}
  focal: f32, // @default 50  Focal length, millimetres (36 mm-wide sensor).
  fstop: f32, // @default 2.8  Aperture, f-number.
  focus: f32, // @default 1  Focus distance, metres (view-plane distance).
  maxCoc: f32, // @default 0.05  Largest disc RADIUS gathered, fraction of the frame width.`;

const COC = `
// Signed circle-of-confusion RADIUS, as a fraction of the frame width: + behind focus, − in front.
fn cocAt(z: f32) -> f32 {
  let f = params.focal * 0.001;
  let s = max(params.focus, f * 1.01);
  let zz = select(params.far, z, z > 0.0);
  let c = (f * f / params.fstop) * (zz - s) / (max(zz, 1e-3) * (s - f));
  return clamp(c / 0.036 * 0.5, -params.maxCoc, params.maxCoc);
}
`;

export const LENS_DOF_WGSL = `struct Params {
${LENS_PARAMS}
  catEye: f32, // @default 0.45  Optical vignetting: how far the second disc slides at the frame's corner (fraction of the disc).
  fringe: f32, // @default 0.08  Longitudinal CA: red and blue discs differ by this share of the radius.
  rim: f32, // @default 0.35  Brighter rim on each disc (a spherical-aberration "soap bubble").
};
${BINDINGS}${VIEW}${COC}
const TAPS: u32 = 160u;

fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  let centre = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let z0 = viewDepth(uv);
  let zc = select(params.far, z0, z0 > 0.0);
  let c0 = cocAt(z0);
  let r0 = abs(c0) * size.x;
  let reach = params.maxCoc * size.x;
  // where this pixel sits in the frame, for the cat's eye (0 at the centre, ~1 at the corners)
  let place = (uv - vec2f(0.5)) * vec2f(aspect, 1.0) / (0.5 * sqrt(aspect * aspect + 1.0));
  let noise = ign(uv * size + vec2f(frameU.absFrame * 7.13, frameU.absFrame * 3.71));
  let spin = noise * 6.2831853;
  // the centre pixel: its own area-weight
  let wc = 1.0 / max(r0 * r0, 1.0);
  var sum = centre.rgb * wc;
  var norm = vec3f(wc);
  for (var i = 0u; i < TAPS; i = i + 1u) {
    let fi = f32(i) + fract(noise * 13.7 + f32(i) * 0.618034);
    let d = sqrt(fi / f32(TAPS)) * reach;
    let a = f32(i) * 2.39996323 + spin;
    let o = vec2f(cos(a), sin(a)) * d;
    let tuv = uv + o / size;
    if (any(tuv < vec2f(0.0)) || any(tuv > vec2f(1.0))) { continue; }
    let zt = viewDepth(tuv);
    let ztc = select(params.far, zt, zt > 0.0);
    let ct = cocAt(zt);
    var rt = abs(ct) * size.x;
    // a sample behind this pixel may not spread past this pixel's own disc
    if (ztc > zc) { rt = min(rt, max(r0, 0.0)); }
    let rr = max(rt, 0.75);
    // the disc's shape: a circle cut by a second one slid toward the frame centre (cat's eye)
    let q = o / rr;
    let slid = q + place * params.catEye;
    let inside2 = smoothstep(1.0 + 1.5 / rr, 1.0 - 1.5 / rr, length(slid));
    // longitudinal CA: behind focus red spreads wider than blue, in front the other way
    let s = sign(ct) * params.fringe;
    let rim = 1.0 + params.rim * smoothstep(0.6, 1.0, d / rr);
    let covR = clamp(rr * (1.0 + s) - d + 0.5, 0.0, 1.0);
    let covG = clamp(rr - d + 0.5, 0.0, 1.0);
    let covB = clamp(rr * (1.0 - s) - d + 0.5, 0.0, 1.0);
    let area = 1.0 / max(rr * rr, 1.0);
    let w = vec3f(covR, covG, covB) * area * inside2 * rim;
    let col = textureSampleLevel(inputTexture, inputSampler, tuv, 0.0).rgb;
    sum = sum + col * w;
    norm = norm + w;
  }
  return vec4f(sum / max(norm, vec3f(1e-6)), centre.a);
}`;

/**
 * The FILL after the gather: a small tent over each pixel's neighbourhood, as wide as the
 * gather's tap spacing at this pixel's own disc, so the sparse gather's speckle melts into
 * smooth discs while what is in focus stays untouched. Input = the gathered frame, More = [depth].
 */
export const DOF_FILL_WGSL = `struct Params {
${LENS_PARAMS}
  spacing: f32, // @default 0.22  Fill radius as a share of the pixel's disc radius.
};
${BINDINGS}${VIEW}${COC}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let centre = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let r = abs(cocAt(viewDepth(uv))) * size.x * params.spacing;
  if (r < 0.75) { return centre; }
  var sum = centre.rgb;
  var norm = 1.0;
  for (var i = 1u; i < 24u; i = i + 1u) {
    let d = sqrt(f32(i) / 24.0) * r;
    let a = f32(i) * 2.39996323;
    let tuv = uv + vec2f(cos(a), sin(a)) * d / size;
    let w = 1.0 - d / (r + 1.0);
    sum = sum + textureSampleLevel(inputTexture, inputSampler, tuv, 0.0).rgb * w;
    norm = norm + w;
  }
  return vec4f(sum / norm, centre.a);
}`;

/**
 * The macro's STUDIO, as an equirect for reflections only: near black, one broad soft box
 * overhead, a tall strip to the right, and a scatter of small hard sources all round — the
 * points a stone's facets pick up one at a time, so the pavé sparkles as the lens moves. A few
 * of the small sources are sodium orange and a few cyan (the warehouse's practicals and LED
 * spill), so the glints are not all white. Direction convention as atmosphere.ts's.
 */
export const STUDIO_ENV_WGSL = `struct Params {
  softbox: f32, // @default 3  Radiance of the overhead soft box.
  strip: f32, // @default 6  Radiance of the strip light.
  points: f32, // @default 40  Radiance of the small sources.
  count: f32, // @default 90  How many small sources.
  size: f32, // @default 0.012  Angular radius of a small source, radians.
  ambient: f32, // @default 0.01  The dark room.
  surround: f32, // @default 1.5  Radiance of the white cards round the lens (what a stone facing the lens returns).
  toward: vec3f, // @default 0  Direction from the subject to the lens (world); the cards gather round it.
  cards: f32, // @default 14  How many cards.
  room: f32, // @default 0  Gain of a real room under it all: the input read as an RGBM-packed HDRI (0 ignores the input).
  roomTurn: f32, // @default 0  The room's rotation about the vertical, fraction of a revolution.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

fn h1(i: f32) -> f32 {
  return fract(sin(i * 127.1 + 311.7) * 43758.5453);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let roomTexel = textureSampleLevel(inputTexture, inputSampler, vec2f(fract(uv.x + params.roomTurn), uv.y), 0.0);
  let unused = roomTexel.a * 0.0;
  let phi = (uv.x - 0.5) * 6.2831853;
  let theta = uv.y * 3.1415927;
  let d = vec3f(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
  var c = vec3f(params.ambient) * (0.6 + 0.4 * d.y);
  // a real room (RGBM, range 16), desaturated toward steel: the broad shapes a metal face mirrors
  let roomRgb = roomTexel.rgb * roomTexel.a * 16.0;
  c = c + mix(roomRgb, vec3f(dot(roomRgb, vec3f(0.2126, 0.7152, 0.0722))), 0.7) * params.room;
  // White cards round the lens, with black between them (a jeweller's tent, torn): a facet
  // either returns a card or the black, so the pave reads as hard black-and-white sparkle.
  let fwd = normalize(params.toward + vec3f(1e-4));
  let side = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let upv = cross(side, fwd);
  let local = vec3f(dot(d, side), dot(d, upv), dot(d, fwd));
  if (local.z > 0.05) {
    let q = local.xy / local.z;
    for (var i = 0.0; i < params.cards; i = i + 1.0) {
      let centre = vec2f(h1(i + 3.3) - 0.5, h1(i + 7.9) - 0.5) * 6.5;
      let halfSize = vec2f(0.05 + 0.22 * h1(i + 11.1), 0.04 + 0.3 * h1(i + 13.7));
      let e = abs(q - centre) - halfSize;
      let inside = 1.0 - smoothstep(-0.02, 0.0, max(e.x, e.y));
      c = c + vec3f(0.96, 0.98, 1.0) * params.surround * (0.4 + 0.6 * h1(i + 19.3)) * inside;
    }
    // straight back at the lens: the operator and the camera, dim grey, never pure black
    c = c + vec3f(0.3) * params.surround * 0.25 * smoothstep(0.5, 0.15, length(q));
  }
  // the overhead soft box: a rounded rectangle up and a little behind the lens
  let box = smoothstep(0.35, 0.28, abs(d.x - 0.1)) * smoothstep(0.25, 0.18, abs(d.z + 0.25)) * step(0.5, d.y);
  c = c + vec3f(0.95, 0.97, 1.0) * params.softbox * box;
  // a tall strip to the right: cool
  let az = atan2(d.x, -d.z);
  let strip = smoothstep(0.06, 0.03, abs(az - 1.1)) * smoothstep(0.75, 0.6, abs(d.y - 0.1));
  c = c + vec3f(0.85, 0.95, 1.0) * params.strip * strip;
  // small hard sources, scattered over the sphere; a few warm, a few cyan
  for (var i = 0.0; i < params.count; i = i + 1.0) {
    let u = h1(i) * 2.0 - 1.0;
    let a = h1(i + 17.3) * 6.2831853;
    let p = vec3f(sqrt(1.0 - u * u) * cos(a), u * 0.8 + 0.1, sqrt(1.0 - u * u) * sin(a));
    let k = dot(d, normalize(p));
    let spot = smoothstep(cos(params.size), cos(params.size * 0.5), k);
    let kind = h1(i + 5.1);
    let tint = select(select(vec3f(1.0, 0.98, 0.95), vec3f(1.0, 0.55, 0.22), kind < 0.18), vec3f(0.45, 0.9, 1.0), kind > 0.85);
    c = c + tint * params.points * spot * (0.4 + 0.6 * h1(i + 9.7));
  }
  return vec4f(c + vec3f(unused), 1.0);
}`;

/** Adds the bloom back onto the picture. Input = the picture, More = [bloom]. */
export const BLOOM_ADD_WGSL = `struct Params {
  gain: f32, // @default 0.1  Bloom brightness.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  return vec4f(base.rgb + textureSampleLevel(inputTexture1, inputSampler, uv, 0.0).rgb * params.gain, base.a);
}`;
