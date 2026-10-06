// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { buildProjectFile, loadProject } from "@domain/project/index.ts";
import type { SnapshotMeta, SnapshotRecord, SnapshotStore } from "@domain/project/index.ts";
import { componentNodeType } from "@domain/components/component-type.ts";
import { COMPONENT_SESSION_STALE_CODE } from "@domain/components/session.ts";
import { parsePresetBank } from "@domain/presets/bank.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";
import { useComponentEditing } from "./use-component-editing.ts";
import type { ComponentEditing } from "./use-component-editing.ts";

/**
 * §T1540b — A STORE ON A LOOK INSTANCE IS PROJECT WORK, AND NOTHING MAY LOSE IT.
 *
 * Store and Delete on a look instance write the COMPONENT (§T1505b), not the document, so
 * the document's revision does not move. Before this row, three things followed from that,
 * each a way to lose the preset:
 *
 *   1. autosave listened to the document only, so the Store reached no snapshot until some
 *      unrelated edit — and the snapshot carried no component library, so even then a
 *      restore dropped it;
 *   2. the unsaved-work question read the revision only, so New/Open threw it away without
 *      asking;
 *   3. a component editor open on that component held the graph from before the Store and
 *      wrote it back on its next commit — any commit, a rename — dropping the preset.
 *
 * Everything below runs the composed runtime (`createAppRuntime`) and the real hooks: the
 * App itself for (1) and (2), `useComponentEditing` for (3). Asserted is what a consumer
 * reads back: the snapshot's bytes, a reopened runtime's recall, the dialog on screen, the
 * catalogue's definition.
 *
 * SENSITIVITY (each red-verified by editing the fix out): dropping the catalogue
 * subscription in `use-autosave.ts` reddens "autosaves a Store" (no snapshot is written);
 * dropping its `serialize` reddens it too (the snapshot holds no component library); the
 * byte comparison in `autosave.ts` reverted to "same revision = skip" reddens "a second
 * Store"; `useDocumentDirty` without the catalogue in `app.tsx` reddens "asks before New";
 * the session guard in `session.ts` removed reddens the editor case (the preset is gone),
 * and the reopen in `use-component-editing.ts` removed reddens it the other way (the rename
 * is refused instead of landing).
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const ACTOR = { kind: "human" as const, id: "tester", label: "Tester" };
const NO_GPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

/** A look: one published `spread`, a page bank `looks` (Targets `parent`) holding `calm`. */
function lookDefinition(): GraphComponentDefinition {
  const presets = JSON.stringify({ version: 1, presets: [{ name: "calm", values: { parent: { spread: 2 } } }] });
  return {
    componentId: "look",
    version: 1,
    name: "Look",
    graph: {
      revision: 1,
      nodes: {
        entry: { id: "entry" as NodeId, type: "componentIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "feed" },
        blurA: { id: "blurA" as NodeId, type: "blur", definitionVersion: 1, position: { x: 240, y: 0 }, parameters: {} },
        exit: { id: "exit" as NodeId, type: "componentOut", definitionVersion: 1, position: { x: 480, y: 0 }, parameters: {}, label: "result" },
        bank: { id: "bank" as NodeId, type: "presets", label: "looks", definitionVersion: 1, position: { x: 0, y: 200 }, parameters: { targets: "parent", presets } },
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "entry" as NodeId, portId: "out" }, target: { nodeId: "blurA" as NodeId, portId: "input" } },
        e1: { id: "e1", source: { nodeId: "blurA" as NodeId, portId: "out" }, target: { nodeId: "exit" as NodeId, portId: "in" } },
      },
      groups: {},
    } as never,
    inputs: [],
    outputs: [],
    parameters: [{ key: "spread", definition: { type: "number", label: "Spread", default: 4, min: 0, max: 64 }, targets: [] }],
  };
}

/** The runtime with the look installed and one instance `city` at spread 20 — all BEFORE mount. */
async function lookRuntime(): Promise<{ runtime: AppRuntime; cityId: NodeId }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: ACTOR });
  runtime.components.register(lookDefinition());
  const placed = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "seed",
      operations: [
        { op: "addNode", ref: "$city", type: componentNodeType("look", 1), position: { x: 0, y: 0 }, label: "city", parameters: { spread: 20 } },
      ],
    },
    runtime.invocation,
  );
  expect(placed.status).toBe("applied");
  return { runtime, cityId: placed.output.createdIds["$city"] as NodeId };
}

