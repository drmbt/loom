import { describe, expect, it } from "vitest";

import type { GraphComponentDefinition } from "../types/components.ts";
import type { FrameClock } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { ProjectFile } from "../project/index.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { effectiveParameterSchema } from "../parameters/resolve.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import type { SystemClipboard } from "../commands/loom-clipboard.ts";
import { alice, bob, contextFor, patch } from "../commands/test-support.ts";
import { registerComponentCommands } from "../components/commands.ts";
import { componentNodeType } from "../components/component-type.ts";
import { createComponentSystem, type ComponentRegistry } from "../components/registry.ts";
import { COMPONENT_SESSION_STALE_CODE, openComponentSession } from "../components/session.ts";
import { createNodeRegistry, type NodeRegistryView } from "../../nodes/registry/registry.ts";
import { testNodeDefinitions } from "../../nodes/registry/test-nodes.ts";
import { cueListNode } from "../../nodes/definitions/cue-list.ts";
import { presetsNode } from "../../nodes/definitions/presets.ts";
import { serializePresetBank, parsePresetBank, type Preset } from "./bank.ts";
import { PRESET_CURRENT_KEY, PRESET_MORPHS_KEY, pageBankOf } from "./bank-view.ts";
import { serializeCueList, type Cue } from "./cue-list.ts";
import { parseMorphRecords } from "./morph.ts";
import { bankMorphRecords, buildMorphIndex } from "./morph-index.ts";
import { planTimelineCues } from "./timeline-cues.ts";

/**
 * T1505b — A LOOK'S PRESETS INSIDE ITS COMPONENT, through the real bus and the real
 * component system (`docs/presets-followups-design-2026-10-03.md` §1.5).
 *
 * THE LOOK every test runs: component `city`, publishing `blur` (→ an internal blur's
 * radius) and `amount` (→ an internal solid's amount), holding a PAGE BANK `looks` whose
 * Targets is `parent` and whose one preset `calm` is `{ parent: { blur: 2, amount: 0.25 } }`
 * — and, beside it, an INTERNAL bank `inner` targeting the internal blur, the authoring
 * tool the page bank must not be confused with. Two instances, `cityA` and `cityB`, sit in
 * the root graph. What is asserted is what a consumer reads back: the document, the
 * definition in the catalogue, the revision, the undo stack and the audit ring.
 */

const ctx = contextFor(alice);
const registry: NodeRegistryView = createNodeRegistry([...testNodeDefinitions, presetsNode, cueListNode]).view();

function node(id: NodeId, type: string, label: string, parameters: Record<string, StoredParameter> = {}, y = 0): GraphNode {
  return { id, type, label, definitionVersion: 1, position: { x: 0, y }, parameters };
}

const bankText = (presets: readonly Preset[]): string => serializePresetBank({ version: 1, presets });

const CALM: Preset = { name: "calm", values: { parent: { blur: 2, amount: 0.25 } } };

function city(presets: readonly Preset[] = [CALM], pageTargets = "parent"): GraphComponentDefinition {
  const nodes = [
    node("blurA", "test.blur", "blurA", { radius: 4 }),
    node("solid", "test.solid", "solid", { amount: 0.5 }, 100),
    node("looks", "presets", "looks", { targets: pageTargets, presets: bankText(presets) }, 200),
    node("inner", "presets", "inner", { targets: "blurA", presets: bankText([]) }, 300),
  ];
  return {
    componentId: "city",
    version: 1,
    name: "City",
    graph: { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "blurA", portId: "out" }],
    parameters: [
      { key: "blur", definition: { type: "number", label: "Blur", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "blurA", key: "radius" }] },
      { key: "amount", definition: { type: "number", label: "Amount", default: 0.5, min: 0, max: 1 }, targets: [{ nodeId: "solid", key: "amount" }] },
    ],
  };
}

const instance = (id: NodeId, label: string, parameters: Record<string, StoredParameter>, componentId = "city"): GraphNode => ({
  ...node(id, componentNodeType(componentId, 1), label, parameters),
});

interface Doc {
  readonly bus: LoomBus;
  readonly store: GraphStore;
  readonly components: ComponentRegistry;
  at(clock: FrameClock | undefined): void;
  graph(): GraphDocument;
}

interface DocOptions {
  readonly definitions?: readonly GraphComponentDefinition[];
  /** False: a bus with NO catalogue attached — the headless MCP twin's shape. */
  readonly catalogue?: boolean;
  readonly prefix?: string;
  readonly clipboard?: SystemClipboard;
  readonly writeFile?: (file: ProjectFile) => Promise<{ kind: "saved"; fileName: string }>;
}

function documentWith(nodes: readonly GraphNode[], options: DocOptions = {}): Doc {
  const initialGraph: GraphDocument = { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} };
  const store = createGraphStore({ ids: createSequentialIdFactory(options.prefix ?? "t"), now: () => "2026-10-03T00:00:00.000Z", initialGraph });
  const system = createComponentSystem(registry, options.definitions ?? [city()]);
  const { bus } = createDomainBus({ store, registry: system.nodes, ...(options.clipboard === undefined ? {} : { systemClipboard: options.clipboard }) });
  if (options.catalogue !== false) {
    registerComponentCommands(bus, { components: system.components, ...(options.writeFile === undefined ? {} : { writeFile: options.writeFile }) });
  }
  let clock: FrameClock | undefined;
  bus.attachFrameClock(() => clock);
  return {
    bus,
    store,
    components: system.components,
    at: (next) => {
      clock = next;
    },
    graph: () => store.view.getGraph(),
  };
}

const twoLooks = (): GraphNode[] => [instance("a", "cityA", { blur: 10, amount: 0.9 }), instance("b", "cityB", { blur: 30, amount: 0.75 })];

const param = (doc: Doc, nodeId: NodeId, key: string): StoredParameter | undefined => doc.graph().nodes[nodeId]?.parameters[key];

