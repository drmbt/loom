import { describe, expect, it } from "vitest";

import { componentNodeType, createComponentSystem } from "../domain/components/index.ts";
import { hasAnimatedParameters } from "../domain/channels/graph-channels.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import { defaultParameters } from "../domain/parameters/validate.ts";
import { NO_MORPHS, buildMorphIndex, morphableKey } from "../domain/presets/morph-index.ts";
import { parseMorphRecords } from "../domain/presets/morph.ts";
import { presetBankNode, presetSession } from "../domain/presets/test-support.ts";
import type { MorphSpec } from "../domain/presets/bank.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { StoredParameter } from "../domain/types/parameters.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { minimalGraphFor } from "../nodes/definitions/test-support.ts";
import { createNodeRegistry, type NodeRegistryView } from "../nodes/registry/registry.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";
import { compileGraph } from "./compile.ts";
import { flattenComponents } from "./flatten.ts";
import { prepareFrameCompiler, structuralParameterKeys } from "./frame-compile.ts";
import type { CompiledGraph, CompileRequest } from "./types.ts";

/**
 * T1497b (§T1398b S2) — A PRESET MORPH REACHES THE PLAN, and only as VALUES.
 *
 * The recall is the real one (`presetSession`), so the documents here carry the record
 * the command actually writes. What is asserted is the number in the pass's UNIFORM block
 * — the thing the GPU reads — at a frame, against the analytic value of the fade, and
 * three properties around it:
 *
 *  - the values-only frame compile (what the live loop runs) hands back exactly what the
 *    full compile at that frame does, so the fast path cannot show a different fade;
 *  - a morph never turns the fast path OFF: a structural key in a recall cuts at the
 *    start instead of animating (the design doc §5.3), which is held against the
 *    compiler's own `structuralParameterKeys` for every registered node type;
 *  - a look is usually a component instance, which flattening dissolves — the fade on its
 *    published knob has to arrive on the internal parameter it drives, at any depth.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const settings: ProjectSettings = {
  outputResolution: { width: 16, height: 16 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const EPOCH = "session-1";

/** Frame `index` of a 60 fps session whose absolute clock started with it. */
const frameAt = (index: number, epoch: string | null = EPOCH): FrameEvaluationInput => ({
  timeSeconds: index / 60,
  deltaSeconds: 1 / 60,
  frameIndex: index,
  mode: "realtime",
  randomSeed: 7,
  absFrameIndex: index,
  absTimeSeconds: index / 60,
  ...(epoch === null ? {} : { absEpoch: epoch }),
});

const LINEAR_1S: MorphSpec = { seconds: 1, curve: "linear" };

const node = (id: string, type: string, parameters: Record<string, StoredParameter> = {}, label = id): GraphNode => ({
  id,
  type,
  label,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
});

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

/** white Solid → Level (brightness 0.2) → Output, and a bank that takes the Level to 0.8. */
function levelDocument(): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      src: node("src", "solid", { color: [1, 1, 1, 1] }, "solid1"),
      grade: node("grade", "level", { brightness: 0.2 }, "level1"),
      out: node("out", "output", {}, "out1"),
      bank: presetBankNode("bank", "looks", "level1", [{ name: "bright", values: { level1: { brightness: 0.8 } } }]),
    },
    edges: {
      e0: edge("e0", ["src", "out"], ["grade", "input"]),
      e1: edge("e1", ["grade", "out"], ["out", "input"]),
    },
  };
}

function requestFor(graph: GraphDocument, extra: Partial<CompileRequest> = {}): CompileRequest {
  return { graph, settings, registry, capabilities: TIER_B_CAPABILITIES, ...extra };
}

/** The uniform a node's pass carries — the value the GPU reads. */
function uniformOf(plan: CompiledGraph, nodeId: string, key: string): unknown {
  const pass = plan.passes.find((each) => "nodeId" in each && each.nodeId === nodeId && "uniforms" in each);
  if (pass === undefined || !("uniforms" in pass)) throw new Error(`no uniform pass for ${nodeId}`);
  return pass.uniforms?.[key];
}

/** The document after the real recall, stamped at absolute time 0 of `EPOCH`. */
async function recalled(graph: GraphDocument, view: NodeRegistryView = registry, morph: MorphSpec = LINEAR_1S): Promise<GraphDocument> {
  const session = presetSession(graph, view);
  session.at({ epoch: EPOCH, absTimeSeconds: 0 });
  await session.recall("bank", "bright", morph);
  return session.graph();
}

