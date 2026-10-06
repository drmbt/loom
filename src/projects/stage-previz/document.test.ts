import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import type { ChannelResolver } from "../../domain/parameters/resolve.ts";
import { loadProject } from "../../domain/project/index.ts";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { stageDocument } from "./document.ts";
import { AREAS, SHOT_ORDER, type AreaFacts, type StageFacts } from "./facts.ts";

/**
 * Stage previz — the session as the app loads and compiles it, from facts shaped like the
 * Blender export's (no GLB needed: compilation sizes meshes from the measured counts).
 */
const FACTS: StageFacts = {
  glbUrl: "media/stage-previz/stage.glb",
  areas: Object.fromEntries(AREAS.map((area) => [area, { select: `${area}.*`, vertices: 960, triangles: 640, topY: 9.3 } satisfies AreaFacts])) as StageFacts["areas"],
  projectors: {
    SR: { name: "SR", eye: [-8.15, 8.55, -0.15], lookAt: [-3.6, 1.4, 1], throwRatio: 1.8, aspect: 1.7778 },
    SL: { name: "SL", eye: [8.15, 8.55, -0.15], lookAt: [3.6, 1.4, 1], throwRatio: 1.8, aspect: 1.7778 },
    DS: { name: "DS", eye: [0, 6.98, 19.75], lookAt: [0, 6.15, -4.35], throwRatio: 1.9447, aspect: 1.7778 },
  },
  shots: SHOT_ORDER.map((name, index) => ({ name, eye: [index, 2, 15], lookAt: [0, 4, 0], fov: 40 + index })),
  deckTop: 1.4,
};

function compiled(values: Readonly<Record<string, number>> = {}) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  const loaded = loadProject(serializeProjectDocument(stageDocument(FACTS)), { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`did not load: ${loaded.reason}`);
  const channels: ChannelResolver = (name, context) => (context.definition.type === "number" ? (values[name] ?? 0.5) : undefined);
  const plan = compileGraph({
    graph: loaded.document.graph,
    settings: loaded.document.settings,
    registry: system.nodes,
    capabilities: TIER_B_CAPABILITIES,
    components: system.components.view(),
    resolution: { channels },
  });
  return { plan, graph: loaded.document.graph };
}

const into = (graph: GraphDocument, nodeId: string, portId: string) =>
  Object.values(graph.edges)
    .filter((entry) => entry.target.nodeId === nodeId && entry.target.portId === portId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((entry) => entry.source.nodeId);

describe("stage previz session", () => {
  it("loads and compiles with no errors, with every pass the haze needs", () => {
    const { plan } = compiled();
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const passNodes = new Set(plan.passes.map((pass) => ("nodeId" in pass ? pass.nodeId : undefined)));
    for (const id of ["stage", "shadowSR", "shadowSL", "shadowDS", "beamSR", "beamSL", "beamDS", "atmosphere", "flipSL"]) expect(passNodes).toContain(id);
  });

  it("flips the stage-left feed horizontally, and only that one, into both its throw and its beam", () => {
    const { graph } = compiled();
    expect(graph.nodes["flipSL"]?.parameters).toMatchObject({ flipx: true, flipy: false });
    expect(into(graph, "projSL", "cookie")).toEqual(["flipSL"]);
    expect(into(graph, "beamSL", "input")).toEqual(["flipSL"]);
    expect(into(graph, "flipSL", "input")).toEqual(["feedSL"]);
    expect(into(graph, "projSR", "cookie")).toEqual(["feedSR"]);
    expect(into(graph, "projDS", "cookie")).toEqual(["feedDS"]);
  });

  it("puts Syphon on input 0 of every feed switch, the test content on 1 and the grid on 2, all on one Source control", () => {
    const { graph } = compiled();
    expect(into(graph, "feedSR", "inputs")).toEqual(["syphonSR", "testBeams", "testGrid"]);
    expect(into(graph, "feedSL", "inputs")).toEqual(["syphonSL", "testBeams", "testGrid"]);
    expect(into(graph, "feedDS", "inputs")).toEqual(["syphonDS", "testVideo", "testGrid"]);
    for (const feed of ["feedSR", "feedSL", "feedDS"]) {
      expect(graph.nodes[feed]?.parameters["index"]).toMatchObject({ mode: "expression", bindings: { expression: { source: "op('source').chan.source" } } });
    }
  });

  it("chains the beams so the composite sees all three, each beam reading the camera depth and its own projector's depth", () => {
    const { graph } = compiled();
    expect(into(graph, "beamSR", "more")).toEqual(["stage", "shadowSR"]);
    expect(into(graph, "beamSL", "more")).toEqual(["stage", "shadowSL", "beamSR"]);
    expect(into(graph, "beamDS", "more")).toEqual(["stage", "shadowDS", "beamSL"]);
    expect(into(graph, "atmosphere", "more")).toEqual(["stage", "beamDS"]);
  });

  it("compiles at every Source and Shot position", () => {
    for (const source of [0, 1, 2]) {
      for (const shot of [0, 1, 2, 3, 4]) {
        const { plan } = compiled({ source, shot });
        expect(plan.diagnostics.filter((entry) => entry.severity === "error"), `source ${source}, shot ${shot}`).toEqual([]);
      }
    }
  });
});
