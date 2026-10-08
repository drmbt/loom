import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/compile.ts";
import { SINK_TARGET_PORT, targetResourceId } from "../../compiler/resources.ts";
import { testCapabilities, testSettings } from "../../compiler/test-support.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { conformsToKind, kindOf } from "../graph/node-kinds.ts";
import { effectiveParameterSchema } from "../parameters/resolve.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createGraphStore } from "../graph/store.ts";
import { createFileReference, collectFileReferences } from "../media/file-reference.ts";
import { parseProjectDocument, serializeProjectDocument } from "../project/serialize.ts";
import { SCHEMA_VERSION } from "../types/schemas.ts";
import { createDomainBus } from "./index.ts";
import { registerPhotoMappingCommands } from "./photo-mapping-commands.ts";
import { alice, contextFor } from "./test-support.ts";

const shader = `struct Params { mode: f32, };
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let coordinate = vec2i(uv * vec2f(textureDimensions(inputTexture1)));
  let depth = textureLoad(inputTexture1, coordinate, 0).r;
  return vec4f(vec3f(depth + params.mode * 0.01), 1.0);
}`;
const input = { photo: createFileReference("photo", "image", "sculpture.jpg"),
  depth: createFileReference("depth", "binary", "depth.loom-f32"),
  mask: createFileReference("mask", "binary", "mask.loom-f32"), width: 800, height: 600, shader };

function harness(omitType?: string) {
  const registry = createNodeRegistry(allNodeDefinitions.filter(definition => definition.type !== omitType)).view();
  const store = createGraphStore({ ids: createSequentialIdFactory("photo"), initialSettings: testSettings() });
  const { bus } = createDomainBus({ store, registry });
  registerPhotoMappingCommands(bus);
  return { registry, store, bus };
}

