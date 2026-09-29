import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSlot, StoredParameter } from "../types/parameters.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { alice, bob, contextFor, patch } from "../commands/test-support.ts";
import { resolveParameters } from "../parameters/resolve.ts";
import { createComponentSystem } from "../components/registry.ts";
import { bloomComponent, blurKnob, instanceNode } from "../components/test-support.ts";
import { createNodeRegistry, type NodeRegistryView } from "../../nodes/registry/registry.ts";
import { testNodeDefinitions } from "../../nodes/registry/test-nodes.ts";
import { presetsNode } from "../../nodes/definitions/presets.ts";
import { EMPTY_PRESET_BANK_JSON, parsePresetBank, serializePresetBank, type Preset } from "./bank.ts";

/**
 * T1496b (§T1398b S1) — the preset bank's Store and Recall, through the REAL bus.
 *
 * Each `describe` is one acceptance line of the design doc §12 S1, asserted on what a
 * consumer reads back: the document's values after the recall, what one undo restores,
 * the revision counter and the audit ring — never which function ran. The recall's whole
 * reason to exist is that a set of nodes changes TOGETHER and comes back TOGETHER, so the
 * headline test counts revisions, undo groups and audit entries, and undoes once.
 */

const registry: NodeRegistryView = createNodeRegistry([...testNodeDefinitions, presetsNode]).view();

function node(id: NodeId, type: string, label: string, parameters: Record<string, StoredParameter> = {}): GraphNode {
  return { id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

function bank(targets: string, id: NodeId = "bank", label = "looks", presets = EMPTY_PRESET_BANK_JSON): GraphNode {
  return node(id, "presets", label, { targets, presets, select: "", current: "" });
}

function harness(nodes: GraphNode[], view: NodeRegistryView = registry): { bus: LoomBus; store: GraphStore } {
  const initialGraph: GraphDocument = { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} };
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-09-29T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store, registry: view });
  return { bus, store };
}

const value = (store: GraphStore, nodeId: NodeId, key: string): StoredParameter | undefined =>
  store.view.getGraph().nodes[nodeId]?.parameters[key];

/** The value a consumer reads for a key: the one read path (§V61), not the stored slot. */
function resolved(store: GraphStore, nodeId: NodeId, key: string): unknown {
  const target = store.view.getGraph().nodes[nodeId]!;
  return resolveParameters(target, registry.get(target.type)).values[key];
}

async function set(bus: LoomBus, store: GraphStore, nodeId: NodeId, parameters: Record<string, StoredParameter>): Promise<void> {
  const result = await bus.execute(
    "graph.applyPatch",
    patch(store.view.getRevision(), [{ op: "setParameters", nodeId, parameters }]),
    contextFor(bob),
  );
  expect(result.status).toBe("applied");
}

function presetsOf(store: GraphStore, bankId: NodeId = "bank"): readonly Preset[] {
  const parsed = parsePresetBank(value(store, bankId, "presets"));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.bank.presets;
}

