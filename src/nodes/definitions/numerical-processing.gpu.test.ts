import { beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "../../domain/commands/index.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../tests/headless/pixel-compare.ts";
import { compileGraph } from "../../compiler/index.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { settings } from "../../examples/documents/builders.ts";

let dawnError: string | undefined;
beforeAll(async () => { dawnError = (await probeDawn()).error; }, 60_000);

/** Real command-path connections, with an explicit constant numerical-map source. */
async function numericalGraph(value: number, brightness = 2, softness = 0) {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const projectSettings = settings({ outputResolution: { width: 4, height: 4 },
    colorPolicy: { workingSpace: "linear", displayTransform: "none" } });
  const store = createGraphStore({ ids: createSequentialIdFactory("numeric"), initialSettings: projectSettings });
  const { bus } = createDomainBus({ store, registry });
  const operations: GraphPatchOperation[] = [
    { op: "addNode", ref: "$map", type: "floatMapIn", label: "floatmap_mask", position: { x: 0, y: 0 },
      parameters: { file: "", emptySource: "constant", emptyValue: value, interpretation: "mask" } },
    { op: "addNode", ref: "$level", type: "level", label: "level_coverage", position: { x: 260, y: 0 }, parameters: { brightness } },
    { op: "addNode", ref: "$limit", type: "limit", label: "limit_coverage", position: { x: 520, y: 0 }, parameters: { low: 0, high: 1 } },
    { op: "addNode", ref: "$threshold", type: "threshold", label: "threshold_coverage", position: { x: 780, y: 0 },
      parameters: { threshold: 0.50015, softness } },
    { op: "addNode", ref: "$picture", type: "solid", label: "solid_picture", position: { x: 780, y: 240 }, parameters: { color: [1, 0, 0, 1] } },
    { op: "addNode", ref: "$mask", type: "mask", label: "mask_processed", position: { x: 1040, y: 0 }, parameters: { channel: "red", apply: "colour" } },
    { op: "addNode", ref: "$out", type: "output", label: "output_masked", position: { x: 1300, y: 0 } },
    { op: "connect", source: { nodeId: "$map", portId: "out" }, target: { nodeId: "$level", portId: "input" } },
    { op: "connect", source: { nodeId: "$level", portId: "out" }, target: { nodeId: "$limit", portId: "input" } },
    { op: "connect", source: { nodeId: "$limit", portId: "out" }, target: { nodeId: "$threshold", portId: "input" } },
    { op: "connect", source: { nodeId: "$threshold", portId: "out" }, target: { nodeId: "$mask", portId: "mask" } },
    { op: "connect", source: { nodeId: "$picture", portId: "out" }, target: { nodeId: "$mask", portId: "input" } },
    { op: "connect", source: { nodeId: "$mask", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
  ];
  const result = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations },
    { actor: { kind: "human", id: "numeric-test" }, projectId: "numeric-test", capabilities: [] });
  expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
  const graph = store.view.getGraph();
  const id = (type: string) => {
    const node = Object.values(graph.nodes).find(node => node.type === type);
    if (node === undefined) throw new Error(`Numerical fixture lacks ${type}`);
    return node.id;
  };
  return { graph, registry, projectSettings, id };
}

describe("numerical masks remain editable in the graph", () => {
  it("connects Float Map → Level → Limit → Threshold → Mask and preserves r32float/data on baseline WebGPU", async () => {
    const fixture = await numericalGraph(0.2501);
    const plan = compileGraph({ graph: fixture.graph, settings: fixture.projectSettings,
      registry: fixture.registry, capabilities: TIER_B_CAPABILITIES });
    expect(plan.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    for (const type of ["level", "limit", "threshold"]) {
      expect(plan.outputs.find(row => row.nodeId === fixture.id(type))).toMatchObject({ format: "r32float", space: "data" });
      const pass = plan.passes.find(pass => pass.kind === "effect" && pass.nodeId === fixture.id(type));
      if (pass?.kind !== "effect") throw new Error(`${type} did not emit an effect`);
      expect(pass.textures?.every(binding => binding.sampled === "unfiltered")).toBe(true);
      expect(pass.samplers ?? []).toEqual([]);
    }
  });

  it.each([[0.25005, 0], [0.2501, 1]] as const)("keeps enough precision to distinguish mask %s across Level and Threshold", async (value, expected) => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const fixture = await numericalGraph(value);
    const result = await renderHeadless({ host: nodeGpuHost(), graph: fixture.graph, settings: fixture.projectSettings,
      frames: 1, outputNodeId: fixture.id("threshold") });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const frame = result.frames[0];
    if (frame === undefined) throw new Error("No numerical frame captured");
    expect(frame.format).toBe("r32float");
    const values = decodeComponents(frame.bytes, frame.format);
    for (const value of values) expect(value).toBeCloseTo(expected, 5);
  }, 60_000);

  it("feeds the processed coverage back into Mask without reducing it to a UI-only edit", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const fixture = await numericalGraph(0.25, 2, 0.2);
    const result = await renderHeadless({ host: nodeGpuHost(), graph: fixture.graph, settings: fixture.projectSettings,
      frames: 1, outputNodeId: fixture.id("output") });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const frame = result.frames[0];
    if (frame === undefined) throw new Error("No masked picture captured");
    const values = decodeComponents(frame.bytes, frame.format);
    // Smoothstep around a threshold of .50015 gives approximately half coverage at .5.
    expect(values[0]).toBeCloseTo(0.5, 2);
    expect(values[1]).toBe(0);
    expect(values[2]).toBe(0);
    expect(values[3]).toBeCloseTo(0.5, 2);
  }, 60_000);
});
