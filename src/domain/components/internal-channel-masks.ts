import type { ChannelMask, GraphDocument, GraphNode } from "../types/graph.ts";
import { channelMaskSchema } from "../types/schemas.ts";
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
