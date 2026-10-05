import { describe, expect, it, vi } from "vitest";

import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { wgsl } from "../wgsl.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T1598b — A SKIPPED DRAW COSTS THE DEVICE NOTHING, and comes back when it is wanted.
 *
 * `skip` exists so a shadow caster a light cannot reach is not swept into its map. Whether a
 * light reaches a caster is a VALUE (the light moves), so the draw stays in the plan and
 * only the encoding stops. Three things have to hold for that to be worth having, and none
 * of them shows in a picture, because a skipped draw is one that would have drawn nothing:
 *
 *  - the device is asked for no render pass and no draw call;
 *  - the flag moves through the values entry point, both ways, with nothing rebuilt;
 *  - a pass that owns its target's CLEAR still clears, or the frame before shows through.
 */

const input: FrameInputs = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [8, 8],
};

const SHADER = wgsl`
  @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
  @fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }`;

/** A map cleared by one draw and filled by two casters, as a shadow sweep is. */
function plan(skip: { near?: boolean; far?: boolean; clear?: boolean } = {}): LogicalExecutionPlan {
  const draw = (id: string, clear: boolean, skipped: boolean | undefined) => ({
    kind: "draw",
    id,
    target: "map",
    topology: "triangle-list",
    vertexCount: 3,
    instances: 1,
    shader: SHADER,
    clear,
    ...(skipped === undefined ? {} : { skip: skipped }),
  });
  return {
    resources: [{ kind: "target", id: "map", size: [8, 8], format: "rgba8unorm" }],
    passes: [draw("clear", true, skip.clear), draw("near", false, skip.near), draw("far", false, skip.far)],
    diagnostics: [],
  };
}

async function rig() {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  await backend.initialize({});
  if (host.device === undefined) throw new Error("No mock device");
  const seen = { passes: 0, draws: 0, pipelines: 0 };
  const createEncoder = host.device.createCommandEncoder.bind(host.device);
  vi.spyOn(host.device, "createCommandEncoder").mockImplementation((descriptor) => {
    const encoder = createEncoder(descriptor);
    const begin = encoder.beginRenderPass.bind(encoder);
    vi.spyOn(encoder, "beginRenderPass").mockImplementation((passDescriptor) => {
      seen.passes += 1;
      const pass = begin(passDescriptor);
      const drawCall = pass.draw.bind(pass);
      vi.spyOn(pass, "draw").mockImplementation((...args) => {
        seen.draws += 1;
        drawCall(...args);
      });
      return pass;
    });
    return encoder;
  });
  const createPipeline = host.device.createRenderPipeline.bind(host.device);
  vi.spyOn(host.device, "createRenderPipeline").mockImplementation((descriptor) => {
    seen.pipelines += 1;
    return createPipeline(descriptor);
  });
  /** What one render asked of the device. */
  const frame = (compiled: Awaited<ReturnType<typeof backend.compile>>): { passes: number; draws: number } => {
    const before = { ...seen };
    backend.render(compiled, input);
    return { passes: seen.passes - before.passes, draws: seen.draws - before.draws };
  };
  return { backend, seen, frame };
}

describe("T1598b: a skipped draw is not encoded", () => {
  it("asks the device for no pass and no draw, and the flag moves both ways as a value", async () => {
    const { backend, seen, frame } = await rig();
    try {
      const spans: string[][] = [];
      backend.onCpuTimings((values) => spans.push(Object.keys(values)));
      const compiled = await backend.compile(plan({ far: true }));
      expect(frame(compiled)).toEqual({ passes: 2, draws: 2 });
      // The performance panel's rows are the passes that ran: the skipped one has none.
      expect(spans.at(-1)).toEqual(["clear", "near"]);

      const built = seen.pipelines;
      backend.updateUniforms({ passId: "far", values: {}, skip: false });
      expect(frame(compiled)).toEqual({ passes: 3, draws: 3 });
      expect(spans.at(-1)).toEqual(["clear", "near", "far"]);

      backend.updateUniforms({ passId: "near", values: {}, skip: true });
      backend.updateUniforms({ passId: "far", values: {}, skip: true });
      expect(frame(compiled)).toEqual({ passes: 1, draws: 1 });
      // §V5: a value. Nothing was built to turn a draw off or on again.
      expect(seen.pipelines).toBe(built);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("follows the plan when the same structure is compiled again with other draws skipped", async () => {
    const { backend, seen, frame } = await rig();
    try {
      const compiled = await backend.compile(plan({ far: true }));
      expect(frame(compiled)).toEqual({ passes: 2, draws: 2 });
      const built = seen.pipelines;
      // The structure key does not hold `skip`, so this is the values-only path (§V5).
      const again = await backend.compile(plan({ near: true }));
      expect(seen.pipelines).toBe(built);
      const spans: string[][] = [];
      backend.onCpuTimings((values) => spans.push(Object.keys(values)));
      expect(frame(again)).toEqual({ passes: 2, draws: 2 });
      expect(spans.at(-1)).toEqual(["clear", "far"]);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("still clears: a skipped pass that owns the clear opens its pass and draws nothing", async () => {
    const { backend, frame } = await rig();
    try {
      const compiled = await backend.compile(plan({ clear: true }));
      // Three passes (the clear's, empty, then the two casters), two draws.
      expect(frame(compiled)).toEqual({ passes: 3, draws: 2 });
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("names a pass that is not a draw instead of remembering a flag nothing reads", async () => {
    const { backend } = await rig();
    try {
      await backend.compile(plan());
      const reported: string[] = [];
      backend.onDiagnostic((diagnostic) => reported.push(diagnostic.message));
      backend.updateUniforms({ passId: "nowhere", values: {}, skip: true });
      expect(reported).toEqual(['updateUniforms() set skip on pass "nowhere", which is not a draw of this plan.']);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });
});
