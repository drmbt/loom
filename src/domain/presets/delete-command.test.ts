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
import { cueListNode } from "../../nodes/definitions/cue-list.ts";
import { parsePresetBank, type Preset } from "./bank.ts";
import { serializeCueList, type Cue } from "./cue-list.ts";
import { presetBankNode } from "./test-support.ts";

/**
 * T1502b — `preset.delete`, through the REAL bus.
 *
 * Delete matters for the same reason Store does: the bank is document state, so removing
 * a preset has to be one step a person can take back, and it must not quietly take
 * anything else with it. What is asserted is what a consumer reads back — the bank's
 * presets, what the remaining ones still recall, the undo stack and the audit ring.
 */

const registry = createNodeRegistry([...testNodeDefinitions, presetsNode, cueListNode]).view();

const LOOKS: readonly Preset[] = [
  { name: "a", values: { blur1: { radius: 10 } } },
  { name: "b", values: { blur1: { radius: 20 } }, morph: { seconds: 3, curve: "linear" } },
  { name: "c", values: { blur1: { radius: 30 } } },
];

function harness(
  bank: GraphNode = presetBankNode("bank", "looks", "blur1", LOOKS, { current: "b" }),
  others: readonly GraphNode[] = [],
): { bus: LoomBus; store: GraphStore } {
  const blur: GraphNode = { id: "blur", type: "test.blur", label: "blur1", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { radius: 4 } };
  const initialGraph: GraphDocument = {
    revision: 0,
    nodes: { blur, [bank.id]: bank, ...Object.fromEntries(others.map((other) => [other.id, other])) },
    edges: {},
    groups: {},
  };
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

/**
 * T1527b — a delete that leaves a cue or a shot pointing at nothing SAYS so when it happens.
 * Without it the first anyone hears of it is a GO refused mid-show. It warns rather than
 * refuses: the delete is what was asked for, and one undo takes it back.
 */
describe("preset.delete names every cue and shot that still names the deleted preset (T1527b)", () => {
  const cueList = (id: string, label: string, cues: readonly Cue[]): GraphNode => ({
    id,
    type: "cueList",
    label,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: { cues: serializeCueList({ version: 1, cues }) },
  });
  // "b" in ANOTHER bank is a different preset: cues and shots naming fx's "b" must not warn.
  const other = presetBankNode("fxBank", "fx", "blur1", [{ name: "b", values: {} }]);
  const shots = presetBankNode("shotBank", "shots", "", [
    { name: "drop", values: {}, recalls: [{ bank: "looks", preset: "b" }] },
    { name: "calm", values: {}, recalls: [{ bank: "fx", preset: "b" }] },
    { name: "riot", values: {}, recalls: [{ bank: "fx", preset: "b" }, { bank: "looks", preset: "b" }] },
  ]);
  // A shot in the deleted preset's OWN bank recalls it too.
  const looks = presetBankNode("bank", "looks", "blur1", [...LOOKS, { name: "d", values: {}, recalls: [{ bank: "looks", preset: "b" }] }]);
  const set = cueList("setList", "set", [
    { name: "1", bank: "looks", preset: "a" },
    { name: "2", bank: "looks", preset: "b" },
    { name: "3", bank: "fx", preset: "b" },
    { name: "4", bank: "looks", preset: "b" },
  ]);
  const encore = cueList("encoreList", "encore", [{ name: "e1", bank: "looks", preset: "b" }]);
  const clean = cueList("cleanList", "clean", [{ name: "x", bank: "fx", preset: "b" }]);

  it("applies the delete and warns once per cue list and bank, naming each cue and each shot", async () => {
    const { bus, store } = harness(looks, [other, shots, set, encore, clean]);
    const deleted = await bus.execute("preset.delete", { nodeId: "bank", name: "b" }, contextFor(alice));

    expect(deleted.status).toBe("applied");
    expect(presetsOf(store).map((preset) => preset.name)).toEqual(["a", "c", "d"]);
    expect(deleted.diagnostics.map((each) => [each.severity, each.code, each.nodeId, each.message])).toEqual([
      ["warning", "preset.delete.recalled", "bank", 'Bank "looks": preset "d" still recalls "b" (looks), which is gone; recalling it will skip it.'],
      ["warning", "preset.delete.cued", "encoreList", 'Cue list "encore": cue "e1" still names "b" (looks), which is gone; GO on it will be refused.'],
      ["warning", "preset.delete.cued", "setList", 'Cue list "set": cues "2", "4" still name "b" (looks), which is gone; GO on them will be refused.'],
      ["warning", "preset.delete.recalled", "shotBank", 'Bank "shots": presets "drop", "riot" still recall "b" (looks), which is gone; recalling them will skip it.'],
    ]);
    // The warning is about the document as the delete left it: the cue really is refused now.
    const go = await bus.execute("cue.fire", { nodeId: "setList", cue: "2" }, contextFor(alice));
    expect(go.status).toBe("rejected");
  });

  it("says nothing when no cue or shot names the deleted preset", async () => {
    const { bus } = harness(looks, [other, shots, set, encore, clean]);
    const deleted = await bus.execute("preset.delete", { nodeId: "bank", name: "c" }, contextFor(alice));
    expect(deleted.status).toBe("applied");
    expect(deleted.diagnostics).toEqual([]);
  });

  it("warns about nothing on a refusal: nothing was deleted", async () => {
    const { bus } = harness(looks, [set]);
    const refused = await bus.execute("preset.delete", { nodeId: "bank", name: "zz" }, contextFor(alice));
    expect(refused.diagnostics.map((each) => each.code)).toEqual(["preset.delete.unknown"]);
  });
});
