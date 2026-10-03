import { describe, expect, it } from "vitest";
import { flattenComponents } from "../../compiler/flatten.ts";
import { alice, contextFor } from "../commands/test-support.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSlot, StoredParameter } from "../types/parameters.ts";
import { componentNodeType } from "./component-type.ts";
import { COMPONENT_OVERRIDES_STATE_KEY, PARENT_BINDINGS_STATE_KEY } from "./instance.ts";
import { createComponentHarness, graphOf, node, type ComponentHarness } from "./test-support.ts";

/**
 * B238 — `component.detach` gave the copies the DEFINITION's values, not the instance's
 * own page: an instance with its Blur knob at 2 detached into blurs at the definition's 4.
 * Detach now writes, once, what flattening writes every compile (`detach-values.ts`).
 *
 * Each value kind is asserted twice, because each half can be right while the other is
 * wrong: the STORED value on the copy (what the user sees in the inspector and what a
 * preset fade's edit rule compares against), and the FLATTENED parameters of the copy
 * against the flattened parameters of the instance's internal node (what the compiler
 * hands the GPU). The second is the "renders the same" claim at the domain level; the
 * Dawn twin is `src/tests/headless/component-detach.gpu.test.ts`.
 */

const ctx = contextFor(alice);

const slot = (mode: ParameterSlot["mode"], binding: ParameterSlot["bindings"][keyof ParameterSlot["bindings"]], retained: number): ParameterSlot => ({
  mode,
  bindings: { [mode]: binding, static: { kind: "static", value: retained } },
});
const bindSlot = (ref: string, retained: number): ParameterSlot => slot("bind", { kind: "bind", ref }, retained);

/**
 * THE LOOK: `blur` drives blurA.radius; `tint` and `amount` drive the solid; `soft` drives
 * nothing and exists for `parent.soft` — read by blurB through a bind slot and by blurC
 * through a legacy `state.parentBindings`. `deep` reads `parent.parent.gain`, past the look.
 * Every internal value differs from every page value, so a copy that kept its definition's
 * value cannot pass by coincidence.
 */
function look(): GraphComponentDefinition {
  return {
    componentId: "look",
    version: 1,
    name: "Look",
    graph: graphOf([
      node("blurA", "test.blur", { radius: 4 }, { label: "blurA", position: { x: 0, y: 0 } }),
      node("blurB", "test.blur", {}, { label: "blurB", position: { x: 100, y: 0 }, parameters: { radius: bindSlot("parent.soft", 1) } }),
      node("blurC", "test.blur", { radius: 4 }, { label: "blurC", position: { x: 200, y: 0 }, state: { [PARENT_BINDINGS_STATE_KEY]: { radius: "parent.soft" } } }),
      node("solid", "test.solid", { color: [0, 0, 0, 1], amount: 0.5 }, { label: "solid", position: { x: 0, y: 100 } }),
      node("deep", "test.blur", {}, { label: "deep", position: { x: 100, y: 100 }, parameters: { radius: bindSlot("parent.parent.gain", 3) } }),
    ]),
    inputs: [{ externalId: "source", label: "Source", nodeId: "blurA", portId: "source" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "blurA", portId: "out" }],
    parameters: [
      { key: "blur", definition: { type: "number", label: "Blur", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "blurA", key: "radius" }] },
      { key: "soft", definition: { type: "number", label: "Soft", default: 4, min: 0, max: 64 }, targets: [] },
      { key: "tint", definition: { type: "color", label: "Tint", default: [0, 0, 0, 1], space: "display" }, targets: [{ nodeId: "solid", key: "color" }] },
      { key: "amount", definition: { type: "number", label: "Amount", default: 0.5, min: 0, max: 1 }, targets: [{ nodeId: "solid", key: "amount" }] },
    ],
  };
}

const PAGE = { blur: 2, soft: 6, tint: [0.1, 0.2, 0.3, 1], amount: 0.25 } as const;

function instanceOf(componentId: string, page: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "inst",
    type: componentNodeType(componentId, 1),
    definitionVersion: 1,
    label: "look1",
    position: { x: 40, y: 40 },
    parameters: page,
    ...extra,
  };
}

interface Detached {
  readonly harness: ComponentHarness;
  readonly before: GraphDocument;
  readonly after: GraphDocument;
  /** The copy of each internal node, by its id in the definition. */
  readonly copies: Record<NodeId, GraphNode>;
  readonly codes: readonly string[];
}

