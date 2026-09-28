import { wgsl } from "../../runtime/backend/wgsl.ts";

/**
 * T1410b — Mesh File In's CLIP pass: every vertex posed by the chosen animation at the frame
 * clock. The pose table (`glb.ts` `DecodedPose`) holds each joint's delta — animated world ×
 * rest world⁻¹ — as three vec4 rows per joint per baked frame; the vertex, placed at rest by
 * the decoder, is Σ weight × delta · rest, the two baked frames either side of the clock
 * blended linearly (exact on a baked frame). A vertex no joint weighs stays where it is.
 *
 * The clock is `absTimeSeconds` — the absolute clock the backend writes into every dispatch
 * block that declares it (`dispatchFrameUniforms`; it does not lap with a timeline loop) —
 * × Speed + Offset; with Loop on it wraps over the baked span, (frames − 1) ÷ rate, else it
 * holds the last pose.
 */
export const MESH_CLIP_WGSL = wgsl`struct ClipParams {
  count: u32,
  joints: u32,
  frames: u32,
  looping: u32,
  rate: f32,
  speed: f32,
  offset: f32,
  absTimeSeconds: f32,
};

@group(0) @binding(0) var<uniform> params: ClipParams;
@group(0) @binding(2) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(3) var<storage, read> in_normal: array<vec3f>;
@group(0) @binding(4) var<storage, read> in_joints: array<vec4f>;
@group(0) @binding(5) var<storage, read> in_weights: array<vec4f>;
@group(0) @binding(6) var<storage, read> pose: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> out_position: array<vec3f>;
@group(0) @binding(8) var<storage, read_write> out_normal: array<vec3f>;

fn poseRow(frame: u32, joint: u32, row: u32) -> vec4f {
  return pose[(frame * params.joints + joint) * 3u + row];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  let last = f32(max(params.frames, 1u) - 1u);
  var at = (params.absTimeSeconds * params.speed + params.offset) * params.rate;
  if (params.looping == 1u && last > 0.0) {
    at = at - floor(at / last) * last;
  }
  at = clamp(at, 0.0, last);
  let f0 = u32(floor(at));
  let f1 = min(f0 + 1u, u32(last));
  let u = at - floor(at);
  let p = vec4f(in_position[index], 1.0);
  let n = in_normal[index];
  let joints = in_joints[index];
  let weights = in_weights[index];
  var posed = vec3f(0.0);
  var bent = vec3f(0.0);
  var total = 0.0;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let w = weights[k];
    if (w <= 0.0) { continue; }
    let joint = min(u32(joints[k] + 0.5), params.joints - 1u);
    let r0 = mix(poseRow(f0, joint, 0u), poseRow(f1, joint, 0u), u);
    let r1 = mix(poseRow(f0, joint, 1u), poseRow(f1, joint, 1u), u);
    let r2 = mix(poseRow(f0, joint, 2u), poseRow(f1, joint, 2u), u);
    posed = posed + w * vec3f(dot(r0, p), dot(r1, p), dot(r2, p));
    bent = bent + w * vec3f(dot(r0.xyz, n), dot(r1.xyz, n), dot(r2.xyz, n));
    total = total + w;
  }
  if (total <= 0.0) {
    out_position[index] = p.xyz;
    out_normal[index] = n;
    return;
  }
  out_position[index] = posed / total;
  out_normal[index] = normalize(bent);
}`;