/** The page bank's presets as the CATALOGUE holds them now. */
function definitionPresets(components: ComponentRegistry, componentId = "city"): readonly Preset[] {
  const definition = components.get(componentId, 1);
  const bank = definition === undefined ? undefined : pageBankOf(definition);
  const parsed = parsePresetBank(bank?.parameters["presets"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.bank.presets;
}

const codes = (result: { diagnostics?: readonly { code: string }[] }): string[] => (result.diagnostics ?? []).map((each) => each.code);

describe("an instance IS the bank from outside: recall on cityA (T1505b §1.5)", () => {
  it("is one revision, one undo group, one audit entry — cityA's page and presetCurrent move, cityB is byte-identical", async () => {
    const doc = documentWith(twoLooks());
    const beforeB = JSON.stringify(doc.graph().nodes["b"]);
    const revision = doc.store.view.getRevision();
    const auditBefore = doc.store.view.getAudit().length;
    const undoBefore = doc.store.view.getHistory(alice).undo.length;

    const recalled = await doc.bus.execute("preset.recall", { nodeId: "a", name: "calm" }, ctx);
    expect(recalled.status, codes(recalled).join()).toBe("applied");
    expect(recalled.output.applied).toEqual(["cityA.amount", "cityA.blur"]);
    expect(param(doc, "a", "blur")).toBe(2);
    expect(param(doc, "a", "amount")).toBe(0.25);
    expect(param(doc, "a", PRESET_CURRENT_KEY)).toBe("calm");
    expect(JSON.stringify(doc.graph().nodes["b"])).toBe(beforeB);

    expect(doc.store.view.getRevision()).toBe(revision + 1);
    expect(doc.store.view.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.status])).toEqual([["preset.recall", "applied"]]);
    expect(doc.store.view.getHistory(alice).undo).toHaveLength(undoBefore + 1);

    await doc.bus.execute("graph.undo", {}, ctx);
    expect(param(doc, "a", "blur")).toBe(10);
    expect(param(doc, "a", "amount")).toBe(0.9);
    expect(param(doc, "a", PRESET_CURRENT_KEY)).toBeUndefined();
  });

  it("gives an instance of a page-banked component presetCurrent and presetMorphs on its page — and only that component", async () => {
    const plain = { ...city(), componentId: "plain", name: "Plain", graph: { ...city().graph, nodes: { blurA: city().graph.nodes["blurA"] as GraphNode, solid: city().graph.nodes["solid"] as GraphNode } } };
    const doc = documentWith([], { definitions: [city(), plain] });
    const pageOf = (componentId: string): string[] => Object.keys(effectiveParameterSchema(doc.bus.registry.get(componentNodeType(componentId, 1)), {}));
    const page = pageOf("city");
    expect(page).toEqual(["blur", "amount", PRESET_CURRENT_KEY, PRESET_MORPHS_KEY]);
    expect(pageOf("plain")).toEqual(["blur", "amount"]);
  });
});

describe("Store on an instance WRITES THE COMPONENT (owner's ruling)", () => {
  it("adds the preset, keyed parent, to the definition — the document does not move — and cityB recalls it", async () => {
    const doc = documentWith(twoLooks());
    await doc.bus.execute("preset.recall", { nodeId: "a", name: "calm" }, ctx);
    await doc.bus.execute("graph.applyPatch", patch(doc.store.view.getRevision(), [{ op: "setParameters", nodeId: "a", parameters: { blur: 50, amount: 0.6 } }]), contextFor(bob));
    const revision = doc.store.view.getRevision();
    const undoBefore = doc.store.view.getHistory(alice).undo.length;

    const stored = await doc.bus.execute("preset.store", { nodeId: "a", name: "riot" }, ctx);
    expect(stored.status, codes(stored).join()).toBe("applied");
    expect(stored.output).toEqual({ ok: true, preset: "riot", captured: 2, missing: [] });
    // Its own preset state is NOT part of the look: only the published page.
    expect(definitionPresets(doc.components)).toEqual([CALM, { name: "riot", values: { parent: { blur: 50, amount: 0.6 } } }]);
    // A component edit: no root revision, no root undo step, and the result says so.
    expect(doc.store.view.getRevision()).toBe(revision);
    expect(doc.store.view.getHistory(alice).undo).toHaveLength(undoBefore);
    expect(codes(stored)).toContain("preset.component.written");

    const onB = await doc.bus.execute("preset.recall", { nodeId: "b", name: "riot" }, ctx);
    expect(onB.status).toBe("applied");
    expect(param(doc, "b", "blur")).toBe(50);
    expect(param(doc, "b", "amount")).toBe(0.6);
    expect(param(doc, "b", PRESET_CURRENT_KEY)).toBe("riot");
    // cityA's own current is its own: Store did not touch it.
    expect(param(doc, "a", PRESET_CURRENT_KEY)).toBe("calm");
  });

  it("captures only the keys a parent.<key> page bank names", async () => {
    const doc = documentWith(twoLooks(), { definitions: [city([], "parent.blur")] });
    const stored = await doc.bus.execute("preset.store", { nodeId: "a", name: "soft" }, ctx);
    expect(stored.status).toBe("applied");
    expect(definitionPresets(doc.components)).toEqual([{ name: "soft", values: { parent: { blur: 10 } } }]);
  });

  it("Delete on an instance is the reverse: the preset leaves the component, and a cue naming another instance is warned about", async () => {
    const cues: Cue[] = [{ name: "c1", bank: "cityB", preset: "calm" }];
    const doc = documentWith([...twoLooks(), node("list", "cueList", "set", { cues: serializeCueList({ version: 1, cues }) })]);
    const revision = doc.store.view.getRevision();
    const deleted = await doc.bus.execute("preset.delete", { nodeId: "a", name: "calm" }, ctx);
    expect(deleted.status, codes(deleted).join()).toBe("applied");
    expect(deleted.output).toEqual({ ok: true, preset: "calm", remaining: [] });
    expect(definitionPresets(doc.components)).toEqual([]);
    expect(doc.store.view.getRevision()).toBe(revision);
    expect(codes(deleted)).toEqual(["preset.component.written", "preset.delete.cued"]);
  });
});

