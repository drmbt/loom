import { SHARED_UNIFORMS_WGSL } from "@runtime/backend/shared-uniforms.ts";
import { wgsl } from "@runtime/backend/wgsl.ts";

/** Stored inside each created network, editable with the existing Custom WGSL controls. */
export const PHOTO_MAPPING_SHADER = wgsl`${SHARED_UNIFORMS_WGSL}
struct Params {
  mode: f32, // @default 0  Effect: 0 contours, 1 aurora, 2 relief, 3 surface trace, 4 depth reveal.
  speed: f32, // @default 0.18  Motion speed.
  bands: f32, // @default 24  Number of relief contours.
  lineWidth: f32, // @default 0.045  Width of each contour.
  gain: f32, // @default 1  Projected brightness.
  photoAmount: f32, // @default 0  Mix in the reference photograph.
  lightColor: vec3f, // @default 1  Colour of the projected effect.
  paletteShift: f32, // @default 0  Rotate the animated colour ramp.
  evolution: f32, // @default 0.35  Slow changes in shape, colour and lighting.
  glow: f32, // @default 0.45  Soft light surrounding contours and ribbons.
  edgeWidth: f32, // @default 0.006  Outline width as a fraction of the shorter image side.
  edgeGlow: f32, // @default 1.2  Brightness of the animated surface boundary.
  architectureDetail: f32, // @default 0.85  Reference-photo detail in projected lines and relief.
  fineDetail: f32, // @default 1  Scale of fine patterns, hatching and light filaments.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;

fn depthAt(uv: vec2f) -> f32 {
  let dims = vec2i(textureDimensions(inputTexture1));
  let pixel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(inputTexture1, pixel, 0).r;
}
fn maskAt(uv: vec2f) -> f32 {
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return 0.0; }
  let dims = vec2i(textureDimensions(inputTexture2));
  let pixel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(inputTexture2, pixel, 0).r;
}
fn surfaceEdge(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(inputTexture2));
  let offset = max(params.edgeWidth, 0.0) * min(dims.x, dims.y) / dims;
  var inside = maskAt(uv + vec2f(offset.x, 0.0));
  inside = min(inside, maskAt(uv - vec2f(offset.x, 0.0)));
  inside = min(inside, maskAt(uv + vec2f(0.0, offset.y)));
  inside = min(inside, maskAt(uv - vec2f(0.0, offset.y)));
  inside = min(inside, maskAt(uv + offset * 0.7071));
  inside = min(inside, maskAt(uv - offset * 0.7071));
  inside = min(inside, maskAt(uv + vec2f(offset.x, -offset.y) * 0.7071));
  inside = min(inside, maskAt(uv + vec2f(-offset.x, offset.y) * 0.7071));
  return smoothstep(0.15, 0.75, maskAt(uv)) * (1.0 - smoothstep(0.15, 0.75, inside));
}
fn ramp(position: f32) -> vec3f {
  let wave = 0.5 + 0.5 * cos(6.2831853 * (position + vec3f(0.0, 0.33, 0.67)));
  return 0.025 + 0.975 * pow(wave, vec3f(1.7));
}
fn ridge(position: f32, width: f32) -> f32 {
  let aa = max(fwidth(position) * 0.65, 0.002);
  return 1.0 - smoothstep(width, width + aa, abs(fract(position) - 0.5));
}
fn hash(point: vec2f) -> f32 {
  return fract(sin(dot(point, vec2f(127.1, 311.7))) * 43758.5453);
}
fn noise(point: vec2f) -> f32 {
  let cell = floor(point);
  let f = fract(point);
  let weight = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(cell), hash(cell + vec2f(1.0, 0.0)), weight.x),
    mix(hash(cell + vec2f(0.0, 1.0)), hash(cell + vec2f(1.0)), weight.x), weight.y);
}
fn field(point: vec2f) -> f32 {
  return noise(point) * 0.57 + noise(point * 2.03 + 19.7) * 0.28
    + noise(point * 4.11 + 7.1) * 0.15;
}
fn luminance(uv: vec2f) -> f32 {
  return dot(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb, vec3f(0.2126, 0.7152, 0.0722));
}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let depth = depthAt(uv);
  let t = frameU.absTime * params.speed;
  let slow = t * params.evolution;
  let phase = 6.2831853 * t;
  let evolve = sin(slow * 0.71) * 0.5 + sin(slow * 1.13) * 0.25;
  let palette = params.paletteShift + slow * 0.12;
  let bands = max(params.bands, 1.0);
  let fine = clamp(params.fineDetail, 0.2, 4.0);
  let width = clamp(params.lineWidth, 0.002, 0.4);
  let glow = clamp(params.glow, 0.0, 1.0);
  let aspect = f32(textureDimensions(inputTexture).x) / f32(textureDimensions(inputTexture).y);
  let p = (uv - 0.5) * vec2f(aspect, 1.0);
  let drift = vec2f(slow * 0.11, -t * 0.09);
  let flow = field(p * 5.0 + drift);
  let turbulence = field(p * 12.0 * fine - drift * 1.7);

  // Photograph derivatives recover cornices, window frames and rooflines that the
  // relative depth model smooths away. Display derivatives keep the detail stable
  // when the source photograph is much larger than the rendered output.
  let pixel = max(1.0 / vec2f(textureDimensions(inputTexture)), fwidth(uv));
  let dxPhoto = luminance(uv + vec2f(pixel.x, 0.0)) - luminance(uv - vec2f(pixel.x, 0.0));
  let dyPhoto = luminance(uv + vec2f(0.0, pixel.y)) - luminance(uv - vec2f(0.0, pixel.y));
  let dxWide = luminance(uv + vec2f(pixel.x * 3.0, 0.0)) - luminance(uv - vec2f(pixel.x * 3.0, 0.0));
  let dyWide = luminance(uv + vec2f(0.0, pixel.y * 3.0)) - luminance(uv - vec2f(0.0, pixel.y * 3.0));
  let detail = clamp(params.architectureDetail, 0.0, 2.0);
  let architecture = clamp(length(vec2f(dxPhoto, dyPhoto)) * 4.0 + length(vec2f(dxWide, dyWide)) * 1.15, 0.0, 1.0) * detail;
  let depthPixel = max(pixel, 1.0 / vec2f(textureDimensions(inputTexture1)));
  let dx = depthAt(uv + vec2f(depthPixel.x, 0.0)) - depthAt(uv - vec2f(depthPixel.x, 0.0));
  let dy = depthAt(uv + vec2f(0.0, depthPixel.y)) - depthAt(uv - vec2f(0.0, depthPixel.y));
  let depthEdge = clamp(length(vec2f(dx, dy)) * 22.0, 0.0, 1.0);
  let travel = 0.55 + 0.45 * sin(uv.x * 14.0 - uv.y * 9.0 + depth * 8.0 - phase);
  let topology = depth * bands * (1.0 + 0.12 * evolve) - t + (flow - 0.5) * 0.8;
  let line = ridge(topology, width);
  let halo = exp(-18.0 * abs(fract(topology) - 0.5)) * glow;
  var colour = vec3f(0.0);

  if (params.mode < 0.5) {
    // Neon engraving: three independently moving contour scales with photographic
    // architecture etched as bright hairlines over deep indigo recesses.
    let micro = ridge(depth * bands * 2.7 * fine + uv.y * 2.0 - t * 0.37 + flow, width * 0.3);
    let braid = ridge(depth * bands * 0.43 + p.x * 2.0 + t * 0.61 + turbulence * 0.6, width * 0.65);
    colour = vec3f(0.009, 0.014, 0.065)
      + ramp(depth * 1.35 + palette + flow * 0.17) * (line * 0.85 + halo * 0.38)
      + vec3f(0.08, 0.9, 1.0) * micro * (0.12 + glow * 0.18)
      + vec3f(1.0, 0.055, 0.42) * braid * (0.08 + halo * 0.3)
      + mix(vec3f(0.12, 0.75, 1.0), vec3f(1.0, 0.22, 0.65), travel) * architecture * (0.35 + travel * 0.55);
  } else if (params.mode < 1.5) {
    // Liquid stained glass: slowly advected colour islands, crossing spectral
    // ribbons and luminous seams pick out architectural features inside each cell.
    let warp = p * 4.0 + vec2f(flow, turbulence) * (1.0 + evolve * 0.4);
    let liquid = field(warp + vec2f(t * 0.16, slow * 0.23));
    let striation = liquid * max(bands * 0.33, 1.0) + depth * max(bands * 0.125, 1.0) - t * 0.43;
    let seam = ridge(striation, width * 0.45);
    let ribbon = ridge(depth * 5.0 + liquid * 2.0 + p.y * 1.1 + t * 0.24, 0.13);
    let fringe = ridge(striation * 2.0 * fine + turbulence * 0.5, width * 0.2);
    let windowGlow = 0.6 + 0.4 * sin(phase * 0.31 + liquid * 10.0);
    colour = ramp(liquid * 1.3 + palette + depth * 0.3) * (0.24 + ribbon * 0.35)
      + ramp(liquid + palette + 0.38) * seam * 0.8
      + vec3f(0.45, 0.95, 1.0) * fringe * glow * 0.25
      + ramp(liquid + palette + 0.1) * architecture * windowGlow * 0.55;
  } else if (params.mode < 2.5) {
    // Brushed iridescent metal: photographic embossing adds fine relief beneath
    // grazing gold and cyan lights, anisotropic highlights and a silver rim.
    let normal = normalize(vec3f(-dx * 40.0 - dxPhoto * detail * 3.0,
      -dy * 40.0 - dyPhoto * detail * 3.0, 1.0));
    let lightA = normalize(vec3f(cos(phase * 0.41), sin(phase * 0.41), 0.43));
    let lightB = normalize(vec3f(cos(-phase * 0.27 + 2.0), sin(-phase * 0.27 + 2.0), 0.65));
    let diffuseA = pow(max(dot(normal, lightA), 0.0), 1.5);
    let diffuseB = pow(max(dot(normal, lightB), 0.0), 2.0);
    let halfLight = normalize(lightA + vec3f(0.0, 0.0, 1.0));
    let specular = pow(max(dot(normal, halfLight), 0.0), 30.0);
    let brushed = 0.7 + 0.3 * sin((uv.x * 160.0 * fine + turbulence * 0.3) * 6.2831853);
    let patina = field(p * 6.0 + slow * 0.13);
    let copper = mix(vec3f(0.22, 0.095, 0.035), vec3f(1.0, 0.4, 0.055), patina);
    let metal = mix(copper, ramp(patina * 0.5 + palette), abs(sin(params.paletteShift * 3.14159)) * 0.55);
    let thin = ridge(depth * bands * 0.9 + t * 0.15, width * 0.45);
    colour = metal * (0.25 + diffuseA * 0.82) * brushed
      + vec3f(0.02, 0.37, 0.63) * diffuseB * 0.25
      + vec3f(1.0, 0.69, 0.21) * specular * (0.4 + glow * 0.9)
      + mix(vec3f(0.06, 0.62, 1.0), vec3f(1.0, 0.45, 0.065), 0.5 + 0.5 * sin(slow + depth * 6.0))
        * (architecture * 0.27 + depthEdge * glow * 0.14 + thin * 0.12);
  } else if (params.mode < 3.5) {
    // Electric blueprint: architectural linework, layered technical hatching,
    // moving amber scans and pulses travel through a stable fine calibration grid.
    let grid = max(ridge(uv.x * 18.0 * aspect + 0.5, 0.015), ridge(uv.y * 18.0 + 0.5, 0.015));
    let hatch = ridge((p.x + p.y) * 48.0 * fine + depth * 4.0, 0.035);
    let scanPosition = fract(t * 0.2 + 0.15);
    let scanDistance = abs(uv.y - scanPosition);
    let scan = exp(-scanDistance * scanDistance * 650.0);
    let dash = ridge((uv.x * aspect + uv.y) * 27.0 * fine - t * 2.0, 0.17);
    let traced = architecture * (0.42 + dash * 0.52) + depthEdge * 0.23;
    let tracePulse = 0.72 + 0.28 * sin(phase + depth * 8.0 + slow * 1.3);
    let gridPulse = 0.16 + 0.16 * (0.5 + 0.5 * sin(phase * 0.6 + uv.y * 9.0 + slow * 0.7));
    let blueprint = mix(vec3f(0.04, 0.65, 1.0), ramp(0.6 + palette), 0.25);
    colour = vec3f(0.015, 0.045, 0.14)
      + vec3f(0.08, 0.52, 1.0) * (grid * gridPulse + line * 0.14 + hatch * 0.015)
      + blueprint * traced * (0.8 + glow * 0.4) * tracePulse
      + vec3f(1.0, 0.5, 0.06) * scan * (0.3 + architecture * 0.7);
  } else {
    // Depth atlas: faceted colour tiles, slowly rotating hatching and a bright
    // scanning iso-depth plane expose large form and finer architectural relief.
    let angle = 0.3 + sin(slow * 0.4) * 0.5;
    let rotated = vec2f(p.x * cos(angle) - p.y * sin(angle), p.x * sin(angle) + p.y * cos(angle));
    let cells = floor(rotated * 20.0 * fine);
    let crystal = hash(cells);
    let facet = ridge(rotated.x * 20.0 * fine + 0.5, 0.02) + ridge(rotated.y * 20.0 * fine + 0.5, 0.02);
    let plane = 0.5 + sin(phase * 0.23 + slow * 0.17) * 0.46;
    let delta = (depth - plane) * 26.0;
    let sweep = exp(-delta * delta);
    let contours = ridge(depth * bands * 1.5 - t * 0.43, width * 0.35);
    let depthColour = mix(vec3f(0.025, 0.12, 0.55), vec3f(1.0, 0.24, 0.09), smoothstep(0.1, 0.85, depth));
    colour = depthColour * (0.32 + crystal * 0.36 + turbulence * 0.12)
      + ramp(depth * 0.75 + palette + 0.3) * contours * 0.4
      + vec3f(0.3, 0.65, 1.0) * facet * glow * 0.12
      + vec3f(0.72, 0.95, 1.0) * sweep * (0.45 + architecture * 0.55)
      + mix(vec3f(0.08, 0.72, 1.0), vec3f(1.0, 0.65, 0.08), depth) * architecture * 0.48;
  }
  // The independently editable mask still traces holes and concavities exactly.
  let edge = surfaceEdge(uv);
  let chase = 0.78 + 0.22 * sin(6.2831853 * (uv.x * 1.7 + uv.y * 1.1 + depth * 0.4 - t));
  var edgeColour = ramp(uv.x * 0.7 + uv.y * 0.4 + palette - t * 0.14);
  if (params.mode >= 1.5 && params.mode < 2.5) { edgeColour = vec3f(1.0, 0.43, 0.065); }
  if (params.mode >= 2.5 && params.mode < 3.5) { edgeColour = vec3f(0.05, 0.7, 1.0); }
  let boundary = edgeColour * max(params.edgeGlow, 0.0) * chase;
  colour = mix(colour, boundary, edge * clamp(params.edgeGlow, 0.0, 1.0));
  colour = clamp(colour, vec3f(0.0), vec3f(1.0));
  let photo = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let light = max(colour.r, max(colour.g, colour.b));
  let projected = mix(colour * params.lightColor, photo * light, clamp(params.photoAmount, 0.0, 1.0));
  return vec4f(projected * params.gain, 1.0);
}`;
