import type { GraphComponentDefinition } from "../types/components.ts";
import type { ChannelMask, GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { PortType } from "../types/ports.ts";
import { isDefaultChannelMask } from "../types/graph.ts";
import { channelMaskSchema } from "../types/schemas.ts";
import { supportsChannelMask } from "../graph/channel-mask.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { COMPONENT_ID_SEPARATOR } from "./internal-resolutions.ts";
import { isComponentInstance } from "./instance.ts";

export const INTERNAL_CHANNEL_MASKS_KEY = "componentChannelMaskOverrides";

/** Relative descendant paths keep overrides local when an instance is copied or renamed. */
export function internalChannelMasks(node: GraphNode): Readonly<Record<string, ChannelMask>> {
  const raw = node.state?.[INTERNAL_CHANNEL_MASKS_KEY];
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid component channel masks");
  const result: Record<string, ChannelMask> = {};
  for (const [path, mask] of Object.entries(raw)) {
    if (path.split(COMPONENT_ID_SEPARATOR).some(part => part.length === 0)) throw new Error("Invalid internal channel mask path");
    result[path] = channelMaskSchema.parse(mask);
  }
  return result;
}

/** Apply exact descendant overrides before inlining; nested instance masks affect only their boundaries. */
export function projectInternalChannelMasks(graph: GraphDocument, masks: Readonly<Record<string, ChannelMask>>): {
  readonly graph: GraphDocument; readonly missing: readonly string[];
} {
  if (Object.keys(masks).length === 0) return { graph, missing: [] };
  const nodes = { ...graph.nodes };
  const missing: string[] = [];
  for (const [path, channelMask] of Object.entries(masks)) {
    const separator = path.indexOf(COMPONENT_ID_SEPARATOR);
    const nodeId = separator < 0 ? path : path.slice(0, separator);
    const node = nodes[nodeId];
    if (node === undefined || (separator >= 0 && !isComponentInstance(node))) {
      missing.push(path);
      continue;
    }
    if (separator < 0) nodes[nodeId] = { ...node, channelMask };
    else nodes[nodeId] = { ...node, state: { ...node.state, [INTERNAL_CHANNEL_MASKS_KEY]: {
      ...internalChannelMasks(node), [path.slice(separator + 1)]: channelMask,
    } } };
  }
  return { graph: { ...graph, nodes }, missing };
}

/**
 * T1545b — THE INSTANCE'S OWN Processing Channels, for `component.detach`. Flattening applies
 * an instance's `channelMask` with a boundary pass on each exposed picture output
 * (`compiler/flatten.ts`, `channelMaskBoundaryDefinition`): the output keeps the masked
 * channels of what the component made and takes the rest from the instance's FIRST
 * connected exposed picture input (opaque black when none is). That boundary is
 * compiler-only — no node type can be placed for it — but a plain node's own `channelMask`
 * compiles to the very same pass (`channelMaskPass`), taking the rest from ITS first
 * connected picture input. So the mask moves onto the node behind each exposed picture
 * output when, and only when, that is the same picture:
 *
 *  - the node is a plain node that supports Processing Channels and has none of its own;
 *  - none of its pictures feeds anything inside (masking a node masks every picture it makes);
 *  - its first connected picture input, once detached, is exactly the instance's first
 *    connected exposed picture input — or neither is connected (both read opaque black).
 *
 * Anything else returns the reason, by name; the copies then draw every channel.
 */
export function carryInstanceChannelMask(input: {
  readonly graph: GraphDocument;
  readonly definition: Pick<GraphComponentDefinition, "inputs" | "outputs">;
  readonly instance: GraphNode;
  /** The document holding the instance: its edges are the instance's connected inputs. */
  readonly outer: GraphDocument;
  readonly registry: NodeRegistryView;
}): { readonly graph: GraphDocument; readonly reason?: string } {
  const { graph, definition, instance, outer, registry } = input;
  const mask = instance.channelMask;
  if (mask === undefined || isDefaultChannelMask(mask)) return { graph };
  const picture = (type: PortType | undefined): boolean => type?.kind === "texture2d" && type.sample !== "depth";
  const name = (nodeId: NodeId): string => graph.nodes[nodeId]?.label ?? nodeId;
  const fed = (externalId: string): boolean =>
    Object.values(outer.edges).some((edge) => edge.target.nodeId === instance.id && edge.target.portId === externalId);
  const insideInto = (nodeId: NodeId, portId: string): boolean =>
    Object.values(graph.edges).some((edge) => edge.target.nodeId === nodeId && edge.target.portId === portId);

  // The instance's preserved picture: its first connected exposed picture input, inside.
  let preserved: { nodeId: NodeId; portId: string } | undefined;
  for (const exposed of definition.inputs) {
    const node = graph.nodes[exposed.nodeId];
    if (node === undefined || !fed(exposed.externalId)) continue;
    if (isComponentInstance(node)) {
      return { graph, reason: `its input "${exposed.externalId}" enters at "${name(exposed.nodeId)}", a component of its own` };
    }
    if (!picture(registry.port(node.type, exposed.portId, "input")?.type)) continue;
    preserved = { nodeId: exposed.nodeId, portId: exposed.portId };
    break;
  }

  const masked = new Set<NodeId>();
  for (const exposed of definition.outputs) {
    const node = graph.nodes[exposed.nodeId];
    if (node === undefined) continue;
    if (isComponentInstance(node)) {
      return { graph, reason: `its output "${exposed.externalId}" comes from "${name(exposed.nodeId)}", a component of its own` };
    }
    if (picture(registry.port(node.type, exposed.portId, "output")?.type)) masked.add(exposed.nodeId);
  }
  if (masked.size === 0) return { graph, reason: "it exposes no picture output" };

  for (const nodeId of [...masked].sort()) {
    const node = graph.nodes[nodeId] as GraphNode;
    const nodeDefinition = registry.get(node.type);
    if (nodeDefinition === undefined || !supportsChannelMask(nodeDefinition)) {
      return { graph, reason: `"${name(nodeId)}" cannot hold Processing Channels` };
    }
    if (!isDefaultChannelMask(node.channelMask)) return { graph, reason: `"${name(nodeId)}" has Processing Channels of its own` };
    const consumer = Object.values(graph.edges).find(
      (edge) => edge.source.nodeId === nodeId && picture(nodeDefinition.outputs.find((port) => port.id === edge.source.portId)?.type),
    );
    if (consumer !== undefined) return { graph, reason: `"${name(nodeId)}"'s picture also feeds "${name(consumer.target.nodeId)}" inside` };
    // Its first connected picture input once detached: an inside edge, or an outside one rewired.
    const first = nodeDefinition.inputs.find(
      (port) =>
        picture(port.type) &&
        (insideInto(nodeId, port.id) ||
          definition.inputs.some((exposed) => exposed.nodeId === nodeId && exposed.portId === port.id && fed(exposed.externalId))),
    );
    const same =
      preserved === undefined
        ? first === undefined
        : first !== undefined && !insideInto(nodeId, first.id) && preserved.nodeId === nodeId && preserved.portId === first.id;
    if (!same) {
      const look = instance.label ?? instance.id;
      return {
        graph,
        reason: `"${name(nodeId)}" would keep the other channels of ${first === undefined ? "nothing (opaque black)" : `its input "${first.id}"`}, where "${look}" kept those of ${preserved === undefined ? "nothing (opaque black)" : "its own first input"}`,
      };
    }
  }
  const nodes = { ...graph.nodes };
  for (const nodeId of masked) nodes[nodeId] = { ...(nodes[nodeId] as GraphNode), channelMask: mask };
  return { graph: { ...graph, nodes } };
}
