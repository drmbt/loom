import { formatParentRead, parentReadsOf, rewriteParentReads, type ParentRead } from "../domain/expressions/index.ts";
import { nearestSpelling } from "../domain/expressions/index.ts";
import { isParameterSlot, storedStaticValue } from "../domain/parameters/slots.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { ParameterSchema, StoredParameter } from "../domain/types/parameters.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";

/**
 * VN36 — `parent(n).par.key` BECOMES `op('<the n-th enclosing instance>').par.key`, here.
 *
 * The per-frame evaluator runs on the flat graph, where no node knows which component it was
 * in, so a `parent()` read is resolved where the scope exists: in the flattener, level by
 * level. What it resolves to is a NAME, not a value. The instance is dissolved, and its page
 * survives as `FlattenedGraph.instancePages`, which the `op()` reader reads per frame
 * (`node-references.ts`). So an animated knob is evaluated once, at its publisher, an edit to
 * it reaches every reader with the next flattening, and this walk stays a pure function of
 * the document (§V529).
 *
 * The same rule as §V81: the read goes through the published page (§V80) and only that. A key
 * the page does not publish is refused HERE, where the page is known, rather than per frame.
 *
 * WHY HERE AND NOT IN VN35'S PASS (`path-references.ts`), which runs once over the finished
 * flattening. A page slot that animates is carried INWARD onto its targets (T1017) before
 * that pass runs, and a `parent()` in it means the component around the INSTANCE. Carried
 * as text, it would be resolved from the target's scope, one level too deep. Resolved here,
 * as the instance's own parameters are made, it is carried as a name, which means the same
 * thing at every depth.
 *
 * A read that resolves nothing is reported and the parameter falls back to its retained
 * static value (§V108), exactly as a failing `parent.` bind does in `effectiveParameters`:
 * one problem, one diagnostic, never a read of 0.
 */

/** One enclosing instance, as a `parent()` read from inside it sees it. */
export interface EnclosingInstance {
  /** Its name in the flattening: what `op()` and `instancePages` know it by. */
  readonly label: string | undefined;
  /** Its published page, or undefined when its component is not installed. */
  readonly schema: ParameterSchema | undefined;
}

/**
 * `parameters` with every active expression's `parent()` reads rewritten against `chain`
 * (the enclosing instances, OUTERMOST FIRST, the last owning the node). Returns the record
 * it was given when nothing reads `parent()`.
 */
export function resolveParentReferences(
  parameters: Record<string, StoredParameter>,
  chain: readonly EnclosingInstance[],
  report: (diagnostic: RuntimeDiagnostic) => void,
): Record<string, StoredParameter> {
  let rewritten: Record<string, StoredParameter> | undefined;
  for (const key of Object.keys(parameters).sort()) {
    const stored = parameters[key];
    if (stored === undefined || !isParameterSlot(stored) || stored.mode !== "expression") continue;
    const binding = stored.bindings.expression;
    if (binding?.kind !== "expression") continue;
    const reads = parentReadsOf(binding.source);
    if (reads.length === 0) continue;

    const refusal = reads.map((read) => refusalOf(read, chain)).find((each) => each !== undefined);
    rewritten ??= { ...parameters };
    if (refusal !== undefined) {
      report(
        compilerDiagnostic("warning", refusal.code, `"${key}" reads ${formatParentRead(refusal.read)}: ${refusal.message}`, {
          suggestion: `${refusal.suggestion} Until then "${key}" holds its static value (§V108).`,
        }),
      );
      const retained = storedStaticValue(stored);
      if (retained === undefined) delete rewritten[key];
      else rewritten[key] = retained;
      continue;
    }
    const source = rewriteParentReads(binding.source, (read) => {
      const owner = chain[chain.length - read.hops];
      return `op('${owner?.label ?? ""}').${["par", read.key, ...(read.component === undefined ? [] : [read.component])].join(".")}`;
    });
    rewritten[key] = { ...stored, bindings: { ...stored.bindings, expression: { kind: "expression", source } } };
  }
  return rewritten ?? parameters;
}

interface Refusal {
  readonly read: ParentRead;
  readonly code: (typeof CompilerDiagnosticCode)["parentReferenceNoParent" | "parentReferenceUnknownKey"];
  readonly message: string;
  readonly suggestion: string;
}

function refusalOf(read: ParentRead, chain: readonly EnclosingInstance[]): Refusal | undefined {
  if (chain.length === 0) {
    return {
      read,
      code: CompilerDiagnosticCode.parentReferenceNoParent,
      message: "this node is not inside a component, so there is no parent to read.",
      suggestion: "Move the node into a component, or read the parameter by name with op('<name>').par.<key>.",
    };
  }
  if (read.hops > chain.length) {
    return {
      read,
      code: CompilerDiagnosticCode.parentReferenceNoParent,
      message: `this node is ${chain.length} component${chain.length === 1 ? "" : "s"} deep, so parent(${read.hops}) reaches past the outermost one.`,
      suggestion: `Count from 1 for the component the node is in, up to parent(${chain.length}).`,
    };
  }
  const owner = chain[chain.length - read.hops];
  if (owner === undefined || owner.label === undefined) {
    return {
      read,
      code: CompilerDiagnosticCode.parentReferenceNoParent,
      message: "the component instance it names has no name to read it by.",
      suggestion: "Name the instance.",
    };
  }
  // An uninstalled component is reported where it stands (`component-missing`), and nothing
  // inside it flattens, so there is no read from inside it to refuse.
  const schema = owner.schema ?? {};
  if (!Object.hasOwn(schema, read.key)) {
    const published = Object.keys(schema).sort();
    const near = nearestSpelling(read.key, published);
    return {
      read,
      code: CompilerDiagnosticCode.parentReferenceUnknownKey,
      message: `the component "${owner.label}" publishes no parameter "${read.key}"${published.length === 0 ? " (it publishes none)" : ""}.`,
      suggestion:
        published.length === 0
          ? `Publish "${read.key}" on the component.`
          : `${near === null ? "" : `Nearest: "${near}". `}It publishes: ${published.join(", ")}.`,
    };
  }
  return undefined;
}