describe("preset.recall over three nodes is ONE revision, ONE undo group, ONE audit entry (T1496b)", () => {
  it("writes all three back, and one undo restores all three", async () => {
    const { bus, store } = harness([
      node("solid", "test.solid", "solid1", { amount: 0.25 }),
      node("blurA", "test.blur", "blur1", { radius: 4 }),
      node("blurB", "test.blur", "blur2", { radius: 8 }),
      bank("solid1 blur1, blur2"),
    ]);
    const stored = await bus.execute("preset.store", { nodeId: "bank", name: "dawn" }, contextFor(alice));
    expect(stored.status).toBe("applied");
    // Every non-pulse parameter of each whole target, so a recall RESETS what was unset.
    expect(stored.output).toEqual({ ok: true, preset: "dawn", captured: 5, missing: [] });

    await bus.execute(
      "graph.applyPatch",
      patch(store.view.getRevision(), [
        { op: "setParameters", nodeId: "solid", parameters: { amount: 0.9 } },
        { op: "setParameters", nodeId: "blurA", parameters: { radius: 20 } },
        { op: "setParameters", nodeId: "blurB", parameters: { radius: 30 } },
      ]),
      contextFor(bob),
    );

    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;
    const undoBefore = store.view.getHistory(alice).undo.length;

    const recalled = await bus.execute("preset.recall", { nodeId: "bank", name: "dawn" }, contextFor(alice));
    expect(recalled.status).toBe("applied");
    expect(recalled.diagnostics.filter((each) => each.severity !== "info")).toEqual([]);

    expect(value(store, "solid", "amount")).toBe(0.25);
    expect(value(store, "blurA", "radius")).toBe(4);
    expect(value(store, "blurB", "radius")).toBe(8);
    expect(value(store, "bank", "current")).toBe("dawn");

    expect(store.view.getRevision()).toBe(revision + 1);
    const audit = store.view.getAudit().slice(auditBefore);
    expect(audit.map((entry) => [entry.command, entry.status, entry.actor.id])).toEqual([["preset.recall", "applied", "alice"]]);
    const history = store.view.getHistory(alice).undo;
    expect(history).toHaveLength(undoBefore + 1);
    expect(history.at(-1)?.label).toBe('Recall "dawn" (looks)');

    const undone = await bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    expect(value(store, "solid", "amount")).toBe(0.9);
    expect(value(store, "blurA", "radius")).toBe(20);
    expect(value(store, "blurB", "radius")).toBe(30);
    expect(value(store, "bank", "current")).toBe("");
  });

  it("stays its own undo group inside a caller's transaction", async () => {
    const { bus, store } = harness([node("blurA", "test.blur", "blur1", { radius: 4 }), bank("blur1")]);
    await bus.execute("preset.store", { nodeId: "bank", name: "p" }, contextFor(alice));
    const inTransaction = contextFor(alice, { transactionId: "drag-1" });
    await bus.execute("graph.applyPatch", patch(store.view.getRevision(), [{ op: "setParameters", nodeId: "blurA", parameters: { radius: 9 } }]), inTransaction);
    await bus.execute("preset.recall", { nodeId: "bank", name: "p" }, inTransaction);
    expect(value(store, "blurA", "radius")).toBe(4);
    // One undo takes back the recall ALONE — the drag's 9 is what it lands on.
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(value(store, "blurA", "radius")).toBe(9);
  });

  it("fires from the bank's Recall pulse with the preset named in Select", async () => {
    const { bus, store } = harness([node("blurA", "test.blur", "blur1", { radius: 4 }), bank("blur1")]);
    await bus.execute("preset.store", { nodeId: "bank", name: "p" }, contextFor(alice));
    await set(bus, store, "blurA", { radius: 11 });
    await set(bus, store, "bank", { select: "p" });
    const fired = await bus.execute("parameter.pulse", { nodeId: "bank", parameterKey: "recall" }, contextFor(alice));
    expect(fired.status).toBe("applied");
    expect(value(store, "blurA", "radius")).toBe(4);
    expect(store.view.getAudit().some((entry) => entry.command === "preset.recall" && entry.actor.id === "alice")).toBe(true);
  });
});

describe("a preset holds the WHOLE slot (ruling 2, T1496b)", () => {
  const expression: ParameterSlot = {
    mode: "expression",
    bindings: { static: { kind: "static", value: 0.1 }, expression: { kind: "expression", source: "0.5 + 0.25" } },
  };

  it("an expression slot stored in a preset comes back as the same expression", async () => {
    const { bus, store } = harness([node("solid", "test.solid", "solid1", { amount: expression }), bank("solid1.amount")]);
    await bus.execute("preset.store", { nodeId: "bank", name: "live" }, contextFor(alice));
    await set(bus, store, "solid", { amount: { mode: "static", bindings: { static: { kind: "static", value: 0.3 } } } });
    expect(resolved(store, "solid", "amount")).toBe(0.3);

    await bus.execute("preset.recall", { nodeId: "bank", name: "live" }, contextFor(alice));
    expect(value(store, "solid", "amount")).toEqual(expression);
    expect(resolved(store, "solid", "amount")).toBe(0.75);
  });

  it("a bare value recalled over an expression takes effect, and the expression is kept (§V108)", async () => {
    const { bus, store } = harness([node("solid", "test.solid", "solid1", { amount: 0.2 }), bank("solid1.amount")]);
    await bus.execute("preset.store", { nodeId: "bank", name: "still" }, contextFor(alice));
    await set(bus, store, "solid", { amount: expression });
    expect(resolved(store, "solid", "amount")).toBe(0.75);

    await bus.execute("preset.recall", { nodeId: "bank", name: "still" }, contextFor(alice));
    // What a consumer reads is the preset's 0.2 — not the expression it was written over.
    expect(resolved(store, "solid", "amount")).toBe(0.2);
    expect(value(store, "solid", "amount")).toEqual({
      mode: "static",
      bindings: { static: { kind: "static", value: 0.2 }, expression: { kind: "expression", source: "0.5 + 0.25" } },
    });
  });
});

