import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1354b — the furnace's SCREEN-SPACE passes, on Custom WGSL · Multi (§T1365b) reading the
 * Render's Depth and Normal outputs (§T1371b): ground-truth-style ambient occlusion,
 * screen-space reflections and a bokeh depth of field. Written here first, promoted to stock
 * nodes by §T1372b/§T1373b/§T1376b once they have earned it.
 *
 * Every pass rebuilds the view the same way: the camera's eye, aim and vertical fov arrive
 * as parameters driven from the camera node, depth is VIEW-PLANE distance ÷ far (the
 * Render's contract), so a pixel's world position is eye + ray · (z ÷ dot(ray, forward)).
 */

const CAMERA_PARAMS = `  eye: vec3f, // @default 0  Camera position (drive from the camera).
  aim: vec3f, // @default 0  Camera look-at (drive from the camera).
  fov: f32, // @default 50  Camera vertical field of view, degrees.
  far: f32, // @default 400  Camera far plane (depth arrives as distance ÷ far).`;

const BINDINGS = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
`;

/** The view basis and the helpers every pass shares: ray, world position, reprojection. */
const VIEW = `
struct View {
  forward: vec3f,
  right: vec3f,
  up: vec3f,
  tanHalf: f32,
  aspect: f32,
};

fn makeView() -> View {
  var v: View;
  v.forward = normalize(params.aim - params.eye);
  v.right = normalize(cross(v.forward, vec3f(0.0, 1.0, 0.0)));
  v.up = cross(v.right, v.forward);
  v.tanHalf = tan(radians(params.fov) * 0.5);
  v.aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  return v;
}

fn rayAt(v: View, uv: vec2f) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return normalize(v.forward + v.right * ndc.x * v.tanHalf * v.aspect + v.up * ndc.y * v.tanHalf);
}

fn depthTexel(uv: vec2f) -> vec2i {
  let size = vec2f(textureDimensions(inputTexture1));
  return clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1));
}

// View-plane distance at uv, or a negative number where there is no surface.
fn viewDepth(uv: vec2f) -> f32 {
  let d = textureLoad(inputTexture1, depthTexel(uv), 0).r;
  return select(d * params.far, -1.0, d >= 0.9999 || d <= 0.0);
}

fn worldAt(v: View, uv: vec2f, z: f32) -> vec3f {
  let ray = rayAt(v, uv);
  return params.eye + ray * (z / max(dot(ray, v.forward), 1e-4));
}

// World point → (uv, view-plane distance); z ≤ 0 means behind the camera.
fn project(v: View, world: vec3f) -> vec3f {
  let rel = world - params.eye;
  let z = dot(rel, v.forward);
  let x = dot(rel, v.right) / (max(z, 1e-4) * v.tanHalf * v.aspect);
  let y = dot(rel, v.up) / (max(z, 1e-4) * v.tanHalf);
  return vec3f(x * 0.5 + 0.5, 0.5 - y * 0.5, z);
}

