import { describe, expect, it } from "vitest";

import type { LoomBus } from "@domain/commands/bus.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore, type GraphStore } from "@domain/graph/store.ts";
import type { CueListQueryOutput } from "@domain/presets/cue-commands.ts";
import { serializeCueList, type Cue } from "@domain/presets/cue-list.ts";
import type { PresetDeleteOutput } from "@domain/presets/delete-command.ts";
import type { MorphSpec, Preset } from "@domain/presets/bank.ts";
import { presetBankNode } from "@domain/presets/test-support.ts";
import type { Actor } from "@domain/types/commands.ts";
import type { FrameClock } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { cueListNode } from "@nodes/definitions/cue-list.ts";
import { presetsNode } from "@nodes/definitions/presets.ts";
import { constantNode } from "@nodes/definitions/values.ts";
import { graphChannelResolver } from "@domain/channels/graph-channels.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { testNodeDefinitions } from "@nodes/registry/test-nodes.ts";

import { createAgentToolSurface, type AgentToolSurface } from "./surface.ts";
import type { CueFireData, PresetListing, RecallPresetData } from "./tools/presets.ts";
import type { ToolResult } from "./types.ts";

/**
 * T1502b (§T1398b S7) — the agent's preset and cue tools, through the REAL bus.
 *
 * The design doc §12 S7 asks three things: each tool round-trips through the bus under the
 * agent actor, `recall_preset` with a morph reports the record, `list_presets` reports
 * progress. Each test reads what a consumer reads — the document after the call, the audit
 * ring, the agent's own undo stack, the tool's `data` — never which function ran.
 *
 * THE STAGE (the cue list's, so a GO and a pad recall are the same presets):
 *
 *   looks   targets blur1      a: radius 10      b: radius 20
 *   fx      targets solid1     dirty: amount 0.9, its own morph 9 s smooth
 *   set     1 looks/a · 2 fx/dirty (cue morph 2 s linear) · 3 looks/b
 */

const AGENT: Actor = { kind: "agent", id: "claude", label: "Claude" };

const registry = createNodeRegistry([...testNodeDefinitions, presetsNode, cueListNode, constantNode]).view();

function node(id: NodeId, type: string, label: string, parameters: Record<string, StoredParameter> = {}): GraphNode {
  return { id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

const LOOKS: readonly Preset[] = [
  { name: "a", values: { blur1: { radius: 10 } } },
  { name: "b", values: { blur1: { radius: 20 } } },
];
const PRESET_MORPH: MorphSpec = { seconds: 9, curve: "smooth" };
const FX: readonly Preset[] = [{ name: "dirty", values: { solid1: { amount: 0.9 } }, morph: PRESET_MORPH }];
const CUE_MORPH: MorphSpec = { seconds: 2, curve: "linear" };
const SET: readonly Cue[] = [
  { name: "1", bank: "looks", preset: "a" },
  { name: "2", bank: "fx", preset: "dirty", morph: CUE_MORPH },
  { name: "3", bank: "looks", preset: "b" },
];

interface Session {
  bus: LoomBus;
  store: GraphStore;
  surface: AgentToolSurface;
  /** The frame clock a command invoked now reads; `undefined` is a bus with no app (headless). */
  at(clock: FrameClock | undefined): void;
}

function session(extra: { readonly nodes?: readonly GraphNode[]; readonly looks?: Record<string, StoredParameter> } = {}): Session {
  const nodes = [
    node("blur", "test.blur", "blur1", { radius: 4 }),
    node("solid", "test.solid", "solid1", { amount: 0.25 }),
    presetBankNode("looks", "looks", "blur1", LOOKS, extra.looks),
    presetBankNode("fx", "fx", "solid1", FX),
    node("list", "cueList", "set", { cues: serializeCueList({ version: 1, cues: SET }) }),
    ...(extra.nodes ?? []),
  ];
  const initialGraph: GraphDocument = { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} };
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-02T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store, registry });
  let clock: FrameClock | undefined;
  bus.attachFrameClock(() => clock);
  return {
    bus,
    store,
    surface: createAgentToolSurface({ bus, actor: AGENT, projectId: "p" }),
    at(next) {
      clock = next;
    },
  };
}