describe("a missing target is skipped with a warning naming it; nothing left is refused (ruling 4, T1496b)", () => {
  it("a deleted target is skipped, named, and the rest applies", async () => {
    const { bus, store } = harness([
      node("blurA", "test.blur", "blur1", { radius: 4 }),
      node("blurB", "test.blur", "blur2", { radius: 8 }),
      bank("blur1 blur2"),
    ]);
    await bus.execute("preset.store", { nodeId: "bank", name: "p" }, contextFor(alice));
    await set(bus, store, "blurA", { radius: 40 });
    await bus.execute("graph.removeNodes", { nodeIds: ["blurB"] }, contextFor(bob));

    const result = await bus.execute("preset.recall", { nodeId: "bank", name: "p" }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(value(store, "blurA", "radius")).toBe(4);
    expect(result.output.skipped).toEqual(["blur2"]);
    const warnings = result.diagnostics.filter((each) => each.severity === "warning");
    expect(warnings.map((each) => each.code)).toEqual(["preset.target.missing"]);
    expect(warnings[0]?.message).toContain('"blur2"');
  });

  it("a value that no longer fits is skipped by name, and the rest applies", async () => {
    const handWritten = serializePresetBank({
      version: 1,
      presets: [{ name: "p", values: { solid1: { amount: "loud", label: "kept" }, blur1: { radius: 6 } } }],
    });
    const { bus, store } = harness([
      node("solid", "test.solid", "solid1", { amount: 0.5, label: "" }),
      node("blurA", "test.blur", "blur1", { radius: 4 }),
      bank("solid1 blur1", "bank", "looks", handWritten),
    ]);
    const result = await bus.execute("preset.recall", { nodeId: "bank", name: "p" }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.output.applied).toEqual(["blur1.radius", "solid1.label"]);
    expect(result.output.skipped).toEqual(["solid1.amount"]);
    expect(result.diagnostics.find((each) => each.code === "preset.value.invalid")?.message).toContain('"solid1.amount"');
    expect(value(store, "solid", "amount")).toBe(0.5);
    expect(value(store, "solid", "label")).toBe("kept");
    expect(value(store, "blurA", "radius")).toBe(6);
  });

  it("a bank whose only target is gone is refused, names it, and changes nothing", async () => {
    const { bus, store } = harness([node("blurB", "test.blur", "blur2", { radius: 8 }), bank("blur2")]);
    await bus.execute("preset.store", { nodeId: "bank", name: "p" }, contextFor(alice));
    await bus.execute("graph.removeNodes", { nodeIds: ["blurB"] }, contextFor(bob));
    const revision = store.view.getRevision();

    const result = await bus.execute("preset.recall", { nodeId: "bank", name: "p" }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.output.ok).toBe(false);
    expect(result.diagnostics.map((each) => each.code)).toEqual(["preset.target.missing", "preset.recall.nothing"]);
    expect(result.diagnostics[0]?.message).toContain('"blur2"');
    expect(store.view.getRevision()).toBe(revision);
    expect(value(store, "bank", "current")).toBe("");
    expect(store.view.getAudit().at(-1)).toMatchObject({ command: "preset.recall", status: "rejected" });
  });
});

describe("paste with colliding names rewrites the bank's names (§V320, T1496b)", () => {
  it("the pasted bank recalls into the pasted target, never the original", async () => {
    const { bus, store } = harness([node("blurA", "test.blur", "blur1", { radius: 4 }), bank("blur1.radius")]);
    await bus.execute("preset.store", { nodeId: "bank", name: "p" }, contextFor(alice));
    await bus.execute("graph.copySelection", { nodeIds: ["blurA", "bank"] }, contextFor(alice));
    const pasted = await bus.execute("graph.paste", {}, contextFor(alice));
    expect(pasted.status).toBe("applied");

    const graph = store.view.getGraph();
    const copyBank = Object.values(graph.nodes).find((each) => each.type === "presets" && each.id !== "bank")!;
    const copyBlur = Object.values(graph.nodes).find((each) => each.type === "test.blur" && each.id !== "blurA")!;
    expect(copyBlur.label).toBe("blur2");
    expect(copyBank.parameters["targets"]).toBe("blur2.radius");
    expect(Object.keys(presetsOf(store, copyBank.id)[0]?.values ?? {})).toEqual(["blur2"]);
    // The original bank is untouched.
    expect(value(store, "bank", "targets")).toBe("blur1.radius");

    await set(bus, store, "blurA", { radius: 30 });
    await set(bus, store, copyBlur.id, { radius: 31 });
    await bus.execute("preset.recall", { nodeId: copyBank.id, name: "p" }, contextFor(alice));
    expect(value(store, copyBlur.id, "radius")).toBe(4);
    expect(value(store, "blurA", "radius")).toBe(30);
  });

  it("a rename carries the bank's targets, values and the expressions a preset holds", async () => {
    const driven: ParameterSlot = { mode: "expression", bindings: { expression: { kind: "expression", source: "op('blur1').par.radius * 2" } } };
    const { bus, store } = harness([
      node("blurA", "test.blur", "blur1", { radius: 4 }),
      node("solid", "test.solid", "solid1", { amount: driven }),
      bank("blur1, solid1.amount"),
    ]);
    await bus.execute("preset.store", { nodeId: "bank", name: "p" }, contextFor(alice));
    await bus.execute("node.rename", { nodeId: "blurA", label: "glow" }, contextFor(alice));
    expect(value(store, "bank", "targets")).toBe("glow, solid1.amount");
    const preset = presetsOf(store)[0]!;
    expect(Object.keys(preset.values)).toEqual(["glow", "solid1"]);
    expect(preset.values["solid1"]?.["amount"]).toEqual({
      mode: "expression",
      bindings: { expression: { kind: "expression", source: "op('glow').par.radius * 2" } },
    });
  });
});

describe("a component instance's published page is captured and recalled (T1496b)", () => {
  it("stores the page and writes it back to the instance", async () => {
    const system = createComponentSystem(registry);
    system.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const instance = { ...instanceNode("inst", "bloom", 1, { blur: 4 }), label: "bloom1" };
    const { bus, store } = harness([instance, bank("bloom1")], system.nodes);

    const stored = await bus.execute("preset.store", { nodeId: "bank", name: "wide" }, contextFor(alice));
    expect(stored.status).toBe("applied");
    // The instance's "every parameter" is its published page — and only that.
    expect(presetsOf(store)[0]?.values).toEqual({ bloom1: { blur: 4 } });

    await set(bus, store, "inst", { blur: 12 });
    const recalled = await bus.execute("preset.recall", { nodeId: "bank", name: "wide" }, contextFor(alice));
    expect(recalled.status).toBe("applied");
    expect(value(store, "inst", "blur")).toBe(4);
  });
});

describe("preset.store (T1496b)", () => {
  it("names every target it could not capture, and refuses when it captured nothing", async () => {
    const { bus, store } = harness([node("blurA", "test.blur", "blur1", { radius: 4 }), bank("blur1 ghost blur1.nope")]);
    const partial = await bus.execute("preset.store", { nodeId: "bank", name: "p" }, contextFor(alice));
    expect(partial.status).toBe("applied");
    expect(partial.output.missing).toEqual(["ghost", "blur1.nope"]);

    await set(bus, store, "bank", { targets: "ghost" });
    const revision = store.view.getRevision();
    const none = await bus.execute("preset.store", { nodeId: "bank", name: "q" }, contextFor(alice));
    expect(none.status).toBe("rejected");
    expect(none.diagnostics.map((each) => each.code)).toEqual(["preset.target.missing", "preset.store.nothing"]);
    expect(store.view.getRevision()).toBe(revision);
  });

  it("overwrites an existing preset in place, keeping bank order", async () => {
    const { bus, store } = harness([node("blurA", "test.blur", "blur1", { radius: 4 }), bank("blur1")]);
    await bus.execute("preset.store", { nodeId: "bank", name: "a" }, contextFor(alice));
    await bus.execute("preset.store", { nodeId: "bank", name: "b" }, contextFor(alice));
    await set(bus, store, "blurA", { radius: 9 });
    await bus.execute("preset.store", { nodeId: "bank", name: "a" }, contextFor(alice));
    expect(presetsOf(store).map((preset) => [preset.name, preset.values["blur1"]?.["radius"]])).toEqual([
      ["a", 9],
      ["b", 4],
    ]);
  });

  it("refuses a malformed bank rather than overwriting what the user typed", async () => {
    const { bus, store } = harness([node("blurA", "test.blur", "blur1"), bank("blur1", "bank", "looks", "{ oops")]);
    const result = await bus.execute("preset.store", { nodeId: "bank", name: "a" }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("preset.bank.malformed");
    expect(result.diagnostics[0]?.message).toContain('"looks"');
    expect(value(store, "bank", "presets")).toBe("{ oops");
  });
});
