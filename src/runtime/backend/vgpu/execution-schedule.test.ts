import { describe, expect, it, vi } from "vitest";
import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { readExecutionPlan, type PassDescriptor } from "../plan.ts";
import { wgsl } from "../wgsl.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { fixturePlan } from "./plan-fixture.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

const work = vi.hoisted(() => ({ expansions: 0, segmentWalks: 0 }));
vi.mock("../plan.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plan.ts")>();
  return {
    ...original,
    expandLoops: (...args: Parameters<typeof original.expandLoops>) => {
      work.expansions += 1;
      const expanded = original.expandLoops(...args);
      const iterate = expanded[Symbol.iterator].bind(expanded);
      Object.defineProperty(expanded, Symbol.iterator, {
        configurable: true,
        value: () => { work.segmentWalks += 1; return iterate(); },
      });
      return expanded;
    },
  };
});

function loopPlan(count: number): LogicalExecutionPlan {
  const source = fixturePlan();
  const read = readExecutionPlan(source);
  if (!read.ok) throw new Error("Invalid scheduling fixture");
  const body: PassDescriptor[] = [...read.passes];
  // Render then compute must cross a submit boundary on the direct path.
  body.splice(1, 0, {
    kind: "dispatch", id: "compute", entryPoint: "main", workgroups: [1, 1, 1],
    shader: wgsl`@compute @workgroup_size(1) fn main() {}`,
  });
  return {
    ...source,
    passes: [
      { kind: "loop", id: "begin", loopId: "loop", edge: "begin", count },
      ...body,
      { kind: "loop", id: "end", loopId: "loop", edge: "end" },
    ],
  };
}

const inputs: FrameInputs = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64],
};

describe("compiled execution schedule", () => {
  it("reuses loop expansion and direct submit segments until counts change", async () => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    try {
      await backend.initialize({});
      work.expansions = 0;
      work.segmentWalks = 0;
      const compiled = await backend.compile(loopPlan(3));
      let generators = 0;
      backend.onCpuTimings((spans) => {
        generators += Object.keys(spans).filter((name) => name === "generate" || name.startsWith("generate~")).length;
      });
      const render = (expected: number): void => {
        generators = 0;
        backend.render(compiled, inputs);
        expect(generators).toBe(expected);
      };
      render(3);
      render(3);
      backend.updateUniforms({ passId: "begin", values: { count: 3 } });
      render(3);
      expect(work.expansions).toBe(1);
      expect(work.segmentWalks).toBe(1);

      backend.updateUniforms({ passId: "begin", values: { count: 5 } });
      render(5);
      render(5);
      expect(work.expansions).toBe(2);
      expect(work.segmentWalks).toBe(2);

      const builds = backend.status.resourceBuilds;
      expect((await backend.compile(loopPlan(2))).id).toBe(compiled.id);
      render(2);
      expect(backend.status.resourceBuilds).toBe(builds);
      expect(work.expansions).toBe(3);
      expect(work.segmentWalks).toBe(3);

      await backend.compile(loopPlan(2));
      render(2);
      expect(work.expansions).toBe(3);
      expect(work.segmentWalks).toBe(3);

      host.loseDevice();
      await Promise.resolve(); // Deliver the deviceLost notification before awaiting its rebuild.
      await backend.whenSettled();
      render(2);
      expect(work.expansions).toBe(3);
      expect(work.segmentWalks).toBe(3);
    } finally {
      backend.dispose();
    }
  });
});