const value = (store: GraphStore, nodeId: NodeId, key: string): StoredParameter | undefined =>
  store.view.getGraph().nodes[nodeId]?.parameters[key];

/** The audit ring since `from`, as `command status actor` — who the bus says did what. */
const auditSince = (store: GraphStore, from: number): string[] =>
  store.view
    .getAudit()
    .slice(from)
    .map((entry) => `${entry.command} ${entry.status} ${entry.actor.kind}:${entry.actor.id}`);

const said = (outcome: ToolResult): string[] => outcome.diagnostics.map((each) => each.message);

async function banksOf(surface: AgentToolSurface): Promise<PresetListing> {
  const listed = await surface.callTool("list_presets", {});
  expect(listed.status, said(listed).join("; ")).toBe("ok");
  return listed.data as PresetListing;
}

async function listOf(surface: AgentToolSurface): Promise<CueListQueryOutput["lists"][number]> {
  const listed = await surface.callTool("list_cues", { nodeId: "list" });
  expect(listed.status, said(listed).join("; ")).toBe("ok");
  return (listed.data as CueListQueryOutput).lists[0]!;
}

describe("store, recall and delete round-trip through the bus as the agent (T1502b)", () => {
  it("lists a bank as the document holds it", async () => {
    const { surface } = session();
    const { banks, clockSeconds } = await banksOf(surface);
    expect(clockSeconds).toBeNull();
    expect(banks.map((bank) => [bank.nodeId, bank.name, bank.targets, bank.current, bank.presets.map((preset) => preset.name)])).toEqual([
      ["fx", "fx", ["solid1"], "", ["dirty"]],
      ["looks", "looks", ["blur1"], "", ["a", "b"]],
    ]);
    // What a plain recall of each would do, by §5.1's ladder: the preset's own morph, else the bank's cut.
    expect(banks[0]?.presets[0]).toEqual({ name: "dirty", keys: ["solid1.amount"], on: {}, recalls: [], morph: PRESET_MORPH });
    expect(banks[1]?.presets[0]?.morph).toEqual({ seconds: 0, curve: "smooth" });
  });

  it("stores what the targets hold now, recalls it back, and deletes it — each one agent-audited step", async () => {
    const { surface, store, bus } = session();
    const before = store.view.getAudit().length;

    const stored = await surface.callTool("store_preset", { nodeId: "looks", name: "base" });
    expect(stored.status, said(stored).join("; ")).toBe("ok");
    expect(stored.data).toMatchObject({ ok: true, preset: "base", missing: [] });
    // The bank lists it with the key it captured: the blur's radius, as the document had it.
    const listed = (await banksOf(surface)).banks.find((bank) => bank.nodeId === "looks");
    expect(listed?.presets.map((preset) => preset.name)).toEqual(["a", "b", "base"]);
    expect(listed?.presets[2]?.keys).toContain("blur1.radius");

    const recalled = await surface.callTool("recall_preset", { nodeId: "looks", name: "b" });
    expect(recalled.status, said(recalled).join("; ")).toBe("ok");
    expect(value(store, "blur", "radius")).toBe(20);
    expect((recalled.data as RecallPresetData).applied).toEqual(["blur1.radius"]);
    expect((await banksOf(surface)).banks.find((bank) => bank.nodeId === "looks")?.current).toBe("b");

    // The stored preset holds the value from BEFORE that recall, so recalling it is the way back.
    await surface.callTool("recall_preset", { nodeId: "looks", name: "base" });
    expect(value(store, "blur", "radius")).toBe(4);

    const deleted = await surface.callTool("delete_preset", { nodeId: "looks", name: "a" });
    expect(deleted.status, said(deleted).join("; ")).toBe("ok");
    expect(deleted.data as PresetDeleteOutput).toEqual({ ok: true, preset: "a", remaining: ["b", "base"] });
    expect((await banksOf(surface)).banks.find((bank) => bank.nodeId === "looks")?.presets.map((preset) => preset.name)).toEqual(["b", "base"]);

    // §V30: every one of them is the AGENT's, under the command's own name.
    expect(auditSince(store, before)).toEqual([
      "preset.store applied agent:claude",
      "preset.recall applied agent:claude",
      "preset.recall applied agent:claude",
      "preset.delete applied agent:claude",
    ]);
    // …and each landed on the agent's own undo stack as its own step (§V41): one undo
    // brings the deleted preset back whole.
    expect(bus.store.getHistory(AGENT).undo).toHaveLength(4);
    const undone = await surface.callTool("undo", {});
    expect(undone.status).toBe("ok");
    expect((await banksOf(surface)).banks.find((bank) => bank.nodeId === "looks")?.presets.map((preset) => preset.name)).toEqual(["a", "b", "base"]);
  });

  it("a dry run validates and changes nothing", async () => {
    const { surface, store } = session();
    const before = store.view.getAudit().length;
    const dry = await surface.callTool("recall_preset", { nodeId: "looks", name: "b", dryRun: true });
    expect(dry.status).toBe("validated");
    expect(value(store, "blur", "radius")).toBe(4);
    expect(auditSince(store, before)).toEqual([]);
  });
});

