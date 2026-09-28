import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1354b — the SEGMENT FILTER: a slab of the hall, in WORLD space, drawn another way. The
 * picture is reconstructed from depth into world positions; inside a slab across the hall
 * (a plane perpendicular to X, drifting along it) the frame switches treatment:
 *
 *  - wire     the geometry as lines — edges from the G-buffer normal and depth discontinuities,
 *             on black, the hot things still glowing through;
 *  - mono     desaturated steel with only the reds and oranges kept;
 *  - thermal  a false-colour heat map of the frame's own luminance.
 *
 * Because the slab lives in the world, it stays fixed to the plant while the camera moves —
 * the building is being re-drawn, not the screen. The edge of the slab is a thin bright seam.
 * Inputs: Input = graded frame, More = [Depth, Normal].
 */
export const SEGMENT_WGSL = `struct Params {
  eye: vec3f, // @default 0  Camera position (drive from the camera).
  aim: vec3f, // @default 0  Camera look-at (drive from the camera).
  fov: f32, // @default 50  Camera vertical field of view, degrees.
  far: f32, // @default 400  Camera far plane.
  roll: f32, // @default 0  Camera roll, degrees.
  amount: f32, // @default 0  0 = off; 1 = the slab fully treated.
  mode: f32, // @default 0  0 wire, 1 mono, 2 thermal (fractional values blend neighbours).
  centre: f32, // @default 0  Slab centre along the hall (world X, metres).
  width: f32, // @default 12  Slab width, metres.
  edgeColour: vec3f, // @default 1  Colour of the wireframe lines and the slab's seam.
};

${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;

// Right-handed about the camera's +z (the angle is negated about forward), as camera.ts guardedRolledUp (T1433b).
fn rolledRight(forward: vec3f, rollDeg: f32) -> vec3f {
  var up = select(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(forward.y) > 0.999);
  let t = radians(-rollDeg);
  up = up * cos(t) + cross(forward, up) * sin(t) + forward * dot(forward, up) * (1.0 - cos(t));
  return normalize(cross(forward, up));
}

fn texelOf(tex: texture_2d<f32>, uv: vec2f) -> vec2i {
  let size = vec2f(textureDimensions(tex));
  return clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1));
}

fn depthAt(uv: vec2f) -> f32 {
  return textureLoad(inputTexture1, texelOf(inputTexture1, uv), 0).r;
}

fn normalAt(uv: vec2f) -> vec4f {
  return textureLoad(inputTexture2, texelOf(inputTexture2, uv), 0);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let colour = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  if (params.amount <= 0.001) { return colour; }
  let d = depthAt(uv);
  let surface = d > 0.0 && d < 0.9999;
  // World X of this pixel: the slab is chosen in the world, not on the screen.
  let forward = normalize(params.aim - params.eye);
  let right = rolledRight(forward, params.roll);
  let up = cross(right, forward);
  let tanHalf = tan(radians(params.fov) * 0.5);
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let ray = normalize(forward + right * ndc.x * tanHalf * aspect + up * ndc.y * tanHalf);
  let world = params.eye + ray * (select(0.5, d, surface) * params.far / max(dot(ray, forward), 1e-3));
  let offset = abs(world.x - params.centre);
  let inside = (1.0 - smoothstep(params.width * 0.5 - 0.4, params.width * 0.5, offset)) * params.amount;
  let seam = exp(-pow((offset - params.width * 0.5) / 0.15, 2.0)) * params.amount * select(0.0, 1.0, surface);
  if (inside <= 0.0 && seam <= 0.01) { return colour; }

  let luma = dot(colour.rgb, vec3f(0.2126, 0.7152, 0.0722));
  // WIRE: 1-pixel edges from normal and depth discontinuities, on black.
  let px = 1.0 / frameU.resolution;
  let n0 = normalAt(uv);
  let nx = normalAt(uv + vec2f(px.x, 0.0));
  let ny = normalAt(uv + vec2f(0.0, px.y));
  let crease = max(1.0 - dot(n0.rgb * 2.0 - 1.0, nx.rgb * 2.0 - 1.0), 1.0 - dot(n0.rgb * 2.0 - 1.0, ny.rgb * 2.0 - 1.0));
  let dx = abs(depthAt(uv + vec2f(px.x, 0.0)) - d);
  let dy = abs(depthAt(uv + vec2f(0.0, px.y)) - d);
  let silhouette = max(dx, dy) / max(d, 1e-4);
  let edge = clamp(smoothstep(0.08, 0.3, crease) + smoothstep(0.01, 0.04, silhouette), 0.0, 1.0);
  let hot = max(colour.r - max(colour.g, colour.b) * 0.6, 0.0);
  let wire = params.edgeColour * edge * 0.9 + colour.rgb * smoothstep(0.35, 0.8, luma) * 0.8 + vec3f(hot, hot * 0.3, 0.0) * 0.5;
  // MONO: steel grey, only the reds and oranges survive.
  let warmth = smoothstep(0.1, 0.35, colour.r - colour.b);
  let mono = mix(vec3f(luma * 0.9), colour.rgb * 1.1, warmth);
  // THERMAL: false colour from luminance — black, violet, red, orange, white.
  let t = clamp(pow(luma, 0.7), 0.0, 1.0);
  let thermal = mix(mix(mix(vec3f(0.0, 0.0, 0.05), vec3f(0.35, 0.0, 0.45), smoothstep(0.0, 0.25, t)), vec3f(0.9, 0.1, 0.05), smoothstep(0.25, 0.55, t)), mix(vec3f(1.0, 0.55, 0.0), vec3f(1.0, 1.0, 0.85), smoothstep(0.8, 1.0, t)), smoothstep(0.55, 0.8, t));
  let m = clamp(params.mode, 0.0, 2.0);
  let treated = select(mix(mono, thermal, m - 1.0), mix(wire, mono, m), m < 1.0);
  var out = mix(colour.rgb, treated, inside);
  out = out + params.edgeColour * seam * 0.6;
  return vec4f(out, colour.a);
}`;
