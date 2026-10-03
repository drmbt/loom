import type { GraphDocument, GraphNode, NodeResolutionOverride } from "../types/graph.ts";
import { nodeResolutionOverrideSchema } from "../types/schemas.ts";
import { isComponentInstance } from "./instance.ts";

/** Component namespace contract: authored IDs contain no slash. */
export const COMPONENT_ID_SEPARATOR = "/";
export function flattenedNodeId(prefix: string, nodeId: string): string {
  return prefix === "" ? nodeId : `${prefix}${COMPONENT_ID_SEPARATOR}${nodeId}`;
}
export const INTERNAL_RESOLUTIONS_KEY = "componentResolutionOverrides";

/** Relative to the owning instance, so copying/renaming the instance never rewrites keys. */
export function internalResolutions(node: GraphNode): Readonly<Record<string, NodeResolutionOverride>> {
  const raw = node.state?.[INTERNAL_RESOLUTIONS_KEY];
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid component resolution overrides");
  const result: Record<string, NodeResolutionOverride> = {};
  for (const [path, resolution] of Object.entries(raw)) {
    if (path.split(COMPONENT_ID_SEPARATOR).some(part => part.length === 0)) throw new Error("Invalid internal resolution path");
    result[path] = nodeResolutionOverrideSchema.parse(resolution) as NodeResolutionOverride;
  }
  return result;
}

/**
 * B239 — an instance's internal resolution overrides written onto its definition graph, for
 * `component.detach`: a direct id sets that node's `resolution`, a nested path merges into
 * the nested instance's own overrides (its first segment must be an instance), outer
 * winning — what flattening does after each level expands (`compiler/flatten.ts`), applied
 * to real nodes once. `missing` lists the paths that name nothing, which flattening reports.
 */
export function projectInternalResolutions(graph: GraphDocument, resolutions: Readonly<Record<string, NodeResolutionOverride>>): {
  readonly graph: GraphDocument; readonly missing: readonly string[];
} {
  if (Object.keys(resolutions).length === 0) return { graph, missing: [] };
  const nodes = { ...graph.nodes };
  const missing: string[] = [];
  for (const [path, resolution] of Object.entries(resolutions)) {
    const separator = path.indexOf(COMPONENT_ID_SEPARATOR);
    const nodeId = separator < 0 ? path : path.slice(0, separator);
    const node = nodes[nodeId];
    if (node === undefined || (separator >= 0 && !isComponentInstance(node))) {
      missing.push(path);
      continue;
    }
    if (separator < 0) nodes[nodeId] = { ...node, resolution };
    else nodes[nodeId] = { ...node, state: { ...node.state, [INTERNAL_RESOLUTIONS_KEY]: {
      ...internalResolutions(node), [path.slice(separator + 1)]: resolution,
    } } };
  }
  return { graph: { ...graph, nodes }, missing };
}
