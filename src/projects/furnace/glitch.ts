import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1354b — the GLITCH LAYER: the picture breaking in the ways industrial IDM breaks sound.
 *
 * One Custom WGSL · Multi pass over the graded frame, with its own PREVIOUS output (a
 * Feedback of itself) and the depth buffer. Every effect is an intensity the director
 * drives, and every random choice is a hash of the block and a stepped clock, so a render
 * reproduces exactly:
 *
 *  - mosh    datamosh: blocks keep LAST frame's picture, dragged along the camera's motion
 *            (reprojected from depth, the motion blur's arithmetic) — on a cut, the old shot
 *            smears into the new one like a dropped I-frame;
 *  - tear    horizontal block rows jump sideways;
 *  - split   the colour channels pull apart;
 *  - sort    bright pixels smear downward past a threshold, pixel-sort style;
 *  - crush   macroblocks and posterised colour, a codec starved of bits;
 *  - freeze  the whole frame stutters on the previous one.
 * Inputs: Input = graded frame, More = [previous output (Feedback), Depth].
 */
export const GLITCH_WGSL = `struct Params {
  eye: vec3f, // @default 0  Camera position (drive from the camera).
  aim: vec3f, // @default 0  Camera look-at (drive from the camera).
  fov: f32, // @default 50  Camera vertical field of view, degrees.
  far: f32, // @default 400  Camera far plane.
  prevEye: vec3f, // @default 0  The camera's position one frame ago.
  prevAim: vec3f, // @default 0  The camera's look-at one frame ago.
  prevFov: f32, // @default 50  The camera's fov one frame ago.
  mosh: f32, // @default 0  Datamosh: share of blocks that keep the moving previous frame.
  tear: f32, // @default 0  Horizontal block-row displacement.
  split: f32, // @default 0  Colour channel separation.
  sort: f32, // @default 0  Downward smear of bright pixels.
  crush: f32, // @default 0  Macroblocking and posterisation.
  freeze: f32, // @default 0  Above 0.5, the frame holds the previous one.
  rate: f32, // @default 12  How many times a second the block pattern re-rolls.
};

${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;

fn glitchHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn previousAt(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(inputTexture1));
  return textureLoad(inputTexture1, clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1)), 0).rgb;
}

fn viewDepth(uv: vec2f) -> f32 {
  let size = vec2f(textureDimensions(inputTexture2));
  let d = textureLoad(inputTexture2, clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1)), 0).r;
  return select(d * params.far, params.far * 0.5, d >= 0.9999 || d <= 0.0);
}

fn basisOf(eye: vec3f, aim: vec3f) -> mat3x3f {
  let forward = normalize(aim - eye);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  return mat3x3f(right, cross(right, forward), forward);
}

// Screen motion of the surface at uv between the previous camera and this one.
fn cameraMotion(uv: vec2f) -> vec2f {
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let now = basisOf(params.eye, params.aim);
  let tanNow = tan(radians(params.fov) * 0.5);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let ray = normalize(now[2] + now[0] * ndc.x * tanNow * aspect + now[1] * ndc.y * tanNow);
  let world = params.eye + ray * (viewDepth(uv) / max(dot(ray, now[2]), 1e-3));
  let before = basisOf(params.prevEye, params.prevAim);
  let tanBefore = tan(radians(params.prevFov) * 0.5);
  let rel = world - params.prevEye;
  let z = max(dot(rel, before[2]), 1e-3);
  let previous = vec2f(dot(rel, before[0]) / (z * tanBefore * aspect) * 0.5 + 0.5, 0.5 - dot(rel, before[1]) / (z * tanBefore) * 0.5);
  return uv - previous;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = frameU.resolution;
  let step = floor(frameU.absTime * params.rate);
  if (params.freeze > 0.5) { return vec4f(previousAt(uv), 1.0); }

  // Tear: rows of blocks slide sideways, a new pattern each step.
  var p = uv;
  let row = floor(uv.y * res.y / 24.0);
  let rowRoll = glitchHash(vec3f(row, step, 3.0));
  if (rowRoll < params.tear * 0.35) {
    p.x = fract(p.x + (glitchHash(vec3f(row, step, 7.0)) - 0.5) * 0.25 * params.tear);
  }

  // Crush: sample at block centres (macroblocks) where the codec starved.
  let blockSize = mix(4.0, 32.0, glitchHash(vec3f(floor(uv * res / 32.0), step)));
  let block = floor(p * res / blockSize);
  let starved = glitchHash(vec3f(block, step + 11.0)) < params.crush * 0.5;
  if (starved) { p = (block + 0.5) * blockSize / res; }

  // Split: channels pulled apart along a hashed direction.
  let angle = glitchHash(vec3f(step, 1.0, 2.0)) * 6.2831853;
  let offset = vec2f(cos(angle), sin(angle)) * params.split * 0.02;
  var color = vec3f(
    textureSampleLevel(inputTexture, inputSampler, p + offset, 0.0).r,
    textureSampleLevel(inputTexture, inputSampler, p, 0.0).g,
    textureSampleLevel(inputTexture, inputSampler, p - offset, 0.0).b,
  );
  if (starved) { color = floor(color * 6.0) / 6.0; }

  // Sort: bright pixels drag down into the pixels below them.
  if (params.sort > 0.0) {
    var brightest = color;
    for (var i = 1; i <= 12; i = i + 1) {
      let above = textureSampleLevel(inputTexture, inputSampler, p - vec2f(0.0, f32(i) * 3.0 / res.y), 0.0).rgb;
      let lum = dot(above, vec3f(0.2126, 0.7152, 0.0722));
      if (lum > 1.0 - params.sort * 0.6) { brightest = max(brightest, above * (1.0 - f32(i) / 14.0)); }
    }
    color = mix(color, brightest, clamp(params.sort, 0.0, 1.0));
  }

  // Mosh: whole macroblocks keep LAST frame, moved along this frame's camera motion.
  let moshBlock = floor(uv * res / 16.0);
  if (glitchHash(vec3f(moshBlock, floor(frameU.absTime * 4.0))) < params.mosh) {
    let motion = cameraMotion((moshBlock + 0.5) * 16.0 / res);
    color = previousAt(uv - motion * 1.5);
  }
  return vec4f(color, 1.0);
}`;
