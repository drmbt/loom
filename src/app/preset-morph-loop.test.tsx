// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { serializePresetBank } from "@domain/presets/bank.ts";
import { parseMorphRecords } from "@domain/presets/morph.ts";
import { serializeProjectDocument } from "@domain/project/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";
import { transportHolderFor } from "./transport-commands.ts";

/**
 * T1497b — A PRESET MORPH IN THE COMPOSED APP (§V222, §V437).
 *
 * The domain tests prove the record and the fold; `compiler/preset-morph.test.ts` proves
 * the plan. Neither can see whether the app is WIRED: that the frame loop attaches its
 * frame clock to the bus (or every recall is silently a cut), that it mints an epoch (or
 * no frame matches any record), that a document whose only animation is a record gets
 * frames compiled at all, and that the uniforms reach the backend BEFORE the render that
 * shows them. "Built, tested, never wired" is this project's dominant bug class, so this
 * file mounts `<App>` over a recording backend and reads what the backend was handed.
 *
 * What is asserted is the brightness uniform in effect at each RENDER — the last value
 * pushed before it — against the value the record and that frame's absolute clock give.
 * The live clock here runs on the real `performance.now()`, so the frame a tick lands on
 * is not ours to choose; the expected value is derived from the frame the app reports.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

type Event =
  | { kind: "render" }
  | { kind: "uniforms"; passId: string; values: Record<string, unknown> }
  | { kind: "compile"; plan: CompiledGraph };

function recordingBackend(): { backend: LoomBackend; tick: () => void; events: Event[] } {
  let onFrame: (() => void) | null = null;
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
    compile: (plan: unknown) => {
      events.push({ kind: "compile", plan: plan as CompiledGraph });
      return Promise.resolve({ id: "fixture", logical: plan } as CompiledExecutionPlan);
    },
    render() {
      events.push({ kind: "render" });
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
      events.push({ kind: "uniforms", passId: update.passId, values: { ...update.values } });
    },
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => ({
      id: "p",
      outputId: options.outputId,
      setOutput() {},
      dispose() {},
    }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: () => Promise.reject(new Error("no GPU")),
    registerMediaSource: () => () => {},
    setCookPolicy() {},
  } as unknown as LoomBackend;
  return {
    backend,
    tick: () => {
      if (onFrame === null) throw new Error("the app registered no frame loop");
      onFrame();
    },
    events,
  };
}

/** noise → Level (brightness 0.2) → Output, and a bank that takes the Level to 0.8. */
async function stage(): Promise<{ runtime: AppRuntime; level: string; bank: string }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  let level = "";
  let bank = "";
  await act(async () => {
    const first = await seed(runtime, [
      { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$level", type: "level", position: { x: 240, y: 0 }, parameters: { brightness: 0.2 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 480, y: 0 } },
      { op: "connect", source: { nodeId: "$noise", portId: "out" }, target: { nodeId: "$level", portId: "input" } },
      { op: "connect", source: { nodeId: "$level", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
    ]);
    expect(first.status).toBe("applied");
    level = first.output.createdIds["$level"] ?? "";
    const name = runtime.bus.store.getGraph().nodes[level]?.label ?? "";
    const second = await seed(runtime, [
      {
        op: "addNode",
        ref: "$bank",
        type: "presets",
        position: { x: 0, y: 300 },
        parameters: {
          targets: name,
          presets: serializePresetBank({ version: 1, presets: [{ name: "bright", values: { [name]: { brightness: 0.8 } } }] }),
        },
      },
    ]);
    expect(second.status, JSON.stringify(second.diagnostics)).toBe("applied");
    bank = second.output.createdIds["$bank"] ?? "";
  });
  return { runtime, level, bank };
}

async function mount(
  runtime: AppRuntime,
  fixture: ReturnType<typeof recordingBackend>,
  onRuntimeChange?: (next: AppRuntime) => void,
): Promise<void> {
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend: fixture.backend };
  await act(async () => {
    render(
      <App
        runtime={runtime}
        storage={createMemoryStorage()}
        gpuProbe={() => Promise.resolve(status)}
        {...(onRuntimeChange === undefined ? {} : { onRuntimeChange })}
      />,
    );
  });
}

/** Lets a compile's `.then` and the effects behind it land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

/** One frame; returns the brightness in effect at its render (undefined = nothing pushed yet). */
async function frame(fixture: ReturnType<typeof recordingBackend>, level: string): Promise<{ pushed: boolean }> {
  const before = fixture.events.length;
  await act(async () => {
    fixture.tick();
  });
  const mine = fixture.events.slice(before);
  expect(mine.filter((event) => event.kind === "render")).toHaveLength(1);
  // T340's order, which is what puts the value on THIS frame: every push precedes the render.
  const renderAt = mine.findIndex((event) => event.kind === "render");
  const late = mine.slice(renderAt + 1).filter((event) => event.kind === "uniforms" && event.passId.startsWith(level));
  expect(late).toEqual([]);
  return { pushed: mine.some((event) => event.kind === "uniforms" && event.passId.startsWith(level)) };
}

/** The Level's brightness the backend currently holds: the last value pushed for its pass. */
function onGpu(fixture: ReturnType<typeof recordingBackend>, level: string): unknown {
  for (let index = fixture.events.length - 1; index >= 0; index -= 1) {
    const event = fixture.events[index];
    if (event?.kind === "uniforms" && event.passId.startsWith(level) && "brightness" in event.values) return event.values["brightness"];
  }
  return undefined;
}

describe("T1497b — a recall with a morph fades the picture in the composed app", () => {
  it("stamps the recall with the frame loop's clock, pushes the fade before each render, lands, and stops", async () => {
    const { runtime, level, bank } = await stage();
    const fixture = recordingBackend();
    await mount(runtime, fixture);

    // Before any frame there is no clock; the loop attaches one and its frames carry an epoch.
    for (let index = 0; index < 3; index += 1) await frame(fixture, level);
    const clock = runtime.bus.frameClock();
    expect(clock).toBeDefined();
    expect(typeof clock?.epoch).toBe("string");
    expect(clock?.epoch).not.toBe("");

    let morph: unknown = "unset";
    await act(async () => {
      const result = await runtime.bus.execute("preset.recall", { nodeId: bank, name: "bright", morph: { seconds: 1, curve: "linear" } }, runtime.invocation);
      expect(result.status).toBe("applied");
      morph = result.output.morph;
    });
    // The wire: with no frame clock attached this would be `null` and every recall a cut.
    expect(morph).toEqual({ seconds: 1, curve: "linear" });
    expect(runtime.bus.store.getGraph().nodes[level]?.parameters["brightness"]).toBe(0.8);
    const [record] = parseMorphRecords(runtime.bus.store.getGraph().nodes[bank]?.parameters["morphs"]);
    expect(record).toMatchObject({ epoch: clock?.epoch, start: clock?.absTimeSeconds, seconds: 1 });
    if (record === undefined) throw new Error("no record");

    // Frame by frame, the value in effect at the render is the fade at that frame's clock.
    const shown: number[] = [];
    let landed = false;
    for (let index = 0; index < 400 && !landed; index += 1) {
      await frame(fixture, level);
      const now = runtime.bus.frameClock();
      if (now === undefined) throw new Error("the frame clock went away");
      expect(now.epoch).toBe(record.epoch);
      const p = Math.min(1, Math.max(0, (now.absTimeSeconds - record.start) / record.seconds));
      const value = onGpu(fixture, level) as number;
      expect(value).toBe(0.2 * (1 - p) + 0.8 * p);
      shown.push(value);
      landed = p >= 1;
    }
    expect(landed).toBe(true);
    // It FADED — at least one render strictly between the ends — and it arrived exactly.
    expect(shown.some((value) => value > 0.2 && value < 0.8)).toBe(true);
    expect(shown.at(-1)).toBe(0.8);
    for (let index = 1; index < shown.length; index += 1) {
      expect(shown[index] as number).toBeGreaterThanOrEqual(shown[index - 1] as number);
    }

    // And then the document is still again: frames render, nothing more is pushed.
    for (let index = 0; index < 5; index += 1) {
      expect((await frame(fixture, level)).pushed).toBe(false);
    }
    runtime.dispose();
  });

  it("a render's `resetAbsoluteClock` starts a new epoch: the fade in flight is over, at its end state", async () => {
    const { runtime, level, bank } = await stage();
    const fixture = recordingBackend();
    await mount(runtime, fixture);
    for (let index = 0; index < 3; index += 1) await frame(fixture, level);

    await act(async () => {
      await runtime.bus.execute("preset.recall", { nodeId: bank, name: "bright", morph: { seconds: 60, curve: "linear" } }, runtime.invocation);
    });
    await frame(fixture, level);
    const live = runtime.bus.frameClock();
    expect(onGpu(fixture, level) as number).toBeLessThan(0.8);

    // What `renderFrameRange` does first (T467).
    transportHolderFor(runtime.bus).current?.resetAbsoluteClock();
    await frame(fixture, level);
    const take = runtime.bus.frameClock();
    expect(take?.epoch).not.toBe(live?.epoch);
    expect(take?.absTimeSeconds).toBe(0);
    // A sixty-second fade, one frame in — and the take shows the destination.
    expect(onGpu(fixture, level)).toBe(0.8);
    for (let index = 0; index < 5; index += 1) await frame(fixture, level);
    expect(onGpu(fixture, level)).toBe(0.8);
    runtime.dispose();
  });

  it("a file saved mid-fade and opened again in the SAME session shows its end state", async () => {
    const { runtime, level, bank } = await stage();
    const fixture = recordingBackend();
    let current = runtime;
    await mount(runtime, fixture, (next) => {
      current = next;
    });
    for (let index = 0; index < 3; index += 1) await frame(fixture, level);
    await act(async () => {
      await runtime.bus.execute("preset.recall", { nodeId: bank, name: "bright", morph: { seconds: 60, curve: "linear" } }, runtime.invocation);
    });
    await frame(fixture, level);
    expect(onGpu(fixture, level) as number).toBeLessThan(0.8);
    const live = runtime.bus.frameClock();

    // Saved as it stands — destination in the values, the fade in the record — and opened
    // through the bus, the door the file picker uses. An open adopts a NEW runtime.
    const text = serializeProjectDocument(runtime.projectDocument());
    await act(async () => {
      await runtime.bus.execute("project.open", { text, fileName: "saved.loom.json" }, runtime.invocation);
    });
    await settle();
    expect(current).not.toBe(runtime);
    expect(parseMorphRecords(current.bus.store.getGraph().nodes[bank]?.parameters["morphs"])).toHaveLength(1);

    const mark = fixture.events.length;
    for (let index = 0; index < 12; index += 1) {
      await act(async () => {
        fixture.tick();
      });
    }
    // The new clock counts from zero in a NEW epoch — and its first frames pass straight
    // through the absolute time the saved record was stamped at.
    const reopened = current.bus.frameClock();
    expect(reopened?.epoch).toBeDefined();
    expect(reopened?.epoch).not.toBe(live?.epoch);
    expect(reopened?.absTimeSeconds).toBeGreaterThan(live?.absTimeSeconds ?? Number.POSITIVE_INFINITY);

    // Nothing the reopened document pushed is a fading value …
    const pushed = fixture.events
      .slice(mark)
      .flatMap((event) => (event.kind === "uniforms" && event.passId.startsWith(level) && "brightness" in event.values ? [event.values["brightness"]] : []));
    expect(pushed.filter((value) => value !== 0.8)).toEqual([]);
    // … and the plan the backend holds for it is the destination.
    const plans = fixture.events.flatMap((event) => (event.kind === "compile" ? [event.plan] : []));
    const pass = (plans.at(-1)?.passes ?? []).find((entry) => "nodeId" in entry && entry.nodeId === level && "uniforms" in entry);
    expect((pass as { uniforms?: Record<string, unknown> } | undefined)?.uniforms?.["brightness"]).toBe(0.8);
    current.dispose();
  });
});