describe("photo mapping creation", () => {
  it("creates a registered editable graph with float32 data and root projector controls", async () => {
    const { bus, store, registry } = harness();
    const result = await bus.execute("photoMapping.create", { ...input, effect: 2 }, contextFor(alice));
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(11);
    expect(Object.values(graph.edges)).toHaveLength(14);
    expect(Object.values(graph.groups)).toHaveLength(1);
    expect(Object.values(graph.groups)[0]!.members).toHaveLength(11);
    for (const node of Object.values(graph.nodes)) {
      expect(conformsToKind(node.label!, kindOf(registry.get(node.type)!))).toBe(true);
    }
    const ids = result.output.createdIds;
    expect(graph.nodes[ids.$coverage!]!.parameters).toMatchObject({ channel: "red", apply: "colour" });
    expect(graph.nodes[ids.$effect!]!.parameters).toMatchObject({ source: shader, mode: 2 });
    for (const ref of ["$photo", "$depth", "$mask"]) {
      expect(graph.nodes[ids[ref]!]!.resolution).toEqual({ mode: "fixed", width: 800, height: 600 });
    }
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: ids.$window!, kind: "output" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    for (const ref of ["$depth", "$mask"]) {
      expect(plan.outputs.find(output => output.nodeId === ids[ref])).toMatchObject({ format: "r32float", space: "data", size: [800, 600] });
    }
    expect(Object.values(graph.edges).filter(edge => edge.target.nodeId === ids.$effect && edge.target.portId === "more").sort((a, b) => a.order! - b.order!))
      .toMatchObject([{ source: { nodeId: ids.$depth }, order: 0 }, { source: { nodeId: ids.$mask }, order: 1 }]);
  });

  it.each([undefined, false])("keeps the viewer output independent from the projector with previz %s", async previz => {
    const { bus, store, registry } = harness();
    const result = await bus.execute("photoMapping.create", { ...input, ...(previz === undefined ? {} : { previz }) }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.diagnostics).toEqual([]);
    const graph = store.view.getGraph();
    const ids = result.output.createdIds;
    const previewEnabled = previz !== false;
    expect(Object.values(graph.nodes)).toHaveLength(previewEnabled ? 11 : 9);
    expect(Object.values(graph.edges)).toHaveLength(previewEnabled ? 14 : 11);
    expect(Object.values(graph.groups)[0]!.members).toHaveLength(previewEnabled ? 11 : 9);
    expect(Object.values(graph.nodes).some(node => node.type === "componentOut")).toBe(false);
    expect(graph.nodes[ids.$output!]!).toMatchObject({
      type: "output", label: previewEnabled ? "output_preview1" : "output_mapping1", position: { x: 780, y: 300 },
    });
    const incoming = (ref: string) => Object.values(graph.edges)
      .filter(edge => edge.target.nodeId === ids[ref])
      .map(edge => ({ source: edge.source, target: edge.target }));
    expect(incoming("$window")).toEqual([{ source: { nodeId: ids.$corner, portId: "out" },
      target: { nodeId: ids.$window, portId: "input" } }]);
    if (previewEnabled) {
      expect(graph.nodes[ids.$previz!]!).toMatchObject({ type: "screen", label: "screen_preview1", position: { x: 520, y: 300 }, parameters: { opacity: 0.35 } });
      expect(graph.nodes[ids.$reference!]!).toMatchObject({ type: "level", label: "level_reference1", position: { x: 260, y: 300 }, parameters: { brightness: 0.65 } });
      expect(incoming("$reference")).toEqual([
        { source: { nodeId: ids.$photo, portId: "out" }, target: { nodeId: ids.$reference, portId: "input" } },
      ]);
      expect(incoming("$previz")).toEqual([
        { source: { nodeId: ids.$coverage, portId: "out" }, target: { nodeId: ids.$previz, portId: "in1" } },
        { source: { nodeId: ids.$reference, portId: "out" }, target: { nodeId: ids.$previz, portId: "in2" } },
      ]);
      expect(incoming("$output")).toEqual([{ source: { nodeId: ids.$previz, portId: "out" },
        target: { nodeId: ids.$output, portId: "input" } }]);
    } else {
      expect(ids.$previz).toBeUndefined();
      expect(Object.values(graph.nodes).some(node => node.type === "screen")).toBe(false);
      expect(incoming("$output")).toEqual([{ source: { nodeId: ids.$corner, portId: "out" },
        target: { nodeId: ids.$output, portId: "input" } }]);
    }
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities() });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    const target = targetResourceId(ids.$output!, SINK_TARGET_PORT);
    expect(plan.resources.some(resource => resource.id === target)).toBe(true);
    expect(plan.outputs.find(output => output.nodeId === ids.$output)).toMatchObject({ portId: SINK_TARGET_PORT, resourceId: target });
    expect(plan.outputs.some(output => output.nodeId === ids.$window)).toBe(false);
    if (previewEnabled) {
      expect(plan.passes.find(pass => "nodeId" in pass && pass.nodeId === ids.$reference)).toMatchObject({
        kind: "effect", uniforms: { brightness: 0.65, opacity: 1 },
      });
      expect(plan.passes.find(pass => "nodeId" in pass && pass.nodeId === ids.$previz)).toMatchObject({
        kind: "effect", uniforms: { opacity: 0.35 }, textures: [
          { binding: "frontTexture", resourceId: targetResourceId(ids.$coverage!, "out") },
          { binding: "backTexture0", resourceId: targetResourceId(ids.$reference!, "out") },
        ],
      });
    }
  });

  it.each([0, 1])("persists preview opacity %i without changing the full-strength projector path", async previewOpacity => {
    const { bus, store, registry } = harness();
    const { mask: _mask, ...unmaskedInput } = input;
    const result = await bus.execute("photoMapping.create", { ...unmaskedInput, previewOpacity }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.diagnostics).toEqual([]);
    const graph = store.view.getGraph();
    const ids = result.output.createdIds;
    expect(Object.values(graph.nodes)).toHaveLength(11);
    expect(graph.nodes[ids.$previz!]!.parameters.opacity).toBe(previewOpacity);
    expect(graph.nodes[ids.$mask!]!).toMatchObject({ type: "solid", parameters: { color: [1, 1, 1, 1] } });
    for (const [source, target] of [["$coverage", "$grid"], ["$grid", "$corner"], ["$corner", "$window"]]) {
      expect(Object.values(graph.edges).find(edge => edge.target.nodeId === ids[target!] && edge.target.portId === "input"))
        .toMatchObject({ source: { nodeId: ids[source!], portId: "out" } });
    }
    const baseline = harness();
    const baselineResult = await baseline.bus.execute("photoMapping.create", { ...unmaskedInput, previz: false }, contextFor(alice));
    expect(baselineResult.status).toBe("applied");
    const baselineIds = baselineResult.output.createdIds;
    for (const ref of ["$coverage", "$grid", "$corner", "$window"]) {
      expect(graph.nodes[ids[ref]!]!.parameters).toEqual(baseline.store.view.getGraph().nodes[baselineIds[ref]!]!.parameters);
    }
    const parsed = parseProjectDocument(serializeProjectDocument({ schemaVersion: SCHEMA_VERSION,
      projectId: "projection", name: "Photo mapping", graph, settings: store.view.getSettings(),
      assets: collectFileReferences([graph]), createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.document.graph).toEqual(graph);
    const plan = compileGraph({ graph: parsed.document.graph, registry, settings: parsed.document.settings,
      capabilities: testCapabilities(), sinks: [{ nodeId: ids.$window!, kind: "output" }, { nodeId: ids.$output!, kind: "output" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(plan.passes.find(pass => "nodeId" in pass && pass.nodeId === ids.$previz)).toMatchObject({ uniforms: { opacity: previewOpacity } });
    const projectorPlan = compileGraph({ graph: parsed.document.graph, registry, settings: parsed.document.settings,
      capabilities: testCapabilities(), sinks: [{ nodeId: ids.$window!, kind: "output" }] });
    expect(projectorPlan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    const baselinePlan = compileGraph({ graph: baseline.store.view.getGraph(), registry,
      settings: baseline.store.view.getSettings(), capabilities: testCapabilities(), sinks: [{ nodeId: baselineIds.$window!, kind: "output" }] });
    // Main Output is always an active sink; compare the projector's source and warp passes.
    expect(projectorPlan.passes.filter(pass => !("nodeId" in pass) || (pass.nodeId !== ids.$previz && pass.nodeId !== ids.$reference && pass.nodeId !== ids.$output)))
      .toEqual(baselinePlan.passes.filter(pass => !("nodeId" in pass) || pass.nodeId !== baselineIds.$output));
  });

  it("saves and reloads independent photo, depth and mask references", async () => {
    const { bus, store } = harness();
    await bus.execute("photoMapping.create", input, contextFor(alice));
    const graph = store.view.getGraph();
    const assets = collectFileReferences([graph]);
    const parsed = parseProjectDocument(serializeProjectDocument({ schemaVersion: SCHEMA_VERSION,
      projectId: "projection", name: "Photo mapping", graph, settings: store.view.getSettings(), assets,
      createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.document.graph).toEqual(graph);
    expect(parsed.document.assets.map(asset => asset.assetId).sort()).toEqual(["depth", "mask", "photo"]);
  });

  it.each([true, false])("uses editable white full-frame coverage when no mask is supplied with previz %s", async previz => {
    const { bus, store, registry } = harness();
    const before = store.view.getGraph();
    const { mask: _mask, ...unmaskedInput } = input;
    const result = await bus.execute("photoMapping.create", { ...unmaskedInput, previz }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.diagnostics).toEqual([]);
    const graph = store.view.getGraph();
    const ids = result.output.createdIds;
    expect(graph.nodes[ids.$mask!]!).toMatchObject({
      type: "solid", label: "solid_coverage1", parameters: { color: [1, 1, 1, 1] },
      position: { x: 0, y: 600 }, resolution: { mode: "fixed", width: 800, height: 600 },
    });
    const edges = Object.values(graph.edges);
    expect(edges.filter(edge => edge.target.nodeId === ids.$mask)).toEqual([]);
    expect(edges.filter(edge => edge.target.nodeId === ids.$effect && edge.target.portId === "more")
      .sort((a, b) => a.order! - b.order!)).toMatchObject([
      { source: { nodeId: ids.$depth }, order: 0 }, { source: { nodeId: ids.$mask }, order: 1 },
    ]);
    expect(edges.filter(edge => edge.target.nodeId === ids.$coverage)).toMatchObject([
      { source: { nodeId: ids.$effect }, target: { portId: "input" } },
      { source: { nodeId: ids.$mask }, target: { portId: "mask" } },
    ]);
    expect(edges.filter(edge => edge.target.nodeId === ids.$window)).toMatchObject([
      { source: { nodeId: ids.$corner }, target: { portId: "input" } },
    ]);
    expect(edges.filter(edge => edge.target.nodeId === ids.$output)).toMatchObject([
      { source: { nodeId: previz ? ids.$previz : ids.$corner }, target: { portId: "input" } },
    ]);
    const assets = collectFileReferences([graph]);
    expect(assets.map(asset => asset.assetId).sort()).toEqual(["depth", "photo"]);
    const parsed = parseProjectDocument(serializeProjectDocument({ schemaVersion: SCHEMA_VERSION,
      projectId: "projection", name: "Photo mapping", graph, settings: store.view.getSettings(), assets,
      createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.document.graph).toEqual(graph);
    expect(parsed.document.assets.map(asset => asset.assetId).sort()).toEqual(["depth", "photo"]);
    const plan = compileGraph({ graph: parsed.document.graph, registry, settings: parsed.document.settings,
      capabilities: testCapabilities(), sinks: [
        { nodeId: ids.$window!, kind: "output" }, { nodeId: ids.$output!, kind: "output" },
      ] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(plan.outputs.find(output => output.nodeId === ids.$mask)).toMatchObject({ size: [800, 600] });
    expect(plan.outputs.find(output => output.nodeId === ids.$output)).toMatchObject({
      portId: SINK_TARGET_PORT, resourceId: targetResourceId(ids.$output!, SINK_TARGET_PORT),
    });
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(store.view.getGraph().nodes).toEqual(before.nodes);
    expect(store.view.getGraph().edges).toEqual(before.edges);
    expect(store.view.getGraph().groups).toEqual(before.groups);
    await bus.execute("graph.redo", {}, contextFor(alice));
    expect(store.view.getGraph().nodes).toEqual(graph.nodes);
    expect(store.view.getGraph().edges).toEqual(graph.edges);
    expect(store.view.getGraph().groups).toEqual(graph.groups);
  });

  it.each([
    { width: 6512, height: 4341, fittedWidth: 4096, fittedHeight: 2730 },
    { width: 4341, height: 6512, fittedWidth: 2730, fittedHeight: 4096 },
    { width: 100_000, height: 1, fittedWidth: 4096, fittedHeight: 1 },
  ])("fits oversized photo output without changing source references: %j", async dimensions => {
    const { bus, store, registry } = harness();
    const previewPhoto = createFileReference("preview", "image", "preview.jpg");
    const result = await bus.execute("photoMapping.create", {
      ...input, width: dimensions.width, height: dimensions.height, previewPhoto, previewFit: "fit",
    }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.diagnostics).toMatchObject([{ severity: "warning", code: "photoMapping.resolution.fitted" }]);
    expect(result.diagnostics[0]!.message).toContain(`${dimensions.width} × ${dimensions.height}`);
    expect(result.diagnostics[0]!.message).toContain(`${dimensions.fittedWidth} × ${dimensions.fittedHeight}`);
    expect(result.output.diagnostics).toEqual(result.diagnostics);
    const graph = store.view.getGraph();
    const ids = result.output.createdIds;
    for (const ref of ["$photo", "$depth", "$mask", "$previewPhoto"]) {
      expect(graph.nodes[ids[ref]!]!.resolution).toEqual({
        mode: "fixed", width: dimensions.fittedWidth, height: dimensions.fittedHeight,
      });
    }
    expect(graph.nodes[ids.$photo!]!.parameters.file).toBe(input.photo);
    expect(graph.nodes[ids.$depth!]!.parameters).toMatchObject({ file: input.depth, photo: input.photo });
    expect(graph.nodes[ids.$mask!]!.parameters).toMatchObject({ file: input.mask, photo: input.photo });
    expect(graph.nodes[ids.$previewPhoto!]!.parameters).toMatchObject({ file: previewPhoto, imageFit: "fit" });
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities() });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    for (const ref of ["$photo", "$depth", "$mask"]) {
      expect(plan.outputs.find(output => output.nodeId === ids[ref])).toMatchObject({
        size: [dimensions.fittedWidth, dimensions.fittedHeight],
      });
    }
    const parsed = parseProjectDocument(serializeProjectDocument({ schemaVersion: SCHEMA_VERSION,
      projectId: "projection", name: "Photo mapping", graph, settings: store.view.getSettings(),
      assets: collectFileReferences([graph]), createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.document.graph).toEqual(graph);
    expect(parsed.document.assets.map(asset => asset.assetId).sort()).toEqual(["depth", "mask", "photo", "preview"]);
  });

  it("keeps existing graph outputs and project resolution unchanged when fitting another photo", async () => {
    const { bus, store } = harness();
    await bus.execute("photoMapping.create", input, contextFor(alice));
    const before = store.view.getGraph();
    const settings = store.view.getSettings();
    const result = await bus.execute("photoMapping.create", { ...input, width: 6512, height: 4341 }, contextFor(alice));
    expect(result.status).toBe("applied");
    for (const [id, node] of Object.entries(before.nodes)) expect(store.view.getGraph().nodes[id]).toEqual(node);
    expect(store.view.getSettings()).toEqual(settings);
  });

  it.each([1036, 1288])("accepts depth preparation size %i supported by Float Map In", async inputSide => {
    const { bus, store, registry } = harness();
    const schema = effectiveParameterSchema(registry.get("floatMapIn")!, {})["inputSide"]!;
    expect(schema.type).toBe("enum");
    if (schema.type !== "enum") throw new Error("Depth input size must be an enum.");
    expect(schema.options.some(option => option.value === String(inputSide))).toBe(true);
    const result = await bus.execute("photoMapping.create", { ...input, inputSide }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.diagnostics).toEqual([]);
    expect(store.view.getGraph().nodes[result.output.createdIds.$depth!]!.parameters.inputSide).toBe(String(inputSide));
  });

  it("creates additional surfaces with distinct names and non-overlapping bounds", async () => {
    const { bus, store } = harness();
    await bus.execute("photoMapping.create", input, contextFor(alice));
    await bus.execute("photoMapping.create", input, contextFor(alice));
    const nodes = Object.values(store.view.getGraph().nodes);
    expect(nodes).toHaveLength(22);
    expect(new Set(nodes.map(node => node.label)).size).toBe(22);
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const left = nodes[a]!;
      const right = nodes[b]!;
      const separated = left.position.x + left.size!.width <= right.position.x || right.position.x + right.size!.width <= left.position.x ||
        left.position.y + left.size!.height <= right.position.y || right.position.y + right.size!.height <= left.position.y;
      expect(separated).toBe(true);
    }
    const [first, second] = Object.values(store.view.getGraph().groups);
    expect(first!.bounds.x + first!.bounds.width).toBeLessThan(second!.bounds.x);
  });

  it("undoes and redoes the whole surface as one action", async () => {
    const { bus, store } = harness();
    const before = store.view.getGraph();
    await bus.execute("photoMapping.create", input, contextFor(alice));
    const created = store.view.getGraph();
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(store.view.getGraph().nodes).toEqual(before.nodes);
    expect(store.view.getGraph().edges).toEqual(before.edges);
    expect(store.view.getGraph().groups).toEqual(before.groups);
    await bus.execute("graph.redo", {}, contextFor(alice));
    expect(store.view.getGraph().nodes).toEqual(created.nodes);
    expect(store.view.getGraph().edges).toEqual(created.edges);
    expect(store.view.getGraph().groups).toEqual(created.groups);
  });

  it("validates dry runs without mutation or minted IDs", async () => {
    const { bus, store } = harness();
    const before = store.view.getGraph();
    const result = await bus.execute("photoMapping.create", input, contextFor(alice, { dryRun: true }));
    expect(result.status).toBe("validated");
    expect(result.output.createdIds).toEqual({});
    expect(store.view.getGraph()).toEqual(before);
  });

  it("refuses a missing preparation node without creating a partial graph", async () => {
    const { bus, store } = harness("floatMapIn");
    const before = store.view.getGraph();
    const result = await bus.execute("photoMapping.create", input, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics).toMatchObject([{ code: "photoMapping.node.unavailable" }]);
    expect(store.view.getGraph()).toEqual(before);
  });

  it.each([{ shader: "" }, { mask: "" }, { mask: "   " }, { width: 0 }, { height: 0 }, { inputSide: 1024 },
    { previewOpacity: -0.01 }, { previewOpacity: 1.01 }, { previewOpacity: NaN }, { previewOpacity: Infinity }])("rejects invalid preparation input %j atomically", async change => {
    const { bus, store } = harness();
    const before = store.view.getGraph();
    const result = await bus.execute("photoMapping.create", { ...input, ...change }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some(diagnostic => diagnostic.severity === "error")).toBe(true);
    expect(store.view.getGraph()).toEqual(before);
  });
});
