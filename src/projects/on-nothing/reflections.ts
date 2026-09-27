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
  var hit = vec3f(-1.0);
  var travelled = 0.0;
  for (var i = 1u; i <= STEPS; i = i + 1u) {
    let travel = params.maxDistance * pow((f32(i) - 1.0 + jitter) / f32(STEPS), 2.0) + 0.05;
    let probe = project(v, p + r * travel);
    if (probe.z <= 0.0 || any(probe.xy < vec2f(0.0)) || any(probe.xy > vec2f(1.0))) { break; }
    let sceneZ = viewDepth(probe.xy);
    if (sceneZ > 0.0 && probe.z > sceneZ && probe.z - sceneZ < params.thickness + travel * 0.02) {
      var lo = previous;
      var hi = travel;
      for (var k = 0; k < 5; k = k + 1) {
        let mid = (lo + hi) * 0.5;
        let q = project(v, p + r * mid);
        let qz = viewDepth(q.xy);
        if (qz > 0.0 && q.z > qz) { hi = mid; } else { lo = mid; }
      }
      hit = project(v, p + r * hi);
      travelled = hi;
      break;
    }
    previous = travel;
  }
  if (hit.z <= 0.0) { return color; }
  let edge = smoothstep(0.0, 0.08, min(min(hit.x, 1.0 - hit.x), min(hit.y, 1.0 - hit.y)));
  // The glossy fetch: a 5 × 9 tent around the hit, its size from roughness × travel.
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let reach = params.blur * roughness * travelled / max(z, 0.5);
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
  let reflected = sum / weight;
  // A ray turning back toward the lens leaves what the frame knows: its "hit" is a false one
  // (it drew bright slabs on the floor). Fade reflections out as the ray turns toward the camera.
  let away = smoothstep(-0.05, 0.3, dot(r, v.forward));
  let amount = clamp(fresnel * gloss * edge * away * params.strength, 0.0, 1.0);
  return vec4f(color.rgb + reflected * amount, color.a);
}`;
