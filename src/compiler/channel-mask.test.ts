import { describe, expect, it } from "vitest";
import type { ChannelMask, GraphDocument, GraphNode } from "../domain/types/graph.ts";
import { DEFAULT_CHANNEL_MASK } from "../domain/types/graph.ts";
import { graphNodeSchema } from "../domain/types/schemas.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { componentNodeType, createComponentSystem } from "../domain/components/index.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import { flattenComponents } from "./flatten.ts";
import type { EffectPassDescriptor } from "../runtime/backend/plan.ts";
import { compileGraph } from "./compile.ts";
import { prepareFrameCompiler } from "./frame-compile.ts";
import { testCapabilities, testSettings } from "./test-support.ts";

const registry = createNodeRegistry(allNodeDefinitions).view();
const RGB: ChannelMask = { r: true, g: true, b: true, a: false };
const settings = { ...testSettings(), colorPolicy: { workingSpace: "linear", displayTransform: "none" } as const };
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type, definitionVersion: 1, parameters: {}, position: { x: 0, y: 0 }, ...extra });
function graph(nodes: GraphNode[], connections: readonly [string, string, string, string][]): GraphDocument {
  return { revision: 1, nodes: Object.fromEntries(nodes.map(entry => [entry.id, entry])), groups: {},
    edges: Object.fromEntries(connections.map(([from, output, to, input], i) =>
      [`e${i}`, { id: `e${i}`, source: { nodeId: from, portId: output }, target: { nodeId: to, portId: input } }])) };
}
const compile = (document: GraphDocument) => compileGraph({ graph: document, settings, registry, capabilities: testCapabilities() });

