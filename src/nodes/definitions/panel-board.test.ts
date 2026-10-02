import { describe, expect, it } from "vitest";
import type { LoomBus } from "../../domain/commands/bus.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { alice, contextFor } from "../../domain/commands/test-support.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { panelBoard, parsePanelBoard, serializePanelBoard, type StoredBoardItem } from "./controls.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1516b — WHERE A PANEL'S CONTROLS SIT is one pure derivation, `panelBoard`, read by the
 * Controls tab, the Panel's canvas body, the phone and the layout model. What the owner
 * relies on: a control he placed STAYS where he put it; a control he just wired in lands
 * somewhere sensible without him doing anything, and the same place every time; a control
 * he unwired is gone from the board; a Panel from before the board (laid out by its text)
 * looks exactly as it did. And the arrangement survives a rename and a paste — the board
 * names its members, and names are what those two operations keep coherent (§V320).
 */

async function documentWith(operations: GraphPatchOperation[]): Promise<{ bus: LoomBus; ids: Record<string, NodeId> }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("b"), now: () => "2026-10-01T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const result = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label: "setup", operations }, contextFor(alice));
  expect(result.output.status).toBe("applied");
  return { bus, ids: result.output.createdIds as Record<string, NodeId> };
}

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
const wire = (from: string, to: string): GraphPatchOperation =>
  ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: `$${to}`, portId: "controls" } }) as GraphPatchOperation;
const board = (items: StoredBoardItem[], columns = 8): string => serializePanelBoard({ columns, items });

const panelOf = (graph: GraphDocument): GraphNode => Object.values(graph.nodes).find((node) => node.type === "panel")!;
/** The board as `name@x,y,w,h` — what a person sees, compactly. */
const placed = (graph: GraphDocument, panel = panelOf(graph)): string[] =>
  (panelBoard(graph, panel)?.items ?? []).map(
    (item) => `${item.kind === "label" ? `"${item.text}"` : (item.node.label ?? item.node.id)}@${String(item.rect.x)},${String(item.rect.y)},${String(item.rect.w)},${String(item.rect.h)}`,
  );

const FOUR: GraphPatchOperation[] = [
  add("heat", "slider", "heat"),
  add("invert", "toggle", "invert"),
  add("flash", "button", "flash"),
  add("warp", "xyPad", "warp"),
];

describe("T1516b — panelBoard: where a Panel's controls sit", () => {
  it("flows unplaced members into the first free spot at their type's size, row-major, in wiring order", async () => {
    const { bus } = await documentWith([...FOUR, add("panel", "panel", "panel1"), wire("heat", "panel"), wire("invert", "panel"), wire("flash", "panel"), wire("warp", "panel")]);
    const graph = bus.store.getGraph();
    // Slider 4×1, toggle 2×1 and button 2×1 fill the eight columns of row 0; the 3×3 pad
    // does not fit beside them, so it takes the first row where it does.
    expect(placed(graph)).toEqual(["heat@0,0,4,1", "invert@4,0,2,1", "flash@6,0,2,1", "warp@0,1,3,3"]);
    expect(panelBoard(graph, panelOf(graph))).toMatchObject({ columns: 8, rows: 4 });
  });

  it("a stored rect wins, labels keep theirs, and the rest flows around them", async () => {
    const { bus } = await documentWith([
      ...FOUR,
      add("panel", "panel", "panel1", {
        board: board([
          { label: "Look", rect: { x: 0, y: 0, w: 5, h: 1 } },
          { member: "warp", rect: { x: 5, y: 0, w: 3, h: 3 } },
        ]),
      }),
      wire("heat", "panel"),
      wire("invert", "panel"),
      wire("warp", "panel"),
    ]);
    expect(placed(bus.store.getGraph())).toEqual([
      '"Look"@0,0,5,1',
      "warp@5,0,3,3",
      // Flowed, in wiring order, into the first spots the stored items leave free.
      "heat@0,1,4,1",
      "invert@0,2,2,1",
    ]);
  });

  it("a stored item whose widget is no longer wired is left out — and the board does not stop at a gap", async () => {
    const { bus } = await documentWith([
      ...FOUR,
      add("panel", "panel", "panel1", {
        board: board([
          { member: "flash", rect: { x: 0, y: 0, w: 2, h: 1 } },
          { member: "heat", rect: { x: 0, y: 2, w: 4, h: 1 } },
        ]),
      }),
      wire("heat", "panel"),
    ]);
    const graph = bus.store.getGraph();
    // `flash` exists and has a stored rect but is not wired: membership is the wire.
    expect(placed(graph)).toEqual(["heat@0,2,4,1"]);
    // The stored text still names it — dropped from the derivation, not from storage.
    expect(String(panelOf(graph).parameters["board"])).toContain('"flash"');
  });

  it("pulls a stored rect inside the columns and up to the type's minimum (a pad is at least 2×2)", async () => {
    const { bus } = await documentWith([
      ...FOUR,
      add("panel", "panel", "panel1", { board: board([{ member: "warp", rect: { x: 7, y: 0, w: 1, h: 1 } }], 4) }),
      wire("warp", "panel"),
    ]);
    expect(placed(bus.store.getGraph())).toEqual(["warp@2,0,2,2"]);
  });

  it("reads a malformed or empty board as nothing stored: everything flows on eight columns", () => {
    expect(parsePanelBoard("")).toEqual({ columns: 8, items: [] });
    expect(parsePanelBoard("{not json")).toEqual({ columns: 8, items: [] });
    expect(parsePanelBoard('{"columns": 6, "items": [{"member": "a", "rect": {"x": 0.5, "y": 0, "w": 1, "h": 1}}, {"label": "L", "rect": {"x": 0, "y": 0, "w": 2, "h": 1}}]}')).toEqual({
      columns: 6,
      items: [{ label: "L", rect: { x: 0, y: 0, w: 2, h: 1 } }],
    });
    const stored = { columns: 5, items: [{ member: "heat", rect: { x: 1, y: 2, w: 3, h: 1 } }] };
    expect(parsePanelBoard(serializePanelBoard(stored))).toEqual(stored);
  });

  it("a Panel laid out by its legacy Layout text has no board — its rows render as before", async () => {
    const { bus } = await documentWith([...FOUR, add("panel", "panel", "panel1", { layout: "# Desk\nheat warp" }), wire("invert", "panel")]);
    const graph = bus.store.getGraph();
    expect(panelBoard(graph, panelOf(graph))).toBeNull();
  });
});