/** The preset names in the page bank of whichever `look` a catalogue holds. */
function bankNames(definition: GraphComponentDefinition | undefined): string[] {
  const parsed = parsePresetBank(definition?.graph.nodes["bank"]?.parameters["presets"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.bank.presets.map((preset) => preset.name);
}

async function store(runtime: AppRuntime, cityId: NodeId, name: string): Promise<void> {
  await act(async () => {
    const result = await runtime.bus.execute("preset.store", { nodeId: cityId, name }, runtime.invocation);
    expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  });
}

function memorySnapshotStore() {
  const records = new Map<string, SnapshotRecord>();
  const puts: SnapshotRecord[] = [];
  const store: SnapshotStore = {
    async list(projectId: string): Promise<SnapshotMeta[]> {
      return [...records.values()]
        .filter((record) => record.projectId === projectId)
        .map(({ key, revision, savedAt, pinned }) => ({ key, revision, savedAt, pinned }));
    },
    async get(projectId: string, key: string): Promise<SnapshotRecord | undefined> {
      return records.get(`${projectId}/${key}`);
    },
    async put(record: SnapshotRecord): Promise<void> {
      puts.push(record);
      records.set(`${record.projectId}/${record.key}`, record);
    },
    async delete(projectId: string, key: string): Promise<void> {
      records.delete(`${projectId}/${key}`);
    },
  };
  return { store, puts };
}

async function mountApp(runtime: AppRuntime, snapshots: SnapshotStore, onRuntimeChange?: (next: AppRuntime) => void) {
  const createSnapshotStore = () => snapshots;
  await act(async () => {
    render(
      <App
        runtime={runtime}
        storage={createMemoryStorage()}
        gpuProbe={() => Promise.resolve(NO_GPU)}
        createSnapshotStore={createSnapshotStore}
        {...(onRuntimeChange === undefined ? {} : { onRuntimeChange })}
      />,
    );
  });
}

/** Opens snapshot bytes the way `project.open` does: the real loader, the real runtime constructor. */
function reopen(text: string): AppRuntime {
  const scratch = createAppRuntime({ identityStorage: null, actor: ACTOR });
  const loaded = loadProject(text, { nodes: scratch.registry, components: scratch.components });
  if (!loaded.ok) throw new Error(loaded.reason);
  return createAppRuntime({ identityStorage: null, actor: ACTOR, document: loaded.document, components: loaded.components });
}

/** The Problems list's rows, read the way a person finds them: by the code each row shows. */
const problems = () => within(screen.getByLabelText("Problems"));
const PATH_MISSING_CODE = "component.path.missingNode";

// The scheduler's own debounce (2 s): these cases wait for the real one.
const AUTOSAVE_WAIT = { timeout: 6000 };

describe("§T1540b — a Store on a look instance reaches autosave and the unsaved-work question", () => {
  it("autosaves a Store, and the snapshot reopens with the preset, which recalls", async () => {
    const { runtime, cityId } = await lookRuntime();
    const { store: snapshots, puts } = memorySnapshotStore();
    await mountApp(runtime, snapshots);
    const revision = runtime.bus.store.getRevision();

    await store(runtime, cityId, "bright");
    // The premise: the document did not move. Only the catalogue did.
    expect(runtime.bus.store.getRevision()).toBe(revision);

    await waitFor(() => expect(puts.length).toBeGreaterThan(0), AUTOSAVE_WAIT);
    const snapshot = puts.at(-1) as SnapshotRecord;

    const reopened = reopen(snapshot.body);
    expect(bankNames(reopened.components.get("look", 1))).toEqual(["calm", "bright"]);
    // And it RECALLS there: move the instance off, recall, the stored 20 comes back.
    const moved = await reopened.bus.execute(
      "graph.applyPatch",
      { baseRevision: reopened.bus.store.getRevision(), label: "move", operations: [{ op: "setParameters", nodeId: cityId, parameters: { spread: 7 } }] },
      reopened.invocation,
    );
    expect(moved.status).toBe("applied");
    const recalled = await reopened.bus.execute("preset.recall", { nodeId: cityId, name: "bright" }, reopened.invocation);
    expect(recalled.status, recalled.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
    expect(reopened.bus.store.getGraph().nodes[cityId]?.parameters["spread"]).toBe(20);
  }, 15_000);

  it("a second Store at the same document revision is written too — the bytes decide, not the revision", async () => {
    const { runtime, cityId } = await lookRuntime();
    const { store: snapshots, puts } = memorySnapshotStore();
    await mountApp(runtime, snapshots);

    await store(runtime, cityId, "bright");
    await waitFor(() => expect(puts.length).toBe(1), AUTOSAVE_WAIT);
    await store(runtime, cityId, "dark");
    await waitFor(() => expect(puts.length).toBe(2), AUTOSAVE_WAIT);
    expect(puts[0]?.revision).toBe(puts[1]?.revision);
    expect(bankNames(reopen(puts[1]?.body ?? "").components.get("look", 1))).toEqual(["calm", "bright", "dark"]);
  }, 20_000);

  it("asks before New after a Store, and does not ask for the same project untouched", async () => {
    // The control first: the seeded project is CLEAN at mount, so New goes straight through.
    {
      const { runtime } = await lookRuntime();
      let swapped: AppRuntime | null = null;
      await mountApp(runtime, memorySnapshotStore().store, (next) => (swapped = next));
      await act(async () => {
        await runtime.bus.execute("project.new", {}, runtime.invocation);
      });
      expect(screen.queryByTestId("unsaved-changes-dialog")).toBeNull();
      expect(swapped).not.toBeNull();
      cleanup();
    }

    const { runtime, cityId } = await lookRuntime();
    await mountApp(runtime, memorySnapshotStore().store);
    await store(runtime, cityId, "bright");
    await act(async () => {
      void runtime.bus.execute("project.new", {}, runtime.invocation);
    });
    expect(await screen.findByTestId("unsaved-changes-dialog")).toBeDefined();
  });
});

interface Handle {
  editing: ComponentEditing;
}

function EditingHarness({ runtime, handle }: { runtime: AppRuntime; handle: Handle }) {
  handle.editing = useComponentEditing(runtime);
  return null;
}

describe("§T1540b — a component editor open on the look does not write its stale graph over a Store", () => {
  it("rebases: the Store survives the editor's next unrelated edit, and the edit lands too", async () => {
    const { runtime, cityId } = await lookRuntime();
    const handle = { editing: null as unknown as ComponentEditing };
    await act(async () => {
      render(<EditingHarness runtime={runtime} handle={handle} />);
    });
    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: cityId }, runtime.invocation);
    });
    expect(handle.editing.definition?.componentId).toBe("look");
    expect(handle.editing.bus).not.toBe(runtime.bus);

    // From OUTSIDE the editor — the root bus, as an agent or the inspector does it.
    await store(runtime, cityId, "bright");

    // An edit that has nothing to do with the bank, on the bus the canvas holds now.
    await act(async () => {
      const renamed = await handle.editing.bus.execute("node.rename", { nodeId: "blurA", label: "softened", exact: true }, runtime.invocation);
      expect(renamed.status).toBe("applied");
    });

    const definition = runtime.components.get("look", 1);
    expect(bankNames(definition)).toEqual(["calm", "bright"]);
    expect(definition?.graph.nodes["blurA"]?.label).toBe("softened");
    // The editor says why its undo history restarted, by name.
    expect(handle.editing.diagnostics.map((each) => each.code)).toContain(COMPONENT_SESSION_STALE_CODE);
    expect(handle.editing.graph.nodes["blurA"]?.label).toBe("softened");
  });
});

