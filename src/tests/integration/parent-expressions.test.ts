import { describe, expect, it } from "vitest";

import { compileGraphRetaining, flattenComponents } from "@compiler/index.ts";
import { testCapabilities, testSettings } from "@compiler/test-support.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { componentNodeType, createComponentSystem } from "@domain/components/index.ts";
import type { GraphComponentDefinition, PublishedParameter } from "@domain/types/components.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { expressionSlot } from "@/examples/documents/builders.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

/**
 * VN36 — `parent(n).par.key` through the real flattener, value graph and compiler.
 *
 * The flattener rewrites each read to `op('<the n-th enclosing instance>').par.key`
 * (`compiler/parent-references.ts`) and the reader reads that instance's page per frame
 * (`instance-parameter-reference.test.ts`). The pixels are `parent-expressions.gpu.test.ts`.
 */

const frameAt = (timeSeconds: number): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed: 1,
});

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label }) as never;

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

const knob = (key: string, targets: PublishedParameter["targets"] = []): PublishedParameter => ({
  key,
  definition: { type: "number", label: key, default: 0.3 },
  targets,
});

/** `in → fx → out`, fx's `amount` the given slot. */
function lamp(amount: StoredParameter, published: PublishedParameter[] = [knob("gain")]): GraphComponentDefinition {
  return {
    componentId: "lamp",
    version: 1,
    name: "Lamp",
    graph: { revision: 1, groups: {}, nodes: { fx: node("fx", "customWgsl", { amount }, "fx_lamp") }, edges: {} },
    inputs: [{ externalId: "source", label: "Source", nodeId: "fx", portId: "input" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "fx", portId: "out" }],
    parameters: published,
  };
}

/** A component that holds one Lamp, publishes `master`, and sets the Lamp's page to `page`. */
function rack(page: Record<string, StoredParameter>): GraphComponentDefinition {
  return {
    componentId: "rack",
    version: 1,
    name: "Rack",
    graph: {
      revision: 1,
      groups: {},
      nodes: { inner: node("inner", componentNodeType("lamp", 1), page, "lamp_inner") },
      edges: {},
    },
    inputs: [{ externalId: "source", label: "Source", nodeId: "inner", portId: "source" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
    parameters: [knob("master")],
  };
}

/** `solid → <instances…> → output`, chained. */
function chain(instances: GraphNode[]): GraphDocument {
  const nodes = [node("solid", "solid", { color: [1, 1, 1, 1] }, "solid_base"), ...instances, node("out", "output", {}, "output_main")];
  const edges: GraphDocument["edges"] = {};
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index] as GraphNode;
    const to = nodes[index + 1] as GraphNode;
    const port = to.type === "output" ? "input" : to.type === "customWgsl" ? "input" : "source";
    edges[`e${index}`] = edge(`e${index}`, [from.id, "out"], [to.id, port]);
  }
  return { revision: 1, groups: {}, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges };
}

/** Each customWgsl's `amount` as compiled at `time`, keyed by flat id, and what the compile said. */
function compiled(definitions: GraphComponentDefinition[], graph: GraphDocument, time = 1) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  for (const definition of definitions) system.components.register(definition);
  const components = system.components.view();
  const flattened = flattenComponents({ graph, registry: system.nodes, components });
  const frame = frameAt(time);
  const channels = createValueGraphSession(system.nodes).evaluate(flattened.graph, frame, { flattening: flattened }).resolver;
  const result = compileGraphRetaining({
    graph,
    settings: testSettings(),
    registry: system.nodes,
    capabilities: testCapabilities(),
    components,
    flattened,
    resolution: { frame, channels },
  });
  const amounts: Record<string, unknown> = {};
  for (const [id, record] of result.retained?.nodes ?? []) {
    if (record.node.type === "customWgsl") amounts[id] = record.context.parameters["amount"];
  }
  // The compile restates the flattening's diagnostics, so its list is the whole answer. What
  // a READER said: `parent()`'s own codes, and any parameter problem on a reading node.
  const said = result.compiled.diagnostics.filter(
    (entry) =>
      entry.code.startsWith("compiler/parent-reference") ||
      (entry.code.startsWith("parameter.") && entry.nodeId !== undefined && result.retained?.nodes.get(entry.nodeId)?.node.type === "customWgsl"),
  );
  return { amounts, said, flattened, pruned: result.compiled.ok ? result.compiled.pruned : [] };
}

