import { describe, expect, it } from "vitest";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { componentNodeDefinition, internalParameterOf, pruneComponentDefinition, validateComponentDefinition } from "./definition.ts";
import { defaultPublishedValues } from "./published-parameter.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { customWgslMultiNode, customWgslNode } from "../../nodes/definitions/custom-wgsl.ts";
import { buildComponentFromSelection } from "./save-selection.ts";
import { componentSourcePath, effectiveInternalOverrides, internalParameterValues } from "./flatten.ts";
import {
  PARENT_BINDINGS_STATE_KEY,
  componentInstances,
  internalParameterPath,
  parseInternalParameterPath,
  readComponentInstance,
} from "./instance.ts";
import { migrationChain, planComponentUpgrade } from "./upgrade.ts";
import { blurKnob, bloomComponent, graphOf, instanceNode, node } from "./test-support.ts";
import type { ComponentGraphSource } from "./recursion.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ParameterSlot } from "../types/parameters.ts";
import { createComponentSystem } from "./registry.ts";
import { createGraphStore } from "../graph/store.ts";
import { createDomainBus } from "../commands/index.ts";
import { alice, contextFor } from "../commands/test-support.ts";
import { authoredGraph } from "../types/graph.ts";
import { validateGraph, validateRequiredInputs } from "../../compiler/validate.ts";
import { openComponentSession } from "./session.ts";
import { componentLibrarySchema, serializeComponentLibrary } from "./schemas.ts";
import { DATA_TEXTURE } from "../../nodes/definitions/common-ports.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import { renderNode } from "../../nodes/definitions/scene.ts";

const nodes = createTestRegistry().view();
/** A catalogue with nothing in it: the definition under test holds no nested instances. */
const noNested: ComponentGraphSource = { graphOf: () => undefined };

