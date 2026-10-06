import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphEdge, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSlot, StoredParameter } from "../types/parameters.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { STORED_READ, resolveParameters } from "../parameters/resolve.ts";
import { loadProject } from "../project/load.ts";
import { serializeProjectDocument } from "../project/serialize.ts";
import { testDocument } from "../project/test-support.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { controlDefaultState, controlNodeDefinitions } from "../../nodes/definitions/controls.ts";
import type { LoomBus } from "./bus.ts";
import { createDomainBus } from "./index.ts";
import { alice, bob, contextFor, patch } from "./test-support.ts";

/**
 * T1619b S1 — a control goes back to its default, and takes its value as it, through the
 * REAL bus. Owner: "ways to reset controls individually or all according to what was saved".
 *
 * Each test asserts what a performer gets from the press: the value the control reads
 * after it (through the one read path, §V61), what one undo gives back, and that the whole
 * command was ONE revision and ONE audit entry — never which function ran.
 */

const registry = createNodeRegistry(controlNodeDefinitions).view();
const VERSIONS: Readonly<Record<string, number>> = Object.fromEntries(controlNodeDefinitions.map((each) => [each.type, each.version]));

function control(id: NodeId, type: string, parameters: Record<string, StoredParameter>): GraphNode {
  return { id, type, label: id, definitionVersion: VERSIONS[type] ?? 1, position: { x: 0, y: 0 }, parameters };
}

/** A Panel and the wires that make `members` its controls, in that order. */
function panel(id: NodeId, members: readonly NodeId[]): { node: GraphNode; edges: GraphEdge[] } {
  return {
    node: control(id, "panel", { title: id }),
    edges: members.map((member, order) => ({
      id: `${id}_${member}`,
      source: { nodeId: member, portId: "out" },
      target: { nodeId: id, portId: "controls" },
      order,
    })),
  };
}

function harness(nodes: readonly GraphNode[], edges: readonly GraphEdge[] = []): { bus: LoomBus; store: GraphStore } {
  const initialGraph: GraphDocument = {
    revision: 0,
    nodes: Object.fromEntries(nodes.map((each) => [each.id, each])),
    edges: Object.fromEntries(edges.map((each) => [each.id, each])),
    groups: {},
  };
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-06T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store, registry });
  return { bus, store };
}

/** What a consumer reads for a key of a node: the one read path, not the stored slot. */
function reads(store: GraphStore, nodeId: NodeId, key: string): unknown {
  const node = store.view.getGraph().nodes[nodeId]!;
  return resolveParameters(node, registry.get(node.type), STORED_READ).values[key];
}

/** A hand moves a control: an ordinary parameter write, as the desk's widget and a phone make. */
async function move(bus: LoomBus, store: GraphStore, nodeId: NodeId, parameters: Record<string, StoredParameter>): Promise<void> {
  const result = await bus.execute("graph.applyPatch", patch(store.view.getRevision(), [{ op: "setParameters", nodeId, parameters }]), contextFor(alice));
  expect(result.status).toBe("applied");
}

const heat = (): GraphNode => control("slider_heat", "slider", { channel: "heat", value: 1, min: 0, max: 2, defaultValue: 1 });

