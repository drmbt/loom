// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { parseCueList, parsePresetBank, serializePresetBank } from "@domain/presets/index.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * T1501b (§T1398b S6) — THE BANK AND THE CUE LIST, EDITED FROM THE INSPECTOR, as the owner
 * meets them: select the bank, name a preset, Store it, change the look, Recall it back,
 * Delete it; select the cue list, build the set as a table, pick the standby, GO.
 *
 * Mounted as the ASSEMBLED pane on the real app runtime and bus, so what is asserted is
 * the document after each press — the bank's presets, the target's value, the list's
 * `cues` — and what one undo puts back. A section that only drew buttons, or that the
 * pane never mounted for these node types, fails here.
 */
beforeAll(installDomStubs);
afterEach(cleanup);

const settings: InspectorProjectSettings = { outputResolution: { width: 1920, height: 1080 }, workingFormat: "rgba8unorm" };
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;

async function documentWith(operations: GraphPatchOperation[]): Promise<{ runtime: AppRuntime; ids: Record<string, NodeId> }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label: "setup", operations }, runtime.invocation);
  expect(result.output.status).toBe("applied");
  return { runtime, ids: result.output.createdIds as Record<string, NodeId> };
}

const mount = (runtime: AppRuntime, nodeId: NodeId) => render(<Inspector bus={runtime.bus} context={runtime.invocation} nodeId={nodeId} settings={settings} />);
const nodeOf = (runtime: AppRuntime, id: NodeId) => runtime.bus.store.getGraph().nodes[id]!;
const undoDepth = (runtime: AppRuntime) => runtime.bus.store.getHistory(runtime.invocation.actor).undo.length;

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await settle();
  });
}
/** Types into a kit text field and leaves it — which is when it commits. */
async function type(field: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(field, { target: { value } });
    fireEvent.blur(field);
    await settle();
  });
}
async function choose(select: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(select, { target: { value } });
    await settle();
  });
}
async function undo(runtime: AppRuntime): Promise<void> {
  await act(async () => {
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    await settle();
  });
}

