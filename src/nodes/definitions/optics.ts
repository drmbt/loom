import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { DEGREES_TO_RADIANS, readColor, readNumber, readVector } from "./parameter-readers.ts";
import type { Params } from "./parameter-readers.ts";
import {
  BRIGHT_EXTRACT_WGSL,
  FLARE_GATHER_WGSL,
  FLARE_SOURCE_WGSL,
  FLARE_WGSL,
  GLOW_ADD_WGSL,
  HALO_RING_WGSL,
  LENS_WGSL,
  STREAK_GATHER_WGSL,
} from "../shaders/optics.wgsl.ts";

/**
 * The OPTICS family: Streak, Halo and Lens (T1402b).
 *
 * Promoted from the On Nothing project's Custom WGSL passes (T1400b,
 * `src/projects/on-nothing/fx.ts`) so a streak glass, a ring flare and a fast wide lens can
 * be built in the app with no code. Streak is the one that changed shape on the way: the
 * project chained a bright pass, a bloom level and three Custom WGSL gathers plus a
 * composite; the node is all of that behind one set of knobs.
 *
 * MULTI-PASS THE WAY BLUR IS (§V8): every intermediate is a declared scratch the compiler
 * materialises, at a fixed fraction of the output (half for the streak, quarter for the
 * halo — both are soft by nature, and the reduction is most of their cost). Nothing the
 * user turns is structural: length, angle, threshold and the rest are derived into uniform
 * values on the CPU (§V5), exactly as Blur derives its tap spacing.
 *
 * THE BRIGHT INPUT. Both glow nodes threshold their input by default. Wiring the optional
 * Bright input replaces the threshold with that image — a bloom level, a matte, anything —
 * which is how the project fed its streaks the bloom's first level so a column is as wide
 * as the lamp's glare rather than its lens. Wiring is structural anyway, so the switch is a
 * binding plus a flag, never a second shader.
 */

/** Node-local scratch keys; the compiler namespaces them. */
export const GLOW_BRIGHT_KEY = "bright";
export const STREAK_LEG_KEYS = ["leg1", "leg2", "leg3"] as const;
export const HALO_RING_KEY = "ring";

/** The streak's internal size, as a fraction of its output. */
export const STREAK_SCALE = 0.5;
/** The halo's internal size, as a fraction of its output. */
export const HALO_SCALE = 0.25;

/**
 * The three legs' tap steps, as fractions of the streak's LENGTH. Eight taps each, every
 * step just under the span of the leg before (1/48 < 7/160, 1/10 < 7/48), so each leg's
 * gaps are filled by the box the leg before drew and the three convolve into one column
 * reaching about 0.9 of the length (7 × (1/160 + 1/48 + 1/10)) with no ladder of copies.
 * The project's measured ratios, verbatim.
 */
export const STREAK_LEG_STEPS = [1 / 160, 1 / 48, 1 / 10] as const;

/** The first two legs are flat boxes; only the last one's weights fall off (`falloff`). */
const FLAT_DECAY = 50;

/** T1439b: the sideways widening's samples either side, at least (the original kernel) and at most. */
export const STREAK_SPREAD_TAPS = { min: 3, max: 32 } as const;

/**
 * Samples either side for a sideways spread of `texels` streak-scratch texels: enough that
 * neighbours sit at most one texel apart, so a thin source widens into a ramp instead of being
 * copied (T1439b). A spread of three texels or less keeps the original seven-tap kernel.
 */
export function streakSpreadTaps(texels: number): number {
  return Math.min(STREAK_SPREAD_TAPS.max, Math.max(STREAK_SPREAD_TAPS.min, Math.ceil(texels)));
}

const thresholdParameters: ParameterSchema = {
  threshold: {
    type: "number",
    label: "Threshold",
    default: 1,
    min: 0,
    max: 10,
    range: "floor",
    group: "Source",
    description: "Linear brightness where the glow starts. Ignored while the Bright input is wired.",
  },
  knee: {
    type: "number",
    label: "Knee",
    default: 0.5,
    min: 0,
    max: 4,
    range: "floor",
    group: "Source",
    description: "Softness of the threshold: how far below it sources begin to fade in.",
  },
};

