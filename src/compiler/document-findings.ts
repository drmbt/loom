import type { ComponentRegistryView } from "../domain/components/index.ts";
import { diagnosticClass, type DiagnosticClass } from "../domain/diagnostics/classes.ts";
import { effectiveParameterSchema, resolveStored } from "../domain/parameters/resolve.ts";
import { parseComponentKey } from "../domain/parameters/slots.ts";
import { definitionOfKey, storedParameterFindings, undeclaredKeys, undeclaredParameter } from "../domain/parameters/validate.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../domain/types/graph.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { compileGraph } from "./compile.ts";
import { COMPONENT_ID_SEPARATOR, compiledWithoutCatalogue, flattenComponents, type FlattenedGraph } from "./flatten.ts";
import type { CompiledGraph } from "./types.ts";

/**
 * §T1641b slice 3 — WHAT A DOCUMENT AT REST HOLDS THAT IS NOT IN EFFECT AS WRITTEN.
 *
 * The bus refuses a stored thing that can never take effect at the command that writes it.
 * A document built by code never meets the bus (§B262 and §B264 both shipped that way): its
 * build script hands an object literal to the serializer, which checks nothing. This is the
 * bus's judgement asked of everything a document already stores, in one function, for the
 * callers that have a document and no command: a save by code, a load by code, a headless
 * render, the app's save, the shipped-set gate.
 *
 * It runs two things and reports their union:
 *
 *  1. THE WRITE GATE, over every stored node of the document's own graph and of every
 *     component definition in the catalogue, instanced or not: every key and every payload
 *     of every slot (`storedParameterFindings`), which is the whole of what `graph.applyPatch`
 *     asks of what it writes. A finding about a payload a slot KEEPS for a mode it is not in
 *     is marked `retained` (`parameter.retained`: nothing reads it as the document stands).
 *  2. THE STRUCTURAL COMPILE: wires, required inputs, loops, the flattening, each kept
 *     node's own compile (a map its node cannot use), a cue list that follows the timeline.
 *     Those are the existing validators of everything that is not a parameter payload.
 *
 * IT REPORTS. It decides nothing about whether the plan is usable (`hasError` does, for the
 * compile) and refuses nothing: each caller applies its own rule to what comes back
 * (`refusedAtCodeSave` is the code-built save's and load's).
 *
 * What it does not read yet, each with the slice of T1641b that adds it: a preset bank's
 * targets, stored values and recalls, and a live cue list's cues (slice 7; only a list that
 * follows the timeline is read, by the compile); a component definition's own validation,
 * and an instance's override paths (slice 8); a map on a node that maps nothing and a wire
 * a port cannot bind (slice 5); two nodes under one name and one connection stored twice
 * (slice 10); a Value Expression's statements (slice 6).
 */

export interface DocumentFinding {
  readonly diagnostic: RuntimeDiagnostic;
  /** `diagnosticClass(diagnostic.code)`, read once so every caller reads the same answer. */
  readonly class: DiagnosticClass | "unclassified";
  /**
   * About a payload a slot keeps for a mode it is not in (`parameter.retained`): the value
   * an expression falls back to, the static a map keeps, an expression kept under Constant.
   * False for everything that is in effect or would be.
   */
  readonly retained: boolean;
  /** The node the finding names, by what a person calls it. */
  readonly node?: { readonly id: string; readonly name: string; readonly type: string } | undefined;
  /** The component definition whose own graph holds the node, when it is not the document's. */
  readonly component?: string | undefined;
  /**
   * The finding names a node NO SINK REACHES: nothing is rendered from it. A code-built
   * save refuses an error on a node a sink reaches (the lead's ruling 12 on T1641b) and
   * lets one on an unreached branch through, as the compile does.
   */
  readonly unreached: boolean;
}

export interface DocumentFindingsInput {
  readonly graph: GraphDocument;
  readonly settings: ProjectSettings;
  /** The node catalogue; component-aware when the document instances components. */
  readonly registry: NodeRegistryView;
  /** The component catalogue. Every definition in it is read, instanced or not. */
  readonly components?: ComponentRegistryView | undefined;
  /** What the structural compile compiles for: a gate's baseline, or a render's own device. */
  readonly capabilities: BackendCapabilities;
  /**
   * A structural compile of THIS graph the caller already has, with the flattening it read:
   * taken instead of compiling again (a headless render compiles for its device anyway).
   */
  readonly compiled?: { readonly plan: CompiledGraph; readonly flattened: FlattenedGraph | undefined } | undefined;
}

const nameOf = (node: GraphNode): { id: string; name: string; type: string } => ({ id: node.id, name: node.label ?? node.id, type: node.type });

/**
 * The write gate over one graph's stored nodes. `compileSaid` answers whether the compile
 * of this graph already reported this code on this node: the resolver re-derives some of
 * the gate's findings for the ACTIVE payload, and one stored key is one finding.
 */
