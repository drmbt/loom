import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";
import { CRT_TUBE_WGSL, CRT_WGSL, FILM_GRADE_WGSL } from "../shaders/film.wgsl.ts";

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
      scalesWithOutput: true,
      group: "Grain",
      description: "Size of one grain in pixels of the input (of the project's reference width, when it names one).",
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
      scalesWithOutput: true,
      group: "Phosphor",
      description: "Pixels per red-green-blue stripe triad (of the project's reference width, when it names one).",
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

/**
 * CRT Tube — the picture re-scanned: shown on a modelled CRT and photographed with a macro
 * lens (T1423b). Promoted from the On Nothing crt shot (`src/projects/on-nothing/shots/crt.ts`);
 * `CRT_TUBE_WGSL` is the ray tracer. Where CRT is a filter laid over the picture, this is a
 * second camera: the output is what a lens a few centimetres from the glass sees — the grille,
 * the scanlines and their fields, the faceplate's curve and reflection, its depth of field.
 */
export const crtTubeNode: NodeDefinition = {
  type: "crtTube",
  version: 1,
  title: "CRT Tube",
  category: "filter",
  description:
    "Shows the picture on a modelled CRT and photographs it with a macro lens: curved glass, an RGB aperture grille, interlaced scanlines that swell with brightness, a reflection and a thin depth of field. Outputs linear display light; set the Output's tone map to none.",
  tags: ["crt", "tube", "rescan", "scanlines", "phosphor", "grille", "macro", "retro", "video"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    tubeSize: { type: "vector", size: 2, label: "Tube Size", default: [400, 300], min: 10, max: 2000, range: "floor", group: "Tube", description: "The visible face, width and height, in millimetres (a 4:3 tube is 400 × 300)." },
    curvature: { type: "number", label: "Curvature Radius", default: 1100, min: 100, max: 100000, step: 10, range: "floor", group: "Tube", description: "Radius of the phosphor and faceplate sphere, mm: smaller bulges more." },
    glass: { type: "number", label: "Glass", default: 12, min: 0, max: 60, range: "floor", group: "Tube", description: "Faceplate thickness, mm." },
    lines: { type: "number", label: "Lines", default: 480, min: 16, max: 2000, range: "floor", group: "Tube", description: "Visible scanlines." },
    triads: { type: "number", label: "Triads", default: 350, min: 16, max: 2000, range: "floor", group: "Tube", description: "RGB triads across the face." },
    beamDark: { type: "number", label: "Beam (Dark)", default: 0.15, min: 0.02, max: 1, range: "floor", group: "Tube", description: "Beam sigma of a dark line, in line pitches." },
    beamBright: { type: "number", label: "Beam (Bright)", default: 0.27, min: 0.02, max: 1, range: "floor", group: "Tube", description: "Beam sigma of a bright line: a bright line swells." },
    grille: { type: "number", label: "Grille Fill", default: 0.75, min: 0.05, max: 1, range: "bounded", group: "Tube", description: "Share of a triad's third each phosphor stripe fills." },
    field: { type: "number", label: "Other Field", default: 0.55, min: 0, max: 1, range: "bounded", group: "Tube", description: "Brightness of the field not being scanned now (phosphor persistence)." },
    halation: { type: "number", label: "Halation", default: 0.12, min: 0, max: 2, range: "floor", group: "Tube", description: "Light scattered in the faceplate (phosphor bloom)." },
    unlit: { type: "number", label: "Unlit Glow", default: 0.02, min: 0, max: 1, range: "floor", group: "Tube", description: "The unlit phosphor's glow: the tube is never black." },
    reflection: { type: "number", label: "Reflection", default: 0.5, min: 0, max: 4, range: "floor", group: "Tube", description: "The room reflected in the faceplate (times Fresnel)." },
    invert: { type: "number", label: "Negative", default: 1, min: 0, max: 1, range: "bounded", group: "Picture", description: "1 shows the picture as a negative, 0 as itself." },
    contrast: { type: "number", label: "Contrast", default: 1.6, min: 0, max: 8, range: "floor", group: "Picture", description: "Contrast of the picture on the tube." },
    pivot: { type: "number", label: "Pivot", default: 0.5, min: 0, max: 1, range: "bounded", group: "Picture", description: "Level of the (inverted) picture that lands on mid-grey." },
    aim: { type: "vector", size: 2, label: "Aim", default: [0.5, 0.5], min: 0, max: 1, range: "soft", group: "Camera", description: "Where the macro camera looks on the face, in uv with y down." },
    distance: { type: "number", label: "Distance", default: 350, min: 10, max: 5000, range: "floor", group: "Camera", description: "Lens to target, mm." },
    pitch: { type: "number", label: "Pitch", default: 15, min: -80, max: 80, range: "bounded", unit: "degrees", group: "Camera", description: "The camera above the face's normal, looking down at the glass." },
    yaw: { type: "number", label: "Yaw", default: 0, min: -80, max: 80, range: "bounded", unit: "degrees", group: "Camera", description: "The camera to the side of the face's normal." },
    roll: { type: "number", label: "Roll", default: 0, min: -180, max: 180, range: "cyclic", unit: "degrees", group: "Camera", description: "Bank around the view axis, with the Camera node's sign: positive turns the camera counter-clockwise as seen from behind it." },
    fov: { type: "number", label: "FOV", default: 24, min: 1, max: 120, range: "bounded", unit: "degrees", group: "Camera", description: "Vertical field of view." },
    aperture: { type: "number", label: "Aperture", default: 6, min: 0, max: 100, step: 0.1, range: "floor", group: "Camera", description: "Lens aperture radius, mm: the depth of field." },
    focus: { type: "number", label: "Focus Offset", default: 0, min: -500, max: 500, step: 1, range: "soft", group: "Camera", description: "Focus beyond the target, mm." },
    exposure: { type: "number", label: "Exposure", default: 0.35, min: 0, max: 20, range: "floor", group: "Grade", description: "Camera exposure: linear gain before the shoulder (low, so a lit phosphor never clips)." },
    gain: { type: "number", label: "Gain", default: 1.3, min: 0, max: 8, range: "floor", group: "Grade", description: "Display gain after the shoulder." },
    lift: { type: "number", label: "Lift", default: 0.035, min: 0, max: 1, range: "bounded", group: "Grade", description: "Display-level black lift." },
    tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display", group: "Grade", description: "The camera's colour cast." },
    saturation: { type: "number", label: "Saturation", default: 0.35, min: 0, max: 2, range: "floor", group: "Grade", description: "Chroma kept." },
    grain: { type: "number", label: "Grain", default: 0.02, min: 0, max: 1, range: "floor", group: "Grade", description: "Grain, heavier in the blacks, a new pattern every frame." },
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
    const tint = readColor(parameters, "tint", [1, 1, 1, 1]);
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:crt-tube`,
      shader: CRT_TUBE_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      sharedBinding: "frameU",
      // Key order matches the WGSL struct's field order.
      uniforms: {
        tubeSize: readVector(parameters, "tubeSize", [400, 300]),
        curvature: readNumber(parameters, "curvature", 1100),
        glass: readNumber(parameters, "glass", 12),
        lines: readNumber(parameters, "lines", 480),
        triads: readNumber(parameters, "triads", 350),
        aim: readVector(parameters, "aim", [0.5, 0.5]),
        distance: readNumber(parameters, "distance", 350),
        pitch: readNumber(parameters, "pitch", 15),
        yaw: readNumber(parameters, "yaw", 0),
        roll: readNumber(parameters, "roll", 0),
        fov: readNumber(parameters, "fov", 24),
        aperture: readNumber(parameters, "aperture", 6),
        focus: readNumber(parameters, "focus", 0),
        beamDark: readNumber(parameters, "beamDark", 0.15),
        beamBright: readNumber(parameters, "beamBright", 0.27),
        grille: readNumber(parameters, "grille", 0.75),
        field: readNumber(parameters, "field", 0.55),
        halation: readNumber(parameters, "halation", 0.12),
        invert: readNumber(parameters, "invert", 1),
        contrast: readNumber(parameters, "contrast", 1.6),
        pivot: readNumber(parameters, "pivot", 0.5),
        unlit: readNumber(parameters, "unlit", 0.02),
        reflection: readNumber(parameters, "reflection", 0.5),
        exposure: readNumber(parameters, "exposure", 0.35),
        gain: readNumber(parameters, "gain", 1.3),
        lift: readNumber(parameters, "lift", 0.035),
        tint: [tint[0] ?? 1, tint[1] ?? 1, tint[2] ?? 1],
        saturation: readNumber(parameters, "saturation", 0.35),
        grain: readNumber(parameters, "grain", 0.02),
      },
      nodeId,
      label: "CRT Tube",
    };
    return { passes: [pass] };
  },
};

/** The finishing group, in library order. */
export const filmNodes: readonly NodeDefinition[] = [filmGradeNode, crtNode, crtTubeNode];
