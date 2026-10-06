// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { setListDocument } from "../examples/documents/set-list.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { useFrameLoop } from "./use-frame-loop.ts";
import { useGraphCompile } from "./use-graph-compile.ts";

/**
 * B234 — THE VALUES A FRAME PUSHES BELONG TO THE PLAN THE BACKEND HOLDS.
 *
 * E82's first GO (`1 open`) is a STRUCTURAL edit — it switches two layers off — on a
 * document that animates (`ramp_ringsSrc.phase` is an expression, and the shot starts a 2 s
 * fade). `backend.compile` is awaited, so for as long as it takes the backend still holds
 * the plan from BEFORE the cue while React has already committed the document after it.
 *
 * The frame loop read its per-frame `animate` function off the newest render and diffed
 * what it returned against the installed plan. In that interval the two belong to
 * different documents, so every frame was refused as "not a values-only variation" — the
 * running animation froze, and Problems kept `animation/structuralDrift`, a sentence about
 * an animated parameter changing the plan's structure, when no parameter had: the
 * DOCUMENT had, and its plan was on its way.
 *
 * This runs E82 through the two hooks `app.tsx` wires together — `useGraphCompile` into
 * `useFrameLoop`, on the real runtime, bus and compiler — over a backend whose `compile`
 * can be HELD, fires the cue on the real bus, and renders frames inside the hold: the
 * interleaving the live app only reaches when a compile outlasts a display frame, which is
 * why the report was "1 in 10".
 */

afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

type Event =
  | { kind: "render"; plan: CompiledGraph }
  | { kind: "uniforms"; passId: string; values: Record<string, unknown>; installed: CompiledGraph | null };

interface Fixture {
  readonly backend: LoomBackend;
  readonly events: Event[];
  tick(): void;
  /** While held, `compile` hands back a promise that only `release` settles. */
  hold(): void;
  release(): void;
  /** How many compiles are waiting. */
  waiting(): number;
  /** The plan of the last compile that RESOLVED — what a real backend's program is built from. */
  installed(): CompiledGraph | null;
}

function holdingBackend(): Fixture {
  let onFrame: (() => void) | null = null;
  let held = false;
  let installed: CompiledGraph | null = null;
  let compiles = 0;
  const pending: Array<() => void> = [];
  const events: Event[] = [];
  const backend = {
    status: {
      initialized: true,
      disposed: false,
      halted: false,
      deviceGeneration: 1,
      temporalResets: 0,
      resourceBuilds: 0,
      framesSubmitted: 0,
      readbacks: 0,
      stale: false,
      estimatedResourceBytes: 0,
    },
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: CompiledGraph) => {
      compiles += 1;
      const result = { id: `plan-${String(compiles)}`, logical: plan } as unknown as CompiledExecutionPlan;
      return new Promise<CompiledExecutionPlan>((resolve) => {
        // The program is swapped at the END of a real compile, in the same turn it resolves.
        const land = (): void => {
          installed = plan;
          resolve(result);
        };
        if (held) pending.push(land);
        else land();
      });
    },
    render(plan: { logical: CompiledGraph }) {
      events.push({ kind: "render", plan: plan.logical });
    },
    resize() {},
    readOutput: () => Promise.reject(new Error("no GPU")),
    onDiagnostic: () => () => {},
    dispose() {},
    loop: (callback: () => void) => {
      onFrame = callback;
      return { stop() {} };
    },
    updateUniforms(update: { passId: string; values: Record<string, unknown> }) {
      events.push({ kind: "uniforms", passId: update.passId, values: { ...update.values }, installed });
    },
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    setCookPolicy() {},
  } as unknown as LoomBackend;
  return {
    backend,
    events,
    tick: () => {
      if (onFrame === null) throw new Error("the frame loop registered no frame callback");
      onFrame();
    },
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      for (const land of pending.splice(0)) land();
    },
    waiting: () => pending.length,
    installed: () => installed,
  };
}

/** `app.tsx`'s wiring of the two hooks, and nothing else of the app. */
function useStage(runtime: AppRuntime, backend: LoomBackend) {
  const compile = useGraphCompile(runtime, CAPABILITIES);
  return useFrameLoop({
    bus: runtime.bus,
    backend,
    compiled: compile.compiled,
    settings: runtime.settings,
    animate: compile.animate,
    valuesOnly: compile.valuesOnly,
    resetFeedback: compile.resetFeedback,
    documentBoundary: compile.documentBoundary,
  });
}

/** Lets a compile's `.then` and the effects behind it land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** One display frame; returns what the backend was handed during it. */
async function frame(fixture: Fixture): Promise<Event[]> {
  const before = fixture.events.length;
  await act(async () => {
    fixture.tick();
  });
  return fixture.events.slice(before);
}

/** Pass ids are `<node>#<node>:<pass>`. */
const pushesTo = (events: readonly Event[], nodeId: string) =>
  events.flatMap((event) => (event.kind === "uniforms" && event.passId.startsWith(`${nodeId}#`) ? [event] : []));

const passIdsOf = (plan: CompiledGraph | null): Set<string> => new Set((plan?.passes ?? []).map((pass) => pass.id));
const cooks = (plan: CompiledGraph | null, nodeId: string): boolean =>
  [...passIdsOf(plan)].some((id) => id.startsWith(`${nodeId}#`));