describe("T1501b — the bank's section: Store, Recall, Delete", () => {
  const presetNames = (runtime: AppRuntime, bankId: NodeId): string[] => {
    const parsed = parsePresetBank(nodeOf(runtime, bankId).parameters["presets"]);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.bank.presets.map((preset) => preset.name);
  };

  it("Store adds a preset that Recall brings back, and Delete removes it — each one undo step", async () => {
    const { runtime, ids } = await documentWith([add("blur", "blur", "blur1", { size: 4 }), add("looks", "presets", "looks", { targets: "blur1" })]);
    const bank = ids["$looks"]!;
    const blur = ids["$blur"]!;
    mount(runtime, bank);
    const section = () => screen.getByRole("region", { name: "Presets bank" });
    // An empty bank offers the first free name, so Store works with no typing at all.
    expect((within(section()).getByRole("textbox", { name: "Preset name" }) as HTMLInputElement).value).toBe("preset1");

    await type(within(section()).getByRole("textbox", { name: "Preset name" }), "soft");
    const beforeStore = undoDepth(runtime);
    await press(within(section()).getByRole("button", { name: "Store" }));
    expect(presetNames(runtime, bank)).toEqual(["soft"]);
    expect(undoDepth(runtime)).toBe(beforeStore + 1);
    expect(section().querySelector('[data-preset-row="soft"]')).not.toBeNull();
    // The field moves on to the next free name, so a second Store does not overwrite.
    expect((within(section()).getByRole("textbox", { name: "Preset name" }) as HTMLInputElement).value).toBe("preset2");

    // The look changes by hand; Recall brings back what Store captured.
    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: blur, parameters: { size: 20 } }] },
        runtime.invocation,
      );
    });
    const beforeRecall = undoDepth(runtime);
    await press(within(section()).getByRole("button", { name: "Recall soft" }));
    expect(nodeOf(runtime, blur).parameters["size"]).toBe(4);
    expect(undoDepth(runtime)).toBe(beforeRecall + 1);
    // The row says which preset is live.
    expect(section().querySelector('[data-preset-row="soft"]')?.textContent).toContain("live");
    await undo(runtime);
    expect(nodeOf(runtime, blur).parameters["size"]).toBe(20);

    const beforeDelete = undoDepth(runtime);
    await press(within(section()).getByRole("button", { name: "Delete soft" }));
    expect(presetNames(runtime, bank)).toEqual([]);
    expect(undoDepth(runtime)).toBe(beforeDelete + 1);
    expect(section().querySelector('[data-preset-row="soft"]')).toBeNull();
    // Deleting a snapshot is not a recall: the look stays where it was.
    expect(nodeOf(runtime, blur).parameters["size"]).toBe(20);
    await undo(runtime);
    expect(presetNames(runtime, bank)).toEqual(["soft"]);
  });

  it("a Store the bus refuses says why and stores nothing; picking a target makes it work", async () => {
    const { runtime, ids } = await documentWith([add("blur", "blur", "blur1", { size: 4 }), add("looks", "presets", "looks")]);
    const bank = ids["$looks"]!;
    mount(runtime, bank);
    const section = () => screen.getByRole("region", { name: "Presets bank" });
    const revision = runtime.bus.store.getRevision();

    await press(within(section()).getByRole("button", { name: "Store" }));
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(within(section()).getByRole("alert").textContent).toContain("declares no targets");

    // The picker lists the other nodes by name; choosing one writes Targets, one patch.
    const before = undoDepth(runtime);
    await choose(within(section()).getByRole("combobox", { name: "Add target" }), "blur1");
    expect(nodeOf(runtime, bank).parameters["targets"]).toBe("blur1");
    expect(undoDepth(runtime)).toBe(before + 1);

    await press(within(section()).getByRole("button", { name: "Store" }));
    expect(presetNames(runtime, bank)).toEqual(["preset1"]);
    expect(within(section()).queryByRole("alert")).toBeNull();
  });

  it("T1527b: a preset moves earlier or later on the strip, and its own morph is set and cleared — each one undo step, and a recall fades by it", async () => {
    const bankJson = serializePresetBank({
      version: 1,
      presets: [
        { name: "soft", values: { blur1: { size: 4 } } },
        { name: "hard", values: { blur1: { size: 20 } } },
      ],
    });
    const { runtime, ids } = await documentWith([add("blur", "blur", "blur1", { size: 9 }), add("looks", "presets", "looks", { targets: "blur1", presets: bankJson, morph: 0 })]);
    const bank = ids["$looks"]!;
    runtime.bus.attachFrameClock(() => ({ epoch: "e1", absTimeSeconds: 10 }));
    mount(runtime, bank);
    const section = () => screen.getByRole("region", { name: "Presets bank" });
    const presetsOf = () => {
      const parsed = parsePresetBank(nodeOf(runtime, bank).parameters["presets"]);
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.bank.presets;
    };
    const recallHard = async () => (await runtime.bus.execute("preset.recall", { nodeId: bank, name: "hard" }, runtime.invocation)).output.morph;

    // Order: the strip's button order is the bank's, so moving a row moves the button.
    expect((within(section()).getByRole("button", { name: "Move soft earlier" }) as HTMLButtonElement).disabled).toBe(true);
    let before = undoDepth(runtime);
    await press(within(section()).getByRole("button", { name: "Move hard earlier" }));
    expect(presetNames(runtime, bank)).toEqual(["hard", "soft"]);
    expect([...section().querySelectorAll("[data-preset-row]")].map((row) => row.getAttribute("data-preset-row"))).toEqual(["hard", "soft"]);
    expect(undoDepth(runtime)).toBe(before + 1);
    await undo(runtime);
    expect(presetNames(runtime, bank)).toEqual(["soft", "hard"]);

    // Its own morph: the bank cuts (Morph 0), hard fades over 2 s on its own curve.
    expect(await recallHard()).toBeNull();
    before = undoDepth(runtime);
    await type(within(section()).getByRole("spinbutton", { name: "Morph seconds for hard" }), "2");
    expect(presetsOf()[1]?.morph).toEqual({ seconds: 2, curve: "smooth" });
    expect(undoDepth(runtime)).toBe(before + 1);
    await choose(within(section()).getByRole("combobox", { name: "Curve for hard" }), "linear");
    expect(presetsOf()[1]?.morph).toEqual({ seconds: 2, curve: "linear" });
    // The values and the neighbour are untouched by a morph edit.
    expect(presetsOf()[0]).toEqual({ name: "soft", values: { blur1: { size: 4 } } });
    expect(presetsOf()[1]?.values).toEqual({ blur1: { size: 20 } });
    await act(async () => {
      await runtime.bus.execute("preset.recall", { nodeId: bank, name: "soft" }, runtime.invocation);
    });
    expect(await recallHard()).toEqual({ seconds: 2, curve: "linear" });

    // Blank is "the bank's": the preset's own morph is gone and a recall cuts again.
    await type(within(section()).getByRole("spinbutton", { name: "Morph seconds for hard" }), "");
    expect(presetsOf()[1]).toEqual({ name: "hard", values: { blur1: { size: 20 } } });
    await act(async () => {
      await runtime.bus.execute("preset.recall", { nodeId: bank, name: "soft" }, runtime.invocation);
    });
    expect(await recallHard()).toBeNull();
  });

  it("T1527b: Delete of a preset a cue still names deletes it and says which cue now points at nothing", async () => {
    const cues = JSON.stringify({ version: 1, cues: [{ name: "7", bank: "looks", preset: "soft" }] });
    const { runtime, ids } = await documentWith([
      add("blur", "blur", "blur1", { size: 4 }),
      add("looks", "presets", "looks", { targets: "blur1", presets: serializePresetBank({ version: 1, presets: [{ name: "soft", values: { blur1: { size: 4 } } }] }) }),
      add("set", "cueList", "set", { cues }),
    ]);
    const bank = ids["$looks"]!;
    mount(runtime, bank);
    const section = () => screen.getByRole("region", { name: "Presets bank" });

    await press(within(section()).getByRole("button", { name: "Delete soft" }));
    expect(presetNames(runtime, bank)).toEqual([]);
    expect(within(section()).queryByRole("alert")).toBeNull();
    expect(within(section()).getByRole("status").textContent).toBe(
      'Cue list "set": cue "7" still names "soft" (looks), which is gone; GO on it will be refused.',
    );
  });
});

