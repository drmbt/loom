// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { memo } from "react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { serializePresetBank } from "@domain/presets/bank.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";
import { createPhoneWrites } from "./phone-writes.ts";
import { revisionWatchFor } from "./revision-watch.ts";

/**
 * T1652b — WHAT A VALUE-ONLY WRITE MUST NOT DO, counted through the composed app.
 *
 * Owner: "I'm using the color hue sliders and while I'm sliding them around there's like
 * lag". Measured on his document: every write of a control was one 57 to 66 ms task,
 * because a moved slider is a document revision and every revision re-rendered the
 * composition root and re-ran some twenty whole-document passes behind it.
 *
 * The rule, in the code's own terms (`classifyRevision`): a VALUES-ONLY revision
 *
 *   - does not render `App`, nor a pane that does not show the value;
 *   - does not run a structural compile: it takes the values lane, exactly once;
 *   - does not run the requirement diagnostics;
 *   - does not rebuild the reference lines' geometry;
 *   - renders the widget of the control that moved, on each surface that draws it, and
 *     no other widget.
 *
 * Counts, never a clock: each number below is how many times a thing ran for N writes,
 * read off the product's own functions mounted in `<App>`. And the other half, which is
 * what a guard like this can swallow: a STRUCTURAL edit still does all of it, and a value
 * that changes what a diagnostic says is still said.
 *
 * Red-verified, each by an edit and restored by an edit (the counts each broke are in
 * the report for T1652b):
 *   - `useGraphCompile` subscribed to `store.subscribe` again: App, the panes, the
 *     structural compile and the requirement diagnostics all count one per write;
 *   - `useDocumentDirty` snapshotting the revision again: App counts one per write;
 *   - the canvas deriving its lines from the store's document again: the geometry counts
 *     one per write;
 *   - `ControlWidget` without its `memo`: the other control's widget renders per write.
 */

const counts = vi.hoisted(() => ({
  /** What the Examples pane was last told: the dirty mark, as a surface reads it. */
  dirty: null as boolean | null,
  app: 0,
  graphPane: 0,
  inspector: 0,
  /** The panel inside the pane: it once held a subscription of its own. */
  inspectorPanel: 0,
  viewer: 0,
  shader: 0,
  problems: 0,
  controls: 0,
  structuralCompiles: 0,
  valuesPasses: 0,
  requirements: 0,
  referenceGeometry: 0,
  widgets: {} as Record<string, number>,
  problemsShown: [] as readonly RuntimeDiagnostic[],
}));

// `AppShell` is rendered by `App` and by nothing else, with no memo between: one render each.
vi.mock("./app-shell.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./app-shell.tsx")>();
  return { ...original, AppShell: (props: Parameters<typeof original.AppShell>[0]) => ((counts.app += 1), original.AppShell(props)) };
});
vi.mock("@editor/library/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@editor/library/index.ts")>();
  return {
    ...original,
    ExampleLibrary: (props: Parameters<typeof original.ExampleLibrary>[0]) => {
      counts.dirty = props.dirty;
      return original.ExampleLibrary(props);
    },
  };
});
vi.mock("./graph-pane.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./graph-pane.tsx")>();
  return { ...original, GraphPane: (props: Parameters<typeof original.GraphPane>[0]) => ((counts.graphPane += 1), original.GraphPane(props)) };
});
vi.mock("./side-panes.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./side-panes.tsx")>();
  return {
    ...original,
    InspectorPane: (props: Parameters<typeof original.InspectorPane>[0]) => ((counts.inspector += 1), original.InspectorPane(props)),
    ViewerPane: (props: Parameters<typeof original.ViewerPane>[0]) => ((counts.viewer += 1), original.ViewerPane(props)),
  };
});
vi.mock("@editor/inspector/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@editor/inspector/index.ts")>();
  return { ...original, Inspector: (props: Parameters<typeof original.Inspector>[0]) => ((counts.inspectorPanel += 1), original.Inspector(props)) };
});
vi.mock("./dock-panes.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./dock-panes.tsx")>();
  return { ...original, ShaderPane: (props: Parameters<typeof original.ShaderPane>[0]) => ((counts.shader += 1), original.ShaderPane(props)) };
});
vi.mock("@editor/shader-editor/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@editor/shader-editor/index.ts")>();
  return {
    ...original,
    ProblemsPanel: (props: Parameters<typeof original.ProblemsPanel>[0]) => {
      counts.problems += 1;
      counts.problemsShown = props.diagnostics;
      return original.ProblemsPanel(props);
    },
  };
});
vi.mock("@editor/controls/controls-pane.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("@editor/controls/controls-pane.tsx")>();
  return { ...original, ControlsPane: (props: Parameters<typeof original.ControlsPane>[0]) => ((counts.controls += 1), original.ControlsPane(props)) };
});
/*
 * A widget's renders, counted INSIDE whatever boundary the product puts around it: the
 * product's own `memo` (and its own comparator) is kept when it has one, and none is added
 * when it has none — so taking the `memo` off `ControlWidget` is seen here as every widget
 * on a board rendering for one that moved.
 */
