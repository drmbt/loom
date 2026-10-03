import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSchema, StoredParameter } from "../types/parameters.ts";
import { resolveParameterSchema } from "../parameters/resolve.ts";
import { isParameterSlot, parseComponentKey, storedStaticValue, withBinding } from "../parameters/slots.ts";
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
 * B239 widens the carried exception to everything flattening resolves ON THE INSTANCE
 * before projecting its page (`Carry`): a legacy `state.parentBindings` entry on the
 * instance is carried as a legacy binding on the copies (the stored value stays as its
 * fallback), a sibling bind takes whatever its sibling carries, and inside a component edit
 * session an outer published knob that drove a page key drives the copies instead
 * (`MovedOuterTarget`; a one-hop read of that key becomes `parent.<outer key>`).
 *
 * Nested instances inside the definition stay instances: their pages are written by the
 * rules above and keep driving their own internals. A ref inside a NESTED definition that
 * reaches past its own component cannot be rewritten without editing that shared
 * definition, so it is said (`nestedParentReads`), not guessed.
 */

/**
 * B239 — an OUTER published target moved onto a copy: the outer component's `outerKey`
 * drove the instance's page key `pageKey`, and now drives the copy's `key` directly.
 */
export interface MovedOuterTarget {
  readonly outerKey: string;
  readonly pageKey: string;
  readonly nodeId: NodeId;
  readonly key: string;
}

export interface DetachedValues {
  /**
   * The copy of internal node `internalId`, holding what flattening wrote there; how many
   * of its parameters read the instance's page through `parent.<key>` and were baked; and
   * the outer published targets that now land on it (B239).
   */
  copy(internalId: NodeId, node: GraphNode): {
    readonly node: GraphNode;
    readonly baked: number;
    readonly moved: readonly MovedOuterTarget[];
  };
  /** Page reads that cannot be carried exactly, each said by name (B239). */
  readonly inexact: readonly string[];
}

export interface DetachedValuesInput {
  readonly definition: GraphComponentDefinition;
  readonly instance: GraphNode;
  /** A copied node's parameter schema, for a legacy `parent.<key>` binding (flattening's `schema`). */
  readonly schemaOf: (node: GraphNode) => ParameterSchema | undefined;
  /**
   * B239 — inside a component edit session: page key → the outer component's published
   * keys that target it, in the outer page's order (a later one wins, as in flattening).
   * Absent at the root, where nothing publishes onto the instance.
   */
  readonly outerTargets?: ReadonlyMap<string, readonly string[]>;
}

/**
 * B239 — where one page key takes its value from when that is NOT the instance's own
 * stored value: what flattening resolves on the instance node, in its order, before the
 * page is projected (`effectiveParameters`). The outer component's fan-out onto the key
 * wins, then a legacy `state.parentBindings` entry, then a `parent.` bind slot; a sibling
 * bind reads its sibling after all of that, so it takes the sibling's source. Each is
 * carried onto the copies — which land at the instance's own level, where those reads
 * resolve — rather than baked to what the instance holds without its scope.
 */
type Carry =
  | { readonly kind: "slot"; readonly slot: StoredParameter }
  | { readonly kind: "legacy"; readonly ref: string }
  | { readonly kind: "outer"; readonly keys: readonly string[] };

/** The ref of a `bind`-mode slot reading `parent.*`, or undefined. */
function parentBindRef(stored: StoredParameter | undefined): string | undefined {
  if (!isParameterSlot(stored) || stored.mode !== "bind") return undefined;
  const binding = stored.bindings.bind;
  return binding?.kind === "bind" && binding.ref.startsWith("parent.") ? binding.ref : undefined;
}

