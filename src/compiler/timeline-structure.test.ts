import { describe, expect, it } from "vitest";

import { DOCUMENT_STRUCTURE, type TimelineStructureState } from "../domain/presets/timeline-cues.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { compileGraph } from "./compile.ts";
import { flattenComponents } from "./flatten.ts";
import { timelineStructureRequest } from "./timeline-structure.ts";
import type { CompileRequest } from "./types.ts";
import { createComponentSystem } from "../domain/components/index.ts";
import { testCapabilities, testSettings } from "./test-support.ts";

/**
 * §T1537b — the compile request of one timeline segment: the overrides land on the graph that
 * COMPILES (the flat one when the request carries a flattening), nothing else moves, and the
 * document's own structure is the request itself — so a document with no structural cue
 * compiles exactly what it did.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const node = (id: string, type: string, parameters: Record<string, unknown>, ui?: Record<string, unknown>): GraphNode =>
  ({ id, type, label: id, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(ui === undefined ? {} : { ui }) }) as GraphNode;

/** blue → Layer(below), naming red; the Layer stored off. */
const stage: GraphDocument = {
  revision: 1,
  nodes: {
    blue: node("blue", "solid", { color: [0, 0, 1, 1] }),
    red: node("red", "solid", { color: [1, 0, 0, 1] }),
    green: node("green", "solid", { color: [0, 1, 0, 1] }),
    layer: node("layer", "layer", { picture: "red", opacity: 1, blend: "replace" }, { bypassed: true }),
    out: node("out", "output", {}),
  },
  edges: {
    e0: { id: "e0", source: { nodeId: "blue", portId: "out" }, target: { nodeId: "layer", portId: "below" } },
    e1: { id: "e1", source: { nodeId: "layer", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  },
  groups: {},
};

const ON_GREEN: TimelineStructureState = {
  key: "on-green",
  bypassed: new Map([["layer", false]]),
  parameters: new Map([["layer", { picture: "green" }]]),
};

const request = (flattened: boolean): CompileRequest => ({
  graph: stage,
  settings: testSettings(),
  registry,
  capabilities: testCapabilities(),
  sinks: [],
  ...(flattened ? { flattened: flattenComponents({ graph: stage, registry, components: createComponentSystem(registry, []).components.view() }) } : {}),
});

const passes = (built: CompileRequest): string[] => compileGraph(built).passes.map((pass) => pass.id.split("#")[0] as string).sort();

describe("§T1537b — timelineStructureRequest", () => {
  it("the document's own structure is the request itself, by identity", () => {
    const base = request(false);
    expect(timelineStructureRequest(base, DOCUMENT_STRUCTURE)).toBe(base);
  });

  it("without a flattening, the overrides land on the document copy; the document is untouched", () => {
    const base = request(false);
    const segment = timelineStructureRequest(base, ON_GREEN);
    expect(segment.graph.nodes["layer"]?.ui?.bypassed).toBe(false);
    expect(segment.graph.nodes["layer"]?.parameters["picture"]).toBe("green");
    expect(stage.nodes["layer"]?.ui?.bypassed).toBe(true);
    expect(segment.settings).toBe(base.settings);
    expect(segment.sinks).toBe(base.sinks);
    // What compiles: the stored layer is pruned; the segment's renders the layer over the GREEN Solid.
    expect(passes(base)).not.toContain("layer");
    expect(passes(segment)).toContain("layer");
    expect(passes(segment)).toContain("green");
    expect(passes(segment)).not.toContain("red");
  });

  it("with a flattening, the overrides land on the FLAT graph the compile reads, the morph index travelling with it", () => {
    const base = request(true);
    const segment = timelineStructureRequest(base, ON_GREEN);
    expect(segment.graph).toBe(base.graph);
    expect(segment.flattened?.graph.nodes["layer"]?.ui?.bypassed).toBe(false);
    expect(segment.flattened?.morphs).toBe(base.flattened?.morphs);
    expect(passes(segment)).toContain("green");
  });
});
