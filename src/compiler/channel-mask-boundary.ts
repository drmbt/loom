import type { ChannelMask } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { PortType } from "../domain/types/ports.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { channelMaskPass } from "./channel-mask.ts";
import { asCompilerContext } from "./types.ts";

/** Compiler-local boundary; never registered in the editor or written to a project. */
export function channelMaskBoundaryDefinition(type: string, outputType: PortType, mask: ChannelMask, inputType?: PortType): NodeDefinition {
  return {
    type, version: 1, title: "Component Processing Channels", category: "component",
    inputs: [
      { id: "processed", label: "Processed", type: outputType },
      ...(inputType === undefined ? [] : [{ id: "preserved", label: "Preserved", type: inputType }]),
    ],
    outputs: [{ id: "out", label: "Out", type: outputType }],
    parameters: {}, resolutionPolicy: { kind: "inherit", input: "processed" }, formatPolicy: { kind: "inherit", input: "processed" },
    compile(raw) {
      const context = asCompilerContext(raw);
      const processed = context.inputs.processed?.[0];
      const preserved = context.inputs.preserved?.[0];
      const output = context.outputs.out;
      if (processed === undefined || output === undefined || (inputType !== undefined && preserved === undefined)) {
        return { passes: [], diagnostics: [{ severity: "error", code: "node.channelMask.boundaryMissing",
          nodeId: context.nodeId, message: "Component channel boundary has no processed output or required preserved input." }] };
      }
      return { passes: [channelMaskPass(context, mask, output, processed.resourceId, preserved)] };
    },
  };
}

/** Only synthetic definitions from this flattening are visible; the caller's registry stays intact. */
export function withChannelMaskBoundaries(registry: NodeRegistryView, definitions: ReadonlyMap<string, NodeDefinition> | undefined): NodeRegistryView {
  if (definitions === undefined || definitions.size === 0) return registry;
  return {
    has: type => definitions.has(type) || registry.has(type),
    get: type => definitions.get(type) ?? registry.get(type),
    require: type => definitions.get(type) ?? registry.require(type),
    list: () => [...registry.list(), ...definitions.values()],
    categories: () => registry.categories(),
    port: (type, portId, direction) => {
      const definition = definitions.get(type);
      return definition === undefined ? registry.port(type, portId, direction) :
        (direction === "input" ? definition.inputs : definition.outputs).find(port => port.id === portId);
    },
    statefulDeclaration: type => definitions.has(type) ? undefined : registry.statefulDeclaration(type),
  };
}
