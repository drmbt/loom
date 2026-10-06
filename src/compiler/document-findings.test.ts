import { describe, expect, it } from "vitest";

import { createComponentSystem } from "../domain/components/registry.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { GraphNode, ProjectDocument } from "../domain/types/graph.ts";
import { expressionSlot } from "../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES, exampleRegistry } from "../examples/runner.ts";
import { DOT, LAMP, dotDocument, lampDocument } from "../tests/fixtures/never-effective.ts";
import { compileGraph } from "./compile.ts";
import { documentFindings, refusedAtCodeSave, type DocumentFinding } from "./document-findings.ts";

/**
 * §T1641b slice 3 — `documentFindings`: the write gate asked of everything a document
 * already stores, with the structural compile's report, as ONE list.
 *
 * Every document here is built the way a build script builds one: object literals through
 * the builders, never a patch. The bus would have refused each wrong thing at the write.
 */

function findingsOf(document: ProjectDocument, definitions: readonly GraphComponentDefinition[] = []): readonly DocumentFinding[] {
  const { components, nodes: registry } = createComponentSystem(exampleRegistry());
  for (const definition of definitions) components.register(definition);
  return documentFindings({
    graph: document.graph,
    settings: document.settings,
    registry,
    components: components.view(),
    capabilities: TIER_B_CAPABILITIES,
  });
}

/** What a caller reads off a finding: its code, whether it is kept or in effect, its class. */
const facts = (findings: readonly DocumentFinding[]): string[] =>
  findings.map((finding) => `${finding.diagnostic.code} ${finding.retained ? "retained" : "active"} ${finding.class}`);

/** A node the builders refuse to make: a type this build does not have. */
const ofAnotherBuild = (id: string): GraphNode => ({ id, type: "aurora", definitionVersion: 1, position: { x: 0, y: 400 }, parameters: { glow: 1 }, label: id });

describe("documentFindings: a payload a slot keeps is told from the one in effect (T1641b)", () => {
  it("the consumer's kept `0` on a boolean: one finding, retained, never, and the compile said nothing of it", () => {
    const document = dotDocument(expressionSlot("1", 0));
    // The gap this slice closes: nothing but the bus ever looked at a kept payload.
    const plan = compileGraph({ graph: document.graph, settings: document.settings, registry: exampleRegistry(), capabilities: TIER_B_CAPABILITIES });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.ok).toBe(true);

    const findings = findingsOf(document);
    expect(facts(findings)).toEqual(["parameter.retained retained never"]);
    expect(findings[0]?.node).toEqual({ id: DOT, name: DOT, type: "circle" });
    expect(findings[0]?.diagnostic.severity).toBe("error");
  });

  it("the same number IN EFFECT is the finding it always was, said once", () => {
    // A bare 0 on the boolean: the default renders. The resolver reports it at the compile
    // and the write gate would say the same of the same key: one stored thing, one finding.
    const findings = findingsOf(dotDocument(0));
    expect(facts(findings)).toEqual(["parameter.type active never"]);
  });

  it("the parameter's own type, kept under a working expression, is silent", () => {
    expect(findingsOf(dotDocument(expressionSlot("1", false)))).toEqual([]);
    expect(findingsOf(dotDocument(true))).toEqual([]);
  });

  it("an unknown function and an undeclared key are each ONE finding, the compile's and the gate's being the same", () => {
    const pow = findingsOf(lampDocument(expressionSlot("pow(0.5 + abstime * 0, 2)", 0.5)));
    expect(facts(pow)).toEqual(["parameter.expression.syntax active never"]);
    expect(pow[0]?.diagnostic.suggestion).toContain("(0.5 + abstime * 0) ^ 2");

    const key = findingsOf(lampDocument(0.5, [], { contrst: 2 }));
    expect(facts(key)).toEqual(["parameter.unknown active never"]);
    expect(key[0]?.node?.name).toBe(LAMP);
  });

  it("reports what only the write gate checks of a value in effect: an armed pulse", () => {
    // §V124: a document may not hold a pulse armed. The resolver reads `true` as a valid
    // boolean, so the compile is silent; the bus refuses the write.
    const feedback: GraphNode = { id: "feedback_trail", type: "feedback", definitionVersion: exampleRegistry().require("feedback").version, position: { x: 0, y: 300 }, parameters: { resetPulse: true }, label: "feedback_trail" };
    const findings = findingsOf(lampDocument(0.5, [feedback]));
    expect(facts(findings.filter((finding) => finding.node?.id === "feedback_trail"))).toContain("parameter.pulse.stored active never");
  });
});

