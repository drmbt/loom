import { describe, expect, it } from "vitest";

import type { FrameClock } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { alice, bob, contextFor, patch } from "../commands/test-support.ts";
import { createNodeRegistry, type NodeRegistryView } from "../../nodes/registry/registry.ts";
import { testNodeDefinitions } from "../../nodes/registry/test-nodes.ts";
import { cueListNode } from "../../nodes/definitions/cue-list.ts";
import { presetsNode } from "../../nodes/definitions/presets.ts";
import type { MorphSpec, Preset } from "./bank.ts";
import { parseCueList, serializeCueList, type Cue } from "./cue-list.ts";
import { parseMorphRecords } from "./morph.ts";
import { presetBankNode } from "./test-support.ts";

/**
 * T1500b (§T1398b S5) — the cue list's GO / BACK / fire / standby, through the REAL bus.
 *
 * Each `describe` is one acceptance line of the design doc §12 S5 (the key and the
 * expression-driven pulse run in the composed app: `src/app/cue-list.test.tsx`). What is
 * asserted is what a consumer reads back — the document after the GO, the revision
 * counter, the undo stack and the audit ring — never which function ran.
 *
 * THE SET every test runs: three cues across two banks, so "the list moved" and "the
 * right bank was recalled" are separately visible.
 *
 *   1  looks/a      blur1.radius → 10      (no morph of its own)
 *   2  fx/dirty     solid1.amount → 0.9    (cue morph 2 s linear; the preset says 9 s)
 *   3  looks/b      blur1.radius → 20
 */

const registry: NodeRegistryView = createNodeRegistry([...testNodeDefinitions, presetsNode, cueListNode]).view();

function node(id: NodeId, type: string, label: string, parameters: Record<string, StoredParameter> = {}): GraphNode {
  return { id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

const CUE_MORPH: MorphSpec = { seconds: 2, curve: "linear" };

const SET: readonly Cue[] = [
  { name: "1", bank: "looks", preset: "a" },
  { name: "2", bank: "fx", preset: "dirty", morph: CUE_MORPH, note: "the drop" },
  { name: "3", bank: "looks", preset: "b" },
];

function cueList(id: NodeId, label: string, cues: readonly Cue[] = SET, extra: Record<string, StoredParameter> = {}): GraphNode {
  return node(id, "cueList", label, { cues: serializeCueList({ version: 1, cues }), ...extra });
}

const LOOKS: readonly Preset[] = [
  { name: "a", values: { blur1: { radius: 10 } } },
  { name: "b", values: { blur1: { radius: 20 } } },
];
/** The preset's OWN morph is 9 s, so a 2 s record can only have come from the cue. */
const FX: readonly Preset[] = [{ name: "dirty", values: { solid1: { amount: 0.9 } }, morph: { seconds: 9, curve: "smooth" } }];

function stage(extra: GraphNode[] = [], list: GraphNode = cueList("list", "set")): GraphNode[] {
  return [
    node("blur", "test.blur", "blur1", { radius: 4 }),
    node("solid", "test.solid", "solid1", { amount: 0.25 }),
    presetBankNode("looks", "looks", "blur1", LOOKS),
    presetBankNode("fx", "fx", "solid1", FX),
    list,
    ...extra,
  ];
}

interface Session {
  bus: LoomBus;
  store: GraphStore;
  /** The frame clock a command invoked now reads; `undefined` is a bus with no app. */
  at(clock: FrameClock | undefined): void;
}

function session(nodes: GraphNode[] = stage()): Session {
  const initialGraph: GraphDocument = { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} };
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-02T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store, registry });
  let clock: FrameClock | undefined;
  bus.attachFrameClock(() => clock);
  return {
    bus,
    store,
    at(next) {
      clock = next;
    },
  };
}

const value = (store: GraphStore, nodeId: NodeId, key: string): StoredParameter | undefined =>
  store.view.getGraph().nodes[nodeId]?.parameters[key];

/** Where a list is, as the document holds it. A parameter never written reads as its default, "". */
const where = (store: GraphStore, listId: NodeId = "list"): { current: unknown; standby: unknown } => ({
  current: value(store, listId, "current") ?? "",
  standby: value(store, listId, "standby") ?? "",
});

async function set(bus: LoomBus, store: GraphStore, nodeId: NodeId, parameters: Record<string, StoredParameter>): Promise<void> {
  const result = await bus.execute("graph.applyPatch", patch(store.view.getRevision(), [{ op: "setParameters", nodeId, parameters }]), contextFor(bob));
  expect(result.status).toBe("applied");
}

