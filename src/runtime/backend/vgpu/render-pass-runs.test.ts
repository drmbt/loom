import { describe, expect, it, vi } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { castersScene, type CastersScene } from "../../../nodes/definitions/shadow-casters.fixture.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { readExecutionPlan, renderPassRuns, runSpanName, spanBasePassId, spanSharedPasses } from "../plan.ts";
import { wgsl } from "../wgsl.ts";
import { countDeviceCalls, during } from "./device-calls.test-support.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T1604b — ONE DEVICE RENDER PASS PER RUN OF DRAWS, not one per draw.
 *
 * A Render's plan is a draw per geometry per target: the lit colour, each G-buffer layer,
 * each face of each shadow. Every one of them used to open a device render pass of its own
 * (two hundred a frame for a scene of thirteen geometries), and a pass is what costs: the
 * encode and the submit on the CPU, a store and a load of the target on a tile-based GPU.
 *
 * The plan is unchanged. `renderPassRuns` says which draws one device pass can hold, the
 * encoder groups by it, and everything below is about what the DEVICE was asked to do,
 * which no picture shows: grouped or not, the frame is byte for byte the same
 * (`render-pass-runs.gpu.test.ts`).
 */

const input: FrameInputs = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [8, 8],
};

const DRAW = wgsl`
  @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
  @fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }`;
const EFFECT = wgsl`
  @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }`;

const draw = (id: string, target: string, clear: boolean, nodeId = "render") => ({ kind: "draw", id, nodeId, target, topology: "triangle-list", vertexCount: 3, instances: 1, shader: DRAW, clear });
const effect = (id: string, target: string) => ({ kind: "effect", id, nodeId: "effect", target, shader: EFFECT });
const target = (id: string) => ({ kind: "target", id, size: [8, 8], format: "rgba8unorm" });

/**
 * A Render in miniature: a shadow map (cleared, three casters), the colour (a backdrop that
 * clears, two geometries), a Normal layer (cleared, two geometries), a post effect, and one
 * more node drawing over the colour afterwards.
 */
function scene(): LogicalExecutionPlan {
  return {
    resources: [target("shadow"), target("color"), target("normal"), target("post")],
    passes: [
      draw("shadow:clear", "shadow", true),
      draw("shadow:0", "shadow", false),
      draw("shadow:1", "shadow", false),
      draw("shadow:2", "shadow", false),
      draw("backdrop", "color", true),
      draw("lit:0", "color", false),
      draw("lit:1", "color", false),
      draw("normal:clear", "normal", true),
      draw("normal:0", "normal", false),
      draw("normal:1", "normal", false),
      effect("grade", "post"),
      draw("overlay", "color", false, "overlay"),
    ],
    diagnostics: [],
  };
}

const runsOf = (plan: LogicalExecutionPlan): string[][] => renderPassRuns(readExecutionPlan(plan).passes).map((run) => [...run.passIds]);