describe("T1497b: the plan's uniforms carry the fade, frame by frame", () => {
  it("a 1 s linear morph of Level brightness 0.2 → 0.8 is 0.5 at frame 30 of 60 fps", async () => {
    const graph = await recalled(levelDocument());
    // The structural compile has no frame: it is the destination, as the document is.
    expect(uniformOf(compileGraph(requestFor(graph)), "grade", "brightness")).toBe(0.8);

    const at = (index: number, epoch: string | null = EPOCH): unknown =>
      uniformOf(compileGraph(requestFor(graph, { resolution: { frame: frameAt(index, epoch) } })), "grade", "brightness");
    expect(at(0)).toBe(0.2);
    expect(at(15)).toBe(0.2 * 0.75 + 0.8 * 0.25);
    expect(at(30)).toBe(0.5);
    expect(at(60)).toBe(0.8);
    expect(at(600)).toBe(0.8);
    // Another epoch — a render's, another session's — and no epoch at all: the destination.
    expect(at(30, "take-1")).toBe(0.8);
    expect(at(30, null)).toBe(0.8);
  });

  it("cut the wire: the same frame without the index is the destination", async () => {
    const graph = await recalled(levelDocument());
    const frame = frameAt(30);
    expect(uniformOf(compileGraph(requestFor(graph, { resolution: { frame, morphs: NO_MORPHS } })), "grade", "brightness")).toBe(0.8);
    expect(uniformOf(compileGraph(requestFor(graph, { resolution: { frame } })), "grade", "brightness")).toBe(0.5);
  });

  it("the values-only frame compile hands back exactly the full compile, and stays values-only", async () => {
    const graph = await recalled(levelDocument());
    // No slot mode animates here; the record alone is what makes this document move.
    expect(hasAnimatedParameters(graph)).toBe(true);
    const request = requestFor(graph);
    const prepared = prepareFrameCompiler(request);
    expect(prepared.uniformOnly).toBe(true);

    for (const index of [0, 1, 15, 30, 59, 60, 61, 240]) {
      const frame = frameAt(index);
      const spliced = prepared.compileFrame({ frame });
      expect(spliced, `frame ${String(index)}: ${String(prepared.reason)}`).not.toBeNull();
      const full = compileGraph({ ...request, resolution: { frame } });
      expect(spliced?.passes).toEqual(full.passes);
      expect(spliced?.signature).toBe(prepared.base.signature);
    }
    expect(prepared.reason).toBeNull();
    expect(uniformOf(prepared.compileFrame({ frame: frameAt(30) }) as CompiledGraph, "grade", "brightness")).toBe(0.5);
  });

  it("a document with no record is not asked for frames at all", () => {
    expect(hasAnimatedParameters(levelDocument())).toBe(false);
    expect(buildMorphIndex({ document: levelDocument(), registry })).toBe(NO_MORPHS);
  });
});

