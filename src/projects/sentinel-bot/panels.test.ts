import { describe, expect, it } from "vitest";
import { parsePresetBank } from "../../domain/presets/bank.ts";
import { presetSession } from "../../domain/presets/test-support.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import { panelBoard } from "../../nodes/definitions/controls.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { sentinelDocument } from "./document.ts";
import { KIT_FIXTURE } from "./kit.fixture.ts";

/**
 * T1561b — THE PANELS, and getting back to what was saved.
 *
 * The owner, 2026-10-06: "ways to reset controls individually or all according to what was saved …
 * accessible on both phone and browser". What exists for it today is a Presets bank, which the
 * desk and the phone both draw as buttons named as their presets are: each of the three panels
 * carries one with a single preset, `reset_<panel>`, holding every control of that panel at the
 * value the file ships it with, and every panel carries `reset_all` as well. (They were first all
 * called `saved`; the owner, with them in front of him: "resetting in the controls is not visible
 * for me anywhere".) The claim is what a performer gets from the press: after moving EVERY control,
 * one recall of a panel's puts that panel back and touches nothing on the other two, and one of
 * `reset_all` puts back all three.
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const PANELS = ["robot", "scene", "lights"] as const;
/** The parameters a control is moved by. */
const KEYS: Readonly<Record<string, readonly string[]>> = { slider: ["value"], toggle: ["on"], xyPad: ["x", "y"] };

const built = (): GraphDocument => structuredClone(sentinelDocument(KIT_FIXTURE).graph);
/** A bank node's presets, as the app reads them. */
function readPresetBank(bank: GraphNode): { presets: ReadonlyArray<{ name: string }> } {
  const parsed = parsePresetBank(storedStaticValue(bank.parameters["presets"]));
  if (!parsed.ok) throw new Error(`${bank.label ?? bank.id} holds no readable bank`);
  return parsed.bank;
}
const named = (graph: GraphDocument, name: string): GraphNode => {
  const found = Object.values(graph.nodes).find((node) => node.label === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
};
/** The controls a panel is wired to, by name. */
const controlsOf = (graph: GraphDocument, panel: string): string[] =>
  Object.values(graph.edges)
    .filter((edge) => edge.target.nodeId === named(graph, `panel_${panel}`).id)
    .map((edge) => (graph.nodes[edge.source.nodeId] as GraphNode).label as string);
/** What every control of a panel reads now: name.key → value. */
const reading = (graph: GraphDocument, panel: string): Record<string, unknown> =>
  Object.fromEntries(
    controlsOf(graph, panel).flatMap((name) => {
      const node = named(graph, name);
      return (KEYS[node.type] ?? []).map((key) => [`${name}.${key}`, storedStaticValue(node.parameters[key])]);
    }),
  );
/** The same document with every control of every panel moved off where it was saved. */
function moved(graph: GraphDocument): GraphDocument {
  const nodes = { ...graph.nodes };
  for (const panel of PANELS) {
    for (const name of controlsOf(graph, panel)) {
      const node = named(graph, name);
      const parameters = { ...node.parameters };
      for (const key of KEYS[node.type] ?? []) {
        const value = storedStaticValue(node.parameters[key]);
        parameters[key] = typeof value === "boolean" ? !value : (value as number) + 0.123;
      }
      nodes[node.id] = { ...node, parameters };
    }
  }
  return { ...graph, nodes };
}

describe("the sentinel's panels", () => {
  it("every control is on exactly one panel, and each panel shows its Saved bank on its board", () => {
    const graph = built();
    const all = PANELS.flatMap((panel) => controlsOf(graph, panel));
    expect(new Set(all).size).toBe(all.length);
    // Every slider, toggle and pad of the document is one of them.
    const widgets = Object.values(graph.nodes).filter((node) => KEYS[node.type] !== undefined).map((node) => node.label as string);
    expect([...all].sort()).toEqual([...widgets].sort());
    for (const panel of PANELS) {
      // The board as the desk and the phone derive it: a named member whose node is gone is dropped there.
      const board = panelBoard(graph, named(graph, `panel_${panel}`));
      const members = (board?.items ?? []).flatMap((item) => (item.kind === "widget" ? [item.node.label as string] : []));
      // What the board draws is the panel's controls, its own reset and the reset for everything; nothing else and nothing missing.
      expect([...members].sort()).toEqual([...controlsOf(graph, panel), `presets_${panel}`, "presets_all"].sort());
      // …and a reset reads as one: the button is named for what it does.
      expect(readPresetBank(named(graph, `presets_${panel}`)).presets.map((preset) => preset.name)).toEqual([`reset_${panel}`]);
      // The phone shows it only if the Phone switch is on.
      expect(storedStaticValue(named(graph, `panel_${panel}`).parameters["remote"])).toBe(true);
      // On a phone there is somewhere to scroll that is not a control: nothing reaches into the last two columns of the board's ten.
      expect(board?.columns).toBe(10);
      for (const item of board?.items ?? []) if (item.kind === "widget") expect([panel, item.node.label, item.rect.x + item.rect.w <= 8]).toEqual([panel, item.node.label, true]);
    }
    // ALL: every control and every bank again, on one board for the desk, in two columns, and not on the phone.
    const everything = panelBoard(graph, named(graph, "panel_all"));
    const shown = (everything?.items ?? []).flatMap((item) => (item.kind === "widget" ? [item.node.label as string] : []));
    expect([...shown].sort()).toEqual([...all, ...PANELS.map((panel) => `presets_${panel}`), "presets_all"].sort());
    expect(readPresetBank(named(graph, "presets_all")).presets.map((preset) => preset.name)).toEqual(["reset_all"]);
    expect([...controlsOf(graph, "all")].sort()).toEqual([...all].sort());
    expect(everything?.columns).toBe(20);
    const columnsUsed = new Set((everything?.items ?? []).map((item) => (item.rect.x < 10 ? "left" : "right")));
    expect([...columnsUsed].sort()).toEqual(["left", "right"]);
    // No two of its controls on top of each other.
    const cells = new Set<string>();
    for (const item of everything?.items ?? []) {
      for (let x = item.rect.x; x < item.rect.x + item.rect.w; x += 1) {
        for (let y = item.rect.y; y < item.rect.y + item.rect.h; y += 1) {
          expect([x, y, cells.has(`${x},${y}`)]).toEqual([x, y, false]);
          cells.add(`${x},${y}`);
        }
      }
    }
    expect(storedStaticValue(named(graph, "panel_all").parameters["remote"])).toBe(false);
  });

  it("a panel's reset puts every control of that panel back to what the file ships and leaves the other panels as they were moved; the reset for everything puts back all three", async () => {
    const shipped = built();
    for (const panel of PANELS) {
      const session = presetSession(moved(built()), registry);
      // Moved: nothing reads what it shipped with.
      for (const other of PANELS) for (const [key, value] of Object.entries(reading(session.graph(), other))) expect([key, value]).not.toEqual([key, reading(shipped, other)[key]]);
      await session.recall(named(session.graph(), `presets_${panel}`).id, `reset_${panel}`);
      expect(reading(session.graph(), panel)).toEqual(reading(shipped, panel));
      for (const other of PANELS.filter((each) => each !== panel)) expect(reading(session.graph(), other)).toEqual(reading(moved(built()), other));
    }
    const session = presetSession(moved(built()), registry);
    await session.recall(named(session.graph(), "presets_all").id, "reset_all");
    for (const panel of PANELS) expect(reading(session.graph(), panel)).toEqual(reading(shipped, panel));
  });
});