const brightPort = {
  id: "bright",
  label: "Bright",
  type: RGBA_TEXTURE,
  optional: true,
  description: "Optional. Wired, this image is what glows, in place of the thresholded input.",
} as const;

/** The integer size the compiler gives a scratch at `scale` (compile.ts's own rounding). */
function scratchSize(resolution: readonly [number, number], scale: number): [number, number] {
  return [Math.max(1, Math.round(resolution[0] * scale)), Math.max(1, Math.round(resolution[1] * scale))];
}

/** The shared first pass: the threshold (or the Bright input) at reduced size. */
function brightExtractPass(
  nodeId: string,
  label: string,
  from: { resource: string; sampler: string },
  external: boolean,
  parameters: Params,
  size: readonly [number, number],
  /** Streak's source-size gate in input pixels (T1422b); 0 is off, and Halo always passes 0. */
  minSize: number,
): EffectPassDescriptor {
  return {
    kind: "effect",
    id: `${nodeId}:bright`,
    shader: BRIGHT_EXTRACT_WGSL,
    target: scratchResourceId(nodeId, GLOW_BRIGHT_KEY),
    textures: [{ binding: "inputTexture", resourceId: from.resource }],
    samplers: [{ binding: "inputSampler", resourceId: from.sampler }],
    uniformBinding: "params",
    uniforms: {
      texel: [1 / size[0], 1 / size[1]],
      threshold: readNumber(parameters, "threshold", 1),
      knee: readNumber(parameters, "knee", 0.5),
      useBright: external ? 1 : 0,
      minSize,
    },
    nodeId,
    label,
  };
}

/**
 * Streak — a streak glass smearing every bright source into a one-sided column (T1402b).
 *
 * Replaces the project's bright pass + three chained STREAK passes + the streak share of
 * its optics composite. Five passes: the bright extract at half size, three gather legs
 * (half size, each into its own scratch), and the add back at full size, where
 * the striations are drawn so the grooves stay crisp.
 *
 * DIRECTION. `angle` 0 streaks UPWARD — the column rises above its source — and 90 streaks
 * to the right. The gather runs the other way, toward the sources, in frame heights, so a
 * length of 0.33 is a third of the frame's height at any aspect and any angle.
 */