describe("T1604b: where the device's render passes are (renderPassRuns)", () => {
  it("is one run per target a node draws into in a row: the first may clear, the rest must not", () => {
    expect(runsOf(scene())).toEqual([
      ["shadow:clear", "shadow:0", "shadow:1", "shadow:2"],
      ["backdrop", "lit:0", "lit:1"],
      ["normal:clear", "normal:0", "normal:1"],
      // After the effect, and another node's: a pass of its own.
      ["overlay"],
    ]);
  });

  it("ends a run at a draw that clears, at another target, at another node, and at anything that is not a draw", () => {
    const plan = (passes: unknown[]): LogicalExecutionPlan => ({ resources: [target("a"), target("b"), { kind: "pingPong", id: "pair", size: [8, 8], format: "rgba8unorm" }], passes, diagnostics: [] });
    // A second clear: what the first run drew would be wiped, so it cannot be the same pass.
    expect(runsOf(plan([draw("x", "a", true), draw("y", "a", true), draw("z", "a", false)]))).toEqual([["x"], ["y", "z"]]);
    // Another target between two draws of the same one: order is kept, so three passes.
    expect(runsOf(plan([draw("x", "a", true), draw("y", "b", true), draw("z", "a", false)]))).toEqual([["x"], ["y"], ["z"]]);
    // Another node: its GPU time is its own, so its draws are its own pass.
    expect(runsOf(plan([draw("x", "a", true, "one"), draw("y", "a", false, "two"), draw("z", "a", false, "two")]))).toEqual([["x"], ["y", "z"]]);
    // A swap between them: the halves move, so the pass ends.
    expect(runsOf(plan([draw("x", "a", true), { kind: "swap", id: "s", resourceId: "pair" }, draw("y", "a", false)]))).toEqual([["x"], ["y"]]);
    expect(runsOf(plan([draw("x", "a", true), effect("e", "b"), draw("y", "a", false)]))).toEqual([["x"], ["y"]]);
  });

  it("ends a run at a loop marker, so a substep region keeps its boundary", () => {
    const passes = [
      draw("before", "a", true),
      { kind: "loop", id: "begin", loopId: "steps", edge: "begin", count: 3 },
      draw("step:0", "a", false),
      draw("step:1", "a", false),
      { kind: "loop", id: "end", loopId: "steps", edge: "end" },
      draw("after", "a", false),
    ];
    expect(runsOf({ resources: [target("a")], passes, diagnostics: [] })).toEqual([["before"], ["step:0", "step:1"], ["after"]]);
  });

  it("names a run's span for its head and for how many passes share it, and a lone draw's as before", () => {
    expect(runSpanName("shot#shot:scene:0", 0)).toBe("shot#shot:scene:0");
    expect(runSpanName("shot#shot:scene:0", 13)).toBe("shot#shot:scene:0+13");
    // A reader that knows nothing of runs bills the span to the head: the right node.
    expect(spanBasePassId("shot#shot:scene:0+13")).toBe("shot#shot:scene:0");
    expect(spanBasePassId("shot#shot:scene:0+13~2")).toBe("shot#shot:scene:0");
    expect(spanBasePassId("shot#shot:scene:0~2")).toBe("shot#shot:scene:0");
    expect(spanSharedPasses("shot#shot:scene:0+13~2")).toBe(13);
    expect(spanSharedPasses("shot#shot:scene:0+13")).toBe(13);
    expect(spanSharedPasses("shot#shot:scene:0~2")).toBe(0);
    expect(spanSharedPasses("shot#shot:scene:0")).toBe(0);
    // A pass id that merely contains the separators keeps its own name.
    expect(spanBasePassId("a+b")).toBe("a+b");
    expect(spanSharedPasses("a+b")).toBe(0);
  });
});

async function rig(features: ReadonlyArray<GPUFeatureName> = []) {
  const host = mockGpuHost({ features });
  const backend = createVgpuBackend({ host });
  await backend.initialize(features.length === 0 ? {} : { requiredFeatures: [...features] });
  const seen = countDeviceCalls(host);
  return { backend, seen };
}

