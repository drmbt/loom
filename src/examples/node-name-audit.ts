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

interface StoredGraph {
  readonly nodes?: Readonly<Record<string, { readonly type?: unknown; readonly label?: unknown }>>;
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

/** Every graph a shipped file holds, root first, then its embedded components in file order. */
function graphsOf(file: StoredFile): Array<readonly [string, StoredGraph]> {
  const graphs: Array<readonly [string, StoredGraph]> = [];
  if (file.graph !== undefined) graphs.push(["root", file.graph]);
  for (const component of file.componentLibrary?.components ?? []) {
    if (component.graph !== undefined) graphs.push([`component ${String(component.componentId)}`, component.graph]);
  }
  return graphs;
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

/** The named nodes of this file whose name does not carry their type's kind, in a stable order. */
export function unconformingNames(fileText: string): UnconformingName[] {
  const file = JSON.parse(fileText) as StoredFile;
  const componentNames = componentNamesOf(file);
  const found: UnconformingName[] = [];
  for (const [graph, stored] of graphsOf(file)) {
    for (const nodeId of Object.keys(stored.nodes ?? {}).sort()) {
      const node = stored.nodes?.[nodeId];
      if (typeof node?.type !== "string" || typeof node.label !== "string") continue;
      if (!kindBindsName(node.type)) continue;
      const kind = kindIn(node.type, componentNames);
      if (!conformsToKind(node.label, kind)) found.push({ graph, nodeId, type: node.type, name: node.label, kind });
    }
  }
  return found;
}

/** How many named nodes a file holds that the convention binds: the denominator, for the report. */
export function boundNameCount(fileText: string): number {
  let count = 0;
  for (const [, stored] of graphsOf(JSON.parse(fileText) as StoredFile)) {
    for (const node of Object.values(stored.nodes ?? {})) {
      if (typeof node.type === "string" && typeof node.label === "string" && kindBindsName(node.type)) count += 1;
    }
  }
  return count;
}
