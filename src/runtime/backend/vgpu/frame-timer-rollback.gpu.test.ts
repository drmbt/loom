import { describe, expect, it } from "vitest";
import { compute, frame, target, timer } from "vgpu";
import type { TimerFrameDrop } from "vgpu";

import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { preparedShader } from "./prepared-shader.ts";

/**
 * T1295 and §T1707b ON A REAL DEVICE: A FRAME'S GPU TIMER COVERS ITS KERNELS, AND A FRAME
 * WHOSE TIMER WAS DISCARDED SAYS SO.
 *
 * 1. A KERNEL IS TIMED LIKE A RENDER PASS. Since §T1707b a kernel is a compute pass of the
 *    frame (`Frame.computePass`), and the vgpu patch gives that pass the `timer` a render
 *    pass takes. Before, a kernel submitted its own command buffer and reserved a pair in the
 *    open frame (`Frame.attachExternalSpan`), with an undo for a throw before its submit; both
 *    are gone with the separate submit.
 *
 * 2. THE SILENT FRAME. A failed pass is rolled back by discarding the timer for the WHOLE
 *    frame, so every span of that frame, the passes that DID run included, produces nothing.
 *    The patch reports that frame through `timer.onDropped` with reason "abandoned", for a
 *    compute pass as for a render pass.
 */

const KERNEL = "@compute @workgroup_size(1) fn main() {}";
async function openTimedGpu() {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const session = await nodeGpuHost().create({});
  if (!(session.requestedFeatures ?? []).includes("timestamp-query")) {
    session.dispose();
    throw new Error(`${probe.adapter ?? "adapter"} granted no timestamp-query; nothing to gate`);
  }
  const gpu = session.gpu;
  const clock = timer(gpu);
  const results: Readonly<Record<string, number>>[] = [];
  const drops: TimerFrameDrop[] = [];
  clock.onResults((spans) => results.push(spans));
  clock.onDropped((drop) => drops.push(drop));
  /** Results resolve off a mapped buffer; wait until the queue and the readback have both landed. */
  const settle = async (count: number): Promise<void> => {
    await gpu.settled();
    const deadline = performance.now() + 5_000;
    while (results.length < count && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  };
  return { session, gpu, clock, results, drops, settle };
}

describe("a frame's GPU timer over its kernels (T1295, §T1707b)", () => {
  it("a kernel's compute pass reports its span beside the frame's render pass", async () => {
    const { session, gpu, clock, results, drops, settle } = await openTimedGpu();
    try {
      const kernel = compute(gpu, preparedShader(KERNEL, "kernel")).compileSync();
      const canvas = target(gpu, { size: [4, 4] });
      const f = frame(gpu);
      f.computePass({ timer: clock.span("kernel") }, (pass) => pass.dispatch(kernel, 1));
      f.pass({ target: canvas, timer: clock.span("draw") }, () => {});
      f.submit();
      await settle(1);
      expect(results).toHaveLength(1);
      // Without the patch's `timer` on computePass the kernel would be missing from its frame.
      expect(Object.keys(results[0] ?? {}).sort()).toEqual(["draw", "kernel"]);
      expect(drops).toEqual([]);
    } finally {
      session.dispose();
    }
  }, 60_000);

  it("a compute pass that fails abandons the frame's timer, and says so", async () => {
    const { session, gpu, clock, results, drops, settle } = await openTimedGpu();
    try {
      const kernel = compute(gpu, preparedShader(KERNEL, "kernel")).compileSync();
      const f = frame(gpu);
      f.computePass({ timer: clock.span("ran") }, (pass) => pass.dispatch(kernel, 1));
      expect(() =>
        f.computePass({ timer: clock.span("failed") }, () => {
          throw new Error("kernel body failed");
        }),
      ).toThrow("kernel body failed");
      f.submit();
      await settle(0);
      expect(results).toEqual([]);
      expect(drops.map((drop) => drop.reason)).toEqual(["abandoned"]);
      expect(drops[0]?.spans, "the frame had attached both spans before the second pass failed").toBe(2);
    } finally {
      session.dispose();
    }
  }, 60_000);

  it("a frame whose pass fails loses its timer for the whole frame, and says so instead of going quiet", async () => {
    const { session, gpu, clock, results, drops, settle } = await openTimedGpu();
    try {
      const canvas = target(gpu, { size: [4, 4] });
      const f = frame(gpu);
      f.pass({ target: canvas, timer: clock.span("ran") }, () => {});
      expect(() =>
        f.pass({ target: canvas, timer: clock.span("failed") }, () => {
          throw new Error("pass body failed");
        }),
      ).toThrow("pass body failed");
      f.submit();
      await settle(0);

      // vgpu's existing rollback: the timer is discarded for the frame, so "ran" — a pass
      // that did execute — has no result either. That loss is correct; its silence was not.
      expect(results).toEqual([]);
      expect(drops.map((drop) => drop.reason)).toEqual(["abandoned"]);
      expect(drops[0]?.frame).toBe(f);
      expect(drops[0]?.spans, "the frame had attached both spans before the second pass failed").toBe(2);
    } finally {
      session.dispose();
    }
  }, 60_000);
});
