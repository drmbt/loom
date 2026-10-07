// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { ComponentSession } from "@domain/components/session.ts";
import { loadProject } from "@domain/project/load.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { AppRuntime, AppRuntimeOptions } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * §T1696b / §B286 — A KEY PRESSED INSIDE A COMPONENT ACTS ON THE COMPONENT.
 *
 * The bug, as measured on main before this row (`docs/component-session-commands-design-
 * 2026-10-06.md` §0.3), through this same mounted app and this same keymap:
 *
 *  - inside Bloom, one Cmd+Z removed a node that had been added at the ROOT: the project
 *    was undone while the user was looking at a component;
 *  - inside DepthCut of the shipped E47 Hologram, with the interior node `cut` selected,
 *    Delete removed the ROOT node `cut`, which is the very instance being edited, and
 *    left the interior node standing;
 *  - `l` laid out the project.
 *
 * One cause: the keymap dispatched on the project's bus with the ids of the graph on the
 * canvas. Each test below is that report, literally: the real `<App>`, a dive through the
 * real command, a real `keydown`. The same three are held in a real browser by
 * `src/tests/e2e/component-keys.spec.ts`.
 */

const sessions: ComponentSession[] = [];
vi.mock("@domain/components/session.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@domain/components/session.ts")>();
  return {
    ...original,
    openComponentSession: (options: Parameters<typeof original.openComponentSession>[0]) => {
      const session = original.openComponentSession(options);
      sessions.push(session);
      return session;
    },
  };
});

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(() => {
  cleanup();
  sessions.length = 0;
});

const settle = (): Promise<void> => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 30)));

async function mounted(options: Partial<AppRuntimeOptions> = {}): Promise<AppRuntime> {
  const { App } = await import("../../app/app.tsx");
  const { createAppRuntime } = await import("../../app/app-runtime.ts");
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester" }, ...options });
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />);
  });
  return runtime;
}

/** Dives into `instance` and returns the session the app opened, with the canvas showing its inside. */
async function dive(runtime: AppRuntime, instance: NodeId): Promise<ComponentSession> {
  await act(async () => {
    await runtime.bus.execute("graph.diveIn", { nodeId: instance }, runtime.invocation);
  });
  await settle();
  const session = sessions.at(-1);
  if (session === undefined) throw new Error("the dive opened no session");
  // The precondition, asserted: the canvas holds the component's nodes, not the project's.
  const framed = await act(async () => runtime.bus.execute("view.frameAll", {}, runtime.invocation));
  expect(framed.output.framed).toBe(Object.keys(session.store.view.getGraph().nodes).length);
  return session;
}

/** The pane a person has clicked into: `graph` keys resolve from the focused element. */
function graphPane(): HTMLElement {
  const pane = document.querySelector<HTMLElement>('[data-keymap-context="graph"]');
  if (pane === null) throw new Error("no graph pane is mounted");
  pane.focus();
  return pane;
}

async function press(target: EventTarget, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target as Element, init);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("§B286 — Cmd+Z inside a component", () => {
  it("undoes the edit made inside, and leaves the project's last edit alone", async () => {
    const runtime = await mounted();
    const placed = await act(async () => runtime.bus.execute("component.instantiate", { componentId: "bloom", position: { x: 0, y: 0 } }, runtime.invocation));
    const instance = placed.output.nodeId as NodeId;
    // An edit at the ROOT: the project's most recent undo step.
    const atRoot = await act(async () =>
      runtime.bus.execute(
        "graph.applyPatch",
        { baseRevision: runtime.bus.store.getRevision(), label: "add", operations: [{ op: "addNode", ref: "$n", type: "noise", position: { x: 300, y: 0 } }] },
        runtime.invocation,
      ),
    );
    const rootNode = atRoot.output.createdIds["$n"] as NodeId;
    const session = await dive(runtime, instance);

    // An edit INSIDE, the way the canvas makes one: a patch on the bus the pane edits through.
    const insideEdit = await act(async () =>
      session.bus.execute(
        "graph.applyPatch",
        { baseRevision: session.store.view.getRevision(), label: "add", operations: [{ op: "addNode", ref: "$i", type: "noise", position: { x: 0, y: 400 } }] },
        runtime.invocation,
      ),
    );
    const innerNode = insideEdit.output.createdIds["$i"] as NodeId;
    expect(session.store.view.getGraph().nodes[innerNode]).toBeDefined();
    const rootAudit = runtime.bus.store.getAudit().length;

    // Both spellings of `mod`, so the claim does not depend on which platform jsdom reports.
    await press(window, { key: "z", code: "KeyZ", metaKey: true });
    await press(window, { key: "z", code: "KeyZ", ctrlKey: true });

    // The inside edit came back out...
    expect(session.store.view.getGraph().nodes[innerNode]).toBeUndefined();
    expect(runtime.components.get("bloom" as never, 1)?.graph.nodes[innerNode]).toBeUndefined();
    // ...and the project's stands: its node, its history, its audit. The second press found
    // nothing left to undo inside, and that is where it stopped.
    expect(runtime.bus.store.getGraph().nodes[rootNode]).toBeDefined();
    expect(runtime.bus.store.getGraph().nodes[instance]).toBeDefined();
    expect(runtime.bus.store.getAudit().slice(rootAudit).map((entry) => entry.command)).not.toContain("graph.undo");
  });
});