describe("recall_preset says what the SCREEN did (T1502b, the design doc §5.5)", () => {
  it("reports the morph record when the bus has a frame clock", async () => {
    const { surface, store, at } = session();
    at({ epoch: "show", absTimeSeconds: 5 });

    // The call's own morph beats the preset's 9 s smooth (§5.1).
    const recalled = await surface.callTool("recall_preset", { nodeId: "fx", name: "dirty", morph: { seconds: 2, curve: "linear" } });
    expect(recalled.status, said(recalled).join("; ")).toBe("ok");
    const data = recalled.data as RecallPresetData;
    expect(data.transition).toBe("morph");
    expect(data.morphUnavailable).toBe(false);
    expect(data.record).toEqual({ preset: "dirty", start: 5, seconds: 2, curve: "linear", progress: 0, keys: ["solid1.amount"] });
    // The END value is in the document already — the fade is the screen's, not the store's.
    expect(value(store, "solid", "amount")).toBe(0.9);
  });

  it("uses the preset's own morph when the call names none, and a zero-second override is a cut", async () => {
    const { surface, at } = session();
    at({ epoch: "show", absTimeSeconds: 1 });

    const cut = (await surface.callTool("recall_preset", { nodeId: "fx", name: "dirty", morph: { seconds: 0, curve: "linear" } })).data as RecallPresetData;
    expect([cut.transition, cut.morphUnavailable, cut.record]).toEqual(["cut", false, null]);

    await surface.callTool("undo", {});
    const own = (await surface.callTool("recall_preset", { nodeId: "fx", name: "dirty" })).data as RecallPresetData;
    expect(own.transition).toBe("morph");
    expect(own.record).toMatchObject({ preset: "dirty", start: 1, seconds: 9, curve: "smooth" });
  });

  it("headless, a morph commits as a cut and the result says so plainly", async () => {
    const { surface, store } = session(); // no frame clock attached: a bus with no app

    const recalled = await surface.callTool("recall_preset", { nodeId: "fx", name: "dirty", morph: { seconds: 2, curve: "linear" } });
    // The values landed — it is not a refusal…
    expect(recalled.status).toBe("ok");
    expect(value(store, "solid", "amount")).toBe(0.9);
    // …and nothing in the result lets a caller read a fade into it.
    const data = recalled.data as RecallPresetData;
    expect(data.transition).toBe("cut");
    expect(data.morphUnavailable).toBe(true);
    expect(data.record).toBeNull();
    expect(data.morph).toBeNull();
    // The command's own sentence rides along, untouched.
    expect(said(recalled)).toContain('Preset "dirty" asks for a 2 s morph, but no frame clock is attached here, so it was recalled as a cut.');
    // A recall that was ASKED to cut is a cut too, and is not the unavailable case.
    await surface.callTool("undo", {});
    const asked = (await surface.callTool("recall_preset", { nodeId: "fx", name: "dirty", morph: { seconds: 0, curve: "linear" } })).data as RecallPresetData;
    expect([asked.transition, asked.morphUnavailable]).toEqual(["cut", false]);
  });
});

