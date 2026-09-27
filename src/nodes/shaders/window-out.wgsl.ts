import type { SinkDisplayTransform } from "../../domain/color/display.ts";
import { SRGB_TRANSFER_WGSL, TONE_MAP_WGSL } from "../../domain/color/display.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";

/**
 * Window Out's fragment shader (§T1391b) — Output's display transform, plus the FIT.
 *
 * A perform window is a fixed W×H surface and its input has its own aspect, so the node
 * decides where the picture lands in its target: `fit` letterboxes (the whole input,
 * black bars), `fill` crops (no bars, edges cut), `stretch` maps corner to corner. It is
 * done HERE rather than in the presentation blit because the blit is a raw copy (§V70a)
 * and the target is what an export or a screenshot of the window reads.
 *
 * `params.mode`: 0 fit, 1 fill, 2 stretch. `params.targetAspect` is the target's
 * width / height; the input's aspect comes from the texture itself. Outside the picture
 * the target is OPAQUE black — a perform surface has nothing behind it to show through.
 *
 * The display half is `outputDisplayShader`'s decision restated for a remapped sample:
 * the curve on linear light, then the encode, alpha clamped at a display sink (T678).
 */
export function windowOutShader(transform: SinkDisplayTransform): EmittedWgsl {
  const curve =
    transform.toneMap === "none" ? "source.rgb" : `${transform.toneMap === "filmic" ? "tonemapFilmic" : "tonemapReinhard"}(source.rgb)`;
  const shown = transform.encode ? `encodeDisplay(${curve})` : curve;
  const alpha = transform.clampAlpha ? "clamp(source.a, 0.0, 1.0)" : "source.a";
  return wgsl`struct Params {
  mode: f32,
  targetAspect: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
${transform.toneMap === "none" ? "" : `\n${TONE_MAP_WGSL}\n`}${transform.encode ? `\n${SRGB_TRANSFER_WGSL}\n` : ""}
fn placed(uv: vec2f) -> vec2f {
  let size = vec2f(textureDimensions(inputTexture));
  let inputAspect = size.x / max(size.y, 1.0);
  let ratio = params.targetAspect / max(inputAspect, 1e-6);
  let centred = uv - vec2f(0.5);
  if (params.mode < 0.5) {
    // fit: the whole input, scaled down along the axis where it is too wide or too tall.
    if (ratio < 1.0) { return vec2f(uv.x, centred.y / ratio + 0.5); }
    return vec2f(centred.x * ratio + 0.5, uv.y);
  }
  if (params.mode < 1.5) {
    // fill: the input covers the target; the overhang is cropped.
    if (ratio < 1.0) { return vec2f(centred.x * ratio + 0.5, uv.y); }
    return vec2f(uv.x, centred.y / ratio + 0.5);
  }
  return uv;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let at = placed(uv);
  if (any(at < vec2f(0.0)) || any(at > vec2f(1.0))) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let source = textureSampleLevel(inputTexture, inputSampler, at, 0.0);
  return vec4f(${shown}, ${alpha});
}`;
}