/** `BARE` is the command as a KEY sends it: no node named. */
const BARE = null;
const go = (bus: LoomBus, nodeId: NodeId | null = "list") => bus.execute("cue.go", nodeId === BARE ? {} : { nodeId }, contextFor(alice));
const back = (bus: LoomBus, nodeId: NodeId | null = "list") => bus.execute("cue.back", nodeId === BARE ? {} : { nodeId }, contextFor(alice));

const codes = (result: { diagnostics: ReadonlyArray<{ code: string }> }): string[] => result.diagnostics.map((each) => each.code);

/** Everything a refusal must leave alone: the revision, the audit's "applied" rows, the undo stack, the document. */
function snapshot(store: GraphStore) {
  return {
    revision: store.view.getRevision(),
    undo: store.view.getHistory(alice).undo.length,
    graph: JSON.stringify(store.view.getGraph().nodes),
  };
}

describe("GO fires the standby cue and advances the list in the SAME revision (T1500b)", () => {
  it("is one revision, one undo group and one `cue.go` audit entry — the recall and the list together", async () => {
    const { bus, store } = session();
    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;
    const undoBefore = store.view.getHistory(alice).undo.length;

    const result = await go(bus);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
    expect(result.output).toEqual({
      ok: true,
      cue: "1",
      bank: "looks",
      preset: "a",
      current: "1",
      standby: "2",
      applied: ["blur1.radius"],
      skipped: [],
      morph: null,
    });

    // The recall landed: the target, and the BANK's `current` because GO recalled that bank.
    expect(value(store, "blur", "radius")).toBe(10);
    expect(value(store, "looks", "current")).toBe("a");
    // …and the list moved: the fired cue is current, the cue after it stands by.
    expect(where(store)).toEqual({ current: "1", standby: "2" });

    // ONE patch. Two would be a list saying "cue 1" over the old picture after one undo.
    expect(store.view.getRevision()).toBe(revision + 1);
    const audit = store.view.getAudit().slice(auditBefore);
    expect(audit.map((entry) => [entry.command, entry.status, entry.actor.id])).toEqual([["cue.go", "applied", "alice"]]);
    const history = store.view.getHistory(alice).undo;
    expect(history).toHaveLength(undoBefore + 1);
    expect(history.at(-1)?.label).toBe('GO 1 "a" (set)');
  });

  it("one undo puts the targets, the bank AND the list back, so the next GO fires the same cue again", async () => {
    const { bus, store, at } = session();
    at({ epoch: "show", absTimeSeconds: 5 });
    await go(bus);
    const second = await go(bus);
    expect(second.output.cue).toBe("2");
    expect(value(store, "solid", "amount")).toBe(0.9);
    expect(where(store)).toEqual({ current: "2", standby: "3" });
    expect(parseMorphRecords(value(store, "fx", "morphs"))).toHaveLength(1);

    const undone = await bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    // All of GO 2, and nothing of GO 1.
    expect(value(store, "solid", "amount")).toBe(0.25);
    expect(value(store, "fx", "current") ?? "").toBe("");
    expect(parseMorphRecords(value(store, "fx", "morphs"))).toEqual([]);
    expect(where(store)).toEqual({ current: "1", standby: "2" });
    expect(value(store, "blur", "radius")).toBe(10);

    const again = await go(bus);
    expect(again.output.cue).toBe("2");
    expect(value(store, "solid", "amount")).toBe(0.9);
    expect(where(store)).toEqual({ current: "2", standby: "3" });
  });

  it("stays its own undo group inside a caller's transaction", async () => {
    const { bus, store } = session();
    const inTransaction = contextFor(alice, { transactionId: "drag-1" });
    await bus.execute("graph.applyPatch", patch(store.view.getRevision(), [{ op: "setParameters", nodeId: "blur", parameters: { radius: 7 } }]), inTransaction);
    await bus.execute("cue.go", { nodeId: "list" }, inTransaction);
    expect(value(store, "blur", "radius")).toBe(10);
    // One undo takes back the GO ALONE — the drag's 7 is what it lands on.
    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(value(store, "blur", "radius")).toBe(7);
    expect(where(store)).toEqual({ current: "", standby: "" });
  });

  it("fires an explicit standby, wherever current is", async () => {
    const { bus, store } = session();
    await go(bus);
    await set(bus, store, "list", { standby: "3" });
    const result = await go(bus);
    expect(result.output.cue).toBe("3");
    expect(value(store, "blur", "radius")).toBe(20);
    // Cue 3 is the last and Wrap is off: nothing stands by, and the list says so.
    expect(where(store)).toEqual({ current: "3", standby: "" });
  });
});

