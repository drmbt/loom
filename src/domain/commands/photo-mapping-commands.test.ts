import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/compile.ts";
import { SINK_TARGET_PORT, targetResourceId } from "../../compiler/resources.ts";
import { graphChannelResolver } from "../channels/graph-channels.ts";
import { testCapabilities, testSettings, flatDocument } from "../../compiler/test-support.ts";
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
import { DEFAULT_PHOTO_DEPTH_RECIPE, DEFAULT_DEPTH_REFINEMENT, depthRecipeFromParameters } from "../media/photo-depth-recipe.ts";
import { DEFAULT_IMAGE_FRAMING } from "../media/image-framing.ts";
import { SHADER_DEPTH_RANGE, SHADER_DEPTH_LIGHT, SHADER_DEPTH_CONTOURS, SHADER_DEPTH_SLICE } from "../media/photo-mapping-modules.ts";
import { PHOTO_DEPTH_CARVE_KERNEL, PHOTO_DEPTH_PAINT_KERNEL } from "../media/depth-point-kernels.ts";
import type { PhotoMappingCreateInput } from "./photo-mapping-commands.ts";

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
  depth: createFileReference("depth", "binary", "depth.loom.exr"),
  mask: createFileReference("mask", "binary", "mask.loom.exr"), width: 800, height: 600, shader };

function harness(omitType?: string) {
  const registry = createNodeRegistry(allNodeDefinitions.filter(definition => definition.type !== omitType)).view();
  const store = createGraphStore({ ids: createSequentialIdFactory("photo"), initialSettings: testSettings() });
  const { bus } = createDomainBus({ store, registry });
  registerPhotoMappingCommands(bus);
  return { registry, store, bus };
}

