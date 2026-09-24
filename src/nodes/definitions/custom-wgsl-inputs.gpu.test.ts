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

describe("Custom WGSL with more than one input (T1365b, §V147)", () => {
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
