import type { GraphEdge, GraphNode, ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { edge, node as buildNode } from "../../../examples/documents/builders.ts";

/**
 * T1407b — GRAPH SURGERY for the shots that are built ON another shot's graph (halo, crt):
 * take the base shot's finished document and re-aim, re-pose and re-finish it by node id.
 * Every edit names its node; a node the base no longer has is an error, never a silent skip,
 * so a rename in document.ts breaks these shots loudly instead of quietly un-grading them.
 */
export interface Surgery {
  readonly nodes: Record<string, GraphNode>;
  readonly edges: Record<string, GraphEdge>;
}

export function surgery(base: ProjectDocument): Surgery {
  return { nodes: { ...base.graph.nodes }, edges: { ...base.graph.edges } };
}

export function finish(base: ProjectDocument, cut: Surgery, name: string): ProjectDocument {
  return { ...base, projectId: `project-on-nothing-${name}`, name: `On Nothing · ${name}`, graph: { ...base.graph, nodes: cut.nodes, edges: cut.edges } };
}

function must(cut: Surgery, id: string): GraphNode {
  const found = cut.nodes[id];
  if (found === undefined) throw new Error(`on-nothing shot surgery: the base graph has no node "${id}".`);
  return found;
}

/** Overwrite (or add) parameters on a node. */
export function setParams(cut: Surgery, id: string, parameters: Record<string, StoredParameter>): void {
  const target = must(cut, id);
  cut.nodes[id] = { ...target, parameters: { ...target.parameters, ...parameters } };
}

/** Drop parameters (an expression slot the base set, so the static value below it rules). */
export function dropParams(cut: Surgery, id: string, keys: readonly string[]): void {
  const target = must(cut, id);
  const parameters = { ...target.parameters };
  for (const key of keys) delete parameters[key];
  cut.nodes[id] = { ...target, parameters };
}

export function addNode(cut: Surgery, id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode>): void {
  if (cut.nodes[id] !== undefined) throw new Error(`on-nothing shot surgery: node "${id}" already exists.`);
  cut.nodes[id] = buildNode(id, type, position, {}, { ...extra, parameters });
}

export function connect(cut: Surgery, from: readonly [string, string], to: readonly [string, string], order?: number): void {
  const id = `${from[0]}-${to[0]}-${to[1]}${order === undefined ? "" : order}`;
  cut.edges[id] = edge(id, from, to, order);
}

/**
 * Put `id` (already added, its Input still free) between `after` and everything `after`'s
 * Out fed: those consumers now read `id`'s Out instead.
 */
export function spliceAfter(cut: Surgery, after: string, id: string): void {
  must(cut, after);
  must(cut, id);
  for (const [key, entry] of Object.entries(cut.edges)) {
    if (entry.source.nodeId === after && entry.source.portId === "out" && entry.target.nodeId !== id) {
      cut.edges[key] = { ...entry, source: { nodeId: id, portId: "out" } };
    }
  }
  connect(cut, [after, "out"], [id, "input"]);
}

/** The node whose Out feeds `id`'s Input. */
export function feederOf(cut: Surgery, id: string): string {
  const found = Object.values(cut.edges).find((entry) => entry.target.nodeId === id && entry.target.portId === "input");
  if (found === undefined) throw new Error(`on-nothing shot surgery: nothing feeds "${id}".`);
  return found.source.nodeId;
}