describe("list_presets reports a running morph with its progress (T1502b)", () => {
  it("is halfway at half the duration, and gone when the fade has finished", async () => {
    const { surface, at } = session();
    at({ epoch: "show", absTimeSeconds: 5 });
    await surface.callTool("recall_preset", { nodeId: "fx", name: "dirty", morph: { seconds: 2, curve: "linear" } });

    at({ epoch: "show", absTimeSeconds: 6 });
    const mid = await banksOf(surface);
    expect(mid.clockSeconds).toBe(6);
    expect(mid.banks.find((bank) => bank.nodeId === "fx")?.morphs).toEqual([
      { preset: "dirty", start: 5, seconds: 2, curve: "linear", progress: 0.5, keys: ["solid1.amount"] },
    ]);
    // The other bank is not fading, and says so by being empty.
    expect(mid.banks.find((bank) => bank.nodeId === "looks")?.morphs).toEqual([]);
    // `current` is the destination from the moment of the recall, not when the fade ends.
    expect(mid.banks.find((bank) => bank.nodeId === "fx")?.current).toBe("dirty");

    at({ epoch: "show", absTimeSeconds: 7.5 });
    expect((await banksOf(surface)).banks.find((bank) => bank.nodeId === "fx")?.morphs).toEqual([]);
  });

  it("reports nothing fading on a surface with no transport, even with a record in the document", async () => {
    const { surface, at } = session();
    at({ epoch: "show", absTimeSeconds: 5 });
    await surface.callTool("recall_preset", { nodeId: "fx", name: "dirty", morph: { seconds: 2, curve: "linear" } });

    at(undefined);
    const headless = await banksOf(surface);
    expect(headless.clockSeconds).toBeNull();
    expect(headless.banks.flatMap((bank) => bank.morphs)).toEqual([]);
  });
});

