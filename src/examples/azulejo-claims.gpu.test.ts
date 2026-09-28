import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../domain/types/graph.ts";
import { azulejoDocument } from "./documents/azulejo.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { decodeHalf, TOLERANCE_CROSS_GPU_HDR } from "../tests/headless/pixel-compare.ts";
import { linearToSrgb, srgbToLinear } from "../runtime/export/pixel-format.ts";

/**
 * T1486b — E80 on Dawn: the mask decides, pixel by pixel, which of the two layers you see.
 *
 * Each claim renders the shipped graph against a variant of it on the same frame, so what is
 * asserted is what differs if a wire were cut or a Switch moved: where the shape is solid the
 * frame IS the inner layer, where it is empty the frame IS the outer layer, a different inner
 * layer reaches only the shape's pixels, and an empty mask leaves the outer layer alone.
 *
 * Every comparison reads the output's half floats as rendered, not display bytes. The
 * output target is DISPLAY-ENCODED rgba16float, and near 1 that encoding folds several
 * coverages into one half (0.999 and 0.9995 both land on 0.99951), so the shape is never read
 * off its own colour: coverage is `cut1`'s ALPHA, which the output leaves linear. The solid
 * region is where that alpha is at its maximum w — one half-float step under 1 where the
 * blur's weights sum — and there the frame is asserted as the mix `inner·w + outer·(1 − w)`
 * in linear light, re-encoded, to the half-float rounding of the result (§V147: derived,
 * not a band). The empty region is alpha exactly 0, and there the frame is asserted equal.
 */
let unavailable: string | undefined;
beforeAll(async () => {
  unavailable = (await probeDawn()).error;
}, 60_000);

const WIDTH = 320;
const HEIGHT = 180;

/** The shipped graph with the output fed from `from` instead of `wall1`, and `index` overrides. */
function variant(from: string, indices: Record<string, number> = {}): GraphDocument {
  const graph = structuredClone(azulejoDocument.graph);
  graph.edges["e18"] = { ...graph.edges["e18"]!, source: { nodeId: from, portId: "out" } };
  for (const [id, index] of Object.entries(indices)) graph.nodes[id]!.parameters["index"] = index;
  return graph;
}

/** The output as rendered: rgba16float, decoded, four values per pixel. */
async function render(graph: GraphDocument): Promise<Float64Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...azulejoDocument.settings, outputResolution: { width: WIDTH, height: HEIGHT } },
    frames: 1,
    outputNodeId: "out",
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0]!;
  expect(frame.format).toBe("rgba16float");
  const bits = new Uint16Array(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength / 2);
  return Float64Array.from(bits, decodeHalf);
}

/** The shape's coverage, read as `cut1`'s alpha: where it is at its maximum, and where it is 0. */
async function maskRegions(): Promise<{ solid: number[]; empty: number[]; w: number }> {
  const cut = await render(variant("cut"));
  let w = 0;
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) w = Math.max(w, cut[index * 4 + 3]!);
  expect(w).toBeGreaterThan(0.999);
  const solid: number[] = [];
  const empty: number[] = [];
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    const alpha = cut[index * 4 + 3]!;
    if (alpha === w) solid.push(index);
    else if (alpha === 0) empty.push(index);
  }
  return { solid, empty, w };
}

/** Largest distance of `frame` from `inner·w + outer·(1 − w)` over `pixels`, relative to the value. */
function offMix(frame: ArrayLike<number>, inner: ArrayLike<number>, outer: ArrayLike<number>, w: number, pixels: readonly number[]): number {
  let worst = 0;
  for (const index of pixels) {
    for (let channel = 0; channel < 3; channel += 1) {
      const at = index * 4 + channel;
      const expected = linearToSrgb(srgbToLinear(inner[at]!) * w + srgbToLinear(outer[at]!) * (1 - w));
      worst = Math.max(worst, Math.abs(frame[at]! - expected) / Math.max(1, Math.abs(expected)));
    }
  }
  return worst;
}

function differing(a: ArrayLike<number>, b: ArrayLike<number>, pixels: readonly number[]): number {
  let count = 0;
  for (const index of pixels) {
    for (let channel = 0; channel < 3; channel += 1) {
      if (a[index * 4 + channel] !== b[index * 4 + channel]) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

describe("E80 Azulejo — the mask chooses the layer (T1486b)", () => {
  it("inside the shape the frame is the inner layer, outside it the outer layer", async () => {
    expect(unavailable).toBeUndefined();
    const { solid, empty, w } = await maskRegions();
    // The two stand-in figures cover a real share of the frame, and most of it is neither.
    expect(solid.length).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
    expect(empty.length).toBeGreaterThan(WIDTH * HEIGHT * 0.5);
    const frame = await render(variant("wall"));
    const inner = await render(variant("inner"));
    const outer = await render(variant("outer"));
    expect(offMix(frame, inner, outer, w, solid)).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
    expect(differing(frame, outer, empty)).toBe(0);
    // And the two layers really are different pictures there, or the claim above is empty.
    expect(differing(inner, outer, solid)).toBeGreaterThan(solid.length * 0.9);
  }, 120_000);

  it("a different inner layer changes the shape's pixels and nothing outside it", async () => {
    expect(unavailable).toBeUndefined();
    const { solid, empty } = await maskRegions();
    const city = await render(variant("wall"));
    // inner1 index 1 is the empty Movie File In: black until a file is loaded.
    const clip = await render(variant("wall", { inner: 1 }));
    expect(differing(city, clip, empty)).toBe(0);
    expect(differing(city, clip, solid)).toBeGreaterThan(solid.length * 0.9);
  }, 120_000);

  it("with an empty shape the wall is the outer layer alone", async () => {
    expect(unavailable).toBeUndefined();
    // The shape cut to `size1`, the black Solid: nobody in front of the camera. (Not the
    // Matte branch — headless, the camera's understudy is a picture the model finds a subject in.)
    const graph = variant("wall");
    graph.edges["e13"] = { ...graph.edges["e13"]!, source: { nodeId: "size", portId: "out" } };
    const nobody = await render(graph);
    const outer = await render(variant("outer"));
    const all = Array.from({ length: WIDTH * HEIGHT }, (_, index) => index);
    expect(differing(nobody, outer, all)).toBe(0);
  }, 120_000);
});