describe("the CUE's morph carries the recall (the design doc §5.1, T1500b)", () => {
  it("overrides the preset's own morph: the record is the cue's 2 s linear, stamped at the frame clock", async () => {
    const { bus, store, at } = session();
    at({ epoch: "show", absTimeSeconds: 5 });
    await go(bus);
    const result = await go(bus);
    expect(result.output.morph).toEqual(CUE_MORPH);
    // The END state is in the document at once; the fade is the record's business.
    expect(value(store, "solid", "amount")).toBe(0.9);
    const records = parseMorphRecords(value(store, "fx", "morphs"));
    expect(records.map((record) => ({ epoch: record.epoch, start: record.start, seconds: record.seconds, curve: record.curve, preset: record.preset }))).toEqual([
      { epoch: "show", start: 5, seconds: 2, curve: "linear", preset: "dirty" },
    ]);
    expect(records[0]?.from).toEqual({ solid1: { amount: 0.25 } });
    expect(records[0]?.to).toEqual({ solid1: { amount: 0.9 } });
  });

  it("a cue with no morph falls to the preset's, then the bank's — the same ladder a pad recall climbs", async () => {
    const nodes = stage().map((each) => (each.id === "looks" ? presetBankNode("looks", "looks", "blur1", LOOKS, { morph: 3, curve: "in" }) : each));
    const { bus, store, at } = session(nodes);
    at({ epoch: "show", absTimeSeconds: 1 });
    const result = await go(bus);
    // Cue 1 names no morph and preset `a` has none, so the bank's 3 s ease-in applies.
    expect(result.output.morph).toEqual({ seconds: 3, curve: "in" });
    expect(parseMorphRecords(value(store, "looks", "morphs")).map((record) => record.seconds)).toEqual([3]);
  });

  it("with no frame clock (headless) the cue commits as a cut, says why, and the list still advances", async () => {
    const { bus, store } = session();
    await go(bus);
    const result = await go(bus);
    expect(result.status).toBe("applied");
    expect(result.output.morph).toBeNull();
    expect(codes(result)).toContain("preset.recall.morphUnavailable");
    expect(value(store, "solid", "amount")).toBe(0.9);
    expect(where(store)).toEqual({ current: "2", standby: "3" });
  });
});

describe("BACK fires the previous cue, with its morph (owner's ruling, T1500b)", () => {
  it("re-fires the cue before current as one `cue.back` patch, and the standby is the cue after it", async () => {
    const { bus, store, at } = session();
    at({ epoch: "show", absTimeSeconds: 2 });
    await go(bus);
    await go(bus);
    await go(bus);
    expect(where(store)).toEqual({ current: "3", standby: "" });
    // Something has moved cue 2's target since it fired, so BACK re-firing it is visible.
    await set(bus, store, "solid", { amount: 0.1 });
    at({ epoch: "show", absTimeSeconds: 30 });

    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;
    const result = await back(bus);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
    expect(result.output).toMatchObject({ ok: true, cue: "2", bank: "fx", preset: "dirty", current: "2", standby: "3", morph: CUE_MORPH });

    expect(value(store, "solid", "amount")).toBe(0.9);
    expect(where(store)).toEqual({ current: "2", standby: "3" });
    // Fired WITH the cue's morph: a fresh 2 s record from the 0.1 it found, at the new clock.
    const record = parseMorphRecords(value(store, "fx", "morphs")).at(-1);
    expect(record).toMatchObject({ start: 30, seconds: 2, curve: "linear", from: { solid1: { amount: 0.1 } } });

    expect(store.view.getRevision()).toBe(revision + 1);
    expect(store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status])).toEqual([["cue.back", "applied"]]);
    expect(store.view.getHistory(alice).undo.at(-1)?.label).toBe('BACK 2 "dirty" (set)');

    // And GO from here fires cue 3 again: BACK left the list where a GO of cue 2 would have.
    expect((await go(bus)).output.cue).toBe("3");
  });

  it("does not move the standby backwards without firing: BACK from cue 2 FIRES cue 1", async () => {
    const { bus, store } = session();
    await go(bus);
    await go(bus);
    await set(bus, store, "blur", { radius: 33 });
    const result = await back(bus);
    expect(result.output.cue).toBe("1");
    expect(value(store, "blur", "radius")).toBe(10);
    expect(where(store)).toEqual({ current: "1", standby: "2" });
  });

  it("is refused at the first cue and before any GO, and the list does not move", async () => {
    const { bus, store } = session();
    const unfired = await back(bus);
    expect(unfired.status).toBe("rejected");
    expect(codes(unfired)).toEqual(["cue.back.unfired"]);
    expect(where(store)).toEqual({ current: "", standby: "" });

    await go(bus);
    const before = snapshot(store);
    const atStart = await back(bus);
    expect(atStart.status).toBe("rejected");
    expect(codes(atStart)).toEqual(["cue.back.start"]);
    expect(snapshot(store)).toEqual(before);
  });
});

