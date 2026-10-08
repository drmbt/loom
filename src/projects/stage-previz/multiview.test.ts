import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import type { ChannelResolver } from "../../domain/parameters/resolve.ts";
import { loadProject } from "../../domain/project/index.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * VN80 — stage-previz-11's quad multiview, read where its consumers read it. Each HazeView
 * instance's haze passes (its three beams and its composite) carry the eye, aim and field of
 * view their own picture is drawn through; the quad pass takes the four pictures in the order
 * its shader lays them out; and `layer_quad`, a Layer over the single view, costs nothing while
 * it is off: bypassed, its picture's chain is pruned and none of the four views cooks.
 */
const VIEWS = {
  view_tight: { eye: [0, 2.2, 17], aim: [0, 4.7, -1.5], fov: 24 },
  view_wide: { eye: [0, 3.6, 24], aim: [0, 4.9, 0.5], fov: 29 },
  view_angled: { eye: [-19, 3.8, 15.5], aim: [0, 4.6, -0.2], fov: 28 },
  view_profile: { eye: [-22, 5.0, 2.0], aim: [0, 5.0, 2.0], fov: 30 },
} as const;

const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
const loaded = loadProject(readFileSync("projects/stage-previz/stage-previz-11.loom.json", "utf8"), { nodes: system.nodes, components: system.components });
if (!loaded.ok) throw new Error(`stage-previz-11 did not load: ${loaded.reason}`);
const { document } = loaded;

/** The document compiled with the quad's Layer on (the Panel switch) unless `quad` says off. */
function compiled(values: Readonly<Record<string, number>> = {}, quad = true) {
  const channels: ChannelResolver = (name, context) => (context.definition.type === "number" ? values[name.split(":")[1] ?? name] : undefined);
  const layer = document.graph.nodes["layerQuad"]!;
  const graph = { ...document.graph, nodes: { ...document.graph.nodes, layerQuad: { ...layer, ui: { ...layer.ui, bypassed: !quad } } } };
  const plan = compileGraph({ graph, settings: document.settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components: system.components.view(), resolution: { channels } });
  if (!plan.ok) throw new Error("stage-previz-11 did not compile");
  return plan;
}
const uniformsOf = (plan: ReturnType<typeof compiled>, nodeId: string) =>
  (plan.passes.find((pass) => "nodeId" in pass && pass.nodeId === nodeId) as { uniforms?: Record<string, unknown> } | undefined)?.uniforms;