/**
 * §T1543b — WHAT THE COMPONENT EDITOR HAS TO SAY REACHES THE PROBLEMS LIST.
 *
 * `useComponentEditing` reported two things nobody rendered: the session it reopened over
 * an outside write (§T1540b's rebase, which restarts undo inside the component), and the
 * path that stopped resolving and put the user back out. Both are events, held like every
 * other accumulating source: Clear empties them (T465) and so does the next project (T792).
 *
 * SENSITIVITY (red-verified by editing): `...editing.diagnostics` out of `problems` in
 * `app.tsx` reddens both rows; the held `ejected` note in `use-component-editing.ts`
 * replaced by the walk's own diagnostics reddens the path case (truncation erases them in
 * the same commit); `clearEditingDiagnostics` out of `clearProblems` reddens the Clear;
 * the `[runtime]` reset in `use-component-editing.ts` dropped reddens both new-project cases.
 */
describe("§T1543b — the component editor's notes are rows in the Problems list", () => {
  async function diveIn(runtime: AppRuntime, cityId: NodeId) {
    await act(async () => {
      const dived = await runtime.bus.execute("graph.diveIn", { nodeId: cityId }, runtime.invocation);
      expect(dived.status).toBe("applied");
    });
  }

  it("a session reopened over an outside Store shows its info row, until Clear", async () => {
    const { runtime, cityId } = await lookRuntime();
    await mountApp(runtime, memorySnapshotStore().store);
    await diveIn(runtime, cityId);
    expect(problems().queryByText(COMPONENT_SESSION_STALE_CODE)).toBeNull();

    // From OUTSIDE the editor: the root bus writes the component the editor has open.
    await store(runtime, cityId, "bright");

    const info = await waitFor(() => problems().getByRole("region", { name: "info" }));
    expect(within(info).getByText(COMPONENT_SESSION_STALE_CODE)).toBeDefined();

    // T465: nothing about it is still true once said, so Clear empties it for good.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear problems" }));
    });
    expect(problems().queryByText(COMPONENT_SESSION_STALE_CODE)).toBeNull();
  });

  it("deleting the instance being edited shows why the editor left it, until the next project", async () => {
    const { runtime, cityId } = await lookRuntime();
    await mountApp(runtime, memorySnapshotStore().store);
    await diveIn(runtime, cityId);

    await act(async () => {
      const removed = await runtime.bus.execute(
        "graph.applyPatch",
        { baseRevision: runtime.bus.store.getRevision(), label: "delete city", operations: [{ op: "removeNodes", nodeIds: [cityId] }] },
        runtime.invocation,
      );
      expect(removed.status).toBe("applied");
    });

    const warnings = await waitFor(() => problems().getByRole("region", { name: "warnings" }));
    expect(within(warnings).getByText(PATH_MISSING_CODE)).toBeDefined();

    // T792: it is about the project being left, so it does not follow you into a new one.
    await act(async () => {
      void runtime.bus.execute("project.new", {}, runtime.invocation);
    });
    const discard = await screen.findByRole("button", { name: "Discard" });
    await act(async () => {
      fireEvent.click(discard);
    });
    await waitFor(() => expect(problems().queryByText(PATH_MISSING_CODE)).toBeNull());
  });

  it("a new project opened from inside a component leaves no row: that path never existed there", async () => {
    const { runtime, cityId } = await lookRuntime();
    let swapped: AppRuntime | null = null;
    await mountApp(runtime, memorySnapshotStore().store, (next) => (swapped = next));
    await diveIn(runtime, cityId);

    await act(async () => {
      await runtime.bus.execute("project.new", {}, runtime.invocation);
    });
    expect(swapped).not.toBeNull();
    expect(problems().queryByText(PATH_MISSING_CODE)).toBeNull();
  });
});