describe("a cue, a shot and a rename name the instance", () => {
  const SET: Cue[] = [{ name: "c1", bank: "cityA", preset: "calm" }];
  const list = (): GraphNode => node("list", "cueList", "set", { cues: serializeCueList({ version: 1, cues: SET }), standby: "c1" });

  it("GO on a cue {bank: cityA} recalls into cityA as ONE patch", async () => {
    const doc = documentWith([...twoLooks(), list()]);
    const revision = doc.store.view.getRevision();
    const auditBefore = doc.store.view.getAudit().length;
    const go = await doc.bus.execute("cue.go", { nodeId: "list" }, ctx);
    expect(go.status, codes(go).join()).toBe("applied");
    expect(param(doc, "a", "blur")).toBe(2);
    expect(param(doc, "a", PRESET_CURRENT_KEY)).toBe("calm");
    expect(param(doc, "list", "current")).toBe("c1");
    expect(doc.store.view.getRevision()).toBe(revision + 1);
    expect(doc.store.view.getAudit().slice(auditBefore).map((entry) => entry.command)).toEqual(["cue.go"]);
    await doc.bus.execute("graph.undo", {}, ctx);
    expect(param(doc, "a", "blur")).toBe(10);
    expect(param(doc, "list", "current")).toBeUndefined();
  });

  it("renaming cityA rewrites the cue, and GO still fires it", async () => {
    const doc = documentWith([...twoLooks(), list()]);
    const renamed = await doc.bus.execute("node.rename", { nodeId: "a", label: "downtown", exact: true }, ctx);
    expect(renamed.status).toBe("applied");
    expect(param(doc, "list", "cues")).toBe(serializeCueList({ version: 1, cues: [{ ...SET[0] as Cue, bank: "downtown" }] }));
    const go = await doc.bus.execute("cue.go", { nodeId: "list" }, ctx);
    expect(go.status).toBe("applied");
    expect(param(doc, "a", "blur")).toBe(2);
  });

  it("a shot that recalls cityA is one patch, and the shot's own values win", async () => {
    const shot: Preset = { name: "drop", values: { cityA: { blur: 60 } }, recalls: [{ bank: "cityA", preset: "calm" }] };
    const doc = documentWith([...twoLooks(), node("shots", "presets", "shots", { targets: "cityA", presets: bankText([shot]) })]);
    const revision = doc.store.view.getRevision();
    const fired = await doc.bus.execute("preset.recall", { nodeId: "shots", name: "drop" }, ctx);
    expect(fired.status, codes(fired).join()).toBe("applied");
    expect(param(doc, "a", "blur")).toBe(60);
    expect(param(doc, "a", "amount")).toBe(0.25);
    // The look the shot reached shows the preset it recalled, as a nested bank does.
    expect(param(doc, "a", PRESET_CURRENT_KEY)).toBe("calm");
    expect(param(doc, "shots", "current")).toBe("drop");
    expect(doc.store.view.getRevision()).toBe(revision + 1);
  });
});

describe("current and morphs are PER INSTANCE", () => {
  const LINEAR: { seconds: number; curve: "linear" } = { seconds: 1, curve: "linear" };

  it("a morph on cityA is a record on cityA keyed parent; cityB's recall leaves it alone", async () => {
    const doc = documentWith(twoLooks());
    doc.at({ epoch: "e1", absTimeSeconds: 0 });
    await doc.bus.execute("preset.recall", { nodeId: "a", name: "calm", morph: LINEAR }, ctx);
    const recordsA = parseMorphRecords(param(doc, "a", PRESET_MORPHS_KEY));
    expect(recordsA.map((record) => [record.preset, record.from, record.to])).toEqual([
      ["calm", { parent: { amount: 0.9, blur: 10 } }, { parent: { amount: 0.25, blur: 2 } }],
    ]);
    expect(param(doc, "b", PRESET_MORPHS_KEY)).toBeUndefined();

    doc.at({ epoch: "e1", absTimeSeconds: 0.25 });
    await doc.bus.execute("preset.recall", { nodeId: "b", name: "calm", morph: LINEAR }, ctx);
    expect(parseMorphRecords(param(doc, "a", PRESET_MORPHS_KEY))).toEqual(recordsA);
    expect(parseMorphRecords(param(doc, "b", PRESET_MORPHS_KEY)).map((record) => record.start)).toEqual([0.25]);
    expect(param(doc, "a", PRESET_CURRENT_KEY)).toBe("calm");
    expect(param(doc, "b", PRESET_CURRENT_KEY)).toBe("calm");

    // The morph index reads the instance's record under its NAME — the fade on cityA.blur
    // is half-way at 0.5 s, and cityB's is a quarter in.
    const index = buildMorphIndex({ document: doc.graph(), registry: doc.bus.registry });
    const halfA = index.stepsAt("a", "blur", { absEpoch: "e1", absTimeSeconds: 0.5 } as never);
    expect(halfA?.map((step) => [step.from, step.to, step.progress])).toEqual([[10, 2, 0.5]]);
    expect(index.stepsAt("b", "blur", { absEpoch: "e1", absTimeSeconds: 0.5 } as never)?.map((step) => step.progress)).toEqual([0.25]);
  });

  it("a shot's record (on a root bank, keyed cityA) and the look's own record (keyed parent) form ONE chain", async () => {
    const shot: Preset = { name: "drop", values: { cityA: { blur: 40 } } };
    const doc = documentWith([...twoLooks(), node("shots", "presets", "shots", { targets: "cityA", presets: bankText([shot]) })]);
    doc.at({ epoch: "e1", absTimeSeconds: 0 });
    await doc.bus.execute("preset.recall", { nodeId: "shots", name: "drop", morph: LINEAR }, ctx);
    doc.at({ epoch: "e1", absTimeSeconds: 0.5 });
    await doc.bus.execute("preset.recall", { nodeId: "a", name: "calm", morph: LINEAR }, ctx);
    expect(bankMorphRecords(doc.graph()).map((bank) => [bank.bankId, bank.records.map((record) => Object.keys(record.to))])).toEqual([
      ["a", [["cityA"]]],
      ["shots", [["cityA"]]],
    ]);
    const index = buildMorphIndex({ document: doc.graph(), registry: doc.bus.registry });
    // At 1.0 s the shot has arrived; at 0.75 s both links are still running — the second
    // continues from what the first left on screen.
    const steps = index.stepsAt("a", "blur", { absEpoch: "e1", absTimeSeconds: 0.75 } as never);
    expect(steps?.map((step) => [step.from, step.to, step.progress])).toEqual([
      [10, 40, 0.75],
      [40, 2, 0.25],
    ]);
  });
});