vi.mock("@editor/controls/control-widget.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("@editor/controls/control-widget.tsx")>();
  type Props = Parameters<Extract<typeof original.ControlWidget, (props: never) => unknown>>[0];
  const product = original.ControlWidget as unknown as { type?: (props: Props) => unknown; compare?: ((a: Props, b: Props) => boolean) | null } | ((props: Props) => unknown);
  const body = typeof product === "function" ? product : (product.type as (props: Props) => unknown);
  const counted = (props: Props) => {
    counts.widgets[props.nodeId] = (counts.widgets[props.nodeId] ?? 0) + 1;
    return body(props);
  };
  const ControlWidget = typeof product === "function" ? counted : memo(counted as ComponentType<Props>, product.compare ?? undefined);
  return { ...original, ControlWidget };
});
vi.mock("@compiler/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@compiler/index.ts")>();
  return {
    ...original,
    compileGraphRetaining: (...args: Parameters<typeof original.compileGraphRetaining>) => ((counts.structuralCompiles += 1), original.compileGraphRetaining(...args)),
    rebaseOnValues: (...args: Parameters<typeof original.rebaseOnValues>) => ((counts.valuesPasses += 1), original.rebaseOnValues(...args)),
  };
});
// `requirementDiagnostics` asks this once per node of the document, and nothing else in a render does.
vi.mock("@domain/types/node-definition.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@domain/types/node-definition.ts")>();
  return {
    ...original,
    nodeRuntimeRequirements: (...args: Parameters<typeof original.nodeRuntimeRequirements>) => ((counts.requirements += 1), original.nodeRuntimeRequirements(...args)),
  };
});
// The reference lines' geometry is rebuilt by exactly this call, when their dependencies are another array.
vi.mock("@editor/edges/reference-geometry.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@editor/edges/reference-geometry.ts")>();
  return {
    ...original,
    referenceLinesOf: (...args: Parameters<typeof original.referenceLinesOf>) => ((counts.referenceGeometry += 1), original.referenceLinesOf(...args)),
  };
});

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

interface UniformWrite {
  readonly passId: string;
  readonly values: Record<string, unknown>;
}

function recordingBackend() {
  const uniforms: UniformWrite[] = [];
  const plans: CompiledGraph[] = [];
  let installs = 0;
  /** While set, an install does not land until `release` is called: a structural build on its way. */
  let held: Promise<void> | null = null;
  let release: () => void = () => undefined;
  const backend = {
    status: {
      initialized: true, disposed: false, halted: false, deviceGeneration: 1,
      temporalResets: 0, resourceBuilds: 0, framesSubmitted: 0, readbacks: 0,
      stale: false, estimatedResourceBytes: 0,
    },
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => {
      installs += 1;
      plans.push(plan as CompiledGraph);
      const landed = { id: "f", logical: plan } as CompiledExecutionPlan;
      return held === null ? Promise.resolve(landed) : held.then(() => landed);
    },
    render() {}, resize() {},
    readOutput: () => Promise.reject(new Error("no GPU")),
    onDiagnostic: () => () => {},
    dispose() {},
    loop: () => ({ stop() {} }),
    updateUniforms(update: UniformWrite) {
      uniforms.push({ passId: update.passId, values: { ...update.values } });
    },
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => ({ id: "p", outputId: options.outputId, setOutput() {}, dispose() {} }),
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
    uniforms,
    plans,
    structuralInstalls: () => installs,
    holdInstalls: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseInstalls: () => {
      held = null;
      release();
    },
  };
}

