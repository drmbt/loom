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
 * its shader lays them out; the Layout fader picks the single view or the quad.
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

function compiled(values: Readonly<Record<string, number>> = {}) {
  const channels: ChannelResolver = (name, context) => (context.definition.type === "number" ? values[name.split(":")[1] ?? name] : undefined);
  const plan = compileGraph({ graph: document.graph, settings: document.settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components: system.components.view(), resolution: { channels } });
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

  it("the quad takes tight, wide, angled, profile in its shader's order, and Layout picks single or quad", () => {
    const into = (nodeId: string, portId: string) =>
      Object.values(document.graph.edges).filter((wire) => wire.target.nodeId === nodeId && wire.target.portId === portId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((wire) => wire.source.nodeId);
    expect(into("quad", "input")).toEqual(["view_tight"]);
    expect(into("quad", "more")).toEqual(["view_wide", "view_angled", "view_profile"]);
    expect(into("pick", "inputs")).toEqual(["hazeRender", "quad"]);
    expect(into("out", "input")).toEqual(["pick"]);
    expect(uniformsOf(compiled({ layout: 0 }), "pick")).not.toEqual(uniformsOf(compiled({ layout: 1 }), "pick"));
  });
});
