import { SHARED_UNIFORMS_WGSL } from "@runtime/backend/shared-uniforms.ts";
import { wgsl } from "@runtime/backend/wgsl.ts";

export const PHOTO_MAPPING_EFFECTS = [
  { id: 0, name: "Neon contours", description: "Animated depth contours pick out ledges and architectural edges" },
  { id: 1, name: "Prismatic sweep", description: "Colour sweeps through depth planes, revealing protrusions and recesses" },
  { id: 2, name: "Chromatic relief", description: "Grazing gold and cyan lights reveal depth relief and local shadows" },
  { id: 3, name: "Surface trace", description: "Depth scans follow architecture and the mask boundary, including openings" },
  { id: 4, name: "Depth reveal", description: "Layered depth bands reveal recesses, highlights and occlusion" },
  { id: 5, name: "Moonlit stone", description: "Moving white grazing light reveals depth relief and architectural shadows" },
  { id: 6, name: "Liquid strata", description: "Luminous ribbons flow along depth bands and catch surface details" },
  { id: 7, name: "Depth constellation", description: "Registered points pulse through depth while tracing structural seams" },
  { id: 8, name: "Thermal scan", description: "A moving depth scanner lights near and far planes with a warm spectral ramp" },
  { id: 9, name: "Mapped video", description: "Video uses the same surface mask, Grid Warp and Corner Pin as every other effect" },
] as const;

/** Regular UV geometry: the switch sends this through the same mask and projector warps. */
export const PHOTO_ALIGNMENT_SHADER = wgsl`
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let grid = uv * 10.0;
  let cell = vec2i(floor(grid));
  let checker = f32((cell.x + cell.y) % 2);
  let aa = max(fwidth(grid), vec2f(0.004));
  let distance = min(fract(grid), 1.0 - fract(grid));
  let lines = 1.0 - smoothstep(aa.x, aa.x * 2.0, min(distance.x, distance.y));
  var colour = mix(vec3f(0.07), vec3f(0.2), checker) + vec3f(lines * 0.55);
  let center = abs(uv - 0.5);
  colour = mix(colour, vec3f(1.0, 0.15, 0.1), 1.0 - smoothstep(0.002, 0.005, center.x));
  colour = mix(colour, vec3f(0.1, 1.0, 0.25), 1.0 - smoothstep(0.002, 0.005, center.y));
  let corners = step(0.92, max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0);
  let quadrant = vec3f(select(0.1, 1.0, uv.x > 0.5), select(0.1, 1.0, uv.y > 0.5), 0.6);
  return vec4f(mix(colour, quadrant, corners), 1.0);
}`;

