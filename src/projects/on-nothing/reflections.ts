import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, VIEW } from "../furnace/screen-space.ts";

/**
 * T1407b — GLOSSY screen-space reflections for the damp floor.
 *
 * The furnace's SSR returns a mirror: one ray, one sharp fetch. On a damp concrete floor
 * that reads as a puddle of glass. The reference's floor instead smears each headlight into
 * a long, soft VERTICAL streak — a rough dielectric seen at a grazing angle stretches its
 * highlight along the view direction. So: the same march for the mirror ray, then the fetch
 * at the hit is a blur whose size grows with roughness and with how far the ray travelled,
 * `stretch` times longer vertically than across. Deterministic (no per-frame noise), so a
 * clip does not shimmer without a temporal filter.
 *
 * T1412b — the SPECKLE on glossy clear coat at grazing angles (white flanks in the wheel and
 * tableau shots) had two causes, both a pixel disagreeing with its neighbours:
 *  - TUNNELLING. A hit was taken wherever a march step landed less than `thickness` behind
 *    the depth buffer, so a step that overshot a surface by more than that (late steps are
 *    long) marched on and hit something far behind it, while its neighbours, staggered by the
 *    jitter, hit the surface. Now a hit is a CROSSING — in front at the step before, behind at
 *    this one — refined by bisection, and judged at the refined point: how far behind the
 *    surface the ray still is (depth confidence) and whether the surface it met faces it
 *    (a ray meeting a surface edge-on, or from behind, is a guess). A crossing that fails is
 *    passed BEHIND, and the ray only counts a new one once it is in front again.
 *  - A SPARSE BLUR. The fetch's size was travel over the RECEIVER's depth, so a flank a metre
 *    from the lens stretched its 45 taps over most of the frame, tens of pixels apart, and
 *    each pixel's taps caught a different few lamps: one neighbour's lamp is another's black.
 *    The size is now the reflected cone's width where it lands, seen at the HIT's depth, and
 *    capped (`maxBlur`).
 * Then the FIREFLY CLAMP, which does most of the work (on the wheel shot the two fixes above
 * without it leave most of the speckle; it without the cap leaves a few dots):
 * the reflected luminance may not exceed the mean plus `clampSigma` standard deviations of
 * eight texels ringing the hit, two pixels out or half the fetch's reach, whichever is
 * wider. A lamp whose ring is lamp reflects whole; a thin glint, or a lamp that only one
 * stray tap of a wide fetch touched, does not.
 * All of it is a function of the pixel alone, so the --final render's sub-frames and 2x
 * supersampling average a stable picture rather than a different sparkle each time.
 * Inputs: Input = lit colour, More = [depth, normal] (normal.a carries roughness).
 */
