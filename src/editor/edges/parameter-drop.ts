import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { componentNamesFor, storedStaticValue } from "@domain/parameters/slots.ts";
import { parseExpression } from "@domain/expressions/evaluate.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId, PortId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ParameterSlot } from "@domain/types/parameters.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * T1351b — what a CHANNEL SOCKET released over a PARAMETER ROW means.
 *
 * The owner's reference wires a Beat straight into a material parameter. Here a parameter
 * driven by a channel is an EXPRESSION (§T897: `driven` is retired, a channel read is the
 * term `op('beat1').chan.band109`), so the drop writes that expression into the slot and
 * keeps the value that was there as the retained static (§V108 — what every host without
 * the channel resolves to, and what a bare document renders).
 *
 * Pure over the document, like its edge-drop siblings, and silent when the drop cannot
 * mean anything: the port socket itself (a whole bag has no single value to read), a
 * texture, a compound parameter (which leaf?), an unlabelled source (unaddressable, T238),
 * a parameter that is not a number or a toggle. The canvas dispatches or does nothing.
 */
export interface ParameterDropTarget {
  readonly nodeId: NodeId;
  readonly key: string;
}

export function parameterDropOperations(
  graph: GraphDocument,
  registry: NodeRegistryView,
  source: { readonly nodeId: NodeId; readonly portId: PortId; readonly channel?: string },
  target: ParameterDropTarget,
): GraphPatchOperation[] {
  if (source.channel === undefined) return [];
  const sourceNode = graph.nodes[source.nodeId];
  const targetNode = graph.nodes[target.nodeId];
  if (sourceNode === undefined || targetNode === undefined) return [];
  const port = registry.port(sourceNode.type, source.portId, "output");
  if (port === undefined || port.type.kind !== "value") return [];
  const label = sourceNode.label;
  if (label === undefined || label === "") return [];
  const definition = registry.get(targetNode.type);
  if (definition === undefined) return [];
  const parameter = effectiveParameterSchema(definition, targetNode.parameters)[target.key];
  if (parameter === undefined) return [];
  if (componentNamesFor(parameter) !== null) return [];
  if (parameter.type !== "number" && parameter.type !== "boolean") return [];

  const expression = `op('${label}').chan.${source.channel}`;
  if (!parseExpression(expression).ok) return [];
  const retained = storedStaticValue(targetNode.parameters[target.key]) ?? parameter.default;
  const slot: ParameterSlot = {
    mode: "expression",
    bindings: {
      static: { kind: "static", value: retained },
      expression: { kind: "expression", source: expression },
    },
  };
  return [{ op: "setParameters", nodeId: target.nodeId, parameters: { [target.key]: slot } }];
}