fn ignHash(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}
`;

/**
 * AMBIENT OCCLUSION, horizon-based and normal-aware: for each pixel, a few directions in the
 * tangent plane, a few steps each, out to a WORLD radius; a sample above the surface's
 * horizon occludes by how far above it is, faded with distance. Multiplies the frame — a
 * contact shadow under every beam, in every crease — with a strength knob, because the
 * Render's own AO touches only the ambient term and the shop has very little ambient.
 * Inputs: Input = lit colour, More = Depth, Normal.
 */
export const GTAO_WGSL = `struct Params {
${CAMERA_PARAMS}
  radius: f32, // @default 1.2  World radius of the occlusion search, metres.
  strength: f32, // @default 0.75  How much of the occlusion darkens the frame.
  power: f32, // @default 1.4  Contrast of the occlusion.
};
${BINDINGS}@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
${VIEW}
const DIRECTIONS: u32 = 8u;
const STEPS: u32 = 6u;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let v = makeView();
  let z = viewDepth(uv);
  let encoded = textureLoad(inputTexture2, depthTexel(uv), 0);
  if (z < 0.0 || encoded.a <= 0.0) { return color; }
  let n = normalize(encoded.rgb * 2.0 - 1.0);
  let p = worldAt(v, uv, z);
  let helper = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let t = normalize(cross(n, helper));
  let b = cross(n, t);
  let spin = ignHash(uv * frameU.resolution) * 6.2831853;
  var occlusion = 0.0;
  for (var i = 0u; i < DIRECTIONS; i = i + 1u) {
    let angle = spin + f32(i) * 6.2831853 / f32(DIRECTIONS);
    let dir = t * cos(angle) + b * sin(angle);
    var best = 0.0;
    for (var s = 1u; s <= STEPS; s = s + 1u) {
      let distance = params.radius * (f32(s) / f32(STEPS)) * (f32(s) / f32(STEPS));
      let probe = project(v, p + dir * distance);
      if (probe.z <= 0.0 || any(probe.xy < vec2f(0.0)) || any(probe.xy > vec2f(1.0))) { break; }
      let sz = viewDepth(probe.xy);
      if (sz < 0.0) { continue; }
      let sp = worldAt(v, probe.xy, sz);
      let toSample = sp - p;
      let length2 = dot(toSample, toSample);
      let elevation = dot(n, toSample) * inverseSqrt(max(length2, 1e-6));
      let falloff = 1.0 - smoothstep(params.radius * params.radius * 0.5, params.radius * params.radius * 2.0, length2);
      best = max(best, (elevation - 0.08) * falloff);
    }
    occlusion = occlusion + clamp(best, 0.0, 1.0);
  }
  let ao = pow(clamp(1.0 - occlusion / f32(DIRECTIONS), 0.0, 1.0), params.power);
  return vec4f(color.rgb * mix(1.0, ao, params.strength), color.a);
}`;

/**
 * SCREEN-SPACE REFLECTIONS: from each glossy pixel, march the mirror ray in WORLD space,
 * reproject each step, and accept the first step that passes behind the depth buffer within
 * a thickness; binary-refine it and take the lit colour there. Faded by Fresnel (Schlick,
 * dielectric F0 — wet concrete and oily floor are the target), by roughness, and at the
 * screen edge where the ray leaves what the frame knows. Molten steel and the arc reflect
 * in the floor; that is most of the "real place" read.
 * Inputs: Input = lit colour, More = Depth, Normal.
 */
export const SSR_WGSL = `struct Params {
${CAMERA_PARAMS}
  strength: f32, // @default 1  Overall reflection strength.
  maxDistance: f32, // @default 40  Longest reflection ray, metres.
  thickness: f32, // @default 0.6  How thick a surface is assumed behind the depth buffer, metres.
  roughnessCutoff: f32, // @default 0.45  Surfaces rougher than this reflect nothing.
};
${BINDINGS}@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
${VIEW}
const STEPS: u32 = 40u;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let encoded = textureLoad(inputTexture2, depthTexel(uv), 0);
  let roughness = encoded.a;
  let v = makeView();
  let z = viewDepth(uv);
  if (z < 0.0 || roughness <= 0.0 || roughness > params.roughnessCutoff) { return color; }
  let n = normalize(encoded.rgb * 2.0 - 1.0);
  let p = worldAt(v, uv, z);
  let view = normalize(p - params.eye);
  let r = reflect(view, n);
  let fresnel = 0.04 + 0.96 * pow(1.0 - clamp(dot(-view, n), 0.0, 1.0), 5.0);
  let gloss = 1.0 - smoothstep(0.05, params.roughnessCutoff, roughness);
  if (fresnel * gloss < 0.01) { return color; }
  let jitter = ignHash(uv * frameU.resolution + vec2f(frameU.absFrame * 3.1));
  var previous = 0.0;
  var hit = vec3f(-1.0);
  for (var i = 1u; i <= STEPS; i = i + 1u) {
    let travel = params.maxDistance * pow((f32(i) - 1.0 + jitter) / f32(STEPS), 2.0) + 0.05;
    let probe = project(v, p + r * travel);
    if (probe.z <= 0.0 || any(probe.xy < vec2f(0.0)) || any(probe.xy > vec2f(1.0))) { break; }
    let sceneZ = viewDepth(probe.xy);
    if (sceneZ > 0.0 && probe.z > sceneZ && probe.z - sceneZ < params.thickness + travel * 0.02) {
      // Refine between the last miss and this hit.
      var lo = previous;
      var hi = travel;
      for (var k = 0; k < 5; k = k + 1) {
        let mid = (lo + hi) * 0.5;
        let q = project(v, p + r * mid);
        let qz = viewDepth(q.xy);
        if (qz > 0.0 && q.z > qz) { hi = mid; } else { lo = mid; }
      }
      hit = project(v, p + r * hi);
      break;
    }
    previous = travel;
  }
  if (hit.z <= 0.0) { return color; }
  let edge = smoothstep(0.0, 0.08, min(min(hit.x, 1.0 - hit.x), min(hit.y, 1.0 - hit.y)));
  let reflected = textureSampleLevel(inputTexture, inputSampler, hit.xy, 0.0).rgb;
  let amount = clamp(fresnel * gloss * edge * params.strength, 0.0, 1.0);
  return vec4f(mix(color.rgb, color.rgb + reflected, amount), color.a);
}`;

/**
 * DEPTH OF FIELD, a gather: each pixel's circle of confusion from its depth against the
 * focus distance, then a golden-angle disc of taps, each weighted so a sharp foreground
 * does not bleed into a blurred background. Bright taps bloom into round bokeh by being
 * averaged in linear HDR.
 * Inputs: Input = colour, More = Depth.
 */
export const DOF_WGSL = `struct Params {
${CAMERA_PARAMS}
  focusDistance: f32, // @default 0  Distance in focus, metres; 0 focuses on whatever is at the frame's centre.
  aperture: f32, // @default 0.8  Blur strength: circle radius in pixels per unit of defocus.
  maxRadius: f32, // @default 14  Largest circle of confusion, pixels.
};
${BINDINGS}${VIEW}
const TAPS: u32 = 48u;

