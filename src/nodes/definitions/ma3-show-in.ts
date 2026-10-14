import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { DMX_SLOTS, DMX_UNIVERSES } from "../../domain/lighting/ma3-show.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import { DATA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";

export const MA3_SHOW_TEXTURE_KEY = "dmx";

/** Shared identity for the show player and its external DMX texture. */
export function ma3ShowSourceIdFor(nodeId: string): string {
  return `${nodeId}:ma3Show`;
}

// The player writes every universe's slots on the CPU; this pass only hands them on.
const DMX_BLIT_WGSL = wgsl`@group(0) @binding(0) var dmxTexture: texture_2d<f32>;

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let value = textureLoad(dmxTexture, vec2i(position.xy), 0).r;
  return vec4f(value, 0.0, 0.0, 1.0);
}`;

/**
 * VN131 — plays a grandMA3 show (a `loom-ma3-show` file) on the timeline and outputs DMX.
 *
 * The output is the DMX texture: 512 x 128, one row per universe (universe N is row N-1, as
 * patched), each texel a slot's byte / 255 in the red channel. A future Art-Net or sACN input
 * publishes exactly this layout, so whatever decodes fixtures from it is shared.
 */
export const ma3ShowInNode: NodeDefinition = {
  type: "ma3ShowIn",
  version: 1,
  title: "MA3 Show In",
  category: "input",
  description: "Plays a grandMA3 show packaged as a .ma3show.json file (patch, fixture profiles, cues and timecode) on the timeline, and outputs every universe's DMX as a 512 x 128 data texture: row N-1 is universe N, red holds slot value / 255. Cue fades, tracking, hits and phasers are evaluated at the frame's time, so scrubbing and renders match playback.",
  tags: ["dmx", "lighting", "grandma3", "timecode", "show", "data", "file"],
  inputs: [],
  outputs: [{ id: "out", label: "DMX", type: DATA_TEXTURE }],
  parameters: {
    file: {
      type: "asset", label: "Show file", kind: "binary", group: "File",
      description: "A .ma3show.json show package, made by tools/ma3/package_show.py from a grandMA3 onPC export.",
    },
    offset: {
      type: "number", label: "Offset", group: "Timing", default: 0, min: -3600, max: 3600, step: 0.001,
      description: "Seconds added to timeline time before the show reads it. Timeline 0 plays the show's timecode start (the packaged song's first sample).",
    },
    blackout: {
      type: "boolean", label: "Blackout", group: "Timing", default: false,
      description: "Output every slot at 0 without stopping the show.",
    },
  },
  resolutionPolicy: { kind: "fixed", width: DMX_SLOTS, height: DMX_UNIVERSES },
  formatPolicy: { kind: "fixed", format: "r32float" },
  compile(context) {
    const { nodeId, outputs } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) return { passes: [] };
    return {
      passes: [{
        kind: "effect", id: `${nodeId}:dmx`, shader: DMX_BLIT_WGSL, target,
        textures: [{ binding: "dmxTexture", resourceId: scratchResourceId(nodeId, MA3_SHOW_TEXTURE_KEY), sampled: "unfiltered" }],
        nodeId,
      }],
      scratch: [{
        key: MA3_SHOW_TEXTURE_KEY, kind: "external", sourceId: ma3ShowSourceIdFor(nodeId), format: "r32float",
      }],
    };
  },
};
