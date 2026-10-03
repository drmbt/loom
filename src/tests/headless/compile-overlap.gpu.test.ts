// @vitest-environment jsdom
import { Buffer } from "node:buffer";

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { useFrameLoop } from "../../app/use-frame-loop.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import type {
  BackendCapabilities,
  CompiledExecutionPlan,
  FrameInputs,
  LogicalExecutionPlan,
} from "../../domain/types/backend.ts";
import { setListDocument } from "../../examples/documents/set-list.ts";
import type { LoomBackend, UniformUpdate } from "../../runtime/backend/index.ts";
import { probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { capturingHost } from "../../runtime/backend/vgpu/preview-synthesis-fixture.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";

/**
 * §B235 — TWO STRUCTURAL REVISIONS INSIDE ONE COMPILE, THROUGH THE REAL STACK.
 *
 * Found fixing §B234 on E82: `backend.compile` diffs a plan against the program it holds
 * and carries every unchanged resource over (§V22), then awaits the device's verdict
 * before installing. `useFrameLoop` handed the backend a new plan on every structural
 * revision without waiting for the previous one, so two revisions inside one compile's
 * duration ran two compiles that both carried from the SAME retained program. Switch two
 * layers off, then one of them straight back on: the first install releases that layer's
 * objects, the second carried them, and it throws "Buffer is destroyed" in
 * `flushUniforms` — after it has already become the installed program. Problems says
 * "The backend rejected the compiled plan", the frame loop keeps announcing the plan from
 * before both edits, and the backend renders a program with destroyed objects in it.
 *
 * The interleaving is forced, not raced: E82 through the two hooks `app.tsx` wires
 * together (`useGraphCompile` into `useFrameLoop`) on the real runtime, bus and compiler,
 * over the vgpu backend on Dawn, with the device's settle — the wait every structural
 * compile makes between building and installing — held while the second edit arrives.
 *
 * What a correct run leaves behind is read back the way the app reads it: no compile
 * failure in the frame loop's diagnostics, nothing from the backend, the announced plan
 * the one for the document as it now stands, and a frame whose pixels equal a fresh
 * backend's for that plan, byte for byte (§V147).
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

type Call =
  | { kind: "render"; plan: CompiledExecutionPlan; inputs: FrameInputs }
  | { kind: "uniforms"; update: UniformUpdate };

interface Stage {
  readonly backend: LoomBackend;
  /** What the frame loop handed the backend, in order, from the first install on. */
  readonly calls: Call[];
  /** Everything the backend reported, as the Problems pane would be handed it. */
  readonly reported: string[];
  /** One display frame, as `backend.loop` would fire it. */
  tick(): void;
  /** While held, the device settle every structural compile awaits does not return. */
  hold(): void;
  release(): void;
  /** How many settles are being held right now — compiles parked between build and install. */
  parked(): number;
  /** How many structural compiles the backend has been handed. */
  compiles(): number;
  dispose(): void;
}