describe("refused by name", () => {
  it("a bus with no component catalogue (the headless MCP twin) refuses an instance bank: recall, store and a cue", async () => {
    const cues: Cue[] = [{ name: "c1", bank: "cityA", preset: "calm" }];
    const doc = documentWith([...twoLooks(), node("list", "cueList", "set", { cues: serializeCueList({ version: 1, cues }), standby: "c1" })], { catalogue: false });
    const before = doc.graph();
    for (const [command, input] of [
      ["preset.recall", { nodeId: "a", name: "calm" }],
      ["preset.store", { nodeId: "a", name: "x" }],
      ["cue.go", { nodeId: "list" }],
    ] as const) {
      const result = await doc.bus.execute(command, input, ctx);
      expect(result.status, command).toBe("rejected");
      expect(codes(result), command).toEqual(["preset.bank.noCatalogue"]);
    }
    expect(doc.graph()).toBe(before);
  });

  it("an instance whose component holds no page bank is refused, naming why", async () => {
    const internalOnly = city([], "blurA");
    const doc = documentWith(twoLooks(), { definitions: [internalOnly] });
    const result = await doc.bus.execute("preset.recall", { nodeId: "a", name: "calm" }, ctx);
    expect(codes(result)).toEqual(["preset.bank.noPageBank"]);
  });

  it("a NESTED instance (a look inside another component) is refused by name", async () => {
    const outer: GraphComponentDefinition = {
      componentId: "outer",
      version: 1,
      name: "Outer",
      graph: { revision: 0, nodes: { inner: instance("inner", "cityIn", {}) }, edges: {}, groups: {} },
      inputs: [],
      outputs: [],
      parameters: [],
    };
    const doc = documentWith([instance("o", "outer1", {}, "outer")], { definitions: [city(), outer] });
    const result = await doc.bus.execute("preset.recall", { nodeId: "o/inner", name: "calm" }, ctx);
    expect(result.status).toBe("rejected");
    expect(codes(result)).toEqual(["preset.bank.nested"]);
  });

  it("inside the definition session, Store and Recall on the PAGE bank are refused — the internal bank still stores and recalls with session undo", async () => {
    const doc = documentWith(twoLooks());
    const session = openComponentSession({ components: doc.components, nodes: doc.bus.registry, componentId: "city", version: 1 });
    try {
      for (const command of ["preset.store", "preset.recall"] as const) {
        const result = await session.bus.execute(command, { nodeId: "looks", name: "calm" }, ctx);
        expect(result.status, command).toBe("rejected");
        expect(codes(result), command).toEqual(["preset.bank.inDefinition"]);
      }
      // THE LEGITIMATE CASE THE GUARD COULD SWALLOW: a bank targeting an internal node.
      const stored = await session.bus.execute("preset.store", { nodeId: "inner", name: "wide" }, ctx);
      expect(stored.status, codes(stored).join()).toBe("applied");
      await session.bus.execute("graph.applyPatch", patch(session.store.view.getRevision(), [{ op: "setParameters", nodeId: "blurA", parameters: { radius: 33 } }]), ctx);
      const recalled = await session.bus.execute("preset.recall", { nodeId: "inner", name: "wide" }, ctx);
      expect(recalled.status).toBe("applied");
      expect(session.store.view.getGraph().nodes["blurA"]?.parameters["radius"]).toBe(4);
      await session.bus.execute("graph.undo", {}, ctx);
      expect(session.store.view.getGraph().nodes["blurA"]?.parameters["radius"]).toBe(33);
      // …and the session's commits reach the catalogue, as every definition edit does.
      expect(doc.components.get("city", 1)?.graph.nodes["blurA"]?.parameters["radius"]).toBe(33);
    } finally {
      session.dispose();
    }
  });

  /*
   * §T1540b (b) — the backstop under the editor's rebase. A session still open over `city`
   * when a Store on an instance writes `city` holds the graph from before the Store; its
   * next commit, however unrelated, would register that graph and drop the preset. It must
   * say so once (`onStale`) and refuse to write back, by name — and must NOT go stale on
   * what the session itself writes (an edit, a publish), the legitimate cases the guard
   * could swallow.
   */
  it("an open definition session goes stale on an outside Store and refuses to write its old graph over it", async () => {
    const doc = documentWith(twoLooks());
    const stale: string[] = [];
    const refused: string[] = [];
    const session = openComponentSession({
      components: doc.components,
      nodes: doc.bus.registry,
      componentId: "city",
      version: 1,
      onStale: (each) => stale.push(each.code),
      onInvalid: (each) => refused.push(...each.map((diagnostic) => diagnostic.code)),
    });
    const presetNames = (): string[] => {
      const parsed = parsePresetBank(doc.components.get("city", 1)?.graph.nodes["looks"]?.parameters["presets"]);
      return parsed.ok ? parsed.bank.presets.map((preset) => preset.name) : [];
    };
    try {
      // The session's own writes keep it current: an edit, and a host command.
      await session.bus.execute("node.rename", { nodeId: "solid", label: "base", exact: true }, ctx);
      const published = await session.bus.execute(
        "component.publishParameter",
        { key: "inner_radius", definition: { type: "number", label: "R", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "blurA", key: "radius" }] },
        ctx,
      );
      expect(published.status, codes(published).join()).toBe("applied");
      await session.bus.execute("node.rename", { nodeId: "inner", label: "inner2", exact: true }, ctx);
      expect(doc.components.get("city", 1)?.graph.nodes["inner"]?.label).toBe("inner2");
      expect(stale).toEqual([]);

      const stored = await doc.bus.execute("preset.store", { nodeId: "a", name: "riot" }, ctx);
      expect(stored.status, codes(stored).join()).toBe("applied");
      expect(stale).toEqual([COMPONENT_SESSION_STALE_CODE]);

      // The stale session's next commit — nothing to do with the bank — is not written.
      await session.bus.execute("node.rename", { nodeId: "blurA", label: "softened", exact: true }, ctx);
      expect(refused).toEqual([COMPONENT_SESSION_STALE_CODE]);
      expect(presetNames()).toEqual(["calm", "riot"]);
      expect(doc.components.get("city", 1)?.graph.nodes["blurA"]?.label).toBe("blurA");
      // Nor does an undo inside it reach back across the Store.
      await session.bus.execute("graph.undo", {}, ctx);
      expect(presetNames()).toEqual(["calm", "riot"]);
      expect(stale).toEqual([COMPONENT_SESSION_STALE_CODE]);
    } finally {
      session.dispose();
    }
  });

  it("publishing presetCurrent or presetMorphs is refused; a second page bank is a warning naming both", async () => {
    const doc = documentWith([]);
    const reserved = doc.components.validate({
      ...city(),
      parameters: [...city().parameters, { key: PRESET_CURRENT_KEY, definition: { type: "string", label: "x", default: "" }, targets: [] }],
    });
    expect(reserved.filter((each) => each.severity === "error").map((each) => each.code)).toEqual(["component.parameter.reserved"]);
    const two = city();
    const second = node("looks2", "presets", "looks2", { targets: "parent.blur", presets: bankText([]) }, 400);
    const warned = doc.components.validate({ ...two, graph: { ...two.graph, nodes: { ...two.graph.nodes, looks2: second } } });
    expect(warned.find((each) => each.code === "component.presets.twoPageBanks")?.message).toContain('"looks", "looks2"');
  });
});