describe("the cue list runs through the bus as the agent (T1502b)", () => {
  it("GO, GO, BACK, fire and standby each move the list and the look in one audited step", async () => {
    const { surface, store, at } = session();
    at({ epoch: "show", absTimeSeconds: 10 });
    const before = store.view.getAudit().length;

    expect(await listOf(surface)).toMatchObject({ name: "set", current: "", standby: "", next: "1" });
    expect((await listOf(surface)).cues.map((cue) => `${cue.name} ${cue.bank}/${cue.preset}`)).toEqual(["1 looks/a", "2 fx/dirty", "3 looks/b"]);

    const first = await surface.callTool("cue_go", { nodeId: "list" });
    expect(first.status, said(first).join("; ")).toBe("ok");
    expect(first.data as CueFireData).toMatchObject({ cue: "1", bank: "looks", preset: "a", current: "1", standby: "2", transition: "cut", record: null });
    expect(value(store, "blur", "radius")).toBe(10);

    // Cue 2 carries its own 2 s linear morph, over the preset's 9 s: the record is the cue's,
    // read back from the bank the cue NAMES.
    const second = (await surface.callTool("cue_go", { nodeId: "list" })).data as CueFireData;
    expect(second).toMatchObject({ cue: "2", current: "2", standby: "3", transition: "morph", morphUnavailable: false });
    expect(second.record).toEqual({ preset: "dirty", start: 10, seconds: 2, curve: "linear", progress: 0, keys: ["solid1.amount"] });
    expect(value(store, "solid", "amount")).toBe(0.9);
    // …and the list reports that fade as running.
    at({ epoch: "show", absTimeSeconds: 11 });
    expect((await listOf(surface)).morphs).toEqual([{ bank: "fx", preset: "dirty", start: 10, seconds: 2, curve: "linear", progress: 0.5 }]);

    const back = (await surface.callTool("cue_back", { nodeId: "list" })).data as CueFireData;
    expect(back).toMatchObject({ cue: "1", current: "1", standby: "2" });

    const fired = (await surface.callTool("cue_fire", { nodeId: "list", cue: "3" })).data as CueFireData;
    expect(fired).toMatchObject({ cue: "3", preset: "b", current: "3", standby: "" });
    expect(value(store, "blur", "radius")).toBe(20);

    const standby = await surface.callTool("set_cue_standby", { nodeId: "list", cue: "2" });
    expect(standby.status).toBe("ok");
    expect(standby.data).toEqual({ ok: true, current: "3", standby: "2" });
    expect(await listOf(surface)).toMatchObject({ current: "3", standby: "2", next: "2" });

    expect(auditSince(store, before)).toEqual([
      "cue.go applied agent:claude",
      "cue.go applied agent:claude",
      "cue.back applied agent:claude",
      "cue.fire applied agent:claude",
      "cue.setStandby applied agent:claude",
    ]);
  });

  it("headless, a cue with a morph is a cut and the GO says so", async () => {
    const { surface, store } = session();
    await surface.callTool("cue_go", { nodeId: "list" });
    const second = await surface.callTool("cue_go", { nodeId: "list" });
    expect(second.status).toBe("ok");
    expect(value(store, "solid", "amount")).toBe(0.9);
    expect(second.data as CueFireData).toMatchObject({ cue: "2", transition: "cut", morphUnavailable: true, record: null });
  });
});

describe("a refusal comes back as a tool result carrying the command's sentence (T1502b)", () => {
  it("names what is wrong, changes nothing, and is audited as the agent's rejected call", async () => {
    const { surface, store } = session();
    const revision = store.view.getRevision();
    const before = store.view.getAudit().length;

    const unknown = await surface.callTool("recall_preset", { nodeId: "looks", name: "nope" });
    expect(unknown.status).toBe("rejected");
    expect(said(unknown)).toEqual(['Bank "looks" has no preset "nope".']);
    expect((unknown.data as RecallPresetData).transition).toBe("none");

    const notABank = await surface.callTool("store_preset", { nodeId: "blur", name: "x" });
    expect(notABank.status).toBe("rejected");
    expect(said(notABank)).toEqual(['"blur1" is a test.blur node, not a Presets bank.']);

    const gone = await surface.callTool("delete_preset", { nodeId: "looks", name: "nope" });
    expect(gone.status).toBe("rejected");
    expect(said(gone)).toEqual(['Bank "looks" has no preset "nope"; nothing was deleted.']);
    expect(gone.data as PresetDeleteOutput).toEqual({ ok: false, preset: null, remaining: ["a", "b"] });

    const noCue = await surface.callTool("cue_fire", { nodeId: "list", cue: "9" });
    expect(noCue.status).toBe("rejected");
    expect(said(noCue)).toEqual(['Cue list "set": it has no cue "9"; nothing was fired.']);

    const noStandby = await surface.callTool("set_cue_standby", { nodeId: "list", cue: "9" });
    expect(noStandby.status).toBe("rejected");
    expect(said(noStandby)[0]).toContain("the standby was not moved");

    // BACK before anything fired has no previous cue: refused in the list's own words.
    const back = await surface.callTool("cue_back", { nodeId: "list" });
    expect(back.status).toBe("rejected");
    expect(said(back)[0]).toContain("nothing was fired");

    expect(store.view.getRevision()).toBe(revision);
    expect(auditSince(store, before)).toEqual([
      "preset.recall rejected agent:claude",
      "preset.store rejected agent:claude",
      "preset.delete rejected agent:claude",
      "cue.fire rejected agent:claude",
      "cue.setStandby rejected agent:claude",
      "cue.back rejected agent:claude",
    ]);
  });

  it("GO past the last cue is refused and the list stays on it", async () => {
    const { surface, store } = session();
    await surface.callTool("cue_fire", { nodeId: "list", cue: "3" });
    const past = await surface.callTool("cue_go", { nodeId: "list" });
    expect(past.status).toBe("rejected");
    expect(past.data as CueFireData).toMatchObject({ ok: false, current: "3", transition: "none", record: null });
    expect(value(store, "list", "current")).toBe("3");
    expect((await listOf(surface)).next).toBeNull();
  });

  it("an id that names no bank or no cue list is said, not answered with an empty list", async () => {
    const { surface } = session();
    const bank = await surface.callTool("list_presets", { nodeId: "blur" });
    expect([bank.status, bank.diagnostics[0]?.code]).toEqual(["error", "preset.bank.unknown"]);
    const list = await surface.callTool("list_cues", { nodeId: "looks" });
    expect([list.status, list.diagnostics[0]?.code]).toEqual(["error", "cue.list.unknown"]);
  });
});

