import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSchema, StoredParameter } from "../types/parameters.ts";
import { resolveParameterSchema } from "../parameters/resolve.ts";
import { isParameterSlot, storedStaticValue, withBinding } from "../parameters/slots.ts";
import { effectiveInternalOverrides } from "./flatten.ts";
import { PARENT_BINDINGS_STATE_KEY, internalParameterPath, parseInternalParameterPath, readComponentInstance, readParentBindings } from "./instance.ts";
import { buildParentScope, formatParentReference, parentBindResolver, parentScopeDrivers, parseParentReference } from "./parent-scope.ts";
import { publishedPage, publishedSchema } from "./published-page.ts";

/**
 * B238 — WHAT A DETACHED COPY HOLDS: the values the instance's page put on screen, not the
 * definition's.
 *
 * Flattening never writes an instance's page into the document: every compile writes it
 * onto the internal parameters of the flat graph (§V80, §V81, `compiler/flatten.ts`).
 * Detach turns those internals into real nodes, so it must write, ONCE, what flattening
 * writes every compile — or the copies show the definition's 4 where the instance showed
 * its own 2. The rule is flattening's, and the parts that decide it are shared, not
 * restated: the page is resolved by the same `resolveParameterSchema` call and projected
 * by the same `publishedPage`, the fan-out is `effectiveInternalOverrides`, and every
 * `parent.<key>` read goes through `parentBindResolver` / `parentScopeDrivers`.
 *
 * ## Per slot kind
 *
 * Published fan-out (the instance's page value for a key, onto every target it drives;
 * the instance's own `componentOverrides` win over it, exactly as in flattening):
 *
 *  - an EXPRESSION or CHANNEL read (`driven`) on a key that drives something travels as
 *    the instance's own slot, unresolved (§T1017's hop-invariant modes): `op('name')`,
 *    `time` and a channel mean the same from the copy as from the instance. Written after
 *    detach's own B41 renames, so a name the instance's expression reads keeps naming the
 *    node it named;
 *  - a STATIC, a `map`, a compound set per component (`tint.r` — assembled) and a SIBLING
 *    `bind` (relative to the instance's page, so it would name another knob on the copy)
 *    are written as the resolved value, in stored space — `publishedPage.stored`;
 *  - a `parent.<key>` BIND on the instance's page is the one exception to flattening's
 *    bake, and it is still the same rule: flattening resolves it where its scope is, the
 *    instance's own level, and the copies land AT that level. So the slot is carried as
 *    written and resolves against the very scope the instance read. (At the root nothing
 *    is in scope, and both sides fall back to the slot's retained static, §V108.)
 *
 * A `parent.<key>` read INSIDE the definition (a bind slot, or `state.parentBindings`):
 *
 *  - one hop (`parent.k`, the instance's own page) is baked to the value flattening reads
 *    — or to the instance's carried `parent.` slot for `k`, by the exception above; an
 *    unresolvable one falls back as flattening's does (the retained static; a legacy
 *    binding leaves the stored value). A legacy binding the published value outranks is
 *    dropped, since flattening ignores it;
 *  - two hops or more reached PAST the instance, and the copies sit one level further
 *    out, so the ref loses one `parent.`: `parent.parent.gain` → `parent.gain`.
 *
 * Nested instances inside the definition stay instances: their pages are written by the
 * rules above and keep driving their own internals. A ref inside a NESTED definition that
 * reaches past its own component cannot be rewritten without editing that shared
 * definition, so it is said (`nestedParentReads`), not guessed.
 */

export interface DetachedValues {
  /**
   * The copy of internal node `internalId`, holding what flattening wrote there, and how
   * many of its parameters read the instance's page through `parent.<key>` and were baked.
   */
  copy(internalId: NodeId, node: GraphNode): { readonly node: GraphNode; readonly baked: number };
}

export interface DetachedValuesInput {
  readonly definition: GraphComponentDefinition;
  readonly instance: GraphNode;
  /** A copied node's parameter schema, for a legacy `parent.<key>` binding (flattening's `schema`). */
  readonly schemaOf: (node: GraphNode) => ParameterSchema | undefined;
}

/** The ref of a `bind`-mode slot reading `parent.*`, or undefined. */
function parentBindRef(stored: StoredParameter | undefined): string | undefined {
  if (!isParameterSlot(stored) || stored.mode !== "bind") return undefined;
  const binding = stored.bindings.bind;
  return binding?.kind === "bind" && binding.ref.startsWith("parent.") ? binding.ref : undefined;
}

