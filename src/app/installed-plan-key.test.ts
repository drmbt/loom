import { describe, expect, it } from "vitest";

import { compileGraph } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { edge, graph, named, settings } from "@/examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "@/examples/runner.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installedPlanKey } from "./use-frame-loop.ts";

/**
 * T1655b — A CAMERA'S TILE IS ANNOUNCED WHEN IT COMES ON SCREEN (§B188, one row further).
 *
 * The tiles, the orbit sets and the viewer read `installedPlan.outputs`, and the App is
 * told about a new install only when `installedPlanKey` moves, so that a values-only edit
 * does not re-render it (§V16). §B188 found the key blind to synthesized rows. It was also
 * blind to a row that BORROWS: a camera with exactly one Render previews as that Render's
 * own picture (T546), which adds no pass, no resource and no synthesis. So when such a
 * camera's tile scrolled into view, the plan that held its row had the same key as the plan
 * before, was never announced, and the tile read "no signal".
 *
 * Reproduced through the real app in `src/tests/e2e/preview-camera.spec.ts`: a camera far
 * from everything, gone to after the install, said "no signal" beside a Render drawing the
 * shot. This file holds the cause: the two plans really do share a signature.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

function shot(options: { camera?: string; eye?: readonly [number, number, number] } = {}): GraphDocument {
  const through = options.camera ?? "camera_shot";
  return graph(
    [
      named("source", "pointGrid", [0, 0], { cols: 4, rows: 4 }),
      named("boxes", "geometry", [400, 0], { mode: "instances" }),
      named("key", "light", [800, 0]),
      named("shot", "camera", [0, 400], { eye: [...(options.eye ?? [0, 0.5, 3])], lookAt: [0, 0, 0] }),
      named("other", "camera", [0, 800], { eye: [3, 0.5, 0], lookAt: [0, 0, 0] }),
      named("shot", "render", [400, 400]),
      named("final", "output", [800, 400]),
    ],
    [
      edge("e1", ["grid_source", "out"], ["geometry_boxes", "points"]),
      edge("e2", ["geometry_boxes", "out"], ["render_shot", "scenes"]),
      edge("e3", [through, "out"], ["render_shot", "camera"]),
      edge("e4", ["light_key", "out"], ["render_shot", "lights"]),
      edge("e5", ["render_shot", "out"], ["output_final", "input"]),
    ],
  );
}

function compile(document: GraphDocument, watched: readonly string[]): CompiledGraph {
  return compileGraph({
    graph: document,
    settings: settings({ outputResolution: { width: 64, height: 64 } }),
    registry,
    capabilities: TIER_B_CAPABILITIES,
    sinks: watched.map((nodeId) => ({ nodeId, portId: "out", kind: "preview" as const })),
  } as never);
}

describe("T1655b — the installed plan's key sees a borrowed row", () => {
  it("⚑ a camera's tile coming on screen moves the key, though it adds no pass and no resource", () => {
    const before = compile(shot(), ["render_shot"]);
    const after = compile(shot(), ["render_shot", "camera_shot"]);
    // The premise, both halves: the camera's row is there now, and NOTHING the plan signature covers moved.
    expect(before.outputs.some((output) => output.nodeId === "camera_shot")).toBe(false);
    expect(after.outputs.find((output) => output.nodeId === "camera_shot")?.synthesis).toBeUndefined();
    expect(after.signature).toBe(before.signature);
    expect(installedPlanKey(after)).not.toBe(installedPlanKey(before));
  });

  it("a values-only edit does NOT move it: moving the camera must not re-render the App", () => {
    // The legitimate case a wider key could swallow, and the reason the key is value-blind (§V16).
    const before = compile(shot({ eye: [0, 0.5, 3] }), ["render_shot", "camera_shot"]);
    const after = compile(shot({ eye: [2, 0.5, 3] }), ["render_shot", "camera_shot"]);
    expect(installedPlanKey(after)).toBe(installedPlanKey(before));
  });

  it("re-wiring the Render to another camera moves it: the tile's sentence names the camera", () => {
    const before = compile(shot({ camera: "camera_shot" }), ["render_shot"]);
    const after = compile(shot({ camera: "camera_other" }), ["render_shot"]);
    expect(after.outputs.find((output) => output.nodeId === "render_shot")?.previewCamera).toEqual({
      kind: "none",
      reason: { because: "through-camera", camera: "camera_other" },
    });
    expect(installedPlanKey(after)).not.toBe(installedPlanKey(before));
  });
});
