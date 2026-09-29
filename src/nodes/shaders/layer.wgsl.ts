import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { blendPixelWgsl } from "./composite.wgsl.ts";

/** The Layer's blends, in menu order — the four it shares with Composite, plus Replace. */
export const LAYER_BLENDS = ["over", "add", "screen", "multiply", "replace"] as const;

export type LayerBlend = (typeof LAYER_BLENDS)[number];

export function isLayerBlend(value: unknown): value is LayerBlend {
  return LAYER_BLENDS.some((blend) => blend === value);
}

/**
 * Layer's fragment shader (T1498b): the picture blended onto the stack below, and the
 * result MIXED over the stack below by opacity.
 *
 *     out = mix(below, blendPixel(picture, below), opacity)
 *
 * WHY A MIX AND NOT COMPOSITE'S OPACITY. Composite's opacity scales the FRONT before the
 * blend (`composite.wgsl.ts`), which is right for a compositing node and wrong for a layer's
 * fade: a Multiply layer faded to 0 would multiply the stack by black. A layer's opacity is
 * the performer's fader, so at 0 it must show the stack below unchanged in EVERY mode, and
 * `mix(below, x, 0)` is exactly `below`. For Over on an opaque stack the two readings are
 * the same algebra: scaling the picture's coverage by o and mixing the full Over by o both
 * give `below + o·picture.a·(picture.rgb − below.rgb)`.
 *
 * The blend maths itself is Composite's (§V140): `blendPixelWgsl` is the one definition of
 * what Over, Add, Screen and Multiply mean. Replace is not a composite operation — it is the
 * picture itself, so the mix makes opacity the wet/dry of an FX layer (the design's §7.4).
 *
 * One shader per blend, chosen at compile time (§V141): the blend changes approximately
 * never, and opacity is the uniform that moves.
 */
export function layerShader(blend: LayerBlend): EmittedWgsl {
  const pixel =
    blend === "replace"
      ? `fn blendPixel(front: vec4f, back: vec4f) -> vec4f {
  return front;
}`
      : blendPixelWgsl(blend);
  return wgsl`${pixel}

struct Params {
  opacity: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var belowTexture: texture_2d<f32>;
@group(0) @binding(3) var pictureTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let below = textureSampleLevel(belowTexture, inputSampler, uv, 0.0);
  let picture = textureSampleLevel(pictureTexture, inputSampler, uv, 0.0);
  return mix(below, blendPixel(picture, below), clamp(params.opacity, 0.0, 1.0));
}`;
}
