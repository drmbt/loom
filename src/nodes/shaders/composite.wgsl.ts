import { WGSL_CHANNEL } from "./common.wgsl.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";

/**
 * Fragment shaders for the compositing family: Over, Add, Multiply, Screen, Difference,
 * and Mask (T40).
 *
 * ALPHA CONVENTION, decided once for the whole catalogue: STRAIGHT (non-premultiplied)
 * alpha. Colour channels carry colour, alpha carries coverage, and the two are combined
 * only when compositing. TouchDesigner makes the same choice, and offers the conversion
 * as an operation on its Math TOP ("Multiply RGB by Alpha" / "Divide RGB by Alpha") rather
 * than as the default. (An earlier version of this note cited a "Premultiply TOP", which
 * a survey of all 149 TOPs found does not exist — §V186. Our equivalent is the Premultiply
 * node, T281.) Every node in this catalogue that writes alpha writes it straight.
 *
 * ONE DECLARED EXCEPTION, and it is opt-in: Mask's `apply: "colour"` (B189) multiplies rgb
 * by the coverage as well, which is premultiplied output by definition. It exists because
 * straight alpha has a cost the convention does not mention — a carve that lives only in
 * alpha is INVISIBLE to every consumer that reads rgb, which is every preview in this app
 * and most kernels — and a DepthCut shipped for two task rows looking exactly like its own
 * input because of it. The default is still straight, so the convention above holds for
 * every node and every existing document; this is a switch a user throws when the thing
 * downstream reads colour, not a drift.
 *
 * COLOUR (§V56): all six operate on LINEAR working-space values. Adding or multiplying
 * encoded values would give a different (and wrong) picture, which is the practical reason
 * the working space is linear in the first place.
 */

/**
 * Builds one blend node's shader from the expression that combines two pixels (T226).
 *
 * A factory rather than hand-written copies: the operators differ by one line, and the
 * parts they share — binding layout, opacity handling, the alpha rule, the FOLD — are
 * exactly the parts that must not drift between them. The generated text still differs per
 * operator and per layer count, so each keeps its own pass signature and nothing branches
 * at runtime.
 *
 * `blend` names a row of `BLEND_PIXELS`: a WGSL expression over `front` and `back` (both
 * `vec4f`, straight alpha) producing the result `vec4f`. It becomes the body of
 * `blendPixel`, which the fold calls once per layer — so there is still ONE definition of
 * what "multiply" means (§V140) no matter how many inputs are wired.
 *
 * THE FOLD IS LEFT TO RIGHT WITH THE FIRST INPUT IN FRONT:
 *
 *     acc = front                    (input 1, scaled by opacity)
 *     acc = blendPixel(acc, layer0)  (input 2)
 *     acc = blendPixel(acc, layer1)  (input 3)
 *
 * so `over` reads "input 1 over input 2 over input 3", the first input nearest the viewer.
 * That is not a coin flip between two equally good readings: it is the only direction under
 * which every existing two-input graph keeps rendering exactly what it rendered before,
 * because it degenerates to `blendPixel(front, back)` at one layer. It also matters for
 * more than Over — `difference` is not associative, so a fold that ran right to left would
 * produce a different picture from the same wiring.
 *
 * `opacity` scales the FRONT and nothing else, unchanged from the two-input version: it is
 * the layer you are placing, not the stack you are placing it on.
 */
export function blendFragmentWgsl(blend: BlendType, layers = 1): EmittedWgsl {
  const count = Math.max(1, Math.floor(layers));
  const declarations = Array.from(
    { length: count },
    (_, index) => `@group(0) @binding(${index + 3}) var backTexture${index}: texture_2d<f32>;`,
  ).join("\n");
  const fold = Array.from(
    { length: count },
    (_, index) =>
      `  acc = blendPixel(acc, textureSampleLevel(backTexture${index}, inputSampler, uv, 0.0));`,
  ).join("\n");

  return wgsl`${blendPixelWgsl(blend)}

struct Params {
  opacity: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var frontTexture: texture_2d<f32>;
${declarations}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var acc = textureSampleLevel(frontTexture, inputSampler, uv, 0.0) * clamp(params.opacity, 0.0, 1.0);
${fold}
  return acc;
}`;
}

