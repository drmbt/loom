import { rewriteNodeNameReferences } from "../../domain/graph/names.ts";
import { sortKeysDeep } from "../../domain/project/serialize.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { outwardKey, renameKey, type ScopeRenames } from "./rename-map.ts";

/**
 * The rename map applied to one shipped file's bytes, IN MEMORY (T1593b phase 2a).
 *
 * This is the rename a person does in the title field, done to every node of a file: the
 * label moves and so does every stored reference to it, through the one function the
 * product renames with (`rewriteNodeNameReferences`, §V128). Nothing here knows a
 * reference kind of its own; that is deliberate, and it is why the equivalence check can
 * say something about the product.
 *
 * A file holds its root graph and the graph of every component it embeds. Each is renamed
 * by the map of ITS scope, and names never cross between them: a reference inside a graph
 * names a node of that graph.
 *
 * The text that comes back is the save path's own serialisation (`sortKeysDeep`, two
 * spaces), so a file nothing was renamed in comes back byte for byte.
 */

interface StoredComponent {
  readonly componentId?: unknown;
  readonly version?: unknown;
  readonly graph?: GraphDocument;
}

interface StoredFile {
  graph?: GraphDocument;
  componentLibrary?: { components?: StoredComponent[] };
}

export interface AppliedRename {
  /** `root`, or `component <id>`. */
  readonly graph: string;
  readonly nodeId: string;
  readonly type: string;
  readonly old: string;
  readonly new: string;
  /** How many stored references moved with it. */
  readonly references: number;
}

export interface AppliedFile {
  readonly text: string;
  readonly applied: readonly AppliedRename[];
}

/** The scope a graph of this file is renamed in. The same rule `scopeOf` reads the audit by. */
function scopeFor(path: string, component: StoredComponent | null): string {
  if (component !== null) return `component ${String(component.componentId)}@${String(Number(component.version))}`;
  if (path.startsWith("projects/")) return `projects/${path.split("/")[1] ?? ""}`;
  return path;
}

/**
 * Renames one graph in place. Two passes, old → a placeholder → new, because a map may
 * hand one node the name another is about to give up, and a rewrite done in one pass would
 * then move the second node's references onto the first.
 */
export function renameGraph(graph: GraphDocument, graphName: string, renames: ScopeRenames | undefined): AppliedRename[] {
  if (renames === undefined) return [];
  const moves: Array<{ nodeId: string; type: string; old: string; next: string; placeholder: string; references: number }> = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node?.label === undefined) continue;
    const next = renames.get(renameKey(node.type, node.label));
    if (next === undefined || next === node.label) continue;
    moves.push({ nodeId, type: node.type, old: node.label, next, placeholder: `renaming${String(moves.length)}pending`, references: 0 });
  }
  for (const move of moves) {
    move.references = rewriteNodeNameReferences(graph, move.old, move.placeholder);
    const node = graph.nodes[move.nodeId];
    if (node !== undefined) graph.nodes[move.nodeId] = { ...node, label: move.placeholder };
  }
  for (const move of moves) {
    rewriteNodeNameReferences(graph, move.placeholder, move.next);
    const node = graph.nodes[move.nodeId];
    if (node !== undefined) graph.nodes[move.nodeId] = { ...node, label: move.next };
  }
  const applied: AppliedRename[] = moves.map((move) => ({ graph: graphName, nodeId: move.nodeId, type: move.type, old: move.old, new: move.next, references: move.references }));
  // Names this graph reads from the document around it: no node here holds them, so there
  // is no label to move, only the references.
  for (const [key, next] of renames) {
    if (!key.startsWith(outwardKey(""))) continue;
    const old = key.slice(outwardKey("").length);
    const references = rewriteNodeNameReferences(graph, old, next);
    if (references > 0) applied.push({ graph: graphName, nodeId: "", type: "", old, new: next, references });
  }
  return applied;
}

/** One shipped file with the map applied. `path` is relative to the repository root. */
export function applyRenameMap(path: string, text: string, byScope: ReadonlyMap<string, ScopeRenames>): AppliedFile {
  const file = JSON.parse(text) as StoredFile;
  const applied: AppliedRename[] = [];
  if (file.graph !== undefined) applied.push(...renameGraph(file.graph, "root", byScope.get(scopeFor(path, null))));
  for (const component of file.componentLibrary?.components ?? []) {
    if (component.graph === undefined) continue;
    applied.push(...renameGraph(component.graph, `component ${String(component.componentId)}`, byScope.get(scopeFor(path, component))));
  }
  const trailing = text.endsWith("\n") ? "\n" : "";
  return { text: `${JSON.stringify(sortKeysDeep(file), null, 2)}${trailing}`, applied };
}
