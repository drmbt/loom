// @vitest-environment jsdom
import { Buffer } from "node:buffer";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { renderFrameRange } from "./render-range.ts";
import { useRuntimeCommands } from "./runtime-commands.ts";
import { transportHolderFor, type TransportHandlers } from "./transport-commands.ts";
import { useFrameLoop } from "./use-frame-loop.ts";
import { useGraphCompile } from "./use-graph-compile.ts";
import type { BackendCapabilities, CompiledExecutionPlan, FrameInputs, LogicalExecutionPlan } from "../domain/types/backend.ts";
import type { ProjectDocument } from "../domain/types/graph.ts";
import { animatedNoiseFieldDocument } from "../examples/documents/animated-noise-field.ts";
import { expressionSlot } from "../examples/documents/builders.ts";
import { feedbackEchoDocument } from "../examples/documents/feedback-echo.ts";
import type { LoomBackend } from "../runtime/backend/index.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { createExportInterface, exportOutputsFrom, readbackSourceFromBackend } from "../runtime/export/index.ts";
import type { ExportInterface, VideoEncoderSink } from "../runtime/export/index.ts";

/**
 * VN71/T1687b — A SEEK JUMPS, AND A TAKE STARTS WHERE IT SAYS (§V170 as amended).
 *
 * The owner's ruling (2026-10-07), TouchDesigner's behaviour: a seek renders the target frame
 * and leaves temporal state as it is — feedback depends on the previous frame, and N frames
 * of feedback are what playing N frames gives. A take is a fresh performance: it clears
 * temporal state and starts at its in point, less the pre-roll the user asked for.
 *
 * Through the app's own wiring — `useGraphCompile` feeding `useFrameLoop` (and the reset
 * command `useRuntimeCommands` registers) over a real vgpu backend on Dawn, with no scheduler:
 * the loop is paused and every render is one a seek, a step or a take asked for. Read where
 * the consumer reads it: the frames `backend.render` was handed, and the output's bytes
 * through the export interface (§V48).
 */

afterEach(cleanup);

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const FPS = 60;
/** One hour at 60 fps: the gate's range, 21.6 times the 10 000 frames the range used to stop at. */
const HOUR = 216_000;

/**
 * E3 with its noise moved by TIMELINE time. As shipped, its `speed` advances on the ABSOLUTE
 * clock, which keeps counting through a seek by design (T461), so frame 600 after a jump and
 * frame 600 after 0..599 differ for a reason that is not the seek. Still stateless.
 */
function timelineNoise(): ProjectDocument {
  const document = structuredClone(animatedNoiseFieldDocument);
  const field = document.graph.nodes["field"]!;
  field.parameters = { ...field.parameters, speed: 0, t4d: expressionSlot("0.37 + time * 0.35", 0.37) };
  return document;
}

interface Rig {
  readonly runtime: AppRuntime;
  /** Opens `document` the way the app does: a NEW runtime around the same backend (`adoptDocument`). */
  reload(document: ProjectDocument): Promise<void>;
  readonly renders: number[];
  transport(): TransportHandlers;
  seek(frameIndex: number): Promise<{ status: string; frameIndex: number }>;
  step(frames: number): Promise<void>;
  /** The output node's bytes as the last rendered frame left them. */
  read(): Promise<Buffer>;
  /** A take of project frames `start..end` with `preRollFrames`: each recorded frame's RGBA8. */
  take(start: number, end: number, preRollFrames: number): Promise<Buffer[]>;
  dispose(): void;
}