async function detach(instance: GraphNode, definitions: readonly GraphComponentDefinition[] = [look()], extra: GraphNode[] = []): Promise<Detached> {
  const harness = createComponentHarness("t", graphOf([instance, ...extra]));
  for (const definition of definitions) harness.components.register(definition);
  const before = harness.store.view.getGraph();
  const result = await harness.bus.execute("component.detach", { nodeId: instance.id }, ctx);
  expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  const after = harness.store.view.getGraph();
  const definition = harness.components.get(definitions[0]!.componentId, 1)!;
  // Copies are found by TYPE and position offset, not by label: a label is what detach may rename.
  const copies: Record<NodeId, GraphNode> = {};
  for (const internalId of Object.keys(definition.graph.nodes)) {
    const internal = definition.graph.nodes[internalId]!;
    const copy = result.output.nodeIds
      .map((id) => after.nodes[id]!)
      .find((each) => each.type === internal.type && each.label === internal.label);
    if (copy !== undefined) copies[internalId] = copy;
  }
  return { harness, before, after, copies, codes: result.diagnostics.map((each) => each.code) };
}

/** Flattened parameters of every internal node, before (under the instance) and after (the copy). */
function flattenedPairs(detached: Detached, instanceId = "inst"): Array<[string, unknown, unknown]> {
  const flatten = (graph: GraphDocument) =>
    flattenComponents({ graph, registry: detached.harness.nodes, components: detached.harness.components });
  const before = flatten(detached.before).graph.nodes;
  const after = flatten(detached.after).graph.nodes;
  // Every internal node has a copy, and both sides flattened it: no pair is two undefineds.
  expect(Object.keys(detached.copies).sort()).toEqual(Object.keys(detached.harness.components.get("look", 1)!.graph.nodes).sort());
  return Object.entries(detached.copies).map(([internalId, copy]) => {
    const pair: [string, unknown, unknown] = [internalId, before[`${instanceId}/${internalId}`]?.parameters, after[copy.id]?.parameters];
    expect(pair[1], internalId).toBeDefined();
    expect(pair[2], internalId).toBeDefined();
    return pair;
  });
}

describe("B238 — a detached copy holds the instance's page, by flattening's rule", () => {
  it("STATIC: the instance's Blur 2 lands on the copy, not the definition's 4", async () => {
    const detached = await detach(instanceOf("look", { ...PAGE }));
    expect(detached.copies["blurA"]?.parameters["radius"]).toBe(2);
    expect(detached.copies["solid"]?.parameters["amount"]).toBe(0.25);
    expect(detached.copies["solid"]?.parameters["color"]).toEqual([0.1, 0.2, 0.3, 1]);
    for (const [internalId, before, after] of flattenedPairs(detached)) expect(after, internalId).toEqual(before);
  });

  it("EXPRESSION: the instance's expression slot travels to the copy unresolved, as flattening hands it down (§T1017)", async () => {
    const expression = slot("expression", { kind: "expression", source: "time * 2" }, 1);
    const detached = await detach(instanceOf("look", { ...PAGE, blur: expression }));
    expect(detached.copies["blurA"]?.parameters["radius"]).toEqual(expression);
    for (const [internalId, before, after] of flattenedPairs(detached)) expect(after, internalId).toEqual(before);
  });

  it("CHANNEL READ: a driven slot travels as the slot — a channel is one global namespace (§V129)", async () => {
    const driven = slot("driven", { kind: "driven", channel: "lfo1.value" }, 1);
    const detached = await detach(instanceOf("look", { ...PAGE, blur: driven }));
    expect(detached.copies["blurA"]?.parameters["radius"]).toEqual(driven);
    for (const [internalId, before, after] of flattenedPairs(detached)) expect(after, internalId).toEqual(before);
  });

  it("SIBLING BIND: relative to the instance's page, so it is baked — Blur bound to Soft 6 writes 6", async () => {
    const detached = await detach(instanceOf("look", { ...PAGE, blur: bindSlot("soft", 1) }));
    expect(detached.copies["blurA"]?.parameters["radius"]).toBe(6);
    for (const [internalId, before, after] of flattenedPairs(detached)) expect(after, internalId).toEqual(before);
  });

  it("COMPOUND PER COMPONENT: tint.r on the instance is assembled into the copy's whole colour", async () => {
    const detached = await detach(instanceOf("look", { ...PAGE, "tint.r": 0.9 }));
    expect(detached.copies["solid"]?.parameters["color"]).toEqual([0.9, 0.2, 0.3, 1]);
    expect(detached.copies["solid"]?.parameters["color.r"]).toBeUndefined();
    for (const [internalId, before, after] of flattenedPairs(detached)) expect(after, internalId).toEqual(before);
  });

  it("PARENT BIND, baked: parent.soft (slot and legacy binding) becomes the 6 it read; parent.parent.gain loses one hop", async () => {
    const detached = await detach(instanceOf("look", { ...PAGE }));
    expect(detached.copies["blurB"]?.parameters["radius"]).toBe(6);
    expect(detached.copies["blurC"]?.parameters["radius"]).toBe(6);
    // The legacy binding is gone with the page it read; a copy left holding it would read
    // whatever owns the copies, which is not the look.
    expect(detached.copies["blurC"]?.state).toBeUndefined();
    // Two hops reached PAST the look; the copies sit one level further out.
    expect(detached.copies["deep"]?.parameters["radius"]).toEqual(bindSlot("parent.gain", 3));
    expect(detached.codes).toContain("component.detach.parentValues");
    for (const [internalId, before, after] of flattenedPairs(detached)) expect(after, internalId).toEqual(before);
  });

  it("a parent.<key> bind ON THE INSTANCE's page is carried as written: the copies land at the instance's own level", async () => {
    const outward = bindSlot("parent.level", 5);
    const detached = await detach(instanceOf("look", { ...PAGE, blur: outward, soft: bindSlot("parent.level", 7) }));
    expect(detached.copies["blurA"]?.parameters["radius"]).toEqual(outward);
    // A one-hop read of a carried key carries the instance's slot too.
    expect(detached.copies["blurB"]?.parameters["radius"]).toEqual(bindSlot("parent.level", 7));
    expect(detached.copies["blurC"]?.parameters["radius"]).toEqual(bindSlot("parent.level", 7));
    // At the root nothing is in scope, and both sides fall back to the retained static.
    for (const [internalId, before, after] of flattenedPairs(detached)) expect(after, internalId).toEqual(before);
  });

  it("the instance's own componentOverrides win over its page, as in flattening", async () => {
    const detached = await detach(instanceOf("look", { ...PAGE }, { state: { [COMPONENT_OVERRIDES_STATE_KEY]: { "blurA/radius": 9 } } }));
    expect(detached.copies["blurA"]?.parameters["radius"]).toBe(9);
    for (const [internalId, before, after] of flattenedPairs(detached)) expect(after, internalId).toEqual(before);
  });

  it("the copies do not share parameter records with the definition: it still holds its own 4", async () => {
    const detached = await detach(instanceOf("look", { ...PAGE }));
    const definition = detached.harness.components.get("look", 1)!;
    expect(definition.graph.nodes["blurA"]?.parameters["radius"]).toBe(4);
    expect(definition.graph.nodes["blurB"]?.parameters["radius"]).toEqual(bindSlot("parent.soft", 1));
  });

  it("undo restores the instance in ONE step, page and all", async () => {
    const detached = await detach(instanceOf("look", { ...PAGE }));
    const undoDepth = detached.harness.store.view.getHistory(alice).undo.length;
    const undone = await detached.harness.bus.execute("graph.undo", {}, ctx);
    expect(undone.status).toBe("applied");
    expect(detached.harness.store.view.getHistory(alice).undo.length).toBe(undoDepth - 1);
    const restored = detached.harness.store.view.getGraph();
    expect(restored.nodes).toEqual(detached.before.nodes);
    expect(restored.edges).toEqual(detached.before.edges);
  });
});