describe("the presets travel with the component", () => {
  it("export → import into a fresh document → recall on the new instance applies the stored preset", async () => {
    const written: ProjectFile[] = [];
    const source = documentWith(twoLooks(), {
      writeFile: async (file) => {
        written.push(file);
        return { kind: "saved", fileName: file.fileName };
      },
    });
    await source.bus.execute("graph.applyPatch", patch(source.store.view.getRevision(), [{ op: "setParameters", nodeId: "a", parameters: { blur: 44 } }]), ctx);
    expect((await source.bus.execute("preset.store", { nodeId: "a", name: "riot" }, ctx)).status).toBe("applied");
    const exported = await source.bus.execute("component.export", { componentId: "city" }, ctx);
    expect(exported.status, codes(exported).join()).toBe("applied");

    const target = documentWith([], { definitions: [], prefix: "z" });
    const imported = await target.bus.execute("component.import", { text: written[0]?.text ?? "" }, ctx);
    expect(imported.status, codes(imported).join()).toBe("applied");
    const placed = imported.output.nodeId as NodeId;
    await target.bus.execute("node.rename", { nodeId: placed, label: "newCity", exact: true }, ctx);
    const recalled = await target.bus.execute("preset.recall", { nodeId: placed, name: "riot" }, ctx);
    expect(recalled.status, codes(recalled).join()).toBe("applied");
    expect(target.graph().nodes[placed]?.parameters["blur"]).toBe(44);
  });

  it("a cross-document paste carries the bank and the instance's own state", async () => {
    const clip = { text: null as string | null, loom: null as string | null };
    const clipboard: SystemClipboard = {
      write(text: string, loom?: string) {
        clip.text = text;
        clip.loom = loom ?? null;
      },
      read: async () => ({ text: clip.text, loom: clip.loom }),
    };
    const a = documentWith(twoLooks(), { clipboard, prefix: "a" });
    await a.bus.execute("preset.recall", { nodeId: "a", name: "calm" }, ctx);
    await a.bus.execute("graph.copySelection", { nodeIds: ["a"] }, ctx);

    const b = documentWith([], { definitions: [], clipboard, prefix: "b" });
    const pasted = await b.bus.execute("graph.paste", {}, ctx);
    expect(pasted.status, codes(pasted).join()).toBe("applied");
    const copy = Object.values(b.graph().nodes).find((each) => each.label === "cityA");
    expect(copy?.parameters[PRESET_CURRENT_KEY]).toBe("calm");
    expect(definitionPresets(b.components)).toEqual([CALM]);
    await b.bus.execute("graph.applyPatch", patch(b.store.view.getRevision(), [{ op: "setParameters", nodeId: copy?.id as NodeId, parameters: { blur: 9 } }]), ctx);
    const recalled = await b.bus.execute("preset.recall", { nodeId: copy?.id as NodeId, name: "calm" }, ctx);
    expect(recalled.status).toBe("applied");
    expect(b.graph().nodes[copy?.id as NodeId]?.parameters["blur"]).toBe(2);
  });
});

describe("preset.moveIntoComponent — explicit, never automatic (§1.2 Q8)", () => {
  const beside = (presets: readonly Preset[], targets = "cityA"): GraphNode =>
    node("bank", "presets", "beside", { targets, presets: bankText(presets), current: "warm", morph: 2 });
  const WARM: Preset = { name: "warm", values: { cityA: { blur: 7, amount: 0.3 } } };

  it("moves the presets into the component as one root patch: the bank goes, the instance holds its state, cues and shots name the instance", async () => {
    const cues: Cue[] = [{ name: "c1", bank: "beside", preset: "warm" }];
    const shot: Preset = { name: "drop", values: {}, recalls: [{ bank: "beside", preset: "warm" }] };
    const doc = documentWith([
      ...twoLooks(),
      beside([WARM]),
      node("list", "cueList", "set", { cues: serializeCueList({ version: 1, cues }), standby: "c1" }),
      node("shots", "presets", "shots", { targets: "", presets: bankText([shot]) }),
    ], { definitions: [city([])] });
    const revision = doc.store.view.getRevision();
    const moved = await doc.bus.execute("preset.moveIntoComponent", { nodeId: "bank" }, ctx);
    expect(moved.status, codes(moved).join()).toBe("applied");
    expect(moved.output).toEqual({ ok: true, instance: "a", moved: ["warm"] });
    expect(definitionPresets(doc.components)).toEqual([{ name: "warm", values: { parent: { blur: 7, amount: 0.3 } } }]);
    expect(doc.graph().nodes["bank"]).toBeUndefined();
    expect(param(doc, "a", PRESET_CURRENT_KEY)).toBe("warm");
    expect(parseCueListBank(param(doc, "list", "cues"))).toEqual(["cityA"]);
    const shots = parsePresetBank(param(doc, "shots", "presets"));
    expect(shots.ok ? shots.bank.presets[0]?.recalls : null).toEqual([{ bank: "cityA", preset: "warm" }]);
    expect(doc.store.view.getRevision()).toBe(revision + 1);

    // The cue fires into the look now.
    const go = await doc.bus.execute("cue.go", { nodeId: "list" }, ctx);
    expect(go.status, codes(go).join()).toBe("applied");
    expect(param(doc, "a", "blur")).toBe(7);
    await doc.bus.execute("graph.undo", {}, ctx);

    // Undo of the move brings the bank back; the component keeps its copy.
    await doc.bus.execute("graph.undo", {}, ctx);
    expect(doc.graph().nodes["bank"]?.label).toBe("beside");
    expect(parseCueListBank(param(doc, "list", "cues"))).toEqual(["beside"]);
    expect(definitionPresets(doc.components).map((preset) => preset.name)).toEqual(["warm"]);
  });

  it("merges by name into the page bank the component already has, and refuses a clash", async () => {
    const doc = documentWith([...twoLooks(), beside([WARM])]);
    const moved = await doc.bus.execute("preset.moveIntoComponent", { nodeId: "bank" }, ctx);
    expect(moved.status).toBe("applied");
    expect(definitionPresets(doc.components).map((preset) => preset.name)).toEqual(["calm", "warm"]);

    const clash = documentWith([...twoLooks(), beside([{ ...WARM, name: "calm" }])]);
    const refused = await clash.bus.execute("preset.moveIntoComponent", { nodeId: "bank" }, ctx);
    expect(codes(refused)).toEqual(["preset.move.clash"]);
    expect(clash.graph().nodes["bank"]).toBeDefined();
  });

  it("refuses a bank that reaches more than one look, naming what would stay beside", async () => {
    const doc = documentWith([...twoLooks(), beside([{ name: "both", values: { cityA: { blur: 1 }, cityB: { blur: 2 } } }], "cityA cityB")]);
    const refused = await doc.bus.execute("preset.moveIntoComponent", { nodeId: "bank" }, ctx);
    expect(refused.status).toBe("rejected");
    expect(codes(refused)).toEqual(["preset.move.notOneLook"]);
    expect(refused.diagnostics[0]?.message).toContain('"cityA", "cityB"');
  });

  it("refuses with no catalogue", async () => {
    const doc = documentWith([...twoLooks(), beside([WARM])], { catalogue: false });
    expect(codes(await doc.bus.execute("preset.moveIntoComponent", { nodeId: "bank" }, ctx))).toEqual(["preset.bank.noCatalogue"]);
  });
});