describe("T1516b — the board survives a rename and a paste (§V320)", () => {
  const stored = [
    { label: "Look", rect: { x: 0, y: 0, w: 3, h: 1 } },
    { member: "heat", rect: { x: 0, y: 1, w: 6, h: 1 } },
    { member: "warp", rect: { x: 6, y: 0, w: 2, h: 2 } },
  ];

  it("renaming a widget keeps it where the owner put it", async () => {
    const { bus, ids } = await documentWith([...FOUR, add("panel", "panel", "panel1", { board: board(stored) }), wire("heat", "panel"), wire("warp", "panel")]);
    const before = placed(bus.store.getGraph());
    const renamed = await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setNodeLabel", nodeId: ids["$heat"]!, label: "glow" }] },
      contextFor(alice),
    );
    expect(renamed.output.status).toBe("applied");
    expect(placed(bus.store.getGraph())).toEqual(before.map((entry) => entry.replace(/^heat@/, "glow@")));
  });

  it("a pasted Panel + widgets is arranged like the original, around the COPIES, not the originals", async () => {
    const { bus, ids } = await documentWith([...FOUR, add("panel", "panel", "panel1", { board: board(stored) }), wire("heat", "panel"), wire("warp", "panel")]);
    const original = placed(bus.store.getGraph());
    await bus.execute("graph.copySelection", { nodeIds: [ids["$heat"]!, ids["$warp"]!, ids["$panel"]!] }, contextFor(alice));
    const pasted = await bus.execute("graph.paste", {}, contextFor(alice));
    expect(pasted.status).toBe("applied");
    const graph = bus.store.getGraph();
    const copy = Object.values(graph.nodes).find((node) => node.type === "panel" && node.id !== ids["$panel"])!;
    // The copies were renumbered (the names were taken) and the copy's board follows them,
    // so its members are the PASTED widgets, each at the rect the original Panel gave it.
    const names = (panelBoard(graph, copy)?.items ?? []).flatMap((item) => (item.kind === "widget" ? [item.node] : []));
    expect(names.map((node) => node.id).some((id) => id === ids["$heat"] || id === ids["$warp"])).toBe(false);
    expect(placed(graph, copy).map((entry) => entry.replace(/^(heat|warp)\d+@/, "$1@"))).toEqual(original);
    // And the original is untouched.
    expect(placed(graph, graph.nodes[ids["$panel"]!]!)).toEqual(original);
  });
});

