import { describe, expect, it } from "vitest";
import { flattenComponents } from "../../compiler/flatten.ts";
import { agent, alice, contextFor } from "../commands/test-support.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSlot, StoredParameter } from "../types/parameters.ts";
import { componentNodeType } from "./component-type.ts";
import { COMPONENT_OVERRIDES_STATE_KEY, PARENT_BINDINGS_STATE_KEY } from "./instance.ts";
import { openComponentSession } from "./session.ts";
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
  readonly messages: ReadonlyArray<{ readonly code: string; readonly message: string }>;
}

async function detach(
  instance: GraphNode,
  definitions: readonly GraphComponentDefinition[] = [look()],
  extra: GraphNode[] = [],
  edges: GraphDocument["edges"] = {},
): Promise<Detached> {
  const harness = createComponentHarness("t", graphOf([instance, ...extra], edges));
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
  return { harness, before, after, copies, codes: result.diagnostics.map((each) => each.code), messages: result.diagnostics };
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

/**
 * OUTER holds an instance of LOOK (`inner`) whose page `lookPage` may read parent.size —
 * OUTER's own page. B239 adds the inner instance's other fields and OUTER's whole page.
 */
function outer(
  lookPage: Record<string, StoredParameter>,
  innerExtra: Partial<GraphNode> = {},
  parameters: GraphComponentDefinition["parameters"] = [
    { key: "size", definition: { type: "number", label: "Size", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "grade", key: "radius" }] },
  ],
): GraphComponentDefinition {
  return {
    componentId: "outer",
    version: 1,
    name: "Outer",
    graph: graphOf([
      { id: "inner", type: componentNodeType("look", 1), definitionVersion: 1, label: "inner", position: { x: 0, y: 0 }, parameters: lookPage, ...innerExtra },
      node("grade", "test.blur", { radius: 4 }, { label: "grade", position: { x: 100, y: 0 } }),
    ]),
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
    parameters,
  };
}

/**
 * B240: OUTER's Size with NO targets — read only as parent.size, pure lexical scope (§V81).
 * A session's write-back prune used to unpublish it on the detach's own edit; the B239
 * session cases gave it a target on `grade` to survive that, and no longer need one.
 */
const scopeSize: GraphComponentDefinition["parameters"] = [
  { key: "size", definition: { type: "number", label: "Size", default: 4, min: 0, max: 64 }, targets: [] },
];

