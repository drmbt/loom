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
import { parseCueList, serializeCueList, type Cue } from "./cue-list.ts";
import { presetBankNode } from "./test-support.ts";

/**
 * VN152 (§T1648b) — `preset.rename`, through the REAL bus. Asserted: what a consumer reads
 * back — the bank's presets in button order, what Select, `current`, the cues and the shots
 * name afterwards, that GO still lands, and that one undo puts every one of them back.
 */

const registry = createNodeRegistry([...testNodeDefinitions, presetsNode, cueListNode]).view();

const LOOKS: readonly Preset[] = [
  { name: "a", values: { blur1: { radius: 10 } } },
  { name: "b", values: { blur1: { radius: 20 } }, morph: { seconds: 3, curve: "linear" } },
  { name: "c", values: { blur1: { radius: 30 } } },
  // A shot in the bank's OWN bank that recalls "b".
  { name: "d", values: {}, recalls: [{ bank: "looks", preset: "b" }] },
];

const cueList = (id: string, label: string, cues: readonly Cue[]): GraphNode => ({
  id,
  type: "cueList",
  label,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters: { cues: serializeCueList({ version: 1, cues }) },
});

function harness(others: readonly GraphNode[] = []): { bus: LoomBus; store: GraphStore } {
  const blur: GraphNode = { id: "blur", type: "test.blur", label: "blur1", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { radius: 4 } };
  const bank = presetBankNode("bank", "looks", "blur1", LOOKS, { current: "b", select: "b" });
  const initialGraph: GraphDocument = {
    revision: 0,
    nodes: { blur, bank, ...Object.fromEntries(others.map((other) => [other.id, other])) },
    edges: {},
    groups: {},
  };
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-11-21T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store, registry });
  return { bus, store };
}

function presetsOf(store: GraphStore, id = "bank"): readonly Preset[] {
  const parsed = parsePresetBank(store.view.getGraph().nodes[id]?.parameters["presets"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.bank.presets;
}

const cuesOf = (store: GraphStore, id: string): Array<[string, string, string]> => {
  const parsed = parseCueList(store.view.getGraph().nodes[id]?.parameters["cues"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.list.cues.map((cue) => [cue.name, cue.bank, cue.preset]);
};

// "b" in ANOTHER bank is a different preset: nothing that names fx's "b" may move.
const fx = presetBankNode("fxBank", "fx", "blur1", [{ name: "b", values: {} }]);
const shots = presetBankNode("shotBank", "shots", "", [
  { name: "drop", values: {}, recalls: [{ bank: "looks", preset: "b" }] },
  { name: "calm", values: {}, recalls: [{ bank: "fx", preset: "b" }] },
]);
const set = cueList("setList", "set", [
  { name: "1", bank: "looks", preset: "a" },
  { name: "2", bank: "looks", preset: "b" },
  { name: "3", bank: "fx", preset: "b" },
]);

describe("preset.rename renames a preset and everything that names it, as one undoable step (VN152)", () => {
  it("renames in place, rewrites Select, current, its own shots, other banks' shots and cues, and one undo puts all of it back", async () => {
    const { bus, store } = harness([fx, shots, set]);
    const revision = store.view.getRevision();
    const before = store.view.getGraph();

    const renamed = await bus.execute("preset.rename", { nodeId: "bank", name: "b", to: "night" }, contextFor(alice));
    expect(renamed.status).toBe("applied");
    expect(renamed.output).toEqual({
      ok: true,
      preset: "night",
      presets: ["a", "night", "c", "d"],
      rewrote: ["looks.preset d", "looks.select", "looks.current", "set.cue 2", "shots.preset drop"],
    });

    // Same position, same values and morph: only the name moved.
    expect(presetsOf(store)).toEqual([LOOKS[0], { ...LOOKS[1], name: "night" }, LOOKS[2], { ...LOOKS[3], recalls: [{ bank: "looks", preset: "night" }] }]);
    const bank = store.view.getGraph().nodes["bank"];
    expect([bank?.parameters["select"], bank?.parameters["current"]]).toEqual(["night", "night"]);
    expect(cuesOf(store, "setList")).toEqual([["1", "looks", "a"], ["2", "looks", "night"], ["3", "fx", "b"]]);
    expect(presetsOf(store, "shotBank").map((preset) => preset.recalls)).toEqual([[{ bank: "looks", preset: "night" }], [{ bank: "fx", preset: "b" }]]);
    expect(presetsOf(store, "fxBank").map((preset) => preset.name)).toEqual(["b"]);
    expect(renamed.diagnostics.map((each) => [each.severity, each.code])).toEqual([["info", "preset.rename.rewrote"]]);

    // ONE revision, one undo group, one audit entry.
    expect(store.view.getRevision()).toBe(revision + 1);
    expect(store.view.getHistory(alice).undo.map((group) => group.label)).toEqual(['Rename "b" to "night" (looks)']);

    // The cue still lands: GO on it recalls the renamed preset.
    const go = await bus.execute("cue.fire", { nodeId: "setList", cue: "2" }, contextFor(alice));
    expect(go.status).toBe("applied");
    expect(store.view.getGraph().nodes["blur"]?.parameters["radius"]).toBe(20);

    await bus.execute("graph.undo", {}, contextFor(alice));
    await bus.execute("graph.undo", {}, contextFor(alice));
    const after = store.view.getGraph();
    for (const id of ["bank", "setList", "shotBank", "fxBank"]) expect(after.nodes[id]?.parameters).toEqual(before.nodes[id]?.parameters);
  });

  it("refuses an unknown name, an invalid name, the same name and a taken name, by name, and changes nothing", async () => {
    const { bus, store } = harness([set]);
    const revision = store.view.getRevision();
    const tries: Array<[string, string]> = [["zz", "y"], ["b", "9lives"], ["b", "b"], ["b", "c"]];
    const codes: string[] = [];
    for (const [name, to] of tries) {
      const refused = await bus.execute("preset.rename", { nodeId: "bank", name, to }, contextFor(alice));
      expect(refused.status).toBe("rejected");
      expect(refused.output).toEqual({ ok: false, preset: null, presets: ["a", "b", "c", "d"], rewrote: [] });
      codes.push(...refused.diagnostics.map((each) => each.code));
    }
    expect(codes).toEqual(["preset.rename.unknown", "preset.name", "preset.rename.same", "preset.rename.taken"]);
    expect(store.view.getRevision()).toBe(revision);
    expect(presetsOf(store)).toEqual(LOOKS);
    expect(cuesOf(store, "setList")[1]).toEqual(["2", "looks", "b"]);
  });

  it("refuses a node that is not a bank", async () => {
    const refused = await harness().bus.execute("preset.rename", { nodeId: "blur", name: "a", to: "z" }, contextFor(alice));
    expect(refused.diagnostics.map((each) => each.code)).toEqual(["preset.bank.type"]);
  });
});