describe("B238 — nested instances stay instances, and their pages keep working", () => {
  /** OUTER holds an instance of LOOK whose Blur reads parent.size — OUTER's own page. */
  function outer(lookPage: Record<string, StoredParameter>): GraphComponentDefinition {
    return {
      componentId: "outer",
      version: 1,
      name: "Outer",
      graph: graphOf([
        { id: "inner", type: componentNodeType("look", 1), definitionVersion: 1, label: "inner", position: { x: 0, y: 0 }, parameters: lookPage },
        node("grade", "test.blur", { radius: 4 }, { label: "grade", position: { x: 100, y: 0 } }),
      ]),
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
      parameters: [
        { key: "size", definition: { type: "number", label: "Size", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "grade", key: "radius" }] },
      ],
    };
  }

  it("the nested copy's page holds what the outer page gave it, and every flattened internal is unchanged", async () => {
    const detached = await detach(
      instanceOf("outer", { size: 11 }),
      [outer({ ...PAGE, blur: bindSlot("parent.size", 1) }), look()],
    );
    const inner = detached.copies["inner"];
    expect(inner?.type).toBe(componentNodeType("look", 1));
    expect(inner?.parameters["blur"]).toBe(11);
    expect(detached.copies["grade"]?.parameters["radius"]).toBe(11);

    // The nested look's own internals, flattened under the outer instance and under the copy.
    const flatten = (graph: GraphDocument) =>
      flattenComponents({ graph, registry: detached.harness.nodes, components: detached.harness.components }).graph.nodes;
    const before = flatten(detached.before);
    const after = flatten(detached.after);
    for (const internalId of ["blurA", "blurB", "blurC", "solid", "deep"]) {
      expect(before[`inst/inner/${internalId}`], internalId).toBeDefined();
      expect(after[`${inner!.id}/${internalId}`]?.parameters, internalId).toEqual(before[`inst/inner/${internalId}`]?.parameters);
    }
    expect(after[`${inner!.id}/blurA`]?.parameters["radius"]).toBe(11);
  });

  it("a nested definition that reads past its own parent (parent.parent.gain) is said, not silently re-aimed", async () => {
    const detached = await detach(instanceOf("outer", { size: 11 }), [outer({ ...PAGE }), look()]);
    expect(detached.codes).toContain("component.detach.nestedParentReads");
    const quiet = await detach(instanceOf("look", { ...PAGE }));
    expect(quiet.codes).not.toContain("component.detach.nestedParentReads");
  });
});