function writeGateOver(
  graph: GraphDocument,
  registry: NodeRegistryView,
  component: string | undefined,
  compileSaid: (code: string, nodeId: string) => boolean,
): DocumentFinding[] {
  const findings: DocumentFinding[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const definition = registry.get(node.type);
    // A type this build lacks, or a node saved against another version of its definition:
    // this build cannot judge its keys or its values (§T1641b slice 2). The compile names both.
    if (definition === undefined || node.definitionVersion !== definition.version) continue;
    const schema = effectiveParameterSchema(definition, node.parameters);
    const push = (diagnostic: RuntimeDiagnostic, retained: boolean): void => {
      findings.push({ diagnostic, class: diagnosticClass(diagnostic.code), retained, node: nameOf(node), component, unreached: false });
    };

    for (const key of undeclaredKeys(schema, node.parameters, definition.retainedParameterKeys)) {
      push(undeclaredParameter(schema, key, node.id, { stored: { nodeId: node.id, type: definition.type }, keysNote: definition.parameterKeysNote }), false);
    }

    /** What the resolver says of each key at rest: the compile reports exactly these. */
    const resolved = component === undefined ? resolveStored(node, definition) : undefined;
    const resolverSays = (key: string, code: string): boolean => {
      if (resolved === undefined) return false;
      const own = resolved.get(key);
      if (own !== undefined) return own.diagnostic?.code === code;
      const parsed = parseComponentKey(key);
      const part = parsed === null ? undefined : resolved.get(parsed.base)?.components?.find((entry) => entry.name === parsed.component);
      return part?.diagnostic?.code === code;
    };

    for (const key of Object.keys(node.parameters).sort()) {
      const stored = node.parameters[key];
      const parameter = definitionOfKey(schema, key);
      if (stored === undefined || parameter === undefined) continue;
      for (const finding of storedParameterFindings(key, parameter, stored, node.id)) {
        const code = finding.diagnostic.code;
        if (!finding.retained && resolverSays(key, code) && compileSaid(code, node.id)) continue;
        push(finding.diagnostic, finding.retained);
      }
    }
  }
  return findings;
}

/**
 * The nodes a sink reaches: the ones the compile kept, and everything wired into them (a
 * Null the compile spliced out, a node of a type this build lacks). With no kept node there
 * is nothing to tell an unreached branch by, and every node counts as reached.
 */
function reachedNodes(plan: CompiledGraph, flat: GraphDocument): ((nodeId: string) => boolean) {
  if (plan.order.length === 0) return () => true;
  const reached = new Set<string>(plan.order);
  const feeders = new Map<string, string[]>();
  for (const edge of Object.values(flat.edges)) {
    const list = feeders.get(edge.target.nodeId);
    if (list === undefined) feeders.set(edge.target.nodeId, [edge.source.nodeId]);
    else list.push(edge.source.nodeId);
  }
  const queue = [...reached];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const feeder of feeders.get(next) ?? []) {
      if (reached.has(feeder)) continue;
      reached.add(feeder);
      queue.push(feeder);
    }
  }
  const inside = [...reached];
  // An instance is inlined away: it is reached when anything inside it is.
  return (nodeId) => reached.has(nodeId) || inside.some((id) => id.startsWith(`${nodeId}${COMPONENT_ID_SEPARATOR}`));
}

/** The write gate over the document's own graph and every definition in the catalogue. */
function writeGateFindings(
  input: Pick<DocumentFindingsInput, "graph" | "registry" | "components">,
  compileSaid: (code: string, nodeId: string) => boolean,
): DocumentFinding[] {
  return [
    ...writeGateOver(input.graph, input.registry, undefined, compileSaid),
    ...(input.components?.all() ?? []).flatMap((definition) =>
      writeGateOver(definition.graph, input.registry, `${definition.name} v${definition.version}`, () => false),
    ),
  ];
}

/**
 * THE APP'S SAVE (ruling 8 on T1641b): what the document being written holds that the bus
 * would have refused, as diagnostics for the save's result and the Problems panel. The
 * write gate's half alone, with no compile: the app's own compile is live and reports the
 * rest, and a save must not wait on a device. The file is written whatever this returns.
 *
 * A finding inside a component definition names the component in its message and no node:
 * the node is not one of the document's own, and a Problems row must not point at one.
 */
export function storedNeverFindings(input: Pick<DocumentFindingsInput, "graph" | "registry" | "components">): RuntimeDiagnostic[] {
  return writeGateFindings(input, () => false)
    .filter((finding) => finding.class === "never" || finding.class === "unclassified")
    .map((finding) => {
      if (finding.component === undefined) return finding.diagnostic;
      const { nodeId: _inside, ...diagnostic } = finding.diagnostic;
      return { ...diagnostic, message: `${diagnostic.message} (in component ${finding.component}, node "${finding.node?.name ?? _inside ?? ""}")` };
    });
}