describe("the nine tools on the surface (T1502b, §V38, §V39)", () => {
  it("are all available on a plain domain bus, ungated, and say which of them mutate", () => {
    const { surface } = session();
    const tools = surface
      .listTools()
      .filter((tool) => /preset|cue/.test(tool.name))
      .map((tool) => [tool.name, tool.kind, tool.mutates, tool.available, tool.capabilities]);
    expect(tools).toEqual([
      ["list_presets", "read", false, true, []],
      ["store_preset", "mutate", true, true, []],
      ["recall_preset", "mutate", true, true, []],
      ["delete_preset", "mutate", true, true, []],
      ["list_cues", "read", false, true, []],
      ["cue_go", "mutate", true, true, []],
      ["cue_back", "mutate", true, true, []],
      ["cue_fire", "mutate", true, true, []],
      ["set_cue_standby", "mutate", true, true, []],
    ]);
  });

  it("refuse a field the command does not take, at the boundary", async () => {
    const { surface, store } = session();
    const smuggled = await surface.callTool("recall_preset", { nodeId: "looks", name: "b", capabilities: ["export"] });
    expect(smuggled.status).toBe("error");
    const curve = await surface.callTool("recall_preset", { nodeId: "looks", name: "b", morph: { seconds: 1, curve: "bounce" } });
    expect(curve.status).toBe("error");
    expect(value(store, "blur", "radius")).toBe(4);
  });
});

/**
 * §T1557b / §B181's shape — list_presets reports the morph a plain recall WOULD use, and
 * reads the bank's Morph as the recall reads it: at this moment, through the read scope.
 * `bankView` used to resolve the bank with `{ channels }` alone, so `op('k1').chan.value`
 * on the bank's Morph had no cross-node reader, fell back to its retained static and the
 * listing said "a cut" while a recall (once fixed) would fade for 3 s. The bus is wired as
 * the app wires it: the channel resolver (`graphChannelResolver`, the backstop of the
 * app's ladder).
 */
describe("§T1557b — list_presets on a bank whose Morph is op('k1').chan.value (B181's shape)", () => {
  it("reports the channel's seconds, not the retained static", async () => {
    const { bus, store, surface } = session({
      nodes: [node("k1", "constant", "k1", { value: 3 })],
      looks: { morph: { mode: "expression", bindings: { static: { kind: "static", value: 0 }, expression: { kind: "expression", source: "op('k1').chan.value" } } } },
    });
    bus.attachChannelResolver(() => graphChannelResolver(store.view.getGraph(), registry));
    const { banks } = await banksOf(surface);
    const looks = banks.find((bank) => bank.nodeId === "looks");
    expect(looks?.presets.map((preset) => preset.morph)).toEqual([
      { seconds: 3, curve: "smooth" },
      { seconds: 3, curve: "smooth" },
    ]);
  });
});
