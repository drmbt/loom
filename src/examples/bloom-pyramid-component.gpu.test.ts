import { beforeAll, describe, expect, it } from "vitest";
import { createComponentSystem } from "../domain/components/index.ts";
import { loadProject } from "../domain/project/load.ts";
import { buildProjectFile } from "../domain/project/project-file.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../domain/types/graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { decodeToLinear } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { flattenComponents } from "../compiler/index.ts";
import { renderHeadless, type RenderedFrame } from "../tests/headless/render-harness.ts";
import { createAppRuntime } from "../app/app-runtime.ts";
import { listStarterComponentFiles } from "./catalogue.ts";
import { edge, graph, named, settings } from "./documents/builders.ts";

// Odd dimensions intentionally retain the historical per-level rounding: Bright is
// 97×55 and Glow is 112×64. Comparing only power-of-two sizes would miss that contract.
const SIZE = { width: 193, height: 109 };
const registry = createNodeRegistry(allNodeDefinitions).view();
let definition: GraphComponentDefinition;

beforeAll(async () => {
  const probe = await probeDawn();
  if (probe.error !== undefined) throw new Error(`Dawn unavailable: ${probe.error}`);
  const file = listStarterComponentFiles().find(each => each.fileName === "Bloom-Pyramid.loom.json");
  if (file === undefined) throw new Error("Bloom-Pyramid.loom.json is not shipped");
  const system = createComponentSystem(registry);
  const loaded = loadProject(file.text, { nodes: system.nodes, components: system.components });
  if (!loaded.ok) throw new Error(`Shipped Bloom Pyramid refused: ${loaded.reason}`);
  const found = loaded.components.find(each => each.componentId === "bloomPyramid");
  if (found === undefined) throw new Error("Shipped file has no Bloom Pyramid definition");
  definition = found;
}, 60_000);

const HDR_SOURCE = `struct Params {
  boost: f32, // @default 1
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let red = (uv - vec2f(0.3, 0.45)) * vec2f(15.0, 11.0);
  let blue = (uv - vec2f(0.68, 0.6)) * vec2f(24.0, 14.0);
  let spark = select(vec3f(0.0), vec3f(90.0, 45.0, 3.0),
    abs(uv.x - 0.505) < 0.009 && abs(uv.y - 0.3) < 0.015);
  return vec4f((base + vec3f(0.08, 0.12, 0.18) + exp(-dot(red, red)) * vec3f(10.0, 1.0, 0.35)
    + exp(-dot(blue, blue)) * vec3f(0.25, 2.0, 7.0) + spark) * params.boost, 1.0);
}`;

