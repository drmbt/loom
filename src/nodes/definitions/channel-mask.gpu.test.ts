import { beforeAll, describe, expect, it } from "vitest";
import type { ChannelMask, GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import { componentNodeType, createComponentSystem } from "../../domain/components/index.ts";
import { allNodeDefinitions } from "./index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../tests/headless/pixel-compare.ts";

const SIZE = { width: 8, height: 4 };
const settings: ProjectSettings = { outputResolution: SIZE, workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" }, randomSeed: 1, previewLongEdge: 64, previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 1 << 28, memoryBudgetBytes: 1 << 30 } };
const RGB: ChannelMask = { r: true, g: true, b: true, a: false };
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type, definitionVersion: 1, parameters: {}, position: { x: 0, y: 0 }, ...extra });
const solid = (id: string, color: number[]) => node(id, "solid", { parameters: { color } });
function graph(nodes: GraphNode[], connections: readonly [string, string, string, string][]): GraphDocument {
  return { revision: 1, nodes: Object.fromEntries(nodes.map(entry => [entry.id, entry])), groups: {},
    edges: Object.fromEntries(connections.map(([from, output, to, input], i) =>
      [`e${i}`, { id: `e${i}`, source: { nodeId: from, portId: output }, target: { nodeId: to, portId: input } }])) };
}
let dawnError: string | undefined;
beforeAll(async () => { dawnError = (await probeDawn()).error; }, 60_000);

async function pixels(document: GraphDocument, frames = 1, components?: ReturnType<typeof createComponentSystem>["components"]) {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const rendered = await renderHeadless({ host: nodeGpuHost(), graph: document, settings, frames,
    capture: Array.from({ length: frames }, (_, index) => index), animate: frames > 1,
    ...(components === undefined ? {} : { components: components.view() }), outputNodeId: "out" });
  expect(rendered.diagnostics.filter(entry => entry.severity === "error")).toEqual([]);
  return rendered.frames.map(frame => decodeComponents(frame.bytes, frame.format));
}
function everyPixel(actual: ArrayLike<number>, expected: number[]) {
  expect(actual.length).toBe(SIZE.width * SIZE.height * 4);
  for (let pixel = 0; pixel < SIZE.width * SIZE.height; pixel += 1) {
    expect(Array.from({ length: 4 }, (_, channel) => actual[pixel * 4 + channel]), `pixel ${pixel}`).toEqual(expected);
  }
}

describe("Common processing channels, actual GPU outputs", () => {
  it("keeps first-input alpha while Add changes RGB, and Over consumes the preserved coverage", async () => {
    const source = graph([solid("front", [1, 0, 0, 0.25]), solid("back", [0, 0, 1, 0.5]),
      node("add", "add", { channelMask: RGB }), node("out", "output")], [
      ["front", "out", "add", "in1"], ["back", "out", "add", "in2"], ["add", "out", "out", "input"],
    ]);
    everyPixel((await pixels(source))[0]!, [1, 0, 1, 0.25]);
    const composed = graph([...Object.values(source.nodes).filter(entry => entry.id !== "out"), solid("ground", [0, 0, 1, 1]),
      node("over", "over"), node("out", "output")], [
      ["front", "out", "add", "in1"], ["back", "out", "add", "in2"], ["add", "out", "over", "in1"],
      ["ground", "out", "over", "in2"], ["over", "out", "out", "input"],
    ]);
    everyPixel((await pixels(composed))[0]!, [0.25, 0, 1, 1]);
  }, 120_000);

  it("preserves disabled RGB and uses explicit generator neutral channels", async () => {
    const input = graph([solid("front", [1, 0, 0, 0.25]), solid("back", [0, 0, 1, 0.5]),
      node("add", "add", { channelMask: { r: false, g: false, b: false, a: true } }), node("out", "output")], [
      ["front", "out", "add", "in1"], ["back", "out", "add", "in2"], ["add", "out", "out", "input"],
    ]);
    everyPixel((await pixels(input))[0]!, [1, 0, 0, 0.75]);
    const generated = graph([node("src", "solid", { parameters: { color: [1, 0, 1, 0.25] },
      channelMask: { r: false, g: true, b: false, a: false } }), node("out", "output")], [["src", "out", "out", "input"]]);
    everyPixel((await pixels(generated))[0]!, [0, 0, 0, 1]);
  }, 120_000);

  it("stores final masked Feedback history in the public ping-pong pair", async () => {
    const document = graph([solid("src", [1, 0, 0, 0.25]), node("feedback", "feedback", { channelMask: RGB,
      parameters: { persistence: 0.5, clearColor: [0, 0, 0, 0] } }), node("out", "output")],
      [["src", "out", "feedback", "in"], ["feedback", "out", "out", "input"]]);
    const result = await pixels(document, 3);
    everyPixel(result[0]!, [0, 0, 0, 0]);
    everyPixel(result[1]!, [0.5, 0, 0, 0.25]);
    everyPixel(result[2]!, [0.5, 0, 0, 0.25]);
  }, 120_000);

  it("masks a component boundary without changing its internal processing", async () => {
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
    const definition: GraphComponentDefinition = { componentId: "channels", version: 1, name: "Channels",
      graph: graph([node("add", "add")], []), parameters: [],
      inputs: [{ externalId: "front", label: "Front", nodeId: "add", portId: "in1" },
        { externalId: "back", label: "Back", nodeId: "add", portId: "in2" }],
      outputs: [{ externalId: "out", label: "Out", nodeId: "add", portId: "out" }] };
    system.components.register(definition);
    const document = graph([solid("front", [1, 0, 0, 0.25]), solid("back", [0, 0, 1, 0.5]),
      node("component", componentNodeType("channels", 1), { channelMask: RGB }), node("out", "output")], [
      ["front", "out", "component", "front"], ["back", "out", "component", "back"], ["component", "out", "out", "input"],
    ]);
    everyPixel((await pixels(document, 1, system.components))[0]!, [1, 0, 1, 0.25]);
  }, 120_000);
});
