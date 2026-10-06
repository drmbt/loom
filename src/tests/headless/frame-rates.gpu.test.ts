import { beforeAll, describe, expect, it } from "vitest";

import { stopsFinalRender } from "../../domain/diagnostics/classes.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { decodeComponents } from "./pixel-compare.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1426b / T1435b — `fps` and `subframes` reach a parameter through the real stack (§V147).
 *
 * The On Nothing render averages 8 sub-frames per output frame, stepping the transport at
 * 192 fps for a 24 fps film. A kernel writes one expression-driven level straight out, so the
 * pixel is what the expression evaluated to: `subframes / 8 + fps / 96` is exactly 1.25 there
 * (8 sub-frames, a 24 fps film) and exactly 0.375 in a plain 24 fps render (1 sub-frame).
 * Values exact in rgba16float, so equality, not a band.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 4, height: 4 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const KERNEL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  level: f32, // @default 0  written straight out
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(vec3f(params.level), 1.0);
}`;

const graph: GraphDocument = {
  revision: 1,
  nodes: {
    seed: { id: "seed", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [0, 0, 0, 1] } },
    fx: {
      id: "fx",
      type: "customWgsl",
      definitionVersion: 1,
      position: { x: 200, y: 0 },
      parameters: { source: KERNEL, level: expressionSlot("subframes / 8 + fps / 96", 0) },
    },
    out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
  },
  edges: {
    e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
    e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  },
  groups: {},
};

async function level(fps: number, subframes?: number): Promise<number> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    frames: 3,
    capture: [2],
    fps,
    ...(subframes === undefined ? {} : { subframes }),
    outputNodeId: "fx",
    animate: true,
  });
  // §T1641b: by class, not by code. No error, nothing that can never take effect, nothing waiting.
  expect(result.diagnostics.filter(stopsFinalRender)).toEqual([]);
  const frame = result.frames[0]!;
  return decodeComponents(frame.bytes, frame.format)[0]!;
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("fps and subframes in an expression, on a real device (T1426b, T1435b)", () => {
  it("reads the film's 24 fps and 8 sub-frames while the transport steps at 192", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    expect(await level(192, 8)).toBe(1.25);
    expect(await level(24)).toBe(0.375);
  }, 60_000);
});