function parseCueListBank(text: unknown): string[] {
  const raw = JSON.parse(String(text)) as { cues: Array<{ bank: string }> };
  return raw.cues.map((cue) => cue.bank);
}

/**
 * T1541b — A TIMED CUE NAMING A LOOK'S INSTANCE. The timeline plans it through the same
 * catalogue GO reads (`bankOf`), so `cue.list` reports no skip for it where the catalogue is
 * attached, and — on the headless twin with none — names why it is skipped rather than
 * calling the instance "not a Presets bank". The pixels are `preset-morph.gpu.test.ts`.
 */
describe("T1541b — a timed cue names a look's instance", () => {
  const timed = (): GraphNode =>
    node("show", "cueList", "show", {
      follow: "timeline",
      cues: serializeCueList({ version: 1, cues: [{ name: "A", bank: "cityA", preset: "calm", at: 1 }] }),
    }, 400);

  it("cue.list warns nothing about it with the catalogue, and names the missing catalogue without one", async () => {
    const withCatalogue = documentWith([...twoLooks(), timed()]);
    const listed = await withCatalogue.bus.query("cue.list", { nodeId: "show" }, ctx);
    expect(listed.lists[0]?.warnings).toEqual([]);

    const bare = documentWith([...twoLooks(), timed()], { catalogue: false });
    const warned = (await bare.bus.query("cue.list", { nodeId: "show" }, ctx)).lists[0]?.warnings ?? [];
    expect(warned).toEqual([
      'Cue "A" (show): "cityA" is a component instance, and this surface has no component catalogue to read its presets from; the timeline skips it.',
    ]);
  });

  it("the morph index the flattening builds folds the cue onto the instance's page from its frame on", () => {
    const doc = documentWith([...twoLooks(), timed()]);
    const graph = doc.graph();
    const plain = buildMorphIndex({ document: graph, registry: doc.bus.registry });
    const timedIndex = buildMorphIndex({ document: graph, registry: doc.bus.registry, components: doc.components });
    // Without the catalogue the cue covers nothing; with it, cityA's published page.
    expect(plain.keysOf("a")).toBeUndefined();
    expect([...(timedIndex.keysOf("a") ?? [])].sort()).toEqual(["amount", "blur"]);
    expect(timedIndex.keysOf("b")).toBeUndefined();
    const frame = { frameIndex: 30, timeSeconds: 1, fps: 30 } as Parameters<typeof timedIndex.stepsAt>[2];
    expect(timedIndex.stepsAt("a", "blur", frame)?.at(-1)?.to).toBe(2);
    expect(timedIndex.stepsAt("a", "amount", frame)?.at(-1)?.to).toBe(0.25);
  });
});

/**
 * §T1559b (2) — A PAGE BANK WHOSE MORPH IS DRIVEN, under a timed list. A ROOT bank in that
 * state is warned about (`cue.timeline.drivenMorph`, `compiler/timeline-cue-problems.test.ts`),
 * because its timed cues read the Morph stored while GO reads it live. An instance's settings
 * are its definition's page bank's, and GO reads those stored as well (`bankSettings`): the
 * two doors agree, so there is nothing to say. Both halves are held here — the second is
 * only right while the first is.
 */
describe("§T1559b (2) — a page bank whose Morph is driven", () => {
  /** Morph `time + 3`: 3 s as the document says it (the zero frame), 8 s at the frame attached below. */
  const drivenCity = (): GraphComponentDefinition => {
    const base = city();
    const looks = base.graph.nodes["looks"] as GraphNode;
    const morph: StoredParameter = {
      mode: "expression",
      bindings: { static: { kind: "static", value: 9 }, expression: { kind: "expression", source: "time + 3" } },
    };
    return { ...base, graph: { ...base.graph, nodes: { ...base.graph.nodes, looks: { ...looks, parameters: { ...looks.parameters, morph } } } } };
  };
  const show = (follow: "live" | "timeline"): GraphNode =>
    node("show", "cueList", "show", {
      follow,
      cues: serializeCueList({ version: 1, cues: [{ name: "A", bank: "cityA", preset: "calm", ...(follow === "timeline" ? { at: 1 } : {}) }] }),
    }, 400);

  it("GO on the instance fades for the STORED 3 s, with a frame attached at which the expression says 8", async () => {
    const doc = documentWith([...twoLooks(), show("live")], { definitions: [drivenCity()] });
    doc.bus.attachFrame(() => ({ timeSeconds: 5, deltaSeconds: 1 / 30, frameIndex: 150, mode: "realtime", randomSeed: 0 }));
    doc.at({ epoch: "e1", absTimeSeconds: 5 });
    const go = await doc.bus.execute("cue.go", { nodeId: "show" }, ctx);
    expect(go.status, codes(go).join()).toBe("applied");
    expect(parseMorphRecords(param(doc, "a", PRESET_MORPHS_KEY)).map((record) => record.seconds)).toEqual([3]);
  });

  it("so a timed list firing it warns nothing", async () => {
    const doc = documentWith([...twoLooks(), show("timeline")], { definitions: [drivenCity()] });
    expect((await doc.bus.query("cue.list", { nodeId: "show" }, ctx)).lists[0]?.warnings).toEqual([]);
    expect(planTimelineCues(doc.graph(), doc.bus.registry, doc.components).warnings).toEqual([]);
  });
});

