import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import { loadProject } from "../../domain/project/index.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";

/**
 * T1404b — the furnace bloom pyramid halves per level, as a pyramid must.
 *
 * A node's `scale` resolution is relative to its INPUT (compiler/resolution.ts). The saved
 * document gave every level `0.5 / 2 ** level`, so the factors compounded: level 4 landed
 * at 1/512 of the frame and the whole upsample chain collapsed to one texel, a flat wash
 * of the frame's average colour instead of a glow around each light. Asserted on the
 * SAVED document (the file the app opens), compiled the way the app compiles it.
 */
const registry = createNodeRegistry(allNodeDefinitions).view();

function sizes(): Map<string, readonly [number, number]> {
  const system = createComponentSystem(registry);
  const loaded = loadProject(readFileSync("projects/furnace/furnace.loom.json", "utf8"), { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`did not load: ${loaded.reason}`);
  const plan = compileGraph({
    graph: loaded.document.graph,
    settings: loaded.document.settings,
    registry: system.nodes,
    capabilities: TIER_B_CAPABILITIES,
    components: system.components.view(),
  });
  return new Map(plan.outputs.map((output) => [output.nodeId, output.size] as const));
}

describe("T1404b — the furnace bloom pyramid", () => {
  it("halves per downsample level and doubles back per upsample level", () => {
    const size = sizes();
    const bright = size.get("bright");
    expect(bright).toEqual([960, 540]);
    // Down level L sits at 1/2^L of the bright pass; up level L doubles the level below, so
    // it lands on down level L's size (level 0 on the bright pass) up to the rounding of
    // 135 → 68 → 34 on the way down: heights come back as 68, 136, 272, 544. The upsample
    // reads its own level by uv, so four rows of slack cost nothing.
    expect([1, 2, 3, 4].map((level) => size.get(`bloomDown${level}`))).toEqual([
      [480, 270],
      [240, 135],
      [120, 68],
      [60, 34],
    ]);
    expect([0, 1, 2, 3].map((level) => size.get(`bloomUp${level}`))).toEqual([
      [960, 544],
      [480, 272],
      [240, 136],
      [120, 68],
    ]);
  });
});