describe("GO past the end without Wrap is refused and the standby stays (T1500b)", () => {
  it("refuses by name, changes nothing, and is audited as a rejected cue.go", async () => {
    const { bus, store } = session();
    await go(bus);
    await go(bus);
    await go(bus);
    const before = snapshot(store);
    const auditBefore = store.view.getAudit().length;

    const result = await go(bus);
    expect(result.status).toBe("rejected");
    expect(codes(result)).toEqual(["cue.go.end"]);
    expect(result.diagnostics[0]?.message).toBe('Cue list "set": "3" is its last cue and Wrap is off; nothing was fired.');
    expect(result.output).toMatchObject({ ok: false, cue: null, current: "3", standby: "" });

    expect(snapshot(store)).toEqual(before);
    expect(where(store)).toEqual({ current: "3", standby: "" });
    expect(store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status])).toEqual([["cue.go", "rejected"]]);
  });

  it("with Wrap on, the last cue leaves the FIRST standing by and GO goes round", async () => {
    const { bus, store } = session(stage([], cueList("list", "set", SET, { wrap: true })));
    await go(bus);
    await go(bus);
    await go(bus);
    expect(where(store)).toEqual({ current: "3", standby: "1" });
    await set(bus, store, "blur", { radius: 33 });
    const result = await go(bus);
    expect(result.output.cue).toBe("1");
    expect(value(store, "blur", "radius")).toBe(10);
    expect(where(store)).toEqual({ current: "1", standby: "2" });
  });

  it("turning Wrap on after running off the end lets the next GO go round", async () => {
    const { bus, store } = session();
    await go(bus);
    await go(bus);
    await go(bus);
    expect((await go(bus)).status).toBe("rejected");
    await set(bus, store, "list", { wrap: true });
    expect((await go(bus)).output.cue).toBe("1");
  });
});

