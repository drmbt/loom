// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { HAZE, LAMP, boundTo, hazeFile, lampFile } from "../fixtures/never-effective.ts";

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

  it("says the same of a bind that names no parameter of its node (slice 1b)", async () => {
    const session = await opened(lampFile(boundTo("contrst", 0.5)));
    const about = (await problems(session.runtime())).filter((entry) => entry.nodeId === LAMP);
    expect(about.map((entry) => [entry.severity, entry.code])).toEqual([["error", "parameter.bind.unreadable"]]);
    expect(about[0]?.message).toContain("it names no parameter on this node (it has blacklevel, brightness, contrast,");
    expect(about[0]?.suggestion).toBe('Nearest: "contrast".');
    await waitFor(() => {
      expect(session.plans.length).toBeGreaterThan(0);
    });
    expect(session.plans.at(-1)?.find((pass) => pass.nodeId === LAMP)?.uniforms?.["brightness"]).toBe(0.5);
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

/**
 * §T1641b slice 2 / §B264 — a slot under a key the node does not declare, opened in the app.
 *
 * The compile called it `compiler/parameter-unknown`, a warning, and an undeclared key has
 * no row in the inspector, so there was nowhere to see it but one amber line and nowhere to
 * fix it at all. It is the write gate's own error now, with the parts a colour has; the plan
 * still renders; and the row that reports it removes it, in a step undo takes back.
 */
describe("§B264 — a file built by code that drives eyeColor.x on a colour, opened in the app", () => {
  const held = (value: number, retained: number) => expressionSlot(`${value} + abstime * 0`, retained);
  const WRITTEN_XYZ = { eyeColor: [1, 0, 0, 1], "eyeColor.x": held(0, 1), "eyeColor.y": held(1, 0), "eyeColor.z": held(0, 0) };
  const storedKeys = (runtime: AppRuntime): string[] => Object.keys(runtime.bus.store.getGraph().nodes[HAZE]?.parameters ?? {}).sort();
  const aboutHaze = async (runtime: AppRuntime) => (await problems(runtime)).filter((entry) => entry.nodeId === HAZE);

  it("is an error for each key, with the parts a colour has and why it is one; the plan renders; the row removes them and undo brings them back", async () => {
    const session = await opened(hazeFile(WRITTEN_XYZ));
    const runtime = session.runtime();
    // Opened whole: nothing was dropped on the way in.
    expect(storedKeys(runtime)).toEqual(["eyeColor", "eyeColor.x", "eyeColor.y", "eyeColor.z", "source"]);

    const about = await aboutHaze(runtime);
    expect(about.map((entry) => [entry.severity, entry.code])).toEqual([
      ["error", "parameter.unknown"],
      ["error", "parameter.unknown"],
      ["error", "parameter.unknown"],
    ]);
    expect(about[0]?.message).toContain('stores a value under "eyeColor.x", which nothing reads: "eyeColor" is a colour, and its parts are r, g, b, a.');
    expect(about[0]?.suggestion).toContain('Write "eyeColor.r".');
    expect(about[0]?.suggestion).toContain("a vec3f or vec4f whose name contains colour, color, tint, rgb, albedo or emissi is a colour");

    // `local`: the backend was handed a plan with the haze's pass in it.
    await waitFor(() => {
      expect(session.plans.length).toBeGreaterThan(0);
    });
    expect(session.plans.at(-1)?.some((pass) => pass.nodeId === HAZE)).toBe(true);

    // The row's own action: every key the node does not declare, in one step.
    const pane = within(screen.getByLabelText("Problems"));
    const remove = pane.getAllByRole("button", { name: `Remove what "${HAZE}" stores under keys it does not declare` });
    expect(remove).toHaveLength(3);
    await act(async () => {
      fireEvent.click(remove[0] as HTMLElement);
    });
    await settle();
    expect(storedKeys(runtime)).toEqual(["eyeColor", "source"]);
    expect(await aboutHaze(runtime)).toEqual([]);

    // One undo step, and nothing was lost: the slots are back, and so is what is said of them.
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    await settle();
    expect(storedKeys(runtime)).toEqual(["eyeColor", "eyeColor.x", "eyeColor.y", "eyeColor.z", "source"]);
    expect((await aboutHaze(runtime)).map((entry) => entry.code)).toEqual(["parameter.unknown", "parameter.unknown", "parameter.unknown"]);
  }, 30_000);
});

/**
 * §T1641b slice 3 — THE APP'S SAVE IS NOT THE DOOR THAT REFUSES (the lead's ruling 8).
 *
 * A save by code refuses a document that holds something which can never take effect
 * (`checked-project.ts`). A person's work is written whatever it holds, because a refused
 * save is lost work; and the save SAYS what it wrote: in its own result, which an agent
 * reads, and in the Problems list. The document here holds one thing in effect (`pow`,
 * which the live compile already reports) and one thing a slot only keeps (a kept static
 * of another type, which nothing in the app said at all until a save).
 */
describe("slice 3 — the app saves a document that holds what can never take effect, and reports", () => {
  const POW = expressionSlot("pow(0.5 + abstime * 0, 2)", 0.5);
  const KEEPS_TEXT = expressionSlot("1", "full");

  it("writes the file whole, says so in the save's result and in Problems, and the picture is still there", async () => {
    const written: string[] = [];
    const picker = globalThis as { showSaveFilePicker?: unknown };
    // The picker path of the app's own write (`project-io.ts`): what lands in the file.
    picker.showSaveFilePicker = () =>
      Promise.resolve({
        name: "lamp.loom.json",
        createWritable: () =>
          Promise.resolve({
            write: (payload: unknown) => {
              written.push(String(payload));
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
      });
    try {
      const session = await opened(lampFile(POW, [], { opacity: KEEPS_TEXT }));
      const runtime = session.runtime();
      const aboutLamp = async () => (await problems(runtime)).filter((entry) => entry.nodeId === LAMP).map((entry) => [entry.severity, entry.code]);
      // Before the save: the compile's own error, and not a word about the kept payload.
      expect(await aboutLamp()).toEqual([["error", "parameter.expression.syntax"]]);

      let result: Awaited<ReturnType<typeof runtime.bus.execute<"project.save">>> | undefined;
      await act(async () => {
        result = await runtime.bus.execute("project.save", { saveAs: false }, runtime.invocation);
      });
      await settle();

      // Not refused: the command applied and bytes reached the file.
      expect(result?.status).toBe("applied");
      expect(result?.status === "applied" ? result.output : undefined).toEqual({ saved: true, fileName: "lamp.loom.json" });
      expect(written).toHaveLength(1);
      // And they are the document, whole: nothing dropped, corrected or defaulted on the way out.
      const saved = JSON.parse(written[0] ?? "{}") as { graph: { nodes: Record<string, { parameters: Record<string, unknown> }> } };
      expect(saved.graph.nodes[LAMP]?.parameters["brightness"]).toEqual(POW);
      expect(saved.graph.nodes[LAMP]?.parameters["opacity"]).toEqual(KEEPS_TEXT);

      // The save's own report: both, each on the node, each with what to write instead.
      const reported = result?.diagnostics ?? [];
      expect(reported.map((entry) => [entry.severity, entry.code, entry.nodeId])).toEqual([
        ["error", "parameter.expression.syntax", LAMP],
        ["error", "parameter.retained", LAMP],
      ]);
      expect(reported[0]?.suggestion).toContain("(0.5 + abstime * 0) ^ 2");
      expect(reported[1]?.message).toContain('Parameter "opacity" is in expression mode and keeps a static payload it cannot take');
      expect(reported[1]?.suggestion).toContain("Keep a finite number as the static value");

      // The Problems list holds the kept payload now, which it could not before the save.
      expect(await aboutLamp()).toContainEqual(["error", "parameter.retained"]);
      // And the document did not go black for any of it: the lamp's pass is in the plan.
      await waitFor(() => {
        expect(session.plans.length).toBeGreaterThan(0);
      });
      expect(session.plans.at(-1)?.some((pass) => pass.nodeId === LAMP)).toBe(true);
    } finally {
      delete picker.showSaveFilePicker;
    }
  }, 30_000);

  it("says nothing when the document holds nothing of the kind", async () => {
    const picker = globalThis as { showSaveFilePicker?: unknown };
    picker.showSaveFilePicker = () =>
      Promise.resolve({ name: "lamp.loom.json", createWritable: () => Promise.resolve({ write: () => Promise.resolve(), close: () => Promise.resolve() }) });
    try {
      const session = await opened(lampFile(expressionSlot("(0.5 + abstime * 0) ^ 2", 0.5)));
      const runtime = session.runtime();
      const result = await runtime.bus.execute("project.save", { saveAs: false }, runtime.invocation);
      expect(result.status).toBe("applied");
      expect(result.diagnostics).toEqual([]);
    } finally {
      delete picker.showSaveFilePicker;
    }
  }, 30_000);
});