/**
 * T1501b — a Presets bank, a Layer and a Cue List sit on a board WITHOUT a wire: none of
 * them can be wired into a value input, so the board item naming them is the membership.
 * What the owner relies on: the three he put on the Panel are there at his rects next to
 * the wired controls; a wired control still needs its wire; a node he deleted is gone from
 * the board; and — because the item is a NAME — a rename and a paste keep it pointed at the
 * right node, exactly as they do for a widget.
 */
describe("T1501b — a bank, a layer and a cue list are board members by name", () => {
  const THREE: GraphPatchOperation[] = [add("looks", "presets", "looks"), add("fx", "layer", "fx"), add("set", "cueList", "set")];
  const stored: StoredBoardItem[] = [
    { member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } },
    { member: "fx", rect: { x: 4, y: 0, w: 2, h: 1 } },
    { member: "set", rect: { x: 0, y: 1, w: 4, h: 2 } },
  ];

  it("keeps a stored item naming one of them with no wire, beside the wired widgets that flow", async () => {
    const { bus } = await documentWith([...FOUR, ...THREE, add("panel", "panel", "panel1", { board: board(stored) }), wire("heat", "panel")]);
    const graph = bus.store.getGraph();
    expect(placed(graph)).toEqual(["looks@0,0,4,1", "fx@4,0,2,1", "set@0,1,4,2", "heat@4,1,4,1"]);
    expect((panelBoard(graph, panelOf(graph))?.items ?? []).map((item) => (item.kind === "widget" ? item.node.type : "label"))).toEqual(["presets", "layer", "cueList", "slider"]);
  });

  it("an item naming any OTHER kind of node is no member: a widget still needs its wire, a blur never joins", async () => {
    const { bus } = await documentWith([
      ...FOUR,
      add("blur", "blur", "soften"),
      add("panel", "panel", "panel1", {
        board: board([
          { member: "flash", rect: { x: 0, y: 0, w: 2, h: 1 } },
          { member: "soften", rect: { x: 2, y: 0, w: 2, h: 1 } },
        ]),
      }),
    ]);
    expect(placed(bus.store.getGraph())).toEqual([]);
  });

  it("drops the item from the board when its node is deleted — the others stay where they were", async () => {
    const { bus, ids } = await documentWith([...THREE, add("panel", "panel", "panel1", { board: board(stored) })]);
    const removed = await bus.execute("graph.removeNodes", { nodeIds: [ids["$looks"]!] }, contextFor(alice));
    expect(removed.status).toBe("applied");
    expect(placed(bus.store.getGraph())).toEqual(["fx@4,0,2,1", "set@0,1,4,2"]);
  });

  it("renaming a member keeps it on the board, at its rect (the kind-6 clause rewrites the item)", async () => {
    const { bus, ids } = await documentWith([...THREE, add("panel", "panel", "panel1", { board: board(stored) })]);
    const renamed = await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setNodeLabel", nodeId: ids["$fx"]!, label: "glitch" }] },
      contextFor(alice),
    );
    expect(renamed.output.status).toBe("applied");
    expect(placed(bus.store.getGraph())).toEqual(["looks@0,0,4,1", "glitch@4,0,2,1", "set@0,1,4,2"]);
  });

  it("a pasted Panel + members shows the COPIES at the original rects, and the original keeps its own", async () => {
    const { bus, ids } = await documentWith([...THREE, add("panel", "panel", "panel1", { board: board(stored) })]);
    const original = placed(bus.store.getGraph());
    await bus.execute("graph.copySelection", { nodeIds: [ids["$looks"]!, ids["$fx"]!, ids["$set"]!, ids["$panel"]!] }, contextFor(alice));
    const pasted = await bus.execute("graph.paste", {}, contextFor(alice));
    expect(pasted.status).toBe("applied");
    const graph = bus.store.getGraph();
    const copy = Object.values(graph.nodes).find((node) => node.type === "panel" && node.id !== ids["$panel"])!;
    const members = (panelBoard(graph, copy)?.items ?? []).flatMap((item) => (item.kind === "widget" ? [item.node.id] : []));
    expect(members).toHaveLength(3);
    // Not one of the originals: a copy that pressed the ORIGINAL bank's presets would be §V320's misbind.
    expect(members.some((id) => id === ids["$looks"] || id === ids["$fx"] || id === ids["$set"])).toBe(false);
    expect(placed(graph, copy).map((entry) => entry.replace(/^(looks|fx|set)\d+@/, "$1@"))).toEqual(original);
    expect(placed(graph, graph.nodes[ids["$panel"]!]!)).toEqual(original);
  });
});
