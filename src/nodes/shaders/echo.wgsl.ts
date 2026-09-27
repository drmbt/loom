import { wgsl } from "../../runtime/backend/wgsl.ts";

/**
 * Echo — the picture laid over its OWN past output (T1402b), promoted from the On Nothing
 * project's ECHO pass, which needed a Feedback node wired back into it.
 *
 * The node owns its history as a ring (Cache's resource, §V226): this pass reads the
 * echo's output from `delay` frames ago out of the ring, and the node's second pass
 * archives this frame's output into it. So the trail is recursive — each echo carries the
 * ones before it, fading by `amount` per step.
 *
 *   blended = mix(now, past, amount)
 *   out     = mix(blended, min(now, blended), darken)
 *
 * `darken` 1 keeps only what darkens the present: a dark shape moving over white leaves a
 * dark smear while the shape itself stays as dark as it is.
 *
 * The tap arithmetic is `CACHE_READ_WGSL`'s verbatim (§V229): while the ring fills, the
 * deepest written layer stands in for a deeper tap, and with nothing archived yet (frame 0,
 * or the first frame after a reset) the past IS the present, so the output is the input.
 */
export const ECHO_WGSL = wgsl`struct Params {
  amount: f32,
  darken: f32,
  tap: f32,
  ringLatest: f32,
  ringWritten: f32,
  ringFrames: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var ringTexture: texture_2d_array<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let now = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  var past = now;
  if (params.ringWritten >= 0.5) {
    let frames = max(params.ringFrames, 1.0);
    let back = clamp(params.tap, 1.0, max(params.ringWritten, 1.0));
    let layer = i32(round(params.ringLatest - (back - 1.0) + frames * 2.0)) % i32(frames);
    past = textureSampleLevel(ringTexture, inputSampler, uv, layer, 0.0);
  }
  let blended = mix(now, past, params.amount);
  let darker = min(now, blended);
  return mix(blended, darker, params.darken);
}`;
