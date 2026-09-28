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

/**
 * THE TUBE, PHOTOGRAPHED (T1423b) — the CRT re-scan as a ray tracer, promoted from the On
 * Nothing crt shot (`TUBE_WGSL` in `src/projects/on-nothing/shots/crt.ts`, T1407b), where it
 * was measured off the reference's re-scanned macro.
 *
 * A thin-lens macro camera (16 aperture samples: real depth of field) looks through a curved
 * glass faceplate (refracted, with a Fresnel reflection of a dark room) onto a curved phosphor
 * surface carrying an aperture grille of R, G, B stripes, lit by scanlines whose beams swell
 * with brightness, interlaced in two fields at 59.94 Hz that the shutter half-catches. Units are
 * millimetres; the tube is a 4:3 face `tubeSize` wide, its phosphor on a sphere of radius
 * `curvature` (apex at z = 0, +z toward the camera), behind `glass` of faceplate. The input is
 * the picture on the tube (linear display light, cropped to 4:3); the output is the camera's
 * finished frame, graded (a soft shoulder, a cast, little chroma, a lift, grain) to linear
 * display light for an Output whose tone map is off. The pixel grid is the input's own size.
 */
export const CRT_TUBE_WGSL = wgsl`${SHARED_UNIFORMS_WGSL}

struct Params {
  tubeSize: vec2f,
  curvature: f32,
  glass: f32,
  lines: f32,
  triads: f32,
  aim: vec2f,
  distance: f32,
  pitch: f32,
  yaw: f32,
  roll: f32,
  fov: f32,
  aperture: f32,
  focus: f32,
  beamDark: f32,
  beamBright: f32,
  grille: f32,
  field: f32,
  halation: f32,
  invert: f32,
  contrast: f32,
  pivot: f32,
  unlit: f32,
  reflection: f32,
  exposure: f32,
  gain: f32,
  lift: f32,
  tint: vec3f,
  saturation: f32,
  grain: f32,
};
@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var inputSampler: sampler;
@group(0) @binding(3) var inputTexture: texture_2d<f32>;

const SAMPLES: i32 = 16;

fn hash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Nearest positive hit of a ray with a sphere centred on (0, 0, -curvature); -1 if none.
fn sphere(o: vec3f, d: vec3f, r: f32, far: bool) -> f32 {
  let c = vec3f(0.0, 0.0, -params.curvature);
  let oc = o - c;
  let b = dot(oc, d);
  let h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) { return -1.0; }
  let s = sqrt(h);
  return select(-b - s, -b + s, far);
}

// A point on the phosphor for face coordinates (u, v).
fn facePoint(uv: vec2f) -> vec3f {
  let x = (uv.x - 0.5) * params.tubeSize.x;
  let y = (0.5 - uv.y) * params.tubeSize.y;
  let r = params.curvature;
  return vec3f(x, y, sqrt(max(r * r - x * x - y * y, 0.0)) - r);
}

// The picture as the tube shows it: negative (by invert), contrasty, on the face's 4:3.
fn picture(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(inputTexture));
  let crop = (4.0 / 3.0) / (size.x / size.y);
  let at = vec2f(0.5 + (uv.x - 0.5) * crop, uv.y);
  var c = pow(max(textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb, vec3f(0.0)), vec3f(1.0 / 2.2));
  c = mix(c, 1.0 - c, params.invert);
  c = clamp((c - params.pivot) * params.contrast + 0.5, vec3f(0.0), vec3f(1.0));
  return pow(c, vec3f(2.2));
}

// Light leaving the phosphor at face coordinates uv (scanlines, fields, grille).
fn phosphor(uv: vec2f, fieldNow: f32) -> vec3f {
  let lineF = uv.y * params.lines;
  let line = floor(lineF);
  let du = 0.8 / (params.triads * 3.0);
  var light = vec3f(0.0);
  for (var k = -1; k <= 1; k = k + 1) {
    let ln = line + f32(k);
    let yc = (ln + 0.5) / params.lines;
    // the video's limited bandwidth: a short horizontal smear along the line
    let c = (picture(vec2f(uv.x - du, yc)) + picture(vec2f(uv.x, yc)) * 2.0 + picture(vec2f(uv.x + du, yc))) * 0.25;
    let peak = max(c.r, max(c.g, c.b));
    let sigma = mix(params.beamDark, params.beamBright, sqrt(clamp(peak, 0.0, 1.0)));
    let y = lineF - (ln + 0.5);
    let fieldW = select(params.field, 1.0, (i32(ln) & 1) == i32(fieldNow));
    light = light + c * exp(-(y * y) / (2.0 * sigma * sigma)) / (sigma * 2.5066) * fieldW;
  }
  // aperture grille: three phosphor stripes a triad, each lit only in its own colour
  let t = fract(uv.x * params.triads) * 3.0;
  let stripe = floor(t);
  let across = (fract(t) - 0.5) / max(params.grille, 0.05);
  let fill = smoothstep(0.5, 0.35, abs(across));
  var mask = vec3f(0.0);
  mask[i32(stripe)] = fill * 3.0 / max(params.grille, 0.05);
  // the halation: the glass scatters a little of the picture around each point
  let halo = picture(uv + vec2f(0.004, 0.0)) + picture(uv - vec2f(0.004, 0.0)) + picture(uv + vec2f(0.0, 0.005)) + picture(uv - vec2f(0.0, 0.005));
  return light * mask + halo * 0.25 * params.halation + vec3f(params.unlit);
}

// The room in the faceplate: a dark studio, one soft window high on the left.
fn room(d: vec3f) -> vec3f {
  let win = exp(-pow(length(d - normalize(vec3f(-0.5, 0.6, 0.6))) / 0.35, 2.0));
  return vec3f(0.004, 0.005, 0.006) + vec3f(0.25, 0.27, 0.3) * win;
}

fn rotate(v: vec3f, axis: vec3f, angle: f32) -> vec3f {
  return v * cos(angle) + cross(axis, v) * sin(angle) + axis * dot(axis, v) * (1.0 - cos(angle));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / max(size.y, 1.0);
  // The camera: back from the target along the face's normal, swung up by pitch and aside by yaw.
  let aimAt = facePoint(params.aim);
  let normal = normalize(aimAt - vec3f(0.0, 0.0, -params.curvature));
  var back = rotate(normal, vec3f(1.0, 0.0, 0.0), -radians(params.pitch));
  back = rotate(back, vec3f(0.0, 1.0, 0.0), radians(params.yaw));
  let eye = aimAt + back * params.distance;
  let forward = -back;
  var up = normalize(vec3f(0.0, 1.0, 0.0) - forward * forward.y);
  // roll: the Camera node's sign (camera.ts guardedRolledUp), right-handed about the camera's +z
  up = rotate(up, forward, radians(-params.roll));
  let right = normalize(cross(forward, up));
  let tanHalf = tan(radians(params.fov) * 0.5);
  let focal = params.distance + params.focus;
  let fieldNow = floor(frameU.absTime * 59.94) % 2.0;

  var sum = vec3f(0.0);
  let seed = vec3f(uv * size, frameU.absFrame);
  for (var s = 0; s < SAMPLES; s = s + 1) {
    let j = vec2f(hash(seed + f32(s) * 1.7), hash(seed + f32(s) * 3.1 + 11.0)) - 0.5;
    let p = uv + j / size;
    let ndc = vec2f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
    let dir = normalize(forward + right * ndc.x * tanHalf * aspect + up * ndc.y * tanHalf);
    // thin lens: a point on the aperture, aimed through the plane of focus
    let a = (f32(s) + hash(seed + 5.0)) * 2.39996323;
    let rr = sqrt((f32(s) + 0.5) / f32(SAMPLES)) * params.aperture;
    let lens = eye + (right * cos(a) + up * sin(a)) * rr;
    let inFocus = eye + dir * (focal / dot(dir, forward));
    let ray = normalize(inFocus - lens);
    // the faceplate: refract in, then find the phosphor behind it
    let t1 = sphere(lens, ray, params.curvature + params.glass, false);
    if (t1 < 0.0) { continue; }
    let p1 = lens + ray * t1;
    let n1 = normalize(p1 - vec3f(0.0, 0.0, -params.curvature));
    let inside = refract(ray, n1, 1.0 / 1.52);
    let t2 = sphere(p1, inside, params.curvature, false);
    if (t2 < 0.0) { continue; }
    let p2 = p1 + inside * t2;
    let face = vec2f(p2.x / params.tubeSize.x + 0.5, 0.5 - p2.y / params.tubeSize.y);
    var light = vec3f(0.0);
    if (all(face >= vec2f(0.0)) && all(face <= vec2f(1.0))) { light = phosphor(face, fieldNow); }
    let cosi = clamp(dot(-ray, n1), 0.0, 1.0);
    let fresnel = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);
    sum = sum + light * (1.0 - fresnel) + room(reflect(ray, n1)) * fresnel * params.reflection;
  }
  var c = sum / f32(SAMPLES);
  // the camera's grade: a soft shoulder, a cast, little chroma, blacks lifted, grain
  c = c * params.exposure / (vec3f(1.0) + c * params.exposure * 0.25);
  c = pow(c, vec3f(1.0 / 2.2)) * params.tint * params.gain;
  let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(y), c, params.saturation);
  c = c + vec3f(params.lift) * (1.0 - c);
  let n = hash(vec3f(floor(uv * size / 1.3), frameU.absFrame * 1.7)) + hash(vec3f(floor(uv * size / 1.3) + 17.0, frameU.absFrame)) - 1.0;
  c = clamp(c + vec3f(n) * params.grain * (0.4 + 0.6 * (1.0 - y)), vec3f(0.0), vec3f(1.0));
  return vec4f(pow(c, vec3f(2.2)), 1.0);
}`;
