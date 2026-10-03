// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { transportHolderFor, type TransportHandlers } from "../../app/transport-commands.ts";
import { useFrameLoop } from "../../app/use-frame-loop.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";
import type { BackendCapabilities, CompiledExecutionPlan, FrameInputs, LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { parseCueList, serializeCueList } from "../../domain/presets/cue-list.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { setListDocument } from "../../examples/documents/set-list.ts";
import type { LoomBackend } from "../../runtime/backend/index.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";

/**
 * §T1537b — THE LIVE LOOP SWITCHES STRUCTURE ON THE CUE FRAME, AND COMPILES ONCE PER CROSSING.
 *
 * The app's own wiring — `useGraphCompile` feeding `useFrameLoop` — over a real vgpu backend
 * on Dawn, with the scheduler replaced by this test's hand (`loop` captures the tick).
 * E82 (the set list) with its cue list FOLLOWING the timeline: "1 open" at 0 s turns the grid
 * and FX layers off, "3 cross" at 1.0 s turns the grid on, "4 drop" at 1.5 s turns the rings
 * off and the FX on, "5 out" at 2.5 s turns the rings back on — four structures, three
 * crossings after the first frame (frames 60, 90 and 150 at 60 fps).
 *
 * Claimed, each read where its consumer reads it — the plan handed to `backend.render` for
 * each frame, the calls `backend.compile` received, the build the backend reports:
 *   - every rendered frame is on the plan of its own playhead's structure;
 *   - the frame BEFORE a crossing asks for the next segment, so its plan is installed with no
 *     further frame — the crossing frame then renders at once (no hold);
 *   - exactly ONE structural compile per crossing, none between, and none builds an Effect
 *     (the next segment was compiled and warmed after the previous install, §T1507b);
 *   - when a frame needing a new structure arrives before its plan is installed, the
 *     scheduled loop HOLDS it and renders it once the plan lands — late, never wrong.
 *
 * MEASURED, printed with LOOM_MEASURE=1: ask (the frame before the crossing) → install, ms.
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
const SETTINGS = { ...setListDocument.settings, fps: FPS, outputResolution: { width: 160, height: 90 } };
const TIMES: Readonly<Record<string, number>> = { "1 open": 0, "2 warm": 0.5, "3 cross": 1, "4 drop": 1.5, "5 out": 2.5 };
const CROSSINGS = [60, 90, 150] as const;

/** E82 with its cue list following the timeline at {@link TIMES}. */
function timedSetList(): GraphDocument {
  const graph = structuredClone(setListDocument.graph) as GraphDocument;
  const list = graph.nodes["set"]!;
  const parsed = parseCueList(list.parameters["cues"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  const cues = parsed.list.cues.map((cue) => ({ ...cue, at: TIMES[cue.name] as number }));
  list.parameters = { ...list.parameters, follow: "timeline", cues: serializeCueList({ version: 1, cues }) };
  return graph;
}

interface Layers {
  readonly rings: boolean;
  readonly grid: boolean;
  readonly fx: boolean;
}

/** Which layers a frame's playhead has on, from the show above. */
const expectedOn = (frame: number): Layers => ({ rings: frame < 90 || frame >= 150, grid: frame >= 60, fx: frame >= 90 });

/** Which layers a plan carries — a bypassed Layer emits no pass (§T1498b). */
function layersOf(plan: LogicalExecutionPlan | undefined): Layers | null {
  if (plan === undefined) return null;
  const has = (nodeId: string): boolean => plan.passes.some((pass) => (pass as { readonly id: string }).id.startsWith(`${nodeId}#`));
  return { rings: has("layerRings"), grid: has("layerGrid"), fx: has("layerFx") };
}

interface Rig {
  readonly renders: Array<{ frame: number; plan: LogicalExecutionPlan | undefined }>;
  readonly compiles: Array<{ plan: LogicalExecutionPlan; at: number; effectsBuilt: number; effectsWarmed: number }>;
  /** The scheduled loop's tick, as `backend.loop` was handed it (null until the loop starts). */
  tick(): void;
  transport(): TransportHandlers;
  readonly reported: string[];
  diagnostics(): readonly unknown[];
  dispose(): void;
}

async function mount(): Promise<Rig> {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const real = createVgpuBackend({ host: nodeGpuHost() });
  const reported: string[] = [];
  real.onDiagnostic((entry) => {
    if (entry.severity !== "info") reported.push(`${entry.severity} ${entry.code}: ${entry.message}`);
  });
  await real.initialize({});
  let scheduled: (() => void) | null = null;
  const logical = new Map<string, LogicalExecutionPlan>();
  const compiles: Rig["compiles"] = [];
  const renders: Rig["renders"] = [];
  const backend = new Proxy(real, {
    get(target, property, receiver) {
      if (property === "loop") {
        return (onFrame: () => void) => {
          scheduled = onFrame;
          return {
            stop() {
              if (scheduled === onFrame) scheduled = null;
            },
          };
        };
      }
      if (property === "compile") {
        return async (plan: LogicalExecutionPlan): Promise<CompiledExecutionPlan> => {
          const compiled = await target.compile(plan);
          logical.set(compiled.id, plan);
          const build = target.status.lastBuild;
          compiles.push({ plan, at: performance.now(), effectsBuilt: build?.effectsBuilt ?? 0, effectsWarmed: build?.effectsWarmed ?? 0 });
          return compiled;
        };
      }
      if (property === "render") {
        return (compiled: CompiledExecutionPlan, inputs: FrameInputs) => {
          renders.push({ frame: inputs.frame.frameIndex, plan: logical.get(compiled.id) });
          target.render(compiled, inputs);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as LoomBackend;

  const runtime: AppRuntime = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
    document: { ...structuredClone(setListDocument), graph: timedSetList(), settings: SETTINGS },
  });
  const view = renderHook(() => {
    const compiled = useGraphCompile(runtime, CAPABILITIES);
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
    });
  });
  await waitFor(() => expect(view.result.current.installedPlan).not.toBeNull(), { timeout: 20_000 });
  return {
    renders,
    compiles,
    tick: () => {
      if (scheduled === null) throw new Error("the loop is not running");
      scheduled();
    },
    transport: () => {
      const handlers = transportHolderFor(runtime.bus).current;
      if (handlers === null) throw new Error("no transport");
      return handlers;
    },
    reported,
    diagnostics: () => view.result.current.diagnostics,
    dispose: () => {
      view.unmount();
      runtime.dispose();
      real.dispose();
    },
  };
}

/** A macrotask turn or two, as the gap between display frames gives the warm-up. */
const gap = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("§T1537b — the live loop: exact crossings, one compile each, warmed", () => {
  it("E82 timed, frame by frame: each crossing's plan is installed before its frame — once, warmed — and every frame is in its own structure", async () => {
    const rig = await mount();
    try {
      // Frame 0's structure is the first compile: grid and FX off (cue "1 open" at 0 s).
      expect(layersOf(rig.compiles[0]?.plan)).toEqual(expectedOn(0));
      const initial = rig.compiles.length;
      // Paused, so every step is exactly one frame (the clock catches up on wall time only
      // while the loop runs).
      await act(async () => {
        rig.transport().togglePlay();
        await gap();
      });
      expect(rig.transport().isPlaying()).toBe(false);

      const lead: number[] = [];
      for (let frame = 0; frame <= 170; frame += 1) {
        const askedAt = performance.now();
        await act(async () => {
          expect(rig.transport().stepFrame(1)).toBe(frame);
          await gap();
        });
        // THE ASK-AHEAD: having rendered frame c − 1, the loop has already asked for c's
        // segment — its install arrives with no further frame stepped. One compile per
        // crossing reached by the NEXT frame, and none between.
        const owed = CROSSINGS.filter((crossing) => crossing <= frame + 1).length;
        await waitFor(() => expect(rig.compiles.length).toBe(initial + owed), { timeout: 10_000 });
        if (CROSSINGS.includes((frame + 1) as (typeof CROSSINGS)[number])) lead.push((rig.compiles.at(-1)?.at ?? askedAt) - askedAt);
      }

      // EXACT: every rendered frame on its own structure.
      const stepped = rig.renders.filter((entry) => entry.frame <= 170);
      expect(stepped.map((entry) => entry.frame)).toEqual(Array.from({ length: 171 }, (_, index) => index));
      const wrong = stepped.filter((entry) => JSON.stringify(layersOf(entry.plan)) !== JSON.stringify(expectedOn(entry.frame)));
      expect(wrong.map((entry) => entry.frame)).toEqual([]);

      const crossingCompiles = rig.compiles.slice(initial);
      expect(crossingCompiles.map((entry) => layersOf(entry.plan))).toEqual(CROSSINGS.map(expectedOn));
      // Warmed: each crossing adopted what the warm-up built, and built nothing itself.
      expect(crossingCompiles.map((entry) => entry.effectsBuilt)).toEqual([0, 0, 0]);
      expect(crossingCompiles.every((entry) => entry.effectsWarmed > 0)).toBe(true);

      if (process.env["LOOM_MEASURE"] === "1") {
        console.info(
          `§T1537b crossing (Dawn, E82 160×90, jsdom React): ask→install ms ${lead.map((ms) => ms.toFixed(1)).join(", ")}; ` +
            `effectsWarmed ${crossingCompiles.map((entry) => entry.effectsWarmed).join(", ")}`,
        );
      }
      expect(rig.diagnostics()).toEqual([]);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 180_000);

  it("a take's order — prepareFrame(n), then the step — renders every frame in its own structure with no waiting between", async () => {
    const rig = await mount();
    try {
      await act(async () => {
        rig.transport().togglePlay();
        await gap();
      });
      const prepare = rig.transport().prepareFrame;
      if (prepare === undefined) throw new Error("the frame loop offers no prepareFrame");
      const from = rig.renders.length;
      // `renderFrameRange`'s own sequence, back to back: seek(0), then step — each frame
      // prepared first, and nothing else given time to happen.
      await act(async () => {
        await prepare(0);
        rig.transport().seek(0);
        for (let frame = 1; frame <= 160; frame += 1) {
          await prepare(frame);
          rig.transport().stepOnce();
        }
      });
      const take = rig.renders.slice(from);
      expect(take.map((entry) => entry.frame)).toEqual(Array.from({ length: 161 }, (_, index) => index));
      const wrong = take.filter((entry) => JSON.stringify(layersOf(entry.plan)) !== JSON.stringify(expectedOn(entry.frame)));
      expect(wrong.map((entry) => entry.frame)).toEqual([]);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 180_000);

  it("a frame that arrives before its structure is installed is HELD, then rendered once in that structure — never in the old one", async () => {
    const rig = await mount();
    try {
      await act(async () => {
        rig.transport().togglePlay();
        await gap();
      });
      // Paused at frame 57, every frame so far in the first structure.
      await act(async () => {
        expect(rig.transport().stepFrame(58)).toBe(57);
        await gap();
      });
      const compilesBefore = rig.compiles.length;
      const rendersBefore = rig.renders.length;
      // Play, and tick back to back — faster than any install can land: frames 58 and 59
      // render, the ask for 60 is still compiling when the loop reaches 60, so 60 is held.
      await act(async () => {
        rig.transport().stepFrame(1);
        rig.transport().togglePlay();
        for (let index = 0; index < 4; index += 1) rig.tick();
      });
      const during = rig.renders.slice(rendersBefore).map((entry) => entry.frame);
      expect(during).toEqual([58, 59]);
      // The install the frame before the crossing asked for.
      await waitFor(() => expect(rig.compiles.length).toBe(compilesBefore + 1), { timeout: 10_000 });
      await act(async () => {
        rig.tick();
      });
      const after = rig.renders.slice(rendersBefore);
      expect(after.map((entry) => entry.frame)).toEqual([58, 59, 60]);
      expect(after.map((entry) => layersOf(entry.plan))).toEqual([expectedOn(58), expectedOn(59), expectedOn(60)]);
      expect(rig.diagnostics()).toEqual([]);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 180_000);
});
