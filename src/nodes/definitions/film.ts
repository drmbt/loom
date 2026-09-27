import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readNumber } from "./parameter-readers.ts";
import { CRT_WGSL, FILM_GRADE_WGSL } from "../shaders/film.wgsl.ts";

/**
 * The FINISHING family: Film Grade and CRT (T1402b).
 *
 * Promoted from the On Nothing project's GRADE and CRT passes (T1400b,
 * `src/projects/on-nothing/fx.ts`), knob for knob, with the project's values as the
 * defaults — dropping either node gives the look it was built for, and the project's own
 * per-shot overrides carry across unchanged. Both bind the shared frame block for their
 * per-frame noise, so both count as time-dependent to the idle skip, as Noise does.
 */

/**
 * Film Grade — a filmic look in one pass: exposure, a Hable shoulder, desaturation that
 * spares saturated warm sources, bleach bypass, contrast, the black crush, a split tint and
 * grain (T1402b).
 *
 * IT TONE MAPS. The output is linear display light in 0..1, so it belongs last before an
 * Output whose Tone map is `none`; a second curve there would compress it twice.
 */
export const filmGradeNode: NodeDefinition = {
  type: "filmGrade",
  version: 1,
  title: "Film Grade",
  category: "color",
  description:
    "Tone maps HDR with a filmic shoulder, then crushes blacks, desaturates, bleaches, split-tints and adds grain; set the Output's tone map to none.",
  tags: ["grade", "film", "tone map", "bleach bypass", "grain", "look", "color"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE, description: "Scene-linear HDR." }],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description: "Linear display light, 0..1, already tone mapped.",
    },
  ],
  parameters: {
    exposure: {
      type: "number",
      label: "Exposure",
      default: 0,
      min: -10,
      max: 10,
      range: "soft",
      description: "Stops of gain before the curve.",
    },
    black: {
      type: "number",
      label: "Black Crush",
      default: 0.035,
      min: 0,
      max: 0.5,
      range: "floor",
      group: "Tone",
      description: "Display level crushed to pure black.",
    },
    contrast: {
      type: "number",
      label: "Contrast",
      default: 1.25,
      min: 0,
      max: 4,
      range: "floor",
      group: "Tone",
      description: "Slope of the S-curve around mid-grey.",
    },
    lift: {
      type: "number",
      label: "Lift",
      default: 0,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Tone",
      description: "Raises the floor toward white, like an overexposed backdrop.",
    },
    saturation: {
      type: "number",
      label: "Saturation",
      default: 0.28,
      min: 0,
      max: 2,
      range: "floor",
      group: "Colour",
      description: "Chroma kept everywhere: 1 keeps it all, 0 is monochrome.",
    },
    keepWarm: {
      type: "number",
      label: "Keep Warm",
      default: 0.5,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Colour",
      description: "Chroma kept on strongly saturated warm sources, so a flare stays orange in a grey grade.",
    },
    bleach: {
      type: "number",
      label: "Bleach",
      default: 0.35,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Colour",
      description: "Bleach-bypass mix: highlights roll off metallic and contrast hardens.",
    },
    highlightTint: {
      type: "color",
      label: "Highlight Tint",
      default: [1, 1, 1, 1],
      space: "linear",
      group: "Split",
      description: "Multiplier pushed into the upper mids.",
    },
    shadowTint: {
      type: "color",
      label: "Shadow Tint",
      default: [1, 1, 1, 1],
      space: "linear",
      group: "Split",
      description: "Multiplier pushed into the shadows.",
    },
    split: {
      type: "number",
      label: "Split",
      default: 0.5,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Split",
      description: "Strength of both tints.",
    },
    grain: {
      type: "number",
      label: "Grain",
      default: 0.03,
      min: 0,
      max: 0.5,
      range: "floor",
      group: "Grain",
      description: "Grain amount, heavier in the blacks, a new pattern every frame.",
    },
    grainSize: {
      type: "number",
      label: "Grain Size",
      default: 1.3,
      min: 0.5,
      max: 8,
      range: "floor",
      unit: "px",
      group: "Grain",
      description: "Size of one grain in pixels of the input.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:film-grade`,
      shader: FILM_GRADE_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      sharedBinding: "frameU",
      // Key order matches the WGSL struct's field order.
      uniforms: {
        highlightTint: readColor(parameters, "highlightTint", [1, 1, 1, 1]),
        shadowTint: readColor(parameters, "shadowTint", [1, 1, 1, 1]),
        exposure: readNumber(parameters, "exposure", 0),
        black: readNumber(parameters, "black", 0.035),
        contrast: readNumber(parameters, "contrast", 1.25),
        saturation: readNumber(parameters, "saturation", 0.28),
        keepWarm: readNumber(parameters, "keepWarm", 0.5),
        bleach: readNumber(parameters, "bleach", 0.35),
        split: readNumber(parameters, "split", 0.5),
        lift: readNumber(parameters, "lift", 0),
        grain: readNumber(parameters, "grain", 0.03),
        grainSize: readNumber(parameters, "grainSize", 1.3),
      },
      nodeId,
      label: "Film Grade",
    };
    return { passes: [pass] };
  },
};