/**
 * T1541b — `preset.recall` NAMED BY A FLAT ID, as a Recall pulse fired inside a look names
 * it (`city/looks`): the page bank's id under a ROOT instance is that instance's recall. The
 * internal authoring bank (`inner`) is not the page bank and stays refused; so does a deeper
 * path. The app-level pulse path (watcher → `parameter.pulse` → here) is `pulse-firing.test.tsx`.
 */
describe("T1541b — a recall named by the page bank's flat id is the instance's", () => {
  it("cityA/looks recalls on cityA, one patch; cityA/inner and a/x/looks are refused by name", async () => {
    const doc = documentWith(twoLooks());
    const beforeB = JSON.stringify(doc.graph().nodes["b"]);
    const undoBefore = doc.store.view.getHistory(alice).undo.length;

    const recalled = await doc.bus.execute("preset.recall", { nodeId: "a/looks", name: "calm" }, ctx);
    expect(recalled.status).toBe("applied");
    expect(param(doc, "a", "blur")).toBe(2);
    expect(param(doc, "a", "amount")).toBe(0.25);
    expect(param(doc, "a", PRESET_CURRENT_KEY)).toBe("calm");
    expect(JSON.stringify(doc.graph().nodes["b"])).toBe(beforeB);
    expect(doc.store.view.getHistory(alice).undo.length).toBe(undoBefore + 1);

    const revision = doc.store.view.getRevision();
    // §T1695b: an INNER bank named from a running instance (an expression on its Recall
    // pulse) has its own refusal, which says why: what it writes is the component's.
    const inner = await doc.bus.execute("preset.recall", { nodeId: "a/inner", name: "calm" }, ctx);
    expect(codes(inner)).toEqual(["preset.bank.inner"]);
    expect(inner.diagnostics[0]?.message).toContain("the same for every instance");
    expect(codes(await doc.bus.execute("preset.recall", { nodeId: "a/x/looks", name: "calm" }, ctx))).toEqual(["preset.bank.nested"]);
    expect(doc.store.view.getRevision()).toBe(revision);
  });
});

/**
 * T1541b — DETACHING A LOOK REWRITES ITS PAGE BANK (the design doc §1.2 Q7). The copy of
 * `looks` would target `parent`, which names nothing at the root; detach points it at the
 * internal parameters the page drove instead — by the copies' names, after detach's own
 * renames — and carries cityA's current preset and running fade. When that cannot be exact
 * it is left alone and a warning names it as inert, and why.
 */