export function detachedValues(input: DetachedValuesInput): DetachedValues {
  const { definition, instance } = input;
  const schema = publishedSchema(definition);
  // The page, resolved and projected exactly as flattening resolves and projects it. No
  // scope: whatever an instance-level `parent.` read would see is carried, not resolved.
  const page = publishedPage(resolveParameterSchema(instance, schema), definition);
  const pageScope = buildParentScope([page.values]);
  const resolveRef = parentBindResolver(pageScope);
  const inexact: string[] = [];
  const look = instance.label ?? instance.id;

  /** Internal path → what flattening writes there: the fan-out, then the instance's own overrides. */
  const written = effectiveInternalOverrides(definition, instance, page.stored);

  // B239: each page key's carried source, sibling chains followed (cycle-guarded, like the
  // resolver's own bind walk).
  const legacy = readParentBindings(instance);
  const carryOf = (key: string, seen: Set<string>): Carry | undefined => {
    if (seen.has(key)) return undefined;
    seen.add(key);
    const outer = input.outerTargets?.get(key);
    if (outer !== undefined && outer.length > 0) return { kind: "outer", keys: outer };
    const raw = legacy[key];
    if (raw !== undefined && parseParentReference(raw) !== null) return { kind: "legacy", ref: raw };
    const stored = instance.parameters[key];
    if (parentBindRef(stored) !== undefined) return { kind: "slot", slot: stored as StoredParameter };
    if (!isParameterSlot(stored) || stored.mode !== "bind") return undefined;
    const binding = stored.bindings.bind;
    if (binding?.kind !== "bind") return undefined;
    if (Object.hasOwn(schema, binding.ref)) return carryOf(binding.ref, seen);
    // One channel of a carried sibling (`tint.r`) has no `parent.` spelling to carry.
    const component = parseComponentKey(binding.ref);
    if (component !== null && Object.hasOwn(schema, component.base) && carryOf(component.base, new Set(seen)) !== undefined) {
      inexact.push(`"${look}"'s ${key} reads ${binding.ref}, a channel of a knob set from outside "${look}"; the copies hold the value it reads without that scope`);
    }
    return undefined;
  };
  /** Published key → its carried source. */
  const carriedByKey = new Map<string, Carry>();
  for (const published of definition.parameters) {
    const carry = carryOf(published.key, new Set());
    if (carry !== undefined) carriedByKey.set(published.key, carry);
  }
  const own = readComponentInstance(instance)?.overrides ?? {};
  /** Internal path → the carry on it, in the fan-out's order (a later published key wins a shared target). */
  const carried: Record<string, { readonly carry: Carry; readonly pageKey: string }> = {};
  for (const published of definition.parameters) {
    for (const target of published.targets) {
      const path = internalParameterPath(target.nodeId, target.key);
      if (path in own) continue;
      const carry = carriedByKey.get(published.key);
      if (carry === undefined) delete carried[path];
      else carried[path] = { carry, pageKey: published.key };
    }
  }

  const byNode = new Map<NodeId, Array<[string, StoredParameter]>>();
  for (const path of Object.keys(written).sort()) {
    const parsed = parseInternalParameterPath(path);
    const value = written[path];
    if (parsed === null || value === undefined) continue;
    const list = byNode.get(parsed.nodeId) ?? [];
    byNode.set(parsed.nodeId, list);
    const carry = carried[path]?.carry;
    list.push([parsed.key, carry?.kind === "slot" ? carry.slot : value]);
  }

  /** The `parent.` ref a legacy or outer carry reads from the copies' level. */
  const carriedRef = (carry: Exclude<Carry, { kind: "slot" }>): string =>
    carry.kind === "legacy" ? carry.ref : formatParentReference({ hops: 1, key: carry.keys[carry.keys.length - 1] as string });

  const copy = (internalId: NodeId, node: GraphNode): { node: GraphNode; baked: number; moved: MovedOuterTarget[] } => {
    let baked = 0;
    const moved: MovedOuterTarget[] = [];
    const fanned = byNode.get(internalId) ?? [];
    const fannedKeys = new Set(fanned.map(([key]) => key));
    const parameters: Record<string, StoredParameter> = { ...node.parameters };
    /** B239: legacy bindings the copy gains — a carried page read, at the copies' level. */
    const added: Record<string, string> = {};
    for (const [key, value] of fanned) {
      parameters[key] = value;
      const entry = carried[internalParameterPath(internalId, key)];
      if (entry?.carry.kind === "legacy") added[key] = entry.carry.ref;
      if (entry?.carry.kind === "outer") {
        for (const outerKey of entry.carry.keys) moved.push({ outerKey, pageKey: entry.pageKey, nodeId: node.id, key });
      }
    }

    // `parent.*` bind slots — the definition's own and any the instance's overrides wrote —
    // read at the INNER level, where flattening reads them. A carried fan-out slot is
    // relative to the instance's level and is not one of them.
    for (const key of Object.keys(parameters).sort()) {
      const stored = parameters[key];
      const ref = parentBindRef(stored);
      if (ref === undefined || !isParameterSlot(stored)) continue;
      const path = internalParameterPath(internalId, key);
      if (fannedKeys.has(key) && carried[path]?.carry.kind === "slot") continue;
      const reference = parseParentReference(ref);
      if (reference !== null && reference.hops > 1) {
        parameters[key] = withBinding(stored, { kind: "bind", ref: formatParentReference({ hops: reference.hops - 1, key: reference.key }) });
        continue;
      }
      const passed = reference === null ? undefined : carriedByKey.get(reference.key);
      if (passed?.kind === "slot") {
        parameters[key] = passed.slot;
        continue;
      }
      if (passed?.kind === "outer") {
        // B239: the outer knob the page key took, read from where the copies sit.
        parameters[key] = withBinding(stored, { kind: "bind", ref: carriedRef(passed) });
        continue;
      }
      const lookup = resolveRef(ref);
      if (lookup.ok) {
        parameters[key] = lookup.value;
        // B239: a page key with a legacy binding of its own reads it from the copies' level;
        // the value it holds without that scope is the fallback, as on the instance.
        if (passed?.kind === "legacy") added[key] = passed.ref;
        else baked += 1;
        continue;
      }
      const retained = storedStaticValue(stored);
      if (retained === undefined) delete parameters[key];
      else parameters[key] = retained;
    }

    // Legacy `state.parentBindings` (§V81), after the slots, as flattening orders them.
    const bindings = readParentBindings(node);
    const kept: Record<string, string> = {};
    const drivers = parentScopeDrivers(node, pageScope);
    const nodeSchema = Object.keys(bindings).length === 0 ? undefined : input.schemaOf(node);
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
      if (passed?.kind === "slot") {
        parameters[key] = passed.slot;
        continue;
      }
      const parameterDefinition = nodeSchema?.[key];
      if (parameterDefinition === undefined) continue;
      // B239: a legacy or outer source is re-aimed rather than dropped; the value read
      // here stays as the fallback.
      if (passed !== undefined) kept[key] = carriedRef(passed);
      const driven = drivers[key]?.({ node, key, definition: parameterDefinition });
      if (driven === undefined) continue;
      parameters[key] = driven;
      if (passed === undefined) baked += 1;
    }
    for (const key of Object.keys(added)) kept[key] = added[key] as string;
    if (Object.keys(bindings).length === 0 && Object.keys(kept).length === 0) return { node: { ...node, parameters }, baked, moved };
    const state: Record<string, unknown> = { ...node.state };
    delete state[PARENT_BINDINGS_STATE_KEY];
    if (Object.keys(kept).length > 0) state[PARENT_BINDINGS_STATE_KEY] = kept;
    const next: GraphNode = { ...node, parameters, state };
    if (Object.keys(state).length === 0) delete next.state;
    return { node: next, baked, moved };
  };

  return { copy, inexact };
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