describe("T1604b: the backend opens one device render pass per run", () => {
  it("asks the device for exactly the runs and the effects: 5 render passes for 12 plan passes, every draw still drawn", async () => {
    const { backend, seen } = await rig();
    try {
      const compiled = await backend.compile(scene());
      // Four runs and one effect. Three of them clear (the shadow map, the colour, the Normal layer) and so does the effect.
      expect(during(seen, () => backend.render(compiled, input))).toEqual({ renderPasses: 5, clears: 4, draws: 12, pipelines: 0 });
      // One pass per draw, on request: the same plan, the same draws, nothing rebuilt.
      backend.setExactPassTiming(true);
      expect(during(seen, () => backend.render(compiled, input))).toEqual({ renderPasses: 12, clears: 4, draws: 12, pipelines: 0 });
      backend.setExactPassTiming(false);
      expect(during(seen, () => backend.render(compiled, input))).toEqual({ renderPasses: 5, clears: 4, draws: 12, pipelines: 0 });
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("does it on the open-frame path the app runs, the same", async () => {
    const { backend, seen } = await rig();
    try {
      const compiled = await backend.compile(scene());
      vi.useFakeTimers();
      const asked = during(seen, () => {
        const loop = backend.loop(() => backend.render(compiled, input), { scheduler: "timer", fps: 60 });
        vi.advanceTimersByTime(17);
        loop.stop();
      });
      expect(asked).toEqual({ renderPasses: 5, clears: 4, draws: 12, pipelines: 0 });
    } finally {
      backend.dispose();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("keeps a loop's boundary: each iteration's draws are their own pass, and the count is a value", async () => {
    const { backend, seen } = await rig();
    try {
      const compiled = await backend.compile({
        resources: [target("a")],
        passes: [
          draw("before", "a", true),
          { kind: "loop", id: "begin", loopId: "steps", edge: "begin", count: 3 },
          draw("step:0", "a", false),
          draw("step:1", "a", false),
          { kind: "loop", id: "end", loopId: "steps", edge: "end" },
          draw("after", "a", false),
        ],
        diagnostics: [],
      });
      // before | step, step | step, step | step, step | after — never one pass of eight draws.
      expect(during(seen, () => backend.render(compiled, input))).toEqual({ renderPasses: 5, clears: 1, draws: 8, pipelines: 0 });
      backend.updateUniforms({ passId: "begin", values: { count: 1 } });
      expect(during(seen, () => backend.render(compiled, input))).toEqual({ renderPasses: 3, clears: 1, draws: 4, pipelines: 0 });
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("gives a run ONE GPU span, named for its head and its sharers; one pass per draw gives every draw its own", async () => {
    const { backend } = await rig(["timestamp-query"]);
    try {
      const results: string[][] = [];
      backend.onGpuTimings((spans) => results.push(Object.keys(spans)));
      const compiled = await backend.compile(scene());
      const timed = async (): Promise<string[]> => {
        results.length = 0;
        backend.render(compiled, input);
        await backend.whenSettled();
        for (let attempt = 0; attempt < 200 && results.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
        return (results[0] ?? []).slice().sort();
      };
      // The run's passes share the span: no number is divided among them.
      expect(await timed()).toEqual(["backdrop+2", "grade", "normal:clear+2", "overlay", "shadow:clear+3"]);
      // Every name is billed to a pass of the plan, and to the node that owns the whole run.
      expect((await timed()).map(spanBasePassId)).toEqual(["backdrop", "grade", "normal:clear", "overlay", "shadow:clear"]);

      backend.setExactPassTiming(true);
      expect(await timed()).toEqual(
        ["backdrop", "grade", "lit:0", "lit:1", "normal:0", "normal:1", "normal:clear", "overlay", "shadow:0", "shadow:1", "shadow:2", "shadow:clear"],
      );
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("keeps the CPU half per draw: every draw of a run reports its own encode time", async () => {
    const { backend } = await rig();
    try {
      const spans: string[][] = [];
      backend.onCpuTimings((values) => spans.push(Object.keys(values)));
      const compiled = await backend.compile(scene());
      backend.render(compiled, input);
      expect(spans.at(-1)).toEqual(["shadow:clear", "shadow:0", "shadow:1", "shadow:2", "backdrop", "lit:0", "lit:1", "normal:clear", "normal:0", "normal:1", "grade", "overlay"]);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });
});

/*
 * THE RENDER'S OWN PLAN. The rule above only pays if the Render emits its draws so that
 * runs can form: a layer's draws together, and nothing of another target between the draws
 * of the colour. The scene is `shadow-casters.fixture.ts` (four geometries, two casting
 * point lights) with the Depth and Normal outputs read: 66 plan passes.
 */
describe("T1604b: a Render's frame is a handful of device render passes", () => {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const SETTINGS = { outputResolution: { width: 64, height: 64 }, workingFormat: "rgba8unorm", randomSeed: 7, previewLongEdge: 192, previewFps: 20, limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 } } as never;
  const CAPABILITIES = { tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"], timestampQuery: false, limits: { maxTextureDimension2D: 8192 } } as never;
  const compiledScene = (options: CastersScene = {}) => {
    const plan = compileGraph({
      graph: castersScene({ ...options, render: { depthOutput: true, normalOutput: true, ...options.render } }),
      settings: SETTINGS,
      registry,
      capabilities: CAPABILITIES,
      sinks: [
        { nodeId: "render_shot", portId: "depth", kind: "preview" },
        { nodeId: "render_shot", portId: "normal", kind: "preview" },
      ],
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return plan;
  };
  /** Each run as "where it draws: how many draws", in plan order. A layered target is named with the run's layer (T1623b slice 4). */
  const shape = (plan: ReturnType<typeof compiledScene>): string[] =>
    renderPassRuns(plan.passes, plan.resources).map(
      (run) => `${run.target.replace(/^(scratch|target):render_shot:/, "")}${run.layer === undefined ? "" : `@${String(run.layer)}`}: ${String(run.passIds.length)}`,
    );

  it("is one pass per shadow atlas, one for the Depth output, one for the colour and one per layer", () => {
    const plan = compiledScene();
    expect(plan.passes.filter((pass) => pass.kind === "draw")).toHaveLength(65);
    // Six faces of a cube share an atlas: a clear and 6 × 4 casters. The colour is the backdrop and four geometries.
    // T1623b slice 4: each light's atlas is a layer of one array, and a layer is a run: the same two runs of 25.
    expect(shape(plan)).toEqual(["shadowCubes@0: 25", "shadowCubes@1: 25", "depth: 5", "out: 5", "normal: 5"]);
  });

  it("asks the device for exactly those: 6 render passes where one per draw is 35", async () => {
    const { backend, seen } = await rig();
    try {
      const plan = compiledScene();
      const compiled = await backend.compile(plan);
      // 31 of the 48 sweep draws are out of their light's reach and skipped (T1598b), so 35
      // draws are encoded. Five runs and the output's own pass hold them.
      expect(plan.passes.filter((pass) => pass.kind === "draw" && pass.skip === true)).toHaveLength(31);
      expect(during(seen, () => backend.render(compiled, input))).toEqual({ renderPasses: 6, clears: 6, draws: 35, pipelines: 0 });
      backend.setExactPassTiming(true);
      expect(during(seen, () => backend.render(compiled, input))).toEqual({ renderPasses: 35, clears: 6, draws: 35, pipelines: 0 });
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("keeps an additive surface in the colour's run: it is drawn last, into the same pass, and is in no other", () => {
    // B256/T1411b: additive geometry is light. It is left out of the Depth output and of
    // every layer, so those runs lose a draw and no boundary moves; in the colour it comes
    // after the opaque draws and extends their pass rather than opening one of its own.
    const plan = compiledScene({ geometry: { lid: { blend: "additive" } } });
    // The lid casts no shadow either: each atlas is a clear and 6 × 3 casters.
    expect(shape(plan)).toEqual(["shadowCubes@0: 19", "shadowCubes@1: 19", "depth: 4", "out: 5", "normal: 4"]);
    const colour = renderPassRuns(plan.passes, plan.resources).find((run) => run.target === "target:render_shot:out");
    // Geometry 2 is the lid: last, after the far cube (3).
    expect(colour?.passIds.map((id) => id.replace("render_shot#render_shot:", ""))).toEqual(["backdrop", "scene:0", "scene:1", "scene:3", "scene:2"]);
  });

  it("leaves a multisampled colour target one pass per draw, and still groups everything else", () => {
    // Measured on a project's scene: grouped, a multisampled target differed from one pass per
    // draw by one unit in the last place on a few pixels (see `renderPassRuns`). The picture
    // must not depend on who is measuring, so such a target is left alone.
    const plan = compiledScene({ render: { antialias: "msaa" } });
    expect(shape(plan)).toEqual(["shadowCubes@0: 25", "shadowCubes@1: 25", "depth: 5", "out: 1", "out: 1", "out: 1", "out: 1", "out: 1", "normal: 5"]);
  });
});