describe("T1541b — detaching a look's instance rewrites its page bank", () => {
  const byLabel = (doc: Doc, label: string): GraphNode | undefined => Object.values(doc.graph().nodes).find((each) => each.label === label);

  it("targets the copies by name, carries the presets, cityA's current and its fade — and a recall on it sets the copies", async () => {
    // A root `solid` already exists, so the look's own `solid` lands renamed.
    const doc = documentWith([...twoLooks(), node("rootSolid", "test.solid", "solid", { amount: 0.1 }, 600)]);
    doc.at({ epoch: "e1", absTimeSeconds: 0 });
    expect((await doc.bus.execute("preset.recall", { nodeId: "a", name: "calm", morph: { seconds: 1, curve: "linear" } }, ctx)).status).toBe("applied");
    const definitionBefore = JSON.stringify(doc.components.get("city", 1));

    const detached = await doc.bus.execute("component.detach", { nodeId: "a" }, ctx);
    expect(detached.status).toBe("applied");
    expect(codes(detached)).toContain("component.detach.pageBank");

    const bank = byLabel(doc, "looks");
    const copiedSolid = Object.values(doc.graph().nodes).find((each) => each.type === "test.solid" && each.id !== "rootSolid");
    expect(copiedSolid?.label).toBe("solid1");
    expect(bank?.parameters["targets"]).toBe("blurA.radius solid1.amount");
    expect(parsePresetBank(bank?.parameters["presets"])).toEqual({
      ok: true,
      bank: { version: 1, presets: [{ name: "calm", values: { blurA: { radius: 2 }, solid1: { amount: 0.25 } } }] },
    });
    expect(bank?.parameters["current"]).toBe("calm");
    const [record] = parseMorphRecords(bank?.parameters["morphs"]);
    expect(record?.from).toEqual({ blurA: { radius: 10 }, solid1: { amount: 0.9 } });
    expect(record?.to).toEqual({ blurA: { radius: 2 }, solid1: { amount: 0.25 } });
    // The internal authoring bank is not a page bank: copied as it was.
    expect(byLabel(doc, "inner")?.parameters["targets"]).toBe("blurA");
    // The component and the other instance are untouched.
    expect(JSON.stringify(doc.components.get("city", 1))).toBe(definitionBefore);
    expect(param(doc, "b", "blur")).toBe(30);

    // The rewritten bank WORKS: a recall sets the copies, not the root `solid`.
    const blurCopy = byLabel(doc, "blurA");
    const nudged = await doc.bus.execute("graph.applyPatch", patch(doc.store.view.getRevision(), [{ op: "setParameters", nodeId: blurCopy!.id, parameters: { radius: 7 } }]), ctx);
    expect(nudged.status).toBe("applied");
    expect((await doc.bus.execute("preset.recall", { nodeId: bank!.id, name: "calm" }, ctx)).status).toBe("applied");
    expect(byLabel(doc, "blurA")?.parameters["radius"]).toBe(2);
    expect(byLabel(doc, "solid1")?.parameters["amount"]).toBe(0.25);
    expect(doc.graph().nodes["rootSolid"]?.parameters["amount"]).toBe(0.1);
  });

  /**
   * B238 — the carried fade only survives if the copies STORE the value the fade is heading
   * to. The morph index's edit rule drops a chain whose key no longer holds the newest
   * record's `to`, and detach used to write the definition's radius 4 where cityA's page
   * said 2 — so the rewritten bank kept a record nothing would ever play.
   */
  it("B238: the fade it carries is still indexed on the copies — they store the value it is heading to", async () => {
    const doc = documentWith(twoLooks());
    doc.at({ epoch: "e1", absTimeSeconds: 0 });
    expect((await doc.bus.execute("preset.recall", { nodeId: "a", name: "calm", morph: { seconds: 1, curve: "linear" } }, ctx)).status).toBe("applied");
    expect((await doc.bus.execute("component.detach", { nodeId: "a" }, ctx)).status).toBe("applied");

    const blurCopy = byLabel(doc, "blurA");
    const solidCopy = byLabel(doc, "solid");
    expect(blurCopy?.parameters["radius"]).toBe(2);
    expect(solidCopy?.parameters["amount"]).toBe(0.25);
    const index = buildMorphIndex({ document: doc.graph(), registry: doc.bus.registry });
    const half = { absEpoch: "e1", absTimeSeconds: 0.5 } as never;
    expect(index.stepsAt(blurCopy!.id, "radius", half)?.map((step) => [step.from, step.to, step.progress])).toEqual([[10, 2, 0.5]]);
    expect(index.stepsAt(solidCopy!.id, "amount", half)?.map((step) => [step.from, step.to, step.progress])).toEqual([[0.9, 0.25, 0.5]]);
  });

  /**
   * T1545b — a DETACHED INSTANTIATE is a detach of a fresh instance, so its page bank is
   * rewritten the same way. It used to land targeting `parent`, which names nothing at the
   * root: a recall on it did nothing. A fresh instance has no current preset or fade.
   */
  it("T1545b: a detached instantiate rewrites the page bank too — targets the copies, and a recall on it sets them", async () => {
    const doc = documentWith([]);
    const made = await doc.bus.execute("component.instantiate", { componentId: "city", mode: "detached" }, ctx);
    expect(made.status).toBe("applied");
    expect(codes(made)).toContain("component.detach.pageBank");
    const bank = byLabel(doc, "looks");
    expect(bank?.parameters["targets"]).toBe("blurA.radius solid.amount");
    expect(parsePresetBank(bank?.parameters["presets"])).toEqual({
      ok: true,
      bank: { version: 1, presets: [{ name: "calm", values: { blurA: { radius: 2 }, solid: { amount: 0.25 } } }] },
    });
    expect(bank?.parameters["current"]).toBe("");
    expect(parseMorphRecords(bank?.parameters["morphs"])).toEqual([]);
    // The copies hold the published defaults (B239); a recall moves them.
    expect(byLabel(doc, "blurA")?.parameters["radius"]).toBe(4);
    expect((await doc.bus.execute("preset.recall", { nodeId: bank!.id, name: "calm" }, ctx)).status).toBe("applied");
    expect(byLabel(doc, "blurA")?.parameters["radius"]).toBe(2);
    expect(byLabel(doc, "solid")?.parameters["amount"]).toBe(0.25);
  });

  it("cannot be exact when a preset holds a key the page does not publish: left as it was, and named as inert", async () => {
    const odd: Preset = { name: "odd", values: { parent: { blur: 3, glow: 1 } } };
    const doc = documentWith(twoLooks(), { definitions: [city([CALM, odd])] });
    const detached = await doc.bus.execute("component.detach", { nodeId: "a" }, ctx);
    expect(detached.status).toBe("applied");
    const inert = detached.diagnostics.find((each) => each.code === "component.detach.pageBankInert");
    expect(inert?.severity).toBe("warning");
    expect(inert?.message).toContain('Preset bank "looks"');
    expect(inert?.message).toContain('"glow" is not a published parameter of the component');
    expect(codes(detached)).not.toContain("component.detach.pageBank");
    expect(byLabel(doc, "looks")?.parameters["targets"]).toBe("parent");
  });
});

/**
 * T1541b × §T1537b × §T1544b — a timed cue naming a look's instance feeds the same planner
 * the structure is built from: a STRUCTURAL key on the look's page (a compile-time Source,
 * here) is filed as structure — its published fan-out is followed (§T1544b) — with no
 * warning, while the look's ordinary keys still fade on the timeline. (The warning kept for
 * an unreadable definition is held in `timeline-cues.test.ts`: without a catalogue a cue
 * naming an instance as its bank is skipped before any key is read.)
 */
describe("T1541b — a timed cue on a look with a structural key on its page", () => {
  function glyph(): GraphComponentDefinition {
    const presets = bankText([{ name: "lit", values: { parent: { code: "fn x() {}", gain: 0.75 } } }]);
    const nodes = [
      node("shader", "test.customWgsl", "shader", { source: "", amount: 1 }),
      node("looks", "presets", "looks", { targets: "parent", presets }, 200),
    ];
    return {
      componentId: "glyph",
      version: 1,
      name: "Glyph",
      graph: { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} },
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "shader", portId: "out" }],
      parameters: [
        { key: "code", definition: { type: "code", language: "wgsl", label: "Code", default: "", compileTime: true }, targets: [{ nodeId: "shader", key: "source" }] },
        { key: "gain", definition: { type: "number", label: "Gain", default: 1 }, targets: [{ nodeId: "shader", key: "amount" }] },
      ],
    };
  }

  const show = (): GraphNode =>
    node("show", "cueList", "show", {
      follow: "timeline",
      cues: serializeCueList({ version: 1, cues: [{ name: "A", bank: "glyph1", preset: "lit", at: 1 }] }),
    }, 400);

  it("§T1544b: files the structural key as structure, warns nothing, and still times the number", () => {
    const doc = documentWith([instance("g", "glyph1", { code: "", gain: 1 }, "glyph"), show()], { definitions: [glyph()] });
    const plan = planTimelineCues(doc.graph(), doc.bus.registry, doc.components);
    expect(plan.warnings.filter((warning) => warning.diagnostic.code === "cue.timeline.structural")).toEqual([]);
    expect([...(plan.structure.get("g")?.keys() ?? [])]).toEqual(["code"]);
    expect(plan.chains.get("g")?.has("gain")).toBe(true);
  });
});
