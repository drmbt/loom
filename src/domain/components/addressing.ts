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