describe("T1497b: a structural key in a recall CUTS — it never animates (§5.3, §V5)", () => {
  it("no key the compiler treats as structure is morphable, for every registered node type", () => {
    const structural: string[] = [];
    for (const definition of allNodeDefinitions) {
      const stored = defaultParameters(effectiveParameterSchema(definition, {}));
      const subject: GraphNode = node("subject", definition.type, stored);
      for (const key of structuralParameterKeys(definition, stored)) {
        structural.push(`${definition.type}.${key}`);
        expect(morphableKey(definition, subject, key), `${definition.type}.${key} is structural and must cut`).toBe(false);
      }
    }
    // Not vacuous, and it covers BOTH roads to "structural": a `compileTime` number, and a
    // resolution-policy input that is not `compileTime` (Window Out's size).
    expect(structural).toContain("cache.frames");
    expect(structural).toContain("window.width");
    const windowOut = allNodeDefinitions.find((definition) => definition.type === "window") as NodeDefinition;
    expect(effectiveParameterSchema(windowOut, {})["width"]?.compileTime).not.toBe(true);
    // The legitimate case the rule must not swallow: an ordinary number fades.
    const level = allNodeDefinitions.find((definition) => definition.type === "level") as NodeDefinition;
    expect(morphableKey(level, node("subject", "level"), "brightness")).toBe(true);
  });

  it("a Cache's frame depth recalled with a morph is 8 at once, and the document stays on the values-only path", async () => {
    const cache = allNodeDefinitions.find((definition) => definition.type === "cache") as NodeDefinition;
    const base = minimalGraphFor(cache, registry) as unknown as GraphDocument;
    const subject = base.nodes["subject"] as GraphNode;
    const graph = await recalled({
      ...base,
      nodes: {
        ...base.nodes,
        subject: { ...subject, label: "cache1", parameters: { ...subject.parameters, frames: 4 } },
        bank: presetBankNode("bank", "looks", "cache1", [{ name: "bright", values: { cache1: { frames: 8 } } }]),
      },
    });
    // The record is there — the recall did change the key …
    expect(parseMorphRecords(graph.nodes["bank"]?.parameters["morphs"])[0]?.to).toEqual({ cache1: { frames: 8 } });
    // … and nothing about it is offered to the frame path.
    expect(buildMorphIndex({ document: graph, registry }).keysOf("subject")).toBeUndefined();

    const ringFrames = (plan: CompiledGraph): number[] =>
      plan.resources.flatMap((resource) => (resource.kind === "ring" ? [resource.frames] : []));
    const structural = compileGraph(requestFor(graph));
    for (const index of [0, 1, 30, 59]) {
      const plan = compileGraph(requestFor(graph, { resolution: { frame: frameAt(index) } }));
      expect(ringFrames(plan)).toEqual([8]);
      expect(plan.signature).toBe(structural.signature);
    }
    const prepared = prepareFrameCompiler(requestFor(graph));
    expect(prepared.uniformOnly).toBe(true);
    expect(prepared.reason).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------ */
/* Inside a component: the published knob's fade reaches the internal parameter           */
/* ------------------------------------------------------------------------------------ */

/** A look: white Solid → Level, with the Level's brightness published. */
function lookComponent(): GraphComponentDefinition {
  return {
    componentId: "look",
    version: 1,
    name: "Look",
    graph: {
      revision: 1,
      groups: {},
      nodes: {
        src: node("src", "solid", { color: [1, 1, 1, 1] }),
        grade: node("grade", "level", { brightness: 1 }),
      },
      edges: { e0: edge("e0", ["src", "out"], ["grade", "input"]) },
    },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
    parameters: [
      {
        key: "brightness",
        definition: { type: "number", label: "Brightness", default: 1, min: 0, max: 8, range: "floor" },
        targets: [{ nodeId: "grade", key: "brightness" }],
      },
    ],
  } as unknown as GraphComponentDefinition;
}

/** A component that holds a `look` and republishes its knob under another name. */
function wrapComponent(): GraphComponentDefinition {
  return {
    componentId: "wrap",
    version: 1,
    name: "Wrap",
    graph: {
      revision: 1,
      groups: {},
      nodes: { inner: node("inner", componentNodeType("look", 1), { brightness: 1 }) },
      edges: {},
    },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
    parameters: [
      {
        key: "amount",
        definition: { type: "number", label: "Amount", default: 1, min: 0, max: 8, range: "floor" },
        targets: [{ nodeId: "inner", key: "brightness" }],
      },
    ],
  } as unknown as GraphComponentDefinition;
}

function instanceDocument(componentId: string, key: string): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      city: node("city", componentNodeType(componentId, 1), { [key]: 0.2 }),
      out: node("out", "output", {}, "out1"),
      bank: presetBankNode("bank", "looks", "city", [{ name: "bright", values: { city: { [key]: 0.8 } } }]),
    },
    edges: { e1: edge("e1", ["city", "out"], ["out", "input"]) },
  };
}

describe("T1497b: a morph on a look's PUBLISHED knob fades the internal parameter it drives", () => {
  it("one level in: the instance is dissolved, and its Level's uniform is 0.5 at frame 30", async () => {
    const system = createComponentSystem(registry, [lookComponent()]);
    const components = system.components.view();
    const graph = await recalled(instanceDocument("look", "brightness"), system.nodes);
    expect(graph.nodes["city"]?.parameters["brightness"]).toBe(0.8);

    const flattened = flattenComponents({ graph, registry: system.nodes, components });
    // Nothing called `city` is left to resolve; the record has to find `city/grade`.
    expect(flattened.graph.nodes["city"]).toBeUndefined();
    expect(flattened.publishedOrigins.get("city/grade")).toEqual({ brightness: { nodeId: "city", key: "brightness" } });
    expect([...(flattened.morphs.keysOf("city/grade") ?? [])]).toEqual(["brightness"]);

    const request: CompileRequest = { graph, settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components, flattened };
    expect(uniformOf(compileGraph(request), "city/grade", "brightness")).toBe(0.8);
    const at = (index: number): unknown =>
      uniformOf(compileGraph({ ...request, resolution: { frame: frameAt(index) } }), "city/grade", "brightness");
    expect(at(0)).toBe(0.2);
    expect(at(30)).toBe(0.5);
    expect(at(60)).toBe(0.8);

    // And through the values-only path the live loop runs, on the flat graph it runs it on.
    expect(hasAnimatedParameters(flattened.graph)).toBe(true);
    const prepared = prepareFrameCompiler(request);
    expect(prepared.uniformOnly).toBe(true);
    expect(uniformOf(prepared.compileFrame({ frame: frameAt(30) }) as CompiledGraph, "city/grade", "brightness")).toBe(0.5);
  });

  it("two levels in: a knob republished by an outer component still carries the fade", async () => {
    const system = createComponentSystem(registry, [lookComponent(), wrapComponent()]);
    const components = system.components.view();
    const graph = await recalled(instanceDocument("wrap", "amount"), system.nodes);
    const flattened = flattenComponents({ graph, registry: system.nodes, components });
    expect(flattened.publishedOrigins.get("city/inner/grade")).toEqual({ brightness: { nodeId: "city", key: "amount" } });

    const request: CompileRequest = { graph, settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components, flattened };
    expect(uniformOf(compileGraph({ ...request, resolution: { frame: frameAt(30) } }), "city/inner/grade", "brightness")).toBe(0.5);
    expect(uniformOf(compileGraph({ ...request, resolution: { frame: frameAt(60) } }), "city/inner/grade", "brightness")).toBe(0.8);
  });

  it("a document with no component flattens to an index over its own nodes", async () => {
    const graph = await recalled(levelDocument());
    const system = createComponentSystem(registry, []);
    const flattened = flattenComponents({ graph, registry: system.nodes, components: system.components.view() });
    expect(flattened.changed).toBe(false);
    expect([...(flattened.morphs.keysOf("grade") ?? [])]).toEqual(["brightness"]);
    expect(flattened.morphs.activeAt(frameAt(30))).toBe(true);
    expect(flattened.morphs.activeAt(frameAt(60))).toBe(false);
    expect(flattened.morphs.activeAt(frameAt(30, "take-1"))).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------ */
/* T1524b: the three ways into a component that used to CUT                               */
/* ------------------------------------------------------------------------------------ */

const bindTo = (ref: string, retained: number): StoredParameter =>
  ({ mode: "bind", bindings: { bind: { kind: "bind", ref }, static: { kind: "static", value: retained } } }) as StoredParameter;

const gainKnob = {
  key: "gain",
  definition: { type: "number", label: "Gain", default: 1, min: 0, max: 8, range: "floor" },
  // No targets: this knob exists only to be read as `parent.gain` (§V81).
  targets: [],
};

/** A look whose Level READS the knob — `parent.gain` as a bind slot, or as the legacy state binding. */
function boundComponent(how: "slot" | "state"): GraphComponentDefinition {
  const grade: GraphNode =
    how === "slot"
      ? node("grade", "level", { brightness: bindTo("parent.gain", 1) })
      : { ...node("grade", "level", { brightness: 1 }), state: { parentBindings: { brightness: "parent.gain" } } };
  return {
    componentId: "bound",
    version: 1,
    name: "Bound",
    graph: {
      revision: 1,
      groups: {},
      nodes: { src: node("src", "solid", { color: [1, 1, 1, 1] }), grade },
      edges: { e0: edge("e0", ["src", "out"], ["grade", "input"]) },
    },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
    parameters: [gainKnob],
  } as unknown as GraphComponentDefinition;
}

/** A component holding a `bound` whose knob is itself bound one level up: `parent.amount`. */
function outerBoundComponent(): GraphComponentDefinition {
  return {
    componentId: "outer",
    version: 1,
    name: "Outer",
    graph: {
      revision: 1,
      groups: {},
      nodes: { inner: node("inner", componentNodeType("bound", 1), { gain: bindTo("parent.amount", 1) }) },
      edges: {},
    },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
    parameters: [{ key: "amount", definition: gainKnob.definition, targets: [] }],
  } as unknown as GraphComponentDefinition;
}

/** A disc: a Circle whose centre is published as `at`, a vector the instance may set per channel. */
function discComponent(): GraphComponentDefinition {
  return {
    componentId: "disc",
    version: 1,
    name: "Disc",
    graph: { revision: 1, groups: {}, nodes: { dot: node("dot", "circle", { center: [0.5, 0.5] }) }, edges: {} },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "dot", portId: "out" }],
    parameters: [
      {
        key: "at",
        definition: { type: "vector", size: 2, label: "At", default: [0.5, 0.5], min: -2, max: 3, range: "soft" },
        targets: [{ nodeId: "dot", key: "center" }],
      },
    ],
  } as unknown as GraphComponentDefinition;
}

/** `city` is an instance holding `before`; the bank's one preset writes `after` onto it. */
function cityDocument(componentId: string, before: Record<string, StoredParameter>, after: Record<string, StoredParameter>): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      city: node("city", componentNodeType(componentId, 1), before),
      out: node("out", "output", {}, "out1"),
      bank: presetBankNode("bank", "looks", "city", [{ name: "bright", values: { city: after } }]),
    },
    edges: { e1: edge("e1", ["city", "out"], ["out", "input"]) },
  };
}