describe("documentFindings: what it reads beyond the document's own graph, and what it leaves alone (T1641b)", () => {
  /** A definition nothing instances: a Level whose kept static is text. */
  const definition: GraphComponentDefinition = {
    componentId: "dimmer" as never,
    version: 1,
    name: "Dimmer",
    graph: {
      revision: 1,
      groups: {},
      nodes: {
        level_inner: { id: "level_inner", type: "level", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { brightness: expressionSlot("0.5", "half") }, label: "level_inner" },
      },
      edges: {},
    },
    inputs: [],
    outputs: [],
    parameters: [],
  };

  it("reads a component definition's own graph, instanced or not, and names the component", () => {
    // No instance: the compile flattens nothing and never sees the inner node.
    const findings = findingsOf(lampDocument(0.5), [definition]);
    expect(facts(findings)).toEqual(["parameter.retained retained never"]);
    expect(findings[0]?.component).toBe("Dimmer v1");
    expect(findings[0]?.node?.name).toBe("level_inner");
  });

  it("does not judge a node saved against another version of its definition: the version is the finding", () => {
    // A newer build's Level may declare `shimmer`; an older one's keys are its migration's input.
    const document = lampDocument(0.5);
    const lamp = document.graph.nodes[LAMP];
    if (lamp === undefined) throw new Error("fixture");
    document.graph.nodes[LAMP] = { ...lamp, definitionVersion: lamp.definitionVersion + 1, parameters: { ...lamp.parameters, shimmer: expressionSlot("1", "bright") } };
    const findings = findingsOf(document);
    expect(findings.map((finding) => finding.diagnostic.code)).toEqual(["compiler/definition-version"]);
    expect(findings.some((finding) => finding.class === "never")).toBe(false);
  });

  it("marks a finding on a node no sink reaches, and only that one", () => {
    const side = findingsOf(lampDocument(0.5, [ofAnotherBuild("aurora_side")]));
    expect(side.map((finding) => [finding.diagnostic.code, finding.class, finding.unreached])).toEqual([["compiler/unknown-node-type", "elsewhereBuild", true]]);
    expect(side.some(refusedAtCodeSave)).toBe(false);

    // In the lamp's own slot, the Output is fed by nothing this build can run.
    const document = lampDocument(0.5);
    const lamp = document.graph.nodes[LAMP];
    if (lamp === undefined) throw new Error("fixture");
    document.graph.nodes[LAMP] = { ...lamp, type: "aurora", parameters: {} };
    const through = findingsOf(document);
    expect(through.filter((finding) => finding.diagnostic.severity === "error").every((finding) => !finding.unreached)).toBe(true);
    expect(through.some(refusedAtCodeSave)).toBe(true);
  });

  it("reads a compile the caller already made instead of compiling again, and says the same", () => {
    const document = lampDocument(expressionSlot("pow(2, 2)", 0.5), [], { opacity: expressionSlot("1", true) });
    const registry = exampleRegistry();
    const plan = compileGraph({ graph: document.graph, settings: document.settings, registry, capabilities: TIER_B_CAPABILITIES });
    const handed = documentFindings({ graph: document.graph, settings: document.settings, registry, capabilities: TIER_B_CAPABILITIES, compiled: { plan, flattened: undefined } });
    expect(facts(handed).sort()).toEqual(["parameter.expression.syntax active never", "parameter.retained retained never"]);
    expect(facts(handed)).toEqual(facts(findingsOf(document)));
  });
});
