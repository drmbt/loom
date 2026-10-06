import { beforeAll, describe, expect, it } from "vitest";

import { stopsFinalRender } from "../../domain/diagnostics/classes.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1432b — pixel-sized effects scale with the render when the project names a reference
 * width, on a real device (§V147).
 *
 * `--final` renders the On Nothing shots at twice the size and box-downsamples, and every
 * effect sized in pixels (a blur radius, a grain) came out half as wide across the frame.
 * With `referenceWidth` named, a parameter that declares `scalesWithOutput` compiles at
 * `outputWidth / referenceWidth` times its authored value.
 *
 * The claims are exact, not banded: a Blur of size 8 in a 128-wide render whose reference is
 * 64 must be BYTE-IDENTICAL to a Blur of size 16 with no reference — the scale is the
 * parameter, so the two compile the same uniforms and draw the same bytes. Each claim also
 * shows the reference matters (size 8 without it differs), so an identity scale cannot pass.
 * The second claim drives the size by an EXPRESSION, resolved per frame (the harness compiles
 * each animated frame in full; the app's values-only frame path is pinned against the full
 * compile in `frame-compile.test.ts`).
 */

const W = 128;
const H = 32;

function settings(referenceWidth?: number): ProjectSettings {
  return {
    outputResolution: { width: W, height: H },
    workingFormat: "rgba16float",
    colorPolicy: { workingSpace: "linear", displayTransform: "none" },
    randomSeed: 1,
    previewLongEdge: 64,
    previewFps: 30,
    ...(referenceWidth === undefined ? {} : { referenceWidth }),
    limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
  };
}

/** A three-pixel vertical band of 1.0 at columns 63..65, on black. */
const LINE = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = floor(uv * vec2f(textureDimensions(inputTexture)));
  return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(1.0), abs(p.x - 64.0) <= 1.0);
}`;

function node(id: string, type: string, parameters: Record<string, StoredParameter> = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters } as GraphNode;
}

function graph(type: string, parameters: Record<string, StoredParameter>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      seed: node("seed", "solid", { color: [0, 0, 0, 1] }),
      fix: node("fix", "customWgsl", { source: LINE }),
      fx: node("fx", type, parameters),
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

async function render(document: GraphDocument, referenceWidth?: number, animate = false): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document,
    settings: settings(referenceWidth),
    frames: 2,
    capture: [1],
    outputNodeId: "fx",
    animate,
  });
  // §T1641b: by class, not by code. No error, nothing that can never take effect, nothing waiting.
  expect(result.diagnostics.filter(stopsFinalRender)).toEqual([]);
  return result.frames[0]!.bytes;
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

describe("pixel-sized effects at a reference width (T1432b)", () => {
  it("a Blur of 8 px at reference 64 in a 128-wide render draws exactly a Blur of 16 px", async () => {
    requireDawn();
    const scaled = await render(graph("blur", { size: 8 }), 64);
    const twice = await render(graph("blur", { size: 16 }));
    const unscaled = await render(graph("blur", { size: 8 }));
    expect(same(scaled, twice)).toBe(true);
    // Not vacuous: without the reference the same document draws the narrower blur.
    expect(same(scaled, unscaled)).toBe(false);
  }, 60_000);

  it("scales a size driven by an expression the same way", async () => {
    requireDawn();
    const driven = await render(graph("blur", { size: expressionSlot("4 + 4 + 0 * time", 1) }), 64, true);
    const twice = await render(graph("blur", { size: 16 }));
    const unscaled = await render(graph("blur", { size: expressionSlot("4 + 4 + 0 * time", 1) }), undefined, true);
    expect(same(driven, twice)).toBe(true);
    expect(same(driven, unscaled)).toBe(false);
  }, 60_000);

  it("Film Grade's grain size and Streak's min size scale; a reference equal to the output is the identity", async () => {
    requireDawn();
    const grade = { grain: 0.5, grainSize: 2 };
    expect(same(await render(graph("filmGrade", grade), 64), await render(graph("filmGrade", { ...grade, grainSize: 4 })))).toBe(true);
    expect(same(await render(graph("filmGrade", grade), 64), await render(graph("filmGrade", grade)))).toBe(false);
    // The streak's source-size gate: 2 px at reference 64 is a 4 px gate here, which the
    // three-pixel band only half passes (it fills 3/4 of the square); at 2 px it passes whole.
    const streak = { threshold: 0.5, knee: 0.1, minSize: 2 };
    expect(same(await render(graph("streak", streak), 64), await render(graph("streak", { ...streak, minSize: 4 })))).toBe(true);
    expect(same(await render(graph("streak", streak), 64), await render(graph("streak", streak)))).toBe(false);
    // A reference equal to the output width scales by exactly 1.
    expect(same(await render(graph("blur", { size: 8 }), W), await render(graph("blur", { size: 8 })))).toBe(true);
  }, 60_000);
});