describe("photo mapping creation", () => {
  it.each([10, 11, 12, 13])("creates modular recipe %i with editable stages and shared calibration, coverage and alignment", async effect => {
    const { bus, store, registry } = harness();
    const patternShader = "@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }";
    const depthRange = { low: 0.2, high: 0.8, softness: 0.03 };
    const result = await bus.execute("photoMapping.create", { ...input, effect, depthRange, patternShader, testPattern: true }, contextFor(alice));
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
    const graph = store.view.getGraph(), ids = result.output.createdIds;
    const node = (ref: string) => graph.nodes[ids[ref]!]!;
    const edges = Object.values(graph.edges);
    const wire = (source: string, target: string, port: string) => expect(edges.find(edge =>
      edge.source.nodeId === ids[source] && edge.target.nodeId === ids[target] && edge.target.portId === port)).toBeDefined();
    expect(node("$range")).toMatchObject({ type: "customWgslMulti", format: { mode: "fixed", format: "r32float" },
      parameters: { source: SHADER_DEPTH_RANGE, low: 0.2, high: 0.8 } });
    expect(node("$effect")).toMatchObject({ type: "level", parameters: { brightness: effect === 13 ? 1.5 : 1, contrast: 1 } });
    wire("$photo", "$depth", "picture"); wire("$photo", "$mask", "picture");
    wire("$photo", "$range", "input"); wire("$depth", "$range", "more");
    wire("$effect", "$testSwitch", "inputs"); wire("$pattern", "$testSwitch", "inputs");
    wire("$testSwitch", "$coverage", "input"); wire("$mask", "$coverage", "mask");
    wire("$coverage", "$grid", "input"); wire("$grid", "$corner", "input"); wire("$corner", "$window", "input");
    if (effect === 13) {
      expect(node("$points").parameters).toMatchObject({ count: 768 * 576, cols: 768, rows: 576, sizeX: 2, sizeY: 2 });
      expect(node("$carve").parameters).toMatchObject({ capacity: 768 * 576, kernel: PHOTO_DEPTH_CARVE_KERNEL, inverseDepth: 1, near: 1.5, far: 3.5 });
      expect(node("$paint").parameters).toMatchObject({ kernel: PHOTO_DEPTH_PAINT_KERNEL, heat: 0, gain: 1 });
      expect(node("$cloudGeometry").parameters).toMatchObject({ material: node("$material").label, blend: "opaque", spherical: false,
        scale: { mode: "map", bindings: { map: { attribute: "tint", channel: "w" } } },
        tint: { mode: "map", bindings: { map: { attribute: "tint" } } } });
      expect(node("$render").parameters).toMatchObject({ scenes: node("$cloudGeometry").label, camera: node("$camera").label });
      wire("$points", "$carve", "in"); wire("$range", "$carve", "field"); wire("$carve", "$paint", "in");
      wire("$photoCoverage", "$paint", "field"); wire("$paint", "$cloudGeometry", "points"); wire("$render", "$effect", "input");
      expect(node("$photoCoverage").parameters.apply).toBe("alpha");
      expect(node("$camera").parameters["eye.x"]).toMatchObject({ mode: "expression", bindings: { expression: { source: `op('${node("$motion").label}').chan.value` } } });
    } else {
      expect(node("$module").parameters.source).toBe(effect === 10 ? SHADER_DEPTH_LIGHT : effect === 11 ? SHADER_DEPTH_CONTOURS : SHADER_DEPTH_SLICE);
      wire("$range", "$module", "more"); wire("$photo", "$module", "input"); wire("$module", "$multiply", "in1");
      wire(effect === 12 ? "$photo" : "$tint", "$multiply", "in2"); wire("$multiply", "$effect", "input");
      expect(node("$module").parameters[effect === 10 ? "direction.x" : effect === 11 ? "offset" : "center"])
        .toMatchObject({ mode: "expression", bindings: { expression: { source: `op('${node("$motion").label}').chan.value` } } });
    }
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: ids.$window!, kind: "readback" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    const ranged = plan.outputs.find(output => output.nodeId === ids.$range);
    expect(ranged).toMatchObject({ format: "r32float", space: "data", size: [800, 600] });
    if (effect === 13) {
      const carve = plan.passes.find(pass => "nodeId" in pass && pass.nodeId === ids.$carve && "textures" in pass);
      expect(carve).toMatchObject({ textures: [{ binding: "fieldTexture", resourceId: ranged!.resourceId, sampled: "unfiltered" }] });
      // The actual scalar field enters Carve directly: no colour conversion or image substitute.
      expect(plan.outputs.find(output => output.nodeId === ids.$render)).toMatchObject({ size: [800, 600] });
    }
    const positions = Object.values(graph.nodes).map(value => `${value.position.x},${value.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
    const group = graph.groups[ids.$group!]!;
    for (const value of Object.values(graph.nodes)) {
      expect(conformsToKind(value.label!, kindOf(registry.get(value.type)!))).toBe(true);
      expect(value.position.x + value.size!.width).toBeLessThanOrEqual(group.bounds.x + group.bounds.width);
      expect(value.position.y + value.size!.height).toBeLessThanOrEqual(group.bounds.y + group.bounds.height);
    }
    expect(collectFileReferences([graph]).map(asset => asset.assetId).sort()).toEqual(["depth", "mask", "photo"]);
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(Object.keys(store.view.getGraph().nodes)).toHaveLength(0);
  });

  it.each([10, 11, 12, 13])("resolves recipe %i motion through ordinary LFO channels at the supplied frame", async effect => {
    const { bus, store, registry } = harness();
    const result = await bus.execute("photoMapping.create", { ...input, effect }, contextFor(alice));
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph(), ids = result.output.createdIds;
    const channels = graphChannelResolver(flatDocument(graph), registry);
    const at = (timeSeconds: number) => compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: ids.$window!, kind: "readback" }], resolution: { channels, frame: {
        timeSeconds, deltaSeconds: 1 / 60, frameIndex: Math.round(timeSeconds * 60), mode: "realtime", randomSeed: 7,
      } } });
    const first = at(0), later = at(6);
    expect(first.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(later.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    // The same graph and resources animate by parameter values; shader code does not own a clock.
    expect(later.signature).toBe(first.signature);
    expect(later.passes).not.toEqual(first.passes);
    if (effect !== 13) {
      const firstPass = first.passes.find(pass => "nodeId" in pass && pass.nodeId === ids.$module);
      const laterPass = later.passes.find(pass => "nodeId" in pass && pass.nodeId === ids.$module);
      expect(laterPass).not.toEqual(firstPass);
    }
  });

  it("keeps portrait cloud sampling rectangular and compiles an explicit neutral depth stub", async () => {
    const { bus, store, registry } = harness();
    const result = await bus.execute("photoMapping.create", { photo: input.photo, width: 300, height: 800, shader, effect: 13 }, contextFor(alice));
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph(), ids = result.output.createdIds;
    expect(graph.nodes[ids.$points!]!.parameters).toMatchObject({ cols: 288, rows: 768, count: 288 * 768 });
    expect(graph.nodes[ids.$carve!]!.parameters.capacity).toBe(288 * 768);
    expect(graph.nodes[ids.$depth!]!.parameters).toMatchObject({ file: "", emptySource: "constant", emptyValue: 0.5 });
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: ids.$window!, kind: "readback" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(plan.resources.some(resource => resource.kind === "externalTexture" && resource.format === "r32float")).toBe(false);
  });

  it("resolves modular scene and expression names after collision suffixes and retains both recipes", async () => {
    const { bus, store, registry } = harness();
    for (let suffix = 1; suffix <= 2; suffix++) {
      const result = await bus.execute("photoMapping.create", { ...input, effect: 13 }, contextFor(alice));
      expect(result.status).toBe("applied");
      const graph = store.view.getGraph(), ids = result.output.createdIds;
      const geometry = graph.nodes[ids.$cloudGeometry!]!, material = graph.nodes[ids.$material!]!;
      const camera = graph.nodes[ids.$camera!]!, motion = graph.nodes[ids.$motion!]!;
      expect(geometry.parameters.material).toBe(material.label);
      expect(material.label).toBe(`material_photo_white${suffix}`);
      expect(camera.parameters["eye.x"]).toMatchObject({ bindings: { expression: { source: `op('${motion.label}').chan.value` } } });
      expect(graph.nodes[ids.$render!]!.parameters).toMatchObject({ camera: camera.label, scenes: geometry.label });
      const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
        sinks: [{ nodeId: ids.$window!, kind: "readback" }] });
      expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    }
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(Object.values(store.view.getGraph().nodes).some(node => node.label?.endsWith("2"))).toBe(false);
    expect(Object.values(store.view.getGraph().nodes).some(node => node.label === "geometry_photo_points1")).toBe(true);
  });

  it("rejects a missing structured recipe dependency before creating any partial network", async () => {
    const { bus, store } = harness("pointKernel");
    const before = store.view.getGraph();
    const result = await bus.execute("photoMapping.create", { ...input, effect: 13 }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "photoMapping.node.unavailable" }));
    expect(store.view.getGraph()).toBe(before);
  });

  it("creates editable neutral-depth and white-mask sources without assets, retaining both photo connections", async () => {
    const { bus, store, registry } = harness();
    const result = await bus.execute("photoMapping.create", { photo: input.photo, width: 800, height: 600, shader }, contextFor(alice));
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph(), ids = result.output.createdIds;
    for (const [ref, interpretation, emptyValue] of [["$depth", "depth", 0.5], ["$mask", "mask", 1]] as const) {
      expect(graph.nodes[ids[ref]!]!).toMatchObject({ type: "floatMapIn", parameters: {
        file: "", photo: input.photo, interpretation, emptySource: "constant", emptyValue,
      } });
      expect(Object.values(graph.edges).find(edge => edge.target.nodeId === ids[ref] && edge.target.portId === "picture"))
        .toMatchObject({ source: { nodeId: ids.$photo, portId: "out" } });
    }
    expect(collectFileReferences([graph]).map(asset => asset.assetId)).toEqual(["photo"]);
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: ids.$window!, kind: "readback" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    for (const [ref, emptyValue] of [["$depth", 0.5], ["$mask", 1]] as const) {
      expect(plan.outputs.find(output => output.nodeId === ids[ref])).toMatchObject({ format: "r32float", space: "data", size: [800, 600] });
      expect(plan.passes.find(pass => "nodeId" in pass && pass.nodeId === ids[ref]))
        .toMatchObject({ kind: "effect", uniforms: { emptyValue } });
    }
    expect(plan.resources.some(resource => resource.kind === "externalTexture" && resource.format === "r32float")).toBe(false);
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(Object.keys(store.view.getGraph().nodes)).toHaveLength(0);
  });

  it("keeps assigned numerical files on the explicit error path rather than a constant substitute", async () => {
    const { bus, store, registry } = harness();
    const result = await bus.execute("photoMapping.create", input, contextFor(alice));
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph();
    for (const ref of ["$depth", "$mask"]) {
      const node = graph.nodes[result.output.createdIds[ref]!]!;
      expect(node.parameters.emptySource).toBe("error");
      const emptySource = effectiveParameterSchema(registry.get(node.type)!, node.parameters).emptySource;
      if (emptySource?.type !== "enum") throw new Error("Float Map In requires its explicit empty-source enum.");
      expect(emptySource.default).toBe("error");
    }
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: result.output.createdIds.$window!, kind: "readback" }] });
    expect(plan.resources.filter(resource => resource.kind === "externalTexture" && resource.format === "r32float")).toHaveLength(2);
  });

  it.each([{ nativeDepth: input.depth }, { depthRecipe: DEFAULT_PHOTO_DEPTH_RECIPE }, { testPattern: true }])("rejects an incomplete optional preparation or calibration request without changing the graph: %j", async patch => {
      const { bus, store } = harness();
      const before = store.view.getGraph();
      const result = await bus.execute("photoMapping.create", { photo: input.photo, width: 800, height: 600, shader, ...patch }, contextFor(alice));
      expect(result.status).toBe("rejected");
      expect(store.view.getGraph()).toBe(before);
      expect(Object.keys(result.output.createdIds)).toHaveLength(0);
    });

  it("persists explicit working-depth bounds while leaving native assets and preparation settings intact", async () => {
    const { bus, store, registry } = harness();
    const rangeShader = shader.replace("struct Params { mode: f32, };", `struct Params {
      mode: f32,
      depthLow: f32, // @default 0
      depthHigh: f32, // @default 1
    };`);
    const depthRange = { low: 0.2, high: 0.8, softness: 0.03 };
    const result = await bus.execute("photoMapping.create", { ...input, shader: rangeShader, depthRange }, contextFor(alice));
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph(), ids = result.output.createdIds;
    expect(graph.nodes[ids.$effect!]!.parameters).toMatchObject({ depthLow: 0.2, depthHigh: 0.8 });
    expect(graph.nodes[ids.$depth!]!.parameters).toMatchObject({ file: input.depth, interpretation: "depth" });
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: ids.$window!, kind: "readback" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(plan.passes.find(pass => "nodeId" in pass && pass.nodeId === ids.$effect)).toMatchObject({ uniforms: { depthLow: 0.2, depthHigh: 0.8 } });
    const invalid = await bus.execute("photoMapping.create", { ...input, depthRange: { ...depthRange, high: 0.1 } }, contextFor(alice));
    expect(invalid.status).toBe("rejected");
    expect(store.view.getGraph()).toBe(graph);
  });

  it.each([true, false])("adds an editable calibration switch and arbitrary video without changing photo-depth-mask registration: %s", async testPattern => {
    const { bus, store, registry } = harness();
    const patternShader = `@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
      let grid = step(0.5, fract(uv.x * 8.0)); return vec4f(grid, grid, grid, 1.0);
    }`;
    const video = createFileReference("content-video", "video", "projection.webm");
    const result = await bus.execute("photoMapping.create", { ...input, effect: 9, patternShader, testPattern, video }, contextFor(alice));
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph(), ids = result.output.createdIds;
    expect(graph.nodes[ids.$pattern!]!).toMatchObject({ type: "customWgsl", parameters: { source: patternShader } });
    expect(graph.nodes[ids.$testSwitch!]!).toMatchObject({ type: "switch", parameters: { index: testPattern ? 1 : 0 } });
    expect(graph.nodes[ids.$video!]!).toMatchObject({ type: "movieFileIn", parameters: { file: video },
      resolution: { mode: "fixed", width: 800, height: 600 } });
    const edges = Object.values(graph.edges);
    expect(edges.filter(edge => edge.target.nodeId === ids.$testSwitch).sort((a, b) => a.order! - b.order!)).toMatchObject([
      { source: { nodeId: ids.$effect }, target: { portId: "inputs" }, order: 0 },
      { source: { nodeId: ids.$pattern }, target: { portId: "inputs" }, order: 1 },
    ]);
    expect(edges.find(edge => edge.target.nodeId === ids.$coverage && edge.target.portId === "input"))
      .toMatchObject({ source: { nodeId: ids.$testSwitch } });
    expect(edges.find(edge => edge.target.nodeId === ids.$effect && edge.target.portId === "input"))
      .toMatchObject({ source: { nodeId: ids.$video } });
    expect(edges.find(edge => edge.target.nodeId === ids.$pattern && edge.target.portId === "input"))
      .toMatchObject({ source: { nodeId: ids.$photo } });
    for (const ref of ["$depth", "$mask"]) {
      expect(edges.find(edge => edge.target.nodeId === ids[ref] && edge.target.portId === "picture"))
        .toMatchObject({ source: { nodeId: ids.$photo } });
    }
    const positions = Object.values(graph.nodes).map(node => `${node.position.x},${node.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
    const group = Object.values(graph.groups)[0]!;
    for (const node of Object.values(graph.nodes)) {
      expect(node.position.x + node.size!.width).toBeLessThanOrEqual(group.bounds.x + group.bounds.width);
      expect(node.position.y + node.size!.height).toBeLessThanOrEqual(group.bounds.y + group.bounds.height);
    }
    const plan = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: ids.$window!, kind: "readback" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(collectFileReferences([graph]).map(asset => asset.assetId).sort()).toEqual(["content-video", "depth", "mask", "photo"]);
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(Object.keys(store.view.getGraph().nodes)).toHaveLength(0);
  });

  it("creates an unassigned replaceable movie input for Video mode and keeps provided video idle for other effects", async () => {
    const unassigned = harness();
    const videoMode = await unassigned.bus.execute("photoMapping.create", { ...input, effect: 9 }, contextFor(alice));
    expect(videoMode.status).toBe("applied");
    const graph = unassigned.store.view.getGraph(), ids = videoMode.output.createdIds;
    expect(graph.nodes[ids.$video!]!).toMatchObject({ type: "movieFileIn", parameters: { file: "" } });
    expect(Object.values(graph.edges).find(edge => edge.target.nodeId === ids.$effect && edge.target.portId === "input"))
      .toMatchObject({ source: { nodeId: ids.$video } });
    const plan = compileGraph({ graph, registry: unassigned.registry, settings: unassigned.store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: ids.$window!, kind: "readback" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    const idle = harness();
    const result = await idle.bus.execute("photoMapping.create", { ...input, effect: 3, video: "show.webm" }, contextFor(alice));
    expect(result.status).toBe("applied");
    const idleGraph = idle.store.view.getGraph(), idleIds = result.output.createdIds;
    expect(idleGraph.nodes[idleIds.$video!]!.parameters.file).toBe("show.webm");
    expect(Object.values(idleGraph.edges).find(edge => edge.target.nodeId === idleIds.$effect && edge.target.portId === "input"))
      .toMatchObject({ source: { nodeId: idleIds.$photo } });
    expect(Object.values(idleGraph.edges).some(edge => edge.source.nodeId === idleIds.$video)).toBe(false);
  });

  it("retains a refined map's native parent through normal save/reopen asset collection", async () => {
    const { bus, store, registry } = harness();
    const nativeDepth = createFileReference("native-depth", "binary", "native.loom.exr");
    const depthRecipe = { ...DEFAULT_PHOTO_DEPTH_RECIPE, modelId: "depth-anything-v2-large-q4f16",
      backend: "webgpu" as const, refinement: { ...DEFAULT_DEPTH_REFINEMENT, target: "2048" as const } };
    const result = await bus.execute("photoMapping.create", { ...input, nativeDepth, depthRecipe }, contextFor(alice));
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph();
    const node = graph.nodes[result.output.createdIds.$depth!]!;
    expect(node.parameters.nativeMap).toBe(nativeDepth);
    expect(depthRecipeFromParameters(node.parameters)).toEqual(depthRecipe);
    const assets = collectFileReferences([graph]);
    expect(assets.map(asset => asset.assetId).sort()).toEqual(["depth", "mask", "native-depth", "photo"]);
    const saved = parseProjectDocument(serializeProjectDocument({ schemaVersion: SCHEMA_VERSION,
      projectId: "refined-photo", name: "Refined mapping", graph, settings: store.view.getSettings(), assets,
      createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.document.graph).toEqual(graph);
    const compiled = compileGraph({ graph, registry, settings: store.view.getSettings(), capabilities: testCapabilities(),
      sinks: [{ nodeId: result.output.createdIds.$window!, kind: "output" }] });
    expect(compiled.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
  });

  it("rejects an incomplete refined recipe before graph mutation", async () => {
    const { bus, store } = harness();
    const before = store.view.getGraph();
    const result = await bus.execute("photoMapping.create", { ...input,
      depthRecipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, refinement: DEFAULT_DEPTH_REFINEMENT } }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(store.view.getGraph()).toBe(before);
  });

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
    expect(graph.nodes[ids.$mask!]!).toMatchObject({ type: "floatMapIn", parameters: { file: "", emptySource: "constant", emptyValue: 1, interpretation: "mask" } });
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
      type: "floatMapIn", label: "floatmap_mask1", parameters: { file: "", emptySource: "constant", emptyValue: 1, interpretation: "mask" },
      position: { x: 0, y: 600 }, resolution: { mode: "fixed", width: 800, height: 600 },
    });
    const edges = Object.values(graph.edges);
    expect(edges.filter(edge => edge.target.nodeId === ids.$mask)).toMatchObject([{ source: { nodeId: ids.$photo }, target: { portId: "picture" } }]);
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

  it("saves framing only on the independent preview photo without changing the projector branch", async () => {
    const previewPhoto = createFileReference("preview", "image", "preview.jpg");
    const previewFraming = { x: 0.25, y: 0.8, zoom: 1.7 };
    const baseline = harness();
    const baselineResult = await baseline.bus.execute("photoMapping.create", {
      ...input, previewPhoto, previewFit: "fill",
    }, contextFor(alice));
    expect(baselineResult.status).toBe("applied");
    const { bus, store } = harness();
    const result = await bus.execute("photoMapping.create", {
      ...input, previewPhoto, previewFit: "fill", previewFraming,
    }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.diagnostics).toEqual([]);
    const graph = store.view.getGraph();
    const ids = result.output.createdIds;
    expect(graph.nodes[ids.$previewPhoto!]!.parameters).toMatchObject({
      file: previewPhoto, imageFit: "fill", imageAnchorX: 0.25, imageAnchorY: 0.8, imageZoom: 1.7,
    });
    for (const ref of ["$photo", "$depth", "$mask", "$effect", "$coverage", "$grid", "$corner", "$window", "$reference", "$previz", "$output"]) {
      expect(graph.nodes[ids[ref]!]!.parameters)
        .toEqual(baseline.store.view.getGraph().nodes[baselineResult.output.createdIds[ref]!]!.parameters);
    }
    expect(graph.edges).toEqual(baseline.store.view.getGraph().edges);
    const parsed = parseProjectDocument(serializeProjectDocument({ schemaVersion: SCHEMA_VERSION,
      projectId: "preview-framing", name: "Photo mapping", graph, settings: store.view.getSettings(),
      assets: collectFileReferences([graph]), createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.document.graph).toEqual(graph);
    expect(parsed.document.graph.nodes[ids.$previewPhoto!]!.parameters).toMatchObject({
      imageAnchorX: 0.25, imageAnchorY: 0.8, imageZoom: 1.7,
    });
  });

  it.each([undefined, DEFAULT_IMAGE_FRAMING])("preserves default framing for legacy preview creation: %j", async previewFraming => {
    const { bus, store } = harness();
    const previewPhoto = createFileReference("preview", "image", "preview.jpg");
    const result = await bus.execute("photoMapping.create", {
      ...input, previewPhoto, ...(previewFraming === undefined ? {} : { previewFraming }),
    }, contextFor(alice));
    expect(result.status).toBe("applied");
    const graph = store.view.getGraph();
    const source = graph.nodes[result.output.createdIds.$photo!]!;
    const preview = graph.nodes[result.output.createdIds.$previewPhoto!]!;
    expect(source.parameters).toMatchObject({ imageAnchorX: 0.5, imageAnchorY: 0.5, imageZoom: 1 });
    expect(preview.parameters).toEqual({ ...source.parameters, file: previewPhoto, imageFit: "stretch" });
  });

  it.each([
    { previewPhoto: undefined, previewFraming: DEFAULT_IMAGE_FRAMING },
    { previz: false, previewFraming: DEFAULT_IMAGE_FRAMING },
    { previewFraming: { x: 1.01, y: 0.5, zoom: 1 } },
    { previewFraming: { x: 0.5, y: -0.01, zoom: 1 } },
    { previewFraming: { x: 0.5, y: 0.5, zoom: 0.99 } },
    { previewFraming: { x: 0.5, y: 0.5, zoom: 8.01 } },
    { previewFraming: { x: NaN, y: 0.5, zoom: 1 } },
    { previewFraming: { x: 0.5, y: 0.5, zoom: Infinity } },
    { previewFraming: { x: 0.5, y: 0.5, zoom: 1, rotation: 0 } },
    { previewFraming: { x: 0.5, y: 0.5 } },
  ])("rejects invalid preview framing atomically: %j", async change => {
    const { bus, store } = harness();
    await bus.execute("photoMapping.create", input, contextFor(alice));
    const before = store.view.getGraph();
    const result = await bus.execute("photoMapping.create", {
      ...input, previewPhoto: createFileReference("preview", "image", "preview.jpg"), ...change,
    } as PhotoMappingCreateInput, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.output.appliedOperations).toBe(0);
    expect(result.diagnostics.some(diagnostic => diagnostic.severity === "error")).toBe(true);
    expect(store.view.getGraph()).toBe(before);
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