describe("synthesized manifest", () => {
  const directInputs = () => ({
    ...bloomComponent("direct", 1),
    graph: graphOf([node("mix", "test.composite")]),
    inputs: [
      { externalId: "pictures", label: "Pictures", nodeId: "mix", portId: "layers" },
      { externalId: "matte", label: "Matte", nodeId: "mix", portId: "mask" },
    ],
    outputs: [{ externalId: "picture", label: "Picture", nodeId: "mix", portId: "out" }],
  });

  it.each([
    ["test.composite", "layers", "mask"],
    ["customWgslMulti", "more", "input"],
  ])("accepts several normal connections to a deliberately exposed %s %s input", async (type, variadicPort, otherPort) => {
    const registry = createNodeRegistry([...nodes.list(), customWgslMultiNode]).view();
    const definition = {
      ...directInputs(),
      graph: graphOf([node("mix", type)]),
      inputs: directInputs().inputs.map((port) => ({ ...port, portId: port.portId === "layers" ? variadicPort : otherPort })),
    };
    const system = createComponentSystem(registry, [definition]);
    const session = openComponentSession({ components: system.components, nodes: system.nodes, componentId: "direct", version: 1 });
    const exposed = await session.bus.execute("component.exposePort", {
      direction: "input", nodeId: "mix", portId: variadicPort, externalId: "pictures", label: "Pictures",
    }, contextFor(alice));
    expect(exposed.status).toBe("applied");
    session.dispose();
    expect(system.components.get("direct", 1)?.inputs[0]).toEqual({
      externalId: "pictures", label: "Pictures", nodeId: "mix", portId: variadicPort, variadic: true,
    });
    const store = createGraphStore({ initialGraph: graphOf([
      node("src1", "test.solid"), node("src2", "test.solid"), instanceNode("instance", "direct", 1),
    ]) });
    const { bus } = createDomainBus({ store, registry: system.nodes });
    const result = await bus.execute("graph.applyPatch", { baseRevision: store.view.getRevision(), operations: [
      { op: "connect", source: { nodeId: "src1", portId: "out" }, target: { nodeId: "instance", portId: "pictures" } },
      { op: "connect", source: { nodeId: "src2", portId: "out" }, target: { nodeId: "instance", portId: "pictures" } },
      { op: "connect", source: { nodeId: "src1", portId: "out" }, target: { nodeId: "instance", portId: "matte" } },
    ] }, contextFor(alice));
    expect(result.status, JSON.stringify(result)).toBe("applied");
    expect(Object.values(store.view.getGraph().edges).filter((edge) => edge.target.portId === "pictures").map((edge) => edge.order)).toEqual([0, 1]);
  });

  it("retains whole-input metadata through the serialized library without widening legacy slots", async () => {
    const legacy = directInputs();
    const whole = { ...directInputs(), componentId: "whole", inputs: directInputs().inputs.map((port) =>
      port.portId === "layers" ? { ...port, variadic: true as const } : port) };
    const serialized = JSON.parse(JSON.stringify(serializeComponentLibrary([legacy, whole]))) as unknown;
    const parsed = componentLibrarySchema.parse(serialized);
    const reloaded = createComponentSystem(nodes, parsed.components as GraphComponentDefinition[]);
    expect(reloaded.components.get("direct", 1)?.inputs).toEqual(legacy.inputs);
    expect(reloaded.nodes.port(instanceNode("i", "direct", 1).type, "pictures", "input")?.variadic).toBeUndefined();
    expect(reloaded.components.get("whole", 1)?.inputs).toEqual(whole.inputs);
    expect(reloaded.nodes.port(instanceNode("i", "whole", 1).type, "pictures", "input")?.variadic).toBe(true);
    const store = createGraphStore({ initialGraph: graphOf([
      node("src1", "test.solid"), node("src2", "test.solid"), instanceNode("instance", "direct", 1),
    ]) });
    const { bus } = createDomainBus({ store, registry: reloaded.nodes });
    const result = await bus.execute("graph.applyPatch", { baseRevision: store.view.getRevision(), operations: [
      { op: "connect", source: { nodeId: "src1", portId: "out" }, target: { nodeId: "instance", portId: "pictures" } },
      { op: "connect", source: { nodeId: "src2", portId: "out" }, target: { nodeId: "instance", portId: "pictures" } },
    ] }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.map((diagnostic) => diagnostic.code)).toContain("port.occupied");
    expect(store.view.getGraph().edges).toEqual({});
  });

  it.each([false, true])("keeps extracted slots fixed when an internal feed is %s", (internalFeed) => {
    const measurements = { ...nodes.require("test.solid"), type: "test.measurements", outputs: [{ id: "out", label: "Out", type: DATA_TEXTURE }] };
    const registry = createNodeRegistry([...nodes.list(), customWgslMultiNode, measurements]).view();
    const graph = graphOf([node("a", "test.measurements"), node("b", "test.measurements"), node("shader", "customWgslMulti")], {
      first: { id: "first", source: { nodeId: "a", portId: "out" }, target: { nodeId: "shader", portId: "more" }, order: 0 },
      second: { id: "second", source: { nodeId: "b", portId: "out" }, target: { nodeId: "shader", portId: "more" }, order: 1 },
    });
    const built = buildComponentFromSelection({ graph, nodeIds: internalFeed ? ["shader", "b"] : ["shader"], componentId: "fixed", name: "Fixed", nodes: registry });
    const system = createComponentSystem(registry, [built.definition]);
    const ports = system.nodes.require(instanceNode("i", "fixed", 1).type).inputs;
    expect(ports).toHaveLength(internalFeed ? 1 : 2);
    expect(ports.every((port) => port.optional === true && port.variadic === undefined)).toBe(true);
    expect(built.definition.inputs.every((port) => port.variadic === undefined)).toBe(true);
  });

  it.each(["input", "output"] as const)("refuses whole-variadic metadata on a non-variadic %s", (direction) => {
    const definition = directInputs();
    const invalid = direction === "input"
      ? { ...definition, inputs: definition.inputs.map((port) => port.portId === "mask" ? { ...port, variadic: true as const } : port) }
      : { ...definition, outputs: definition.outputs.map((port) => ({ ...port, variadic: true as const })) };
    expect(validateComponentDefinition(invalid, nodes).map((diagnostic) => diagnostic.code)).toContain("component.port.variadic");
    expect(() => createComponentSystem(nodes, [invalid])).toThrow("not a variadic input");
  });

  it.each(["feed", "alias"] as const)("refuses exposing a whole input beside an existing internal %s atomically", async (conflict) => {
    const base = directInputs();
    const definition = conflict === "feed"
      ? { ...base, graph: graphOf([node("mix", "test.composite"), node("inside", "test.solid")], {
        hidden: { id: "hidden", source: { nodeId: "inside", portId: "out" }, target: { nodeId: "mix", portId: "layers" }, order: 1 },
      }) }
      : { ...base, inputs: [...base.inputs, { externalId: "second", label: "Second", nodeId: "mix", portId: "layers" }] };
    const system = createComponentSystem(nodes, [definition]);
    const before = JSON.stringify(system.components.get("direct", 1));
    const session = openComponentSession({ components: system.components, nodes: system.nodes, componentId: "direct", version: 1 });
    try {
      const revision = session.store.view.getRevision();
      const result = await session.bus.execute("component.exposePort", {
        direction: "input", nodeId: "mix", portId: "layers", externalId: "pictures", label: "Pictures",
      }, contextFor(alice));
      expect(result.status).toBe("rejected");
      expect(result.diagnostics?.map((diagnostic) => diagnostic.code)).toContain("component.port.variadic");
      expect(session.store.view.getRevision()).toBe(revision);
      expect(JSON.stringify(system.components.get("direct", 1))).toBe(before);
    } finally { session.dispose(); }
  });

  it("refuses adding a second exposure to an already whole input", () => {
    const base = directInputs();
    const definition = {
      ...base,
      inputs: [
        { ...base.inputs[0]!, variadic: true as const },
        base.inputs[1]!,
        { externalId: "second", label: "Second", nodeId: "mix", portId: "layers" },
      ],
    };
    expect(validateComponentDefinition(definition, nodes).map((diagnostic) => diagnostic.code)).toContain("component.port.variadic");
  });

  it.each([
    [{ scenes: "geometry_inside" }, false],
    [{ scenes: " , \n " }, true],
    [{ lights: "light_inside" }, true],
  ] as const)("checks only active named feeds of the whole input (%j)", (parameters, valid) => {
    const registry = createNodeRegistry([...nodes.list(), renderNode]).view();
    const definition = {
      ...directInputs(),
      graph: graphOf([node("render", "render", { ...parameters })]),
      inputs: [{ externalId: "scene", label: "Scene", nodeId: "render", portId: "scenes", variadic: true as const }],
      outputs: [{ externalId: "out", label: "Out", nodeId: "render", portId: "out" }],
    };
    const codes = validateComponentDefinition(definition, registry).map((diagnostic) => diagnostic.code);
    if (valid) expect(codes).not.toContain("component.port.variadic");
    else expect(codes).toContain("component.port.variadic");
  });

  it("keeps an unwired directly exposed optional input optional in authored validation", () => {
    const system = createComponentSystem(nodes, [directInputs()]);
    const graph = graphOf([node("src", "test.solid"), instanceNode("instance", "direct", 1)], {
      feed: { id: "feed", source: { nodeId: "src", portId: "out" }, target: { nodeId: "instance", portId: "pictures" } },
    });
    const validated = validateGraph(authoredGraph(graph), system.nodes);
    expect(validateRequiredInputs(validated.nodes, validated.edges, new Set(["instance"]))).toEqual([]);
    const manifest = system.nodes.require(instanceNode("instance", "direct", 1).type);
    expect(manifest.inputs.map(({ id, label, type, optional }) => ({ id, label, type, optional }))).toEqual([
      { id: "pictures", label: "Pictures", type: nodes.port("test.composite", "layers", "input")!.type, optional: undefined },
      { id: "matte", label: "Matte", type: nodes.port("test.composite", "mask", "input")!.type, optional: true },
    ]);
    expect(manifest.outputs).toEqual([{ id: "picture", label: "Picture", type: nodes.port("test.composite", "out", "output")!.type }]);
  });

  it("permits a directly exposed Custom WGSL More input to stay unwired", () => {
    const registry = createNodeRegistry([...nodes.list(), customWgslMultiNode]).view();
    const definition = {
      ...directInputs(),
      graph: graphOf([node("shader", "customWgslMulti")]),
      inputs: [
        { externalId: "picture", label: "Picture", nodeId: "shader", portId: "input" },
        { externalId: "data", label: "Data", nodeId: "shader", portId: "more", variadic: true as const },
      ],
      outputs: [{ externalId: "out", label: "Out", nodeId: "shader", portId: "out" }],
    };
    const system = createComponentSystem(registry, [definition]);
    const graph = graphOf([node("src", "test.solid"), instanceNode("instance", "direct", 1)], {
      feed: { id: "feed", source: { nodeId: "src", portId: "out" }, target: { nodeId: "instance", portId: "picture" } },
    });
    const validated = validateGraph(authoredGraph(graph), system.nodes);
    expect(validateRequiredInputs(validated.nodes, validated.edges, new Set(["instance"]))).toEqual([]);
    expect(system.nodes.port(instanceNode("instance", "direct", 1).type, "data", "input")).toMatchObject({ optional: true });
  });

  it("refuses to compile as a node — a component is FLATTENED, not compiled (§V82)", () => {
    const manifest = componentNodeDefinition(bloomComponent("bloom", 1, [blurKnob]), nodes);
    const compiled = manifest.compile({});
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("component.notFlattened");
  });

  it("drops an exposed port whose internal port cannot be typed rather than inventing a type", () => {
    const broken = {
      ...bloomComponent("bloom", 1),
      outputs: [{ externalId: "out", label: "Out", nodeId: "blurA", portId: "nope" }],
    };
    expect(componentNodeDefinition(broken, nodes).outputs).toEqual([]);
    expect(validateComponentDefinition(broken, nodes).map((d) => d.code)).toContain(
      "component.port.missingPort",
    );
  });
});