/** The recalled document compiled at a frame through BOTH frame paths, which must agree. */
async function fadingInstance(
  definitions: readonly GraphComponentDefinition[],
  document: GraphDocument,
): Promise<{ graph: GraphDocument; flattened: ReturnType<typeof flattenComponents>; at: (index: number, nodeId: string, key: string) => unknown; settled: (nodeId: string, key: string) => unknown }> {
  const system = createComponentSystem(registry, [...definitions]);
  const components = system.components.view();
  const graph = await recalled(document, system.nodes);
  const flattened = flattenComponents({ graph, registry: system.nodes, components });
  const request: CompileRequest = { graph, settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components, flattened };
  const prepared = prepareFrameCompiler(request);
  return {
    graph,
    flattened,
    settled: (nodeId, key) => uniformOf(compileGraph(request), nodeId, key),
    at(index, nodeId, key) {
      const frame = frameAt(index);
      const full = uniformOf(compileGraph({ ...request, resolution: { frame } }), nodeId, key);
      // The values-only path the live loop runs hands back the same number, or it is not a fade.
      const spliced = prepared.compileFrame({ frame });
      expect(spliced, String(prepared.reason)).not.toBeNull();
      expect(uniformOf(spliced as CompiledGraph, nodeId, key)).toEqual(full);
      return full;
    },
  };
}