/**
 * The Porter-Duff family, as ONE function and a pair of coverage weights (T282).
 *
 * Every compositing operator in the algebra is the same weighted sum of premultiplied
 * colour — `Ap*fa + Bp*fb` — and differs only in what `fa` and `fb` are. Writing six
 * shaders would be writing the same three lines six times and inviting exactly the drift
 * §V140 exists to prevent; writing the weights down instead makes the whole family a table.
 *
 *   over     fa = 1        fb = 1 - a.a     the default: A on top of B
 *   under    fa = 1 - b.a  fb = 1           B on top of A (Porter-Duff "dst-over")
 *   inside   fa = b.a      fb = 0           A, clipped to where B is opaque ("src-in")
 *   outside  fa = 1 - b.a  fb = 0           A, only where B is NOT ("src-out")
 *   atop     fa = b.a      fb = 1 - a.a     A over B but confined to B's shape
 *   xor      fa = 1 - b.a  fb = 1 - a.a     each where the other is not
 *
 * The division at the end is what STRAIGHT alpha costs: the sum is premultiplied, so it
 * has to be divided back out. Guarded against a fully transparent result, where the colour
 * is arbitrary anyway.
 */
const PORTER_DUFF_WGSL = `fn porterDuff(front: vec4f, back: vec4f, fa: f32, fb: f32) -> vec4f {
  let outAlpha = (front.a * fa) + (back.a * fb);
  let rgb = ((front.rgb * front.a) * fa) + ((back.rgb * back.a) * fb);
  return vec4f(rgb / max(outAlpha, 1e-6), outAlpha);
}`;

/** One Porter-Duff operator, as the call its coverage weights make. */
function porterDuffPixel(fa: string, fb: string): { readonly expression: string; readonly porterDuff: boolean } {
  return { expression: `porterDuff(front, back, ${fa}, ${fb})`, porterDuff: true };
}

/** One arithmetic operator: an expression over `front` and `back` that needs no helper. */
function arithmeticPixel(expression: string): { readonly expression: string; readonly porterDuff: boolean } {
  return { expression, porterDuff: false };
}

/**
 * Every blend the family ships, as the expression that combines two pixels (T226, §V140).
 *
 * A table of expressions rather than of finished shaders: the shader text depends on how
 * many inputs are wired, and the alternative — building all ten at every count up front —
 * would generate text nobody asks for. The KEYS are the operation names saved in
 * documents, so this map is also the list of what `operation` may legally say.
 */
const BLEND_PIXELS = {
  over: porterDuffPixel("1.0", "1.0 - front.a"),
  under: porterDuffPixel("1.0 - back.a", "1.0"),
  inside: porterDuffPixel("back.a", "0.0"),
  outside: porterDuffPixel("1.0 - back.a", "0.0"),
  atop: porterDuffPixel("back.a", "1.0 - front.a"),
  xor: porterDuffPixel("1.0 - back.a", "1.0 - front.a"),
  // The arithmetic operators work per channel across RGBA, as TD's Composite TOP does —
  // adding two images adds their alpha too. Only the Porter-Duff set is coverage-aware.
  add: arithmeticPixel(`front + back`),
  multiply: arithmeticPixel(`front * back`),
  screen: arithmeticPixel(`vec4f(1.0) - ((vec4f(1.0) - front) * (vec4f(1.0) - back))`),
  difference: arithmeticPixel(`abs(front - back)`),
} as const;

export type BlendType = keyof typeof BLEND_PIXELS;

export function isBlendType(value: unknown): value is BlendType {
  return typeof value === "string" && value in BLEND_PIXELS;
}

/**
 * `blendPixel(front, back)` for one operation, after the Porter-Duff helper when the
 * operation calls it — the ONE definition of what that operation means (§V140).
 *
 * Exported for Layer (T1498b), which applies the same pixel differently — mixed over the
 * stack below by its opacity — and must not grow a second copy of what "screen" means.
 */
export function blendPixelWgsl(blend: BlendType): string {
  const { expression, porterDuff } = BLEND_PIXELS[blend];
  const pixel = `fn blendPixel(front: vec4f, back: vec4f) -> vec4f {
  return ${expression};
}`;
  return porterDuff ? `${PORTER_DUFF_WGSL}\n\n${pixel}` : pixel;
}

/** The shader for one operation folding `layers` inputs behind the front one. */
export function blendShaderFor(blend: BlendType, layers: number): EmittedWgsl {
  return blendFragmentWgsl(blend, layers);
}

/**
 * Cross — dissolve between two inputs by a factor (T234). TD's Cross TOP.
 *
 * Deliberately NOT one of the Composite operations. Every entry in that menu is a fixed
 * function of two pixels; Cross is a function of two pixels AND a parameter, and that
 * parameter is the entire point — it is the thing you animate to dissolve between two
 * chains. Putting it in the menu would give it a control the other operations do not have
 * and hide the one thing it is for.
 *
 * `cross` is 0 at input 1 and 1 at input 2, matching TD. A straight `mix` across RGBA is
 * right here even though the arithmetic operators are per-channel by convention: a
 * dissolve interpolates coverage as well as colour, so a transparent image crossing into
 * an opaque one becomes progressively more opaque.
 */