describe("validateComponentDefinition", () => {
  it("warns when a published range reaches outside the target's", () => {
    const definition = bloomComponent("bloom", 1, [
      {
        key: "blur",
        // test.blur's radius stops at 64; a knob that goes to 200 refuses at the edit.
        definition: { type: "number", label: "Blur", default: 4, min: 0, max: 200 },
        targets: [{ nodeId: "blurA", key: "radius" }],
      },
    ]);
    expect(validateComponentDefinition(definition, nodes).map((d) => d.code)).toContain(
      "component.parameter.rangeWiderThanTarget",
    );
  });

  it("only WARNS about a published parameter with no targets — it may be pure scope (§V81)", () => {
    const definition = bloomComponent("bloom", 1, [
      { key: "scope", definition: { type: "number", label: "Scope", default: 1 }, targets: [] },
    ]);
    const diagnostics = validateComponentDefinition(definition, nodes);
    expect(diagnostics.every((diagnostic) => diagnostic.severity !== "error")).toBe(true);
  });

  it("rejects a componentId carrying the version separator", () => {
    const definition = { ...bloomComponent("bloom@2", 1) };
    expect(validateComponentDefinition(definition, nodes).map((d) => d.code)).toContain("component.id");
  });
});

describe("pruneComponentDefinition", () => {
  it("drops exposures and targets that no longer exist, and unpublishes an empty knob", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    const remaining = { ...definition.graph.nodes };
    delete remaining.blurA;
    delete remaining.blurB;
    delete remaining.blurC;

    const pruned = pruneComponentDefinition(
      { ...definition, graph: { ...definition.graph, nodes: remaining } },
      nodes,
      noNested,
    );
    expect(pruned.inputs).toEqual([]);
    expect(pruned.outputs).toEqual([]);
    expect(pruned.parameters).toEqual([]);
  });

  it("keeps the surviving targets of a partly-broken knob", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    const remaining = { ...definition.graph.nodes };
    delete remaining.blurC;
    const pruned = pruneComponentDefinition(
      { ...definition, graph: { ...definition.graph, nodes: remaining } },
      nodes,
      noNested,
    );
    expect(pruned.parameters[0]?.targets.map((target) => target.nodeId)).toEqual(["blurA", "blurB"]);
  });

  /*
   * B240 — the prune unpublished EVERY knob with zero targets on every session edit, so a
   * knob published as pure lexical scope (§V81: read inside only as `parent.<key>`) was gone
   * after the next unrelated edit. The rule now: a knob goes only when the edit took its
   * LAST target and nothing inside reads it; a knob that came in with no targets stays.
   */
  const bindSlot = (ref: string, mode: ParameterSlot["mode"] = "bind"): ParameterSlot => ({
    mode,
    bindings: { bind: { kind: "bind", ref }, static: { kind: "static", value: 1 } },
  });
  /** The bloom with every target of `blur` deleted, and `extra` beside what is left. */
  const lostEveryTarget = (extra: GraphNode[]) => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    return { ...definition, graph: graphOf(extra) };
  };
  const reader = (parameters: GraphNode["parameters"], extra: Partial<GraphNode> = {}): GraphNode =>
    node("reader", "test.blur", {}, { parameters, ...extra });
  const nested = (graph: GraphDocument): ComponentGraphSource => ({
    graphOf: (componentId) => (componentId === "inner" ? graph : undefined),
  });
  const nestedInstance = (page: GraphNode["parameters"] = {}): GraphNode => ({ ...instanceNode("nest", "inner", 1), parameters: page });

  it("keeps a knob published with NO targets, whether or not anything reads it yet", () => {
    const scope = { key: "scope", definition: { type: "number" as const, label: "Scope", default: 1 }, targets: [] };
    const pruned = pruneComponentDefinition(bloomComponent("bloom", 1, [scope]), nodes, noNested);
    expect(pruned.parameters).toEqual([scope]);
  });

  it.each([
    ["a parent.<key> bind slot", [reader({ radius: bindSlot("parent.blur") })], noNested],
    ["a parent.<key> bind kept behind a static, one click from reading again", [reader({ radius: bindSlot("parent.blur", "static") })], noNested],
    ["a legacy state.parentBindings entry", [reader({ radius: 4 }, { state: { [PARENT_BINDINGS_STATE_KEY]: { radius: "parent.blur" } } })], noNested],
    ["a nested instance's page bound to parent.<key>", [nestedInstance({ size: bindSlot("parent.blur") })], noNested],
    [
      "parent.parent.<key> inside a nested instance's definition",
      [nestedInstance()],
      nested(graphOf([node("deep", "test.blur", {}, { parameters: { radius: bindSlot("parent.parent.blur") } })])),
    ],
  ] as const)("keeps a knob that lost its last target while %s reads it", (_, extra, source) => {
    const pruned = pruneComponentDefinition(lostEveryTarget([...extra]), nodes, source);
    expect(pruned.parameters.map((published) => [published.key, published.targets])).toEqual([["blur", []]]);
  });

  it.each([
    ["nothing reads it", [reader({ radius: 4 })], noNested],
    ["a read two hops out (parent.parent.blur) names a different component", [reader({ radius: bindSlot("parent.parent.blur") })], noNested],
    ["a sibling bind named like the key is not a parent read", [reader({ radius: bindSlot("blur") })], noNested],
    [
      "a nested definition's parent.blur reads ITS OWN page, and a self-nesting definition is walked once",
      [nestedInstance()],
      nested(graphOf([node("deep", "test.blur", {}, { parameters: { radius: bindSlot("parent.blur") } }), nestedInstance()])),
    ],
  ] as const)("still unpublishes a knob that lost its last target when %s", (_, extra, source) => {
    const pruned = pruneComponentDefinition(lostEveryTarget([...extra]), nodes, source);
    expect(pruned.parameters).toEqual([]);
  });
});

