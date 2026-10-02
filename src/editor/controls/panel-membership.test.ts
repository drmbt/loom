import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LoomBus } from "../../domain/commands/bus.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { alice, contextFor } from "../../domain/commands/test-support.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { compileGraph } from "../../compiler/compile.ts";
import { testCapabilities, testSettings } from "../../compiler/test-support.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { CONTROL_WIDGET_TYPES, panelBoard, panelLayout, panelMembers, parsePanelBoard, parsePanelLayout, soloPanelFor } from "../../nodes/definitions/controls.ts";
import { serializePresetBank } from "../../domain/presets/bank.ts";
import { removeFromPanelOperations } from "./panel-board-edit.ts";
import { joinPanelOperations, panelUnderDrop } from "./panel-join.ts";

/**
 * T1512b — WHICH WIDGETS A PANEL SHOWS, AND IN WHAT ORDER, decided by `panelLayout`: the
 * one derivation the Panel's canvas body, the Controls tab and the phone read.
 *
 * What the owner asked for, as behaviour: a widget joins a Panel by being WIRED to it (or
 * dropped on it — the same edge), never by typing its name; the Panel shows its widgets in
 * wiring order and rearranging them rewrites that order through the bus; the old Layout
 * text is an optional override that, when present, still decides exactly what it decided
 * before — so a document built on it (E81 as it shipped at 972d4894) shows what it showed.
 *
 * Built through the real bus and registry, so the connect is accepted by the real port
 * rules (a widget's `out` into a Panel's variadic `controls`) and the order is the one the
 * patch layer really keeps.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

async function documentWith(operations: GraphPatchOperation[]): Promise<{ bus: LoomBus; ids: Record<string, NodeId> }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("m"), now: () => "2026-09-29T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry });
  const result = await apply(bus, operations);
  return { bus, ids: result as Record<string, NodeId> };
}

async function apply(bus: LoomBus, operations: GraphPatchOperation[]): Promise<Record<string, string>> {
  const result = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label: "t", operations }, contextFor(alice));
  expect(result.output.status).toBe("applied");
  return result.output.createdIds as Record<string, string>;
}

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
const wire = (from: string, to: string): GraphPatchOperation =>
  ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: `$${to}`, portId: "controls" } }) as GraphPatchOperation;

const labels = (graph: GraphDocument, panel: NodeId): string[] => panelMembers(graph, graph.nodes[panel]!).map((node) => node.label ?? node.id);

describe("T1512b — a Panel's members are the widgets wired into it, in wiring order", () => {
  it("shows wired widgets in the order they were wired — not creation order, not by name", async () => {
    const { bus, ids } = await documentWith([
      add("a", "slider", "alpha"),
      add("b", "toggle", "bravo"),
      add("c", "button", "charlie"),
      add("lfo", "lfo", "lfo1"),
      add("panel", "panel", "panel1"),
      wire("c", "panel"),
      wire("a", "panel"),
      // A value source that is no widget is wired legally and shows nothing.
      wire("lfo", "panel"),
      wire("b", "panel"),
    ]);
    const graph = bus.store.getGraph();
    expect(panelLayout(graph, graph.nodes[ids["$panel"]!]!).source).toBe("wiring");
    expect(labels(graph, ids["$panel"]!)).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("a fresh Panel with nothing wired shows nothing — no text to fill in", async () => {
    const { bus, ids } = await documentWith([add("a", "slider", "alpha"), add("panel", "panel", "panel1")]);
    const graph = bus.store.getGraph();
    expect(panelLayout(graph, graph.nodes[ids["$panel"]!]!)).toEqual({ source: "wiring", rows: [] });
  });

  it("wiring widgets into a Panel compiles and evaluates with no diagnostics", async () => {
    const { bus } = await documentWith([add("a", "slider", "alpha"), add("panel", "panel", "panel1"), wire("a", "panel")]);
    const graph = bus.store.getGraph();
    const compiled = compileGraph({ graph, settings: testSettings(), registry, capabilities: testCapabilities() });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const frame = { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 } as const;
    expect(createValueGraphSession(registry).evaluate(graph, frame).diagnostics).toEqual([]);
  });

});

describe("T1512b — dropping a widget on a Panel wires it", () => {
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const boxOf = (id: NodeId) => boxes[id] ?? null;

  it("the Panel under the widget's centre is the one it joins, appended at the end", async () => {
    const { bus, ids } = await documentWith([
      add("a", "slider", "alpha"),
      add("b", "slider", "bravo"),
      add("blur", "blur", "blur1"),
      add("panel", "panel", "panel1"),
      wire("a", "panel"),
    ]);
    const panel = ids["$panel"]!;
    boxes[panel] = { x: 400, y: 100, width: 178, height: 240 };
    const graph = bus.store.getGraph();
    expect(panelUnderDrop(graph, ids["$b"]!, { x: 480, y: 200 }, boxOf)).toBe(panel);
    // Beside the Panel is not on it, and a node that is no widget never joins one.
    expect(panelUnderDrop(graph, ids["$b"]!, { x: 380, y: 200 }, boxOf)).toBeNull();
    expect(panelUnderDrop(graph, ids["$blur"]!, { x: 480, y: 200 }, boxOf)).toBeNull();

    await apply(bus, joinPanelOperations(graph, ids["$b"]!, panel));
    expect(labels(bus.store.getGraph(), panel)).toEqual(["alpha", "bravo"]);
    // Dropping it again adds no second wire.
    expect(joinPanelOperations(bus.store.getGraph(), ids["$b"]!, panel)).toEqual([]);
  });

  it("a widget's own add-to-panel offers the one Panel it is not on yet, and only while there is one", async () => {
    const { bus, ids } = await documentWith([add("a", "slider", "alpha"), add("panel", "panel", "panel1")]);
    expect(soloPanelFor(bus.store.getGraph(), ids["$a"]!)).toBe(ids["$panel"]);
    await apply(bus, joinPanelOperations(bus.store.getGraph(), ids["$a"]!, ids["$panel"]!));
    expect(soloPanelFor(bus.store.getGraph(), ids["$a"]!)).toBeNull();
    const more = await apply(bus, [add("b", "slider", "bravo"), add("second", "panel", "panel2")]);
    expect(soloPanelFor(bus.store.getGraph(), more["$b"] as NodeId)).toBeNull();
  });
});

describe("T1512b — the Layout text is an optional override, and it still decides what it decided", () => {
  it("a non-empty layout wins over the wiring", async () => {
    const { bus, ids } = await documentWith([
      add("a", "slider", "alpha"),
      add("b", "toggle", "bravo"),
      add("panel", "panel", "panel1", { layout: "# Desk\n> hands on\nbravo alpha ghost" }),
      wire("a", "panel"),
    ]);
    const graph = bus.store.getGraph();
    const layout = panelLayout(graph, graph.nodes[ids["$panel"]!]!);
    expect(layout.source).toBe("layout");
    expect(layout.rows.map((row) => (row.kind === "widgets" ? row.cells.map((cell) => (cell.kind === "widget" ? cell.node.label : `?${cell.name}`)) : row))).toEqual([
      { kind: "heading", text: "Desk" },
      { kind: "text", text: "hands on" },
      ["bravo", "alpha", "?ghost"],
    ]);
  });

  it("the pre-T1512b default layout (a lone `# Controls`) is not an override — the wiring decides", async () => {
    const { bus, ids } = await documentWith([
      add("a", "slider", "alpha"),
      add("panel", "panel", "panel1", { layout: "# Controls\n" }),
      wire("a", "panel"),
    ]);
    const graph = bus.store.getGraph();
    expect(panelLayout(graph, graph.nodes[ids["$panel"]!]!).source).toBe("wiring");
    expect(labels(graph, ids["$panel"]!)).toEqual(["alpha"]);
  });

  it("E81's pre-T1512b Layout text, set on today's wired E81, resolves exactly as the text read then", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, "../../../examples/E81-Phone-Desk.loom.json"), "utf8");
    const graph = (JSON.parse(text) as { graph: GraphDocument }).graph;
    const wired = Object.values(graph.nodes).find((node) => node.type === "panel")!;
    // E81 now joins its widgets by wire with Layout empty; this is the text it shipped with
    // at 972d4894 — the shape of every document laid out by text before the wiring existed.
    // Set on the WIRED Panel, so the override is shown winning over wires that disagree.
    expect(panelLayout(graph, wired).source).toBe("wiring");
    const panel: GraphNode = {
      ...wired,
      parameters: {
        ...wired.parameters,
        layout: "# Picture\n> Heat is brightness. Invert flips it.\nheat invert\n# Colour\n> Each press turns the hue a quarter.\nflash\n# Mapping\n> Drag the picture's top-right corner.\nwarp\n",
      },
    };
    // The pre-T1512b reading, spelled out: parse the text, resolve each name by label ?? id.
    const byName = new Map(
      Object.values(graph.nodes)
        .filter((node) => CONTROL_WIDGET_TYPES.has(node.type))
        .map((node): [string, GraphNode] => [node.label ?? node.id, node]),
    );
    const before = parsePanelLayout(panel.parameters["layout"] as string).map((row) =>
      row.kind === "widgets" ? row.names.map((name) => byName.get(name)?.id ?? `?${name}`) : row,
    );
    const now = panelLayout(graph, panel).rows.map((row) =>
      row.kind === "widgets" ? row.cells.map((cell) => (cell.kind === "widget" ? cell.node.id : `?${cell.name}`)) : row,
    );
    expect(panelLayout(graph, panel).source).toBe("layout");
    expect(now).toEqual(before);
    // Non-vacuous: E81 names four widgets under three headings.
    expect(now.flat().filter((cell) => typeof cell === "string")).toHaveLength(4);
  });
});

/**
 * T1501b — a Presets bank, a Layer and a Cue List cannot be wired into a Panel (no value
 * output), so the same two gestures — the drop and "+ panel" — write a board item that
 * NAMES the node instead. What the owner relies on: it lands at a sensible size in the
 * first free spot without moving anything already there; doing it twice adds nothing;
 * taking it off again is one write; and a node that is none of these still never joins.
 */
