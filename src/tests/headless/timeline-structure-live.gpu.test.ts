// @vitest-environment jsdom
import { Buffer } from "node:buffer";
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
  readonly renders: Array<{ frame: number; plan: LogicalExecutionPlan | undefined; at: number }>;
  readonly compiles: Array<{ plan: LogicalExecutionPlan; at: number; effectsBuilt: number; effectsWarmed: number }>;
  /** The scheduled loop's tick, as `backend.loop` was handed it (null until the loop starts). */
  tick(): void;
  transport(): TransportHandlers;
  readonly reported: string[];
  diagnostics(): readonly unknown[];
  /** §T1544b: the bytes of `nodeId`'s output as the last rendered frame left them. */
  read(nodeId: string): Promise<Buffer>;
  /** §T1544b: the performance pane's snapshot, as the app's hub has it. */
  telemetry(): ReturnType<AppRuntime["telemetry"]["snapshot"]>;
  dispose(): void;
}

async function mount(settings: typeof SETTINGS = SETTINGS, graph: GraphDocument = timedSetList()): Promise<Rig> {
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
          renders.push({ frame: inputs.frame.frameIndex, plan: logical.get(compiled.id), at: performance.now() });
          target.render(compiled, inputs);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as LoomBackend;

  const runtime: AppRuntime = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
    document: { ...structuredClone(setListDocument), graph, settings },
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
      telemetry: runtime.telemetry,
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
    telemetry: () => runtime.telemetry.snapshot(),
    read: async (nodeId) => {
      const plan = renders.at(-1)?.plan as unknown as { readonly outputs: ReadonlyArray<{ readonly nodeId: string; readonly resourceId: string }> } | undefined;
      const output = plan?.outputs.find((entry) => entry.nodeId === nodeId);
      if (output === undefined) throw new Error(`no output for  in the last rendered plan`);
      return Buffer.from((await real.readOutput(output.resourceId)).bytes);
    },
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
      // §T1544b: the performance pane counts the three ticks that held frame 60, and shows the
      // crossing's build as the backend reported it — what it built and what it adopted.
      await waitFor(() => expect(rig.telemetry().heldTicks).toBe(3), { timeout: 5_000 });
      const crossing = rig.compiles.at(-1);
      expect(crossing?.effectsWarmed ?? 0).toBeGreaterThan(0);
      await waitFor(() => expect(rig.telemetry().build?.effectsWarmed).toBe(crossing?.effectsWarmed), { timeout: 5_000 });
      expect(rig.telemetry().build?.effectsBuilt).toBe(crossing?.effectsBuilt);
      expect(rig.diagnostics()).toEqual([]);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 180_000);
});

/**
 * §T1544b (2) — THE LOOP'S WRAP IS WARMED LIKE A CROSSING. Looping 0..160: after the last
 * crossing (150) the next structure the playhead meets is not a later cue — there is none
 * before the out point — but frame 0's, at the lap. The warm-up after the 150 install builds
 * THAT segment ahead (its plan kept for the install, its Effects warmed), so the lap's
 * install builds no Effect, and the first frame of the new lap is in frame 0's structure.
 */
