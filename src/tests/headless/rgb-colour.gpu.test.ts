import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { decodeComponents } from "./pixel-compare.ts";
import { renderHeadless } from "./render-harness.ts";
import { validateParameterValue } from "../../domain/parameters/validate.ts";

/**
 * T1434b — a colour given as THREE numbers is a colour, on a real device (§V147).
 *
 * A Custom WGSL `tint: vec3f` reflects to a colour picker (its name reads as colour), and the
 * validator wanted rgba: `[0.25, 0.5, 0.75]` was refused with a diagnostic and the kernel got
 * the default white. The kernel below writes its tint straight out, so the pixel IS the value
 * the shader received: exactly the three numbers given (0s and 1s, which the display decode
 * of a reflected colour keeps exact), with no diagnostic, and the same bytes as the rgba
 * spelling. A `vec4f` colour given rgb gets alpha 1.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const KERNEL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  tint: vec3f, // @default 1  written straight out
  glowColor: vec4f, // @default 1  alpha written to the output's alpha
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(params.tint * params.glowColor.rgb, params.glowColor.a);
}`;

function graph(tint: ParameterValue, glowColor: ParameterValue): GraphDocument {
  return {
    revision: 1,
    nodes: {
      seed: { id: "seed", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [0, 0, 0, 1] } },
      fx: { id: "fx", type: "customWgsl", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: { source: KERNEL, tint, glowColor } },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

async function render(document: GraphDocument): Promise<{ pixel: number[]; bytes: Uint8Array; diagnostics: string[] }> {
  const result = await renderHeadless({ host: nodeGpuHost(), graph: document, settings, frames: 1, capture: [0], outputNodeId: "fx" });
  const frame = result.frames[0]!;
  return {
    pixel: [...decodeComponents(frame.bytes, frame.format).slice(0, 4)],
    bytes: frame.bytes,
    diagnostics: result.diagnostics.filter((d) => d.nodeId === "fx").map((d) => `${d.code}: ${d.message}`),
  };
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("an rgb colour (T1434b)", () => {
  it("reaches a vec3f colour exactly, with no diagnostic, and draws the rgba spelling's bytes", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const rgb = await render(graph([1, 0, 1], [1, 1, 1, 1]));
    expect(rgb.diagnostics).toEqual([]);
    expect(rgb.pixel).toEqual([1, 0, 1, 1]);
    const rgba = await render(graph([1, 0, 1, 1], [1, 1, 1, 1]));
    expect(rgb.bytes).toEqual(rgba.bytes);
  }, 60_000);

  it("gives a vec4f colour set as rgb an alpha of exactly 1", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const rgb = await render(graph([1, 1, 1], [0, 1, 0]));
    expect(rgb.diagnostics).toEqual([]);
    expect(rgb.pixel).toEqual([0, 1, 0, 1]);
    // Two numbers are still no colour, refused by name.
    const colour = { type: "color", label: "C", default: [1, 1, 1, 1], space: "display" } as const;
    expect(validateParameterValue("glowColor", colour, [0, 1])?.message).toContain("3 or 4 finite numbers");
  }, 60_000);
});