describe("buildComponentFromSelection", () => {
  it("exposes ONE output for a port feeding several outside targets", () => {
    const graph = graphOf(
      [
        node("b1", "test.blur"),
        node("out1", "test.composite"),
        node("out2", "test.composite"),
      ],
      {
        e1: { id: "e1", source: { nodeId: "b1", portId: "out" }, target: { nodeId: "out1", portId: "layers" } },
        e2: { id: "e2", source: { nodeId: "b1", portId: "out" }, target: { nodeId: "out2", portId: "layers" } },
      },
    );
    const built = buildComponentFromSelection({
      graph,
      nodeIds: ["b1"],
      componentId: "c",
      name: "One",
      nodes,
    });
    expect(built.definition.outputs).toHaveLength(1);
    // ...but both outside edges are rewired through it, or the user loses a connection.
    expect(built.outputWiring).toHaveLength(2);
  });

  it("gives two exposures distinct ids when one internal port is fed twice", () => {
    const graph = graphOf(
      [node("src1", "test.solid"), node("src2", "test.solid"), node("comp", "test.composite")],
      {
        e1: { id: "e1", source: { nodeId: "src1", portId: "out" }, target: { nodeId: "comp", portId: "layers" } },
        e2: { id: "e2", source: { nodeId: "src2", portId: "out" }, target: { nodeId: "comp", portId: "layers" } },
      },
    );
    const built = buildComponentFromSelection({
      graph,
      nodeIds: ["comp"],
      componentId: "c",
      name: "Two",
      nodes,
    });
    expect(built.definition.inputs.map((port) => port.externalId)).toEqual(["layers", "layers_2"]);
  });

  it("places the instance at the centre of what it replaces", () => {
    const graph = graphOf([
      node("a", "test.blur", {}, { position: { x: 0, y: 0 } }),
      node("b", "test.blur", {}, { position: { x: 100, y: 50 } }),
    ]);
    const built = buildComponentFromSelection({
      graph,
      nodeIds: ["a", "b"],
      componentId: "c",
      name: "Mid",
      nodes,
    });
    expect(built.position).toEqual({ x: 50, y: 25 });
  });
});

