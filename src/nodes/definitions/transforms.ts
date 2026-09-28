import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import {
  DEGREES_TO_RADIANS,
  EXTEND_OPTIONS,
  TRANSFORM_ORDER_OPTIONS,
  readEnumIndex,
  readFlag,
  readNumber,
  readVector,
} from "./parameter-readers.ts";
import {
  FLIP_FRAGMENT_WGSL,
  MIRROR_FRAGMENT_WGSL,
  CROP_FRAGMENT_WGSL,
  TILE_FRAGMENT_WGSL,
  TRANSFORM_FRAGMENT_WGSL,
} from "../shaders/transforms.wgsl.ts";

/**
 * Geometry filters: Transform, Crop, Tile (T40).
 *
 * All three take one texture in and one out, with `{kind:"inherit", input:"input"}` for
 * both resolution and format: a filter that resized or reformatted its input without being
 * asked would be an invisible conversion, which is exactly what §V13 exists to prevent.
 *
 * COLOUR (§V56): they move pixels, they never change values. Whatever space the input
 * carries, the output carries — no decode, no encode, no channel arithmetic. That holds
 * for a DATA input too, which is why a UV or a distance field can be transformed and still
 * mean what it meant.
 */

/**
 * Transform — TD's Transform TOP.
 *
 * Translate is in fractions of the image, as in TD; rotation happens in a square space so
 * a rotate on a 16:9 image does not shear it. `xord` is TD's Transform Order menu, and the
 * shader applies the INVERSE of the parameters in the reverse of that order, because a
 * fragment shader moves the sample coordinate rather than the image.
 */
