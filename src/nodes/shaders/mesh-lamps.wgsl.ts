import { wgsl } from "../../runtime/backend/wgsl.ts";

/**
 * T1424b — Mesh File In's LAMPS pass: every vertex's published emissive is the file's emissive
 * times the gain of its Lamps group (`lamp`, 1-based; 0 is no group, gain 1). Eight gains ride
 * two named vec4 rows. The gains are values, so a knob or an expression moves them every frame
 * with no rebuild; the file's own emissive is read, never overwritten.
 */
export const MESH_LAMPS_WGSL = wgsl`struct LampParams {
  count: u32,
  gainsA: vec4f,
  gainsB: vec4f,
};

@group(0) @binding(0) var<uniform> params: LampParams;
@group(0) @binding(2) var<storage, read> in_emissive: array<vec3f>;
@group(0) @binding(3) var<storage, read> in_lamp: array<f32>;
@group(0) @binding(4) var<storage, read_write> out_emissive: array<vec3f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  let lamp = u32(in_lamp[index] + 0.5);
  var gain = 1.0;
  if (lamp >= 1u && lamp <= 4u) {
    gain = params.gainsA[lamp - 1u];
  } else if (lamp >= 5u && lamp <= 8u) {
    gain = params.gainsB[lamp - 5u];
  }
  out_emissive[index] = in_emissive[index] * gain;
}`;