describe("control.reset sends a moved control back to its default as ONE patch (T1619b)", () => {
  it("a slider moved to 1.7 reads its default 1 after the reset; one revision, one audit entry, and one undo gives 1.7 back", async () => {
    const { bus, store } = harness([heat()]);
    await move(bus, store, "slider_heat", { value: 1.7 });
    expect(reads(store, "slider_heat", "value")).toBe(1.7);

    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;
    const undoBefore = store.view.getHistory(alice).undo.length;

    const reset = await bus.execute("control.reset", { nodeIds: ["slider_heat"] }, contextFor(alice));
    expect(reset.status).toBe("applied");
    expect(reset.output).toEqual({ ok: true, changed: ["slider_heat"], skipped: [] });
    expect(reset.diagnostics).toEqual([]);

    expect(reads(store, "slider_heat", "value")).toBe(1);
    expect(store.view.getRevision()).toBe(revision + 1);
    expect(store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status, entry.actor.id])).toEqual([["control.reset", "applied", "alice"]]);
    const history = store.view.getHistory(alice).undo;
    expect(history).toHaveLength(undoBefore + 1);
    expect(history.at(-1)?.label).toBe("Reset slider_heat");

    expect((await bus.execute("graph.undo", {}, contextFor(alice))).status).toBe("applied");
    expect(reads(store, "slider_heat", "value")).toBe(1.7);
  });

  it("stays its own undo group inside a drag's transaction: one undo takes back the reset alone", async () => {
    const { bus, store } = harness([heat()]);
    const drag = contextFor(alice, { transactionId: "drag-1" });
    await bus.execute("graph.applyPatch", patch(store.view.getRevision(), [{ op: "setParameters", nodeId: "slider_heat", parameters: { value: 0.3 } }]), drag);
    await bus.execute("control.reset", { nodeIds: ["slider_heat"] }, drag);
    expect(reads(store, "slider_heat", "value")).toBe(1);
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(reads(store, "slider_heat", "value")).toBe(0.3);
  });

  it("a toggle and both axes of an XY pad reset the same way, the pad in one write", async () => {
    const { bus, store } = harness([
      control("toggle_invert", "toggle", { channel: "invert", on: false, defaultOn: true }),
      control("xypad_warp", "xyPad", { channel: "warp", x: 0.1, y: 0.9, min: 0, max: 1, defaultX: 0.82, defaultY: 0.78 }),
    ]);
    const revision = store.view.getRevision();
    const reset = await bus.execute("control.reset", { nodeIds: ["toggle_invert", "xypad_warp"] }, contextFor(alice));
    expect(reset.output).toEqual({ ok: true, changed: ["toggle_invert", "xypad_warp"], skipped: [] });
    expect(reads(store, "toggle_invert", "on")).toBe(true);
    expect([reads(store, "xypad_warp", "x"), reads(store, "xypad_warp", "y")]).toEqual([0.82, 0.78]);
    expect(store.view.getRevision()).toBe(revision + 1);
  });

  it("the inspector's Reset to default on the Value means the same number, not the type's 0.5", async () => {
    const { bus, store } = harness([heat()]);
    await move(bus, store, "slider_heat", { value: 0.2 });
    const reset = await bus.execute("parameter.reset", { nodeId: "slider_heat", parameterKey: "value" }, contextFor(alice));
    expect(reset.status).toBe("applied");
    expect(reads(store, "slider_heat", "value")).toBe(1);
  });

  it("a default outside the range reads as the nearest end, and is not snapped to Step", async () => {
    const { bus, store } = harness([control("slider_gain", "slider", { channel: "gain", value: 0, min: 0, max: 2, step: 0.5, defaultValue: 0.7 }), control("slider_over", "slider", { channel: "over", value: 0, min: 0, max: 2, defaultValue: 9 })]);
    await bus.execute("control.reset", { all: true }, contextFor(alice));
    expect(reads(store, "slider_gain", "value")).toBe(0.7);
    expect(reads(store, "slider_over", "value")).toBe(2);
  });
});

describe("control.setDefault makes the current value the default (T1619b)", () => {
  it("set as default at 1.7, move away, reset: it returns to 1.7, and one undo of the set gives the old default back", async () => {
    const { bus, store } = harness([heat()]);
    await move(bus, store, "slider_heat", { value: 1.7 });
    const auditBefore = store.view.getAudit().length;
    const set = await bus.execute("control.setDefault", { nodeIds: ["slider_heat"] }, contextFor(alice));
    expect(set.status).toBe("applied");
    expect(set.output).toEqual({ ok: true, changed: ["slider_heat"], skipped: [] });
    expect(store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status])).toEqual([["control.setDefault", "applied"]]);
    // Setting the default moves no value.
    expect(reads(store, "slider_heat", "value")).toBe(1.7);

    await move(bus, store, "slider_heat", { value: 0.4 });
    await bus.execute("control.reset", { nodeIds: ["slider_heat"] }, contextFor(alice));
    expect(reads(store, "slider_heat", "value")).toBe(1.7);

    // Undo the reset, the move and the set: the default is 1 again, so a reset goes there.
    for (let step = 0; step < 3; step += 1) await bus.execute("graph.undo", {}, contextFor(alice));
    await move(bus, store, "slider_heat", { value: 0.4 });
    await bus.execute("control.reset", { nodeIds: ["slider_heat"] }, contextFor(alice));
    expect(reads(store, "slider_heat", "value")).toBe(1);
  });

  it("is refused by name, writing nothing, when every value already is its default", async () => {
    const { bus, store } = harness([heat()]);
    const revision = store.view.getRevision();
    const set = await bus.execute("control.setDefault", { all: true }, contextFor(alice));
    expect(set.status).toBe("rejected");
    expect(set.diagnostics.map((each) => each.code)).toEqual(["control.setDefault.nothing"]);
    expect(store.view.getRevision()).toBe(revision);
  });
});

