import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../tests/headless/pixel-compare.ts";

/**
 * Window Out's Fit on a real device (§T1391b, §V147).
 *
 * Exact, not banded: each mode is compared with a STRETCH of the same input into a target
 * shaped so that the two sample the input at the same coordinates. The input is a 200×100
 * red→blue ramp (2:1) and the window is 100×100 (1:1):
 *
 *  - FILL crops the input's middle half: window column x samples input u = (x + 50.5)/200,
 *    which is what a 200×100 stretch samples at column x + 50;
 *  - FIT letterboxes: rows 25..74 sample input v = (y − 24.5)/50, what a 100×50 stretch
 *    samples at row y − 25, and every other row is opaque black.
 *
 * Raw linear values out (display transform none), so no encode sits between the two.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 200, height: 100 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

function graph(fit: string, width: number, height: number): GraphDocument {
  return {
    revision: 1,
    nodes: {
      ramp: {
        id: "ramp", type: "ramp", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { type: "horizontal", stops: [{ position: 0, color: [1, 0, 0, 1] }, { position: 1, color: [0, 0, 1, 1] }] },
      },
      win: { id: "win", type: "window", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: { fit, width, height } },
    },
    edges: { e1: { id: "e1", source: { nodeId: "ramp", portId: "out" }, target: { nodeId: "win", portId: "input" } } },
    groups: {},
  };
}

async function render(fit: string, width: number, height: number) {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(fit, width, height),
    settings,
    frames: 1,
    capture: [0],
    outputNodeId: "win",
    outputPortId: "$target",
    displaySinks: ["win"],
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0]!;
  const pixels = decodeComponents(frame.bytes, frame.format);
  expect(pixels.length).toBe(width * height * 4);
  const at = (x: number, y: number): number[] => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
  return at;
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("Window Out places its input by Fit (§T1391b)", () => {
  it("FILL crops the middle half: column x is the 2:1 stretch's column x + 50", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const fill = await render("fill", 100, 100);
    const wide = await render("stretch", 200, 100);
    for (const y of [0, 50, 99]) {
      for (let x = 0; x < 100; x += 1) expect(fill(x, y), `x ${x} y ${y}`).toEqual(wide(x + 50, y));
    }
    // And it IS a crop: the window's left edge is not the input's left edge.
    expect(fill(0, 50)).not.toEqual(wide(0, 50));
  }, 120_000);

  it("FIT letterboxes: rows 25..74 are the 100×50 stretch, every other row opaque black", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const fit = await render("fit", 100, 100);
    const short = await render("stretch", 100, 50);
    for (let y = 0; y < 100; y += 1) {
      for (const x of [0, 37, 99]) {
        if (y < 25 || y >= 75) expect(fit(x, y), `bar x ${x} y ${y}`).toEqual([0, 0, 0, 1]);
        else expect(fit(x, y), `x ${x} y ${y}`).toEqual(short(x, y - 25));
      }
    }
  }, 120_000);
});