async function stage(): Promise<Stage> {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const { host, session } = capturingHost();
  const real = createVgpuBackend({ host });
  const reported: string[] = [];
  real.onDiagnostic((entry) => {
    if (entry.severity !== "info") reported.push(`${entry.severity} ${entry.code}: ${entry.message}`);
  });
  await real.initialize({});
  const active = session();
  if (active === undefined) throw new Error("the host produced no session");

  const gpu = active.gpu as unknown as { settled(): Promise<void> };
  const settled = gpu.settled.bind(gpu);
  let held = false;
  const waiting: Array<() => void> = [];
  gpu.settled = () =>
    held ? new Promise<void>((resolve) => waiting.push(resolve)).then(settled) : settled();

  const calls: Call[] = [];
  let onFrame: (() => void) | null = null;
  let compiles = 0;
  const backend = new Proxy(real, {
    get(target, property, receiver) {
      if (property === "loop") {
        return (callback: () => void) => {
          onFrame = callback;
          return { stop() {} };
        };
      }
      if (property === "compile") {
        return (plan: LogicalExecutionPlan) => {
          compiles += 1;
          return target.compile(plan);
        };
      }
      if (property === "render") {
        return (plan: CompiledExecutionPlan, inputs: FrameInputs) => {
          calls.push({ kind: "render", plan, inputs });
          target.render(plan, inputs);
        };
      }
      if (property === "updateUniforms") {
        return (update: UniformUpdate) => {
          calls.push({ kind: "uniforms", update });
          target.updateUniforms(update);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as LoomBackend;

  return {
    backend,
    calls,
    reported,
    tick: () => {
      if (onFrame === null) throw new Error("the frame loop registered no frame callback");
      onFrame();
    },
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      for (const resume of waiting.splice(0)) resume();
    },
    parked: () => waiting.length,
    compiles: () => compiles,
    dispose: () => {
      real.dispose();
    },
  };
}

/** `app.tsx`'s wiring of the two hooks, and nothing else of the app. */
function useStage(runtime: AppRuntime, backend: LoomBackend) {
  const compile = useGraphCompile(runtime, CAPABILITIES);
  const loop = useFrameLoop({
    bus: runtime.bus,
    backend,
    compiled: compile.compiled,
    settings: runtime.settings,
    animate: compile.animate,
    valuesOnly: compile.valuesOnly,
    resetFeedback: compile.resetFeedback,
    documentBoundary: compile.documentBoundary,
  });
  return { loop, compiled: compile.compiled };
}

/** Lets the effects and a compile's continuations run. */
async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const cooks = (plan: CompiledGraph | null | undefined, nodeId: string): boolean =>
  (plan?.passes ?? []).some((pass) => pass.id.startsWith(`${nodeId}#`));

const resourceOf = (plan: CompiledGraph, nodeId: string): string => {
  const row = plan.outputs.find((output) => output.nodeId === nodeId);
  if (row === undefined) throw new Error(`no output row for ${nodeId}`);
  return row.resourceId;
};

describe("§B235 — two structural revisions inside one compile", () => {
  it("E82: two layers off, one straight back on — the second compile waits for the first, and the newest document is what renders", async () => {
    const live = await stage();
    const runtime = createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
      document: {
        ...structuredClone(setListDocument),
        settings: { ...setListDocument.settings, outputResolution: { width: 160, height: 90 } },
      },
    });
    try {
      const view = renderHook(() => useStage(runtime, live.backend));
      await waitFor(() => expect(view.result.current.loop.installedPlan).not.toBeNull(), { timeout: 20_000 });
      const shipped = view.result.current.loop.installedPlan;
      expect(cooks(shipped, "layerFx")).toBe(true);
      expect(cooks(shipped, "layerGrid")).toBe(true);
      const compilesAtBoot = live.compiles();

      // Edit 1: both idle layers off. Its compile builds, then parks on the device settle.
      live.hold();
      await act(async () => {
        const result = await runtime.bus.execute("node.toggleBypass", { nodeIds: ["layerGrid", "layerFx"] }, runtime.invocation);
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
      });
      await waitFor(() => expect(live.parked()).toBe(1), { timeout: 20_000 });
      expect(live.compiles()).toBe(compilesAtBoot + 1);

      // Edit 2, inside that compile: layerFx straight back on — the plan needs back what
      // edit 1's plan dropped, and the program it would carry it from is still the shipped one.
      await act(async () => {
        const result = await runtime.bus.execute("node.toggleBypass", { nodeIds: ["layerFx"] }, runtime.invocation);
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
      });
      await settle(100);
      const latest = view.result.current.compiled;
      expect(latest?.ok).toBe(true);
      if (latest === null || !latest.ok) throw new Error("the second edit did not compile");
      expect(cooks(latest, "layerFx")).toBe(true);
      expect(cooks(latest, "layerGrid")).toBe(false);
      // Read now, asserted below the consumer's view: how many compiles the backend held
      // at once while the first was unfinished.
      const handedDuringHold = live.compiles() - compilesAtBoot;
      const parkedDuringHold = live.parked();

      live.release();
      // Until the newest plan is announced — or the frame loop reports why it was not.
      await waitFor(
        () => {
          const { installedPlan, diagnostics } = view.result.current.loop;
          expect(installedPlan === latest || diagnostics.length > 0).toBe(true);
        },
        { timeout: 20_000 },
      );
      await settle(50);

      // Nothing failed, on either side of the bus.
      expect(view.result.current.loop.diagnostics).toEqual([]);
      expect(view.result.current.loop.installedPlan).toBe(latest);
      expect(live.reported).toEqual([]);
      expect(live.backend.status.stale).toBe(false);
      // The cause, not only its symptoms: the second compile reached the backend only
      // after the first had installed.
      expect({ handedDuringHold, parkedDuringHold }).toEqual({ handedDuringHold: 1, parkedDuringHold: 1 });
      expect(live.compiles()).toBe(compilesAtBoot + 2);

      // A frame of the installed program, read back: what the frame loop handed the
      // backend from the install on, replayed on a fresh backend, gives the same bytes.
      const from = live.calls.length;
      await act(async () => {
        live.tick();
      });
      const frame = live.calls.slice(from);
      const render = frame.findLast((call) => call.kind === "render");
      if (render?.kind !== "render") throw new Error("the frame rendered nothing");
      expect(render.plan.logical).toBe(latest);
      // `layerFx.out` is the target whose uniform block the overlapping compile destroyed;
      // `out` is the picture.
      const read = async (backend: LoomBackend, nodeId: string): Promise<Buffer> =>
        Buffer.from((await backend.readOutput(resourceOf(latest, nodeId))).bytes);
      const liveFx = await read(live.backend, "layerFx");
      const liveOut = await read(live.backend, "out");
      expect(live.reported).toEqual([]);

      const reference = await stage();
      try {
        const installed = await reference.backend.compile(latest);
        for (const call of frame) {
          if (call.kind === "uniforms") reference.backend.updateUniforms(call.update);
          else reference.backend.render(installed, call.inputs);
        }
        // §V854: the picture has ink, so "equal" is not two empty targets agreeing.
        expect(liveOut.some((byte) => byte !== 0)).toBe(true);
        expect(liveFx.equals(await read(reference.backend, "layerFx"))).toBe(true);
        expect(liveOut.equals(await read(reference.backend, "out"))).toBe(true);
        expect(reference.reported).toEqual([]);
      } finally {
        reference.dispose();
      }
      view.unmount();
    } finally {
      runtime.dispose();
      live.dispose();
    }
  }, 120_000);
});