describe("B238 — nested instances stay instances, and their pages keep working", () => {

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

/** The flattened fields a render reads, for one node. */
const rendered = (each: GraphNode | undefined) =>
  each === undefined ? undefined : { parameters: each.parameters, resolution: each.resolution, channelMask: each.channelMask };

describe("B239 — what flattening applies BESIDE the page reaches the copies too", () => {
  it("the instance's internal resolution overrides and channel masks land on the copies — a nested path on the nested copy", async () => {
    // Flattening applies both to the internals every compile; detach dropped both, so a
    // look whose instance set one internal node to 2×2 detached at the definition's size.
    const fixed = { mode: "fixed", width: 2, height: 2 } as const;
    const half = { mode: "scale", factor: 0.5 } as const;
    const red = { r: true, g: false, b: false, a: true };
    const detached = await detach(
      instanceOf("outer", { size: 11 }, {
        state: {
          componentResolutionOverrides: { grade: fixed, "inner/blurA": half },
          componentChannelMaskOverrides: { grade: red, "inner/solid": red },
        },
      }),
      [outer({ ...PAGE }), look()],
    );
    const grade = detached.copies["grade"]!;
    const inner = detached.copies["inner"]!;
    expect(grade.resolution).toEqual(fixed);
    expect(grade.channelMask).toEqual(red);
    // The nested path stays an override ON the nested copy, which still flattens it.
    expect(inner.state?.["componentResolutionOverrides"]).toEqual({ blurA: half });
    expect(inner.state?.["componentChannelMaskOverrides"]).toEqual({ solid: red });

    const flatten = (graph: GraphDocument) =>
      flattenComponents({ graph, registry: detached.harness.nodes, components: detached.harness.components }).graph.nodes;
    const before = flatten(detached.before);
    const after = flatten(detached.after);
    const pairs: Array<[string, string]> = [
      ["inst/grade", grade.id],
      ...["blurA", "blurB", "blurC", "solid", "deep"].map((id): [string, string] => [`inst/inner/${id}`, `${inner.id}/${id}`]),
    ];
    for (const [was, now] of pairs) {
      expect(before[was], was).toBeDefined();
      expect(rendered(after[now]), now).toEqual(rendered(before[was]));
    }
    // And the overrides are on the picture, so the equality above is not two defaults.
    expect(before["inst/grade"]?.resolution).toEqual(fixed);
    expect(before["inst/inner/blurA"]?.resolution).toEqual(half);
    expect(before["inst/inner/solid"]?.channelMask).toEqual(red);
  });

  /**
   * T1545b — THE INSTANCE'S OWN Processing Channels. Flattening masks each exposed picture
   * output, keeping the other channels of the instance's first connected input. A plain
   * node's own mask is the same pass keeping its own first input's, so the mask lands on the
   * node behind the output only where that is the same picture; elsewhere it is said by name.
   */
  const red = { r: true, g: false, b: false, a: true };
  const chain = (feedsInside: boolean): GraphComponentDefinition => ({
    componentId: "chain",
    version: 1,
    name: "Chain",
    graph: graphOf(
      [
        node("first", "test.blur", { radius: 1 }, { label: "first" }),
        node("last", "test.blur", { radius: 2 }, { label: "last" }),
        ...(feedsInside ? [node("tap", "test.blur", { radius: 3 }, { label: "tap" })] : []),
      ],
      {
        e1: { id: "e1", source: { nodeId: "first", portId: "out" }, target: { nodeId: "last", portId: "source" } },
        ...(feedsInside ? { e2: { id: "e2", source: { nodeId: "last", portId: "out" }, target: { nodeId: "tap", portId: "source" } } } : {}),
      },
    ),
    inputs: [{ externalId: "source", label: "Source", nodeId: "first", portId: "source" }],
    outputs: [
      { externalId: "out", label: "Out", nodeId: "last", portId: "out" },
      { externalId: "front", label: "Front", nodeId: "first", portId: "out" },
    ],
    parameters: [],
  });
  const feed = node("feed", "test.blur", {}, { label: "feed" });
  const fedEdge = { e9: { id: "e9", source: { nodeId: "feed", portId: "out" }, target: { nodeId: "inst", portId: "source" } } };

  it("T1545b: the instance's own channelMask lands on the node behind its output when that keeps the same input's other channels", async () => {
    // LOOK exposes blurA as both input and output: blurA's first input IS the instance's.
    const harnessed = await detach(instanceOf("look", { ...PAGE }, { channelMask: red }), [look()], [feed], fedEdge);
    expect(harnessed.codes).not.toContain("component.detach.channelMask");
    expect(harnessed.copies["blurA"]?.channelMask).toEqual(red);
    expect(harnessed.copies["solid"]?.channelMask).toBeUndefined();
  });

  it("T1545b: where the node behind the output keeps a different input's channels, or feeds something inside, it is said by name and not carried", async () => {
    const throughChain = await detach(instanceOf("chain", {}, { channelMask: red }), [chain(false)], [feed], fedEdge);
    const said = throughChain.messages.find((each) => each.code === "component.detach.channelMask");
    expect(said?.message).toBe(
      '"look1"\'s Processing Channels (R A) cannot be carried onto the copies exactly: "first"\'s picture also feeds "last" inside. The copies draw every channel.',
    );
    expect(Object.values(throughChain.copies).map((each) => each.channelMask)).toEqual([undefined, undefined]);
    const tapped = await detach(instanceOf("chain", {}, { channelMask: red }), [{ ...chain(true), outputs: [chain(true).outputs[0]!] }], [feed], fedEdge);
    expect(tapped.messages.find((each) => each.code === "component.detach.channelMask")?.message).toContain('"last"\'s picture also feeds "tap" inside');
    const onlyLast = await detach(instanceOf("chain", {}, { channelMask: red }), [{ ...chain(false), outputs: [chain(false).outputs[0]!] }], [feed], fedEdge);
    expect(onlyLast.messages.find((each) => each.code === "component.detach.channelMask")?.message).toContain(
      '"last" would keep the other channels of its input "source", where "look1" kept those of its own first input',
    );
  });

  it("an override naming no internal node is said by name, as flattening reports it", async () => {
    const detached = await detach(instanceOf("look", { ...PAGE }, { state: { componentResolutionOverrides: { gone: { mode: "fixed", width: 2, height: 2 } } } }));
    expect(detached.codes).toContain("component.detach.overrideMissing");
  });
});

describe("B239 — component.instantiate in detached mode writes the published DEFAULTS onto the copies", () => {
  it("Blur defaults to 8 and Soft to 6 while the definition holds 4: the copies render what a fresh linked instance renders", async () => {
    // A published default is re-authored on the page and need not equal the internal value
    // it drives; a fresh instance shows the DEFAULT, so a fresh copy must too.
    const base = look();
    const lookWithDefaults: GraphComponentDefinition = {
      ...base,
      parameters: base.parameters.map((published) =>
        published.key === "blur" || published.key === "soft"
          ? { ...published, definition: { ...published.definition, default: published.key === "blur" ? 8 : 6 } as typeof published.definition }
          : published),
    };
    const harness = createComponentHarness("t");
    harness.components.register(lookWithDefaults);
    const linked = await harness.bus.execute("component.instantiate", { componentId: "look" }, ctx);
    const copy = await harness.bus.execute("component.instantiate", { componentId: "look", mode: "detached", position: { x: 400, y: 0 } }, ctx);
    expect(copy.status).toBe("applied");
    const graph = harness.store.view.getGraph();
    const copies = Object.fromEntries(copy.output.nodeIds.map((id) => [graph.nodes[id]!.label!, graph.nodes[id]!]));
    expect(copies["blurA"]?.parameters["radius"]).toBe(8);
    expect(copies["blurB"]?.parameters["radius"]).toBe(6);
    expect(copies["blurC"]?.parameters["radius"]).toBe(6);
    expect(copies["blurC"]?.state).toBeUndefined();
    expect(copies["deep"]?.parameters["radius"]).toEqual(bindSlot("parent.gain", 3));
    // The stale "those bindings no longer resolve" warning is gone: they resolved, to the defaults.
    expect(copy.diagnostics.map((each) => each.code)).not.toContain("component.detach.parentBindings");

    const flat = flattenComponents({ graph, registry: harness.nodes, components: harness.components }).graph.nodes;
    for (const internalId of Object.keys(lookWithDefaults.graph.nodes)) {
      const label = lookWithDefaults.graph.nodes[internalId]!.label!;
      const under = flat[`${linked.output.nodeId}/${internalId}`];
      expect(under, internalId).toBeDefined();
      expect(flat[copies[label]!.id]?.parameters, internalId).toEqual(under?.parameters);
    }
  });
});

describe("B239 — detach inside a component edit session", () => {
  /**
   * ROOT holds `inst`, an instance of OUTER; inside OUTER sits `inner`, an instance of LOOK.
   * The session edits OUTER and detaches `inner`, so the copies land in OUTER's graph — one
   * level below the root, where OUTER's own page is in scope. The claim each time: the
   * root document flattens to the same internals before and after.
   */
  async function detachInside(definition: GraphComponentDefinition, rootPage: Record<string, StoredParameter>, inner: GraphComponentDefinition = look()) {
    const harness = createComponentHarness("t", graphOf([instanceOf("outer", rootPage)]));
    // LOOK first: OUTER's targets on `inner` validate against LOOK's page.
    harness.components.register(inner);
    harness.components.register(definition);
    const flatten = () =>
      flattenComponents({ graph: harness.store.view.getGraph(), registry: harness.nodes, components: harness.components }).graph.nodes;
    const before = flatten();
    const session = openComponentSession({ components: harness.components, nodes: harness.nodes, componentId: "outer", version: 1 });
    const result = await session.bus.execute("component.detach", { nodeId: "inner" }, ctx);
    session.dispose();
    expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
    const after = flatten();
    const outerAfter = harness.components.get("outer", 1)!;
    const copies: Record<string, GraphNode> = {};
    for (const id of result.output.nodeIds) {
      const copy = outerAfter.graph.nodes[id];
      if (copy?.label !== undefined) copies[copy.label] = copy;
    }
    expect(Object.keys(copies).sort()).toEqual(["blurA", "blurB", "blurC", "deep", "solid"]);
    const pairs = Object.entries(copies).map(([internalId, copy]): [string, unknown, unknown] => {
      expect(before[`inst/inner/${internalId}`], internalId).toBeDefined();
      return [internalId, rendered(before[`inst/inner/${internalId}`]), rendered(after[`inst/${copy.id}`])];
    });
    return { before, after, copies, pairs, outerAfter, codes: result.diagnostics.map((each) => each.code) };
  }

  it("the instance's own legacy state.parentBindings are CARRIED, not baked: Blur and Soft keep reading OUTER's Size 11", async () => {
    const inside = await detachInside(
      outer({ ...PAGE }, { state: { [PARENT_BINDINGS_STATE_KEY]: { blur: "parent.size", soft: "parent.size" } } }, scopeSize),
      { size: 11 },
    );
    // Fan-out target: the page value stays as the fallback, the binding reads OUTER's page.
    expect(inside.copies["blurA"]?.parameters["radius"]).toBe(2);
    expect(inside.copies["blurA"]?.state?.[PARENT_BINDINGS_STATE_KEY]).toEqual({ radius: "parent.size" });
    // One-hop reads of Soft — a bind slot and a legacy binding — follow it there too.
    expect(inside.copies["blurB"]?.state?.[PARENT_BINDINGS_STATE_KEY]).toEqual({ radius: "parent.size" });
    expect(inside.copies["blurC"]?.state?.[PARENT_BINDINGS_STATE_KEY]).toEqual({ radius: "parent.size" });
    for (const [internalId, before, after] of inside.pairs) expect(after, internalId).toEqual(before);
    expect(inside.after[`inst/${inside.copies["blurA"]!.id}`]?.parameters["radius"]).toBe(11);
  });

  it("a sibling bind chaining to a parent. bind resolves like flattening: Blur → Soft → parent.size reads 11, not Soft's retained 7", async () => {
    const inside = await detachInside(outer({ ...PAGE, blur: bindSlot("soft", 1), soft: bindSlot("parent.size", 7) }, {}, scopeSize), { size: 11 });
    expect(inside.copies["blurA"]?.parameters["radius"]).toEqual(bindSlot("parent.size", 7));
    for (const [internalId, before, after] of inside.pairs) expect(after, internalId).toEqual(before);
    expect(inside.after[`inst/${inside.copies["blurA"]!.id}`]?.parameters["radius"]).toBe(11);
  });

  it("OUTER's published targets on the instance's keys move onto the copies; a read of a moved key reads OUTER's knob", async () => {
    const size = { type: "number", label: "Size", default: 4, min: 0, max: 64 } as const;
    const inside = await detachInside(
      outer({ ...PAGE }, {}, [
        { key: "size", definition: size, targets: [{ nodeId: "grade", key: "radius" }, { nodeId: "inner", key: "blur" }, { nodeId: "inner", key: "soft" }] },
        { key: "mood", definition: { type: "number", label: "Mood", default: 0.5, min: 0, max: 1 }, targets: [{ nodeId: "inner", key: "amount" }] },
      ]),
      { size: 11, mood: 0.75 },
    );
    const page = Object.fromEntries(inside.outerAfter.parameters.map((published) => [published.key, published.targets]));
    expect(page["size"]).toEqual([{ nodeId: "grade", key: "radius" }, { nodeId: inside.copies["blurA"]!.id, key: "radius" }]);
    expect(page["mood"]).toEqual([{ nodeId: inside.copies["solid"]!.id, key: "amount" }]);
    // Soft drives nothing; what read parent.soft now reads OUTER's Size directly.
    expect(inside.copies["blurB"]?.parameters["radius"]).toEqual(bindSlot("parent.size", 1));
    expect(inside.copies["blurC"]?.state?.[PARENT_BINDINGS_STATE_KEY]).toEqual({ radius: "parent.size" });
    for (const [internalId, before, after] of inside.pairs) expect(after, internalId).toEqual(before);
    expect(inside.after[`inst/${inside.copies["solid"]!.id}`]?.parameters["amount"]).toBe(0.75);
  });

  it("an outer knob whose only target was a page key with no targets of its own takes that key's parent. readers, and they keep it published", async () => {
    // B240: Ghost drove Soft, which drives nothing and exists for parent.soft. Those reads
    // become parent.ghost on the copies, so Ghost loses its last target yet is still read;
    // unpublishing it left blurB and blurC on their retained statics.
    const inside = await detachInside(
      outer({ ...PAGE }, {}, [
        ...scopeSize,
        { key: "ghost", definition: { type: "number", label: "Ghost", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "inner", key: "soft" }] },
      ]),
      { size: 11, ghost: 9 },
    );
    expect(inside.codes).not.toContain("component.detach.outerTarget");
    expect(inside.outerAfter.parameters.map((published) => [published.key, published.targets])).toEqual([["size", []], ["ghost", []]]);
    expect(inside.copies["blurB"]?.parameters["radius"]).toEqual(bindSlot("parent.ghost", 1));
    for (const [internalId, before, after] of inside.pairs) expect(after, internalId).toEqual(before);
    expect(inside.after[`inst/${inside.copies["blurB"]!.id}`]?.parameters["radius"]).toBe(9);
  });

  /**
   * T1545b — A CARRIED READ SKIPS THE PAGE KNOB'S CHECK. Flattening does not clamp a value
   * that reaches a page knob from outside: the knob refuses it, as an error, and the page keeps (here
   * Blur's stored 2). The copies read parent.size directly and check it only against their
   * own radius, so where OUTER's Size can hold what Blur refuses, detach says so by name.
   */
  const narrowBlur = (max: number): GraphComponentDefinition => ({
    ...look(),
    parameters: look().parameters.map((published) =>
      published.key === "blur" ? { ...published, definition: { type: "number", label: "Blur", default: 4, min: 0, max } } : published,
    ),
  });
  const legacyBlur = { state: { [PARENT_BINDINGS_STATE_KEY]: { blur: "parent.size" } } };

  it("T1545b: OUTER's Size (0..64) can hold what Blur (0..10) refuses — said by name, and true: at Size 30 the instance drew Blur's own 2, the copies draw 30", async () => {
    const inside = await detachInside(outer({ ...PAGE }, legacyBlur, scopeSize), { size: 30 }, narrowBlur(10));
    expect(inside.codes).toContain("component.detach.inexact");
    const blurA = inside.copies["blurA"]!.id;
    expect(inside.before["inst/inner/blurA"]?.parameters["radius"]).toBe(2);
    expect(inside.after[`inst/${blurA}`]?.parameters["radius"]).toBe(30);
  });

  it("T1545b: OUTER's Size (0..10) inside Blur's range (0..10) — nothing said, and every flattened internal matches", async () => {
    const inside = await detachInside(
      outer({ ...PAGE }, legacyBlur, [{ key: "size", definition: { type: "number", label: "Size", default: 4, min: 0, max: 10 }, targets: [] }]),
      { size: 7 },
      narrowBlur(10),
    );
    expect(inside.codes).not.toContain("component.detach.inexact");
    for (const [internalId, before, after] of inside.pairs) expect(after, internalId).toEqual(before);
    expect(inside.after[`inst/${inside.copies["blurA"]!.id}`]?.parameters["radius"]).toBe(7);
  });

  it("an outer knob whose only target cannot move (one channel of Tint) and that nothing reads is unpublished, and said by name", async () => {
    const inside = await detachInside(
      outer({ ...PAGE }, {}, [
        ...scopeSize,
        { key: "red", definition: { type: "number", label: "Red", default: 0.5, min: 0, max: 1 }, targets: [{ nodeId: "inner", key: "tint.r" }] },
      ]),
      { size: 11, red: 0.75 },
    );
    expect(inside.codes.filter((code) => code === "component.detach.outerTarget")).toHaveLength(2);
    expect(inside.outerAfter.parameters.map((published) => published.key)).toEqual(["size"]);
  });
});

/**
 * T1545b — UNDO OF AN IN-SESSION DETACH. The session's store holds OUTER's graph; the
 * detach also moved OUTER's published targets and its output exposure onto the copies, in
 * the catalogue only. Undo brought `inner` back with the page still aimed at copies that
 * were gone, so the write-back prune dropped them: Size and Mood lost their targets and
 * OUTER exposed nothing. The session now records the definition with the step.
 */
describe("T1545b — undo and redo inside a component session restore the definition with the graph", () => {
  const size = { type: "number", label: "Size", default: 4, min: 0, max: 64 } as const;
  const mood = { type: "number", label: "Mood", default: 0.5, min: 0, max: 1 } as const;
  const outerWithKnobs = (): GraphComponentDefinition => ({
    ...outer({ ...PAGE }, {}, [
      { key: "size", definition: size, targets: [{ nodeId: "grade", key: "radius" }, { nodeId: "inner", key: "blur" }] },
      { key: "mood", definition: mood, targets: [{ nodeId: "inner", key: "amount" }] },
    ]),
    outputs: [
      { externalId: "out", label: "Out", nodeId: "inner", portId: "out" },
      { externalId: "side", label: "Side", nodeId: "grade", portId: "out" },
    ],
  });

  function opened(definition: GraphComponentDefinition) {
    const harness = createComponentHarness("t", graphOf([instanceOf("outer", { size: 11, mood: 0.75 })]));
    harness.components.register(look());
    harness.components.register(definition);
    const session = openComponentSession({ components: harness.components, nodes: harness.nodes, componentId: "outer", version: 1 });
    const shell = () => {
      const { graph: _graph, ...rest } = harness.components.get("outer", 1)!;
      void _graph;
      return JSON.parse(JSON.stringify(rest)) as unknown;
    };
    const flat = () => {
      const flattened = flattenComponents({ graph: harness.store.view.getGraph(), registry: harness.nodes, components: harness.components });
      return Object.values(flattened.graph.nodes).map((each) => [each.type, rendered(each)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    };
    return { harness, session, shell, flat };
  }

  it("detach, undo: OUTER's page targets and exposure are back on inner, and the root flattens as before; redo puts them back on the copies", async () => {
    const { harness, session, shell, flat } = opened(outerWithKnobs());
    const shellBefore = shell();
    const flatBefore = flat();
    const detached = await session.bus.execute("component.detach", { nodeId: "inner" }, ctx);
    expect(detached.status).toBe("applied");
    const shellAfter = shell();
    expect(shellAfter).not.toEqual(shellBefore);
    expect(flat()).toEqual(flatBefore);

    expect((await session.bus.execute("graph.undo", {}, ctx)).status).toBe("applied");
    expect(harness.components.get("outer", 1)?.graph.nodes["inner"]).toBeDefined();
    expect(shell()).toEqual(shellBefore);
    expect(flat()).toEqual(flatBefore);

    expect((await session.bus.execute("graph.redo", {}, ctx)).status).toBe("applied");
    expect(harness.components.get("outer", 1)?.graph.nodes["inner"]).toBeUndefined();
    expect(shell()).toEqual(shellAfter);
    expect(flat()).toEqual(flatBefore);
    session.dispose();
  });

  it("the general case: deleting the node a knob and an exposure name prunes both, and undo brings them back with the node", async () => {
    const { harness, session, shell } = opened(outerWithKnobs());
    const shellBefore = shell();
    const removed = await session.bus.execute(
      "graph.applyPatch",
      { baseRevision: session.store.view.getRevision(), label: "delete grade", operations: [{ op: "removeNodes", nodeIds: ["grade"] }] },
      ctx,
    );
    expect(removed.status).toBe("applied");
    const pruned = harness.components.get("outer", 1)!;
    expect(pruned.parameters.find((each) => each.key === "size")?.targets).toEqual([{ nodeId: "inner", key: "blur" }]);
    expect(pruned.outputs.map((each) => each.externalId)).toEqual(["out"]);
    expect((await session.bus.execute("graph.undo", {}, ctx)).status).toBe("applied");
    expect(shell()).toEqual(shellBefore);
    expect((await session.bus.execute("graph.redo", {}, ctx)).status).toBe("applied");
    expect(harness.components.get("outer", 1)!.parameters.find((each) => each.key === "size")?.targets).toEqual([{ nodeId: "inner", key: "blur" }]);
    session.dispose();
  });

  // §T1546b made a publish an undo step of its own, so alice's Undo now takes back her own
  // publish first (`session-undo.test.ts`). What can still change the definition after a
  // step without being undone first is ANOTHER actor's edit (§V41): that publish survives.
  it("a publish another actor made after the step survives the step's undo", async () => {
    const { harness, session } = opened(outerWithKnobs());
    expect((await session.bus.execute("component.detach", { nodeId: "inner" }, ctx)).status).toBe("applied");
    const published = await session.bus.execute(
      "component.publishParameter",
      { key: "extra", definition: { type: "number", label: "Extra", default: 1, min: 0, max: 8 }, targets: [{ nodeId: "grade", key: "radius" }] },
      contextFor(agent),
    );
    expect(published.status).toBe("applied");
    expect((await session.bus.execute("graph.undo", {}, ctx)).status).toBe("applied");
    const after = harness.components.get("outer", 1)!;
    expect(after.parameters.map((each) => each.key)).toContain("extra");
    // The exposure, which nothing else touched, is still restored onto inner.
    expect(after.outputs[0]).toEqual({ externalId: "out", label: "Out", nodeId: "inner", portId: "out" });
    session.dispose();
  });
});

/**
 * T1545b — PATHS INTO THE DETACHED INSTANCE, held outside the session. The root's instance
 * of OUTER overrides inner's Blur, sizes inner's blurA and masks inner/solid; a SHELL
 * component holds another OUTER instance sizing inner's blurA. Detaching `inner` inside
 * OUTER leaves every one of those naming nothing, in stores the session's undo does not
 * reach, so they are said per holder, with what each would name on the copies.
 */
describe("T1545b — an in-session detach names the root and catalogue paths it leaves dangling", () => {
  const red = { r: true, g: false, b: false, a: true };
  const shell = (): GraphComponentDefinition => ({
    componentId: "shell",
    version: 1,
    name: "Shell",
    graph: graphOf([
      instanceOf("outer", { size: 3 }, { id: "held", label: "held", state: { componentResolutionOverrides: { "inner/blurA": { mode: "fixed", width: 2, height: 2 } } } }),
    ]),
    inputs: [],
    outputs: [],
    parameters: [],
  });

  async function detachInner(root: boolean) {
    const rootInstance = instanceOf("outer", { size: 11 }, {
      label: "scene",
      state: {
        [COMPONENT_OVERRIDES_STATE_KEY]: { "inner/blur": 5, "grade/radius": 2 },
        componentResolutionOverrides: { "inner/blurA": { mode: "fixed", width: 2, height: 2 }, grade: { mode: "fixed", width: 4, height: 4 } },
        componentChannelMaskOverrides: { "inner/solid": red },
      },
    });
    const harness = createComponentHarness("t", graphOf([rootInstance]));
    harness.components.register(look());
    harness.components.register(outer({ ...PAGE }));
    harness.components.register(shell());
    const session = openComponentSession({
      components: harness.components,
      nodes: harness.nodes,
      componentId: "outer",
      version: 1,
      ...(root ? { root: () => harness.store.view.getGraph() } : {}),
    });
    const result = await session.bus.execute("component.detach", { nodeId: "inner" }, ctx);
    session.dispose();
    expect(result.status).toBe("applied");
    return result.diagnostics.filter((each) => each.code === "component.detach.instancePaths");
  }

  it("names the root instance's override, resolution and mask paths, and the catalogue holder's, with the copies they would name", async () => {
    const said = await detachInner(true);
    expect(said.map((each) => each.message)).toEqual([
      '"scene" in the project sets override inner/blur, resolution inner/blurA, channel mask inner/solid inside "inner"; with "inner" detached, those paths name nothing.',
      '"held" in component "Shell" sets resolution inner/blurA inside "inner"; with "inner" detached, those paths name nothing.',
    ]);
    expect(said[0]?.suggestion).toBe(
      "Set them again on scene (resolution blurA, channel mask solid), or undo the detach. This editor cannot rewrite them: they live in the project, outside this component's undo history.",
    );
  });

  it("paths that do not reach inner (grade) are not named; without the project document only the catalogue holder is", async () => {
    const said = await detachInner(false);
    expect(said.map((each) => each.message)).toEqual([
      '"held" in component "Shell" sets resolution inner/blurA inside "inner"; with "inner" detached, those paths name nothing.',
    ]);
  });
});