export function documentFindings(input: DocumentFindingsInput): readonly DocumentFinding[] {
  const { graph, registry, components } = input;
  const flattened =
    input.compiled !== undefined ? input.compiled.flattened : components === undefined ? undefined : flattenComponents({ graph, registry, components });
  const plan =
    input.compiled?.plan ??
    compileGraph({
      graph,
      settings: input.settings,
      registry,
      capabilities: input.capabilities,
      ...(flattened === undefined ? {} : { flattened }),
    });
  const flat = flattened?.graph ?? compiledWithoutCatalogue(graph);
  const reached = reachedNodes(plan, flat);

  const said = new Set(plan.diagnostics.map((diagnostic) => `${diagnostic.code}|${diagnostic.nodeId ?? ""}`));
  const atRest = writeGateFindings(input, (code, nodeId) => said.has(`${code}|${nodeId}`)).map((finding) =>
    finding.component === undefined && finding.node !== undefined ? { ...finding, unreached: !reached(finding.node.id) } : finding,
  );

  const compiled: DocumentFinding[] = plan.diagnostics.map((diagnostic) => {
    const id = diagnostic.nodeId;
    const node = id === undefined ? undefined : (flat.nodes[id] ?? flattened?.instanceNodes.get(id) ?? graph.nodes[id]);
    return {
      diagnostic,
      class: diagnosticClass(diagnostic.code),
      retained: false,
      node: node === undefined ? undefined : nameOf(node),
      component: undefined,
      unreached: id !== undefined && !reached(id),
    };
  });

  // One stored thing, one finding: the compile's `parameter.unknown` is the gate's own.
  const seen = new Set<string>();
  return [...compiled, ...atRest].filter((finding) => {
    const key = `${finding.component ?? ""}|${finding.diagnostic.code}|${finding.diagnostic.nodeId ?? ""}|${finding.diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A finding as a script that stops on it prints it: the code, the node BY NAME (a
 * parameter's message names its key, not its node), and what to write instead.
 */
export function describeFinding(finding: Pick<DocumentFinding, "diagnostic" | "node" | "component">): string {
  const { diagnostic, node } = finding;
  const where =
    node === undefined
      ? diagnostic.nodeId === undefined
        ? ""
        : `"${diagnostic.nodeId}": `
      : `"${node.name}" (${node.type})${finding.component === undefined ? "" : ` in component ${finding.component}`}: `;
  const said = /[.!?]$/.test(diagnostic.message) ? diagnostic.message : `${diagnostic.message}.`;
  return `${diagnostic.code}: ${where}${diagnostic.suggestion === undefined ? diagnostic.message : `${said} ${diagnostic.suggestion}`}`;
}

/**
 * WHAT A DOCUMENT BUILT BY CODE IS REFUSED FOR, at its save and at its load.
 *
 * Anything that can never take effect, at any severity, retained payloads included: a
 * build script's output is the script's to correct, and nothing here is work a person
 * would lose. A code nobody classed, which nobody has judged. And an ERROR on a node a
 * sink reaches (a required input not wired, a loop): a script's output is meant to render.
 *
 * What it lets through, by name: a finding that is still waiting on something outside the
 * document (`notYet`: a channel a live publisher supplies), one true of this build or host
 * only, a clamp or a fallback that says what stands in, and an error on a branch no sink
 * reaches.
 *
 * THE APP'S SAVE IS NOT THIS RULE. A person's work is written whatever it holds, and the
 * save reports (ruling 8 on T1641b).
 */
export function refusedAtCodeSave(finding: DocumentFinding): boolean {
  if (finding.class === "never" || finding.class === "unclassified") return true;
  return finding.diagnostic.severity === "error" && !finding.unreached;
}

/** Thrown by the checked save and load: every refused finding, by code, node and remedy. */
export class DocumentRefused extends Error {
  readonly findings: readonly DocumentFinding[];

  /** `refusal` is the sentence's head: `"E4 Bloom" was not saved`. */
  constructor(refusal: string, findings: readonly DocumentFinding[]) {
    super(
      `${refusal}: ${findings.length === 1 ? "one thing in it cannot" : `${findings.length} things in it cannot`} take effect as written.\n` +
        findings.map((finding) => `  ${describeFinding(finding)}`).join("\n"),
    );
    this.name = "DocumentRefused";
    this.findings = findings;
  }
}

/** Throws `DocumentRefused` when a code-built document holds anything `refusedAtCodeSave`. */
export function requireCodeBuilt(refusal: string, findings: readonly DocumentFinding[]): void {
  const refused = findings.filter(refusedAtCodeSave);
  if (refused.length > 0) throw new DocumentRefused(refusal, refused);
}
