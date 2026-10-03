import type { GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { ParameterMode, ParameterSchema, ParameterValue, StoredParameter } from "../types/parameters.ts";
import type { ResolvedParameters } from "../parameters/resolve.ts";
import { storedValues } from "../parameters/stored-values.ts";

/**
 * B238 — the published page of ONE instance, in the two shapes its internals are written
 * from. Moved here from `compiler/flatten.ts` unchanged so that the two writers of an
 * instance's page onto its internal parameters — flattening (§V80, every compile) and
 * `component.detach` (once, into real nodes) — decide it in ONE place. Two copies of this
 * decision is B8's shape again: a detach that wrote the definition's values instead of the
 * page's was B238.
 */

/** The published parameter page of a component, as a parameter schema. */
export function publishedSchema(definition: GraphComponentDefinition): ParameterSchema {
  const schema: ParameterSchema = {};
  for (const published of definition.parameters) schema[published.key] = published.definition;
  return schema;
}

/**
 * The published modes that mean the same thing wherever the slot is evaluated (T1017).
 *
 * `expression` reads `time`/`frame` and `op('name')`, and after flattening every name in
 * the document lives in ONE flat graph whose labels B41 already made unique — so the
 * expression resolves to the same node from the instance or from the internal parameter
 * it drives. `driven` names a channel, which is the same global namespace (§V129).
 *
 * `bind` is deliberately absent and it is the whole reason this is a whitelist rather
 * than "anything that is a slot": a bind ref is RELATIVE. `parent.gain` written on the
 * instance means the component that owns the INSTANCE; the same text carried one level
 * inward would mean the instance itself, silently reading a different knob. A sibling
 * ref moves the same way. So a bind is resolved where its scope is — the instance's own
 * level, in the flattener and in `component.detach` alike — and its value is what fans out. `static` and `map` cannot move per frame at all (T988, §V287), so
 * there is nothing to defer.
 */
export const HOP_INVARIANT_MODES: ReadonlySet<ParameterMode> = new Set<ParameterMode>(["expression", "driven"]);

/**
 * The two shapes of one instance's published page, built TOGETHER from one resolution.
 *
 * ## Why both, and why from one call (T1017, §V837, T1000)
 *
 * §V80's fan-out and §V81's lexical scope are fed by the same page and need it in
 * different shapes, and the last three instances of §V837 were all "one of two things
 * built at a different moment than the other". So there is one `resolveNodeParameters`
 * and one function that projects it, rather than a resolved page here and a stored page
 * computed at the call site — which is how "at which moment" gets set on one and
 * forgotten on the other.
 *
 *  - `values` — STORED space, every key a plain value. What `buildParentScope` reads,
 *    because a `ParentScope` is a value lookup: `parentBindResolver` and
 *    `parentScopeDrivers` both hand their answer straight to `validateParameterValue`.
 *  - `stored` — what §V80 writes onto internal parameters. Identical to `values` EXCEPT
 *    for a key whose active mode is hop-invariant AND which actually drives a target:
 *    that key keeps its SLOT, unresolved, so the internal parameter carries the
 *    expression or the channel and the ordinary per-frame values-only resolution (§V163)
 *    evaluates it at the frame, against the flat graph, through the one read path (§V61).
 *
 * ## Why a slot rather than a per-frame re-flattening
 *
 * This is §V5's split applied one layer up. The STRUCTURE a component flattens to —
 * which nodes, which edges, which resources — depends only on the document, which is why
 * `flattenComponents` is memoized on the document revision (§V529: it costs 5–7× the
 * value graph it feeds, and per-frame flattening made the correct version 1.4× SLOWER
 * than the broken one). Only the VALUE moves per frame. Handing the slot down means the
 * value is evaluated where every other animated parameter's is — in `validateGraph`, on
 * the flat graph, with the frame and the channel resolver already in hand — so animating
 * a published knob costs the flattener nothing at all.
 *
 * ## Why this cannot bring back B8's double decode
 *
 * The §V56 hazard is a display-space number decoded TWICE, and it needs a RESOLVED value
 * to happen: T307 kept this boundary on `entries[].value` (display-encoded) rather than
 * `values` (already decoded to linear) precisely so a picked mid-grey reaches the shader
 * at 0.2140 and not 0.0376 (B8, T187). Both halves above preserve that. `values` is
 * `storedValues(...)`, unchanged. `stored` substitutes the UNRESOLVED slot — a number
 * that has not been resolved cannot have been decoded, and the internal parameter it
 * lands on decodes exactly once, like any slot a user typed there directly. A compound
 * published per component (`tint.r`, §V113) has no slot at the bare key, so it takes the
 * `values` path unchanged and its decode count is untouched.
 */
export interface PublishedPage {
  /** STORED space, fully resolved. The `parent.<key>` scope (§V81) reads this. */
  readonly values: Record<string, ParameterValue>;
  /** What §V80 fans out onto internal parameters; animated keys stay slots. */
  readonly stored: Record<string, StoredParameter>;
  /**
   * Diagnostics belonging to the deferred keys, to be DROPPED at this level.
   *
   * A key whose slot travels inward is not decided here, so neither is its verdict: the
   * flattener has no frame, no channel resolver and no reader, and reporting from that
   * position produced exactly the false alarms T1017 measured — `op()` warned and a
   * clock read 0 — about parameters that are about to resolve correctly at every target.
   * Identity, not text: these are the very objects `resolveNodeParameters` pushed.
   */
  readonly deferred: ReadonlySet<RuntimeDiagnostic>;
}

export function publishedPage(
  resolved: ResolvedParameters,
  definition: GraphComponentDefinition,
): PublishedPage {
  // Only a knob that DRIVES something may defer: a published parameter with no targets
  // exists purely for `parent.<key>` (§V81), so its value is read here or nowhere, and
  // deferring it would silence a real diagnostic with nothing downstream to restate it.
  const driving = new Set<string>();
  for (const published of definition.parameters) {
    if (published.targets.length > 0) driving.add(published.key);
  }

  // THE un-decoded page, asked for the one way there is to ask (§V56, T307). `stored` is
  // a DELTA on it rather than a second walk of the same entries: a parallel loop here
  // would be a third caller inventing a third answer, which is the exact thing
  // `storedValues` exists to prevent.
  const values = storedValues(resolved);
  const stored: Record<string, StoredParameter> = { ...values };
  const deferred = new Set<RuntimeDiagnostic>();
  for (const entry of resolved.entries) {
    if (!driving.has(entry.key) || entry.slot === undefined) continue;
    if (!HOP_INVARIANT_MODES.has(entry.mode)) continue;
    stored[entry.key] = entry.slot;
    if (entry.diagnostic !== null) deferred.add(entry.diagnostic);
  }
  return { values, stored, deferred };
}
