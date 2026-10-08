import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterDefinition, ParameterSchema } from "../../domain/types/parameters.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHARED_SAMPLER_ID, scratchResourceId } from "../../compiler/resources.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";
import { FFGL_TYPE, ffglControls, hsbToRgb, parseFfglManifest, type FfglControl, type FfglManifest } from "./ffgl-manifest.ts";

/**
 * FFGL (VN85): a Resolume FFGL plugin, running in the desktop app's native host
 * (src/devices/native/ffgl-host.mm), as a node.
 *
 * ## What the node stores, and why not a path
 *
 * `plugin` is the plugin's bundle NAME (`VignettePlus`); the desktop resolves it through the
 * plugin folders (src/desktop/ffgl-plugins.cjs, fed by settings in VN90), so a document opens
 * the same on any machine that has the plugin, and the browser host (VN84) keys its WASM
 * modules by the same name. `manifest` is the plugin's own parameter table as the host read
 * it, stored WITH the document, so the schema below is derived synchronously and headless
 * (§V11, §V585): a machine without the plugin still opens the document, shows the controls,
 * and keeps every value.
 *
 * ## The controls are the plugin's (ffgl-manifest.ts, the one normaliser)
 *
 * In the plugin's order: STANDARD/XPOS/YPOS as 0..1 numbers with the plugin's declared range,
 * INTEGER as whole numbers, BOOLEAN as toggles, OPTION as a menu of the plugin's elements,
 * each HUE/SATURATION/BRIGHTNESS/ALPHA quad as ONE colour (as Resolume shows it), TEXT as
 * text, and EVENT as a pulse that fires `runtime.ffglEvent`. A Phase parameter is a plain
 * 0..1 number: drive it with an expression (`fract(time * rate)`) or a lane, never with
 * smoothing — a slewed phase crosses the wrap the long way round.
 *
 * ## The frame (the person-mask native path's shape)
 *
 * compile() copies the input into this node's own sRGB scratch target (`ffglInput`), which
 * the desktop presents to the native host: the plugin sees display-encoded bytes, as it does
 * in Resolume. The result comes back as an external texture (`ffglResult`, filled through the
 * media registry by src/app/native-ffgl-sources.ts) and is blitted to the output. Time is the
 * frame's abs time, fed to the plugin as its free clock (the host's rule: monotonic, one
 * interval across a seek); BPM is the `bpm` parameter. No clock is read here (§V44).
 *
 * Limits, stated: the input reaches the plugin OPAQUE (alpha is not carried in, as with Syphon
 * Out); a live frame is at least one frame late, an offline frame is exact; desktop macOS only.
 */
export const FFGL_TYPE_NAME = "ffgl";
export const FFGL_INPUT_KEY = "ffglInput";
export const FFGL_RESULT_KEY = "ffglResult";
export const FFGL_EVENT_COMMAND = "runtime.ffglEvent";

export function ffglSourceIdFor(nodeId: string): string {
  return `ffgl:${nodeId}`;
}

const COPY_WGSL = wgsl`@group(0) @binding(0) var copySampler: sampler;
@group(0) @binding(1) var copySource: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(copySource, copySampler, uv, 0.0);
}`;

const RESULT_WGSL = wgsl`@group(0) @binding(0) var resultSampler: sampler;
@group(0) @binding(1) var resultTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(resultTexture, resultSampler, uv, 0.0);
}`;

const OWN_PARAMETERS = {
  plugin: {
    type: "string", label: "Plugin", group: "FFGL", default: "", compileTime: true,
    description: "The plugin's bundle name (VignettePlus), found in the desktop app's plugin folders. Setting it loads the plugin and reflects its parameters below.",
  },
  manifest: {
    type: "string", label: "Plugin table", group: "FFGL", default: "", compileTime: true, multiline: true,
    description: "The plugin's own parameter table, read from the plugin when it was loaded and kept with the document, so the controls exist on a machine without the plugin. Written by the app; not for editing.",
  },
  bpm: {
    type: "number", label: "BPM", group: "FFGL", default: 120, min: 1, max: 999, range: "bounded", step: 0.01,
    description: "The tempo sent to the plugin as FFGL beat info. drmbt plugins do not read it by design; bind it to an audio tempo for one that does.",
  },
} satisfies ParameterSchema;

/** The stored manifest, or undefined when the node has none yet (or a malformed one). */
export function ffglManifestOf(stored: Readonly<Record<string, unknown>>): FfglManifest | undefined {
  const text = stored["manifest"];
  if (typeof text !== "string" || text === "") return undefined;
  try { return parseFfglManifest(JSON.parse(text)); } catch { return undefined; }
}