describe("a cue naming a missing bank or preset is refused and the standby stays (T1500b)", () => {
  /** A list whose SECOND cue is the broken one, so the standby is an explicit "2" when GO meets it. */
  async function standingOn(broken: Cue, extra: GraphNode[] = []): Promise<Session> {
    const made = session(stage(extra, cueList("list", "set", [SET[0]!, broken, SET[2]!])));
    await go(made.bus);
    expect(where(made.store)).toEqual({ current: "1", standby: "2" });
    return made;
  }

  it.each([
    ["a bank that does not exist", { name: "2", bank: "ghost", preset: "dirty" }, "cue.bank.missing", 'Cue "2" (set): no node is named "ghost"; nothing was fired.'],
    ["a node that is not a bank", { name: "2", bank: "blur1", preset: "dirty" }, "cue.bank.type", 'Cue "2" (set): "blur1" is a test.blur node, not a Presets bank; nothing was fired.'],
    ["a preset the bank does not hold", { name: "2", bank: "fx", preset: "gone" }, "cue.preset.missing", 'Cue "2" (set): bank "fx" has no preset "gone"; nothing was fired.'],
  ] satisfies Array<[string, Cue, string, string]>)("%s: refused by name, nothing written, standby still on the cue", async (_what, broken, code, message) => {
    const { bus, store } = await standingOn(broken);
    const before = snapshot(store);
    const result = await go(bus);
    expect(result.status).toBe("rejected");
    expect(codes(result)).toEqual([code]);
    expect(result.diagnostics[0]?.message).toBe(message);
    expect(result.output).toMatchObject({ ok: false, cue: "2", current: "1", standby: "2", applied: [] });
    expect(snapshot(store)).toEqual(before);
    // THE RULE: the list still says cue 1 is live and cue 2 is next. It did not skip to 3.
    expect(where(store)).toEqual({ current: "1", standby: "2" });
  });

  it("a cue whose preset has nothing left to apply is refused too (ruling 4), naming the target that is gone", async () => {
    const orphan = presetBankNode("old", "old", "vanished", [{ name: "p", values: { vanished: { radius: 1 } } }]);
    const { bus, store } = await standingOn({ name: "2", bank: "old", preset: "p" }, [orphan]);
    const before = snapshot(store);
    const result = await go(bus);
    expect(result.status).toBe("rejected");
    expect(codes(result)).toEqual(["preset.target.missing", "cue.fire.nothing"]);
    expect(result.output.skipped).toEqual(["vanished"]);
    expect(snapshot(store)).toEqual(before);
    expect(where(store)).toEqual({ current: "1", standby: "2" });
  });

  it("the operator moves the standby past the broken cue and the set carries on", async () => {
    const { bus, store } = await standingOn({ name: "2", bank: "ghost", preset: "dirty" });
    expect((await go(bus)).status).toBe("rejected");
    const moved = await bus.execute("cue.setStandby", { nodeId: "list", cue: "3" }, contextFor(alice));
    expect(moved.status).toBe("applied");
    expect((await go(bus)).output.cue).toBe("3");
    expect(value(store, "blur", "radius")).toBe(20);
  });

  it("a cue that still has SOMETHING to apply fires, skipping what is gone by name (ruling 4)", async () => {
    const partial = presetBankNode("mix", "mix", "solid1 vanished", [{ name: "p", values: { solid1: { amount: 0.6 }, vanished: { radius: 1 } } }]);
    const { bus, store } = await standingOn({ name: "2", bank: "mix", preset: "p" }, [partial]);
    const result = await go(bus);
    expect(result.status).toBe("applied");
    expect(result.output).toMatchObject({ applied: ["solid1.amount"], skipped: ["vanished"] });
    expect(value(store, "solid", "amount")).toBe(0.6);
    expect(where(store)).toEqual({ current: "2", standby: "3" });
  });

  it("a standby naming a cue that is no longer in the list is refused — never a quiet jump to cue 1", async () => {
    const { bus, store } = session();
    await go(bus);
    await set(bus, store, "list", { standby: "9" });
    const before = snapshot(store);
    const result = await go(bus);
    expect(result.status).toBe("rejected");
    expect(codes(result)).toEqual(["cue.standby.unknown"]);
    expect(snapshot(store)).toEqual(before);
    expect(where(store)).toEqual({ current: "1", standby: "9" });
  });

  it("a malformed Cues field is refused, naming the list, and nothing is overwritten", async () => {
    const { bus, store } = session(stage([], node("list", "cueList", "set", { cues: "{ not json" })));
    const result = await go(bus);
    expect(result.status).toBe("rejected");
    expect(codes(result)).toEqual(["cue.list.malformed"]);
    expect(result.diagnostics[0]?.message).toBe('Cue list "set": the cues field is not valid JSON.');
    expect(value(store, "list", "cues")).toBe("{ not json");
  });
});

describe("a bare GO acts on the ONE list with Keys on; none or several is refused, naming them (T1500b)", () => {
  const second = (extra: Record<string, StoredParameter> = {}): GraphNode =>
    cueList("list2", "encore", [{ name: "e1", bank: "looks", preset: "b" }], extra);

  it("with one list, GO and BACK with no nodeId reach it", async () => {
    const { bus, store } = session();
    expect((await go(bus, BARE)).output.cue).toBe("1");
    expect((await go(bus, BARE)).output.cue).toBe("2");
    expect((await back(bus, BARE)).output.cue).toBe("1");
    expect(where(store)).toEqual({ current: "1", standby: "2" });
  });

  it("with two lists answering, it is refused naming BOTH, and neither moves", async () => {
    const { bus, store } = session(stage([second()]));
    const before = snapshot(store);
    for (const result of [await go(bus, BARE), await back(bus, BARE)]) {
      expect(result.status).toBe("rejected");
      expect(codes(result)).toEqual(["cue.list.ambiguous"]);
      expect(result.diagnostics[0]?.message).toBe('2 cue lists answer GO and BACK — "set", "encore" — so nothing was fired.');
    }
    expect(snapshot(store)).toEqual(before);
  });

  it("Keys off on one of them settles it: the bare GO fires the other", async () => {
    const { bus, store } = session(stage([second({ keys: false })]));
    expect((await go(bus, BARE)).output.cue).toBe("1");
    expect(where(store, "list2")).toEqual({ current: "", standby: "" });

    await set(bus, store, "list", { keys: false });
    await set(bus, store, "list2", { keys: true });
    const result = await go(bus, BARE);
    expect(result.output).toMatchObject({ cue: "e1", bank: "looks", preset: "b" });
    expect(where(store, "list2")).toEqual({ current: "e1", standby: "" });
  });

  it("with Keys off everywhere it is refused naming the lists; with no list at all it says so", async () => {
    const off = session(stage([second({ keys: false })], cueList("list", "set", SET, { keys: false })));
    const refused = await go(off.bus, BARE);
    expect(refused.status).toBe("rejected");
    expect(codes(refused)).toEqual(["cue.list.none"]);
    expect(refused.diagnostics[0]?.message).toBe('No cue list answers GO and BACK: Keys is off on "set", "encore".');

    const empty = session([node("blur", "test.blur", "blur1")]);
    const none = await go(empty.bus, BARE);
    expect(none.status).toBe("rejected");
    expect(none.diagnostics[0]?.message).toBe("This document has no cue list, so GO and BACK have nothing to fire.");
  });

  it("a NAMED list fires whatever its Keys say, and two lists answering does not get in its way", async () => {
    const { bus, store } = session(stage([second()], cueList("list", "set", SET, { keys: false })));
    expect((await go(bus, "list")).output.cue).toBe("1");
    expect((await go(bus, "list2")).output.cue).toBe("e1");
    expect(where(store)).toEqual({ current: "1", standby: "2" });
  });

  it("a node that is not a cue list is refused by type", async () => {
    const { bus } = session();
    const result = await go(bus, "blur");
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.message).toBe('"blur1" is a test.blur node, not a Cue List.');
    expect(codes(await go(bus, "nope"))).toEqual(["cue.list.missing"]);
  });
});