async function patch(runtime: AppRuntime, operations: GraphPatchOperation[], label = "edit") {
  let created: Record<string, NodeId> = {};
  await act(async () => {
    const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label, operations }, runtime.invocation);
    expect(result.status, JSON.stringify(result.diagnostics).slice(0, 400)).toBe("applied");
    created = result.output.createdIds as Record<string, NodeId>;
  });
  return created;
}

/** Lets a compile's `.then` and the effects behind it land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

/**
 * solid → level → blur → output. A Slider (0 to 2) and a Toggle on a published Panel; the
 * Level's brightness reads the Slider through an expression — the owner's shape: a control
 * is its own node, read by an expression in another.
 */
async function stage() {
  const fixture = recordingBackend();
  const actor = { kind: "human" as const, id: "tester", label: "Tester" };
  // Built on a scratch runtime and then OPENED, so the document under test starts clean:
  // nothing has been written since it was opened, exactly as after a load.
  const scratch = createAppRuntime({ identityStorage: null, actor });
  const seeded = await scratch.bus.execute("graph.applyPatch", { baseRevision: scratch.bus.store.getRevision(), label: "seed", operations: [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 }, label: "solid_ground" },
    {
      op: "addNode", ref: "$level", type: "level", position: { x: 300, y: 0 }, label: "level_grade",
      parameters: {
        // The two ways another node reads a control: its published channel, and its parameter.
        brightness: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('slider_gain').chan.gain" }, static: { kind: "static", value: 1 } } },
        contrast: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('slider_gain').par.value" }, static: { kind: "static", value: 1 } } },
        opacity: 1,
      },
    },
    { op: "addNode", ref: "$blur", type: "blur", position: { x: 600, y: 0 }, label: "blur_soft", parameters: { size: 4 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 900, y: 0 }, label: "output_frame" },
    { op: "addNode", ref: "$slider", type: "slider", position: { x: 0, y: 300 }, label: "slider_gain", parameters: { caption: "Gain", channel: "gain", value: 0.5, min: 0, max: 2, step: 0, defaultValue: 0.5 } },
    { op: "addNode", ref: "$toggle", type: "toggle", position: { x: 0, y: 500 }, label: "toggle_arm", parameters: { caption: "Arm", channel: "arm", on: false, defaultOn: false } },
    {
      op: "addNode", ref: "$panel", type: "panel", position: { x: 300, y: 300 }, label: "panel_desk",
      parameters: {
        title: "Desk",
        remote: true,
        board: serializePanelBoard({ columns: 8, items: [{ member: "slider_gain", rect: { x: 0, y: 0, w: 8, h: 1 } }, { member: "toggle_arm", rect: { x: 0, y: 1, w: 4, h: 1 } }] }),
      },
    },
    { op: "connect", source: { nodeId: "$solid", portId: "out" }, target: { nodeId: "$level", portId: "input" } },
    { op: "connect", source: { nodeId: "$level", portId: "out" }, target: { nodeId: "$blur", portId: "input" } },
    { op: "connect", source: { nodeId: "$blur", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
    { op: "connect", source: { nodeId: "$slider", portId: "out" }, target: { nodeId: "$panel", portId: "controls" } },
    { op: "connect", source: { nodeId: "$toggle", portId: "out" }, target: { nodeId: "$panel", portId: "controls" } },
  ] as GraphPatchOperation[] }, scratch.invocation);
  expect(seeded.status, JSON.stringify(seeded.diagnostics).slice(0, 400)).toBe("applied");
  const ids = seeded.output.createdIds as Record<string, NodeId>;
  const runtime = createAppRuntime({ identityStorage: null, actor, document: scratch.projectDocument() });
  scratch.dispose();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend: fixture.backend };
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />);
  });
  await settle();
  const id = (ref: string): NodeId => ids[ref] as NodeId;
  return { runtime, fixture, id, watch: revisionWatchFor(runtime.bus.store, runtime.registry) };
}

/** Every counter, as a plain object, for a before/after difference. */
function snapshot() {
  return { ...counts, widgets: { ...counts.widgets } };
}
function since(before: ReturnType<typeof snapshot>) {
  const now = snapshot();
  const widgets: Record<string, number> = {};
  for (const [nodeId, count] of Object.entries(now.widgets)) widgets[nodeId] = count - (before.widgets[nodeId] ?? 0);
  return {
    app: now.app - before.app,
    graphPane: now.graphPane - before.graphPane,
    inspector: now.inspector - before.inspector,
    inspectorPanel: now.inspectorPanel - before.inspectorPanel,
    viewer: now.viewer - before.viewer,
    shader: now.shader - before.shader,
    problems: now.problems - before.problems,
    controls: now.controls - before.controls,
    structuralCompiles: now.structuralCompiles - before.structuralCompiles,
    valuesPasses: now.valuesPasses - before.valuesPasses,
    requirements: now.requirements - before.requirements,
    referenceGeometry: now.referenceGeometry - before.referenceGeometry,
    widgets,
  };
}

