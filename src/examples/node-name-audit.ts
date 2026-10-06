import { parseComponentNodeType } from "../domain/components/component-type.ts";
import { COMPONENT_KIND, conformsToKind, kindBindsName, kindFromName, kindOfType } from "../domain/graph/node-kinds.ts";

/**
 * Which named nodes in a shipped document do not carry their kind (T1593b).
 *
 * One reading of a `.loom.json`, shared by the gate that counts them
 * (`node-names.test.ts`) and the sweep that will rename them, so the two cannot disagree
 * about what "does not conform" means or about which graphs a file holds.
 *
 * A file holds its ROOT graph and, under `componentLibrary`, the graph of every component
 * it embeds (§V94). Both are read: a component's internals are nodes a person opens and
 * sees, and an example that embeds a starter component carries a copy of its names.
 *
 * Three kinds of node are not counted, each for a reason that is not "convenient":
 *  - an UNNAMED node has no name to judge (it follows its definition's title);
 *  - a component's In and Out are named for the socket they publish (`kindBindsName`);
 *  - nothing else. An unknown type is judged against its fallback kind like any other.
 *
 * ## A component instance is judged against ITS COMPONENT'S NAME, read from this file
 *
 * An instance of Bloom is `bloom_glow`: its kind is the component's own name, which its
 * type string does not carry. The file does. A save embeds every definition it uses
 * (§V94), so the name the kind comes from is the one THIS file would open with, which is
 * the right authority: a saved document's own copy of a component wins over the shipped
 * one on load. An instance whose definition the file does not embed is judged against the
 * bare fallback kind, and so fails by name instead of passing unexamined.
 *
 * Reads the JSON directly rather than through the loader: the question is about the bytes
 * that ship, and it needs no registry to answer.
 */
export interface UnconformingName {
  /** `root`, or `component <id>` for a graph embedded under `componentLibrary`. */
  readonly graph: string;
  readonly nodeId: string;
  readonly type: string;
  readonly name: string;
  /** The kind the name would have to carry. */
  readonly kind: string;
}

/** One node of a shipped graph, as the naming rule sees it. */
export interface AuditedNode {
  readonly id: string;
  readonly type: string;
  /** Its name, or `undefined` for an unnamed node. */
  readonly name: string | undefined;
  /** The kind its name must carry, in this file. */
  readonly kind: string;
  /** False for a component's In and Out, whose name is a socket's label. */
  readonly bound: boolean;
}

/** One graph a shipped file holds: its root, or a component definition it embeds. */
export interface AuditedGraph {
  /** `root`, or `component <id>`. */
  readonly graph: string;
  /** The embedded definition this graph belongs to, or `null` for the root graph. */
  readonly component: { readonly id: string; readonly version: number; readonly name: string } | null;
  /** In id order, so every reader walks them the same way. */
  readonly nodes: readonly AuditedNode[];
  /** Wires, by node id: what the sweep reads to say what a node is FOR. */
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

interface StoredGraph {
  readonly nodes?: Readonly<Record<string, { readonly type?: unknown; readonly label?: unknown }>>;
  readonly edges?: Readonly<Record<string, { readonly source?: { readonly nodeId?: unknown }; readonly target?: { readonly nodeId?: unknown } }>>;
}

interface StoredComponent {
  readonly componentId?: unknown;
  readonly version?: unknown;
  readonly name?: unknown;
  readonly graph?: StoredGraph;
}

interface StoredFile {
  readonly graph?: StoredGraph;
  readonly componentLibrary?: { readonly components?: readonly StoredComponent[] };
}

/** `<componentId>@<version>` → the name that definition holds in this file. */
function componentNamesOf(file: StoredFile): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const component of file.componentLibrary?.components ?? []) {
    if (typeof component.name === "string") names.set(`${String(component.componentId)}@${String(component.version)}`, component.name);
  }
  return names;
}

/** The kind a node of this type must carry, in this file. */
function kindIn(type: string, componentNames: ReadonlyMap<string, string>): string {
  const instance = parseComponentNodeType(type);
  if (instance === null) return kindOfType(type);
  const name = componentNames.get(`${instance.componentId}@${instance.version}`);
  return name === undefined ? COMPONENT_KIND : kindFromName(name);
}

function audited(graph: string, component: AuditedGraph["component"], stored: StoredGraph, names: ReadonlyMap<string, string>): AuditedGraph {
  const nodes: AuditedNode[] = [];
  for (const id of Object.keys(stored.nodes ?? {}).sort()) {
    const node = stored.nodes?.[id];
    if (typeof node?.type !== "string") continue;
    nodes.push({
      id,
      type: node.type,
      name: typeof node.label === "string" ? node.label : undefined,
      kind: kindIn(node.type, names),
      bound: kindBindsName(node.type),
    });
  }
  const edges = Object.values(stored.edges ?? {}).flatMap((edge) =>
    typeof edge.source?.nodeId === "string" && typeof edge.target?.nodeId === "string"
      ? [{ from: edge.source.nodeId, to: edge.target.nodeId }]
      : [],
  );
  return { graph, component, nodes, edges };
}

/** Every graph a shipped file holds, root first, then its embedded components in file order. */
export function auditedGraphs(fileText: string): AuditedGraph[] {
  const file = JSON.parse(fileText) as StoredFile;
  const names = componentNamesOf(file);
  const graphs: AuditedGraph[] = [];
  if (file.graph !== undefined) graphs.push(audited("root", null, file.graph, names));
  for (const component of file.componentLibrary?.components ?? []) {
    if (component.graph === undefined) continue;
    const id = String(component.componentId);
    graphs.push(
      audited(
        `component ${id}`,
        { id, version: Number(component.version), name: typeof component.name === "string" ? component.name : id },
        component.graph,
        names,
      ),
    );
  }
  return graphs;
}

/** The named nodes of this file whose name does not carry their type's kind, in a stable order. */
export function unconformingNames(fileText: string): UnconformingName[] {
  const found: UnconformingName[] = [];
  for (const { graph, nodes } of auditedGraphs(fileText)) {
    for (const node of nodes) {
      if (node.name === undefined || !node.bound) continue;
      if (!conformsToKind(node.name, node.kind)) found.push({ graph, nodeId: node.id, type: node.type, name: node.name, kind: node.kind });
    }
  }
  return found;
}

/** How many named nodes a file holds that the convention binds: the denominator, for the report. */
export function boundNameCount(fileText: string): number {
  let count = 0;
  for (const { nodes } of auditedGraphs(fileText)) {
    for (const node of nodes) if (node.name !== undefined && node.bound) count += 1;
  }
  return count;
}