describe("the list's GO and BACK pulses fire it, on ITS node (T1500b)", () => {
  it("parameter.pulse on `go` / `back` advances that list — even with another list answering the keys", async () => {
    const other = cueList("list2", "encore", [{ name: "e1", bank: "looks", preset: "b" }]);
    const { bus, store } = session(stage([other]));
    const pulse = (parameterKey: string) => bus.execute("parameter.pulse", { nodeId: "list", parameterKey }, contextFor(alice));

    expect((await pulse("go")).output).toEqual({ fired: "cue.go" });
    expect((await pulse("go")).output).toEqual({ fired: "cue.go" });
    expect(where(store)).toEqual({ current: "2", standby: "3" });
    expect((await pulse("back")).output).toEqual({ fired: "cue.back" });
    expect(where(store)).toEqual({ current: "1", standby: "2" });
    expect(where(store, "list2")).toEqual({ current: "", standby: "" });
  });

  it("a pulse whose GO is refused reports the refusal instead of claiming it fired", async () => {
    const { bus } = session(stage([], cueList("list", "set", [])));
    const result = await bus.execute("parameter.pulse", { nodeId: "list", parameterKey: "go" }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.output).toEqual({ fired: null });
    expect(codes(result)).toEqual(["cue.go.empty"]);
  });
});

describe("cue.fire fires a named cue; cue.setStandby moves the standby without firing (T1500b)", () => {
  it("fire: one patch, the named cue is current, the cue after it stands by", async () => {
    const { bus, store } = session();
    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;
    const result = await bus.execute("cue.fire", { nodeId: "list", cue: "3" }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.output).toMatchObject({ ok: true, cue: "3", bank: "looks", preset: "b", current: "3", standby: "" });
    expect(value(store, "blur", "radius")).toBe(20);
    expect(store.view.getRevision()).toBe(revision + 1);
    expect(store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status])).toEqual([["cue.fire", "applied"]]);
    expect(store.view.getHistory(alice).undo.at(-1)?.label).toBe('Fire 3 "b" (set)');

    const first = await bus.execute("cue.fire", { nodeId: "list", cue: "1" }, contextFor(alice));
    expect(first.output).toMatchObject({ current: "1", standby: "2" });
  });

  it("fire: an unknown cue is refused, listing the cues, and the list does not move", async () => {
    const { bus, store } = session();
    await go(bus);
    const before = snapshot(store);
    const result = await bus.execute("cue.fire", { nodeId: "list", cue: "7" }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(codes(result)).toEqual(["cue.unknown"]);
    expect(result.diagnostics[0]).toMatchObject({ message: 'Cue list "set": it has no cue "7"; nothing was fired.', suggestion: "Its cues: 1, 2, 3." });
    expect(snapshot(store)).toEqual(before);
  });

  it("setStandby: writes the standby and NOTHING else, as one undoable step, and GO then fires it", async () => {
    const { bus, store } = session();
    await go(bus);
    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;

    const moved = await bus.execute("cue.setStandby", { nodeId: "list", cue: "3" }, contextFor(alice));
    expect(moved.status).toBe("applied");
    expect(moved.output).toEqual({ ok: true, current: "1", standby: "3" });
    // Nothing fired: the targets and the banks are exactly where GO 1 left them.
    expect(value(store, "blur", "radius")).toBe(10);
    expect(value(store, "solid", "amount")).toBe(0.25);
    expect(where(store)).toEqual({ current: "1", standby: "3" });
    expect(store.view.getRevision()).toBe(revision + 1);
    expect(store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status])).toEqual([["cue.setStandby", "applied"]]);
    expect(store.view.getHistory(alice).undo.at(-1)?.label).toBe("Standby 3 (set)");

    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(where(store)).toEqual({ current: "1", standby: "2" });

    await bus.execute("cue.setStandby", { nodeId: "list", cue: "3" }, contextFor(alice));
    expect((await go(bus)).output.cue).toBe("3");
  });

  it("setStandby: an unknown cue is refused and the standby stays", async () => {
    const { bus, store } = session();
    await go(bus);
    const before = snapshot(store);
    const result = await bus.execute("cue.setStandby", { nodeId: "list", cue: "7" }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.output).toEqual({ ok: false, current: "1", standby: "2" });
    expect(result.diagnostics[0]?.message).toBe('Cue list "set": it has no cue "7"; the standby was not moved.');
    expect(snapshot(store)).toEqual(before);
  });

  it("neither guesses a list: with no nodeId they are refused even when exactly one list exists", async () => {
    const { bus } = session();
    const fire = await bus.execute("cue.fire", { cue: "1" } as never, contextFor(alice));
    const standby = await bus.execute("cue.setStandby", { cue: "1" } as never, contextFor(alice));
    expect(codes(fire)).toEqual(["cue.list.missing"]);
    expect(codes(standby)).toEqual(["cue.list.missing"]);
  });

  it("a dry run validates and moves nothing (§V36)", async () => {
    const { bus, store } = session();
    const before = snapshot(store);
    const result = await bus.execute("cue.go", { nodeId: "list" }, contextFor(alice, { dryRun: true }));
    expect(result.status).toBe("validated");
    expect(snapshot(store)).toEqual(before);
  });
});