const WRITES = 12;

describe("T1652b — a value-only write, through the composed app", () => {
  it("renders the control that moved and nothing that does not show it; compiles on the values lane, once", async () => {
    const { runtime, fixture, id, watch } = await stage();
    const slider = id("$slider");
    const toggle = id("$toggle");
    const level = id("$level");
    expect(fixture.structuralInstalls(), "a plan is installed before anything is measured").toBeGreaterThan(0);

    // The first write of a freshly opened document makes it DIRTY, and the root shows that:
    // it renders for it ONCE, and not again for the dirty document's next writes (below).
    expect(counts.dirty, "just opened, so clean").toBe(false);
    const clean = snapshot();
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 0.55 } }]);
    await settle();
    expect(counts.dirty, "a value write did not mark the document dirty").toBe(true);
    expect(since(clean).app, "the root renders once for the dirty mark").toBe(1);
    expect(since(clean).structuralCompiles).toBe(0);

    const installsBefore = fixture.structuralInstalls();
    const uniformsBefore = fixture.uniforms.length;
    const before = snapshot();
    const escalatedBefore = watch.stats().escalated;
    for (let write = 1; write <= WRITES; write += 1) {
      await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 0.55 + write * 0.05 } }]);
    }
    await settle();
    const moved = since(before);

    // THE RULE.
    expect(moved.app, "App rendered for a value").toBe(0);
    expect(moved.graphPane, "the graph pane rendered for a control's value (its node draws it, not the pane)").toBe(0);
    expect(moved.inspector, "the inspector rendered with nothing inspected").toBe(0);
    expect(moved.inspectorPanel, "the inspector's panel rendered with nothing inspected").toBe(0);
    expect(moved.viewer, "the viewer rendered for a value").toBe(0);
    expect(moved.shader, "the shader pane rendered for a value").toBe(0);
    expect(moved.problems, "the problems pane rendered for a value").toBe(0);
    expect(moved.structuralCompiles, "a structural compile ran for a value").toBe(0);
    expect(moved.requirements, "the requirement diagnostics ran for a value").toBe(0);
    expect(moved.referenceGeometry, "the reference lines were rebuilt for a value").toBe(0);
    expect(moved.valuesPasses, "exactly one values pass per write").toBe(WRITES);
    expect(watch.stats().escalated - escalatedBefore, `a write left the lane: ${watch.stats().lastEscalation ?? ""}`).toBe(0);
    expect(fixture.structuralInstalls() - installsBefore, "the backend built a program for a value").toBe(0);

    // WHAT IT MUST STILL DO. The surface that shows the control renders, and of its widgets
    // only that control's: once per write on each surface that draws it.
    expect(moved.controls).toBe(WRITES);
    // One render per write on each surface that draws the control: the Controls tab's board, the Panel
    // node's body on the canvas, and the Slider node's own body. A whole number, the same for every write.
    const surfaces = (moved.widgets[slider] ?? 0) / WRITES;
    expect(surfaces, `the moved control's widget rendered ${String(moved.widgets[slider])} times for ${String(WRITES)} writes`).toBe(3);
    expect(moved.widgets[toggle] ?? 0, "another control's widget rendered for this one's value").toBe(0);

    // And the value reaches the device: the node that READS the control gets the last number written.
    const last = 0.55 + WRITES * 0.05;
    const reached = fixture.uniforms.slice(uniformsBefore).filter((write) => write.passId.startsWith(level));
    expect(reached.length).toBe(WRITES);
    // Both readers: the one through the control's channel and the one through its parameter.
    expect(Object.values(reached[reached.length - 1]?.values ?? {}).filter((value) => value === last)).toHaveLength(2);
    // …and only that node's pass was written: a value is not a reason to restate the plan.
    expect(new Set(fixture.uniforms.slice(uniformsBefore).map((write) => write.passId)).size).toBe(1);

    runtime.dispose();
  }, 60_000);

  it("a phone's write and the desk's write of one control each render that control's widget and no other", async () => {
    const { runtime, id } = await stage();
    const slider = id("$slider");
    const toggle = id("$toggle");
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 0.6 } }]);
    await settle();

    const desk = snapshot();
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 0.7 } }]);
    await settle();
    const byDesk = since(desk);

    // The phone's road: vetted against the document and written as that phone (`createPhoneWrites`).
    const refused: string[] = [];
    const phones = createPhoneWrites({ bus: runtime.bus, invocation: runtime.invocation, schedule: (run) => (run(), () => undefined), onRefused: (_phone, reason) => refused.push(reason) });
    const phone = snapshot();
    await act(async () => {
      await phones.write("phone-a", { handle: slider, values: { value: 0.9 }, phase: "commit" });
      await phones.settled();
    });
    await settle();
    const byPhone = since(phone);
    expect(refused).toEqual([]);
    expect(runtime.bus.store.getGraph().nodes[slider]?.parameters["value"]).toBe(0.9);
    // The desk shows what the phone wrote, on every surface that draws the control.
    const shown = [...document.querySelectorAll('[role="slider"][aria-label="Gain"]')].map((element) => element.getAttribute("aria-valuenow"));
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(new Set(shown)).toEqual(new Set(["0.9"]));

    for (const [who, moved] of [["the desk", byDesk], ["the phone", byPhone]] as const) {
      expect(moved.app, `${who}: App rendered`).toBe(0);
      expect(moved.structuralCompiles, `${who}: a structural compile`).toBe(0);
      expect(moved.valuesPasses, `${who}: values passes`).toBe(1);
      expect(moved.widgets[slider] ?? 0, `${who}: the control's widget`).toBeGreaterThanOrEqual(1);
      expect(moved.widgets[toggle] ?? 0, `${who}: another control's widget`).toBe(0);
    }
    expect(byPhone.widgets[slider]).toBe(byDesk.widgets[slider]);
    phones.dispose();
    runtime.dispose();
  }, 60_000);

  it("a recall of a preset holding thirty values is ONE values pass, not thirty and not a structural compile", async () => {
    const { runtime, fixture, id, watch } = await stage();
    // Thirty values on ten nodes, and a bank whose preset moves every one of them.
    const refs = Array.from({ length: 10 }, (_unused, index) => `$grade${String(index)}`);
    const made = await patch(
      runtime,
      refs.flatMap((ref, index) => [
        { op: "addNode", ref, type: "level", position: { x: index * 300, y: 900 }, label: `level_g${String(index)}`, parameters: { brightness: 1, contrast: 1, opacity: 1 } },
        { op: "connect", source: { nodeId: id("$solid"), portId: "out" }, target: { nodeId: ref, portId: "input" } },
      ]) as GraphPatchOperation[],
    );
    const names = refs.map((_ref, index) => `level_g${String(index)}`);
    const values = Object.fromEntries(names.map((name, index) => [name, { brightness: 0.5 + index * 0.01, contrast: 1.5, opacity: 0.75 }]));
    const bank = (
      await patch(runtime, [
        {
          op: "addNode", ref: "$bank", type: "presets", position: { x: 0, y: 1200 }, label: "presets_looks",
          parameters: { targets: names.join(" "), presets: serializePresetBank({ version: 1, presets: [{ name: "night", values }] }) },
        },
      ] as GraphPatchOperation[])
    )["$bank"] as NodeId;
    await settle();

    const before = snapshot();
    const installsBefore = fixture.structuralInstalls();
    const escalatedBefore = watch.stats().escalated;
    await act(async () => {
      const recalled = await runtime.bus.execute("preset.recall", { nodeId: bank, name: "night", morph: { seconds: 0, curve: "linear" } }, runtime.invocation);
      expect(recalled.status, JSON.stringify(recalled.diagnostics).slice(0, 400)).toBe("applied");
    });
    await settle();
    const moved = since(before);

    const graph = runtime.bus.store.getGraph();
    expect(refs.map((ref) => graph.nodes[made[ref] as NodeId]?.parameters["contrast"])).toEqual(refs.map(() => 1.5));
    expect(graph.nodes[bank]?.parameters["current"]).toBe("night");
    expect(watch.stats().escalated - escalatedBefore, `the recall left the lane: ${watch.stats().lastEscalation ?? ""}`).toBe(0);
    expect(moved.valuesPasses).toBe(1);
    expect(moved.structuralCompiles).toBe(0);
    expect(moved.app).toBe(0);
    expect(fixture.structuralInstalls() - installsBefore).toBe(0);
    runtime.dispose();
  }, 60_000);
});