export function detachedValues(input: DetachedValuesInput): DetachedValues {
  const { definition, instance } = input;
  // The page, resolved and projected exactly as flattening resolves and projects it. No
  // scope: whatever an instance-level `parent.` bind would read is carried, not resolved.
  const page = publishedPage(resolveParameterSchema(instance, publishedSchema(definition)), definition);
  const pageScope = buildParentScope([page.values]);
  const resolveRef = parentBindResolver(pageScope);

  /** Internal path → what flattening writes there: the fan-out, then the instance's own overrides. */
  const written = effectiveInternalOverrides(definition, instance, page.stored);
  /** Published key → the instance's `parent.` bind on it, carried rather than resolved. */
  const carriedByKey = new Map<string, StoredParameter>();
  for (const published of definition.parameters) {
    const stored = instance.parameters[published.key];
    if (parentBindRef(stored) !== undefined) carriedByKey.set(published.key, stored as StoredParameter);
  }
  const own = readComponentInstance(instance)?.overrides ?? {};
  /** Internal path → a carried slot, in the fan-out's order (a later published key wins a shared target). */
  const carried: Record<string, StoredParameter> = {};
  for (const published of definition.parameters) {
    for (const target of published.targets) {
      const path = internalParameterPath(target.nodeId, target.key);
      if (path in own) continue;
      const slot = carriedByKey.get(published.key);
      if (slot === undefined) delete carried[path];
      else carried[path] = slot;
    }
  }

  const byNode = new Map<NodeId, Array<[string, StoredParameter]>>();
  for (const path of Object.keys(written).sort()) {
    const parsed = parseInternalParameterPath(path);
    const value = written[path];
    if (parsed === null || value === undefined) continue;
    const list = byNode.get(parsed.nodeId) ?? [];
    byNode.set(parsed.nodeId, list);
    list.push([parsed.key, carried[path] ?? value]);
  }

  const copy = (internalId: NodeId, node: GraphNode): { node: GraphNode; baked: number } => {
    let baked = 0;
    const fanned = byNode.get(internalId) ?? [];
    const fannedKeys = new Set(fanned.map(([key]) => key));
    const parameters: Record<string, StoredParameter> = { ...node.parameters };
    for (const [key, value] of fanned) parameters[key] = value;

    // `parent.*` bind slots — the definition's own and any the instance's overrides wrote —
    // read at the INNER level, where flattening reads them. A carried fan-out slot is
    // relative to the instance's level and is not one of them.
    for (const key of Object.keys(parameters).sort()) {
      const stored = parameters[key];
      const ref = parentBindRef(stored);
      if (ref === undefined || !isParameterSlot(stored)) continue;
      const path = internalParameterPath(internalId, key);
      if (fannedKeys.has(key) && carried[path] !== undefined) continue;
      const reference = parseParentReference(ref);
      if (reference !== null && reference.hops > 1) {
        parameters[key] = withBinding(stored, { kind: "bind", ref: formatParentReference({ hops: reference.hops - 1, key: reference.key }) });
        continue;
      }
      const passed = reference === null ? undefined : carriedByKey.get(reference.key);
      if (passed !== undefined) {
        parameters[key] = passed;
        continue;
      }
      const lookup = resolveRef(ref);
      if (lookup.ok) {
        parameters[key] = lookup.value;
        baked += 1;
        continue;
      }
      const retained = storedStaticValue(stored);
      if (retained === undefined) delete parameters[key];
      else parameters[key] = retained;
    }

    // Legacy `state.parentBindings` (§V81), after the slots, as flattening orders them.
    const bindings = readParentBindings(node);
    if (Object.keys(bindings).length === 0) return { node: { ...node, parameters }, baked };
    const kept: Record<string, string> = {};
    const drivers = parentScopeDrivers(node, pageScope);
    const schema = input.schemaOf(node);
    for (const key of Object.keys(bindings).sort()) {
      const raw = bindings[key] as string;
      const reference = parseParentReference(raw);
      if (reference === null) {
        kept[key] = raw;
        continue;
      }
      if (reference.hops > 1) {
        kept[key] = formatParentReference({ hops: reference.hops - 1, key: reference.key });
        continue;
      }
      // Flattening lets the published value win over a binding on the same key.
      if (fannedKeys.has(key)) continue;
      const passed = carriedByKey.get(reference.key);
      if (passed !== undefined) {
        parameters[key] = passed;
        continue;
      }
      const parameterDefinition = schema?.[key];
      if (parameterDefinition === undefined) continue;
      const driven = drivers[key]?.({ node, key, definition: parameterDefinition });
      if (driven === undefined) continue;
      parameters[key] = driven;
      baked += 1;
    }
    const state: Record<string, unknown> = { ...node.state };
    delete state[PARENT_BINDINGS_STATE_KEY];
    if (Object.keys(kept).length > 0) state[PARENT_BINDINGS_STATE_KEY] = kept;
    const next: GraphNode = { ...node, parameters, state };
    if (Object.keys(state).length === 0) delete next.state;
    return { node: next, baked };
  };

  return { copy };
}

/**
 * Nested instances in `graph` whose definitions — at any depth — read past their own
 * component with `parent.parent…`. Detach moves the nested instance one level out, so such
 * a read would name one component further out; it lives in a shared definition and is
 * reported rather than rewritten. Returns the nested instance ids, sorted.
 */
export function nestedParentReads(
  graph: GraphDocument,
  definitionOf: (node: GraphNode) => GraphComponentDefinition | undefined,
): NodeId[] {
  const readsPast = (inner: GraphDocument, depth: number): boolean =>
    Object.values(inner.nodes).some((node) => {
      const refs = [
        ...Object.values(node.parameters).map(parentBindRef),
        ...Object.values(readParentBindings(node)),
      ];
      if (refs.some((ref) => ref !== undefined && (parseParentReference(ref)?.hops ?? 0) > depth)) return true;
      const nested = readComponentInstance(node) === null ? undefined : definitionOf(node);
      return nested !== undefined && readsPast(nested.graph, depth + 1);
    });
  const found: NodeId[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId] as GraphNode;
    const nested = readComponentInstance(node) === null ? undefined : definitionOf(node);
    if (nested !== undefined && readsPast(nested.graph, 1)) found.push(nodeId);
  }
  return found;
}
