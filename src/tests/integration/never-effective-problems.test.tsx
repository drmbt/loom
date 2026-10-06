// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";
import { LAMP, lampFile } from "../fixtures/never-effective.ts";

/**
 * §T1641b slice 1 / §B262 — THE SAME DOCUMENT, OPENED IN THE APP.
 *
 * A file built by code with `pow(x, 2)` in an expression never met the bus, so nothing
 * refused it. Opened, the compile said `parameter.expression` at WARNING: one more amber row
 * among the ones every document has. Under the rule the Problems list (the registry the
 * panel and `get_diagnostics` both read) holds an ERROR on the node, with what to write
 * instead; and the finding is `local`, so the plan still reaches the backend with the lamp
 * at its stored value. A document that rendered yesterday must not open black.
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

interface PlanPass {
  readonly nodeId?: string;
  readonly uniforms?: Readonly<Record<string, unknown>>;
}

/** A backend that accepts every plan and keeps what it was handed. */
function capturingBackend(): { backend: LoomBackend; plans: Array<readonly PlanPass[]> } {
  const plans: Array<readonly PlanPass[]> = [];
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
    onDiagnostic: () => () => {},
    recover: async () => {},
    loop: () => ({ stop: () => {} }),
    previewHost: () => ({ setPreviewProgram: () => {}, presentPreviews: () => {}, dispose: () => {} }),
    present: () => ({ id: "present-stub", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compile: async (plan: { passes?: readonly PlanPass[] }) => {
      plans.push(plan.passes ?? []);
      return { id: `plan-${plans.length}`, passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as LoomBackend;
  return { backend, plans };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

async function opened(text: string): Promise<{ runtime: () => AppRuntime; plans: Array<readonly PlanPass[]> }> {
  const first = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  let current = first;
  const { backend, plans } = capturingBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  render(
    <App
      runtime={first}
      storage={createMemoryStorage()}
      gpuProbe={() => Promise.resolve(status)}
      onRuntimeChange={(next) => {
        current = next;
      }}
    />,
  );
  await act(async () => {});
  await settle();
  // Through the bus's own door: the one the file picker and the example library use.
  await act(async () => {
    await current.bus.execute("project.open", { text, fileName: "lamp.loom.json" }, current.invocation);
  });
  await settle();
  return { runtime: () => current, plans };
}

async function problems(runtime: AppRuntime): Promise<readonly RuntimeDiagnostic[]> {
  const snapshot = await runtime.bus.query("diagnostics.get", {}, runtime.invocation);
  return snapshot.diagnostics;
}

describe("§B262 — a file built by code with pow() in an expression, opened in the app", () => {
  it("is an error in the Problems list, on the node, with what to write instead; and the plan still renders", async () => {
    const session = await opened(lampFile(expressionSlot("pow(0.5 + abstime * 0, 2)", 0.5)));

    // The document opened whole: nothing was dropped or rewritten on the way in.
    const stored = session.runtime().bus.store.getGraph().nodes[LAMP]?.parameters["brightness"];
    expect(stored).toEqual(expressionSlot("pow(0.5 + abstime * 0, 2)", 0.5));

    const about = (await problems(session.runtime())).filter((entry) => entry.nodeId === LAMP);
    expect(about.map((entry) => [entry.severity, entry.code])).toEqual([["error", "parameter.expression.syntax"]]);
    expect(about[0]?.message).toContain('unknown function "pow"');
    expect(about[0]?.suggestion).toContain("Write (0.5 + abstime * 0) ^ 2.");

    // `local`: the backend was handed a plan, the lamp's pass in it at the stored 0.5. A
    // compile error that is not local withdraws the plan, and a fresh open shows nothing.
    await waitFor(() => {
      expect(session.plans.length).toBeGreaterThan(0);
    });
    const lamp = session.plans.at(-1)?.find((pass) => pass.nodeId === LAMP);
    expect(lamp?.uniforms?.["brightness"]).toBe(0.5);
  }, 30_000);

  it("leaves the same document alone when the expression is one the grammar reads", async () => {
    const session = await opened(lampFile(expressionSlot("(0.5 + abstime * 0) ^ 2", 0.5)));
    expect((await problems(session.runtime())).filter((entry) => entry.nodeId === LAMP)).toEqual([]);
    await waitFor(() => {
      expect(session.plans.length).toBeGreaterThan(0);
    });
    // The expression's value: the plan is not merely tolerated, it is driven.
    expect(session.plans.at(-1)?.find((pass) => pass.nodeId === LAMP)?.uniforms?.["brightness"]).toBe(0.25);
  }, 30_000);
});