/** Stored inside each created network, editable with the existing Custom WGSL controls. */
export const PHOTO_MAPPING_SHADER = wgsl`${SHARED_UNIFORMS_WGSL}
struct Params {
  mode: f32, // @default 0  Effect: 0 contours, 1 prismatic sweep, 2 chromatic relief, 3 surface trace, 4 depth reveal.
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
  fineDetail: f32, // @default 1  Scale of fine depth contours and architectural highlights.
  depthStrength: f32, // @default 1  Strength of relative-depth relief and shadows.
  depthLow: f32, // @default 0  Far cutoff for relative-depth re-ranging.
  depthHigh: f32, // @default 1  Near cutoff for relative-depth re-ranging.
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
  let raw = textureLoad(inputTexture1, pixel, 0).r;
  return clamp((raw - params.depthLow) / max(params.depthHigh - params.depthLow, 0.000001), 0.0, 1.0);
}
fn maskAt(uv: vec2f) -> f32 {
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return 0.0; }
  let dims = vec2i(textureDimensions(inputTexture2));
  let pixel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(inputTexture2, pixel, 0).r;
}
fn edgeMaskAt(uv: vec2f) -> f32 {
  let halfPixel = 0.5 / vec2f(textureDimensions(inputTexture2));
  return maskAt(clamp(uv, halfPixel, vec2f(1.0) - halfPixel));
}
fn surfaceEdge(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(inputTexture2));
  let offset = max(params.edgeWidth, 0.0) * min(dims.x, dims.y) / dims;
  var inside = edgeMaskAt(uv + vec2f(offset.x, 0.0));
  inside = min(inside, edgeMaskAt(uv - vec2f(offset.x, 0.0)));
  inside = min(inside, edgeMaskAt(uv + vec2f(0.0, offset.y)));
  inside = min(inside, edgeMaskAt(uv - vec2f(0.0, offset.y)));
  inside = min(inside, edgeMaskAt(uv + offset * 0.7071));
  inside = min(inside, edgeMaskAt(uv - offset * 0.7071));
  inside = min(inside, edgeMaskAt(uv + vec2f(offset.x, -offset.y) * 0.7071));
  inside = min(inside, edgeMaskAt(uv + vec2f(-offset.x, offset.y) * 0.7071));
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
// Relative inverse depth is a height field, not metric geometry. A short ray
// along the grazing light tests nearby protrusions without moving the photograph.
fn visibility(uv: vec2f, depth: f32, light: vec3f, strength: f32) -> f32 {
  let dims = vec2f(textureDimensions(inputTexture1));
  let direction = normalize(light.xy);
  let stepUV = direction * 2.0 / dims;
  var blocked = 0.0;
  for (var step = 1; step <= 12; step++) {
    let offset = stepUV * f32(step);
    let sampleUV = uv + offset;
    let rayHeight = depth + length(offset) * light.z / max(length(light.xy) * strength * 0.25, 0.001);
    let obstruction = smoothstep(0.003, 0.025, depthAt(sampleUV) - rayHeight);
    blocked = max(blocked, obstruction * maskAt(sampleUV));
  }
  return 1.0 - blocked * 0.85;
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
  let strength = clamp(params.depthStrength, 0.0, 4.0);

  // Recover cornices and window frames at their fixed photo coordinates. These
  // derivatives affect projected features independently of literal photo mixing.
  let pixel = max(1.0 / vec2f(textureDimensions(inputTexture)), fwidth(uv));
  let dxPhoto = luminance(uv + vec2f(pixel.x, 0.0)) - luminance(uv - vec2f(pixel.x, 0.0));
  let dyPhoto = luminance(uv + vec2f(0.0, pixel.y)) - luminance(uv - vec2f(0.0, pixel.y));
  let dxWide = luminance(uv + vec2f(pixel.x * 3.0, 0.0)) - luminance(uv - vec2f(pixel.x * 3.0, 0.0));
  let dyWide = luminance(uv + vec2f(0.0, pixel.y * 3.0)) - luminance(uv - vec2f(0.0, pixel.y * 3.0));
  let detail = clamp(params.architectureDetail, 0.0, 2.0);
  let architecture = clamp(length(vec2f(dxPhoto, dyPhoto)) * (3.0 + fine)
    + length(vec2f(dxWide, dyWide)) * 1.15, 0.0, 1.0) * detail;
  let depthPixel = max(pixel, 1.0 / vec2f(textureDimensions(inputTexture1)));
  let left = depthAt(uv - vec2f(depthPixel.x, 0.0));
  let right = depthAt(uv + vec2f(depthPixel.x, 0.0));
  let above = depthAt(uv - vec2f(0.0, depthPixel.y));
  let below = depthAt(uv + vec2f(0.0, depthPixel.y));
  let gradient = vec2f(right - left, below - above) / (2.0 * depthPixel);
  let normal = normalize(vec3f(-gradient * strength * 0.42, 1.0));
  let photoNormal = normalize(vec3f(-gradient * strength * 0.42
    - vec2f(dxPhoto, dyPhoto) * detail * 3.0, 1.0));
  let curvature = (left + right + above + below - depth * 4.0);
  let depthEdge = clamp(length(gradient) * strength * 0.28, 0.0, 1.0);
  let crease = clamp(abs(curvature) * 60.0 * strength, 0.0, 1.0);
  let features = clamp(architecture + depthEdge * 0.45 + crease, 0.0, 1.5);
  let topology = depth * bands * (1.0 + evolve * 0.12) - t;
  let line = ridge(topology, width);
  let halo = exp(-18.0 * abs(fract(topology) - 0.5)) * glow;
  let featurePulse = 0.65 + 0.35 * sin(depth * 18.0 - phase + slow * 0.7);
  var colour = vec3f(0.0);

  if (params.mode < 0.5) {
    // Iso-depth engraving: every filament is a level set of the measured field.
    let micro = ridge(depth * bands * 2.7 * fine - t * 0.37, width * 0.3);
    let contourColour = ramp(depth * 1.35 + palette);
    colour = ramp(depth * 0.6 + palette + 0.7) * 0.18
      + contourColour * (line * 0.85 + halo * 0.45)
      + vec3f(0.03, 0.8, 1.0) * micro * (0.12 + glow * 0.2)
      + mix(vec3f(0.08, 0.65, 1.0), vec3f(1.0, 0.05, 0.35), featurePulse)
        * features * (0.45 + featurePulse * 0.65);
  } else if (params.mode < 1.5) {
    // Broad spectral light planes cross depth, then catch differently facing walls.
    let plane = depth * (2.4 + evolve * 0.8) - t * 0.25;
    let spectral = ramp(plane + palette);
    let light = normalize(vec3f(cos(phase * 0.21), sin(phase * 0.21), 0.3));
    let facing = max(dot(normal, light), 0.0);
    let prism = ridge(depth * max(bands * 0.25, 1.0) - t * 0.43, width * 0.65);
    let sheet = 0.5 + 0.5 * sin(6.2831853 * plane);
    colour = spectral * (0.35 + sheet * 0.25 + facing * 0.35)
      + ramp(plane + palette + 0.32) * prism * (0.4 + glow * 0.5)
      + mix(vec3f(0.1, 0.8, 1.0), vec3f(1.0, 0.2, 0.55), featurePulse)
        * features * (0.55 + featurePulse * 0.45);
  } else if (params.mode < 2.5) {
    // Warm raised faces and cool recesses exchange grazing light and real local
    // occlusion. Photo embossing is confined to the photograph's actual edges.
    let lightA = normalize(vec3f(cos(phase * 0.27 + slow * 0.4), sin(phase * 0.27 + slow * 0.4), 0.24));
    let lightB = normalize(vec3f(cos(-phase * 0.19 + 2.3), sin(-phase * 0.19 + 2.3), 0.4));
    let shadow = visibility(uv, depth, lightA, strength);
    let diffuseA = max(dot(photoNormal, lightA), 0.0) * shadow;
    let diffuseB = max(dot(photoNormal, lightB), 0.0);
    let halfLight = normalize(lightA + vec3f(0.0, 0.0, 1.0));
    let specular = pow(max(dot(photoNormal, halfLight), 0.0), 12.0 + fine * 10.0) * shadow;
    let raised = smoothstep(0.15, 0.9, depth);
    let gold = mix(vec3f(0.52, 0.15, 0.025), vec3f(1.0, 0.56, 0.08), raised);
    let cold = vec3f(0.015, 0.31, 0.7);
    let metal = mix(gold, ramp(depth * 0.4 + palette), abs(sin(params.paletteShift * 3.14159)) * 0.45);
    colour = metal * (0.25 + diffuseA * 0.85) * (0.65 + shadow * 0.35)
      + cold * diffuseB * (0.4 + (1.0 - raised) * 0.5)
      + vec3f(1.0, 0.78, 0.29) * specular * (0.45 + glow * 0.9)
      + mix(vec3f(0.05, 0.75, 1.0), vec3f(1.0, 0.5, 0.07), featurePulse)
        * architecture * (0.6 + featurePulse * 0.35)
      + vec3f(1.0, 0.39, 0.055) * crease * glow * 0.4;
  } else if (params.mode < 3.5) {
    // A depth scanner activates measured seams and architectural linework. Empty
    // wall interiors carry only a quiet depth tint, never a screen-space grid.
    let plane = 0.5 + sin(phase * 0.19 + slow * 0.23) * 0.48;
    let delta = (depth - plane) * (9.0 + fine * 4.0);
    let scan = exp(-delta * delta);
    let blueprint = mix(vec3f(0.025, 0.65, 1.0), ramp(0.58 + palette), 0.22);
    colour = vec3f(0.012, 0.055, 0.19) + blueprint * depth * (0.035 + featurePulse * 0.035)
      + blueprint * features * (0.4 + featurePulse * 0.65) * (0.8 + glow * 0.4)
      + vec3f(1.0, 0.51, 0.035) * scan * features * (0.9 + glow * 0.7);
  } else if (params.mode < 4.5) {
    // Depth strata alternately expose near and far surfaces, with the transition
    // following the height field and its occluding ridges rather than tiled UVs.
    let plane = 0.5 + sin(phase * 0.23 + slow * 0.17) * 0.46;
    let reveal = smoothstep(plane - 0.035, plane + 0.035, depth);
    let delta = (depth - plane) * (18.0 + fine * 8.0);
    let sweep = exp(-delta * delta);
    let strata = ridge(depth * bands * 0.5 - t * 0.18 + evolve * 0.4, width * 0.5);
    let far = mix(vec3f(0.025, 0.08, 0.38), vec3f(0.08, 0.4, 0.75), depth);
    let near = mix(vec3f(0.8, 0.12, 0.04), vec3f(1.0, 0.62, 0.08), depth);
    colour = mix(far, near, reveal) * (0.55 + normal.z * 0.25)
      + ramp(depth * 0.7 + palette + 0.2) * strata * glow * 0.35
      + vec3f(0.65, 0.94, 1.0) * sweep * (0.55 + features * 0.4)
      + mix(vec3f(0.05, 0.65, 1.0), vec3f(1.0, 0.62, 0.08), reveal)
        * features * (0.55 + featurePulse * 0.35);
  } else if (params.mode < 5.5) {
    let light = normalize(vec3f(cos(phase * 0.19), sin(phase * 0.19), 0.28));
    let shadow = visibility(uv, depth, light, strength);
    let facing = max(dot(photoNormal, light), 0.0) * shadow;
    colour = vec3f(0.08, 0.12, 0.2) * (0.2 + depth * 0.4)
      + vec3f(0.68, 0.82, 1.0) * facing * 0.85
      + vec3f(0.45, 0.8, 1.0) * features * featurePulse * 0.25;
  } else if (params.mode < 6.5) {
    let ribbon = depth * (5.0 + evolve * 0.6) - t * 0.4;
    let crest = pow(0.5 + 0.5 * sin(ribbon * 6.2831853), 5.0);
    colour = ramp(ribbon * 0.12 + palette) * (0.18 + crest * 0.7)
      + ramp(depth + palette + 0.5) * (features * featurePulse * 0.55 + halo * 0.3);
  } else if (params.mode < 7.5) {
    let lattice = fract(uv * vec2f(64.0, 48.0)) - 0.5;
    let dotLight = exp(-dot(lattice, lattice) * 70.0);
    let pulse = 0.5 + 0.5 * sin(depth * 32.0 - phase);
    colour = ramp(depth + palette) * (0.04 + dotLight * (0.2 + pulse * 0.75))
      + vec3f(0.15, 0.8, 1.0) * features * (0.35 + pulse * 0.4);
  } else if (params.mode < 8.5) {
    let plane = 0.5 + sin(phase * 0.16) * 0.48;
    let scan = exp(-pow((depth - plane) * 16.0, 2.0));
    let thermal = mix(vec3f(0.04, 0.03, 0.3), vec3f(1.0, 0.18, 0.025), smoothstep(0.1, 0.7, depth));
    colour = thermal * (0.4 + featurePulse * 0.25) + vec3f(1.0, 0.86, 0.2) * scan * (0.5 + features * 0.4);
  } else {
    return vec4f(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb * params.gain, 1.0);
  }
  // Window holes and concavities are independent of the depth model. Rim motion
  // follows their depth, and the existing downstream Mask clips the final light.
  let edge = surfaceEdge(uv);
  let chase = 0.85 + 0.15 * sin(6.2831853 * (depth * 1.4 - t));
  var edgeColour = ramp(depth * 0.7 + palette - t * 0.14);
  if (params.mode >= 1.5 && params.mode < 2.5) { edgeColour = vec3f(1.0, 0.5, 0.065); }
  if (params.mode >= 2.5 && params.mode < 3.5) { edgeColour = vec3f(0.05, 0.8, 1.0); }
  let boundary = edgeColour * max(params.edgeGlow, 0.0) * chase;
  colour = mix(colour, boundary, edge * clamp(params.edgeGlow, 0.0, 1.0));
  colour = clamp(colour, vec3f(0.0), vec3f(1.0));
  let photo = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let light = max(colour.r, max(colour.g, colour.b));
  let projected = mix(colour * params.lightColor, photo * light, clamp(params.photoAmount, 0.0, 1.0));
  return vec4f(projected * params.gain, 1.0);
}`;