describe("what the flattening compiler reads (§V82)", () => {
  it("expands one published value into every internal target it drives", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    expect(internalParameterValues(definition, { blur: 5 })).toEqual({
      "blurA/radius": 5,
      "blurB/radius": 5,
      "blurC/radius": 5,
    });
  });

  it("lets a per-instance override win over the published fan-out", () => {
    const definition = bloomComponent("bloom", 1, [blurKnob]);
    const instance = instanceNode("i", "bloom", 1, { blur: 5 });
    const withOverride = { ...instance, state: { componentOverrides: { "blurB/radius": 40 } } };
    expect(effectiveInternalOverrides(definition, withOverride, { blur: 5 })).toEqual({
      "blurA/radius": 5,
      "blurB/radius": 40,
      "blurC/radius": 5,
    });
  });

  it("builds the source path a user can act on", () => {
    expect(componentSourcePath(["n1", "n2"], { n1: "DreamyFeedback_2", n2: "Blur_1" }, "shader.wgsl:42")).toBe(
      "Main / DreamyFeedback_2 / Blur_1 / shader.wgsl:42",
    );
  });
});

describe("instance helpers", () => {
  it("round-trips an internal parameter path", () => {
    expect(parseInternalParameterPath(internalParameterPath("blurA", "radius"))).toEqual({
      nodeId: "blurA",
      key: "radius",
    });
    expect(parseInternalParameterPath("nope")).toBeNull();
  });

  it("reads identity and version from the node type, never from a second copy", () => {
    const instance = instanceNode("i", "bloom", 3, { blur: 5 });
    // definitionVersion disagreeing must not change the answer: the type is the key the
    // registry is looked up by, so it is the version that is actually in effect.
    const state = readComponentInstance({ ...instance, definitionVersion: 1 });
    expect(state).toEqual({ componentId: "bloom", version: 3, parameters: { blur: 5 } });
  });

  it("finds instances in sorted order and ignores ordinary nodes", () => {
    const graph = graphOf([
      node("z", "test.blur"),
      instanceNode("b", "bloom", 1),
      instanceNode("a", "bloom", 1),
    ]);
    expect(componentInstances(graph).map((each) => each.nodeId)).toEqual(["a", "b"]);
  });
});