describe("T1524b: a `parent.<key>` read of a morphing knob fades with it", () => {
  it.each(["slot", "state"] as const)("the Level bound to parent.gain (%s) is 0.5 at frame 30 and 0.8 after", async (how) => {
    const run = await fadingInstance([boundComponent(how)], cityDocument("bound", { gain: 0.2 }, { gain: 0.8 }));
    // Flattening wrote the VALUE the scope resolved to, and now says where it came from.
    expect(run.flattened.graph.nodes["city/grade"]?.parameters["brightness"]).toBe(0.8);
    expect(run.flattened.publishedOrigins.get("city/grade")).toEqual({ brightness: { nodeId: "city", key: "gain", baked: true } });
    expect(run.settled("city/grade", "brightness")).toBe(0.8);
    expect(run.at(0, "city/grade", "brightness")).toBe(0.2);
    expect(run.at(30, "city/grade", "brightness")).toBe(0.5);
    expect(run.at(60, "city/grade", "brightness")).toBe(0.8);
    expect(run.at(600, "city/grade", "brightness")).toBe(0.8);
  });

  it("two levels in: a knob that is itself bound to parent.amount carries the fade down", async () => {
    const run = await fadingInstance(
      [boundComponent("slot"), outerBoundComponent()],
      cityDocument("outer", { amount: 0.2 }, { amount: 0.8 }),
    );
    expect(run.flattened.publishedOrigins.get("city/inner/grade")).toEqual({ brightness: { nodeId: "city", key: "amount", baked: true } });
    expect(run.at(30, "city/inner/grade", "brightness")).toBe(0.5);
    expect(run.at(60, "city/inner/grade", "brightness")).toBe(0.8);
  });

  it("cut the wire: a document with no bind is not given an origin, and an unrelated knob moves nothing", async () => {
    // The legitimate case the origin must not swallow: the same component, the Level NOT bound.
    const unbound = { ...boundComponent("slot"), graph: { ...boundComponent("slot").graph, nodes: { ...boundComponent("slot").graph.nodes, grade: node("grade", "level", { brightness: 1 }) } } } as GraphComponentDefinition;
    const run = await fadingInstance([unbound], cityDocument("bound", { gain: 0.2 }, { gain: 0.8 }));
    expect(run.flattened.publishedOrigins.get("city/grade")).toBeUndefined();
    expect(run.at(30, "city/grade", "brightness")).toBe(1);
  });
});