describe("T1652b — what the rule must not swallow", () => {
  it("a STRUCTURAL edit still compiles, still re-renders what shows it, and still re-derives what a value cannot move", async () => {
    const { runtime, id } = await stage();
    const blur = id("$blur");
    const edits: ReadonlyArray<{ readonly what: string; readonly operations: GraphPatchOperation[]; readonly newReference: boolean }> = [
      // A mode change: a static knob becomes an expression.
      {
        what: "a mode change",
        operations: [{ op: "setParameters", nodeId: blur, parameters: { size: { mode: "expression", bindings: { expression: { kind: "expression", source: "4 + time" }, static: { kind: "static", value: 4 } } } } }],
        newReference: false,
      },
      // A new expression that reads the control: a reference line that was not there.
      {
        what: "a new expression reading the control",
        operations: [{ op: "setParameters", nodeId: blur, parameters: { size: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('slider_gain').chan.gain * 8" }, static: { kind: "static", value: 4 } } } } }],
        newReference: true,
      },
      // A node and a wire.
      {
        what: "a node and a wire",
        operations: [
          { op: "addNode", ref: "$extra", type: "level", position: { x: 0, y: 1500 }, label: "level_extra" },
          { op: "connect", source: { nodeId: id("$solid"), portId: "out" }, target: { nodeId: "$extra", portId: "input" } },
        ] as GraphPatchOperation[],
        newReference: false,
      },
    ];
    for (const edit of edits) {
      const before = snapshot();
      await patch(runtime, edit.operations);
      await settle();
      const moved = since(before);
      expect(moved.structuralCompiles, `${edit.what}: no structural compile`).toBeGreaterThanOrEqual(1);
      expect(moved.valuesPasses, `${edit.what}: took the values lane`).toBe(0);
      expect(moved.app, `${edit.what}: App did not render`).toBeGreaterThanOrEqual(1);
      expect(moved.graphPane, `${edit.what}: the graph pane did not render`).toBeGreaterThanOrEqual(1);
      expect(moved.requirements, `${edit.what}: the requirement diagnostics did not run`).toBeGreaterThanOrEqual(1);
      if (edit.newReference) expect(moved.referenceGeometry, `${edit.what}: the reference lines were not rebuilt`).toBeGreaterThanOrEqual(1);
    }
    runtime.dispose();
  }, 60_000);

  it("a value that changes what a DIAGNOSTIC says is still said, and unsaid when the value goes back", async () => {
    const { runtime, id, watch } = await stage();
    const slider = id("$slider");
    const level = id("$level");
    // Opacity runs 0 to 1 and the Slider 0 to 2: an expression that reads the control is in range at 0.5.
    await patch(runtime, [
      { op: "setParameters", nodeId: level, parameters: { opacity: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('slider_gain').chan.gain" }, static: { kind: "static", value: 1 } } } } },
    ]);
    await settle();
    const clamped = (): RuntimeDiagnostic[] => counts.problemsShown.filter((entry) => entry.code === "parameter.expression.clamped");
    expect(clamped()).toEqual([]);

    // The write is values-only by every rule of the document. What it changes is what the reader's node SAYS.
    const before = snapshot();
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 1.5 } }]);
    await settle();
    const moved = since(before);
    expect(clamped().map((entry) => entry.nodeId)).toEqual([level]);
    expect(moved.structuralCompiles, "the revision that changed a diagnostic was not compiled in full").toBeGreaterThanOrEqual(1);
    expect(moved.problems).toBeGreaterThanOrEqual(1);
    expect(watch.stats().lastEscalation).toMatch(/says something different about its new value/);

    // Back in range: the warning goes, by the same road.
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 0.5 } }]);
    await settle();
    expect(clamped()).toEqual([]);

    // And in range to in range is the lane again: the doubt was about one revision, not about the node.
    const after = snapshot();
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 0.6 } }]);
    await settle();
    expect(since(after)).toMatchObject({ structuralCompiles: 0, valuesPasses: 1, app: 0 });
    runtime.dispose();
  }, 60_000);

  it("the inspector follows a value on the node it inspects, and on a node that reads it, and sits still for any other", async () => {
    const { runtime, id } = await stage();
    const slider = id("$slider");
    const level = id("$level");
    const blur = id("$blur");
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 0.6 } }]);
    await settle();
    const select = async (nodeId: NodeId): Promise<void> => {
      await act(async () => {
        const result = await runtime.bus.execute("graph.selectNodes", { nodeIds: [nodeId] }, runtime.invocation);
        expect(result.status).toBe("applied");
      });
      await settle();
    };
    const writes = async (nodeId: NodeId, parameters: Record<string, number>): Promise<ReturnType<typeof since>> => {
      const before = snapshot();
      await patch(runtime, [{ op: "setParameters", nodeId, parameters }]);
      await settle();
      return since(before);
    };

    // Inspecting the control: its own value is what the pane shows.
    await select(slider);
    expect((await writes(slider, { value: 0.7 })).inspector).toBeGreaterThanOrEqual(1);
    // Inspecting the node whose expression reads the control: the number it shows moved.
    await select(level);
    expect((await writes(slider, { value: 0.8 })).inspector).toBeGreaterThanOrEqual(1);
    // Inspecting a node with no expression: the control's value is nothing it shows…
    await select(blur);
    expect(await writes(slider, { value: 0.9 })).toMatchObject({ inspector: 0, inspectorPanel: 0 });
    // …and its own value is.
    expect((await writes(blur, { size: 6 })).inspector).toBeGreaterThanOrEqual(1);
    runtime.dispose();
  }, 60_000);
});