export const transformNode: NodeDefinition = {
  type: "transform",
  version: 1,
  title: "Transform",
  category: "filter",
  description: "Translate, rotate, scale and pivot an image, with a choice of extend mode.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    t: { type: "vector", size: 2, label: "Translate", default: [0, 0], min: -4, max: 4, range: "soft" },
    r: { type: "number", label: "Rotate", default: 0, min: -360, max: 360, range: "cyclic", unit: "degrees" },
    s: { type: "vector", size: 2, label: "Scale", default: [1, 1], min: -8, max: 8, range: "soft" },
    p: { type: "vector", size: 2, label: "Pivot", default: [0, 0], min: -2, max: 2, range: "soft" },
    xord: {
      type: "enum",
      label: "Transform Order",
      default: "srt",
      options: [...TRANSFORM_ORDER_OPTIONS],
    },
    extend: { type: "enum", label: "Extend", default: "hold", options: [...EXTEND_OPTIONS] },
    aspectcorrect: {
      type: "boolean",
      label: "Aspect Correct",
      default: true,
      description: "Rotate in a square space so a non-square image does not shear.",
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
    const aspect = readFlag(parameters, "aspectcorrect", true) === 1 ? resolution[0] / resolution[1] : 1;
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:transform`,
      shader: TRANSFORM_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        t: readVector(parameters, "t", [0, 0]),
        s: readVector(parameters, "s", [1, 1]),
        piv: readVector(parameters, "p", [0, 0]),
        rot: readNumber(parameters, "r", 0) * DEGREES_TO_RADIANS,
        xord: readEnumIndex(parameters, "xord", TRANSFORM_ORDER_OPTIONS, "srt"),
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold"),
        aspect,
      },
      nodeId,
      label: "Transform",
    };
    return { passes: [pass] };
  },
};

/**
 * Crop — TD's Crop TOP, keeping the input resolution.
 *
 * TD's Crop resizes its output to the cropped region. `ResolutionPolicy` cannot express a
 * size derived from a parameter value (it offers inherit | fixed | scale | project |
 * custom), so this node keeps the input size and blanks what falls outside the region. The
 * alternative available today — stretching the region back up to full size — would be a
 * zoom wearing a crop's name. If a parameter-derived resolution kind is ever added, this
 * node is its first consumer.
 *
 * Bounds are fractions of the image with y UP (bottom = 0), matching TD's convention.
 */
export const cropNode: NodeDefinition = {
  type: "crop",
  version: 1,
  title: "Crop",
  category: "filter",
  description:
    "Blanks everything outside a rectangular region. Keeps the input resolution.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    left: { type: "number", label: "Left", default: 0, min: 0, max: 1, range: "bounded" },
    right: { type: "number", label: "Right", default: 1, min: 0, max: 1, range: "bounded" },
    bottom: { type: "number", label: "Bottom", default: 0, min: 0, max: 1, range: "bounded" },
    top: { type: "number", label: "Top", default: 1, min: 0, max: 1, range: "bounded" },
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
      id: `${nodeId}:crop`,
      shader: CROP_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      // Packed as one vec4 rather than four scalars: the shader wants them as two
      // min/max pairs, and a swapped pair (left > right) is then a min/max away from
      // being harmless instead of producing an empty image.
      uniforms: {
        bounds: [
          readNumber(parameters, "left", 0),
          readNumber(parameters, "right", 1),
          readNumber(parameters, "bottom", 0),
          readNumber(parameters, "top", 1),
        ],
      },
      nodeId,
      label: "Crop",
    };
    return { passes: [pass] };
  },
};

/**
 * Tile — TD's Tile TOP: repeat the image, optionally mirroring alternate tiles.
 *
 * T1402b: the CROP window (TD's Tile carries the same four) is which part of the source
 * every tile shows. With it, N vertical strips of one central slice, alternately flipped,
 * is this node on its own — the On Nothing project's MIRROR pass needed a Custom WGSL node
 * for exactly that. Which strips flip is `offset`: an odd whole-tile offset flips the even
 * strips instead of the odd ones (back-to-back rather than face-to-face). Added without a
 * version bump because the defaults are the full frame, which is the old arithmetic exactly.
 *
 * T1413b: the SEAMS layout places the grid by one seam and the tile size in uv (what a
 * reference measures) instead of a count and a shift, and UNFOLD lets the tiles cut by the
 * frame edges run on from their inner neighbour — the On Nothing quad's composite, three
 * seams and two outer strips that do not fold again, which needed its own mirror pass. Both
 * default off, and the seams layout is plain arithmetic onto Repeat/Offset, so the shader's
 * grid is the one it always was.
 */
const TILE_LAYOUT_OPTIONS = [
  { value: "repeat", label: "Repeat" },
  { value: "seams", label: "Seams" },
] as const;

/**
 * Repeat and offset for the shader, from either layout. Seams: tile 0 starts at the seam and
 * runs right in x; in y the seam is bottom-up (as the crop window is) and tile 0 lies ABOVE it,
 * so in the shader's top-down uv it spans (1 - seam - size) .. (1 - seam).
 */
function tileGrid(parameters: Readonly<Record<string, ParameterValue>>): { repeat: readonly number[]; offset: readonly number[] } {
  if (parameters["layout"] !== "seams") {
    return { repeat: readVector(parameters, "repeat", [2, 2]), offset: readVector(parameters, "offset", [0, 0]) };
  }
  const [seamX, seamY] = readVector(parameters, "seam", [0.5, 0.5]) as [number, number];
  const [sizeX, sizeY] = readVector(parameters, "tilesize", [0.5, 0.5]).map((size) => Math.max(size, 1e-3)) as [number, number];
  return { repeat: [1 / sizeX, 1 / sizeY], offset: [-seamX / sizeX, (seamY + sizeY - 1) / sizeY] };
}

export const tileNode: NodeDefinition = {
  type: "tile",
  version: 1,
  title: "Tile",
  category: "filter",
  description:
    "Repeats the image, or a cropped window of it, in a grid, with optional mirroring of alternate tiles.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    repeat: { type: "vector", size: 2, label: "Repeat", default: [2, 2], min: 0.01, max: 64, range: "floor" },
    offset: {
      type: "vector",
      size: 2,
      label: "Offset",
      default: [0, 0],
      min: -8,
      max: 8,
      range: "soft",
      description: "Shifts the grid, in tiles. An odd whole number swaps which tiles mirror.",
    },
    mirrorx: { type: "boolean", label: "Mirror X", default: false },
    mirrory: { type: "boolean", label: "Mirror Y", default: false },
    layout: {
      type: "enum",
      label: "Layout",
      default: "repeat",
      options: TILE_LAYOUT_OPTIONS,
      description:
        "Repeat: the grid is Repeat tiles across the frame, shifted by Offset. Seams: the grid is placed by one seam's position and the tile size, both in uv.",
    },
    seam: {
      type: "vector",
      size: 2,
      label: "Seam",
      default: [0.5, 0.5],
      min: -1,
      max: 2,
      range: "soft",
      group: "Seams",
      description:
        "Seams layout: where one seam lies, 0..1 across the frame from the bottom left. The tile right of and above it shows the window unflipped.",
    },
    tilesize: {
      type: "vector",
      size: 2,
      label: "Tile Size",
      default: [0.5, 0.5],
      min: 0.001,
      max: 4,
      range: "soft",
      group: "Seams",
      description: "Seams layout: one tile's width and height, 0..1 of the frame.",
    },
    unfoldx: {
      type: "boolean",
      label: "Unfold Outer X",
      default: false,
      description:
        "The tiles cut by the left and right frame edges run on from their inner neighbour instead of starting another tile (no fold at the outermost seams).",
    },
    unfoldy: {
      type: "boolean",
      label: "Unfold Outer Y",
      default: false,
      description: "The same for the tiles cut by the top and bottom frame edges.",
    },
    cropleft: {
      type: "number",
      label: "Crop Left",
      default: 0,
      min: 0,
      max: 1,
      range: "soft",
      group: "Crop",
      description: "Left edge of the source window every tile shows, 0..1 across the source.",
    },
    cropright: {
      type: "number",
      label: "Crop Right",
      default: 1,
      min: 0,
      max: 1,
      range: "soft",
      group: "Crop",
      description: "Right edge of the source window.",
    },
    cropbottom: {
      type: "number",
      label: "Crop Bottom",
      default: 0,
      min: 0,
      max: 1,
      range: "soft",
      group: "Crop",
      description: "Bottom edge of the source window, 0 at the bottom of the source.",
    },
    croptop: {
      type: "number",
      label: "Crop Top",
      default: 1,
      min: 0,
      max: 1,
      range: "soft",
      group: "Crop",
      description: "Top edge of the source window.",
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
      id: `${nodeId}:tile`,
      shader: TILE_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        ...tileGrid(parameters),
        mirror: [readFlag(parameters, "mirrorx", false), readFlag(parameters, "mirrory", false)],
        unfold: [readFlag(parameters, "unfoldx", false), readFlag(parameters, "unfoldy", false)],
        crop: [
          readNumber(parameters, "cropleft", 0),
          readNumber(parameters, "cropright", 1),
          readNumber(parameters, "cropbottom", 0),
          readNumber(parameters, "croptop", 1),
        ],
      },
      nodeId,
      label: "Tile",
    };
    return { passes: [pass] };
  },
};

/** The geometry-filter group, in library order. */
/**
 * Flip — exact axis reversal (T242). TD's Flip TOP.
 *
 * Transform can flip with a negative scale, so this earns its place two ways. It is EXACT:
 * reversing a coordinate lands on texel centres, where a -1 scale runs the image through
 * the sampler's filter and softens it a little every time. And it is what someone actually
 * looks for — nobody reaches for "set scale x to -1" when they want a mirror image, so a
 * Transform-only answer is a discoverability failure dressed up as orthogonality.
 *
 * There is deliberately NO transpose. A `swap` exchanging x and y reads as a free 90 degree
 * rotation and silently squashes every non-square image, because the output keeps the
 * input's resolution. TD splits the two across two nodes for this reason — its Flop CHANGES
 * the resolution, and the resolution-preserving transpose lives on Tile — and both need a
 * resolution policy that swaps its axes, which we do not have. Shipping the broken half
 * would be worse than shipping neither.
 */
export const flipNode: NodeDefinition = {
  type: "flip",
  version: 1,
  title: "Flip",
  category: "filter",
  description: "Reverses the image on either axis, exactly.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    flipx: { type: "boolean", label: "Flip X", default: false },
    flipy: { type: "boolean", label: "Flip Y", default: false },
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
      id: `${nodeId}:flip`,
      shader: FLIP_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        flip: [readFlag(parameters, "flipx", false), readFlag(parameters, "flipy", false)],
      },
      nodeId,
      label: "Flip",
    };
    return { passes: [pass] };
  },
};

/**
 * Mirror — fold the image about a pivot (T242).
 *
 * Not the same operation as Tile's mirror flags, which mirror alternate REPEATS to make a
 * tiling seamless. This folds the image itself, at a pivot you choose: the operation behind
 * kaleidoscopes, symmetric masks, and making a hand-drawn shape symmetric without drawing
 * both halves.
 *
 * The pivot and the ROTATION are why this is a node rather than a checkbox on Flip. Folding
 * about the centre on an axis is only symmetry; folding about an arbitrary point across an
 * arbitrary line is the kaleidoscope operation. TD's Mirror carries the same three controls
 * for the same reason.
 */
export const mirrorNode: NodeDefinition = {
  type: "mirror",
  version: 1,
  title: "Mirror",
  category: "filter",
  description: "Folds the image about a pivot so one half replaces the other.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    mirrorx: { type: "boolean", label: "Mirror X", default: true },
    mirrory: { type: "boolean", label: "Mirror Y", default: false },
    pivot: {
      type: "vector",
      size: 2,
      label: "Pivot",
      default: [0.5, 0.5],
      min: 0,
      max: 1,
      range: "bounded",
      description: "Where the fold happens. Off-centre is the interesting case.",
    },
    keephigh: {
      type: "boolean",
      label: "Keep Far Side",
      default: false,
      description: "Which half survives the fold and is copied onto the other.",
    },
    rotate: {
      type: "number",
      label: "Rotate",
      default: 0,
      min: -180,
      max: 180,
      range: "cyclic",
      unit: "degrees",
      description: "Angle of the fold line. Off-axis is what makes a kaleidoscope.",
    },
    extend: { type: "enum", label: "Extend", default: "hold", options: [...EXTEND_OPTIONS] },
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
      id: `${nodeId}:mirror`,
      shader: MIRROR_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        pivot: readVector(parameters, "pivot", [0.5, 0.5]),
        axis: [readFlag(parameters, "mirrorx", true), readFlag(parameters, "mirrory", false)],
        keepHigh: readFlag(parameters, "keephigh", false),
        rotate: readNumber(parameters, "rotate", 0) * DEGREES_TO_RADIANS,
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold"),
      },
      nodeId,
      label: "Mirror",
    };
    return { passes: [pass] };
  },
};

export const transformNodes: readonly NodeDefinition[] = [
  transformNode,
  flipNode,
  mirrorNode,
  cropNode,
  tileNode,
];