describe("a Panel's id names the controls on it; all names every control (T1619b)", () => {
  const board = () => {
    const robot = panel("panel_robot", ["slider_speed", "toggle_perch", "xypad_view", "button_flash"]);
    const lights = panel("panel_lights", ["slider_lamp"]);
    return harness(
      [
        control("slider_speed", "slider", { channel: "speed", value: 0.9, defaultValue: 0.25 }),
        control("toggle_perch", "toggle", { channel: "perch", on: true, defaultOn: false }),
        control("xypad_view", "xyPad", { channel: "view", x: -1, y: 2, min: -2, max: 2, defaultX: 1.1, defaultY: 0.6 }),
        control("button_flash", "button", { channel: "flash", held: false, presses: 4 }),
        control("slider_lamp", "slider", { channel: "lamp", value: 0.1, defaultValue: 0.8 }),
        robot.node,
        lights.node,
      ],
      [...robot.edges, ...lights.edges],
    );
  };

  it("resets the Panel's three controls in ONE patch, passes over its Button, and leaves the other Panel's slider where it was moved", async () => {
    const { bus, store } = board();
    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;
    const reset = await bus.execute("control.reset", { nodeIds: ["panel_robot"] }, contextFor(alice));
    expect(reset.status).toBe("applied");
    // In the Panel's own order; the Button holds nothing to reset and is not a refusal.
    expect(reset.output).toEqual({ ok: true, changed: ["slider_speed", "toggle_perch", "xypad_view"], skipped: [] });
    expect(reads(store, "slider_speed", "value")).toBe(0.25);
    expect(reads(store, "toggle_perch", "on")).toBe(false);
    expect([reads(store, "xypad_view", "x"), reads(store, "xypad_view", "y")]).toEqual([1.1, 0.6]);
    expect(reads(store, "button_flash", "presses")).toBe(4);
    expect(reads(store, "slider_lamp", "value")).toBe(0.1);
    expect(store.view.getRevision()).toBe(revision + 1);
    expect(store.view.getAudit().slice(auditBefore)).toHaveLength(1);

    // One undo puts all three back together.
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect([reads(store, "slider_speed", "value"), reads(store, "toggle_perch", "on"), reads(store, "xypad_view", "x")]).toEqual([0.9, true, -1]);
  });

  it("all: true reaches the control on the other Panel too", async () => {
    const { bus, store } = board();
    const reset = await bus.execute("control.reset", { all: true }, contextFor(alice));
    expect([...(reset.output.changed ?? [])].sort()).toEqual(["slider_lamp", "slider_speed", "toggle_perch", "xypad_view"]);
    expect(reads(store, "slider_lamp", "value")).toBe(0.8);
  });

  it("control.resetAll and control.setAllDefaults are the whole document with no input, for a door that cannot build one (the palette)", async () => {
    const { bus, store } = board();
    const auditBefore = store.view.getAudit().length;
    const set = await bus.execute("control.setAllDefaults", {}, contextFor(alice));
    expect([...set.output.changed].sort()).toEqual(["slider_lamp", "slider_speed", "toggle_perch", "xypad_view"]);
    // Every value is its default now, so there is nothing to reset.
    expect((await bus.execute("control.resetAll", {}, contextFor(alice))).status).toBe("rejected");
    await move(bus, store, "slider_lamp", { value: 0.55 });
    const reset = await bus.execute("control.resetAll", {}, contextFor(alice));
    expect(reset.output).toEqual({ ok: true, changed: ["slider_lamp"], skipped: [] });
    expect(reads(store, "slider_lamp", "value")).toBe(0.1);
    expect(store.view.getAudit().slice(auditBefore).filter((entry) => entry.status === "applied").map((entry) => entry.command)).toEqual(["control.setAllDefaults", "graph.applyPatch", "control.resetAll"]);
  });
});

