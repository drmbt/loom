import type { NodeId } from "../types/ids.ts";
import { COMPONENT_ID_SEPARATOR, flattenedNodeId } from "./internal-resolutions.ts";

/**
 * T1695b — THE ONE PLACE A NODE OF AN INSTANCE IS ADDRESSED FROM OUTSIDE IT.
 *
 * A node inside a component has two names. Inside the definition it is its own id (`fb`).
 * In the flattened document, which is what the plan, the backend and every runtime table
 * key on, it is that id under the chain of instances it was reached through (`two/fb`,
 * `outer/two/fb`). A command fired inside a component editor names the first and, when it
 * is about the running instance, must reach the second.
 *
 * Before this module eight roads made that crossing, each for one case, and six of them
 * joined or split the id with their own string code (`docs/component-session-commands-
 * design-2026-10-06.md` §1.6). `flat-id-joiner.test.ts` holds the list of the ones that are
 * left; it can only get shorter.
 *
 * ## Which path
 *
 * `ComponentPath` means two things under one type name (§T1216): the EDITOR's, a list of
 * instance node ids each living in the graph the one before it opened (`["a", "b"]`), and
 * the COMPILER's, the same chain accumulated (`["a", "a/b"]`). Joining the second with the
 * separator gives `a/a/b`, a lookup that finds nothing and says nothing. Everything here
 * takes the editor's, and the type's name says so.
 *
 * This holds under either component model. While a definition is edited apart from its
 * instances (a linked component), the path is how a session reaches the instance in view.
 * If a component is a folder of real nodes, the same function is what turns a place in the
 * tree into a node's name.
 */

/** Instance node ids from the root, innermost last; each lives in the graph the previous one opened. */
export type InstancePath = readonly NodeId[];

/** The flattened id of `nodeId` as the instance at the end of `path` holds it. An empty path is the root. */
export function toInstance(path: InstancePath, nodeId: NodeId): NodeId {
  let prefix = "";
  for (const instance of path) prefix = flattenedNodeId(prefix, instance);
  return flattenedNodeId(prefix, nodeId);
}

/**
 * Where a flattened id enters a graph: the instance node of that graph it passes through
 * first, and the rest of the id inside it. Undefined for an id with no path (a node of the
 * graph itself).
 */
export function enteredThrough(flatId: NodeId): { readonly instance: NodeId; readonly rest: NodeId } | undefined {
  const at = flatId.indexOf(COMPONENT_ID_SEPARATOR);
  if (at <= 0 || at === flatId.length - 1) return undefined;
  return { instance: flatId.slice(0, at), rest: flatId.slice(at + 1) };
}

/**
 * The inverse: the id a node of that instance has inside its definition, or undefined when
 * `flatId` is not a node of that instance (a root node, another instance's, or one nested
 * deeper inside it, which the definition in hand does not hold).
 */
export function fromInstance(path: InstancePath, flatId: NodeId): NodeId | undefined {
  if (path.length === 0) return flatId.includes(COMPONENT_ID_SEPARATOR) ? undefined : flatId;
  const prefix = `${toInstance(path.slice(0, -1), path[path.length - 1] as NodeId)}${COMPONENT_ID_SEPARATOR}`;
  if (!flatId.startsWith(prefix)) return undefined;
  const rest = flatId.slice(prefix.length);
  return rest === "" || rest.includes(COMPONENT_ID_SEPARATOR) ? undefined : rest;
}

/**
 * VN35 — A NODE REACHED BY NAME ACROSS INSTANCES (proposal 01 §4 stage 1).
 *
 * The flattened id above is the MACHINE's address of a node inside an instance, built from
 * ids. A path is the AUTHOR's: the same walk spelled in node names, which is what an
 * `op('…')` and a source reference hold. `projector_left/projector_beam` is the node named
 * `projector_beam` inside the instance named `projector_left`, and `../camera_stage` is the
 * node named `camera_stage` in the graph that holds the referring node's instance.
 *
 * - A segment is a node's NAME as written in the graph it lives in: an internal's label in
 *   its DEFINITION, never the label B41's uniquing gave its flattened copy, which no author
 *   sees. An unnamed instance has no path, as an unnamed node has no name (§V127).
 * - Relative only. At the root a relative path is the absolute one, and inside a definition
 *   an absolute path would name a document the definition cannot know. A leading `/`, an
 *   empty segment, and a `..` after a name are malformed.
 * - A name holding no separator is a bare name and is not a path: it keeps the rules it had.
 */
export const NODE_PATH_UP = "..";

export interface NodePath {
  /** How many graphs to climb before the names apply. */
  readonly up: number;
  /** The names to walk down, the node's own last. Never empty. */
  readonly names: readonly string[];
}

