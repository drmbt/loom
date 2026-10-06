import { describe, expect, it } from "vitest";

import { MAX_KERNEL_STEPS } from "./plan.ts";
import { SHARED_UNIFORMS_WGSL, dispatchStepUniforms, sharedUniformsFromFrame, stepSeed } from "./shared-uniforms.ts";

/**
 * T468: the ABSOLUTE clock reaches shaders, not just expressions. The block and its
 * writer are two texts describing one layout; this pins both sides so neither can
 * gain a member the other lacks (V380's mirror hazard, in the small).
 */
describe("the shared frame block carries the absolute clock (T468)", () => {
  it("declares absTime and absFrame as NAMED f32 members (V380)", () => {
    expect(SHARED_UNIFORMS_WGSL).toContain("absTime: f32");
    expect(SHARED_UNIFORMS_WGSL).toContain("absFrame: f32");
    // Named members, never an array — uniform arrays defeat the writer's reflection.
    expect(SHARED_UNIFORMS_WGSL).not.toContain("array<");
  });

  it("writes the same number expressions read as `abstime` — one clock, two readers", () => {
    const shared = sharedUniformsFromFrame({
      frame: {
        timeSeconds: 0.5, // a fresh lap: the TIMELINE clock just wrapped
        deltaSeconds: 1 / 60,
        frameIndex: 30,
        mode: "live",
        randomSeed: 7,
        absFrameIndex: 3630,
        absTimeSeconds: 60.5, // the show has run a minute — and keeps growing
      },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    } as never);
    expect(shared.absTime).toBe(60.5);
    expect(shared.absFrame).toBe(3630);
    // The lap clock is untouched beside it — two clocks, both real (§V172's shape).
    expect(shared.time).toBe(0.5);
  });

  it("falls back to the lap clock when the transport predates the absolute one", () => {
    const shared = sharedUniformsFromFrame({
      frame: { timeSeconds: 2, deltaSeconds: 1 / 60, frameIndex: 120, mode: "live", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    } as never);
    expect(shared.absTime).toBe(2);
    expect(shared.absFrame).toBe(120);
  });
});

/**
 * T1583b: what one RUN of a stepped kernel reads differently from the frame. The device
 * half is `vgpu/kernel-steps.gpu.test.ts`; these are the properties a handful of fixture
 * kernels cannot cover — the whole run range, and the whole seed argument.
 */
describe("the per-run values of a stepped dispatch (T1583b)", () => {
  const frame = { deltaSeconds: 1 / 60, firstRun: true, seed: 7 };

  it("run 0 of one step is the frame's own values: the delta over 1, the seed untouched", () => {
    expect(dispatchStepUniforms({ run: 0, substeps: 1, iterations: 1 }, frame)).toEqual({
      deltaSeconds: 1 / 60,
      substep: 0,
      substeps: 1,
      iteration: 0,
      iterations: 1,
      firstRun: 1,
      seed: 7,
    });
  });

  it("divides the delta by SUBSTEPS alone, and counts iterations inside each substep", () => {
    const runs = Array.from({ length: 6 }, (_unused, run) =>
      dispatchStepUniforms({ run, substeps: 2, iterations: 3 }, frame),
    );
    expect(runs.map((values) => values["deltaSeconds"])).toEqual(Array(6).fill(1 / 120));
    expect(runs.map((values) => values["substep"])).toEqual([0, 0, 0, 1, 1, 1]);
    expect(runs.map((values) => values["iteration"])).toEqual([0, 1, 2, 0, 1, 2]);
    // Only the first run of the frame is the seeding one.
    expect(runs.map((values) => values["firstRun"])).toEqual([1, 0, 0, 0, 0, 0]);
    expect(dispatchStepUniforms({ run: 0, substeps: 2, iterations: 3 }, { ...frame, firstRun: false })["firstRun"]).toBe(0);
  });

  it("carries no seed for a pass that has none", () => {
    const values = dispatchStepUniforms({ run: 3, substeps: 4, iterations: 1 }, { deltaSeconds: 1, firstRun: false });
    expect(Object.hasOwn(values, "seed")).toBe(false);
  });

  it("the run occupies the seed's TOP bits: 256 runs, eight bits, nothing below bit 24", () => {
    expect(stepSeed(7, 0)).toBe(7);
    expect(stepSeed(0, 1)).toBe(0x8000_0000);
    expect(stepSeed(0, 2)).toBe(0x4000_0000);
    expect(stepSeed(0, 3)).toBe(0xc000_0000);
    expect(stepSeed(0, 255)).toBe(0xff00_0000);
    const folds = Array.from({ length: MAX_KERNEL_STEPS }, (_unused, run) => stepSeed(0, run));
    expect(new Set(folds).size).toBe(MAX_KERNEL_STEPS);
    // The claim the docblock makes: the seed meets the point id by XOR, so a (point, run)
    // pair is a distinct hash input for every id that leaves the top eight bits clear.
    expect(folds.every((fold) => (fold & 0x00ff_ffff) === 0)).toBe(true);
    // And it is an unsigned 32-bit number whatever the seed's own top bit is.
    expect(stepSeed(0xffff_ffff, 1)).toBe(0x7fff_ffff);
  });
});