export const streakNode: NodeDefinition = {
  type: "streak",
  version: 1,
  title: "Streak",
  category: "filter",
  description:
    "Smears every bright source into a soft one-sided column with glassy striations, and adds it back onto the picture.",
  tags: ["glow", "flare", "streak", "smear", "optics", "lens", "anamorphic"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }, brightPort],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    ...thresholdParameters,
    minSize: {
      type: "number",
      label: "Min Size",
      default: 0,
      min: 0,
      max: 32,
      range: "floor",
      unit: "px",
      scalesWithOutput: true,
      group: "Source",
      description:
        "Smallest source that streaks, in pixels (of the project's reference width, when it names one): a source must fill most of a square this wide to pass the threshold, so a thin glint does not streak like a lamp. 0 is off. Ignored while the Bright input is wired.",
    },
    length: {
      type: "number",
      label: "Length",
      default: 0.33,
      min: 0,
      max: 1,
      range: "floor",
      description: "How far the column reaches from its source, as a fraction of the frame height.",
    },
    angle: {
      type: "number",
      label: "Angle",
      default: 0,
      min: -180,
      max: 180,
      range: "cyclic",
      unit: "degrees",
      description: "Which way the column runs: 0 is up, 90 is to the right.",
    },
    falloff: {
      type: "number",
      label: "Falloff",
      default: 1.2,
      min: 0.05,
      max: 50,
      range: "floor",
      description: "How the column fades along its length: small fades early, large holds a flat slab to the end.",
    },
    spread: {
      type: "number",
      label: "Spread",
      default: 0.004,
      min: 0,
      max: 0.05,
      range: "floor",
      description: "Widens the column sideways, as a fraction of the frame width: a soft ramp, however thin the source.",
    },
    tail: {
      type: "number",
      label: "Tail",
      default: 0.12,
      min: 0,
      max: 0.5,
      range: "floor",
      description: "Reach of the faint tail on the other side of the source, as a fraction of the frame height.",
    },
    striation: {
      type: "number",
      label: "Striation",
      default: 0.55,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Glass",
      description: "Depth of the glass's grooves running along the column.",
    },
    striationScale: {
      type: "number",
      label: "Striation Count",
      default: 140,
      min: 1,
      max: 1000,
      range: "floor",
      group: "Glass",
      description: "How many grooves fit across the frame width.",
    },
    gain: {
      type: "number",
      label: "Gain",
      default: 1,
      min: 0,
      max: 10,
      range: "floor",
      group: "Glass",
      description: "Brightness of the column added back onto the picture.",
    },
    tint: {
      type: "color",
      label: "Tint",
      default: [1, 1, 1, 1],
      space: "linear",
      group: "Glass",
      description: "Multiplies the column's colour; a faintly cold glass is just under 1 in red.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const bright = inputs["bright"];
    const aspect = resolution[0] / resolution[1];
    const theta = readNumber(parameters, "angle", 0) * DEGREES_TO_RADIANS;
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    // Toward the sources, in uv per frame HEIGHT (uv x is a frame width, so x divides by
    // the aspect). Angle 0: straight down the texture, i.e. from below the pixel.
    const toward = [-sin / aspect, cos] as const;
    const length = readNumber(parameters, "length", 0.33);
    const spread = readNumber(parameters, "spread", 0.004);
    // In streak-scratch texels: `spread` is a fraction of the frame width in any direction
    // (x is a width; y is a height times the aspect, which is a width again).
    const taps = streakSpreadTaps(spread * scratchSize(resolution, STREAK_SCALE)[0]);
    const tail = readNumber(parameters, "tail", 0.12);
    const legs = STREAK_LEG_KEYS.map((key, index): EffectPassDescriptor => {
      const step = length * STREAK_LEG_STEPS[index]!;
      const from = index === 0 ? GLOW_BRIGHT_KEY : STREAK_LEG_KEYS[index - 1]!;
      const last = index === STREAK_LEG_KEYS.length - 1;
      return {
        kind: "effect",
        id: `${nodeId}:streak-${key}`,
        shader: STREAK_GATHER_WGSL,
        target: scratchResourceId(nodeId, key),
        textures: [{ binding: "inputTexture", resourceId: scratchResourceId(nodeId, from) }],
        samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
        uniformBinding: "params",
        // Key order matches the WGSL struct's field order, as everywhere else in the catalogue.
        uniforms: {
          gather: [toward[0] * step, toward[1] * step],
          // Sideways in frame widths: x is already a width, y is a height (times aspect).
          spread: index === 0 ? [cos * spread, sin * spread * aspect] : [0, 0],
          back: last ? [-toward[0] * tail, -toward[1] * tail] : [0, 0],
          decay: last ? readNumber(parameters, "falloff", 1.2) : FLAT_DECAY,
          taps,
          norm: 1 / (taps + 1),
        },
        nodeId,
        label: `Streak ${index + 1}`,
      };
    });
    const add: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:streak-add`,
      shader: GLOW_ADD_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: source.resource },
        { binding: "glowTexture", resourceId: scratchResourceId(nodeId, STREAK_LEG_KEYS[2]) },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        tint: readColor(parameters, "tint", [1, 1, 1, 1]),
        // The axis ACROSS the column, in frame widths: the grooves run along the streak.
        across: [cos, sin / aspect],
        striation: readNumber(parameters, "striation", 0.55),
        striationScale: readNumber(parameters, "striationScale", 140),
        gain: readNumber(parameters, "gain", 1),
      },
      nodeId,
      label: "Streak Add",
    };
    const extract = brightExtractPass(
      nodeId,
      "Streak Bright",
      bright ?? source,
      bright !== undefined,
      parameters,
      scratchSize(resolution, STREAK_SCALE),
      readNumber(parameters, "minSize", 0),
    );
    return {
      passes: [extract, ...legs, add],
      scratch: [GLOW_BRIGHT_KEY, ...STREAK_LEG_KEYS].map((key) => ({ key, scale: STREAK_SCALE })),
    };
  },
};

/**
 * Halo — a thin ring flare around every bright source, its colours split by dispersion
 * (T1402b). Replaces the project's hot bright pass + HALO pass + the halo share of its
 * optics composite: the extract and the ring at quarter size, the add back at full.
 */
export const haloNode: NodeDefinition = {
  type: "halo",
  version: 1,
  title: "Halo",
  category: "filter",
  description:
    "Draws a thin ring around every bright source, red outside and blue inside, and adds it back onto the picture.",
  tags: ["glow", "flare", "ring", "halo", "optics", "lens", "dispersion"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }, brightPort],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    ...thresholdParameters,
    radius: {
      type: "number",
      label: "Radius",
      default: 0.14,
      min: 0,
      max: 1,
      range: "floor",
      description: "Ring radius, as a fraction of the frame height.",
    },
    width: {
      type: "number",
      label: "Width",
      default: 0.012,
      min: 0,
      max: 0.2,
      range: "floor",
      description: "Ring thickness, as a fraction of the frame height.",
    },
    dispersion: {
      type: "number",
      label: "Dispersion",
      default: 0.06,
      min: 0,
      max: 1,
      range: "floor",
      description: "How far red sits outside blue, as a fraction of the radius.",
    },
    gain: {
      type: "number",
      label: "Gain",
      default: 1,
      min: 0,
      max: 10,
      range: "floor",
      description: "Brightness of the ring added back onto the picture.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const bright = inputs["bright"];
    const extract = brightExtractPass(
      nodeId,
      "Halo Bright",
      bright ?? source,
      bright !== undefined,
      parameters,
      scratchSize(resolution, HALO_SCALE),
      0,
    );
    const ring: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:halo-ring`,
      shader: HALO_RING_WGSL,
      target: scratchResourceId(nodeId, HALO_RING_KEY),
      textures: [{ binding: "inputTexture", resourceId: scratchResourceId(nodeId, GLOW_BRIGHT_KEY) }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        radius: readNumber(parameters, "radius", 0.14),
        width: readNumber(parameters, "width", 0.012),
        dispersion: readNumber(parameters, "dispersion", 0.06),
      },
      nodeId,
      label: "Halo Ring",
    };
    const add: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:halo-add`,
      shader: GLOW_ADD_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: source.resource },
        { binding: "glowTexture", resourceId: scratchResourceId(nodeId, HALO_RING_KEY) },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      // The streak's add, with the glass switched off: no grooves, no tint.
      uniforms: {
        tint: [1, 1, 1, 1],
        across: [0, 0],
        striation: 0,
        striationScale: 0,
        gain: readNumber(parameters, "gain", 1),
      },
      nodeId,
      label: "Halo Add",
    };
    return {
      passes: [extract, ring, add],
      scratch: [GLOW_BRIGHT_KEY, HALO_RING_KEY].map((key) => ({ key, scale: HALO_SCALE })),
    };
  },
};

/**
 * Lens — barrel distortion, swirling edge blur, edge chromatic aberration, a snap-zoom
 * radial blur and the vignette, in one pass (T1402b). The project's LENS pass, knob for knob.
 */
export const lensNode: NodeDefinition = {
  type: "lens",
  version: 1,
  title: "Lens",
  category: "filter",
  description:
    "A fast wide lens: barrel distortion, soft swirling edges, colour fringes at the edges, a zoom blur and a vignette.",
  tags: ["lens", "distortion", "barrel", "vignette", "aberration", "optics", "zoom blur"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    distortion: {
      type: "number",
      label: "Distortion",
      default: 0.06,
      min: -1,
      max: 1,
      range: "soft",
      description: "Barrel distortion: positive bows straight lines outward, negative pinches them in.",
    },
    edgeBlur: {
      type: "number",
      label: "Edge Blur",
      default: 0.012,
      min: 0,
      max: 0.1,
      range: "floor",
      group: "Edges",
      description: "Blur reach at the corners, as a fraction of the frame; it grows from nothing at the centre.",
    },
    swirl: {
      type: "number",
      label: "Swirl",
      default: 0.6,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Edges",
      description: "Direction of the edge blur: 0 radial, 1 around the centre (a swirl).",
    },
    aberration: {
      type: "number",
      label: "Aberration",
      default: 0.0015,
      min: -0.02,
      max: 0.02,
      range: "soft",
      group: "Edges",
      description: "Colour fringing at the corners: red pushed outward, blue inward.",
    },
    zoomBlur: {
      type: "number",
      label: "Zoom Blur",
      default: 0,
      min: 0,
      max: 1,
      range: "floor",
      group: "Zoom",
      description: "Radial blur toward the zoom centre, like a snap zoom. 0 is off.",
    },
    zoomCentre: {
      type: "vector",
      size: 2,
      label: "Zoom Centre",
      default: [0.5, 0.5],
      min: 0,
      max: 1,
      range: "soft",
      group: "Zoom",
      description: "Where the zoom blur converges, in uv with y down, as Circle's centre.",
    },
    vignette: {
      type: "number",
      label: "Vignette",
      default: 0.55,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Vignette",
      description: "Darkening toward the corners.",
    },
    vignetteRound: {
      type: "number",
      label: "Roundness",
      default: 0.75,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Vignette",
      description: "1 is a round vignette, 0 follows the frame's shape.",
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
      id: `${nodeId}:lens`,
      shader: LENS_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        zoomCentre: readVector(parameters, "zoomCentre", [0.5, 0.5]),
        distortion: readNumber(parameters, "distortion", 0.06),
        edgeBlur: readNumber(parameters, "edgeBlur", 0.012),
        swirl: readNumber(parameters, "swirl", 0.6),
        aberration: readNumber(parameters, "aberration", 0.0015),
        zoomBlur: readNumber(parameters, "zoomBlur", 0),
        vignette: readNumber(parameters, "vignette", 0.55),
        vignetteRound: readNumber(parameters, "vignetteRound", 0.75),
      },
      nodeId,
      label: "Lens",
    };
    return { passes: [pass] };
  },
};

/** T1423b: the flare's two reduction stages, node-local scratch keys. */
export const FLARE_GATHER_KEY = "gather";
export const FLARE_SOURCE_KEY = "source";
/** Columns of the flare's gather (its rows follow the aspect): the project's measured 60. */
export const FLARE_GATHER_COLUMNS = 60;

/**
 * On-Axis Flare — the flare a lens throws when a hard light looks straight down it (T1423b).
 *
 * Promoted from the On Nothing halo shot (`src/projects/on-nothing/shots/halo.ts`), where it was
 * measured off the reference: a thin rainbow ring round the source with red outermost, a veil
 * filling it, a core glow, a peach ghost and a small red ring. It is MEASURED, not keyed:
 * `FLARE_GATHER_WGSL` and `FLARE_SOURCE_WGSL` reduce the bright, on-axis energy of the Source
 * (the input, unless the Source port is wired) to a centroid, an energy and a colour each frame,
 * so an arm passing over the lamp dims the flare as it would on glass. Three passes: the gather
 * (60 columns, its rows to the aspect) and the 2-texel source stage as half-float scratch sized
 * from the node's width, then the flare added onto the input at full size.
 */
export const flareNode: NodeDefinition = {
  type: "flare",
  version: 1,
  title: "On-Axis Flare",
  category: "filter",
  description:
    "Measures the bright light near the middle of the frame and draws the flare a lens throws from it: a rainbow ring, a veil, a glow and two ghosts, following the light and dimming when something covers it.",
  tags: ["flare", "lens flare", "ring", "ghost", "veil", "optics", "lens", "dispersion"],
  inputs: [
    { id: "input", label: "Input", type: RGBA_TEXTURE },
    {
      id: "source",
      label: "Source",
      type: RGBA_TEXTURE,
      optional: true,
      description: "Optional. Wired, the flare is measured from this image instead of the input (say, before a depth of field softens the lamp).",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    threshold: { type: "number", label: "Threshold", default: 6, min: 0, max: 100, step: 0.1, range: "floor", group: "Source", description: "Linear brightness where a pixel starts to count as a flare source." },
    axis: { type: "number", label: "Axis", default: 0.35, min: 0.01, max: 2, range: "floor", group: "Source", description: "How far from the frame centre a source still flares, as a fraction of the frame height (the width of a Gaussian window)." },
    gain: { type: "number", label: "Gain", default: 1, min: 0, max: 100, step: 0.01, range: "floor", description: "Overall flare strength per unit of measured energy." },
    tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display", description: "Flare colour; multiplies the source's own." },
    veil: { type: "number", label: "Veil", default: 0.35, min: 0, max: 4, range: "floor", group: "Glow", description: "The flat veiling glare filling the ring." },
    veilTint: { type: "color", label: "Veil Tint", default: [1, 1, 1, 1], space: "display", group: "Glow", description: "Colour of the veil (the glare inside the ring reads cooler than the core)." },
    core: { type: "number", label: "Core", default: 1, min: 0, max: 20, range: "floor", group: "Glow", description: "The soft glow round the source." },
    coreRadius: { type: "number", label: "Core Radius", default: 0.16, min: 0.001, max: 1, range: "floor", group: "Glow", description: "The core's 1/e radius, as a fraction of the frame height." },
    glow: { type: "number", label: "Wide Glow", default: 0.2, min: 0, max: 4, range: "floor", group: "Glow", description: "A wide soft glow round the source, reaching toward the ring." },
    radius: { type: "number", label: "Ring Radius", default: 0.8, min: 0, max: 2, range: "floor", group: "Ring", description: "Ring radius, as a fraction of the frame height." },
    width: { type: "number", label: "Ring Width", default: 0.018, min: 0.001, max: 0.3, range: "floor", group: "Ring", description: "Ring thickness (a Gaussian's sigma), as a fraction of the frame height." },
    dispersion: { type: "number", label: "Dispersion", default: 0.035, min: 0, max: 0.5, range: "floor", group: "Ring", description: "How far red sits outside blue, as a fraction of the radius." },
    ring: { type: "number", label: "Ring", default: 0.25, min: 0, max: 4, range: "floor", group: "Ring", description: "Ring strength." },
    ringSaturation: { type: "number", label: "Ring Saturation", default: 0.7, min: 0, max: 1, range: "bounded", group: "Ring", description: "How much of the dispersion's colour the ring keeps." },
    ringFacing: { type: "number", label: "Ring Facing", default: 0.6, min: 0, max: 1, range: "bounded", group: "Ring", description: "How much stronger the ring is toward Ring Angle than opposite it; 0 is even all round." },
    ringAngle: { type: "number", label: "Ring Angle", default: 0.5, min: -3.14159, max: 3.14159, range: "cyclic", unit: "radians", group: "Ring", description: "Direction the ring is strongest: 0 is right, positive turns down." },
    ghost: { type: "number", label: "Ghost", default: 0.2, min: 0, max: 4, range: "floor", group: "Ghosts", description: "Strength of the peach ghost." },
    ghostAt: { type: "vector", size: 2, label: "Ghost Offset", default: [0.2, 0.2], min: -2, max: 2, range: "soft", group: "Ghosts", description: "The peach ghost's offset from the source, in frame heights, y down." },
    ghostRadius: { type: "number", label: "Ghost Radius", default: 0.3, min: 0.001, max: 2, range: "floor", group: "Ghosts", description: "The peach ghost's radius, as a fraction of the frame height." },
    dot: { type: "number", label: "Red Ring", default: 0.4, min: 0, max: 4, range: "floor", group: "Ghosts", description: "Strength of the small red ring ghost." },
    dotAt: { type: "vector", size: 2, label: "Red Ring Offset", default: [0.7, 0.7], min: -2, max: 2, range: "soft", group: "Ghosts", description: "The red ring's offset from the source, in frame heights, y down." },
    dotRadius: { type: "number", label: "Red Ring Radius", default: 0.027, min: 0.001, max: 0.5, range: "floor", group: "Ghosts", description: "The red ring's radius, as a fraction of the frame height." },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    const input = inputs["input"];
    if (target === undefined || input === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const measured = inputs["source"] ?? input;
    // Sized from the node's width, so the gather is 60 columns and the source stage 2 at any size.
    const gatherScale = FLARE_GATHER_COLUMNS / resolution[0];
    const gatherSize = scratchSize(resolution, gatherScale);
    const tint = readColor(parameters, "tint", [1, 1, 1, 1]);
    const veilTint = readColor(parameters, "veilTint", [1, 1, 1, 1]);
    const gather: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:flare-gather`,
      shader: FLARE_GATHER_WGSL,
      target: scratchResourceId(nodeId, FLARE_GATHER_KEY),
      textures: [{ binding: "inputTexture", resourceId: measured.resource }],
      samplers: [{ binding: "inputSampler", resourceId: measured.sampler }],
      uniformBinding: "params",
      uniforms: {
        block: [1 / gatherSize[0], 1 / gatherSize[1]],
        threshold: readNumber(parameters, "threshold", 6),
        axis: readNumber(parameters, "axis", 0.35),
      },
      nodeId,
      label: "Flare Gather",
    };
    const source: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:flare-source`,
      shader: FLARE_SOURCE_WGSL,
      target: scratchResourceId(nodeId, FLARE_SOURCE_KEY),
      textures: [{ binding: "inputTexture", resourceId: scratchResourceId(nodeId, FLARE_GATHER_KEY) }],
      nodeId,
      label: "Flare Source",
    };
    const flare: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:flare`,
      shader: FLARE_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: input.resource },
        { binding: "sourceTexture", resourceId: scratchResourceId(nodeId, FLARE_SOURCE_KEY) },
      ],
      samplers: [{ binding: "inputSampler", resourceId: input.sampler }],
      uniformBinding: "params",
      // Key order matches the WGSL struct's field order.
      uniforms: {
        gain: readNumber(parameters, "gain", 1),
        veil: readNumber(parameters, "veil", 0.35),
        core: readNumber(parameters, "core", 1),
        coreRadius: readNumber(parameters, "coreRadius", 0.16),
        radius: readNumber(parameters, "radius", 0.8),
        width: readNumber(parameters, "width", 0.018),
        dispersion: readNumber(parameters, "dispersion", 0.035),
        ring: readNumber(parameters, "ring", 0.25),
        ringSaturation: readNumber(parameters, "ringSaturation", 0.7),
        glow: readNumber(parameters, "glow", 0.2),
        ringFacing: readNumber(parameters, "ringFacing", 0.6),
        ringAngle: readNumber(parameters, "ringAngle", 0.5),
        ghost: readNumber(parameters, "ghost", 0.2),
        ghostAt: readVector(parameters, "ghostAt", [0.2, 0.2]),
        ghostRadius: readNumber(parameters, "ghostRadius", 0.3),
        dot: readNumber(parameters, "dot", 0.4),
        dotAt: readVector(parameters, "dotAt", [0.7, 0.7]),
        dotRadius: readNumber(parameters, "dotRadius", 0.027),
        tint: [tint[0] ?? 1, tint[1] ?? 1, tint[2] ?? 1],
        veilTint: [veilTint[0] ?? 1, veilTint[1] ?? 1, veilTint[2] ?? 1],
      },
      nodeId,
      label: "Flare",
    };
    return {
      passes: [gather, source, flare],
      scratch: [
        { key: FLARE_GATHER_KEY, scale: gatherScale, format: "rgba16float" },
        { key: FLARE_SOURCE_KEY, scale: 2 / resolution[0], format: "rgba16float" },
      ],
    };
  },
};

/** The optics group, in library order. */
export const opticsNodes: readonly NodeDefinition[] = [streakNode, haloNode, lensNode, flareNode];