/**
 * CRT — the picture re-scanned on a tube: curvature and black corners, an RGB aperture
 * grille, brightness-dependent scanlines, interlace jitter, phosphor glow and flicker
 * (T1402b). Works on display light, so it goes after a grade.
 */
export const crtNode: NodeDefinition = {
  type: "crt",
  version: 1,
  title: "CRT",
  category: "filter",
  description:
    "Re-scans the picture on a curved tube: phosphor stripes, scanlines that swell on bright areas, interlace jitter and glow.",
  tags: ["crt", "tube", "scanlines", "retro", "tv", "phosphor", "interlace"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE, description: "Display light, after the grade." }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    amount: {
      type: "number",
      label: "Amount",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      description: "Fades the tube in; 0 passes the input through.",
    },
    lines: {
      type: "number",
      label: "Lines",
      default: 540,
      min: 1,
      max: 2160,
      range: "floor",
      step: 1,
      description: "Scanlines over the frame height.",
    },
    curvature: {
      type: "number",
      label: "Curvature",
      default: 0.08,
      min: 0,
      max: 1,
      range: "floor",
      description: "How much the tube bulges; the corners fall to black.",
    },
    mask: {
      type: "number",
      label: "Mask",
      default: 0.5,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Phosphor",
      description: "Depth of the red, green and blue phosphor stripes.",
    },
    maskPitch: {
      type: "number",
      label: "Mask Pitch",
      default: 3,
      min: 1,
      max: 24,
      range: "floor",
      unit: "px",
      group: "Phosphor",
      description: "Pixels per red-green-blue stripe triad.",
    },
    glow: {
      type: "number",
      label: "Glow",
      default: 0.5,
      min: 0,
      max: 4,
      range: "floor",
      group: "Phosphor",
      description: "Phosphor glow bleeding around bright areas.",
    },
    jitter: {
      type: "number",
      label: "Jitter",
      default: 0.4,
      min: 0,
      max: 2,
      range: "floor",
      description: "Interlace jitter: alternate frames shift by this many lines.",
    },
    gain: {
      type: "number",
      label: "Gain",
      default: 1.25,
      min: 0,
      max: 4,
      range: "floor",
      description: "Brightness makeup for what the mask and scanlines take away.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:crt`,
      shader: CRT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      sharedBinding: "frameU",
      uniforms: {
        amount: readNumber(parameters, "amount", 1),
        lines: readNumber(parameters, "lines", 540),
        curvature: readNumber(parameters, "curvature", 0.08),
        mask: readNumber(parameters, "mask", 0.5),
        maskPitch: readNumber(parameters, "maskPitch", 3),
        glow: readNumber(parameters, "glow", 0.5),
        jitter: readNumber(parameters, "jitter", 0.4),
        gain: readNumber(parameters, "gain", 1.25),
      },
      nodeId,
      label: "CRT",
    };
    return { passes: [pass] };
  },
};

/** The finishing group, in library order. */
export const filmNodes: readonly NodeDefinition[] = [filmGradeNode, crtNode];