// Frozen pre-extraction equations, independent of bloomPyramidGraph and the production
// shader module. The reference is the old ordinary nine-node chain, not another call to
// the implementation under test. All three kernels retain their historical HDR math.
const LEGACY_INPUT = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;`;
const LEGACY_BRIGHT = `struct Params { threshold: f32, knee: f32, };
${LEGACY_INPUT}
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let brightness = max(color.r, max(color.g, color.b));
  let soft = clamp(brightness - params.threshold + params.knee, 0.0, 2.0 * params.knee);
  let weight = max(soft * soft / (4.0 * params.knee + 1e-4), brightness - params.threshold) / max(brightness, 1e-4);
  return vec4f(color * weight, 1.0);
}`;
const LEGACY_DOWN = `struct Params { clampLuma: f32, };
${LEGACY_INPUT}
fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb; }
fn karis(c: vec3f) -> f32 { return select(1.0, 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722))), params.clampLuma > 0.0); }
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(inputTexture));
  let a = tap(uv + t * vec2f(-2.0, -2.0)); let b = tap(uv + t * vec2f(0.0, -2.0)); let c = tap(uv + t * vec2f(2.0, -2.0));
  let d = tap(uv + t * vec2f(-2.0, 0.0)); let e = tap(uv); let f = tap(uv + t * vec2f(2.0, 0.0));
  let g = tap(uv + t * vec2f(-2.0, 2.0)); let h = tap(uv + t * vec2f(0.0, 2.0)); let i = tap(uv + t * vec2f(2.0, 2.0));
  let j = tap(uv + t * vec2f(-1.0, -1.0)); let k = tap(uv + t * vec2f(1.0, -1.0));
  let l = tap(uv + t * vec2f(-1.0, 1.0)); let m = tap(uv + t * vec2f(1.0, 1.0));
  let b0 = (j + k + l + m) * 0.25; let b1 = (a + b + d + e) * 0.25;
  let b2 = (b + c + e + f) * 0.25; let b3 = (d + e + g + h) * 0.25; let b4 = (e + f + h + i) * 0.25;
  let w0 = 0.5 * karis(b0); let w1 = 0.125 * karis(b1); let w2 = 0.125 * karis(b2);
  let w3 = 0.125 * karis(b3); let w4 = 0.125 * karis(b4);
  let sum = (b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + b4 * w4) / max(w0 + w1 + w2 + w3 + w4, 1e-6);
  return vec4f(sum, 1.0);
}`;
const LEGACY_UP = `struct Params { radius: f32, lower: f32, };
${LEGACY_INPUT}
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.radius / vec2f(textureDimensions(inputTexture));
  var wide = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb * 4.0;
  wide = wide + (textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-t.x, 0.0), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(t.x, 0.0), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(0.0, -t.y), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  wide = wide + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-t.x, -t.y), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(t.x, -t.y), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(-t.x, t.y), 0.0).rgb
    + textureSampleLevel(inputTexture, inputSampler, uv + vec2f(t.x, t.y), 0.0).rgb;
  let size = vec2f(textureDimensions(inputTexture1));
  let own = textureLoad(inputTexture1, clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1)), 0).rgb;
  return vec4f(mix(own, wide / 16.0, params.lower * 0.5), 1.0);
}`;

interface Controls { threshold: number; knee: number; radius: number; spread: number; fireflyFilter: number }
const DEFAULT: Controls = { threshold: 1.2, knee: 0.8, radius: 1, spread: 1, fireflyFilter: 1 };
const FLOAT = { mode: "fixed", format: "rgba16float" } as const;

function sourceNodes(format: "rgba8unorm" | "rgba16float" = "rgba16float"): GraphNode[] {
  return [
    named("seed", "solid", [0, 0], { color: [0, 0, 0, 1] }, { id: "seed" }),
    named("plate", "customWgsl", [200, 0], { source: HDR_SOURCE, boost: 1 }, { id: "plate", format: { mode: "fixed", format } }),
  ];
}

function legacy(controls: Controls): GraphDocument {
  const nodes = sourceNodes();
  const edges: GraphEdge[] = [edge("seed-plate", ["seed", "out"], ["plate", "input"]), edge("plate-bright", ["plate", "out"], ["bright", "input"])];
  nodes.push(named("bright", "customWgsl", [400, 0], { source: LEGACY_BRIGHT, threshold: controls.threshold, knee: controls.knee }, { id: "bright", format: FLOAT, resolution: { mode: "scale", factor: 0.5 } }));
  for (let level = 1; level <= 4; level += 1) {
    nodes.push(named(`down${level}`, "customWgsl", [600, level * 100], { source: LEGACY_DOWN, clampLuma: level === 1 ? controls.fireflyFilter : 0 }, { id: `down${level}`, format: FLOAT, resolution: { mode: "scale", factor: 0.5 } }));
    edges.push(edge(`down${level}`, [level === 1 ? "bright" : `down${level - 1}`, "out"], [`down${level}`, "input"]));
  }
  for (let level = 0; level <= 3; level += 1) {
    nodes.push(named(`up${level}`, "customWgslMulti", [800, level * 100], { source: LEGACY_UP, radius: controls.radius, lower: controls.spread }, { id: `up${level}`, format: FLOAT, resolution: { mode: "scale", factor: 2 } }));
    edges.push(edge(`up${level}-lower`, [level === 3 ? "down4" : `up${level + 1}`, "out"], [`up${level}`, "input"]));
    edges.push(edge(`up${level}-own`, [level === 0 ? "bright" : `down${level}`, "out"], [`up${level}`, "more"], 0));
  }
  return graph(nodes, edges);
}

/** Instantiate through the command bus, then save/reload with the embedded shipped library. */
async function instantiated(controls: Controls, byteHost = false) {
  const projectSettings = settings({ outputResolution: SIZE, workingFormat: byteHost ? "rgba8unorm" : "rgba16float" });
  const runtime = createAppRuntime({ identityStorage: null, components: [definition], settings: projectSettings });
  try {
    const sources = sourceNodes(byteHost ? "rgba8unorm" : "rgba16float");
    const added = await runtime.bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
      ...sources.map(source => ({ op: "addNode" as const, ref: source.id, type: source.type, position: source.position, parameters: source.parameters, label: source.label! })),
      { op: "connect", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "plate", portId: "input" } },
    ] }, runtime.invocation);
    expect(added.status).toBe("applied");
    const placed = await runtime.bus.execute("component.instantiate", { componentId: definition.componentId, version: definition.version }, runtime.invocation);
    expect(placed.status).toBe("applied");
    const id = placed.output.nodeId!;
    const wired = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
      { op: "setParameters", nodeId: id, parameters: { ...controls } },
      { op: "connect", source: { nodeId: "plate", portId: "out" }, target: { nodeId: id, portId: "picture" } },
    ] }, runtime.invocation);
    expect(wired.status).toBe("applied");
    // addNode does not carry Common overrides; author the HDR source through its normal command.
    expect((await runtime.bus.execute("node.setFormat", { nodeId: "plate", format: { mode: "fixed", format: byteHost ? "rgba8unorm" : "rgba16float" } }, runtime.invocation)).status).toBe("applied");
    const saved = buildProjectFile({ document: runtime.projectDocument(), components: [definition] });
    const system = createComponentSystem(registry);
    const loaded = loadProject(saved.text, { nodes: system.nodes, components: system.components });
    if (!loaded.ok) throw new Error(`Instantiated Bloom Pyramid refused on reload: ${loaded.reason}`);
    expect(loaded.placeholders).toEqual([]);
    return { graph: loaded.document.graph, settings: projectSettings, components: system.components.view(), registry: system.nodes, id };
  } finally { runtime.dispose(); }
}

async function capture(input: Awaited<ReturnType<typeof instantiated>>, port: "out" | "bright"): Promise<RenderedFrame> {
  // The harness reads materialized rows, while public component ports map to their inner
  // endpoints. Resolve the SHIPPED public socket through the compiler's own mapping.
  const flattened = flattenComponents({ graph: input.graph, registry: input.registry, components: input.components });
  const endpoint = flattened.instanceOutputs.get(input.id)?.get(port);
  if (endpoint === undefined) throw new Error(`Bloom Pyramid has no public ${port} output`);
  const result = await renderHeadless({ host: nodeGpuHost(), graph: input.graph, settings: input.settings, components: input.components,
    outputNodeId: endpoint.nodeId, outputPortId: endpoint.portId, sinks: [{ nodeId: input.id, portId: "out" }, { nodeId: input.id, portId: "bright" }], frames: 1, capture: [0], strict: true });
  expect(result.diagnostics.filter(each => each.severity === "error")).toEqual([]);
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("Bloom Pyramid captured no frame");
  return frame;
}

function pixels(frame: RenderedFrame): Float32Array {
  return decodeToLinear({ ...frame, rowStride: frame.width * BYTES_PER_PIXEL[frame.format] }, "linear").rgba;
}
function energy(frame: RenderedFrame): number {
  return pixels(frame).reduce((sum, value, index) => sum + (index % 4 === 3 ? 0 : value), 0);
}
function peak(frame: RenderedFrame): number {
  return pixels(frame).reduce((max, value, index) => index % 4 === 3 ? max : Math.max(max, value), 0);
}

describe("the shipped Bloom Pyramid renders its legacy HDR graph", () => {
  it("reproduces Glow and Bright exactly after instantiate/save/reload on an odd-sized colored HDR plate", async () => {
    const controls = { ...DEFAULT, threshold: 1.5, knee: 0.35, radius: 1.2, spread: 1.4, fireflyFilter: 0 };
    const component = await instantiated(controls);
    for (const port of ["out", "bright"] as const) {
      const actual = await capture(component, port);
      const expected = await renderHeadless({ host: nodeGpuHost(), graph: legacy(controls), settings: component.settings,
        outputNodeId: port === "out" ? "up0" : "bright", sinks: [{ nodeId: "up0", portId: "out" }, { nodeId: "bright", portId: "out" }], frames: 1, capture: [0], strict: true });
      const frame = expected.frames[0];
      if (frame === undefined) throw new Error("Legacy bloom captured no frame");
      expect([actual.width, actual.height]).toEqual(port === "out" ? [112, 64] : [97, 55]);
      expect(actual.format).toBe("rgba16float");
      expect(actual.bytes).toEqual(frame.bytes);
      expect(peak(actual)).toBeGreaterThan(1);
    }
  });

  it("responds to spread, radius and firefly filtering, and keeps floating targets on a byte-format host", async () => {
    const baseline = await capture(await instantiated(DEFAULT), "out");
    const wider = await capture(await instantiated({ ...DEFAULT, spread: 2 }), "out");
    const softer = await capture(await instantiated({ ...DEFAULT, radius: 3 }), "out");
    const unfiltered = await capture(await instantiated({ ...DEFAULT, fireflyFilter: 0 }), "out");
    expect(wider.bytes).not.toEqual(baseline.bytes);
    expect(softer.bytes).not.toEqual(baseline.bytes);
    expect(unfiltered.bytes).not.toEqual(baseline.bytes);
    expect(peak(wider)).toBeLessThan(peak(baseline));
    expect(peak(softer)).toBeLessThan(peak(baseline));
    expect(energy(unfiltered)).toBeGreaterThan(energy(baseline));
    const byteHost = await capture(await instantiated({ ...DEFAULT, threshold: 0, knee: 0.001 }, true), "out");
    expect(byteHost.format).toBe("rgba16float");
    expect(energy(byteHost)).toBeGreaterThan(0);
  });
});