describe("T1524b: a compound published PER COMPONENT fades channel by channel", () => {
  it("a recall of `at.x` moves only that channel of the internal centre: 0.5 at frame 30", async () => {
    const run = await fadingInstance(
      [discComponent()],
      cityDocument("disc", { at: [0.1, 0.7], "at.x": 0.2 }, { "at.x": 0.8 }),
    );
    // Inside, the centre is the ASSEMBLED tuple: no `center.x` slot exists to ask about.
    expect(run.flattened.graph.nodes["city/dot"]?.parameters).toMatchObject({ center: [0.8, 0.7] });
    expect(run.flattened.graph.nodes["city/dot"]?.parameters["center.x"]).toBeUndefined();
    expect([...(run.flattened.morphs.keysOf("city/dot") ?? [])]).toEqual(["center.x"]);
    expect(run.at(0, "city/dot", "center")).toEqual([0.2, 0.7]);
    expect(run.at(30, "city/dot", "center")).toEqual([0.5, 0.7]);
    expect(run.at(60, "city/dot", "center")).toEqual([0.8, 0.7]);
  });

  it("a recall of the BARE key fades the channels it holds and leaves an overridden channel where it is", async () => {
    const run = await fadingInstance(
      [discComponent()],
      cityDocument("disc", { at: [0.2, 0.1], "at.y": 0.7 }, { at: [0.8, 0.9] }),
    );
    // y is the instance's own override before, during and after: the bare key's 0.1 → 0.9
    // never shows, and a fold that blended the bare tuples would drag y through 0.4.
    expect(run.at(0, "city/dot", "center")).toEqual([0.2, 0.7]);
    expect(run.at(30, "city/dot", "center")).toEqual([0.5, 0.7]);
    expect(run.at(60, "city/dot", "center")).toEqual([0.8, 0.7]);
  });

  it("a channel the component AUTHORS on its own node outranks the published one, and does not fade", async () => {
    const authored = {
      ...discComponent(),
      graph: { revision: 1, groups: {}, nodes: { dot: node("dot", "circle", { center: [0.5, 0.5], "center.x": 0.3 }) }, edges: {} },
    } as unknown as GraphComponentDefinition;
    const run = await fadingInstance([authored], cityDocument("disc", { at: [0.1, 0.7], "at.x": 0.2 }, { "at.x": 0.8 }));
    expect(run.flattened.morphs.keysOf("city/dot")).toBeUndefined();
    expect(run.at(30, "city/dot", "center")).toEqual([0.3, 0.7]);
  });
});

describe("T1524b: a BIND-mode end fades from, and to, the value flattening wrote for it", () => {
  /** `look` with a second published knob for the first to bind to; only `brightness` drives the Level. */
  function twoKnobLook(): GraphComponentDefinition {
    const look = lookComponent();
    return { ...look, parameters: [...look.parameters, { ...gainKnob, key: "trim" }] } as unknown as GraphComponentDefinition;
  }

  it("static → bind: the Level fades 0.2 → the sibling knob's 0.8", async () => {
    const run = await fadingInstance(
      [twoKnobLook()],
      cityDocument("look", { brightness: 0.2, trim: 0.8 }, { brightness: bindTo("trim", 0.2) }),
    );
    expect(run.settled("city/grade", "brightness")).toBe(0.8);
    expect(run.at(0, "city/grade", "brightness")).toBe(0.2);
    expect(run.at(30, "city/grade", "brightness")).toBe(0.5);
    expect(run.at(60, "city/grade", "brightness")).toBe(0.8);
  });

  it("bind → static: the fade STARTS on the value the bind showed, not on its retained static", async () => {
    const run = await fadingInstance(
      [twoKnobLook()],
      // The bind reads `trim` (0.2); its retained static is 0.9 and must never be seen.
      cityDocument("look", { brightness: bindTo("trim", 0.9), trim: 0.2 }, { brightness: 0.8 }),
    );
    expect(run.at(0, "city/grade", "brightness")).toBe(0.2);
    expect(run.at(30, "city/grade", "brightness")).toBe(0.5);
    expect(run.at(60, "city/grade", "brightness")).toBe(0.8);
  });
});