export const GLOSSY_SSR_WGSL = `struct Params {
${CAMERA_PARAMS}
  strength: f32, // @default 1  Overall reflection strength.
  maxDistance: f32, // @default 30  Longest reflection ray, metres.
  thickness: f32, // @default 0.4  How thick a surface is assumed behind the depth buffer, metres.
  roughnessCutoff: f32, // @default 0.5  Surfaces rougher than this reflect nothing.
  blur: f32, // @default 0.9  Blur at the hit per unit roughness × travel, as a fraction of the frame height per metre.
  stretch: f32, // @default 3  How much longer the blur runs vertically than across.
  keepBright: f32, // @default 3  Radiance above which a reflection keeps full strength; dimmer things (car bodies) reflect only dimShare of it.
  dimShare: f32, // @default 0.15  Share of a dim reflection that shows: sealed concrete mirrors lamps, not paint.
  maxBlur: f32, // @default 0.1  Largest blur at the hit, as a fraction of the frame height (before stretch).
  clampSigma: f32, // @default 1  Firefly clamp: a reflection may be at most this many standard deviations above the mean of the texels ringing its hit.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;
${VIEW}
const STEPS: u32 = 48u;

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
  let gloss = 1.0 - smoothstep(0.02, params.roughnessCutoff, roughness);
  if (fresnel * gloss < 0.005) { return color; }
  // A fixed, per-pixel stagger of the march (no clock): no shimmer across frames.
  let jitter = ignHash(uv * frameU.resolution);
  var previous = 0.0;
  var wasFront = true;
  var hit = vec3f(-1.0);
  var travelled = 0.0;
  var confidence = 0.0;
  for (var i = 1u; i <= STEPS; i = i + 1u) {
    let travel = params.maxDistance * pow((f32(i) - 1.0 + jitter) / f32(STEPS), 2.0) + 0.05;
    let probe = project(v, p + r * travel);
    if (probe.z <= 0.0 || any(probe.xy < vec2f(0.0)) || any(probe.xy > vec2f(1.0))) { break; }
    let sceneZ = viewDepth(probe.xy);
    let behind = sceneZ > 0.0 && probe.z > sceneZ;
    if (behind && wasFront) {
      // A crossing: bisect back to where the ray meets the surface.
      var lo = previous;
      var hi = travel;
      for (var k = 0; k < 7; k = k + 1) {
        let mid = (lo + hi) * 0.5;
        let q = project(v, p + r * mid);
        let qz = viewDepth(q.xy);
        if (qz > 0.0 && q.z > qz) { hi = mid; } else { lo = mid; }
      }
      let q = project(v, p + r * hi);
      // Depth confidence: on a surface the refined point sits just behind it; past the edge
      // of something nearer, it is still far behind (the ray went behind it, not into it).
      let tolerance = params.thickness + hi * 0.02;
      let depthOk = 1.0 - smoothstep(0.5 * tolerance, tolerance, q.z - viewDepth(q.xy));
      // Facing: a surface met edge-on or from behind is no reliable hit.
      let hn = textureLoad(inputTexture2, depthTexel(q.xy), 0).rgb * 2.0 - 1.0;
      let facing = smoothstep(0.02, 0.2, dot(normalize(hn + vec3f(1e-6)), -r));
      if (depthOk * facing > 0.0) {
        hit = q;
        travelled = hi;
        confidence = depthOk * facing;
        break;
      }
    }
    wasFront = !behind;
    previous = travel;
  }
  if (hit.z <= 0.0) { return color; }
  let edge = smoothstep(0.0, 0.08, min(min(hit.x, 1.0 - hit.x), min(hit.y, 1.0 - hit.y)));
  // The glossy fetch: a 5 × 9 tent around the hit, its size from roughness × travel — the
  // width of the reflected cone where it lands, seen from the camera at the HIT's depth.
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let reach = min(params.blur * roughness * travelled / max(hit.z, 0.5), params.maxBlur);
  let span = vec2f(reach / aspect, reach * params.stretch);
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var j = -4; j <= 4; j = j + 1) {
    for (var i2 = -2; i2 <= 2; i2 = i2 + 1) {
      let o = vec2f(f32(i2) / 2.0, f32(j) / 4.0);
      let w = (1.0 - abs(o.x) * 0.6) * (1.0 - abs(o.y) * 0.8);
      let at = clamp(hit.xy + o * span, vec2f(0.0), vec2f(1.0));
      sum = sum + textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb * w;
      weight = weight + w;
    }
  }
  var reflected = sum / weight;
  // The firefly clamp: the eight texels ringing the hit, two pixels out (or the tent's own
  // unstretched half-reach, when that is wider), bound how much brighter than its surroundings the
  // reflection may be.
  let luma = vec3f(0.2126, 0.7152, 0.0722);
  let ring = max(2.0 / frameU.resolution.y, 0.5 * reach);
  var mean = 0.0;
  var square = 0.0;
  for (var k = 0; k < 8; k = k + 1) {
    let a = f32(k) * 0.7853982;
    let at = clamp(hit.xy + vec2f(cos(a) / aspect, sin(a)) * ring, vec2f(0.0), vec2f(1.0));
    let l = dot(textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb, luma);
    mean = mean + l;
    square = square + l * l;
  }
  mean = mean / 8.0;
  let ceiling = mean + params.clampSigma * sqrt(max(square / 8.0 - mean * mean, 0.0));
  let rl0 = dot(reflected, luma);
  reflected = reflected * min(1.0, ceiling / max(rl0, 1e-6));
  let rl = dot(reflected, luma);
  reflected = reflected * mix(params.dimShare, 1.0, smoothstep(params.keepBright * 0.3, params.keepBright, rl));
  // A ray turning back toward the lens leaves what the frame knows: its "hit" is a false one
  // (it drew bright slabs on the floor). Fade reflections out as the ray turns toward the camera.
  let away = smoothstep(-0.05, 0.3, dot(r, v.forward));
  let amount = clamp(fresnel * gloss * edge * away * confidence * params.strength, 0.0, 1.0);
  return vec4f(color.rgb + reflected * amount, color.a);
}`;
