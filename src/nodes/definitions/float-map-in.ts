import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { PHOTO_DEPTH_INPUT_SIDES } from "../../domain/media/preparation-sizes.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import { DATA_TEXTURE, RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";

export const FLOAT_MAP_TEXTURE_KEY = "floatMap";

/** Shared identity for the numerical-image loader and its external texture. */
export function floatMapSourceIdFor(nodeId: string): string {
  return `${nodeId}:floatMap`;
}

// The loader resolves the image to the output dimensions before upload. Pixel coordinates
// read the corresponding sample exactly; neither colour transfer nor filtering applies.
const FLOAT_MAP_BLIT_WGSL = wgsl`@group(0) @binding(0) var floatMapTexture: texture_2d<f32>;

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let value = textureLoad(floatMapTexture, vec2i(position.xy), 0).r;
  return vec4f(value, 0.0, 0.0, 1.0);
}`;

export const floatMapInNode: NodeDefinition = {
  type: "floatMapIn",
  version: 1,
  title: "Float Map In",
  category: "input",
  description: "Loads a saved .loomf32 numerical image as a single-channel 32-bit float texture. Depth, coverage and arbitrary scalar fields retain their precision without colour decoding. Select Depth or Mask to prepare or explicitly rerun from a reference photo; saved results load independently of inference. Consumers read the red channel.",
  tags: ["depth", "mask", "data", "photo", "projection", "file"],
  inputs: [{ id: "picture", label: "Reference photo", type: RGBA_TEXTURE, optional: true,
    description: "Connect the source Movie File In so replacing its photo marks prepared maps out of date." }],
  // The existing logical data port is shared with data consumers; its physical texture
  // has only a red channel, declared by formatPolicy rather than a second port family.
  outputs: [{ id: "out", label: "Data", type: DATA_TEXTURE }],
  parameters: {
    file: {
      type: "asset", label: "Float map", kind: "binary", group: "File",
      description: "Saved .loomf32 data asset. Its float32 samples and preparation metadata are loaded without an image decoder or sRGB conversion.",
    },
    interpretation: {
      type: "enum", label: "Interpretation", group: "Preparation", default: "raw",
      options: [
        { value: "raw", label: "Raw values" },
        { value: "depth", label: "Depth" },
        { value: "mask", label: "Mask" },
      ],
      description: "Raw exposes saved numerical values unchanged. Depth applies the saved depth normalization during loading. Mask exposes coverage. Interpretation does not rerun inference or modify the saved base samples.",
    },
    photo: {
      type: "asset", label: "Reference photo", kind: "image", group: "Preparation",
      description: "Source photo used only when Prepare / rerun is requested. Changing the photo does not regenerate or overwrite the saved map automatically.",
      inactiveWhen: values => values["interpretation"] === "depth" || values["interpretation"] === "mask" ? null : "Raw values load an existing map without photo preparation.",
    },
    inputSide: {
      type: "enum", label: "Depth input size", group: "Preparation", default: "518",
      options: PHOTO_DEPTH_INPUT_SIDES.map(side => ({ value: String(side), label: side === 518 ? "518 px (model export size)" : `${side} px` })),
      description: "Depth model input side for the next explicit preparation run. All choices are multiples of the model's 14-pixel patch size. Higher resolution increases inference work; the saved base samples remain float32.",
      inactiveWhen: values => values["interpretation"] === "depth" ? null : "Input size applies only when preparing depth.",
    },
    prepare: {
      type: "pulse", label: "Prepare / rerun…", group: "Preparation",
      fires: "photoMapping.prepare", input: { nodeIds: ["$node"] },
      description: "Explicitly prepares this map from the reference photo and saves the result. Rerunning depth leaves separately prepared or hand-corrected masks unchanged. Loading a saved map never triggers this action.",
      inactiveWhen: values => values["interpretation"] === "depth" || values["interpretation"] === "mask" ? null : "Select Depth or Mask to prepare a photo-derived map.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "fixed", format: "r32float" },
  compile(context) {
    const { nodeId, outputs } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) return { passes: [] };
    return {
      passes: [{
        kind: "effect", id: `${nodeId}:floatMap`, shader: FLOAT_MAP_BLIT_WGSL, target,
        textures: [{ binding: "floatMapTexture", resourceId: scratchResourceId(nodeId, FLOAT_MAP_TEXTURE_KEY), sampled: "unfiltered" }],
        nodeId,
      }],
      scratch: [{
        key: FLOAT_MAP_TEXTURE_KEY, kind: "external", sourceId: floatMapSourceIdFor(nodeId), format: "r32float",
      }],
    };
  },
};