describe("T1652b — what still hears a value the root did not render for", () => {
  it("an agent: the diagnostics are stamped with the revision of the value, and `project.compile` answers for it without compiling", async () => {
    const { runtime, id } = await stage();
    const slider = id("$slider");
    for (const value of [0.6, 0.7, 0.8]) await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value } }]);
    await settle();
    const before = snapshot();
    const revision = runtime.bus.store.getRevision();
    // "Did you look at my edit?" (§V338): the list is this revision's, the lane verified it.
    const diagnostics = await runtime.bus.query("diagnostics.get", {}, runtime.invocation);
    expect(diagnostics.revision).toBe(revision);
    const compiled = await runtime.bus.execute("project.compile", {}, runtime.invocation);
    expect(compiled.status).toBe("applied");
    expect(compiled.output).toMatchObject({ ok: true, compiled: true });
    // The plan it reports is the lane's, on hand: asking did not compile the document.
    expect(since(before)).toMatchObject({ structuralCompiles: 0, app: 0 });
    runtime.dispose();
  }, 60_000);

  it("a value written while a structural build is on its way is not lost: it lands behind that build", async () => {
    const { runtime, fixture, id, watch } = await stage();
    const slider = id("$slider");
    const level = id("$level");
    const valueIn = (plan: CompiledGraph | undefined): unknown[] =>
      (plan?.passes ?? []).filter((pass) => pass.id.startsWith(level)).flatMap((pass) => ("uniforms" in pass ? Object.values(pass.uniforms ?? {}) : []));

    fixture.holdInstalls();
    const installsBefore = fixture.structuralInstalls();
    // A structural edit whose plan has the SAME structure as the one installed (a rename):
    // its build is handed to the backend and does not land yet. The same structure is the
    // case that matters — a uniform write into the old program would be accepted, and the
    // build then lands on top of it with the values it was compiled with.
    await patch(runtime, [{ op: "setNodeLabel", nodeId: id("$blur"), label: "blur_other" }]);
    expect(fixture.structuralInstalls() - installsBefore, "the rename did not start a build").toBe(1);
    const uniformsBefore = fixture.uniforms.length;
    // The value arrives meanwhile. The device still holds the OLD program, so it cannot be a uniform write…
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 1.25 } }]);
    expect(watch.stats().lastEscalation).toMatch(/could not take the values as a uniform write/);
    expect(fixture.uniforms.length - uniformsBefore, "a uniform was written into a program about to be replaced").toBe(0);
    // …so it takes the structural road, behind the build on its way.
    fixture.releaseInstalls();
    await settle();
    await settle();
    expect(valueIn(fixture.plans[fixture.plans.length - 1])).toContain(1.25);
    // And the next value is the lane again.
    const before = snapshot();
    await patch(runtime, [{ op: "setParameters", nodeId: slider, parameters: { value: 1.3 } }]);
    await settle();
    expect(since(before)).toMatchObject({ structuralCompiles: 0, valuesPasses: 1, app: 0 });
    runtime.dispose();
  }, 60_000);
});