describe("T1501b — a bank, a layer and a cue list join a Panel by name", () => {
  const bankOf = (count: number): string =>
    serializePresetBank({ version: 1, presets: Array.from({ length: count }, (_unused, index) => ({ name: `p${String(index + 1)}`, values: {} })) });
  const stored = (graph: GraphDocument, panel: NodeId): string[] =>
    parsePanelBoard(graph.nodes[panel]!.parameters["board"]).items.map(
      (item) => `${"member" in item ? item.member : `"${item.label}"`}@${String(item.rect.x)},${String(item.rect.y)},${String(item.rect.w)},${String(item.rect.h)}`,
    );

  it("each lands at its own size in the first free spot: bank 4×1, layer 2×1, cue list 4×2 — and a bank of six takes two rows", async () => {
    const { bus, ids } = await documentWith([
      add("looks", "presets", "looks", { presets: bankOf(3) }),
      add("fx", "layer", "fx"),
      add("set", "cueList", "set"),
      add("big", "presets", "big", { presets: bankOf(6) }),
      add("panel", "panel", "panel1"),
    ]);
    const panel = ids["$panel"]!;
    for (const ref of ["$looks", "$fx", "$set", "$big"]) {
      const operations = joinPanelOperations(bus.store.getGraph(), ids[ref]!, panel);
      // ONE operation — the board write — and no wire.
      expect(operations.map((operation) => operation.op)).toEqual(["setParameters"]);
      await apply(bus, operations);
    }
    expect(stored(bus.store.getGraph(), panel)).toEqual(["looks@0,0,4,1", "fx@4,0,2,1", "set@0,1,4,2", "big@4,1,4,2"]);
    expect(Object.keys(bus.store.getGraph().edges)).toEqual([]);
    // Already there: nothing to write, and the node's own "+ panel" stops offering.
    expect(joinPanelOperations(bus.store.getGraph(), ids["$fx"]!, panel)).toEqual([]);
    expect(soloPanelFor(bus.store.getGraph(), ids["$fx"]!)).toBeNull();
  });

  it("the drop finds the Panel for these kinds too, and still not for any other node", async () => {
    const { bus, ids } = await documentWith([add("fx", "layer", "fx"), add("blur", "blur", "blur1"), add("panel", "panel", "panel1")]);
    const panel = ids["$panel"]!;
    const boxOf = (id: NodeId) => (id === panel ? { x: 400, y: 100, width: 178, height: 240 } : null);
    const graph = bus.store.getGraph();
    expect(panelUnderDrop(graph, ids["$fx"]!, { x: 480, y: 200 }, boxOf)).toBe(panel);
    expect(panelUnderDrop(graph, ids["$fx"]!, { x: 380, y: 200 }, boxOf)).toBeNull();
    expect(panelUnderDrop(graph, ids["$blur"]!, { x: 480, y: 200 }, boxOf)).toBeNull();
    expect(joinPanelOperations(graph, ids["$blur"]!, panel)).toEqual([]);
  });

  it("joining pins the wired widgets where they are drawn — nothing already on the board moves", async () => {
    const { bus, ids } = await documentWith([add("a", "slider", "alpha"), add("fx", "layer", "fx"), add("panel", "panel", "panel1"), wire("a", "panel")]);
    const panel = ids["$panel"]!;
    await apply(bus, joinPanelOperations(bus.store.getGraph(), ids["$fx"]!, panel));
    expect(stored(bus.store.getGraph(), panel)).toEqual(["alpha@0,0,4,1", "fx@4,0,2,1"]);
  });

  it("a Panel laid out by its legacy Layout text has no board, so it takes none of them", async () => {
    const { bus, ids } = await documentWith([add("fx", "layer", "fx"), add("panel", "panel", "panel1", { layout: "# Desk\nalpha" })]);
    expect(joinPanelOperations(bus.store.getGraph(), ids["$fx"]!, ids["$panel"]!)).toEqual([]);
    expect(soloPanelFor(bus.store.getGraph(), ids["$fx"]!)).toBeNull();
  });

  it("Remove from panel is the board write alone — there is no wire to cut — and the node stays", async () => {
    const { bus, ids } = await documentWith([add("looks", "presets", "looks"), add("fx", "layer", "fx"), add("panel", "panel", "panel1")]);
    const panel = ids["$panel"]!;
    await apply(bus, joinPanelOperations(bus.store.getGraph(), ids["$looks"]!, panel));
    await apply(bus, joinPanelOperations(bus.store.getGraph(), ids["$fx"]!, panel));
    const graph = bus.store.getGraph();
    const operations = removeFromPanelOperations(graph, panel, panelBoard(graph, graph.nodes[panel]!)!, "member:looks");
    expect(operations.map((operation) => operation.op)).toEqual(["setParameters"]);
    await apply(bus, operations);
    expect(stored(bus.store.getGraph(), panel)).toEqual(["fx@4,0,2,1"]);
    expect(bus.store.getGraph().nodes[ids["$looks"]!]).toBeDefined();
  });
});