describe("Common processing channels", () => {
  it("keeps absent and all-enabled plans byte-identical", () => {
    const document = graph([node("src", "solid"), node("out", "output")], [["src", "out", "out", "input"]]);
    const before = compile(document);
    const after = compile({ ...document, nodes: { ...document.nodes, src: { ...document.nodes.src!, channelMask: DEFAULT_CHANNEL_MASK } } });
    expect(after).toEqual(before);
  });

  it("keeps downstream, preview and exported output identities public", () => {
    const document = graph([node("src", "solid"), node("add", "add", { channelMask: RGB }), node("out", "output")],
      [["src", "out", "add", "in1"], ["src", "out", "add", "in2"], ["add", "out", "out", "input"]]);
    const result = compile(document);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const output = result.outputs.find(entry => entry.nodeId === "add")!;
    const processed = `${output.resourceId}:channel-process`;
    const passes = result.passes as readonly EffectPassDescriptor[];
    const operation = passes.find(pass => pass.nodeId === "add" && pass.target === processed)!;
    const mask = passes.find(pass => pass.id === "add:channel-mask:out")!;
    expect(operation.target).toBe(processed);
    expect(mask.target).toBe(output.resourceId);
    expect(mask.textures).toEqual([
      { binding: "processedTexture", resourceId: processed, sampled: "unfiltered" },
      { binding: "preservedTexture", resourceId: result.outputs.find(entry => entry.nodeId === "src")!.resourceId, sampled: "filtered" },
    ]);
    const sink = passes.find(pass => pass.nodeId === "out")!;
    expect(sink.textures).toEqual(expect.arrayContaining([expect.objectContaining({ resourceId: output.resourceId })]));
    expect(result.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: processed, kind: "target" })]));
  });

  it("uses generator neutral channels rather than uninitialized storage", () => {
    const result = compile(graph([node("src", "solid", { channelMask: { r: false, g: true, b: true, a: false } }), node("out", "output")],
      [["src", "out", "out", "input"]]));
    expect(result.ok).toBe(true);
    const mask = result.passes.find(pass => (pass as { id: string }).id === "src:channel-mask:out") as EffectPassDescriptor;
    expect(mask.shader).toContain("let preserved = vec4f(0.0, 0.0, 0.0, 1.0)");
    expect(mask.textures).toHaveLength(1);
  });

  it("takes the first connected declared texture port rather than sorted edge IDs", () => {
    const document = graph([node("a", "solid"), node("b", "solid"), node("blend", "add", { channelMask: RGB }), node("out", "output")],
      [["b", "out", "blend", "in2"], ["a", "out", "blend", "in1"], ["blend", "out", "out", "input"]]);
    const result = compile(document);
    expect(result.ok).toBe(true);
    const mask = result.passes.find(pass => (pass as { id: string }).id === "blend:channel-mask:out") as EffectPassDescriptor;
    expect(mask.textures).toEqual(expect.arrayContaining([expect.objectContaining({ binding: "preservedTexture", resourceId: "target:a:out" })]));
  });

  it("writes final masked Feedback history before swapping the public pair", () => {
    const result = compile(graph([node("src", "solid"), node("delay", "feedback", { channelMask: RGB }), node("out", "output")],
      [["src", "out", "delay", "in"], ["delay", "out", "out", "input"]]));
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const output = result.outputs.find(entry => entry.nodeId === "delay")!;
    const passes = result.passes as readonly EffectPassDescriptor[];
    expect(passes.find(pass => pass.nodeId === "delay" && pass.target === `${output.resourceId}:channel-process`)!.target).toBe(`${output.resourceId}:channel-process`);
    expect(passes.find(pass => pass.id === "delay:channel-mask:out")!.target).toBe(output.resourceId);
    expect(passes.findIndex(pass => pass.id === "delay:channel-mask:out")).toBeLessThan(result.passes.findIndex(pass => pass.kind === "swap" && pass.resourceId === output.resourceId));
    expect(result.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: output.resourceId, kind: "pingPong" })]));
  });

  it("does not modify Cache's stored input ring", () => {
    const document = graph([node("src", "solid"), node("cache", "cache"), node("out", "output")],
      [["src", "out", "cache", "input"], ["cache", "out", "out", "input"]]);
    const before = compile(document);
    const after = compile({ ...document, nodes: { ...document.nodes, cache: { ...document.nodes.cache!, channelMask: RGB } } });
    expect(after.ok).toBe(true);
    const findWrite = (passes: typeof before.passes) => passes.find(pass => (pass as { id: string }).id === "cache:cache-write");
    expect(findWrite(after.passes)).toEqual(findWrite(before.passes));
    expect(after.passes).toHaveLength(before.passes.length + 1);
  });

  it("keeps a masked Null alias as its semantic identity without extra resources or passes", () => {
    const document = graph([node("src", "solid"), node("wire", "null", { channelMask: RGB }), node("out", "output")],
      [["src", "out", "wire", "in"], ["wire", "out", "out", "input"]]);
    const result = compile(document);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.passes.some(pass => (pass as { nodeId: string }).nodeId === "wire")).toBe(false);
    expect(result.outputs.find(entry => entry.nodeId === "wire")!.resourceId).toBe(result.outputs.find(entry => entry.nodeId === "src")!.resourceId);
  });

  it("retains processed pass IDs during uniform-only animation", () => {
    const document = graph([node("src", "solid", { channelMask: RGB, parameters: {
      "color.r": { mode: "expression", bindings: { expression: { kind: "expression", source: "time" } } },
    } }), node("out", "output")], [["src", "out", "out", "input"]]);
    const request = { graph: document, settings, registry, capabilities: testCapabilities() };
    const prepared = prepareFrameCompiler(request);
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);
    const resolution = { frame: { timeSeconds: 0.5, deltaSeconds: 1 / 60, frameIndex: 30, mode: "offline" as const, randomSeed: 1 } };
    const spliced = prepared.compileFrame(resolution);
    expect(spliced, prepared.reason ?? "").not.toBeNull();
    expect(spliced!.passes).toEqual(compileGraph({ ...request, resolution }).passes);
  });

  it("rejects a masked output with no actual render pass", () => {
    const silent: NodeDefinition = { ...registry.require("solid"), type: "silent", compile: () => ({ passes: [] }) };
    const local = createNodeRegistry([...allNodeDefinitions, silent]).view();
    const result = compileGraph({ graph: graph([node("src", "silent", { channelMask: RGB }), node("out", "output")],
      [["src", "out", "out", "input"]]), settings, registry: local, capabilities: testCapabilities() });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(d => d.code === "node.channelMask.unwritten")).toBe(true);
    expect(result.passes.some(pass => (pass as { id: string }).id === "src:channel-mask:out")).toBe(false);
  });

  it("validates persisted masks strictly and accepts older documents", () => {
    expect(graphNodeSchema.safeParse(node("src", "solid")).success).toBe(true);
    expect(graphNodeSchema.parse(node("src", "solid", { channelMask: RGB })).channelMask).toEqual(RGB);
    expect(graphNodeSchema.safeParse(node("src", "solid", { channelMask: { ...RGB, a: 0 } as never })).success).toBe(false);
    expect(graphNodeSchema.safeParse(node("src", "solid", { channelMask: { r: true } as never })).success).toBe(false);
  });

  it("wraps component outputs without modifying internal consumers, including nesting and multiple outputs", () => {
    const system = createComponentSystem(registry);
    const inner: GraphComponentDefinition = { componentId: "masked", version: 1, name: "Masked",
      graph: graph([node("add", "add"), node("inside", "null")], [["add", "out", "inside", "in"]]),
      inputs: [
        { externalId: "front", label: "Front", nodeId: "add", portId: "in1" },
        { externalId: "back", label: "Back", nodeId: "add", portId: "in2" },
      ],
      outputs: [
        { externalId: "processed", label: "Processed", nodeId: "add", portId: "out" },
        { externalId: "internal", label: "Internal", nodeId: "inside", portId: "out" },
      ], parameters: [] };
    system.components.register(inner);
    const innerNode = node("inner", componentNodeType("masked", 1), { channelMask: RGB });
    const outer: GraphComponentDefinition = { componentId: "nested", version: 1, name: "Nested",
      graph: graph([innerNode], []), inputs: [
        { externalId: "front", label: "Front", nodeId: "inner", portId: "front" },
        { externalId: "back", label: "Back", nodeId: "inner", portId: "back" },
      ], outputs: [
        { externalId: "processed", label: "Processed", nodeId: "inner", portId: "processed" },
        { externalId: "internal", label: "Internal", nodeId: "inner", portId: "internal" },
      ], parameters: [] };
    system.components.register(outer);
    const document = graph([node("a", "solid"), node("b", "solid"), node("c", componentNodeType("nested", 1), { channelMask: { r: false, g: true, b: true, a: true } }),
      node("out", "output"), node("out2", "output")], [
      ["b", "out", "c", "back"], ["a", "out", "c", "front"], ["c", "processed", "out", "input"], ["c", "internal", "out2", "input"],
    ]);
    const flattened = flattenComponents({ graph: document, registry: system.nodes, components: system.components.view() });
    expect(flattened.diagnostics).toEqual([]);
    expect(flattened.graph.nodes["c/inner/add"]!.channelMask).toBeUndefined();
    const result = compileGraph({ graph: document, settings, registry: system.nodes, components: system.components.view(), capabilities: testCapabilities() });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.passes.filter(pass => pass.kind === "effect" && pass.label === "Processing Channels")).toHaveLength(4);
    const outerMask = result.passes.find(pass => pass.kind === "effect" && pass.nodeId === "c/$channels:processed") as EffectPassDescriptor;
    expect(outerMask.textures).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: "preservedTexture", resourceId: "target:a:out" }),
      expect.objectContaining({ binding: "processedTexture", resourceId: "target:c/inner/$channels:processed:out" }),
    ]));
    const innerMask = result.passes.find(pass => pass.kind === "effect" && pass.nodeId === "c/inner/$channels:processed") as EffectPassDescriptor;
    expect(innerMask.textures).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: "preservedTexture", resourceId: "target:a:out" }),
    ]));
    expect(registry.has("compiler:channel-mask:c/$channels:processed")).toBe(false);
    expect(inner.graph.nodes.add!.channelMask).toBeUndefined();
  });

  it("adds no synthetic component boundary when all channels are enabled", () => {
    const system = createComponentSystem(registry);
    system.components.register({ componentId: "plain", version: 1, name: "Plain", graph: graph([node("src", "solid")], []),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "src", portId: "out" }], parameters: [] });
    const document = graph([node("c", componentNodeType("plain", 1), { channelMask: DEFAULT_CHANNEL_MASK }), node("out", "output")], [["c", "out", "out", "input"]]);
    const flattened = flattenComponents({ graph: document, registry: system.nodes, components: system.components.view() });
    expect(flattened.compilerDefinitions).toBeUndefined();
    expect(Object.keys(flattened.graph.nodes)).toEqual(["c/src", "out"]);
  });

  it("projects a nested component mask override before flattening its boundary", () => {
    const system = createComponentSystem(registry);
    system.components.register({ componentId: "inner", version: 1, name: "Inner", graph: graph([node("src", "solid")], []),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "src", portId: "out" }], parameters: [] });
    system.components.register({ componentId: "outer", version: 1, name: "Outer", graph: graph([node("inner", componentNodeType("inner", 1))], []),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }], parameters: [] });
    const document = graph([node("c", componentNodeType("outer", 1), { state: { componentChannelMaskOverrides: { inner: RGB } } }), node("out", "output")],
      [["c", "out", "out", "input"]]);
    const result = compileGraph({ graph: document, settings, registry: system.nodes, components: system.components.view(), capabilities: testCapabilities() });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.passes.filter(pass => pass.kind === "effect" && pass.label === "Processing Channels")).toHaveLength(1);
    expect(result.passes.some(pass => pass.kind === "effect" && pass.nodeId === "c/inner/$channels:out")).toBe(true);
    expect(system.components.view().get("outer", 1)!.graph.nodes.inner!.channelMask).toBeUndefined();
  });

  it("processes every materialized output of a multi-output image node", () => {
    const multi: NodeDefinition = { ...registry.require("solid"), type: "multi", outputs: [
      { id: "first", label: "First", type: { kind: "texture2d", sample: "float", channels: 4 } },
      { id: "second", label: "Second", type: { kind: "texture2d", sample: "float", channels: 4 } },
    ], compile(raw) {
      const context = raw as import("./types.ts").CompilerNodeContext;
      return { passes: Object.values(context.outputs).map(output => ({ kind: "effect", target: output.resourceId,
        shader: "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }" })) };
    } };
    const local = createNodeRegistry([...allNodeDefinitions, multi]).view();
    const document = graph([node("src", "multi", { channelMask: RGB }), node("out", "output"), node("out2", "output")],
      [["src", "first", "out", "input"], ["src", "second", "out2", "input"]]);
    const result = compileGraph({ graph: document, settings, registry: local, capabilities: testCapabilities() });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.passes.filter(pass => pass.kind === "effect" && pass.nodeId === "src" && pass.label === "Processing Channels")).toHaveLength(2);
  });
});