function definitionOf(control: FfglControl, group: string): ParameterDefinition | undefined {
  const base = { label: control.label, group };
  switch (control.kind) {
    case "float":
      return { ...base, type: "number", default: control.default, min: control.min, max: control.max, range: "bounded" };
    case "integer":
      return { ...base, type: "number", default: control.default, min: control.min, max: control.max, range: "bounded", step: 1 };
    case "toggle":
      return { ...base, type: "boolean", default: control.default };
    case "pulse":
      return { ...base, type: "pulse", fires: FFGL_EVENT_COMMAND, input: { nodeIds: ["$node"], event: control.key } };
    case "menu": {
      const options = control.options.map(option => ({ value: String(option.value), label: option.label || String(option.value) }));
      const fallback = options.find(option => option.value === String(control.default))?.value ?? options[0]?.value ?? "0";
      return options.length ? { ...base, type: "enum", default: fallback, options } : undefined;
    }
    case "hsba": {
      const [h, s, b, a] = control.default;
      return { ...base, type: "color", space: "display", default: [...hsbToRgb(h, s, b), a] as [number, number, number, number] };
    }
    case "rgb":
      return { ...base, type: "color", space: "display", default: [...control.default, 1] as [number, number, number, number] };
    case "text":
      return { ...base, type: "string", default: control.default };
    default:
      return undefined;
  }
}

const schemas = new Map<string, ParameterSchema>();
/** The node's schema: its own keys, then the plugin's controls in the plugin's order. */
export function ffglParameterSchema(stored: Readonly<Record<string, unknown>>): ParameterSchema {
  const text = typeof stored["manifest"] === "string" ? stored["manifest"] : "";
  const hit = schemas.get(text);
  if (hit) return hit;
  const manifest = ffglManifestOf(stored);
  const schema: Record<string, ParameterDefinition> = { ...OWN_PARAMETERS };
  if (manifest) {
    for (const control of ffglControls(manifest)) {
      const definition = definitionOf(control, manifest.parameters.find(p => p.index === ("index" in control ? control.index : control.indices[0]))?.group || manifest.name);
      if (definition) schema[control.key] = definition;
    }
  }
  schemas.set(text, schema);
  return schema;
}

export const ffglNode: NodeDefinition = {
  type: FFGL_TYPE_NAME,
  version: 1,
  title: "FFGL",
  category: "filter",
  description:
    "Runs a Resolume FFGL plugin in the desktop app (Apple Silicon macOS). Set Plugin to a bundle name from the plugin folders; its parameters appear below in the plugin's order, colours and events included. The plugin's clock is the frame's time, so renders repeat exactly. The input reaches the plugin opaque (alpha is not carried in). A live frame arrives at least one frame late; offline renders are exact.",
  tags: ["ffgl", "resolume", "plugin", "native", "effect"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE, optional: true,
    description: "The picture the plugin processes. A source plugin (one that generates) needs none." }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: OWN_PARAMETERS,
  parametersFor: ffglParameterSchema,
  parameterKeysNote: "An FFGL node's keys after Plugin, Plugin table and BPM are the plugin's own parameters, named from the plugin's table (Tint_saturation → tint, folded into one colour).",
  requires: ["desktop", "macos"],
  resolutionPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, outputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) return { passes: [] };
    const manifest = ffglManifestOf(parameters as Readonly<Record<string, unknown>>);
    const source = inputs["input"];
    const generates = manifest?.pluginType === 1;
    // §V585: an effect with nothing to process, or a node with no plugin yet, asks nothing of the host.
    if (manifest === undefined || (source === undefined && !generates)) return { passes: [] };
    const passes: EffectPassDescriptor[] = [];
    if (source !== undefined) {
      passes.push({
        kind: "effect", id: `${nodeId}:ffgl-input`, shader: COPY_WGSL, target: scratchResourceId(nodeId, FFGL_INPUT_KEY),
        samplers: [{ binding: "copySampler", resourceId: SHARED_SAMPLER_ID }],
        textures: [{ binding: "copySource", resourceId: source.resource }], nodeId,
      });
    }
    passes.push({
      kind: "effect", id: `${nodeId}:ffgl-result`, shader: RESULT_WGSL, target,
      samplers: [{ binding: "resultSampler", resourceId: SHARED_SAMPLER_ID }],
      textures: [{ binding: "resultTexture", resourceId: scratchResourceId(nodeId, FFGL_RESULT_KEY) }], nodeId,
    });
    return {
      passes,
      scratch: [
        ...(source !== undefined ? [{ key: FFGL_INPUT_KEY, format: "rgba8unorm-srgb" as const }] : []),
        // The plugin writes display-encoded bytes, as every FFGL host expects: decoded on sample.
        { key: FFGL_RESULT_KEY, kind: "external" as const, sourceId: ffglSourceIdFor(nodeId), format: "rgba8unorm-srgb" as const },
      ],
    };
  },
};

/** Exposed for tests and the tracker: does this manifest describe a plugin that needs an input? */
export function ffglNeedsInput(manifest: FfglManifest): boolean {
  return manifest.pluginType !== 1;
}
export { FFGL_TYPE };