describe("upgrade planning (§V84, §V10)", () => {
  it("reports a version step nobody wrote a migration for", () => {
    const target = { ...bloomComponent("bloom", 3), migrations: [{ fromVersion: 2, toVersion: 3, description: "x" }] };
    const chain = migrationChain(target, 1, 3);
    expect(chain.steps).toHaveLength(1);
    expect(chain.gaps).toEqual([{ from: 1, to: 2 }]);
  });

  it("resets a value the re-authored control can no longer hold, and says so", () => {
    const to = bloomComponent("bloom", 2, [
      {
        key: "blur",
        definition: { type: "number", label: "Blur", default: 4, min: 0, max: 8 },
        targets: [{ nodeId: "blurA", key: "radius" }],
      },
    ]);
    const plan = planComponentUpgrade({
      instance: instanceNode("i", "bloom", 1, { blur: 40 }),
      from: bloomComponent("bloom", 1, [blurKnob]),
      to,
    });
    expect(plan.parameters).toEqual({ blur: 4 });
    expect(plan.reset).toEqual(["blur"]);
    expect(plan.diagnostics.map((d) => d.code)).toContain("component.upgrade.valueReset");
  });

  it("reports ports that disappear, because their edges go with them", () => {
    const plan = planComponentUpgrade({
      instance: instanceNode("i", "bloom", 1, { blur: 4 }),
      from: bloomComponent("bloom", 1, [blurKnob]),
      to: { ...bloomComponent("bloom", 2, [blurKnob]), inputs: [] },
    });
    expect(plan.removedInputs).toEqual(["source"]);
    expect(plan.diagnostics.map((d) => d.code)).toContain("component.upgrade.removedPorts");
  });
});