describe("§B286 — Delete and `l` inside a component of a shipped example whose ids collide", () => {
  async function insideDepthCut() {
    const { createAppRuntime } = await import("../../app/app-runtime.ts");
    const registry = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "loader" } }).registry;
    const loaded = loadProject(readFileSync("examples/E47-Hologram.loom.json", "utf8"), { registry } as never);
    if (!loaded.ok) throw new Error("E47 did not load");
    const runtime = await mounted({ document: loaded.document, components: loaded.components });
    // The collision the report rests on: `cut` is a node of the project AND of the component.
    expect(runtime.bus.store.getGraph().nodes["cut"]?.type).toBe("component:depthCut@1");
    const session = await dive(runtime, "cut");
    expect(session.componentId).toBe("depthCut");
    expect(session.store.view.getGraph().nodes["cut"]).toBeDefined();
    return { runtime, session };
  }

  it("Delete removes the interior node that is selected, and the instance of the same id stands", async () => {
    const { runtime, session } = await insideDepthCut();
    const root = { revision: runtime.bus.store.getRevision(), graph: runtime.bus.store.getGraph() };

    // Select the interior `cut` the way a click does, then press the key with the pane focused.
    await act(async () => {
      await runtime.bus.execute("graph.selectNodes", { nodeIds: ["cut"] }, runtime.invocation);
    });
    await settle();
    await press(graphPane(), { key: "Delete", code: "Delete" });

    expect(session.store.view.getGraph().nodes["cut"]).toBeUndefined();
    // The project is the same object it was: nothing in it was touched, the instance least of all.
    expect(runtime.bus.store.getGraph()).toBe(root.graph);
    expect(runtime.bus.store.getGraph().nodes["cut"]?.type).toBe("component:depthCut@1");
    expect(runtime.bus.store.getRevision()).toBe(root.revision);
  });

  it("`l` lays out what is on screen, and the project keeps its layout", async () => {
    const { runtime, session } = await insideDepthCut();
    const root = { revision: runtime.bus.store.getRevision(), graph: runtime.bus.store.getGraph() };
    // Throw one interior node far out, so there IS something to tidy on screen.
    await act(async () => {
      await session.bus.execute(
        "graph.applyPatch",
        { baseRevision: session.store.view.getRevision(), label: "move", operations: [{ op: "moveNodes", positions: { matte: { x: 4000, y: 4000 } } }] },
        runtime.invocation,
      );
    });
    const before = session.store.view.getRevision();

    await press(graphPane(), { key: "l", code: "KeyL" });

    expect(session.store.view.getRevision()).toBeGreaterThan(before);
    expect(session.store.view.getGraph().nodes["matte"]?.position).not.toEqual({ x: 4000, y: 4000 });
    expect(runtime.bus.store.getGraph()).toBe(root.graph);
    expect(runtime.bus.store.getRevision()).toBe(root.revision);
  });
});

describe("§T1696b — what is MEANT to reach the project from inside a component still does", () => {
  /**
   * The case the guard above could swallow. "No command run inside a component touches the
   * project" would be a simpler rule and a wrong one: the transport, the show's cue keys and
   * a page bank's recall are the project's, and standing inside a component must not take
   * them away. Each reaches the project because its command SAYS so (`inSession`), not
   * because a graph edit fell through.
   */
  it("the GO key, with the editor inside a component, fires the show's cue list", async () => {
    const runtime = await mounted();
    const { serializePresetBank } = await import("@domain/presets/bank.ts");
    const { serializeCueList } = await import("@domain/presets/cue-list.ts");
    const built = await act(async () =>
      runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "a show",
          operations: [
            { op: "addNode", ref: "$level", type: "level", label: "level_show", position: { x: 0, y: 300 } },
            {
              op: "addNode",
              ref: "$bank",
              type: "presets",
              label: "presets_show",
              position: { x: 300, y: 300 },
              parameters: { targets: "level_show", presets: serializePresetBank({ version: 1, presets: [{ name: "bright", values: { level_show: { brightness: 3 } } }] }) },
            },
            {
              op: "addNode",
              ref: "$cues",
              type: "cueList",
              label: "cuelist_show",
              position: { x: 600, y: 300 },
              parameters: { keys: true, cues: serializeCueList({ version: 1, cues: [{ name: "1", bank: "presets_show", preset: "bright" }] }) },
            },
          ],
        },
        runtime.invocation,
      ),
    );
    expect(built.status, built.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
    const level = built.output.createdIds["$level"] as NodeId;
    const placed = await act(async () => runtime.bus.execute("component.instantiate", { componentId: "bloom", position: { x: 0, y: 0 } }, runtime.invocation));
    const session = await dive(runtime, placed.output.nodeId as NodeId);
    const inside = session.store.view.getRevision();

    // The key's own call: `cue.go` with no list named, on the bus a key dispatches on.
    const go = await act(async () => session.bus.execute("cue.go", {}, runtime.invocation));

    expect(go.status, go.diagnostics.map((each) => `${each.code}: ${each.message}`).join("; ")).toBe("applied");
    // The show's cue fired in the PROJECT; the component was not asked for a cue list it does not have.
    expect(runtime.bus.store.getGraph().nodes[level]?.parameters["brightness"]).toBe(3);
    expect(session.store.view.getRevision()).toBe(inside);
  });

  it("play and pause answer from inside a component as they do outside", async () => {
    const runtime = await mounted();
    const placed = await act(async () => runtime.bus.execute("component.instantiate", { componentId: "bloom", position: { x: 0, y: 0 } }, runtime.invocation));
    const outside = await act(async () => runtime.bus.execute("transport.togglePlay", {}, { ...runtime.invocation, dryRun: true }));
    const session = await dive(runtime, placed.output.nodeId as NodeId);
    const inside = await act(async () => session.bus.execute("transport.togglePlay", {}, { ...runtime.invocation, dryRun: true }));
    expect([inside.status, inside.diagnostics.map((each) => each.code)]).toEqual([outside.status, outside.diagnostics.map((each) => each.code)]);
  });
});
