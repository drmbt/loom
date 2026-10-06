import { describe, expect, it } from "vitest";
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
 * desk and the phone both draw as buttons: each of the three panels carries one with a single
 * preset, `saved`, holding every control of that panel at the value the file ships it with. The
 * claim is what a performer gets from the press: after moving EVERY control of a panel, one
 * recall puts each of them back, and touches nothing on the other two panels.
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const PANELS = ["robot", "scene", "lights"] as const;
/** The parameters a control is moved by. */
const KEYS: Readonly<Record<string, readonly string[]>> = { slider: ["value"], toggle: ["on"], xyPad: ["x", "y"] };

const built = (): GraphDocument => structuredClone(sentinelDocument(KIT_FIXTURE).graph);
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
      // What the board draws is the panel's controls and its bank, nothing else and nothing missing.
      expect([...members].sort()).toEqual([...controlsOf(graph, panel), `presets_${panel}`].sort());
      // The phone shows it only if the Phone switch is on.
      expect(storedStaticValue(named(graph, `panel_${panel}`).parameters["remote"])).toBe(true);
    }
  });

  it("Saved puts every control of its panel back to what the file ships, and leaves the other panels as they were moved", async () => {
    const shipped = built();
    for (const panel of PANELS) {
      const session = presetSession(moved(built()), registry);
      // Moved: nothing reads what it shipped with.
      for (const other of PANELS) for (const [key, value] of Object.entries(reading(session.graph(), other))) expect([key, value]).not.toEqual([key, reading(shipped, other)[key]]);
      await session.recall(named(session.graph(), `presets_${panel}`).id, "saved");
      expect(reading(session.graph(), panel)).toEqual(reading(shipped, panel));
      for (const other of PANELS.filter((each) => each !== panel)) expect(reading(session.graph(), other)).toEqual(reading(moved(built()), other));
    }
  });
});
