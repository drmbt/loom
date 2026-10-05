// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { detectPlatform } from "@editor/keymap/index.ts";
import { serializePresetBank } from "@domain/presets/bank.ts";
import { serializeCueList } from "@domain/presets/cue-list.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T1555b — THE PROBLEMS REGISTRY, THROUGH THE REAL APP.
 *
 * `problem-sources.test.ts` reads `app.tsx` and proves every hook is registered, in the
 * order the hand-written list had. This file proves what the person and the agent then
 * READ: with six sources populated at once through the mounted app, the one list holds
 * them in the pre-T1555b concatenation order, and Clear empties the accumulating ones and
 * leaves the derived one. A registry that read the right hooks but dropped an entry from the
 * read, or cleared a derived source, would pass the source gate and fail here.
 *
 * Populated through the doors a real session uses: a lone Output (the compile), a refused
 * shortcut (a rejection), no snapshot store (autosave), a file that is not a project
 * (project), a backend report (the backend's retained list) and a backend that refuses the
 * plan (the frame loop).
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

/** A backend that refuses every plan and reports whatever the test emits. */
function refusingBackend(): { backend: LoomBackend; emit(diagnostic: RuntimeDiagnostic): void } {
  const listeners = new Set<(diagnostic: RuntimeDiagnostic) => void>();
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
    onDiagnostic: (listener: (diagnostic: RuntimeDiagnostic) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover: async () => {},
    loop: () => ({ stop: () => {} }),
    previewHost: () => ({ setPreviewProgram: () => {}, presentPreviews: () => {}, dispose: () => {} }),
    present: () => ({ id: "present-stub", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compile: () => Promise.reject(new Error("plan refused by the fixture")),
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as LoomBackend;
  return { backend, emit: (diagnostic) => listeners.forEach((listener) => listener(diagnostic)) };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

async function mount(status: GpuStatus): Promise<AppRuntime> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  render(
    <App
      runtime={runtime}
      storage={createMemoryStorage()}
      gpuProbe={() => Promise.resolve(status)}
      // No snapshot store: autosave says, as a warning, that it is not saving.
      createSnapshotStore={() => undefined}
    />,
  );
  await act(async () => {});
  await settle();
  return runtime;
}

/** The list the agent reads (`get_diagnostics`), which is the list the pane renders. */
async function problems(runtime: AppRuntime): Promise<readonly RuntimeDiagnostic[]> {
  const snapshot = await runtime.bus.query("diagnostics.get", {}, runtime.invocation);
  return snapshot.diagnostics;
}

describe("T1555b — the Problems list through the mounted app", () => {
  it("holds six populated sources in the pre-registry order, and Clear empties only the accumulating ones", async () => {
    const { backend, emit } = refusingBackend();
    const runtime = await mount({ kind: "ready", capabilities: CAPABILITIES, baseline: true, backend });

    // compile: a lone Output.
    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "addNode", ref: "$out", type: "output", position: { x: 0, y: 0 } }],
        },
        runtime.invocation,
      );
    });
    // rejection: the fullscreen shortcut, refused because jsdom has no Fullscreen API.
    const mac = detectPlatform() === "mac";
    await act(async () => {
      fireEvent.keyDown(window, { key: "F", code: "KeyF", shiftKey: true, metaKey: mac, ctrlKey: !mac });
    });
    // project: a file that is not a project.
    await act(async () => {
      await runtime.bus.execute("project.open", { text: "not a project", fileName: "x.loom.json" }, runtime.invocation);
    });
    // backend: a report the backend retains.
    await act(async () => {
      emit({ severity: "warning", code: "backend/unknown-resource", message: "fixture report" });
    });
    await settle();

    // The pre-T1555b concatenation order: compile, …, rejection, autosave, project,
    // backend (`recovery`), frame loop. Exact, not "contains": a source read twice, or one
    // moved, changes this list.
    const COMPILE = ["compiler/input-missing", "node.compile.missingResource", "compiler/node-no-passes"];
    expect((await problems(runtime)).map((entry) => entry.code)).toEqual([
      ...COMPILE,
      "view.fullscreenUnsupported",
      "project.autosave.unavailable",
      "project.parse.invalidJson",
      "project.open.rejected",
      "backend/unknown-resource",
      "backend/compile-failed",
    ]);
    // The person's pane renders the same list the agent read.
    const pane = within(screen.getByLabelText("Problems"));
    expect(pane.getByText("view.fullscreenUnsupported")).toBeDefined();

    // T465: Clear empties the five accumulating sources populated here; the compile is
    // derived from the document, so it is still true and still listed.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear problems" }));
    });
    await settle();
    expect((await problems(runtime)).map((entry) => entry.code)).toEqual(COMPILE);
    expect(pane.queryByText("view.fullscreenUnsupported")).toBeNull();
    runtime.dispose();
  }, 30_000);

  it("puts the missing GPU ahead of the other sources, and Clear cannot remove it", async () => {
    const runtime = await mount({ kind: "unavailable", reason: "navigator.gpu is undefined" });
    await waitFor(async () => {
      expect((await problems(runtime)).map((entry) => entry.code)).toEqual(["gpu.unavailable", "project.autosave.unavailable"]);
    });
    // Derived from the probe, so Clear cannot remove it while it is still true.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear problems" }));
    });
    expect((await problems(runtime)).map((entry) => entry.code)).toEqual(["gpu.unavailable"]);
    runtime.dispose();
  }, 30_000);

  /**
   * §T1559b (2) — a cue list that follows the timeline reads its bank's Morph as the document
   * stores it, and a DRIVEN Morph is said by the compile (`timelineCueProblems`). The other
   * timeline warnings stay on the list's own inspector section; this one is about the bank,
   * so it has to arrive HERE, in the list the person and the agent read, on the bank's id.
   * The fade's stored seconds are `compiler/timeline-cue-problems.test.ts`.
   */
  it("§T1559b (2): says a timed cue list's bank has a driven Morph, on the bank, with the stored seconds", async () => {
    const { backend } = refusingBackend();
    const runtime = await mount({ kind: "ready", capabilities: CAPABILITIES, baseline: true, backend });
    await act(async () => {
      const added = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [
            { op: "addNode", ref: "$level", type: "level", label: "level1", position: { x: 0, y: 0 } },
            {
              op: "addNode",
              ref: "$bank",
              type: "presets",
              label: "looks",
              position: { x: 0, y: 200 },
              parameters: {
                targets: "level1",
                presets: serializePresetBank({ version: 1, presets: [{ name: "bright", values: { level1: { brightness: 0.8 } } }] }),
                // `time + 2`: 2 s as the document says it (the zero frame), and longer every second it plays.
                morph: { mode: "expression", bindings: { static: { kind: "static", value: 9 }, expression: { kind: "expression", source: "time + 2" } } },
              },
            },
            {
              op: "addNode",
              ref: "$list",
              type: "cueList",
              label: "show",
              position: { x: 0, y: 400 },
              parameters: { follow: "timeline", cues: serializeCueList({ version: 1, cues: [{ name: "A", bank: "looks", preset: "bright", at: 1 }] }) },
            },
          ],
        },
        runtime.invocation,
      );
      expect(added.status).toBe("applied");
    });
    await settle();

    const bank = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === "looks");
    const said = (await problems(runtime)).filter((entry) => entry.code.startsWith("cue."));
    expect(said.map((entry) => [entry.severity, entry.code, entry.nodeId])).toEqual([["warning", "cue.timeline.drivenMorph", bank?.id]]);
    expect(said[0]?.message).toContain('Cue list "show" follows the timeline and fires bank "looks", whose Morph is driven (expression)');
    expect(said[0]?.message).toContain("the stored value, 2 s");
    // The person's pane renders the same entry.
    expect(within(screen.getByLabelText("Problems")).getByText("cue.timeline.drivenMorph")).toBeDefined();
    runtime.dispose();
  }, 30_000);
});
