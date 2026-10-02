import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { alice, contextFor } from "../commands/test-support.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { testNodeDefinitions } from "../../nodes/registry/test-nodes.ts";
import { presetsNode } from "../../nodes/definitions/presets.ts";
import { parsePresetBank, type Preset } from "./bank.ts";
import { presetBankNode } from "./test-support.ts";

/**
 * T1502b — `preset.delete`, through the REAL bus.
 *
 * Delete matters for the same reason Store does: the bank is document state, so removing
 * a preset has to be one step a person can take back, and it must not quietly take
 * anything else with it. What is asserted is what a consumer reads back — the bank's
 * presets, what the remaining ones still recall, the undo stack and the audit ring.
 */

const registry = createNodeRegistry([...testNodeDefinitions, presetsNode]).view();

const LOOKS: readonly Preset[] = [
  { name: "a", values: { blur1: { radius: 10 } } },
  { name: "b", values: { blur1: { radius: 20 } }, morph: { seconds: 3, curve: "linear" } },
  { name: "c", values: { blur1: { radius: 30 } } },
];

function harness(bank: GraphNode = presetBankNode("bank", "looks", "blur1", LOOKS, { current: "b" })): { bus: LoomBus; store: GraphStore } {
  const blur: GraphNode = { id: "blur", type: "test.blur", label: "blur1", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { radius: 4 } };
  const initialGraph: GraphDocument = { revision: 0, nodes: { blur, [bank.id]: bank }, edges: {}, groups: {} };
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-02T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store, registry });
  return { bus, store };
}

function presetsOf(store: GraphStore): readonly Preset[] {
  const parsed = parsePresetBank(store.view.getGraph().nodes["bank"]?.parameters["presets"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.bank.presets;
}

describe("preset.delete removes one preset as one undoable step (T1502b)", () => {
  it("takes out the named preset only, and one undo brings it back whole and in place", async () => {
    const { bus, store } = harness();
    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;

    const deleted = await bus.execute("preset.delete", { nodeId: "bank", name: "b" }, contextFor(alice));
    expect(deleted.status).toBe("applied");
    expect(deleted.output).toEqual({ ok: true, preset: "b", remaining: ["a", "c"] });

    // The neighbours are untouched, in their button order, values and all.
    expect(presetsOf(store)).toEqual([LOOKS[0], LOOKS[2]]);
    // `current` is "the preset recalled last": deleting it does not rewrite what was recalled.
    expect(store.view.getGraph().nodes["bank"]?.parameters["current"]).toBe("b");
    // The targets are not written: a delete is the bank's edit, not a recall.
    expect(store.view.getGraph().nodes["blur"]?.parameters["radius"]).toBe(4);

    expect(store.view.getRevision()).toBe(revision + 1);
    expect(store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status, entry.actor.id])).toEqual([
      ["preset.delete", "applied", "alice"],
    ]);
    expect(store.view.getHistory(alice).undo.map((group) => group.label)).toEqual(['Delete "b" (looks)']);

    // The deleted preset is really gone for a recall…
    const recalled = await bus.execute("preset.recall", { nodeId: "bank", name: "b" }, contextFor(alice));
    expect(recalled.status).toBe("rejected");

    // …and one undo restores it with its morph, between its neighbours.
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(presetsOf(store)).toEqual(LOOKS);
  });

  it("refuses a name the bank does not hold, naming the ones it does, and changes nothing", async () => {
    const { bus, store } = harness();
    const revision = store.view.getRevision();

    const refused = await bus.execute("preset.delete", { nodeId: "bank", name: "zz" }, contextFor(alice));
    expect(refused.status).toBe("rejected");
    expect(refused.output).toEqual({ ok: false, preset: null, remaining: ["a", "b", "c"] });
    expect(refused.diagnostics.map((each) => [each.code, each.message, each.suggestion])).toEqual([
      ["preset.delete.unknown", 'Bank "looks" has no preset "zz"; nothing was deleted.', "Its presets: a, b, c."],
    ]);
    expect(store.view.getRevision()).toBe(revision);
    expect(presetsOf(store)).toEqual(LOOKS);
  });

  it("refuses a node that is not a bank, and a bank whose Presets field cannot be read", async () => {
    const notABank = await harness().bus.execute("preset.delete", { nodeId: "blur", name: "a" }, contextFor(alice));
    expect(notABank.diagnostics.map((each) => each.code)).toEqual(["preset.bank.type"]);

    // A malformed bank is left exactly as written: rewriting it would lose the text someone is mid-way through fixing.
    const broken = presetBankNode("bank", "looks", "blur1", [], { presets: "{ not json" });
    const { bus, store } = harness(broken);
    const malformed = await bus.execute("preset.delete", { nodeId: "bank", name: "a" }, contextFor(alice));
    expect(malformed.status).toBe("rejected");
    expect(malformed.diagnostics.map((each) => each.code)).toEqual(["preset.bank.malformed"]);
    expect(store.view.getGraph().nodes["bank"]?.parameters["presets"]).toBe("{ not json");
  });
});