/*
 * SENSITIVITY (red-verified by editing): `use-project.ts` loading against the open
 * runtime's registry and catalogue again reddens this (the outgoing catalogue is written).
 */
describe("§T1543b — an Open loads the file's components into the incoming runtime", () => {
  it("writes nothing to the outgoing project, so no autosave of it is scheduled, and the instances still resolve", async () => {
    // The file: a project whose library carries `look`, with an instance of it.
    const { runtime: source, cityId } = await lookRuntime();
    const text = buildProjectFile({
      document: source.projectDocument(),
      components: [source.components.get("look", 1) as GraphComponentDefinition],
    }).text;
    source.dispose();

    const outgoing = createAppRuntime({ identityStorage: null, actor: ACTOR });
    // Autosave's two change sources on the outgoing project (`use-autosave.ts`): a
    // notification from either is what schedules a write of it.
    let outgoingWrites = 0;
    outgoing.components.subscribe(() => (outgoingWrites += 1));
    outgoing.bus.store.subscribe(() => (outgoingWrites += 1));
    let incoming: AppRuntime | null = null;
    await mountApp(outgoing, memorySnapshotStore().store, (next) => (incoming = next));

    await act(async () => {
      const opened = await outgoing.bus.execute("project.open", { text, fileName: "look.loom.json" }, outgoing.invocation);
      expect(opened.status).toBe("applied");
    });

    const adopted = incoming as AppRuntime | null;
    expect(adopted).not.toBeNull();
    expect(outgoingWrites).toBe(0);
    expect(outgoing.components.get("look", 1)).toBeUndefined();
    // The legitimate case the change must not swallow: the file's own component is in the
    // runtime that opened it, and its instance is that component, not a placeholder.
    expect(adopted?.components.get("look", 1)).toBeDefined();
    expect(adopted?.bus.store.getGraph().nodes[cityId]?.type).toBe(componentNodeType("look", 1));
    expect(problems().queryByText("project.node.unknownType")).toBeNull();
  });
});
