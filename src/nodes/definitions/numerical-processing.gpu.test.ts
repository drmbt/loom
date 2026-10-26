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

/**
 * T1708b: Displace FILTERS its field, and a device need not filter 32-bit floats (§V57), so a
 * Float Map In field used to be refused at compile on baseline WebGPU
 * (`compiler/binding-unfilterable`). The field is now read with textureLoad and filtered in
 * the shader. Through the real stack on Dawn without `float32-filterable`, exactly: a
 * constant field of 0.75 at weight 0.25 moves uv by 0.0625 in x, one texel of a 16-wide
 * picture, so the displaced ramp is the undisplaced one shifted one pixel, its last column
 * held. A constant field is also the one bilinear filtering cannot change.
 */
describe("Displace reads a 32-bit float field on baseline WebGPU (T1708b)", () => {
  const SIDE = 16;
  const projectSettings = settings({ outputResolution: { width: SIDE, height: SIDE },
    colorPolicy: { workingSpace: "linear", displayTransform: "none" } });
  const node = (id: string, type: string, parameters: Record<string, unknown>) =>
    ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters });
  const edge = (id: string, from: string, to: string, port: string) =>
    ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });
  /** A horizontal ramp displaced by a field of red = `value`, green = 0. */
  const graphWith = (value: number) => ({
    revision: 1,
    nodes: {
      ramp: node("ramp", "ramp", { type: "horizontal" }),
      field: node("field", "floatMapIn", { file: "", emptySource: "constant", emptyValue: value, interpretation: "mask" }),
      push: node("push", "displace", { weight: [0.25, 0.25], extend: "hold" }),
      out: node("out", "output", {}),
    },
    edges: {
      a: edge("a", "ramp", "push", "source"),
      b: edge("b", "field", "push", "disp"),
      c: edge("c", "push", "out", "input"),
    },
    groups: {},
  });
  const render = async (graph: ReturnType<typeof graphWith>, outputNodeId: string): Promise<Uint8Array> => {
    const result = await renderHeadless({ host: nodeGpuHost(), graph: graph as never, settings: projectSettings,
      frames: 1, outputNodeId });
    expect(result.diagnostics.filter(d => d.severity === "error").map(d => d.message)).toEqual([]);
    const frame = result.frames[0];
    if (frame === undefined) throw new Error("No displaced frame captured");
    return frame.bytes;
  };

  it("compiles the r32float field as an unfiltered read on Tier B", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph: graphWith(0.75) as never, settings: projectSettings,
      registry, capabilities: TIER_B_CAPABILITIES });
    expect(plan.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const pass = plan.passes.find(entry => entry.kind === "effect" && entry.nodeId === "push");
    if (pass?.kind !== "effect") throw new Error("Displace did not emit an effect");
    expect(pass.textures?.find(binding => binding.binding === "displaceTexture")?.sampled).toBe("unfiltered");
  });

  it("moves the picture by exactly the field's value", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const shifted = await render(graphWith(0.75), "push");
    const ramp = await render(graphWith(0.75), "ramp");
    const texel = shifted.byteLength / (SIDE * SIDE);
    const pixel = (bytes: Uint8Array, x: number, y: number) =>
      Array.from(bytes.subarray((y * SIDE + x) * texel, (y * SIDE + x + 1) * texel));
    // Green 0 sits below the 0.5 midpoint, so y moves too, but a horizontal ramp is the same
    // down every column: only red's one texel is visible.
    for (let y = 0; y < SIDE; y += 1) {
      for (let x = 0; x < SIDE; x += 1) {
        expect({ x, y, value: pixel(shifted, x, y) }).toEqual({ x, y, value: pixel(ramp, Math.min(x + 1, SIDE - 1), y) });
      }
    }
    // The ramp is not flat, or a shift would be invisible.
    expect(pixel(ramp, 0, 0)).not.toEqual(pixel(ramp, 1, 0));
  }, 60_000);
});
