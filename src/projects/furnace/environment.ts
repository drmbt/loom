import { KEY_DIRECTION } from "./atmosphere.ts";

/**
 * T1354b — the shop as an EQUIRECT: what a steel surface anywhere in the hall would see
 * reflected. Not a photograph of the hall — the few things that decide how metal reads: a
 * dark roof, the bright bands of the side windows, the skylights overhead, the sun's own
 * disc low on the window side, and a warm, dim floor bounce. Fed to the Render's
 * environment input, it gives the steel its sheen and the shadows their fill.
 *
 * Direction convention is the Render's: u = atan2(R.x, −R.z)/2π + 0.5, v = acos(R.y)/π.
 */
export const SHOP_ENVIRONMENT_WGSL = `struct Params {
  windows: f32, // @default 1.4  Radiance of the side-window bands.
  skylights: f32, // @default 0.9  Radiance of the roof skylights.
  roof: f32, // @default 0.012  Radiance of the dark roof.
  floorBounce: f32, // @default 0.035  Warm light bounced off the floor.
  sun: f32, // @default 6  Radiance of the sun seen through the windows.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

const SUN_DIRECTION: vec3f = vec3f(${(-KEY_DIRECTION[0]).toFixed(4)}, ${(-KEY_DIRECTION[1]).toFixed(4)}, ${(-KEY_DIRECTION[2]).toFixed(4)});

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Keep the input bound (the node requires one); its value never reaches the picture.
  let unused = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).a * 0.0;
  let phi = (uv.x - 0.5) * 6.2831853;
  let theta = uv.y * 3.1415927;
  let d = vec3f(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
  var radiance = mix(vec3f(0.035, 0.026, 0.018) * params.floorBounce / 0.035, vec3f(0.62, 0.64, 0.68) * params.roof, smoothstep(-0.2, 0.3, d.y));
  // Side windows: horizontal bands facing ±Z, between low and high elevation, mullioned.
  let side = abs(d.z);
  let band = smoothstep(0.05, 0.12, d.y) * (1.0 - smoothstep(0.32, 0.42, d.y)) * smoothstep(0.55, 0.8, side);
  let mullions = step(0.18, fract(atan2(d.x, side) * 7.0));
  radiance = radiance + vec3f(0.7, 0.88, 1.0) * params.windows * band * mullions;
  // Skylights: a strip along the roof ridge (X).
  let ridge = smoothstep(0.85, 0.97, d.y) * (1.0 - smoothstep(0.08, 0.2, abs(d.z)));
  radiance = radiance + vec3f(0.68, 0.86, 1.0) * params.skylights * ridge * step(0.4, fract(d.x * 3.0));
  // The sun, low, seen through the window side.
  radiance = radiance + vec3f(1.0, 0.9, 0.75) * params.sun * pow(max(dot(d, SUN_DIRECTION), 0.0), 900.0);
  return vec4f(radiance + vec3f(unused), 1.0);
}`;
