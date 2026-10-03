import { SRGB_TRANSFER_WGSL } from "../domain/color/display.ts";
import type { ChannelMask } from "../domain/types/graph.ts";
import { isDefaultChannelMask } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../runtime/backend/plan.ts";
import { wgsl } from "../runtime/backend/wgsl.ts";
import type { CompiledInputBinding, CompilerNodeContext, ResolvedOutput } from "./types.ts";

export interface ChannelMaskOutput {
  readonly output: ResolvedOutput;
  readonly processed: string;
  readonly pass: EffectPassDescriptor;
}

/** Select output channels in their declared sampled space; input absence is generator neutral. */
export function channelMaskPass(
  context: CompilerNodeContext,
  mask: ChannelMask,
  output: Pick<ResolvedOutput, "resourceId" | "portId" | "space">,
  processed: string,
  input: CompiledInputBinding | undefined,
): EffectPassDescriptor {
  const filtered = input !== undefined && input.format !== "r32float";
  const readInput = input === undefined ? "vec4f(0.0, 0.0, 0.0, 1.0)" : filtered
    ? "textureSampleLevel(preservedTexture, inputSampler, uv, 0.0)"
    : "textureLoad(preservedTexture, min(vec2i(uv * vec2f(textureDimensions(preservedTexture))), vec2i(textureDimensions(preservedTexture)) - vec2i(1)), 0)";
  const conversion = input === undefined || input.space === output.space || input.space === "data" || output.space === "data"
    ? "preserved.rgb" : output.space === "encoded" ? "encodeDisplay(preserved.rgb)" : "decodeDisplay(preserved.rgb)";
  const shader = wgsl`@group(0) @binding(0) var processedTexture: texture_2d<f32>;
${input === undefined ? "" : "@group(0) @binding(1) var preservedTexture: texture_2d<f32>;"}
${filtered ? "@group(0) @binding(2) var inputSampler: sampler;" : ""}
${conversion === "preserved.rgb" ? "" : SRGB_TRANSFER_WGSL}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = min(vec2i(uv * vec2f(textureDimensions(processedTexture))), vec2i(textureDimensions(processedTexture)) - vec2i(1));
  let processed = textureLoad(processedTexture, pixel, 0);
  let preserved = ${readInput};
  let original = vec4f(${conversion}, preserved.a);
  return select(original, processed, vec4<bool>(${mask.r}, ${mask.g}, ${mask.b}, ${mask.a}));
}`;
  return {
    kind: "effect", id: `${context.nodeId}:channel-mask:${output.portId}`, nodeId: context.nodeId,
    label: "Processing Channels", shader, target: output.resourceId,
    textures: [
      { binding: "processedTexture", resourceId: processed, sampled: "unfiltered" },
      ...(input === undefined ? [] : [{ binding: "preservedTexture", resourceId: input.resourceId,
        sampled: filtered ? "filtered" as const : "unfiltered" as const }]),
    ],
    ...(filtered ? { samplers: [{ binding: "inputSampler", resourceId: context.sampler }] } : {}),
  };
}

/** Compile against private targets; downstream bindings keep the public, masked output identity. */
export function prepareChannelMask(
  context: CompilerNodeContext,
  definition: NodeDefinition,
  mask: ChannelMask | undefined,
  outputs: readonly ResolvedOutput[],
): { readonly context: CompilerNodeContext; readonly outputs: readonly ChannelMaskOutput[] } {
  if (isDefaultChannelMask(mask)) return { context, outputs: [] };
  const selected = mask!;
  let input: CompiledInputBinding | undefined;
  for (const port of definition.inputs) {
    if (port.type.kind !== "texture2d" || port.type.sample === "depth") continue;
    const connected = context.inputs[port.id]?.[0];
    if (connected !== undefined) { input = connected; break; }
  }
  const masked = outputs.filter(output => output.resourceKind !== "pointset" && output.format !== "depth24plus")
    .map(output => {
      const processed = `${output.resourceId}:channel-process`;
      const pass = channelMaskPass(context, selected, output, processed, input);
      return { output, processed, pass };
    });
  const replacements = new Map(masked.map(entry => [entry.output.resourceId, entry.processed]));
  return {
    context: { ...context,
      ...(context.target === undefined ? {} : { target: replacements.get(context.target) ?? context.target }),
      outputs: Object.fromEntries(Object.entries(context.outputs).map(([port, binding]) =>
        [port, { ...binding, resourceId: replacements.get(binding.resourceId) ?? binding.resourceId }])),
    },
    outputs: masked,
  };
}