describe("the cue.list query reports cues, current, standby, the derived next and running morphs (T1500b)", () => {
  it("reports one list: where it is, what GO would fire, and the fade its bank is running", async () => {
    const { bus, at } = session();
    at({ epoch: "show", absTimeSeconds: 5 });
    await go(bus);
    await go(bus);
    // Half a second into cue 2's two-second morph.
    at({ epoch: "show", absTimeSeconds: 5.5 });

    const { lists } = await bus.query("cue.list", { nodeId: "list" }, contextFor(alice));
    expect(lists).toEqual([
      {
        nodeId: "list",
        name: "set",
        malformed: null,
        cues: SET,
        current: "2",
        standby: "3",
        next: "3",
        wrap: false,
        keys: true,
        morphs: [{ bank: "fx", preset: "dirty", start: 5, seconds: 2, curve: "linear", progress: 0.25 }],
      },
    ]);

    // Once the fade is over, it is no longer reported as running.
    at({ epoch: "show", absTimeSeconds: 8 });
    expect((await bus.query("cue.list", { nodeId: "list" }, contextFor(alice))).lists[0]?.morphs).toEqual([]);
  });

  it("derives `next` exactly as GO does: null at the end without Wrap, the first cue before any GO", async () => {
    const { bus } = session();
    const next = async (): Promise<string | null | undefined> => (await bus.query("cue.list", { nodeId: "list" }, contextFor(alice))).lists[0]?.next;
    expect(await next()).toBe("1");
    await go(bus);
    await go(bus);
    await go(bus);
    expect(await next()).toBeNull();
  });

  it("without a nodeId reports every cue list, and a malformed one says why instead of vanishing", async () => {
    const broken = node("list2", "cueList", "encore", { cues: "{ nope", keys: false });
    const { bus } = session(stage([broken]));
    const { lists } = await bus.query("cue.list", {}, contextFor(alice));
    expect(lists.map((each) => [each.name, each.malformed, each.cues.length, each.next, each.keys])).toEqual([
      ["set", null, 3, "1", true],
      ["encore", "the cues field is not valid JSON", 0, null, false],
    ]);
    expect((await bus.query("cue.list", { nodeId: "blur" }, contextFor(alice))).lists).toEqual([]);
  });
});