describe("B234 — a structural cue across an in-flight compile", () => {
  it("keeps the installed plan animating on its own document's values, and reports no structural drift", async () => {
    const runtime = createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
      document: structuredClone(setListDocument),
    });
    const fixture = holdingBackend();
    const stage = renderHook(() => useStage(runtime, fixture.backend));
    /** What the frame loop hands the Problems pane. */
    const drift = () => stage.result.current.diagnostics.filter((entry) => entry.code === "animation/structuralDrift");
    await settle();

    // The stage as shipped: both idle layers are in the plan, and the rings' phase moves.
    const before = fixture.installed();
    expect(before).not.toBeNull();
    expect(cooks(before, "layerFx")).toBe(true);
    let warm: Event[] = [];
    for (let index = 0; index < 3; index += 1) warm = [...warm, ...(await frame(fixture))];
    // §V854: the fixture animates at all — or "it kept animating" below proves nothing.
    expect(pushesTo(warm, "ringsSrc").length).toBeGreaterThan(0);

    // GO: `1 open` switches layer_grid and layer_fx off and starts a 2 s fade. The compile
    // it causes is HELD, so the backend keeps the plan from before the cue.
    fixture.hold();
    await act(async () => {
      const result = await runtime.bus.execute("cue.go", { nodeId: "set" }, runtime.invocation);
      expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
    });
    expect(runtime.bus.store.getGraph().nodes["layerFx"]?.ui?.bypassed).toBe(true);
    expect(fixture.waiting()).toBe(1);
    expect(fixture.installed()).toBe(before);

    // Frames inside the hold. Each renders the plan the backend holds …
    let during: Event[] = [];
    for (let index = 0; index < 4; index += 1) during = [...during, ...(await frame(fixture))];
    const rendered = during.flatMap((event) => (event.kind === "render" ? [event.plan] : []));
    expect(rendered).toHaveLength(4);
    for (const plan of rendered) expect(plan).toBe(before);
    // … and no parameter of that plan changed its structure, so Problems must not say one did.
    expect(drift()).toEqual([]);
    // THAT document's animation is still running: the phase the cue did not touch keeps
    // moving, where a refused push leaves it frozen until the install lands.
    expect(pushesTo(during, "ringsSrc").length).toBeGreaterThan(0);
    // Every value written names a pass of the plan it was written into, with the rings
    // layer still at the opacity the installed document has: the cue's 0.25 → 1 fade
    // belongs to the plan that has not landed.
    const installedIds = passIdsOf(before);
    for (const event of during) {
      if (event.kind !== "uniforms") continue;
      expect(event.installed).toBe(before);
      expect(installedIds.has(event.passId), event.passId).toBe(true);
    }
    for (const push of pushesTo(during, "layerRings")) {
      if ("opacity" in push.values) expect(push.values["opacity"]).toBe(0.25);
    }

    // The install lands: the cue's plan, without the two layers, and the fade starts.
    await act(async () => {
      fixture.release();
    });
    await settle();
    const after = fixture.installed();
    expect(after).not.toBe(before);
    expect(cooks(after, "layerFx")).toBe(false);
    expect(cooks(after, "layerRings")).toBe(true);
    let landed: Event[] = [];
    for (let index = 0; index < 4; index += 1) landed = [...landed, ...(await frame(fixture))];
    const opacities = pushesTo(landed, "layerRings").flatMap((push) =>
      typeof push.values["opacity"] === "number" ? [push.values["opacity"]] : [],
    );
    // The fade is the new document's, pushed into the new plan: above the 0.25 it left.
    expect(opacities.length).toBeGreaterThan(0);
    for (const value of opacities) expect(value).toBeGreaterThan(0.25);
    for (const event of landed) {
      if (event.kind === "uniforms") expect(passIdsOf(event.installed).has(event.passId), event.passId).toBe(true);
    }
    expect(drift()).toEqual([]);
    runtime.dispose();
  });

  it("still refuses and reports an animated parameter that DOES change the installed plan's structure", async () => {
    // The case the pairing must not swallow (T594): the plan is installed, its own
    // `animate` runs against it, and a frame comes back structurally different.
    const plan = (passId: string): CompiledGraph =>
      ({
        ok: true,
        signature: passId,
        passes: [{ kind: "effect", id: passId, shader: "// same", target: "t", uniformBinding: "params", uniforms: { amount: 1 } }],
        resources: [],
        outputs: [],
        diagnostics: [],
        feedback: [],
        pruned: [],
        resourceSignatures: [],
        passSignatures: [],
        sources: [],
      }) as unknown as CompiledGraph;
    const installed = plan("a#a:fill");
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
    const fixture = holdingBackend();
    const stage = renderHook(() =>
      useFrameLoop({
        bus: runtime.bus,
        backend: fixture.backend,
        compiled: installed,
        settings: runtime.settings,
        animate: () => plan("a#a:other"),
      }),
    );
    await settle();
    expect(fixture.installed()).toBe(installed);

    const events = [...(await frame(fixture)), ...(await frame(fixture))];
    expect(events.filter((event) => event.kind === "uniforms")).toEqual([]);
    expect(stage.result.current.diagnostics.map((entry) => entry.code)).toEqual(["animation/structuralDrift"]);
    runtime.dispose();
  });
});