describe("T1501b — the cue list's section: the table, the standby, GO and BACK", () => {
  const LOOKS = serializePresetBank({
    version: 1,
    presets: [
      { name: "soft", values: { blur1: { size: 4 } } },
      { name: "hard", values: { blur1: { size: 20 } } },
    ],
  });
  const FX = serializePresetBank({ version: 1, presets: [{ name: "wash", values: { blur1: { size: 12 } } }] });

  async function show() {
    const made = await documentWith([
      add("blur", "blur", "blur1", { size: 9 }),
      add("looks", "presets", "looks", { targets: "blur1", presets: LOOKS }),
      add("fx", "presets", "fx", { targets: "blur1", presets: FX }),
      add("set", "cueList", "set"),
    ]);
    mount(made.runtime, made.ids["$set"]!);
    return made;
  }
  const section = () => screen.getByRole("region", { name: "Cues" });
  const cuesOf = (runtime: AppRuntime, listId: NodeId) => {
    const parsed = parseCueList(nodeOf(runtime, listId).parameters["cues"]);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.list.cues;
  };

  it("builds the set as a table — add, pick bank and preset, morph, reorder, rename, remove — one patch per edit", async () => {
    const { runtime, ids } = await show();
    const list = ids["$set"]!;
    let depth = undoDepth(runtime);
    /** Every edit must be exactly one undo step, and must have written the `cues` parameter. */
    const oneStep = () => {
      expect(undoDepth(runtime)).toBe(depth + 1);
      depth += 1;
    };

    // A new cue names a bank that HAS a preset, and that bank's first: it can fire at once.
    await press(within(section()).getByRole("button", { name: "Add cue" }));
    oneStep();
    expect(cuesOf(runtime, list)).toEqual([{ name: "1", bank: "fx", preset: "wash" }]);

    // Another bank: the preset follows to one that bank holds.
    await choose(within(section()).getByRole("combobox", { name: "Bank for cue 1" }), "looks");
    oneStep();
    expect(cuesOf(runtime, list)).toEqual([{ name: "1", bank: "looks", preset: "soft" }]);

    await choose(within(section()).getByRole("combobox", { name: "Preset for cue 1" }), "hard");
    oneStep();
    expect(cuesOf(runtime, list)).toEqual([{ name: "1", bank: "looks", preset: "hard" }]);

    // The next cue starts from the bank the last one used.
    await press(within(section()).getByRole("button", { name: "Add cue" }));
    oneStep();
    expect(cuesOf(runtime, list)[1]).toEqual({ name: "2", bank: "looks", preset: "soft" });

    // A morph time is the cue's own; the curve is offered once it has one.
    expect((within(section()).getByRole("combobox", { name: "Curve for cue 2" }) as HTMLSelectElement).disabled).toBe(true);
    await type(within(section()).getByRole("spinbutton", { name: "Morph seconds for cue 2" }), "2.5");
    oneStep();
    expect(cuesOf(runtime, list)[1]).toEqual({ name: "2", bank: "looks", preset: "soft", morph: { seconds: 2.5, curve: "smooth" } });
    await choose(within(section()).getByRole("combobox", { name: "Curve for cue 2" }), "linear");
    oneStep();
    expect(cuesOf(runtime, list)[1]?.morph).toEqual({ seconds: 2.5, curve: "linear" });

    await press(within(section()).getByRole("button", { name: "Move cue 2 up" }));
    oneStep();
    expect(cuesOf(runtime, list).map((cue) => cue.name)).toEqual(["2", "1"]);

    await type(within(section()).getByRole("textbox", { name: "Name of cue 2" }), "intro");
    oneStep();
    expect(cuesOf(runtime, list).map((cue) => cue.name)).toEqual(["intro", "1"]);

    // A name another cue has would make the whole list unreadable: refused here, nothing written.
    const revision = runtime.bus.store.getRevision();
    await type(within(section()).getByRole("textbox", { name: "Name of cue 1" }), "intro");
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(within(section()).getByRole("alert").textContent).toContain('"intro"');

    await press(within(section()).getByRole("button", { name: "Remove cue 1" }));
    oneStep();
    expect(cuesOf(runtime, list)).toEqual([{ name: "intro", bank: "looks", preset: "soft", morph: { seconds: 2.5, curve: "linear" } }]);

    // One undo is one edit back: the removed cue returns.
    await undo(runtime);
    expect(cuesOf(runtime, list).map((cue) => cue.name)).toEqual(["intro", "1"]);
  });

  it("picks the standby, and GO / BACK fire through the list: the look moves and the position follows", async () => {
    const { runtime, ids } = await show();
    const list = ids["$set"]!;
    const size = () => nodeOf(runtime, ids["$blur"]!).parameters["size"];
    const position = () => section().querySelector("[data-cue-position]")?.textContent;
    await press(within(section()).getByRole("button", { name: "Add cue" }));
    await choose(within(section()).getByRole("combobox", { name: "Bank for cue 1" }), "looks");
    await press(within(section()).getByRole("button", { name: "Add cue" }));
    await choose(within(section()).getByRole("combobox", { name: "Preset for cue 2" }), "hard");
    expect(position()).toBe("— ▸ 1");

    // Jump the standby to cue 2: GO fires IT, not the first cue.
    await choose(within(section()).getByRole("combobox", { name: "Standby" }), "2");
    expect(nodeOf(runtime, list).parameters["standby"]).toBe("2");
    expect(position()).toBe("— ▸ 2");
    const before = undoDepth(runtime);
    await press(within(section()).getByRole("button", { name: "GO" }));
    expect(size()).toBe(20);
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(position()).toBe("2 ▸ —");

    // The end of the list: GO is refused, in the command's own words, and nothing moves.
    const revision = runtime.bus.store.getRevision();
    await press(within(section()).getByRole("button", { name: "GO" }));
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(within(section()).getByRole("alert").textContent).toContain("Wrap is off");

    await press(within(section()).getByRole("button", { name: "BACK" }));
    expect(size()).toBe(4);
    expect(position()).toBe("1 ▸ 2");

    // Renaming the cue the list is ON keeps the list on it.
    await type(within(section()).getByRole("textbox", { name: "Name of cue 1" }), "opener");
    expect(nodeOf(runtime, list).parameters["current"]).toBe("opener");
    expect(position()).toBe("opener ▸ 2");
  });

  it("T1508b: times a cue (typed and from the playhead), follows the timeline, and then GO is off with the reason — each edit one undo step", async () => {
    const { runtime, ids } = await show();
    const list = ids["$set"]!;
    // The page's frame clock: the last frame drew the playhead at 2.5 s.
    runtime.bus.attachFrameClock(() => ({ epoch: "e", absTimeSeconds: 9, timeSeconds: 2.5, timelineRate: 30 }));
    await press(within(section()).getByRole("button", { name: "Add cue" }));
    await press(within(section()).getByRole("button", { name: "Add cue" }));
    let depth = undoDepth(runtime);

    await type(within(section()).getByRole("spinbutton", { name: "At for cue 1" }), "1.5");
    expect(undoDepth(runtime)).toBe(depth + 1);
    depth += 1;
    expect(cuesOf(runtime, list)[0]?.at).toBe(1.5);

    await press(within(section()).getByRole("button", { name: "Set cue 2 to the playhead" }));
    expect(undoDepth(runtime)).toBe(depth + 1);
    depth += 1;
    expect(cuesOf(runtime, list)[1]?.at).toBe(2.5);

    const go = within(section()).getByRole("button", { name: "GO" }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    await press(within(section()).getByRole("switch", { name: "Follow timeline" }));
    expect(undoDepth(runtime)).toBe(depth + 1);
    expect(nodeOf(runtime, list).parameters["follow"]).toBe("timeline");
    // GO and BACK are off and say why; the position is the playhead's (2.5 s: past both cues).
    const goNow = within(section()).getByRole("button", { name: "GO" }) as HTMLButtonElement;
    expect(goNow.disabled).toBe(true);
    expect(goNow.title).toContain("follows the timeline");
    expect(section().querySelector("[data-cue-position]")?.textContent).toBe("⏱ 2 ▸ —");
    expect(section().querySelector("[data-timeline-warnings]")).toBeNull();

    // A cue with no time is said, by name, under the controls.
    await type(within(section()).getByRole("spinbutton", { name: "At for cue 1" }), "");
    expect(section().querySelector("[data-timeline-warnings]")?.textContent).toContain('Cue "1" (set) has no At time');

    // Back to live: one undo step, and GO is a button again.
    await undo(runtime);
    await undo(runtime);
    expect(nodeOf(runtime, list).parameters["follow"] ?? "live").toBe("live");
    expect((within(section()).getByRole("button", { name: "GO" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * T1505b — A LOOK'S INSTANCE IN THE INSPECTOR. The instance of a component whose definition
 * holds a page bank shows the same Presets section — its component's presets, its own
 * `current` — and its page does NOT grow the two JSON rows the instance's preset state is
 * kept in. Recall is the instance's undoable patch; Store writes the component (no undo
 * step), which the section says. A bank beside ONE look offers "Move into" that look.
 */
describe("T1505b — a look's instance shows its component's presets", () => {
  function withLook(runtime: AppRuntime): void {
    const presets = serializePresetBank({ version: 1, presets: [{ name: "calm", values: { parent: { glow: 2 } } }] });
    runtime.components.register({
      componentId: "look",
      version: 1,
      name: "Look",
      graph: {
        revision: 0,
        nodes: {
          blur: { id: "blur", type: "blur", label: "blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { size: 4 } },
          looks: { id: "looks", type: "presets", label: "looks", definitionVersion: 1, position: { x: 0, y: 200 }, parameters: { targets: "parent", presets } },
        },
        edges: {},
        groups: {},
      },
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "blur", portId: "out" }],
      parameters: [{ key: "glow", definition: { type: "number", label: "Glow", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "blur", key: "size" }] }],
    });
  }

  it("lists the component's presets, recalls on the instance as one undo step, and hides the instance's preset-state rows", async () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
    withLook(runtime);
    const placed = await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), label: "setup", operations: [add("city", "component:look@1", "city", { glow: 30 })] },
      runtime.invocation,
    );
    const city = (placed.output.createdIds as Record<string, NodeId>)["$city"]!;
    mount(runtime, city);
    const section = () => screen.getByRole("region", { name: "Presets bank" });
    expect(section().querySelector('[data-preset-component="Look"]')).not.toBeNull();
    expect(section().querySelector('[data-preset-row="calm"]')).not.toBeNull();
    // Targets are the component's: no field for them on the instance.
    expect(within(section()).queryByRole("textbox", { name: "Targets" })).toBeNull();
    expect(screen.queryByText("Preset morphs")).toBeNull();

    const beforeRecall = undoDepth(runtime);
    await press(within(section()).getByRole("button", { name: "Recall calm" }));
    expect(nodeOf(runtime, city).parameters["glow"]).toBe(2);
    expect(nodeOf(runtime, city).parameters["presetCurrent"]).toBe("calm");
    expect(undoDepth(runtime)).toBe(beforeRecall + 1);
    expect(section().querySelector('[data-preset-row="calm"]')?.textContent).toContain("live");

    // Store writes the COMPONENT: no undo step, and the new preset is the component's.
    await type(within(section()).getByRole("textbox", { name: "Preset name" }), "wide");
    const beforeStore = undoDepth(runtime);
    await press(within(section()).getByRole("button", { name: "Store" }));
    expect(undoDepth(runtime)).toBe(beforeStore);
    const stored = parsePresetBank(runtime.components.get("look", 1)?.graph.nodes["looks"]?.parameters["presets"]);
    expect(stored.ok ? stored.bank.presets.map((preset) => preset.name) : []).toEqual(["calm", "wide"]);
    expect(section().querySelector('[data-preset-row="wide"]')).not.toBeNull();
  });

  it("a bank beside one look offers Move into it — the bank goes, the look holds the presets", async () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
    withLook(runtime);
    const presets = serializePresetBank({ version: 1, presets: [{ name: "warm", values: { city: { glow: 9 } } }] });
    const placed = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "setup",
        operations: [add("city", "component:look@1", "city", { glow: 30 }), add("beside", "presets", "beside", { targets: "city", presets })],
      },
      runtime.invocation,
    );
    const beside = (placed.output.createdIds as Record<string, NodeId>)["$beside"]!;
    mount(runtime, beside);
    await press(within(screen.getByRole("region", { name: "Presets bank" })).getByRole("button", { name: "Move into city" }));
    expect(runtime.bus.store.getGraph().nodes[beside]).toBeUndefined();
    const moved = parsePresetBank(runtime.components.get("look", 1)?.graph.nodes["looks"]?.parameters["presets"]);
    expect(moved.ok ? moved.bank.presets.map((preset) => preset.name) : []).toEqual(["calm", "warm"]);
  });
});