const instanceOf = (id: string, componentId: string, label: string, page: Record<string, StoredParameter> = {}) =>
  node(id, componentNodeType(componentId, 1), page, label);

describe("VN36 — parent().par.key inside a component", () => {
  const reader = lamp(expressionSlot("parent().par.gain * 0.5", 0.25));

  it("reads ITS instance's page: two instances, two values (§V321)", () => {
    const { amounts, said, flattened } = compiled(
      [reader],
      chain([instanceOf("a", "lamp", "lamp_a", { gain: 0.4 }), instanceOf("b", "lamp", "lamp_b", { gain: 0.8 })]),
    );
    expect(said).toEqual([]);
    expect(amounts).toEqual({ "a/fx": 0.2, "b/fx": 0.4 });
    // The rewrite itself: a name, not a value — the instance's page is read per frame.
    const slot = flattened.graph.nodes["a/fx"]?.parameters["amount"];
    expect(slot).toMatchObject({ bindings: { expression: { source: "op('lamp_a').par.gain * 0.5" } } });
  });

  it("follows an ANIMATED page knob per frame", () => {
    const graph = chain([instanceOf("a", "lamp", "lamp_a", { gain: expressionSlot("time * 0.2", 0.3) })]);
    expect(compiled([reader], graph, 1).amounts["a/fx"]).toBe(0.1);
    expect(compiled([reader], graph, 3).amounts["a/fx"]).toBeCloseTo(0.3, 12);
  });

  it("CUT THE PUBLISH: the read is refused by name and the static stands, never 0", () => {
    const unpublished = lamp(expressionSlot("parent().par.gain * 0.5", 0.25), []);
    const { amounts, said } = compiled([unpublished], chain([instanceOf("a", "lamp", "lamp_a", { gain: 0.4 })]));
    expect(amounts["a/fx"]).toBe(0.25);
    expect(said.map((entry) => entry.code)).toEqual(["compiler/parent-reference-unknown-key"]);
    expect(said[0]?.nodeId).toBe("a/fx");
    expect(said[0]?.message).toContain(`publishes no parameter "gain"`);
  });

  it("names the nearest published key when the read misspells it", () => {
    const misspelt = lamp(expressionSlot("parent().par.gian", 0.25));
    const { said } = compiled([misspelt], chain([instanceOf("a", "lamp", "lamp_a")]));
    expect(said[0]?.code).toBe("compiler/parent-reference-unknown-key");
    expect(said[0]?.suggestion).toContain(`Nearest: "gain"`);
  });
});

describe("VN36 — parent() across nesting", () => {
  it("parent(2) reads two components out", () => {
    const deep = lamp(expressionSlot("parent(2).par.master + parent().par.gain", 0.25));
    const { amounts, said } = compiled(
      [deep, rack({ gain: 0.1 })],
      chain([instanceOf("r", "rack", "rack_a", { master: 0.5 })]),
    );
    expect(said).toEqual([]);
    expect(amounts["r/inner/fx"]).toBeCloseTo(0.6, 12);
  });

  it("reads a page value set on a NESTED instance, which no root parameter stands behind", () => {
    const { amounts } = compiled(
      [lamp(expressionSlot("parent().par.gain", 0.25)), rack({ gain: 0.7 })],
      chain([instanceOf("r", "rack", "rack_a")]),
    );
    expect(amounts["r/inner/fx"]).toBe(0.7);
  });

  it("a nested page that reads parent() animates through to the inner reader", () => {
    const graph = chain([instanceOf("r", "rack", "rack_a", { master: expressionSlot("time * 0.1", 0.3) })]);
    const definitions = [lamp(expressionSlot("parent().par.gain", 0.25)), rack({ gain: expressionSlot("parent().par.master * 2", 0.3) })];
    expect(compiled(definitions, graph, 1).amounts["r/inner/fx"]).toBeCloseTo(0.2, 12);
    expect(compiled(definitions, graph, 2).amounts["r/inner/fx"]).toBeCloseTo(0.4, 12);
  });

  it("a page slot CARRIED inward (T1017) keeps the parent() it was written with", () => {
    // `amount` is published onto fx.amount, and the Rack sets it, on its Lamp, to an animated
    // read of the Rack's own page. Carried as text, `parent()` would be read from fx — one
    // level too deep, where the Lamp publishes no `master`.
    const fanned = lamp(0.25, [knob("gain"), knob("amount", [{ nodeId: "fx", key: "amount" }])]);
    const graph = chain([instanceOf("r", "rack", "rack_a", { master: expressionSlot("time * 0.1", 0.3) })]);
    const definitions = [fanned, rack({ amount: expressionSlot("parent().par.master * 3", 0.3) })];
    const { amounts, said } = compiled(definitions, graph, 2);
    expect(said).toEqual([]);
    expect(amounts["r/inner/fx"]).toBeCloseTo(0.6, 12);
  });

  it("parent(n) past the outermost component is refused", () => {
    const tooDeep = lamp(expressionSlot("parent(2).par.gain", 0.25));
    const { amounts, said } = compiled([tooDeep], chain([instanceOf("a", "lamp", "lamp_a")]));
    expect(amounts["a/fx"]).toBe(0.25);
    expect(said.map((entry) => entry.code)).toEqual(["compiler/parent-reference-no-parent"]);
    expect(said[0]?.message).toContain("reaches past the outermost one");
  });
});

