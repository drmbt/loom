import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { newKey, newLane, serializeAutomation } from "../../domain/automation/model.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * VN61 — A PARAMETER THAT REFERENCES AN AUTOMATION LANE FOLLOWS THE PLAYHEAD; CUT THE
 * REFERENCE AND IT DOES NOT.
 *
 * Through the real stack: the automation node's `valueEvaluate` in the harness's value
 * graph, the expression `op('automation_score').chan.red` resolved per frame, the compile,
 * Dawn. The lane is a linear ramp from 0 at the start to 1 at one second, at 30 fps, so
 * frame 6 is exactly 0.2 and frame 15 exactly 0.5 (the playhead is integer ticks: 48 000
 * and 120 000 of 240 000). Those values are asserted from PIXELS against renders of the
 * same graph with the tint STATIC at that number, byte-identical, so no colour arithmetic
 * is restated here (§V147). Then the reference is removed (the slot back to its static
 * value) and the two playheads render the same bytes: the cut-the-wire diff.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const settings: ProjectSettings = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 8,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const RETAINED = 0.9;

const LANES = serializeAutomation({
  version: 1,
  lanes: [newLane("lane1", "red", [newKey("start", 0, 0, { interp: "linear" }), newKey("end", 240_000, 1)])],
});

const node = (id: string, type: string, x: number, parameters: Record<string, unknown>, label?: string): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x, y: 0 }, parameters, ...(label === undefined ? {} : { label }) }) as never;

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

/** automation_score beside White Solid → Custom WGSL (rgb × amount × tint) → Output. */
function document(red: StoredParameter): GraphDocument {
  return {
    revision: 1,
    nodes: {
      auto: node("auto", "automation", -400, { lanes: LANES }, "automation_score"),
      solid: node("solid", "solid", 0, { color: [1, 1, 1, 1] }),
      fx: node("fx", "customWgsl", 200, { amount: 1, tint: [1, 1, 1, 1], "tint.r": red }),
      out: node("out", "output", 400, {}),
    },
    edges: {
      e0: edge("e0", ["solid", "out"], ["fx", "input"]),
      e1: edge("e1", ["fx", "out"], ["out", "input"]),
    },
    groups: {},
  };
}

async function render(red: StoredParameter, startFrame: number): Promise<Buffer> {
  const result = await renderHeadless({ host: nodeGpuHost(), graph: document(red), settings, fps: 30, startFrame, frames: 1, animate: true });
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return Buffer.from(frame.bytes);
}

describe("VN61 — a lane drives a parameter through op('<node>').chan.<lane>", () => {
  it("renders the lane's value at each playhead, and the same at both once the reference is cut", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const read = expressionSlot("op('automation_score').chan.red", RETAINED);

    const at6 = await render(read, 6);
    const at15 = await render(read, 15);
    // The lane's exact values, from pixels: frame 6 IS 0.2, frame 15 IS 0.5.
    expect(Buffer.compare(at6, await render(0.2, 0))).toBe(0);
    expect(Buffer.compare(at15, await render(0.5, 0))).toBe(0);
    // Two playheads, two pictures.
    expect(Buffer.compare(at6, at15)).not.toBe(0);

    // Cut the wire: the slot back to static (the retained value). Both playheads agree,
    // and they show the retained value, not either lane value.
    const cut6 = await render(RETAINED, 6);
    const cut15 = await render(RETAINED, 15);
    expect(Buffer.compare(cut6, cut15)).toBe(0);
    expect(Buffer.compare(cut6, at6)).not.toBe(0);
    expect(Buffer.compare(cut15, at15)).not.toBe(0);
  }, 120_000);
});