async function mount(document: ProjectDocument): Promise<Rig> {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const real = createVgpuBackend({ host: nodeGpuHost() });
  await real.initialize({});
  const renders: number[] = [];
  const backend = new Proxy(real, {
    get(target, property, receiver) {
      // No scheduler: every render below is one a seek, a step or a take asked for.
      if (property === "loop") return () => ({ stop() {} });
      if (property === "compile") return async (plan: LogicalExecutionPlan): Promise<CompiledExecutionPlan> => target.compile(plan);
      if (property === "render") {
        return (compiled: CompiledExecutionPlan, inputs: FrameInputs) => {
          renders.push(inputs.frame.frameIndex);
          target.render(compiled, inputs);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as LoomBackend;

  const open = (opened: ProjectDocument): AppRuntime =>
    createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
      document: {
        ...structuredClone(opened),
        settings: { ...opened.settings, fps: FPS, frameRange: { start: 0, end: HOUR - 1 }, outputResolution: { width: 64, height: 36 } },
      },
    });
  let runtime = open(document);
  const retired: AppRuntime[] = [];
  const view = renderHook(({ runtime }: { readonly runtime: AppRuntime }) => {
    const compiled = useGraphCompile(runtime, CAPABILITIES);
    useRuntimeCommands({ bus: runtime.bus, backend, compiled: compiled.compiled });
    return useFrameLoop({
      bus: runtime.bus,
      backend,
      compiled: compiled.compiled,
      settings: runtime.settings,
      animate: compiled.animate,
      valuesOnly: compiled.valuesOnly,
      resetFeedback: compiled.resetFeedback,
      documentBoundary: compiled.documentBoundary,
      warmPlan: compiled.warmPlan,
      timeline: compiled.timeline,
      telemetry: runtime.telemetry,
    });
  }, { initialProps: { runtime } });
  await waitFor(() => expect(view.result.current.installedPlan).not.toBeNull(), { timeout: 20_000 });
  await act(async () => {
    await runtime.bus.execute("transport.pause", {}, runtime.invocation);
  });
  const exports: ExportInterface = createExportInterface({
    source: readbackSourceFromBackend(real),
    outputs: () => exportOutputsFrom(view.result.current.installedPlan?.outputs ?? []),
    isPlaying: () => false,
  });
  const outputRef = () => {
    const found = exports.listOutputs().find((output) => output.ref.nodeId === "out");
    if (found === undefined) throw new Error("no output for out");
    return found;
  };
  const transport = (): TransportHandlers => {
    const handlers = transportHolderFor(runtime.bus).current;
    if (handlers === null) throw new Error("no transport");
    return handlers;
  };
  return {
    get runtime() {
      return runtime;
    },
    reload: async (opened) => {
      const before = view.result.current.installedPlan;
      retired.push(runtime);
      runtime = open(opened);
      renders.length = 0;
      view.rerender({ runtime });
      // The load's install, and the boundary's frame 0 behind it (`use-frame-loop.ts`).
      await waitFor(() => {
        expect(view.result.current.installedPlan).not.toBe(before);
        expect(renders).toContain(0);
      }, { timeout: 20_000 });
      await act(async () => {
        await runtime.bus.execute("transport.pause", {}, runtime.invocation);
      });
    },
    renders,
    transport,
    seek: async (frameIndex) => {
      let result: { status: string; output: { frameIndex: number } } | undefined;
      await act(async () => {
        result = await runtime.bus.execute("transport.seek", { frameIndex }, runtime.invocation);
      });
      if (result === undefined) throw new Error("the seek returned nothing");
      return { status: result.status, frameIndex: result.output.frameIndex };
    },
    step: async (frames) => {
      await act(async () => {
        await runtime.bus.execute("transport.stepFrame", { frames }, runtime.invocation);
      });
    },
    read: async () => Buffer.from((await real.readOutput(outputRef().resourceId)).bytes),
    take: async (start, end, preRollFrames) => {
      const frames: Buffer[] = [];
      const encoder: VideoEncoderSink = {
        configure() {},
        encode(frame) {
          frames.push(Buffer.from(frame.image.data));
        },
        finish: async () => ({ mimeType: "video/mp4", bytes: new Uint8Array(), frameCount: frames.length, durationSeconds: 0 }),
      };
      const handlers = transport();
      await act(async () => {
        await renderFrameRange({
          api: exports,
          ref: outputRef().ref,
          range: { start, end },
          timelineFps: FPS,
          outputFps: FPS,
          preRollFrames,
          encoder,
          transport: {
            isPlaying: handlers.isPlaying,
            togglePlay: handlers.togglePlay,
            seek: handlers.seek,
            stepOnce: handlers.stepOnce,
            latestFrame: () => view.result.current.latestFrame(),
            resetAbsoluteClock: handlers.resetAbsoluteClock,
            resetState: handlers.resetState,
          },
        });
      });
      return frames;
    },
    dispose: () => {
      view.unmount();
      for (const old of retired) old.dispose();
      runtime.dispose();
      real.dispose();
    },
  };
}

describe("VN71 — a seek jumps; a take starts where it says", () => {
  it("a stateless 60 fps document with a 216 000-frame range seeks to its last frame in ONE render — the play-through's frame", async () => {
    const rig = await mount(timelineNoise());
    try {
      rig.renders.length = 0;
      expect(await rig.seek(HOUR - 1)).toEqual({ status: "applied", frameIndex: HOUR - 1 });
      expect(rig.renders).toEqual([HOUR - 1]);

      // And the frame it rendered is THE frame: a jump to 600 against 0..600 stepped in order.
      await rig.seek(600);
      const jumped = await rig.read();
      await rig.seek(0);
      const zero = await rig.read();
      await rig.step(600);
      expect(rig.renders.at(-1)).toBe(600);
      expect(jumped.equals(await rig.read())).toBe(true);
      // Not because every frame is one picture.
      expect(jumped.equals(zero)).toBe(false);
    } finally {
      rig.dispose();
    }
  }, 120_000);

  it("a feedback document seeks far ahead in ONE render, its trail carrying on from its buffer; the reset command then clears it", async () => {
    const rig = await mount(feedbackEchoDocument);
    try {
      const far = 100_000;
      // E2's LFOs read the ABSOLUTE clock (§V453), which counts on through every seek by
      // design (T461), so each compared frame is rendered at the same absolute count: what
      // differs between them is then the echo's history and nothing else.
      const at = async (frameIndex: number): Promise<void> => {
        await act(async () => {
          rig.transport().resetAbsoluteClock(frameIndex);
        });
        await rig.seek(frameIndex);
      };
      // What frame `far` looks like over CLEARED history: the reference for "reset" below.
      await act(async () => {
        rig.transport().resetState();
      });
      await at(far);
      const cleared = await rig.read();

      // Build a trail, then jump: one render, and the picture is NOT the cleared one —
      // the echo carried what 0..90 left in it across the seek.
      await rig.seek(0);
      await rig.step(90);
      rig.renders.length = 0;
      await act(async () => {
        rig.transport().resetAbsoluteClock(far);
      });
      expect(await rig.seek(far)).toEqual({ status: "applied", frameIndex: far });
      expect(rig.renders).toEqual([far]);
      const carried = await rig.read();
      expect(carried.equals(cleared)).toBe(false);

      // The reset is the user's: after it, the same jump is the cleared picture again.
      await act(async () => {
        await rig.runtime.bus.execute("runtime.resetFeedback", {}, rig.runtime.invocation);
      });
      await at(far);
      expect((await rig.read()).equals(cleared)).toBe(true);
    } finally {
      rig.dispose();
    }
  }, 120_000);

  it("a LOAD starts fresh: a document opened over a built-up trail shows none of it (the boundary's resetState)", async () => {
    const rig = await mount(feedbackEchoDocument);
    try {
      // A cold open's frame 0: the reference.
      await rig.seek(0);
      const cold = await rig.read();
      // Build a trail, so the echo holds something a load must not carry.
      await rig.step(90);
      expect((await rig.read()).equals(cold)).toBe(false);
      // The same file opened again: the backend keeps feedback pairs by resource id, and the
      // two documents share every id, so only the boundary's clear stands between frame 0
      // and the trail. A seek no longer clears anything, so the boundary must.
      await rig.reload(feedbackEchoDocument);
      // The frame the boundary itself rendered — a further seek would echo it once more. A new
      // runtime is a new clock, so its absolute count is the cold open's too.
      expect(rig.renders).toEqual([0]);
      expect((await rig.read()).equals(cold)).toBe(true);
    } finally {
      rig.dispose();
    }
  }, 120_000);

  it("a take's pre-roll changes its first frame on a feedback document and nothing on a stateless one", async () => {
    const feedback = await mount(feedbackEchoDocument);
    try {
      const bare = await feedback.take(120, 121, 0);
      const rolled = await feedback.take(120, 121, 30);
      expect(bare).toHaveLength(2);
      expect(rolled).toHaveLength(2);
      expect(bare[0]!.equals(rolled[0]!)).toBe(false);
      // A take clears what it found: the same take twice is the same file, whatever the
      // transport held between them.
      await feedback.step(45);
      expect((await feedback.take(120, 121, 0))[0]!.equals(bare[0]!)).toBe(true);
    } finally {
      feedback.dispose();
    }
    // E3 as shipped: stateless, and its noise moves on the ABSOLUTE clock, so this half also
    // holds the take to starting its count AT the entry — the in point carries the in point's
    // abstime however long the pre-roll was, or the two takes differ here.
    const stateless = await mount(animatedNoiseFieldDocument);
    try {
      const bare = await stateless.take(120, 121, 0);
      const rolled = await stateless.take(120, 121, 30);
      expect(bare[0]!.equals(rolled[0]!)).toBe(true);
      expect(bare[1]!.equals(rolled[1]!)).toBe(true);
    } finally {
      stateless.dispose();
    }
  }, 180_000);

  it("past one day at the project rate, a seek is refused and renders nothing", async () => {
    const rig = await mount(timelineNoise());
    try {
      rig.renders.length = 0;
      expect((await rig.seek(86_400 * FPS)).status).toBe("rejected");
      expect(rig.renders).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 120_000);
});
