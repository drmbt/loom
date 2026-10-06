import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1583b — kernel steps through the WHOLE stack: a document, the per-frame compile, the
 * animator, the frame driver and the offline transport, on a real device.
 *
 * `backend/vgpu/kernel-steps.gpu.test.ts` holds what one frame of N runs does. This file
 * holds the two claims that need a clock the test does not hand-feed:
 *
 *  - the count is a per-frame VALUE an expression drives — Notch's rate form, which keeps
 *    the simulation's step the same size when the frame rate drops;
 *  - offline sub-frames MULTIPLY the count (assessment risk 6): each sub-frame is a frame
 *    to the kernel, with its own smaller delta, so an accumulated export runs
 *    subframes × substeps dispatches per picture and still covers the same time.
 *
 * The transport's first frame has no predecessor and a delta of zero, so every sequence
 * below has one frame that advances nothing; the expected numbers say where.
 */

const CAPACITY = 8;
const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "acc", type: "f32", default: [0] },
  { name: "aux", type: "f32", default: [0] },
]);

/** position.x counts runs, acc sums the time they covered, aux keeps the last run's step. */
const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.x = p.position.x + 1.0;
  q.acc = p.acc + ctx.delta;
  q.aux = ctx.delta;
  return q;
}`;

function graphOf(substeps: unknown): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      k: {
        id: "k", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { capacity: CAPACITY, attributes: ATTRIBUTES, kernel: KERNEL, substeps },
      },
      draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: CAPACITY, sizePixels: 2 } },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "k", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  } as never as GraphDocument;
}

interface Readback {
  /** Runs since the start, per point. */
  readonly runs: number[];
  /** Simulated seconds those runs covered. */
  readonly covered: number[];
  /** The step the last run was handed. */
  readonly step: number[];
}

async function render(
  substeps: unknown,
  options: { readonly fps: number; readonly frames: number; readonly subframes?: number; readonly animate?: boolean },
): Promise<Readback> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const graph = graphOf(substeps);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    fps: options.fps,
    frames: options.frames,
    outputNodeId: "out",
    probeBuffers: [pointStorageId("k")],
    ...(options.subframes === undefined ? {} : { subframes: options.subframes }),
    ...(options.animate === true ? { animate: true } : {}),
  });
  const problems = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
  if (problems.length > 0) throw new Error(problems.map((d) => `${d.code}: ${d.message}`).join("; "));
  const raw = result.buffers?.[pointStorageId("k")];
  if (raw === undefined) throw new Error("the kernel's buffer was not probed");
  const node = { type: "pointKernel", parameters: { capacity: CAPACITY, attributes: ATTRIBUTES } };
  const position = kernelRegionSlice(node, raw, "position").floats;
  return {
    runs: Array.from({ length: CAPACITY }, (_unused, point) => position[point * 4] as number),
    covered: [...kernelRegionSlice(node, raw, "acc").floats],
    step: [...kernelRegionSlice(node, raw, "aux").floats],
  };
}

const every = (value: number): number[] => Array<number>(CAPACITY).fill(value);

describe("kernel steps: the rate form, driven per frame (T1583b)", () => {
  /** Notch's Update Rate with Min/Max Update Steps, as one expression on Substeps. */
  const RATE = {
    mode: "expression",
    bindings: {
      expression: { kind: "expression", source: "clamp(ceil(delta * 240), 1, 16)" },
      static: { kind: "static", value: 1 },
    },
  };
  const FRAMES = 5;

  it("halving the frame rate doubles the runs and leaves the step where it was, bit for bit", async () => {
    const at60 = await render(RATE, { fps: 60, frames: FRAMES, animate: true });
    const at30 = await render(RATE, { fps: 30, frames: FRAMES, animate: true });
    // Frame 0 has no delta: ceil(0) clamps to one run. Each frame after it runs
    // ceil(240 / fps). Red against a count the animator never delivered: 5 at both.
    expect(at60.runs).toEqual(every(1 + (FRAMES - 1) * 4));
    expect(at30.runs).toEqual(every(1 + (FRAMES - 1) * 8));
    // The point of the rate form: the step a run is handed is 1/240 s at either rate —
    // the same f32, because 1/30 is exactly twice 1/60 and both divisions are by a power
    // of two. A bare count of 4 would have handed the 30 fps run a step twice as long.
    const step = Math.fround(1 / 60 / 4);
    expect(at60.step).toEqual(every(step));
    expect(at30.step).toEqual(every(step));
  }, 120_000);

  it("a frame rate at or above the target runs once per frame, at the frame's whole step", async () => {
    const at240 = await render(RATE, { fps: 240, frames: FRAMES, animate: true });
    expect(at240.runs).toEqual(every(FRAMES));
    expect(at240.step).toEqual(every(Math.fround(1 / 240)));
  }, 120_000);
});

describe("kernel steps: offline sub-frames multiply the count (T1583b, risk 6)", () => {
  it("2 pictures × 4 sub-frames × 4 substeps is 32 runs, covering exactly the time the sub-frames did", async () => {
    // `fps` is the rate the transport STEPS at: 256 sub-frames a second, four to a
    // picture. Every number below is a small integer over a power of two, so exact.
    const stepped = await render(4, { fps: 256, subframes: 4, frames: 8 });
    expect(stepped.runs).toEqual(every(8 * 4));
    // A run's step is the SUB-frame's delta over the substeps, not the picture's.
    expect(stepped.step).toEqual(every(1 / 256 / 4));
    // Seven sub-frames carry a delta (the first has none), so the runs cover 7/256 s —
    // the same time the unstepped kernel covers in the same sub-frames.
    expect(stepped.covered).toEqual(every(7 / 256));
    const single = await render(1, { fps: 256, subframes: 4, frames: 8 });
    expect(single.runs).toEqual(every(8));
    expect(single.covered).toEqual(every(7 / 256));
  }, 120_000);
});