/**
 * T1008/§T1019(b) — A COMPOUND COMPONENT IS A LEGAL PUBLISH TARGET. §V113 makes
 * `color.g` a real per-channel slot in the store, and the inspector writes such keys
 * daily — but `internalParameterOf` looked targets up as `schema[key]`, so a published
 * parameter aimed at a component was reported missing and PRUNED as broken. That gap is
 * why Chorus shipped one Grid vec2 where the owner asked for Rows and Columns as
 * separate knobs. The same resolution the command door uses (T1008's shared helper)
 * now answers here, and a genuinely wrong component still fails.
 */
describe("publishing a compound component (T1008/§T1019b)", () => {
  const withComponentTarget = (key: string) => ({
    ...bloomComponent("grade", 1),
    graph: graphOf([node("srcA", "test.solid", { color: [0, 0, 0, 1] }, { position: { x: 0, y: 0 } })]),
    inputs: [],
    outputs: [],
    parameters: [
      {
        key: "green",
        definition: { type: "number" as const, label: "Green", default: 0, min: 0, max: 1 },
        targets: [{ nodeId: "srcA", key }],
      },
    ],
  });

  it("validates and survives pruning — the knob the owner asked for is publishable", () => {
    const definition = withComponentTarget("color.g");
    const codes = validateComponentDefinition(definition, nodes).map((d) => d.code);
    expect(codes).not.toContain("component.parameter.missingTarget");
    // And the prune keeps it: the pre-fix behaviour silently UNPUBLISHED the knob.
    const pruned = pruneComponentDefinition(definition, nodes, noNested);
    expect(pruned.parameters.map((p) => p.key)).toEqual(["green"]);
  });

  it("still reports a component the compound does not have", () => {
    const codes = validateComponentDefinition(withComponentTarget("color.q"), nodes).map((d) => d.code);
    expect(codes).toContain("component.parameter.missingTarget");
  });
});

/**
 * T1184 — THE THIRD SURFACE. The owner named `customWgsl`, point kernels AND components,
 * and the component half turns out to need no code of its own: a published parameter is a
 * COPY of the internal definition (`component-page.tsx` says so, and §V80 says re-authoring
 * it is the normal case), and `internalParameterOf` resolves that definition through
 * `effectiveParameterSchema` — the reflected schema, not the static one (§T903).
 *
 * So the claim worth gating is not "components have defaults" but that the reflected
 * DEFAULT survives the trip: publish `octaves` off a shader that declares `@default 6`, and
 * the component's own parameter page — and every fresh instance of it — starts at 6 rather
 * than at the 0 the type would have invented. Without T1184 this test is the same test and
 * the number is 0, which is exactly the defect one level up.
 */
describe("T1184 — publishing a reflected knob carries the shader's declared default", () => {
  const SHADER = `struct Params {
  octaves: f32,  // @default 6  how many times the fold refines
};
@group(0) @binding(3) var<uniform> params: Params;
@fragment fn fs() -> @location(0) vec4f { return vec4f(params.octaves); }`;

  const registry = createNodeRegistry([customWgslNode]).view();
  const graph = graphOf([
    node("shader1", "customWgsl", { source: SHADER, octaves: 4 }, { position: { x: 0, y: 0 } }),
  ]);

  it("resolves the internal definition with the DECLARED default, not the type's zero", () => {
    const internal = internalParameterOf(graph, { nodeId: "shader1", key: "octaves" }, registry);
    expect(internal).toMatchObject({ type: "number", default: 6 });
  });

  it("gives a fresh instance of the component that same default", () => {
    const internal = internalParameterOf(graph, { nodeId: "shader1", key: "octaves" }, registry);
    if (internal === undefined) throw new Error("the reflected knob must resolve to publish at all");
    const definition = {
      ...bloomComponent("alembic", 1),
      graph,
      inputs: [],
      outputs: [],
      // The publish button hands the internal definition through verbatim; this is that copy.
      parameters: [{ key: "octaves", definition: internal, targets: [{ nodeId: "shader1", key: "octaves" }] }],
    };
    // The SHADER's 6, never the document's 4 — reset is a claim about the type, and a
    // component's published default is the type-level claim its users will reset to.
    expect(defaultPublishedValues(definition)).toEqual({ octaves: 6 });
    expect(validateComponentDefinition(definition, registry).map((d) => d.code)).not.toContain(
      "component.parameter.missingTarget",
    );
  });
});
