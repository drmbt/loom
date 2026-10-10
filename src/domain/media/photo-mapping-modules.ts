/**
 * Small editable projection stages. Each reads registered near-bright float32
 * depth from the first More socket of Custom WGSL · Multi; the required primary
 * picture sets the output extent. Colour belongs to downstream Tint/compositing.
 * Drive their ordinary parameters with LFOs or expressions to animate them.
 * These strings intentionally have no runtime, DOM or shared-clock dependency.
 */
const DEPTH_INPUT = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

fn depthAt(uv: vec2f) -> f32 {
  let size = vec2i(textureDimensions(inputTexture1));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - vec2i(1));
  return textureLoad(inputTexture1, pixel, 0).r;
}`;

/** White directional illumination of relative relief; neither normals nor shadows are metric. */
export const SHADER_DEPTH_LIGHT = `${DEPTH_INPUT}
struct Params {
  direction: vec3f, // @default [0.8, -0.6, 0.25] Light direction in image axes: X right, Y down, Z toward the viewer. Zero removes the directional light.
  relief: f32, // @default 0.12 Relative height scale; increasing it strengthens normals and local shadows.
  ambient: f32, // @default 0.08 Constant illumination in 0..1, independent of shadow visibility.
  shadow: f32, // @default 0.8 Local shadow strength in 0..1; zero disables the six depth tests.
  gain: f32, // @default 1 White illumination gain. Colour is applied downstream.
};
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture1));
  let pixel = 1.0 / size;
  let scale = max(params.relief, 0.0) * min(size.x, size.y) * 0.5;
  let slope = vec2f(depthAt(uv + vec2f(pixel.x, 0.0)) - depthAt(uv - vec2f(pixel.x, 0.0)),
    depthAt(uv + vec2f(0.0, pixel.y)) - depthAt(uv - vec2f(0.0, pixel.y)));
  let normal = normalize(vec3f(-slope * scale, 1.0));
  let light = params.direction / max(length(params.direction), 0.0001);
  let lateral = length(light.xy);
  var visibility = 1.0;
  if (params.shadow > 0.0 && lateral > 0.0001 && params.relief > 0.0) {
    let center = depthAt(uv);
    let direction = light.xy / lateral;
    for (var tap = 1; tap <= 6; tap++) {
      let offset = direction * pixel * f32(tap * 2);
      let sampleUv = uv + offset;
      if (any(sampleUv < vec2f(0.0)) || any(sampleUv >= vec2f(1.0))) { break; }
      let rayHeight = center + length(offset) * max(light.z, 0.0) / (lateral * params.relief);
      let obstruction = smoothstep(0.002, 0.01, depthAt(sampleUv) - rayHeight);
      visibility = min(visibility, 1.0 - obstruction * clamp(params.shadow, 0.0, 1.0));
    }
  }
  let ambient = clamp(params.ambient, 0.0, 1.0);
  let illumination = (ambient + (1.0 - ambient) * max(dot(normal, light), 0.0) * visibility) * max(params.gain, 0.0);
  return vec4f(vec3f(illumination), 1.0);
}`;

/** Monochrome contour coverage. Paper/ink colours and background compositing are separate nodes. */
export const SHADER_DEPTH_CONTOURS = `${DEPTH_INPUT}
struct Params {
  levels: f32, // @default 24 Number of iso-depth contours across the normalized depth range.
  width: f32, // @default 0.045 Half-width in contour intervals, in 0..0.5.
  offset: f32, // @default 0 Contour phase in intervals; drive this parameter to move the lines through depth.
  gain: f32, // @default 1 Contour coverage gain. White marks the lines; tint or invert downstream.
};
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let phase = depthAt(uv) * max(params.levels, 1.0) + params.offset;
  let distance = abs(fract(phase) - 0.5);
  let antialias = max(fwidth(phase), 0.0001);
  let width = clamp(params.width, 0.0, 0.5);
  let coverage = (1.0 - smoothstep(width, width + antialias, distance)) * max(params.gain, 0.0);
  return vec4f(vec3f(coverage), 1.0);
}`;

/** A monochrome depth-band exposure. Animate center outside the shader to scan the relief. */
export const SHADER_DEPTH_SLICE = `${DEPTH_INPUT}
struct Params {
  center: f32, // @default 0.5 Depth-band center in 0..1; 0 is far and 1 is near.
  thickness: f32, // @default 0.16 Full depth-band width in 0..1.
  softness: f32, // @default 0.03 Feather beyond the band in normalized depth units.
  gain: f32, // @default 1 Exposure gain. White is the exposed slice; colour belongs downstream.
};
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let depth = depthAt(uv);
  let distance = abs(depth - clamp(params.center, 0.0, 1.0));
  let halfWidth = clamp(params.thickness, 0.0, 1.0) * 0.5;
  let feather = max(max(params.softness, 0.0), max(fwidth(depth), 0.0001));
  let exposure = (1.0 - smoothstep(halfWidth, halfWidth + feather, distance)) * max(params.gain, 0.0);
  return vec4f(vec3f(exposure), 1.0);
}`;
/** The common numerical range stage stays separate from styling and geometry. */
export const SHADER_DEPTH_RANGE = `
struct Params { low: f32, // @default 0
  high: f32, // @default 1
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dimensions = vec2i(textureDimensions(inputTexture1));
  let pixel = clamp(vec2i(uv * vec2f(dimensions)), vec2i(0), dimensions - vec2i(1));
  let depth = textureLoad(inputTexture1, pixel, 0).r;
  let working = clamp((depth - params.low) / max(params.high - params.low, 0.000001), 0.0, 1.0);
  return vec4f(working, 0.0, 0.0, 1.0);
}`;
