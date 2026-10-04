import { describe, expect, it } from "vitest";

import { compileGraphRetaining, flattenComponents, prepareFrameCompiler } from "@compiler/index.ts";
import { testCapabilities, testSettings } from "@compiler/test-support.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { componentNodeType, createComponentSystem } from "@domain/components/index.ts";
import { NO_FLATTENING, nodeReferenceMembers, parameterReadOptions } from "@domain/parameters/index.ts";
import { effectiveParameterSchema, resolveParameters } from "@domain/parameters/resolve.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { expressionSlot } from "@/examples/documents/builders.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

/**
 * §T1485b — `op('<instance>').chan.<c>`, the same answer in the COMPILER and the INSPECTOR.
 *
 * Flattening deletes the instance node, so the compiler (which reads `op()` against the flat
 * graph) found no node called `analysis1`, and the inspector (which reads against the
 * document, where the instance exists) asked the channel resolver for `analysis1:level` —
 * an address nothing publishes under, because the value graph runs flat and keys its bags
 * by the INNER labels. Both now read the union of the instance's exposed value outputs.
 *
 * Everything here is the real thing: the real flattener produces the instance map, the real
 * value graph evaluates the flat document and supplies the channels, and the compiler and
 * the inspector's reader factory read through them. The `GPU` half (`instance-channel-
 * reference.gpu.test.ts`) shows the same read reaching pixels.
 */

const FRAME: FrameEvaluationInput = {
  timeSeconds: 1,
  deltaSeconds: 1 / 60,
  frameIndex: 60,
  mode: "realtime",
  randomSeed: 1,
};

const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string, y = 0): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y }, parameters, ...(label === undefined ? {} : { label }) }) as never;

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

/** Two value outputs (`levels`, `hits`), one publisher each, and `shared` on both. */
function analysis(level: number): GraphComponentDefinition {
  return {
    componentId: "analysis",
    version: 1,
    name: "Analysis",
    graph: {
      revision: 1,
      groups: {},
      nodes: {
        bands: node("bands", "valueExpression", { expressions: `level = ${level}; shared = 1` }, "bands1"),
        onsets: node("onsets", "valueExpression", { expressions: "kick = 0.6; shared = 2" }, "onsets1"),
        levels: node("levels", "componentOutValue", {}, "levels", 0),
        hits: node("hits", "componentOutValue", {}, "hits", 100),
      },
      edges: {
        a: edge("a", ["bands", "out"], ["levels", "in"]),
        b: edge("b", ["onsets", "out"], ["hits", "in"]),
      },
    },
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

function document(amount: StoredParameter): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      inst: node("inst", componentNodeType("analysis", 1), {}, "analysis1"),
      solid: node("solid", "solid", { color: [1, 1, 1, 1] }),
      fx: node("fx", "customWgsl", { amount }, "fx1"),
      out: node("out", "output", {}),
    },
    edges: {
      e0: edge("e0", ["solid", "out"], ["fx", "input"]),
      e1: edge("e1", ["fx", "out"], ["out", "input"]),
    },
  };
}

/** One frame of the app's own sequence: flatten, evaluate the value graph, hand on its resolver. */
function world(amount: StoredParameter, level = 0.75) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  system.components.register(analysis(level));
  const graph = document(amount);
  const components = system.components.view();
  const flattened = flattenComponents({ graph, registry: system.nodes, components });
  // The premise, asserted: the instance node is gone from what the compiler reads.
  expect(Object.keys(flattened.graph.nodes)).not.toContain("inst");
  const evaluated = createValueGraphSession(system.nodes).evaluate(flattened.graph, FRAME);
  return { system, graph, components, flattened, evaluated };
}

/** The compiler: what `customWgsl.compile` was handed for `amount`, and what it said. */
function compiled(amount: StoredParameter, level = 0.75) {
  const { system, graph, components, flattened, evaluated } = world(amount, level);
  const result = compileGraphRetaining({
    graph,
    settings: testSettings(),
    registry: system.nodes,
    capabilities: testCapabilities(),
    components,
    flattened,
    resolution: { frame: FRAME, channels: evaluated.resolver },
  });
  return {
    amount: result.retained?.nodes.get("fx")?.context.parameters["amount"],
    expression: result.compiled.diagnostics.filter((entry) => entry.nodeId === "fx" && entry.code.startsWith("parameter.")),
  };
}

/** The inspector: `inspector.tsx`'s reader factory, over the DOCUMENT graph, as the pane builds it. */
function inspected(amount: StoredParameter, level = 0.75) {
  const { system, graph, flattened, evaluated } = world(amount, level);
  const target = graph.nodes["fx"]!;
  const resolved = resolveParameters(
    target,
    system.nodes.get(target.type),
    parameterReadOptions({
      graph,
      registry: system.nodes,
      channels: evaluated.resolver,
      frame: FRAME,
      // The inspector reads the stored document: no fade, and the flattening's instances.
      flattening: { ...NO_FLATTENING, instanceChannels: flattened.instanceChannels },
    }),
  );
  return resolved.get("amount");
}