describe("stage-previz-11: the quad multiview", () => {
  const plan = compiled();

  it.each(Object.entries(VIEWS))("%s: its beams and its haze composite see through its own camera", (view, camera) => {
    for (const pass of ["beamSR", "beamSL", "beamDS", "atmosphere"]) {
      const uniforms = uniformsOf(plan, `${view}/${pass}`);
      expect(uniforms, `${view}/${pass}`).toBeDefined();
      expect(uniforms!["eye"]).toEqual(camera.eye);
      expect(uniforms!["aim"]).toEqual(camera.aim);
      expect(uniforms!["fov"]).toBe(camera.fov);
    }
  });

  it("the single view still looks through the Shot, Orbit and Zoom camera, which none of the four follows", () => {
    // every fader the view camera reads, so its expression resolves rather than falling back
    const front = compiled({ shot: 0, orbit: 0, zoom: 0 });
    const moved = compiled({ shot: 0, orbit: 90, zoom: 0 });
    expect(uniformsOf(moved, "hazeRender/atmosphere")!["eye"]).not.toEqual(uniformsOf(front, "hazeRender/atmosphere")!["eye"]);
    for (const view of Object.keys(VIEWS)) expect(uniformsOf(moved, `${view}/atmosphere`)!["eye"]).toEqual(uniformsOf(front, `${view}/atmosphere`)!["eye"]);
  });

  it("the quad takes tight, wide, angled, profile in its shader's order, as the picture of a Layer over the single view", () => {
    const into = (nodeId: string, portId: string) =>
      Object.values(document.graph.edges).filter((wire) => wire.target.nodeId === nodeId && wire.target.portId === portId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((wire) => wire.source.nodeId);
    expect(into("quad", "input")).toEqual(["view_tight"]);
    expect(into("quad", "more")).toEqual(["view_wide", "view_angled", "view_profile"]);
    expect(into("layerQuad", "below")).toEqual(["hazeRender"]);
    expect(into("layerQuad", "picture")).toEqual(["quad"]);
    expect(into("out", "input")).toEqual(["layerQuad"]);
  });

  it("opens with the quad off, and off it cooks none of the four views: the plan is the single view's alone", () => {
    expect(document.graph.nodes["layerQuad"]!.ui?.bypassed).toBe(true);
    const cooking = (plan: ReturnType<typeof compiled>) =>
      new Set(plan.passes.map((pass) => ("nodeId" in pass ? String(pass.nodeId) : "")).filter((id) => id.startsWith("view_") || id === "quad").map((id) => id.split("/")[0]));
    expect([...cooking(compiled({}, false))]).toEqual([]);
    expect([...cooking(compiled({}, true))].sort()).toEqual(["quad", "view_angled", "view_profile", "view_tight", "view_wide"]);
    // and what it does cook is the single view's chain: every haze pass the single view has
    const single = compiled({}, false).passes.filter((pass) => "nodeId" in pass && String(pass.nodeId).startsWith("hazeRender/")).length;
    expect(single).toBeGreaterThan(0);
    expect(compiled({}, true).passes.filter((pass) => "nodeId" in pass && String(pass.nodeId).startsWith("hazeRender/")).length).toBe(single);
  });
});

/**
 * VN83 — stage-previz-12: a dual view (front over a stage-right profile, full-width strips), and
 * each layout a Layer on a black base, so only the one switched on cooks: Single, Dual, Quad.
 */
describe("stage-previz-12: one layout cooks at a time", () => {
  const system12 = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  const loaded12 = loadProject(readFileSync("projects/stage-previz/stage-previz-12.loom.json", "utf8"), { nodes: system12.nodes, components: system12.components });
  if (!loaded12.ok) throw new Error(`stage-previz-12 did not load: ${loaded12.reason}`);
  const doc12 = loaded12.document;
  const LAYERS = ["layerSingle", "layerDual", "layerQuad"] as const;
  /** What cooks with only `on` switched on, by the top-level node each pass belongs to. */
  const cooking = (on: (typeof LAYERS)[number]) => {
    const nodes = { ...doc12.graph.nodes };
    for (const id of LAYERS) nodes[id] = { ...nodes[id]!, ui: { ...nodes[id]!.ui, bypassed: id !== on } };
    const plan = compileGraph({ graph: { ...doc12.graph, nodes }, settings: doc12.settings, registry: system12.nodes, capabilities: TIER_B_CAPABILITIES, components: system12.components.view(), resolution: { channels: () => undefined } });
    if (!plan.ok) throw new Error("stage-previz-12 did not compile");
    return [...new Set(plan.passes.map((pass) => ("nodeId" in pass ? String(pass.nodeId).split("/")[0]! : "")).filter((id) => /^(hazeRender|view_|strip_|quad|dual)$|^(view|strip)_/.test(id)))].sort();
  };

  it("opens on Single, the other two off", () => {
    expect(LAYERS.map((id) => doc12.graph.nodes[id]!.ui?.bypassed === true)).toEqual([false, true, true]);
  });

  it.each([
    ["layerSingle", ["hazeRender"]],
    ["layerDual", ["dual", "strip_front", "strip_side"]],
    ["layerQuad", ["quad", "view_angled", "view_profile", "view_tight", "view_wide"]],
  ] as const)("%s on alone cooks only its own views", (on, expected) => {
    expect(cooking(on)).toEqual([...expected]);
  });
});