export const CROSS_FRAGMENT_WGSL = wgsl`struct Params {
  cross: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var frontTexture: texture_2d<f32>;
@group(0) @binding(3) var backTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let a = textureSampleLevel(frontTexture, inputSampler, uv, 0.0);
  let b = textureSampleLevel(backTexture, inputSampler, uv, 0.0);
  return mix(a, b, clamp(params.cross, 0.0, 1.0));
}`;

/**
 * Mask — multiply an image's coverage by a mask channel.
 *
 * The mask input is DATA: a coverage value, not light. It is read from one channel and
 * multiplies alpha — with straight alpha that is exactly what "mask" means, and it keeps
 * the colour valid where coverage is partial.
 *
 * B189 — AND WHETHER IT TOUCHES COLOUR IS NOW A MODE, because "keeps the colour valid"
 * has a cost nobody had priced. Alpha-only is right when a Porter-Duff operator will
 * read that alpha downstream and divide the premultiply back out (which is this app's
 * stated convention — see `PORTER_DUFF_WGSL` above). It is WRONG when the consumer reads
 * colour: every RGB view in the editor, and any kernel or shader sampling rgb. In that
 * case the carve is arithmetically perfect and completely invisible, which is how a
 * DepthCut shipped for two task-rows looking exactly like its own input.
 *
 * Two shaders, not a branch on a uniform (§V141, `output.toneMap`'s precedent): the mode
 * changes approximately never, and `alpha` keeps the text it has always had so upgrading
 * moves no existing project's pixels OR its structural key.
 */
// r32float cannot use a filtering sampler on the baseline WebGPU tier. Interpolate
// explicitly with the same pixel centres and clamp-to-edge addressing as the sampler.
const MASK_UNFILTERED_SAMPLE = `fn maskField(uv: vec2f) -> vec4f {
  let dimensions = vec2i(textureDimensions(maskTexture));
  let coordinate = uv * vec2f(dimensions) - vec2f(0.5);
  let lower = vec2i(floor(coordinate));
  let fraction = fract(coordinate);
  let maximum = dimensions - vec2i(1);
  let a = textureLoad(maskTexture, clamp(lower, vec2i(0), maximum), 0);
  let b = textureLoad(maskTexture, clamp(lower + vec2i(1, 0), vec2i(0), maximum), 0);
  let c = textureLoad(maskTexture, clamp(lower + vec2i(0, 1), vec2i(0), maximum), 0);
  let d = textureLoad(maskTexture, clamp(lower + vec2i(1, 1), vec2i(0), maximum), 0);
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}`;

const maskShader = (carveColour: boolean, unfiltered = false) => wgsl`${WGSL_CHANNEL}

struct Params {
  channel: f32,
  invert: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var maskTexture: texture_2d<f32>;
${unfiltered ? `${MASK_UNFILTERED_SAMPLE}\n` : ""}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let field = ${unfiltered ? "maskField(uv)" : "textureSampleLevel(maskTexture, inputSampler, uv, 0.0)"};
  let raw = clamp(channelValue(field, params.channel), 0.0, 1.0);
  let coverage = mix(raw, 1.0 - raw, clamp(params.invert, 0.0, 1.0));
  return vec4f(source.rgb${carveColour ? " * coverage" : ""}, source.a * coverage);
}`;

/** Coverage into alpha alone — the straight-alpha reading, and the shipped default. */
export const MASK_FRAGMENT_WGSL = maskShader(false);

/** Coverage into colour AND alpha — a carve you can see in an RGB view (B189). */
export const MASK_COLOUR_FRAGMENT_WGSL = maskShader(true);

const MASK_FLOAT_FRAGMENT_WGSL = maskShader(false, true);
const MASK_FLOAT_COLOUR_FRAGMENT_WGSL = maskShader(true, true);

/** The two modes, as the parameter spells them. */
export const MASK_APPLY_OPTIONS = [
  { value: "alpha", label: "Alpha only" },
  { value: "colour", label: "Colour and alpha" },
] as const;

export type MaskApply = (typeof MASK_APPLY_OPTIONS)[number]["value"];

export function isMaskApply(value: unknown): value is MaskApply {
  return MASK_APPLY_OPTIONS.some((option) => option.value === value);
}

export function maskShaderFor(apply: MaskApply, unfiltered = false): EmittedWgsl {
  if (unfiltered) return apply === "colour" ? MASK_FLOAT_COLOUR_FRAGMENT_WGSL : MASK_FLOAT_FRAGMENT_WGSL;
  return apply === "colour" ? MASK_COLOUR_FRAGMENT_WGSL : MASK_FRAGMENT_WGSL;
}