describe("what a reset leaves alone, and what it refuses (T1619b)", () => {
  const learned: ParameterSlot = {
    mode: "expression",
    bindings: { expression: { kind: "expression", source: "0.9" }, static: { kind: "static", value: 0.2 } },
  };

  it("a value an expression drives is left as it is and named, and the rest of the command applies", async () => {
    const { bus, store } = harness([control("slider_learned", "slider", { channel: "learned", value: learned, defaultValue: 0.5 }), heat()]);
    await move(bus, store, "slider_heat", { value: 1.7 });
    const reset = await bus.execute("control.reset", { all: true }, contextFor(alice));
    expect(reset.status).toBe("applied");
    expect(reset.output).toEqual({ ok: true, changed: ["slider_heat"], skipped: ["slider_learned.value"] });
    expect(reset.diagnostics.map((each) => [each.severity, each.code])).toEqual([["warning", "control.default.driven"]]);
    // Still learned: a reset never changes a mode (unlike parameter.reset, §V149).
    expect(store.view.getGraph().nodes["slider_learned"]?.parameters["value"]).toEqual(learned);
    expect(reads(store, "slider_heat", "value")).toBe(1);
  });

  it("nothing away from its default is a refusal by name that writes nothing", async () => {
    const { bus, store } = harness([heat()]);
    const revision = store.view.getRevision();
    const undoBefore = store.view.getHistory(alice).undo.length;
    const reset = await bus.execute("control.reset", { nodeIds: ["slider_heat"] }, contextFor(alice));
    expect(reset.status).toBe("rejected");
    expect(reset.output).toEqual({ ok: false, changed: [], skipped: [] });
    expect(reset.diagnostics.map((each) => [each.severity, each.code])).toEqual([["error", "control.reset.nothing"]]);
    expect(store.view.getRevision()).toBe(revision);
    expect(store.view.getHistory(alice).undo).toHaveLength(undoBefore);
  });

  it("a node that is not a control, and an id nothing has, are each said by name", async () => {
    const { bus } = harness([heat(), control("button_flash", "button", { channel: "flash" })]);
    const reset = await bus.execute("control.reset", { nodeIds: ["button_flash", "gone"] }, contextFor(alice));
    expect(reset.status).toBe("rejected");
    expect(reset.output.skipped).toEqual(["button_flash", "gone"]);
    expect(reset.diagnostics.map((each) => each.code)).toEqual(["control.default.notControl", "control.default.noNode", "control.reset.nothing"]);
  });

  /*
   * The lead's ruling for the owner, 2026-10-06: A MISSING DEFAULT MUST NOT READ AS 0.5. A
   * control whose source authored none used to reset to the type's 0.5 clamped into its
   * range: a number nobody chose, silently. It has NO default now.
   */
  it("a control that stores no default has none: it is not sent to 0.5, the refusal names it, and Set as default gives it one", async () => {
    const { bus, store } = harness([control("slider_gain", "slider", { channel: "gain", value: 7, min: 0, max: 10 }), heat()]);
    await move(bus, store, "slider_heat", { value: 1.7 });

    const alone = await bus.execute("control.reset", { nodeIds: ["slider_gain"] }, contextFor(alice));
    expect(alone.status).toBe("rejected");
    expect(alone.output).toEqual({ ok: false, changed: [], skipped: ["slider_gain"] });
    expect(alone.diagnostics.map((each) => [each.severity, each.code])).toEqual([
      ["warning", "control.default.missing"],
      ["error", "control.reset.nothing"],
    ]);
    expect(alone.diagnostics[0]?.message).toBe('"slider_gain" has no default to go back to. Set as default gives it one.');
    expect(reads(store, "slider_gain", "value")).toBe(7);

    // Among others it is left where it is and named; the control that holds a default goes back.
    const all = await bus.execute("control.reset", { all: true }, contextFor(alice));
    expect(all.output).toEqual({ ok: true, changed: ["slider_heat"], skipped: ["slider_gain"] });
    expect(reads(store, "slider_gain", "value")).toBe(7);

    const set = await bus.execute("control.setDefault", { nodeIds: ["slider_gain"] }, contextFor(alice));
    expect(set.output).toEqual({ ok: true, changed: ["slider_gain"], skipped: [] });
    await move(bus, store, "slider_gain", { value: 2 });
    const back = await bus.execute("control.reset", { nodeIds: ["slider_gain"] }, contextFor(alice));
    expect(back.status).toBe("applied");
    expect(reads(store, "slider_gain", "value")).toBe(7);
  });

  it("a fresh control, nothing stored at all, has no default either; Set as default stores the value it shows", async () => {
    const { bus, store } = harness([control("slider_fresh", "slider", { channel: "fresh" }), control("toggle_fresh", "toggle", { channel: "arm" })]);
    expect((await bus.execute("control.reset", { all: true }, contextFor(alice))).status).toBe("rejected");
    const set = await bus.execute("control.setDefault", { all: true }, contextFor(alice));
    expect(set.output.changed).toEqual(["slider_fresh", "toggle_fresh"]);
    await move(bus, store, "slider_fresh", { value: 0.9 });
    await move(bus, store, "toggle_fresh", { on: true });
    await bus.execute("control.reset", { all: true }, contextFor(alice));
    expect([reads(store, "slider_fresh", "value"), reads(store, "toggle_fresh", "on")]).toEqual([0.5, false]);
  });

  it("the bus refuses a scope that names nothing, or both, before the handler runs", async () => {
    const { bus, store } = harness([heat()]);
    await move(bus, store, "slider_heat", { value: 1.7 });
    for (const input of [{}, { nodeIds: [] }, { all: true, nodeIds: ["slider_heat"] }, { all: false }]) {
      const result = await bus.execute("control.reset", input as never, contextFor(bob));
      expect(result.status).toBe("rejected");
    }
    expect(reads(store, "slider_heat", "value")).toBe(1.7);
  });
});