describe("a cue that fires a SHOT is still one GO (§T1499b's planner, T1500b)", () => {
  /** `drop` sets the solid itself and recalls the looks bank's `b` — two banks, one cue. */
  const SHOTS: readonly Preset[] = [
    { name: "drop", values: { solid1: { amount: 0.6 } }, recalls: [{ bank: "looks", preset: "b" }] },
    { name: "loop", values: { solid1: { amount: 0.7 } }, recalls: [{ bank: "shots", preset: "loop" }] },
  ];
  const withShots = (cues: readonly Cue[]): Session =>
    session(stage([presetBankNode("shots", "shots", "solid1", SHOTS)], cueList("list", "set", cues)));

  it("everything the shot reaches, both banks' `current` and the list move in ONE revision, and one undo takes it all back", async () => {
    const { bus, store } = withShots([{ name: "1", bank: "shots", preset: "drop" }, SET[2]!]);
    const revision = store.view.getRevision();
    const auditBefore = store.view.getAudit().length;

    const result = await go(bus);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
    expect([...result.output.applied].sort()).toEqual(["blur1.radius", "solid1.amount"]);
    expect(value(store, "solid", "amount")).toBe(0.6);
    expect(value(store, "blur", "radius")).toBe(20);
    expect(value(store, "shots", "current")).toBe("drop");
    expect(value(store, "looks", "current")).toBe("b");
    expect(where(store)).toEqual({ current: "1", standby: "3" });

    expect(store.view.getRevision()).toBe(revision + 1);
    expect(store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status])).toEqual([["cue.go", "applied"]]);

    await bus.execute("graph.undo", {}, contextFor(alice));
    expect(value(store, "solid", "amount")).toBe(0.25);
    expect(value(store, "blur", "radius")).toBe(4);
    expect(value(store, "shots", "current") ?? "").toBe("");
    expect(value(store, "looks", "current") ?? "").toBe("");
    expect(where(store)).toEqual({ current: "", standby: "" });
  });

  it("a shot the planner refuses (its recalls go round in a circle) is refused in the planner's words, and the standby stays", async () => {
    const { bus, store } = withShots([SET[0]!, { name: "2", bank: "shots", preset: "loop" }, SET[2]!]);
    await go(bus);
    const before = snapshot(store);
    const result = await go(bus);
    expect(result.status).toBe("rejected");
    // The planner's diagnosis alone — not "nothing left to apply", which is not why.
    expect(codes(result)).toEqual(["preset.recall.cycle"]);
    expect(result.output).toMatchObject({ ok: false, cue: "2", current: "1", standby: "2", applied: [] });
    expect(snapshot(store)).toEqual(before);
    expect(where(store)).toEqual({ current: "1", standby: "2" });
  });
});

describe("renaming a bank carries the cues that name it (§V128, T1500b)", () => {
  it("the cue follows the rename and GO still fires it", async () => {
    const { bus, store } = session();
    const renamed = await bus.execute("node.rename", { nodeId: "looks", label: "city" }, contextFor(alice));
    expect(renamed.status).toBe("applied");
    const parsed = parseCueList(value(store, "list", "cues"));
    expect(parsed.ok ? parsed.list.cues.map((each) => each.bank) : []).toEqual(["city", "fx", "city"]);
    const result = await go(bus);
    expect(result.output).toMatchObject({ ok: true, cue: "1", bank: "city" });
    expect(value(store, "blur", "radius")).toBe(10);
  });

  it("a cue list pasted beside its bank fires the PASTED bank's preset, never the original's (§V320)", async () => {
    const { bus, store } = session([
      node("blur", "test.blur", "blur1", { radius: 4 }),
      presetBankNode("looks", "looks", "blur1", LOOKS),
      cueList("list", "set", [SET[0]!], { keys: false }),
    ]);
    await bus.execute("graph.copySelection", { nodeIds: ["blur", "looks", "list"] }, contextFor(alice));
    const pasted = await bus.execute("graph.paste", {}, contextFor(alice));
    expect(pasted.status).toBe("applied");

    const graph = store.view.getGraph();
    const copyOf = (type: string, original: NodeId): GraphNode => Object.values(graph.nodes).find((each) => each.type === type && each.id !== original)!;
    const copyList = copyOf("cueList", "list");
    const copyBank = copyOf("presets", "looks");
    const copyBlur = copyOf("test.blur", "blur");
    const cues = parseCueList(copyList.parameters["cues"]);
    expect(cues.ok ? cues.list.cues.map((each) => each.bank) : []).toEqual([copyBank.label]);
    expect(copyBank.label).not.toBe("looks");

    const result = await go(bus, copyList.id);
    expect(result.status).toBe("applied");
    expect(value(store, copyBlur.id, "radius")).toBe(10);
    // The originals are untouched: neither the first blur nor the first bank's `current`.
    expect(value(store, "blur", "radius")).toBe(4);
    expect(value(store, "looks", "current") ?? "").toBe("");
  });
});
