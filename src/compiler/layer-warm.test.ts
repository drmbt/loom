import { describe, expect, it } from "vitest";

import { createComponentSystem } from "../domain/components/index.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { setListDocument } from "../examples/documents/set-list.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { compileGraph } from "./compile.ts";
import { flattenComponents } from "./flatten.ts";
import { MAX_WARM_LAYERS, compileLayerWarmPlan, layerWarmRequest } from "./layer-warm.ts";
import type { CompiledGraph, CompileRequest } from "./types.ts";

/**
 * §T1507b — the warm plan is what the backend builds a bypassed Layer's passes AHEAD from,
 * and the switch-on compile adopts what was built by PASS ID AND WGSL BYTES. So the
 * property that matters is not "some plan with layers on" but: every pass a real
 * switch-on compiles has its id and bytes in the warm plan. A warm plan that differed
 * (another sink set, a stale flattening, a non-layer node switched on) would build
 * passes nothing ever adopts, and the switch would build its own again.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

function setList(bypassed: readonly string[]): GraphDocument {
  const graph = structuredClone(setListDocument.graph) as GraphDocument;
  for (const nodeId of bypassed) {
    const node = graph.nodes[nodeId]!;
    node.ui = { ...node.ui, bypassed: true };
  }
  return graph;
}

function request(graph: GraphDocument): CompileRequest {
  // The output node only: a bypassed layer's look is then pruned, which is the case with
  // the most to build ahead.
  return { graph, settings: setListDocument.settings, registry, capabilities: TIER_B_CAPABILITIES, sinks: [] };
}

function compiled(graph: GraphDocument): CompiledGraph {
  const plan = compileGraph(request(graph));
  expect(plan.ok).toBe(true);
  return plan;
}

/** `id → bytes` of every effect pass: the key the backend adopts on. */
function effectKeys(plan: CompiledGraph): Map<string, string> {
  return new Map(plan.passes.flatMap((pass) => (pass.kind === "effect" ? [[pass.id, String(pass.shader)] as const] : [])));
}

describe("§T1507b — layerWarmRequest / compileLayerWarmPlan", () => {
  it("E82: every pass a single layer's switch-on compiles is in the warm plan, with the same bytes", () => {
    const off = setList(["layerGrid", "layerFx"]);
    const warm = compileLayerWarmPlan(request(off));
    expect(warm).not.toBeNull();
    const warmKeys = effectKeys(warm!);
    const offKeys = effectKeys(compiled(off));
    for (const switchedOn of [["layerFx"], ["layerGrid"], ["layerGrid", "layerFx"]]) {
      const stillOff = ["layerGrid", "layerFx"].filter((nodeId) => !switchedOn.includes(nodeId));
      const after = effectKeys(compiled(setList(stillOff)));
      const brought = [...after].filter(([id]) => !offKeys.has(id));
      expect(brought.length).toBeGreaterThan(0);
      for (const [id, bytes] of brought) expect(warmKeys.get(id), id).toBe(bytes);
    }
    // And with both on it IS the plan the shipped document compiles to.
    expect(warmKeys).toEqual(effectKeys(compiled(setList([]))));
  });

  it("switches on bypassed Layers only — a bypassed filter stays bypassed", () => {
    const warm = layerWarmRequest(request(setList(["layerGrid", "layerFx", "dim"])));
    expect(warm).not.toBeNull();
    const nodes = warm!.graph.nodes;
    expect([nodes["layerGrid"]!.ui?.bypassed, nodes["layerFx"]!.ui?.bypassed, nodes["dim"]!.ui?.bypassed]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("is null when no Layer is bypassed: there is nothing to build ahead", () => {
    expect(layerWarmRequest(request(setList([])))).toBeNull();
    expect(compileLayerWarmPlan(request(setList(["dim"])))).toBeNull();
  });

  it(`is bounded: at most ${MAX_WARM_LAYERS} layers, the first by node id`, () => {
    const graph = setList([]);
    const template = graph.nodes["layerGrid"]!;
    const ids = Array.from({ length: MAX_WARM_LAYERS + 3 }, (_, index) => `extra${String(index).padStart(2, "0")}`);
    for (const id of ids) graph.nodes[id] = { ...template, id, ui: { ...template.ui, bypassed: true } };
    const warm = layerWarmRequest(request(graph))!;
    const on = ids.filter((id) => warm.graph.nodes[id]!.ui?.bypassed === false);
    expect(on).toEqual(ids.slice(0, MAX_WARM_LAYERS));
  });

  it("edits the flattening the request carries, which wins over its graph", () => {
    const off = setList(["layerGrid", "layerFx"]);
    const system = createComponentSystem(registry);
    const flattened = flattenComponents({ graph: off, registry: system.nodes, components: system.components.view() });
    const withFlattening: CompileRequest = { ...request(off), registry: system.nodes, components: system.components.view(), flattened };
    const warm = layerWarmRequest(withFlattening)!;
    expect(warm.flattened!.graph.nodes["layerFx"]!.ui?.bypassed).toBe(false);
    const plan = compileLayerWarmPlan(withFlattening)!;
    expect(plan.passes.some((pass) => pass.id.startsWith("layerFx#"))).toBe(true);
    // The caller's flattening is not touched: it is the CPU layer's, for the document as it is.
    expect(flattened.graph.nodes["layerFx"]!.ui?.bypassed).toBe(true);
  });
});
