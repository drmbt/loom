import { describe, expect, it } from "vitest";

import { compileGraphRetaining, flattenComponents, prepareFrameCompiler } from "@compiler/index.ts";
import { testCapabilities, testSettings } from "@compiler/test-support.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { componentNodeType, createComponentSystem } from "@domain/components/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { expressionSlot } from "@/examples/documents/builders.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

/**
 * VN36 — `op('<instance>').par.<key>`: a DISSOLVED instance's published page, read per frame.
 *
 * Flattening deletes the instance node, so the compiler's reader (over the flat graph) found
 * nothing called `rig1`. The flattening now hands its pages over (`instancePages`) and the
 * reader resolves the page key through its own slot, at the frame — the read `parent()`
 * becomes. Real flattener, real value graph, real compiler; the GPU half is
 * `parent-expressions.gpu.test.ts`.
 */

const frameAt = (timeSeconds: number): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed: 1,
});

const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(label === undefined ? {} : { label }) }) as never;

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

/** A component whose page publishes `gain` (no targets: it exists to be read) and `tint`. */
const RIG: GraphComponentDefinition = {
  componentId: "rig",
  version: 1,
  name: "Rig",
  graph: { revision: 1, groups: {}, nodes: { hold: node("hold", "valueExpression", { expressions: "x = 1" }, "value_hold") }, edges: {} },
  inputs: [],
  outputs: [],
  parameters: [
    { key: "gain", definition: { type: "number", label: "Gain", default: 0.3 }, targets: [] },
    { key: "tint", definition: { type: "color", label: "Tint", space: "linear", default: [0.1, 0.2, 0.3, 1] }, targets: [] },
  ],
};

function document(gain: StoredParameter, amount: StoredParameter): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      inst: node("inst", componentNodeType("rig", 1), { gain }, "rig1"),
      solid: node("solid", "solid", { color: [1, 1, 1, 1] }),
      fx: node("fx", "customWgsl", { amount }, "fx1"),
      out: node("out", "output", {}),
    },
    edges: { e0: edge("e0", ["solid", "out"], ["fx", "input"]), e1: edge("e1", ["fx", "out"], ["out", "input"]) },
  };
}

function request(gain: StoredParameter, amount: StoredParameter) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  system.components.register(RIG);
  const graph = document(gain, amount);
  const components = system.components.view();
  const flattened = flattenComponents({ graph, registry: system.nodes, components });
  expect(Object.keys(flattened.graph.nodes)).not.toContain("inst");
  return { system, graph, components, flattened };
}

/** What `customWgsl.compile` was handed for `amount` at `time`, and what the compile said about it. */
function compiledAt(gain: StoredParameter, amount: StoredParameter, time: number) {
  const { system, graph, components, flattened } = request(gain, amount);
  const frame = frameAt(time);
  const evaluated = createValueGraphSession(system.nodes).evaluate(flattened.graph, frame, { flattening: flattened });
  const result = compileGraphRetaining({
    graph,
    settings: testSettings(),
    registry: system.nodes,
    capabilities: testCapabilities(),
    components,
    flattened,
    resolution: { frame, channels: evaluated.resolver },
  });
  return {
    amount: result.retained?.nodes.get("fx")?.context.parameters["amount"],
    said: result.compiled.diagnostics.filter((entry) => entry.nodeId === "fx" && entry.code.startsWith("parameter.")),
  };
}

describe("VN36 — the compiler reads op('<instance>').par.<key>", () => {
  it("evaluates a published page expression containing a component path", () => {
    const gain = expressionSlot("op('rig1/value_hold').chan.x * 0.5", 0.3);
    expect(compiledAt(gain, expressionSlot("op('rig1').par.gain * 2", 0.25), 1).amount).toBe(1);
  });

  it("reads a nested instance's page through its authored path", () => {
    const outer: GraphComponentDefinition = {
      componentId: "outer", version: 1, name: "Outer", inputs: [], outputs: [], parameters: [],
      graph: { revision: 1, groups: {}, edges: {}, nodes: {
        inner: node("inner", componentNodeType("rig", 1), { gain: 0.75 }, "rig_inner"),
      } },
    };
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), [RIG, outer]);
    const graph = document(0.3, expressionSlot("op('outer1/rig_inner').par.gain", 0.25));
    graph.nodes.inst = node("inst", componentNodeType("outer", 1), {}, "outer1");
    const flattened = flattenComponents({ graph, registry: system.nodes, components: system.components.view() });
    const result = compileGraphRetaining({ graph, registry: system.nodes, components: system.components.view(), flattened,
      settings: testSettings(), capabilities: testCapabilities() });
    expect(result.retained?.nodes.get("fx")?.context.parameters.amount).toBe(0.75);
  });

  it("reads the instance's page value, and follows it when the page changes", () => {
    const read = expressionSlot("op('rig1').par.gain", 0.25);
    expect(compiledAt(0.6, read, 1)).toEqual({ amount: 0.6, said: [] });
    // Cut the question the other way: another page value, another number.
    expect(compiledAt(0.9, read, 1).amount).toBe(0.9);
  });

  it("evaluates an ANIMATED page knob at the frame, at its publisher", () => {
    const read = expressionSlot("op('rig1').par.gain * 2", 0.25);
    const knob = expressionSlot("time * 0.25", 0.3);
    expect(compiledAt(knob, read, 1).amount).toBe(0.5);
    expect(compiledAt(knob, read, 2).amount).toBe(1);
  });

  it("reads one component of a published compound, and refuses the compound whole by name", () => {
    expect(compiledAt(0.6, expressionSlot("op('rig1').par.tint.g", 0.25), 1).amount).toBe(0.2);
    const whole = compiledAt(0.6, expressionSlot("op('rig1').par.tint", 0.25), 1);
    expect(whole.amount).toBe(0.25);
    expect(whole.said[0]?.message).toContain("name a component");
  });

  it("refuses a key the page does not publish, listing what it does", () => {
    const missing = compiledAt(0.6, expressionSlot("op('rig1').par.gian", 0.25), 1);
    expect(missing.amount).toBe(0.25);
    expect(missing.said[0]?.message).toContain(`has no parameter "gian"`);
    expect(missing.said[0]?.suggestion).toContain(`Nearest: "gain"`);
  });

  it("the per-frame values-only compile reads the page too, and moves with it", () => {
    const read = expressionSlot("op('rig1').par.gain", 0.25);
    const knob = expressionSlot("time * 0.25", 0.3);
    const { system, graph, components, flattened } = request(knob, read);
    const base = { graph, settings: testSettings(), registry: system.nodes, capabilities: testCapabilities(), components, flattened };
    const fast = prepareFrameCompiler(base);
    expect(fast.reason).toBeNull();
    const passesAt = (time: number) => {
      const frame = frameAt(time);
      const channels = createValueGraphSession(system.nodes).evaluate(flattened.graph, frame, { flattening: flattened }).resolver;
      const spliced = fast.compileFrame({ frame, channels });
      expect(spliced).not.toBeNull();
      // The fast path's own contract: the plan the full compile makes at this frame.
      expect(spliced?.passes).toEqual(compileGraphRetaining({ ...base, resolution: { frame, channels } }).compiled.passes);
      return spliced?.passes;
    };
    expect(passesAt(1)).not.toEqual(passesAt(3));
  });
});
