import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";

/**
 * T1365b on a REAL device: Custom WGSL reads more than one image. Two solids of known colour
 * reach Input and More; the shader returns More's first minus Input, so each output channel is
 * a difference only BOTH bindings can produce — exact bytes (§V147). The refusal: a source
 * that declares `inputTexture2` with nothing on More is refused by name.
 */

const SETTINGS: ProjectSettings = {
  outputResolution: { width: 16, height: 16 },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const TWO_INPUTS = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let a = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let b = textureLoad(inputTexture1, vec2i(uv * vec2f(textureDimensions(inputTexture1))), 0);
  return vec4f(b.rgb - a.rgb, 1.0);
}`;

function graph(source: string, wireSecond: boolean): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters });
  return {
    revision: 1,
    nodes: {
      // Linear values on an rgba8unorm project: 0.2 and 0.9 in, 0.7 out.
      a: node("a", "solid", { color: [0.2, 0.2, 0.2, 1] }),
      b: node("b", "solid", { color: [0.9, 0.5, 0.2, 1] }),
      fx: node("fx", "customWgslMulti", { source }),
      out: node("out", "output", {}),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      ...(wireSecond ? { e2: { id: "e2", source: { nodeId: "b", portId: "out" }, target: { nodeId: "fx", portId: "more" } } } : {}),
      e3: { id: "e3", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

/*
 * VN139: all fifteen More inputs, in edge order. Each input is a black or a white solid, and
 * the shader writes input k as bit k of the output: inputs 1..8 are red's eight bits, 9..15
 * are green's low seven. Only fifteen bindings, each reading its own edge, spell the pattern.
 */
const PATTERN = [1, 0, 1, 1, 0, 0, 1, 0, /* red 0b01001101 */ 0, 1, 1, 0, 1, 0, 1 /* green 0b1010110 */];
const FIFTEEN_INPUTS = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
${PATTERN.map((_, k) => `@group(0) @binding(${k + 4}) var inputTexture${k + 1}: texture_2d<f32>;`).join("\n")}

fn bit(t: texture_2d<f32>) -> f32 { return textureLoad(t, vec2i(0, 0), 0).r; }

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let keep = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).a;
  let red = ${PATTERN.slice(0, 8).map((_, k) => `bit(inputTexture${k + 1}) * ${2 ** k}.0`).join(" + ")};
  let green = ${PATTERN.slice(8).map((_, k) => `bit(inputTexture${k + 9}) * ${2 ** k}.0`).join(" + ")};
  return vec4f(red / 255.0, green / 255.0, 0.0, keep);
}`;

function fifteenGraph(): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters });
  const edge = (id: string, source: string, target: string, portId: string) => ({ id, source: { nodeId: source, portId: "out" }, target: { nodeId: target, portId } });
  return {
    revision: 1,
    nodes: {
      a: node("a", "solid", { color: [0, 0, 0, 1] }),
      ...Object.fromEntries(PATTERN.map((on, k) => [`s${k + 1}`, node(`s${k + 1}`, "solid", { color: [on, on, on, 1] })])),
      fx: node("fx", "customWgslMulti", { source: FIFTEEN_INPUTS }),
      out: node("out", "output", {}),
    },
    edges: {
      e0: edge("e0", "a", "fx", "input"),
      // Edge ids sort in wiring order (m01..m15): edge order is binding order.
      ...Object.fromEntries(PATTERN.map((_, k) => { const id = `m${String(k + 1).padStart(2, "0")}`; return [id, edge(id, `s${k + 1}`, "fx", "more")]; })),
      z: edge("z", "fx", "out", "input"),
    },
    groups: {},
  } as never;
}

describe("Custom WGSL with more than one input (T1365b, §V147)", () => {
  it("binds all fifteen More inputs in edge order (VN139)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const result = await renderHeadless({ host: nodeGpuHost(), graph: fifteenGraph(), settings: SETTINGS, frames: 1, outputNodeId: "fx", outputPortId: "out" });
    const bytes = result.frames[0]!.bytes;
    const bits = (from: number, to: number): number => PATTERN.slice(from, to).reduce((sum, on, k) => sum + on * 2 ** k, 0);
    expect([bits(0, 8), bits(8, 15)]).toEqual([0b01001101, 0b1010110]);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0b01001101, 0b1010110, 0]);
  });

  it("reads Input 2 beside Input: the output is their difference to the byte", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const result = await renderHeadless({ host: nodeGpuHost(), graph: graph(TWO_INPUTS, true), settings: SETTINGS, frames: 1, outputNodeId: "fx", outputPortId: "out" });
    const bytes = result.frames[0]!.bytes;
    // The solids are display-space colours decoded to linear and STORED in the project's
    // rgba8unorm, so each input arrives quantised; the difference is of those stored bytes.
    const linear = (display: number): number => (display <= 0.04045 ? display / 12.92 : ((display + 0.055) / 1.055) ** 2.4);
    const stored = (display: number): number => Math.round(linear(display) * 255);
    const expected = [0.9, 0.5, 0.2].map((channel) => Math.max(0, stored(channel) - stored(0.2)));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual(expected);
  });

  it("refuses by name a declared input that nothing feeds", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    await expect(
      renderHeadless({ host: nodeGpuHost(), graph: graph(TWO_INPUTS, false), settings: SETTINGS, frames: 1, outputNodeId: "fx", outputPortId: "out" }),
    ).rejects.toThrow(/reads `inputTexture1` but More has only 0 connection/);
  });
});
