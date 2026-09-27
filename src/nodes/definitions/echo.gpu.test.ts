import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../tests/headless/pixel-compare.ts";

/**
 * Echo on a real device (T1402b, §V147): per-frame behaviour, so texel-level and exact.
 *
 * A dark 4x4 dot steps 16 pixels right every frame across a white field. The trail it
 * leaves is analytic: with Darken on, a pixel the dot left k frames ago holds 1 − amount^k
 * (at amount 0.5: 0.5, 0.75, 0.875 — each exact in a half float), because the node archives
 * its own OUTPUT and so every echo carries the ones before it. Frame 0 is the input
 * unchanged (§V229). With a delay of 2 the copies sit two frames apart: the position one
 * frame old is untouched, the one two frames old is echoed.
 */

const W = 96;
const H = 64;
const Y = 31;
const dotX = (frame: number): number => 10 + 16 * frame;

const settings: ProjectSettings = {
  outputResolution: { width: W, height: H },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const MOVING_DOT = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let p = floor(uv * vec2f(textureDimensions(inputTexture)));
  let x0 = 10.0 + 16.0 * frameU.frameIndex;
  let inside = p.x >= x0 && p.x < x0 + 4.0 && p.y >= 30.0 && p.y < 34.0;
  return vec4f(vec3f(select(1.0, 0.0, inside)), max(base.a, 1.0));
}`;

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

function graph(parameters: Record<string, ParameterValue>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      seed: node("seed", "solid", { color: [0, 0, 0, 1] }),
      fix: node("fix", "customWgsl", { source: MOVING_DOT }),
      fx: node("fx", "echo", parameters),
      out: node("out", "output"),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fix", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fix", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

/** Frames 0..n-1 of the echo's output, each as "the red value at (x, Y)". */
async function row(parameters: Record<string, ParameterValue>, frames: number): Promise<Array<(x: number) => number>> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(parameters),
    settings,
    fps: 60,
    frames,
    capture: Array.from({ length: frames }, (_, index) => index),
    outputNodeId: "fx",
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(result.frames).toHaveLength(frames);
  return result.frames.map((frame) => {
    const pixels = decodeComponents(frame.bytes, frame.format);
    return (x: number) => pixels[(Y * W + x) * 4]!;
  });
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);
const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

describe("Echo on a real device (T1402b)", () => {
  it("leaves a darkening trail whose values are 1 - amount^k, and frame 0 is the input", async () => {
    requireDawn();
    const frames = await row({ amount: 0.5, darken: 1, delay: 1, frames: 2 }, 4);
    // Frame 0: nothing archived, so the past is the present.
    expect(frames[0]!(dotX(0) + 1)).toBe(0);
    expect(frames[0]!(dotX(1) + 1)).toBe(1);
    expect(frames[0]!(80)).toBe(1);

    const last = frames[3]!;
    expect(last(dotX(3) + 1)).toBe(0); // the dot, as dark as it is
    expect(last(dotX(2) + 1)).toBe(0.5); // one frame behind
    expect(last(dotX(1) + 1)).toBe(0.75); // two
    expect(last(dotX(0) + 1)).toBe(0.875); // three: the trail is recursive
    expect(last(90)).toBe(1); // where the dot never was
  }, 60_000);

  it("blends instead of darkening at Darken 0: the moving dot itself is ghosted", async () => {
    requireDawn();
    const frames = await row({ amount: 0.5, darken: 0, delay: 1, frames: 2 }, 2);
    expect(frames[1]!(dotX(1) + 1)).toBe(0.5); // now 0, past 1: half and half
    expect(frames[1]!(dotX(0) + 1)).toBe(0.5); // now 1, past 0
  }, 60_000);

  it("spaces the echoes Delay frames apart", async () => {
    requireDawn();
    const frames = await row({ amount: 0.5, darken: 1, delay: 2, frames: 3 }, 4);
    const last = frames[3]!;
    expect(last(dotX(2) + 1)).toBe(1); // one frame old: not an echo at delay 2
    expect(last(dotX(1) + 1)).toBe(0.5); // two frames old: the echo
    // The same frame at delay 1 has an echo one frame back — the knob is what moved it.
    const near = (await row({ amount: 0.5, darken: 1, delay: 1, frames: 3 }, 4))[3]!;
    expect(near(dotX(2) + 1)).toBe(0.5);
  }, 60_000);
});