describe("§T1485b — the compiler reads op('<instance>').chan.<c>", () => {
  it("hands the node the instance's published value, and follows it when the instance changes", () => {
    const read = expressionSlot("op('analysis1').chan.level", 0.25);
    const at075 = compiled(read, 0.75);
    expect(at075.expression).toEqual([]);
    expect(at075.amount).toBe(0.75);
    // The cut-the-wire question: the instance publishes another number, the node gets it.
    expect(compiled(read, 0.4).amount).toBe(0.4);
  });

  it("reads the OTHER output's channel too — the union of the value outputs", () => {
    const kick = compiled(expressionSlot("op('analysis1').chan.kick", 0.25));
    expect(kick.expression).toEqual([]);
    expect(kick.amount).toBe(0.6);
  });

  it("refuses a channel two outputs publish, naming both ports, and keeps the retained value", () => {
    const shared = compiled(expressionSlot("op('analysis1').chan.shared", 0.25));
    expect(shared.amount).toBe(0.25);
    expect(shared.expression).toHaveLength(1);
    const message = shared.expression[0]?.message ?? "";
    expect(message).toContain(`"shared"`);
    expect(message).toContain(`"levels"`);
    expect(message).toContain(`"hits"`);
  });

  it("still names a channel nobody publishes as missing, not ambiguous", () => {
    const missing = compiled(expressionSlot("op('analysis1').chan.nope", 0.25));
    expect(missing.amount).toBe(0.25);
    expect(missing.expression[0]?.message).toContain(`publishes no channel "nope"`);
  });
});

describe("§T1485b — the per-frame values-only compile reads the instance too", () => {
  /**
   * The app animates through `prepareFrameCompiler`, which builds its OWN reader each frame
   * over the retained plan — so the instance map has to ride on the retained compile as
   * `morphs` does, or every animated frame reads §V108's retained value while the
   * structural compile reads the instance. Asserted against the full compile at the same
   * frame and channels, which is the fast path's own contract.
   */
  it("splices the same plan the full compile produces, and it moves with the instance", () => {
    const read = expressionSlot("op('analysis1').chan.level", 0.25);
    const planAt = (level: number) => {
      const { system, graph, components, flattened, evaluated } = world(read, level);
      const request = {
        graph,
        settings: testSettings(),
        registry: system.nodes,
        capabilities: testCapabilities(),
        components,
        flattened,
      };
      const resolution = { frame: FRAME, channels: evaluated.resolver };
      const fast = prepareFrameCompiler(request);
      expect(fast.reason).toBeNull();
      const spliced = fast.compileFrame(resolution);
      expect(spliced).not.toBeNull();
      expect(spliced?.passes).toEqual(compileGraphRetaining({ ...request, resolution }).compiled.passes);
      return spliced?.passes;
    };
    expect(planAt(0.75)).not.toEqual(planAt(0.4));
  });
});

describe("§T1485b — the inspector's reader gives the compiler's answer (§V61)", () => {
  it("reads the same value off the DOCUMENT graph, where the instance node still exists", () => {
    const read = expressionSlot("op('analysis1').chan.level", 0.25);
    expect(inspected(read, 0.75)?.value).toBe(0.75);
    expect(inspected(read, 0.75)?.diagnostic).toBeNull();
    expect(inspected(read, 0.4)?.value).toBe(0.4);
    expect(inspected(expressionSlot("op('analysis1').chan.kick", 0.25))?.value).toBe(0.6);
  });

  it("refuses the shared name with the same ports named", () => {
    const shared = inspected(expressionSlot("op('analysis1').chan.shared", 0.25));
    expect(shared?.value).toBe(0.25);
    expect(shared?.diagnostic?.message).toContain(`"levels"`);
    expect(shared?.diagnostic?.message).toContain(`"hits"`);
  });
});

describe("§T1485b — completion offers what the reader accepts (§V150)", () => {
  it("lists the instance's channels under .chan, minus the one it would refuse", () => {
    const { system, graph, flattened, evaluated } = world(0.25);
    const offered = nodeReferenceMembers(
      {
        graph,
        schemaOf: (target) => effectiveParameterSchema(system.nodes.get(target.type), target.parameters),
        channelsOf: (name) => Object.keys(evaluated.byName.get(name) ?? {}),
        instances: flattened.instanceChannels,
      },
      "analysis1",
      ["chan"],
    ).map((member) => member.text);
    expect(offered).toEqual(["level", "kick"]);
  });
});
