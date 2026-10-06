import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1585b — the harness's PER-FRAME buffer probe (`probeFrames`).
 *
 * A claim about how a simulation moves is a claim about every frame: no point jumps from one
 * frame to the next, no segment is long on the way. `probeBuffers` alone reads the state the
 * LAST frame left, so such a claim could only be asked of the end. This reads the same
 * buffers after each named frame, inside one render.
 *
 * The fixture is a kernel that counts its own runs, so a frame's buffer says which frame it
 * is: `position.x` is the number of frames stepped so far. Whether a probe read the frame it
 * was asked for — and not the last one, or the one before — is then a number.
 */

const CAPACITY = 4;
const ATTRIBUTES = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);
const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.x = p.position.x + 1.0;
  return q;
}`;
const NODE = { type: "pointKernel", parameters: { capacity: CAPACITY, attributes: ATTRIBUTES } };
const BUFFER = pointStorageId("kernel_counter");

function graph(): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      kernel_counter: {
        id: "kernel_counter", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { capacity: CAPACITY, attributes: ATTRIBUTES, kernel: KERNEL },
      },
      points_draw: { id: "points_draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: CAPACITY, sizePixels: 2 } },
      output_out: { id: "output_out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "kernel_counter", portId: "out" }, target: { nodeId: "points_draw", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "points_draw", portId: "out" }, target: { nodeId: "output_out", portId: "input" } },
    },
  } as never as GraphDocument;
}

/** The run count the kernel's buffer holds: `position.x` of its first point. */
const runsIn = (raw: ArrayBuffer | undefined): number => {
  if (raw === undefined) throw new Error("the kernel's buffer was not probed");
  return kernelRegionSlice(NODE, raw, "position").floats[0] as number;
};

async function render(more: { readonly frames: number; readonly probeFrames?: ReadonlyArray<number>; readonly probeBuffers?: ReadonlyArray<string> }) {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  return renderHeadless({ host: nodeGpuHost(), graph: graph(), fps: 60, outputNodeId: "output_out", probeBuffers: [BUFFER], ...more });
}

describe("render harness: buffers probed at named frames (T1585b)", () => {
  it("each named frame's buffer is the state THAT frame left, in the order the frames ran", async () => {
    // Asked out of order, and with the last frame among them.
    const result = await render({ frames: 7, probeFrames: [5, 0, 2, 6] });
    expect(result.bufferFrames?.map((entry) => entry.frameIndex)).toEqual([0, 2, 5, 6]);
    // Frame n is the kernel's (n + 1)th run. A probe that read after the whole render
    // would say 7 four times; one a frame late, 2, 4, 7, 7.
    expect(result.bufferFrames?.map((entry) => runsIn(entry.buffers[BUFFER]))).toEqual([1, 3, 6, 7]);
    // The final probe is still there, and is the last frame's.
    expect(runsIn(result.buffers?.[BUFFER])).toBe(7);
    expect(Object.keys(result.bufferFrames?.[0]?.buffers ?? {})).toEqual([BUFFER]);
  }, 120_000);

  it("is absent when it was not asked for, and probing changes nothing about the run", async () => {
    const plain = await render({ frames: 4 });
    expect(plain.bufferFrames).toBeUndefined();
    const probed = await render({ frames: 4, probeFrames: [0, 1, 2, 3] });
    // The same final state, and the same pixels: reading a buffer between frames is not a step.
    expect(runsIn(probed.buffers?.[BUFFER])).toBe(runsIn(plain.buffers?.[BUFFER]));
    expect(Buffer.from(probed.frames[0]?.bytes ?? []).equals(Buffer.from(plain.frames[0]?.bytes ?? []))).toBe(true);
    expect(probed.bufferFrames?.map((entry) => runsIn(entry.buffers[BUFFER]))).toEqual([1, 2, 3, 4]);
  }, 120_000);

  it("refuses a probe that could only come back empty: a frame the render never steps, or no buffer to read", async () => {
    await expect(render({ frames: 3, probeFrames: [1, 3] })).rejects.toThrow("probeFrames asks for frame 3, and this render steps frames 0 to 2.");
    await expect(render({ frames: 3, probeFrames: [-1] })).rejects.toThrow("probeFrames asks for frame -1");
    await expect(render({ frames: 3, probeFrames: [1], probeBuffers: [] })).rejects.toThrow(
      "probeFrames names frames to read buffers at, and probeBuffers names no buffer to read.",
    );
    // The legitimate edge: an empty list asks for nothing and gets an empty list.
    expect((await render({ frames: 3, probeFrames: [] })).bufferFrames).toEqual([]);
  }, 120_000);
});