describe("VN36 — parent() at the root", () => {
  it("raises no-parent and keeps the static, rather than reading 0", () => {
    const graph = chain([node("fx", "customWgsl", { amount: expressionSlot("parent().par.gain", 0.25) }, "fx_root")]);
    const { amounts, said } = compiled([], graph);
    expect(amounts["fx"]).toBe(0.25);
    expect(said.map((entry) => entry.code)).toEqual(["compiler/parent-reference-no-parent"]);
    expect(said[0]?.nodeId).toBe("fx");
  });
});

describe("VN36 — the value graph orders a parent() read after what the page reads", () => {
  /**
   * The reader is a Constant INSIDE the component (flat id `a/k`), and the page knob it reads
   * reads a Constant at the root whose id, `zsrc`, sorts AFTER it. The value graph evaluates in
   * dependency order, ties by id, so unless the walk follows `op('knob_a').par.level` into the
   * page and on to `op('constant_src')`, the reader evaluates first and reads a bag not yet
   * published: the default, one frame late at best.
   */
  it("reads the root channel through the page in the SAME evaluation", () => {
    const knobHolder: GraphComponentDefinition = {
      componentId: "knob",
      version: 1,
      name: "Knob",
      graph: { revision: 1, groups: {}, nodes: { k: node("k", "constant", { value: expressionSlot("parent().par.level", 0) }, "constant_k") }, edges: {} },
      inputs: [],
      outputs: [],
      parameters: [knob("level")],
    };
    const graph: GraphDocument = {
      revision: 1,
      groups: {},
      nodes: {
        zsrc: node("zsrc", "constant", { value: 0.7 }, "constant_src"),
        a: instanceOf("a", "knob", "knob_a", { level: expressionSlot("op('constant_src').chan.value", 0.3) }),
      },
      edges: {},
    };
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
    system.components.register(knobHolder);
    const flattened = flattenComponents({ graph, registry: system.nodes, components: system.components.view() });
    const evaluated = createValueGraphSession(system.nodes).evaluate(flattened.graph, frameAt(1), { flattening: flattened });
    expect(evaluated.byName.get("constant_k")).toEqual({ value: 0.7 });
  });
});

describe("VN36 — liveness follows a parent() read through the page", () => {
  it("a node read only by a page knob, through parent(), is not reported dead", () => {
    // `fx_spare` is wired to nothing. The one thing that reads it is the Lamp's page, and the
    // one thing that reads the page is the Lamp's inner node, through parent().
    const graph = chain([instanceOf("a", "lamp", "lamp_a", { gain: expressionSlot("op('fx_spare').par.amount", 0.3) })]);
    graph.nodes["spare"] = node("spare", "customWgsl", { amount: 0.9 }, "fx_spare");
    const { amounts, pruned } = compiled([lamp(expressionSlot("parent().par.gain", 0.25))], graph);
    expect(amounts["a/fx"]).toBe(0.9);
    expect(pruned).not.toContain("spare");
  });
});