describe("§T1544b — the loop's wrap back to the first segment is precompiled and warmed", () => {
  it("looping 0..160: the lap's install builds 0 Effects, and the wrapped frame is in frame 0's structure", async () => {
    const rig = await mount({ ...SETTINGS, frameRange: { start: 0, end: 160 } });
    try {
      await act(async () => {
        rig.transport().togglePlay();
        await gap();
      });
      expect(rig.transport().isLooping()).toBe(true);
      const initial = rig.compiles.length;
      // Paused steps to 158, each crossing installed (and the next warmed) as it comes.
      for (let frame = 0; frame <= 158; frame += 1) {
        await act(async () => {
          rig.transport().stepFrame(1);
          await gap();
        });
        const owed = CROSSINGS.filter((crossing) => crossing <= frame + 1).length;
        await waitFor(() => expect(rig.compiles.length).toBe(initial + owed), { timeout: 10_000 });
      }
      // The warm-up after the 150 install runs in a task of its own: let it land.
      await act(async () => {
        for (let turn = 0; turn < 20; turn += 1) await gap();
      });
      const beforeLap = rig.compiles.length;
      const rendersBefore = rig.renders.length;
      const lapped = (): boolean => rig.renders.slice(rendersBefore).some((entry) => entry.frame >= 160);
      // Play: the loop reaches the out point and laps (one tick may cover several frames).
      await act(async () => {
        rig.transport().togglePlay();
        for (let tick = 0; tick < 6 && !lapped(); tick += 1) rig.tick();
      });
      expect(lapped()).toBe(true);
      // The lap asked for frame 0's segment: one install, and it built nothing.
      await waitFor(() => expect(rig.compiles.length).toBe(beforeLap + 1), { timeout: 10_000 });
      const lap = rig.compiles.at(-1);
      expect(layersOf(lap?.plan)).toEqual(expectedOn(0));
      expect(lap?.effectsBuilt).toBe(0);
      expect(lap?.effectsWarmed ?? 0).toBeGreaterThan(0);
      await act(async () => {
        rig.tick();
      });
      const wrapped = rig.renders.slice(rendersBefore).find((entry) => entry.frame < 160);
      expect(wrapped?.frame).toBe(0);
      expect(layersOf(wrapped?.plan)).toEqual(expectedOn(0));
      expect(rig.diagnostics()).toEqual([]);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 240_000);
});

/**
 * §T1544b (1) — A PAUSED SCRUB OR STEP ACROSS A CROSSING RENDERS EACH FRAME IN ITS OWN
 * STRUCTURE. A seek replays from frame 0 on the paused driver and the step button steps it;
 * neither passes the scheduled loop's `ready` hold, so until §T1544b every replayed frame
 * rendered on whatever plan was installed — the crossing frame in the old structure, and
 * every frame of a replay from the far side of a crossing in the new one. Now each frame
 * waits for its segment's plan before it is stepped.
 */
describe("§T1544b — paused seeks and steps cross structure exactly", () => {
  /** The renders since `from`, each against its own playhead's structure: the frames that are wrong. */
  const wrongSince = (rig: Rig, from: number): number[] =>
    rig.renders
      .slice(from)
      .filter((entry) => JSON.stringify(layersOf(entry.plan)) !== JSON.stringify(expectedOn(entry.frame)))
      .map((entry) => entry.frame);

  it("E82 paused at 50: a seek to the crossing (60) shows the new structure ON frame 60; a step queued behind a seek lands on 90 in its own; every frame in its own", async () => {
    const rig = await mount();
    try {
      await act(async () => {
        rig.transport().togglePlay();
        await gap();
      });
      await act(async () => {
        expect(rig.transport().stepFrame(51)).toBe(50);
        await gap();
      });
      // A scrub to the crossing frame. VN71 (the owner's ruling, 2026-10-07; §V170 as amended):
      // a seek JUMPS — it renders frame 60 alone, in its own structure, the plan installed first.
      const fromSeek = rig.renders.length;
      await act(async () => {
        expect(rig.transport().seek(60)).toBe(60);
      });
      await waitFor(() => expect(rig.renders.slice(fromSeek).map((entry) => entry.frame).at(-1)).toBe(60), { timeout: 10_000 });
      expect(rig.renders.slice(fromSeek).map((entry) => entry.frame)).toEqual([60]);
      expect(layersOf(rig.renders.at(-1)?.plan)).toEqual(expectedOn(60));
      expect(wrongSince(rig, fromSeek)).toEqual([]);

      // A seek to 88 and, at once, a step of two: the step waits for the seek, then 89, 90 (the crossing).
      const fromStep = rig.renders.length;
      await act(async () => {
        expect(rig.transport().seek(88)).toBe(88);
        expect(rig.transport().stepFrame(2)).toBe(90);
      });
      await waitFor(() => expect(rig.renders.slice(fromStep).map((entry) => entry.frame).at(-1)).toBe(90), { timeout: 10_000 });
      expect(rig.renders.slice(fromStep).map((entry) => entry.frame)).toEqual([88, 89, 90]);
      expect(layersOf(rig.renders.at(-1)?.plan)).toEqual(expectedOn(90));
      expect(wrongSince(rig, fromStep)).toEqual([]);
      expect(rig.transport().isPlaying()).toBe(false);

      // A seek to 170, past the last crossing: one frame, and ONE install — 170's segment. It
      // used to replay 0..170 and install four (frame 0's segment, then one per crossing).
      const fromLong = rig.renders.length;
      const compilesBefore = rig.compiles.length;
      const started = performance.now();
      await act(async () => {
        rig.transport().seek(170);
      });
      await waitFor(() => expect(rig.renders.slice(fromLong).map((entry) => entry.frame).at(-1)).toBe(170), { timeout: 20_000 });
      const long = rig.renders.slice(fromLong);
      expect(wrongSince(rig, fromLong)).toEqual([]);
      expect(long.map((entry) => entry.frame)).toEqual([170]);
      expect(rig.compiles.length - compilesBefore).toBe(1);
      if (process.env["LOOM_MEASURE"] === "1") {
        const gaps = long.slice(1).map((entry, index) => entry.at - (long[index] as (typeof long)[number]).at);
        const waits = [(long[0]?.at ?? started) - started, ...gaps.filter((ms) => ms > 1).sort((a, b) => b - a).slice(0, 3)];
        const steps = gaps.filter((ms) => ms <= 1);
        console.info(
          `§T1544b seek →170 past 3 crossings (Dawn, E82 160×90, jsdom React): ${((long.at(-1)?.at ?? started) - started).toFixed(1)} ms in all, ` +
            `1 install; the wait ${waits.map((ms) => ms.toFixed(1)).join(", ")} ms; ` +
            `the other ${String(steps.length)} steps ${(steps.reduce((sum, ms) => sum + ms, 0) / Math.max(1, steps.length)).toFixed(2)} ms each`,
        );
      }

      // Play pressed while a seek is still installing its frame's plan is OWED: the scheduler
      // does not run beside it, and starts once the frame has landed.
      await act(async () => {
        rig.transport().seek(10);
        rig.transport().togglePlay();
        expect(rig.transport().isPlaying()).toBe(true);
        expect(() => rig.tick()).toThrow("the loop is not running");
      });
      await waitFor(() => expect(rig.renders.at(-1)?.frame).toBe(10), { timeout: 10_000 });
      await waitFor(() => expect(() => rig.tick()).not.toThrow(), { timeout: 10_000 });
      expect(rig.transport().isPlaying()).toBe(true);
      expect(rig.diagnostics()).toEqual([]);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 240_000);

  /**
   * A SEEK ACROSS THE CROSSING, IN A FEEDBACK LOOP. A feedback loop records the output; a Layer
   * the timeline turns on at 1.0 s (frame 60) adds green into it. The play-through 0..70 runs
   * every frame in its own structure. Then a seek: VN71 (the owner's ruling, 2026-10-07; §V170
   * as amended) — a seek JUMPS, renders its one target frame and leaves the feedback as it is,
   * so it is no longer byte-identical to the play-through (the take is: `seek-jump.gpu.test.ts`).
   * What it still owes is §T1544b: the target's plan installed BEFORE its one frame — a seek to
   * 59 from the Layer's side renders 59 without the Layer, and back to 70 with it.
   */
  it("a seek across the crossing renders its one target frame on the target's structure, in a feedback loop", async () => {
    const node = (id: string, type: string, parameters: Record<string, unknown>, ui?: Record<string, unknown>) =>
      ({ id, type, label: id, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(ui === undefined ? {} : { ui }) }) as GraphDocument["nodes"][string];
    const edge = (id: string, source: string, target: string, port: string) => ({
      id,
      source: { nodeId: source, portId: "out" },
      target: { nodeId: target, portId: port },
    });
    const graph = {
      revision: 1,
      nodes: {
        base: node("base", "solid", { color: [0.02, 0, 0, 1] }),
        green: node("green", "solid", { color: [0, 0.25, 0, 1] }),
        fb: node("fb", "feedback", { source: "layer1", persistence: 1 }),
        acc: node("acc", "layer", { opacity: 0.9, blend: "add" }),
        layer1: node("layer1", "layer", { opacity: 1, blend: "add" }, { bypassed: true }),
        out: node("out", "output", {}),
        stage: node("stage", "presets", { targets: "layer1", presets: JSON.stringify({ version: 1, presets: [{ name: "on", values: {}, on: { layer1: true } }] }) }),
        show: node("show", "cueList", { follow: "timeline", cues: serializeCueList({ version: 1, cues: [{ name: "in", bank: "stage", preset: "on", at: 1 }] }) }),
      },
      edges: {
        e0: edge("e0", "base", "acc", "below"),
        e1: edge("e1", "fb", "acc", "picture"),
        e2: edge("e2", "acc", "layer1", "below"),
        e3: edge("e3", "green", "layer1", "picture"),
        e4: edge("e4", "layer1", "out", "input"),
      },
      groups: {},
    } as unknown as GraphDocument;
    const layerOn = (plan: LogicalExecutionPlan | undefined): boolean =>
      plan?.passes.some((pass) => (pass as { readonly id: string }).id.startsWith("layer1#")) === true;

    const rig = await mount(SETTINGS, graph);
    try {
      await act(async () => {
        rig.transport().togglePlay();
        await gap();
      });
      const initial = rig.compiles.length;
      // PLAY-THROUGH: 0..70 one step at a time, the crossing installed ahead as playback does.
      const fromPlay = rig.renders.length;
      for (let frame = 0; frame <= 70; frame += 1) {
        await act(async () => {
          rig.transport().stepFrame(1);
          await gap();
        });
        await waitFor(() => expect(rig.compiles.length).toBe(initial + (frame + 1 >= 60 ? 1 : 0)), { timeout: 10_000 });
      }
      const played = rig.renders.slice(fromPlay);
      expect(played.map((entry) => entry.frame)).toEqual(Array.from({ length: 71 }, (_, index) => index));
      expect(played.filter((entry) => layerOn(entry.plan) !== entry.frame >= 60).map((entry) => entry.frame)).toEqual([]);
      const before = await rig.read("out");

      // THE SEEK to 59, from the Layer's side of the crossing: 59's plan (no Layer) must be
      // installed before its one frame renders, or it renders with the Layer.
      const fromBack = rig.renders.length;
      await act(async () => {
        expect(rig.transport().seek(59)).toBe(59);
      });
      await waitFor(() => expect(rig.renders.slice(fromBack).map((entry) => entry.frame).at(-1)).toBe(59), { timeout: 10_000 });
      const back = rig.renders.slice(fromBack);
      expect(back.map((entry) => entry.frame)).toEqual([59]);
      expect(back.map((entry) => layerOn(entry.plan))).toEqual([false]);

      // And forward again, across it: 70 alone, with the Layer.
      const fromSeek = rig.renders.length;
      await act(async () => {
        expect(rig.transport().seek(70)).toBe(70);
      });
      await waitFor(() => expect(rig.renders.slice(fromSeek).map((entry) => entry.frame).at(-1)).toBe(70), { timeout: 10_000 });
      const jumped = rig.renders.slice(fromSeek);
      expect(jumped.map((entry) => entry.frame)).toEqual([70]);
      expect(jumped.map((entry) => layerOn(entry.plan))).toEqual([true]);
      // And it is NOT the play-through's frame 70: the feedback carried the history this seek
      // came from (59's, over the play-through's), not 0..69's. A take is where 70 is 70.
      expect(Buffer.compare(await rig.read("out"), before)).not.toBe(0);
      expect(rig.diagnostics()).toEqual([]);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 240_000);
});

/**
 * §T1547b (b) — A STEP AFTER THE LOOP HELD A FRAME AND WAS PAUSED. Playback reaches the
 * crossing (60) before its plan is installed, so the scheduled loop holds 60 (§T1537b); the
 * person pauses there, still looking at 59, and steps. The step is one frame: 60, in its own
 * structure — and `stepFrame`, which returns before the install lands, reports the frame
 * that is then shown. It used to report 60 and show 61: the pause dropped the held frame
 * the transport had already produced, and the step took the one after it.
 */
describe("§T1547b — a paused step after a held frame", () => {
  it("play into the held crossing frame, pause, step: frame 60 is shown in its own structure, and 60 is what the step reported", async () => {
    const rig = await mount();
    try {
      await act(async () => {
        rig.transport().togglePlay();
        await gap();
      });
      await act(async () => {
        expect(rig.transport().stepFrame(58)).toBe(57);
        await gap();
      });
      const compilesBefore = rig.compiles.length;
      const from = rig.renders.length;
      let reported = -1;
      // One synchronous turn: the install the ask-ahead starts for 60 cannot land inside it.
      await act(async () => {
        rig.transport().stepFrame(1);
        rig.transport().togglePlay();
        for (let index = 0; index < 3; index += 1) rig.tick();
        rig.transport().togglePlay();
        expect(rig.transport().isPlaying()).toBe(false);
        expect(rig.renders.slice(from).map((entry) => entry.frame)).toEqual([58, 59]);
        reported = rig.transport().stepFrame(1);
      });
      await waitFor(() => expect(rig.compiles.length).toBe(compilesBefore + 1), { timeout: 10_000 });
      await waitFor(() => expect(rig.renders.length).toBe(from + 3), { timeout: 10_000 });
      const shown = rig.renders.at(-1);
      expect(rig.renders.slice(from).map((entry) => entry.frame)).toEqual([58, 59, 60]);
      expect(reported).toBe(shown?.frame);
      expect(layersOf(shown?.plan)).toEqual(expectedOn(60));
      expect(rig.transport().isPlaying()).toBe(false);
      expect(rig.diagnostics()).toEqual([]);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 180_000);

  it("kept for the step, a held frame still renders ONCE when playback goes on: 60 once the plan lands, then the frames after it", async () => {
    const rig = await mount();
    try {
      await act(async () => {
        rig.transport().togglePlay();
        await gap();
      });
      await act(async () => {
        expect(rig.transport().stepFrame(58)).toBe(57);
        await gap();
      });
      const compilesBefore = rig.compiles.length;
      const from = rig.renders.length;
      await act(async () => {
        rig.transport().stepFrame(1);
        rig.transport().togglePlay();
        for (let index = 0; index < 3; index += 1) rig.tick();
      });
      await waitFor(() => expect(rig.compiles.length).toBe(compilesBefore + 1), { timeout: 10_000 });
      await act(async () => {
        rig.tick();
        rig.tick();
      });
      const frames = rig.renders.slice(from).map((entry) => entry.frame);
      expect(frames.slice(0, 3)).toEqual([58, 59, 60]);
      // The frame after the held one is a later frame — never 60 offered a second time.
      expect(frames).toHaveLength(4);
      expect(frames[3]).toBeGreaterThan(60);
      expect(rig.reported).toEqual([]);
    } finally {
      rig.dispose();
    }
  }, 180_000);
});