describe("a control made on the bus is born at its default (T1619b)", () => {
  const made = async (parameters: Record<string, StoredParameter>, type = "slider") => {
    const { bus, store } = harness([]);
    const added = await bus.execute(
      "graph.applyPatch",
      patch(store.view.getRevision(), [{ op: "addNode", ref: "$new", type, position: { x: 0, y: 0 }, label: `${type.toLowerCase()}_new`, parameters }]),
      contextFor(alice),
    );
    expect(added.status).toBe("applied");
    const id = Object.keys(store.view.getGraph().nodes)[0] as NodeId;
    return { bus, store, id };
  };

  it("a slider created at 7 stores 7 as its default, not the manifest's 0.5: moved and reset, it reads 7", async () => {
    const { bus, store, id } = await made({ channel: "gain", value: 7, min: 0, max: 10 });
    expect(store.view.getGraph().nodes[id]?.parameters["defaultValue"]).toBe(7);
    // Nothing is away at birth.
    expect((await bus.execute("control.reset", { all: true }, contextFor(alice))).status).toBe("rejected");
    await move(bus, store, id, { value: 2 });
    await bus.execute("control.reset", { all: true }, contextFor(alice));
    expect(reads(store, id, "value")).toBe(7);
  });

  it("a toggle and a pad the same; a control created with nothing is born at its declared value; a default the creator names wins", async () => {
    const stores = async (parameters: Record<string, StoredParameter>, type?: string) => {
      const { store, id } = await made(parameters, type);
      return store.view.getGraph().nodes[id]?.parameters;
    };
    expect(await stores({ on: true }, "toggle")).toMatchObject({ on: true, defaultOn: true });
    expect(await stores({ x: 0.2, y: 0.9 }, "xyPad")).toMatchObject({ defaultX: 0.2, defaultY: 0.9 });
    expect(await stores({})).toMatchObject({ value: 0.5, defaultValue: 0.5 });
    expect(await stores({ value: 7, max: 10, defaultValue: 3 })).toMatchObject({ value: 7, defaultValue: 3 });
  });
});