fn focusAt() -> f32 {
  if (params.focusDistance > 0.0) { return params.focusDistance; }
  let centre = viewDepth(vec2f(0.5));
  return select(centre, 30.0, centre < 0.0);
}

fn circleAt(z: f32, focus: f32) -> f32 {
  if (z < 0.0) { return params.maxRadius; }
  let defocus = abs(1.0 / max(focus, 0.1) - 1.0 / max(z, 0.1)) * focus;
  return clamp(defocus * params.aperture * 10.0, 0.0, params.maxRadius);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centre = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let z = viewDepth(uv);
  let focus = focusAt();
  let coc = circleAt(z, focus);
  if (coc < 0.5) { return centre; }
  let texel = 1.0 / frameU.resolution;
  var sum = centre.rgb;
  var weight = 1.0;
  for (var i = 1u; i < TAPS; i = i + 1u) {
    let radius = sqrt(f32(i) / f32(TAPS)) * coc;
    let angle = f32(i) * 2.39996323;
    let offset = vec2f(cos(angle), sin(angle)) * radius * texel;
    let tapZ = viewDepth(uv + offset);
    let tapCoc = circleAt(tapZ, focus);
    // A tap contributes if ITS blur reaches this pixel (so an in-focus foreground stays out).
    let w = smoothstep(radius - 1.0, radius + 1.0, max(tapCoc, select(coc, 0.0, tapZ >= 0.0 && tapZ < z - 1.0)));
    sum = sum + textureSampleLevel(inputTexture, inputSampler, uv + offset, 0.0).rgb * w;
    weight = weight + w;
  }
  return vec4f(sum / weight, centre.a);
}`;