/** True when a reference is written as a path rather than as a bare name. */
export function isNodePath(text: string): boolean {
  return text.includes(COMPONENT_ID_SEPARATOR);
}

/** The path a reference spells, or undefined when it is malformed. A bare name parses as a one-name path. */
export function parseNodePath(text: string): NodePath | undefined {
  const segments = text.split(COMPONENT_ID_SEPARATOR);
  let up = 0;
  while (segments[up] === NODE_PATH_UP) up += 1;
  const names = segments.slice(up);
  if (names.length === 0 || names.some((name) => name === "" || name === NODE_PATH_UP)) return undefined;
  return { up, names };
}

export function formatNodePath(path: NodePath): string {
  return [...Array<string>(path.up).fill(NODE_PATH_UP), ...path.names].join(COMPONENT_ID_SEPARATOR);
}

/**
 * §V128 for a path: the reference with its FIRST name renamed, when that name is a node of
 * the graph the reference is written in (a path that does not climb). Undefined when the
 * rename does not touch it: a bare name (the caller's own clause), a path that climbs, or a
 * path through another node. A name further down lives in a definition and is that
 * definition's to rename.
 */
export function renamedPathHead(text: string, oldName: string, newName: string): string | undefined {
  if (!isNodePath(text)) return undefined;
  const path = parseNodePath(text);
  if (path === undefined || path.up > 0 || path.names[0] !== oldName) return undefined;
  return formatNodePath({ up: 0, names: [newName, ...path.names.slice(1)] });
}

/**
 * One graph of the flattening, as names see it. The root's key is `""`; an inlined
 * instance's is its flattened id, which is the prefix its own nodes carry.
 */
export interface NameScope {
  /** The graph holding this one's instance; undefined at the root. */
  readonly parent: string | undefined;
  /** The instance's own name in `parent`; undefined at the root and for an unnamed instance. */
  readonly label: string | undefined;
  /** Each name in this graph: a flattened node, or an inlined instance's scope key. */
  readonly names: ReadonlyMap<string, { readonly node: NodeId } | { readonly scope: string }>;
}
export type NameScopes = ReadonlyMap<string, NameScope>;

export type PathResolution =
  | { readonly ok: true; readonly nodeId: NodeId }
  | { readonly ok: false; readonly reason: string };

/** Walks `path` from the graph `from`, name by name. Each refusal says where the walk stopped. */
export function resolveNodePath(path: NodePath, from: string, scopes: NameScopes): PathResolution {
  let at = scopes.get(from);
  for (let climb = 0; climb < path.up; climb += 1) {
    if (at?.parent === undefined) return { ok: false, reason: "it climbs above the document's root" };
    at = scopes.get(at.parent);
  }
  for (let index = 0; index < path.names.length; index += 1) {
    const name = path.names[index] as string;
    const entry = at?.names.get(name);
    const last = index === path.names.length - 1;
    if (entry === undefined) {
      return { ok: false, reason: `no node is named "${name}" ${index === 0 && path.up === 0 ? "beside it" : "there"}` };
    }
    if (last) {
      if ("node" in entry) return { ok: true, nodeId: entry.node };
      return { ok: false, reason: `"${name}" is a component instance; name a node inside it` };
    }
    if (!("scope" in entry)) return { ok: false, reason: `"${name}" is not a component instance, so nothing is inside it` };
    at = scopes.get(entry.scope);
  }
  return { ok: false, reason: "it names nothing" };
}

/** True when `scope` is `ancestor` or lies inside it. */
export function isWithinScope(scope: string, ancestor: string, scopes: NameScopes): boolean {
  for (let at: string | undefined = scope; at !== undefined; at = scopes.get(at)?.parent) {
    if (at === ancestor) return true;
  }
  return false;
}

/**
 * The path a node in `from` writes to reach `name` in the graph `to`: climb to the graph
 * both lie in, then name the instances down. Undefined when an instance on the way has no
 * name, so no path can be written.
 */
export function pathBetween(from: string, to: string, name: string, scopes: NameScopes): string | undefined {
  let up = 0;
  let common = from;
  while (!isWithinScope(to, common, scopes)) {
    const parent = scopes.get(common)?.parent;
    if (parent === undefined) return undefined;
    common = parent;
    up += 1;
  }
  const down: string[] = [];
  for (let at = to; at !== common; ) {
    const scope = scopes.get(at);
    if (scope?.label === undefined || scope.parent === undefined) return undefined;
    down.unshift(scope.label);
    at = scope.parent;
  }
  return formatNodePath({ up, names: [...down, name] });
}