describe("a document saved before controls held a default opens with each default equal to its stored value (T1619b)", () => {
  /** A version-1 control, as every file written before this slice holds it: no default key. */
  const saved = (id: NodeId, type: string, parameters: Record<string, StoredParameter>): GraphNode => ({ ...control(id, type, parameters), definitionVersion: 1 });
  const learned: ParameterSlot = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.9" }, static: { kind: "static", value: 0.3 } } };

  function open(nodes: readonly GraphNode[]) {
    const text = serializeProjectDocument(testDocument({ graph: { revision: 1, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} } }));
    const loaded = loadProject(text, { nodes: registry });
    if (!loaded.ok) throw new Error(loaded.reason);
    return loaded;
  }

  it("through the real load: every control is at its default, and a reset after a move returns to the value in the file", async () => {
    const loaded = open([
      saved("slider_heat", "slider", { channel: "heat", value: 1.1, min: -2, max: 2 }),
      saved("toggle_cuts", "toggle", { channel: "cuts", on: true }),
      saved("xypad_view", "xyPad", { channel: "view", x: 1.1, y: 0.6, min: -2, max: 2 }),
      saved("slider_learned", "slider", { channel: "learned", value: learned }),
      saved("slider_fresh", "slider", { channel: "fresh" }),
      saved("button_flash", "button", { channel: "flash", presses: 3 }),
    ]);
    const nodes = loaded.document.graph.nodes;
    // The three control types moved to version 2; the Button, which holds no default, did not.
    expect(loaded.nodeMigrations.map((change) => [change.nodeId, change.toVersion, change.added]).sort()).toEqual([
      // Nothing stored for its value: its default is the declared 0.5 it showed.
      ["slider_fresh", 2, ["defaultValue"]],
      ["slider_heat", 2, ["defaultValue"]],
      ["slider_learned", 2, ["defaultValue"]],
      ["toggle_cuts", 2, ["defaultOn"]],
      ["xypad_view", 2, ["defaultX", "defaultY"]],
    ]);
    expect(nodes["button_flash"]?.definitionVersion).toBe(1);
    for (const id of ["slider_heat", "toggle_cuts", "xypad_view", "slider_fresh", "slider_learned"]) {
      const state = controlDefaultState(nodes[id]!);
      // Every one HOLDS a default, and none is away from it.
      expect([id, state?.missing, state?.away]).toEqual([id, [], []]);
    }
    expect(controlDefaultState(nodes["slider_heat"]!)?.defaults).toEqual({ value: 1.1 });
    expect(controlDefaultState(nodes["toggle_cuts"]!)?.defaults).toEqual({ on: true });
    expect(controlDefaultState(nodes["xypad_view"]!)?.defaults).toEqual({ x: 1.1, y: 0.6 });
    // A learned slider's default is the hand-set value it retained under the expression.
    expect(controlDefaultState(nodes["slider_learned"]!)?.defaults).toEqual({ value: 0.3 });

    // And on a bus over the opened document: move, reset, the file's value.
    const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-06T00:00:00.000Z", initialGraph: loaded.document.graph });
    const { bus } = createDomainBus({ store, registry });
    await move(bus, store, "slider_heat", { value: -1.5 });
    await move(bus, store, "toggle_cuts", { on: false });
    const reset = await bus.execute("control.reset", { all: true }, contextFor(alice));
    expect(reset.output.changed).toEqual(["slider_heat", "toggle_cuts"]);
    expect(reads(store, "slider_heat", "value")).toBe(1.1);
    expect(reads(store, "toggle_cuts", "on")).toBe(true);
  });

  it("a second open of the saved result migrates nothing: the default is in the file now", () => {
    const first = open([saved("slider_heat", "slider", { channel: "heat", value: 1.1, min: -2, max: 2 })]);
    const again = loadProject(serializeProjectDocument(first.document), { nodes: registry });
    if (!again.ok) throw new Error(again.reason);
    expect(again.nodeMigrations).toEqual([]);
    expect(again.changed).toBe(false);
    expect(again.document.graph.nodes["slider_heat"]?.parameters["defaultValue"]).toBe(1.1);
  });
});
