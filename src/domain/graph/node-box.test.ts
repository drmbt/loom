import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../types/graph.ts";
import type { EdgeId, NodeId } from "../types/ids.ts";
import { boxesOverlap, nodeBox, nodePortRows } from "./node-box.ts";

/**
 * T1512b — A PANEL'S BOX GROWS WITH WHAT IS WIRED INTO IT, because its canvas body draws
 * every member live (`PanelNodeBody`). The layout gate (§V389, `src/examples/layout.test.ts`)
 * measures with `nodeBox`; while the model counted only the Panel's port rows, a Panel with
 * four widgets was ~300px taller on the canvas than in the gate, and a note placed under it
 * would overlap it with the gate green — the bug the gate exists to catch, one level up.
 *
 * The exact numbers are the browser's: `node-box.spec.ts` measures E81's four widgets and
 * its wired Panel in a real DOM (422px here is what Chromium lays out for that Panel), and
 * an empty Panel's two-line hint was measured the same way (27px).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const at = (id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode =>
  ({ id: id as NodeId, type, definitionVersion: 1, position: { x: 0, y: 0 }, label: id, parameters }) as GraphNode;

function graphOf(nodes: GraphNode[], wired: string[]): GraphDocument {
  const edges: Record<string, GraphEdge> = {};
  wired.forEach((source, order) => {
    edges[`w${order}`] = {
      id: `w${order}` as EdgeId,
      source: { nodeId: source as NodeId, portId: "out" },
      target: { nodeId: "panel" as NodeId, portId: "controls" },
      order,
    } as GraphEdge;
  });
  return { revision: 1, nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), edges, groups: {} } as unknown as GraphDocument;
}

const widgets = [at("heat", "slider"), at("invert", "toggle"), at("flash", "button"), at("warp", "xyPad")];
const panel = at("panel", "panel", { title: "Desk" });
const boxOf = (graph: GraphDocument, id: string) => nodeBox(graph.nodes[id]!, registry.get(graph.nodes[id]!.type), undefined, graph);

describe("T1512b — node-box models the Panel body from its members", () => {
  it("a Panel laid out by its override text stacks its widgets, as the browser measured", () => {
    const empty = boxOf(graphOf([...widgets, panel], []), "panel");
    expect(empty.height).toBe(103);
    // The four widgets stacked in the body (T1512b's measured 422px Panel, which then also
    // drew four more sockets on its variadic input: 4 × (14 + 2) = 64px that no Panel has
    // since T1518b, wired or not).
    const override = at("panel", "panel", { title: "Desk", layout: "heat invert flash warp" });
    expect(boxOf(graphOf([...widgets, override], []), "panel").height).toBe(422 - 64);
  });

  it("a wired widget makes the Panel taller: the XY pad's three rows outweigh a slider's one", () => {
    const withSlider = boxOf(graphOf([...widgets, panel], ["heat"]), "panel");
    const withPad = boxOf(graphOf([...widgets, panel], ["warp"]), "panel");
    expect(withPad.height).toBeGreaterThan(withSlider.height);
  });

  it("a widget that only EXISTS is not on the Panel — membership is the wire", () => {
    const unwired = boxOf(graphOf([...widgets, panel], []), "panel");
    expect(unwired.height).toBe(boxOf(graphOf([panel], []), "panel").height);
  });

  it("the gate can now see a note under a wired Panel", () => {
    const graph = graphOf([...widgets, panel], ["heat", "invert", "flash", "warp"]);
    // 120px below the Panel's top clears an UNWIRED Panel entirely (103px) and lands on the
    // board of a wired one (158px since T1518b took the per-wire sockets away; it was 222).
    const note: GraphNode = { ...at("note", "annotate"), position: { x: 0, y: 120 }, size: { width: 300, height: 100 } } as GraphNode;
    expect(boxesOverlap(boxOf(graph, "panel"), nodeBox(note, registry.get("annotate")))).toBe(true);
    expect(boxesOverlap(boxOf(graphOf([...widgets, panel], []), "panel"), nodeBox(note, registry.get("annotate")))).toBe(false);
  });
});

/**
 * T1516b — A BOARD PANEL'S BODY IS ITS BOARD, SCALED TO THE NODE: the title, then `rows`
 * square cells of `164 / columns` px (the `.controls` content width). So the box follows
 * the ARRANGEMENT, not the member count: the same four widgets on two rows are a shorter
 * Panel than on four, and a wider grid is a shorter one again. The layout gate reads this,
 * so a board rearranged in a shipped example moves its Panel's box exactly as the canvas.
 */
describe("T1516b — node-box follows the board", () => {
  const ALL = ["heat", "invert", "flash", "warp"];
  const boardPanel = (board: object) => at("panel", "panel", { title: "Desk", board: JSON.stringify(board) });
  const heightWith = (board: object) => boxOf(graphOf([...widgets, boardPanel(board)], ALL), "panel").height;
  /** Pad on the left (3×3), the rest stacked beside it: three rows. */
  const threeRows = {
    columns: 8,
    items: [
      { member: "warp", rect: { x: 0, y: 0, w: 3, h: 3 } },
      { member: "heat", rect: { x: 3, y: 0, w: 5, h: 1 } },
      { member: "invert", rect: { x: 3, y: 1, w: 2, h: 1 } },
      { member: "flash", rect: { x: 5, y: 1, w: 3, h: 1 } },
    ],
  };

  it("is the title plus rows × the canvas cell, with nothing stored (the four flow onto four rows)", () => {
    // Flowed: slider 4×1 + toggle 2×1 + button 2×1 on row 0, the pad 3×3 under them — four rows.
    const flowed = boxOf(graphOf([...widgets, panel], ALL), "panel");
    // border 2 + title 24 + controls (8 + 14.85 title + 4 gap + 4 × 20.5 + 1) + ports (8 + ONE 14px row, T1518b).
    expect(flowed.height).toBe(Math.round(2 + 24 + (8 + 14.85 + 4 + 4 * 20.5 + 1) + (8 + 14)));
  });

  it("moving a control so the board loses a row makes the Panel one canvas cell shorter", () => {
    const four = heightWith({ ...threeRows, items: [...threeRows.items.slice(0, 3), { member: "flash", rect: { x: 3, y: 3, w: 3, h: 1 } }] });
    const three = heightWith(threeRows);
    // One 20.5px cell (164 / 8); each box is rounded once, so the difference is 20 or 21.
    expect(Math.abs(four - three - 20.5)).toBeLessThanOrEqual(0.5);
  });

  it("a wider grid draws the same board with smaller cells, so a shorter Panel", () => {
    expect(heightWith({ ...threeRows, columns: 16 })).toBeLessThan(heightWith(threeRows));
  });

  it("a member's stored rect wins over where it would flow", () => {
    // Stored: everything on ONE row of a 16-wide board — one row of 10.25px cells.
    const oneRow = {
      columns: 16,
      items: [
        { member: "heat", rect: { x: 0, y: 0, w: 4, h: 1 } },
        { member: "invert", rect: { x: 4, y: 0, w: 2, h: 1 } },
        { member: "flash", rect: { x: 6, y: 0, w: 2, h: 1 } },
        { member: "warp", rect: { x: 8, y: 0, w: 2, h: 2 } },
      ],
    };
    expect(heightWith(oneRow)).toBe(Math.round(2 + 24 + (8 + 14.85 + 4 + 2 * 10.25 + 1) + (8 + 14)));
  });
});

/**
 * T1518b — THE PANEL'S CONTROLS INPUT IS ONE ROW, HOWEVER MANY WIRES LAND ON IT. The canvas
 * draws one "Controls · 4 wired" socket instead of a socket per wire plus a spare (five rows
 * on E81, a column taller than the board), so the model must stop counting them — or the
 * layout gate would reserve 64px under every wired Panel that the browser never draws, and
 * `node-box.spec.ts` (which measures E81's Panel) would say so.
 *
 * And the rule is the PANEL'S: every other variadic input still draws a socket per wire
 * (T695 — a drop needs a slot to aim at where order is the operation), so its rows still grow.
 */
describe("T1518b — a one-socket input is one port row", () => {
  const ALL = ["heat", "invert", "flash", "warp"];
  const rowsOf = (graph: GraphDocument, id: string) => nodePortRows(graph.nodes[id]!, registry.get(graph.nodes[id]!.type), graph);

  it("a Panel has one port row unwired and one with four wires", () => {
    expect(rowsOf(graphOf([...widgets, panel], []), "panel")).toBe(1);
    expect(rowsOf(graphOf([...widgets, panel], ALL), "panel")).toBe(1);
  });

  it("so wiring a control in changes the Panel's height only by what the BOARD gained", () => {
    // One row of the default board either way: a slider (4×1), then a toggle (2×1) beside it.
    const one = boxOf(graphOf([...widgets, panel], ["heat"]), "panel");
    const two = boxOf(graphOf([...widgets, panel], ["heat", "invert"]), "panel");
    expect(two.height).toBe(one.height);
    expect(one.height).toBe(Math.round(2 + 24 + (8 + 14.85 + 4 + 20.5 + 1) + (8 + 14)));
  });

  it("another variadic input still grows a row per wire, plus its spare (T695)", () => {
    const composite = at("comp", "composite");
    const layers = ["a", "b"].map((id) => at(id, "solid"));
    const edges = Object.fromEntries(
      layers.map((layer, order) => [
        `l${String(order)}`,
        { id: `l${String(order)}` as EdgeId, source: { nodeId: layer.id, portId: "out" }, target: { nodeId: composite.id, portId: "in2" }, order } as GraphEdge,
      ]),
    );
    const graph = { ...graphOf([composite, ...layers], []), edges } as GraphDocument;
    // Front (1) + Behind: two wires and the spare (3).
    expect(rowsOf(graph, "comp")).toBe(4);
  });
});

/**
 * T1515b — A LINKED INSTANCE IS ONE PIXEL TALLER THAN ITS PORTS ALONE: `.node[data-component]`
 * draws a 2px top border where every other node has a hairline. The §V389 gate lays shipped
 * examples out against this box, and `node-box.spec.ts` measured every shipped instance at
 * 165px against a modelled 164 the first time it sized one from its definition at all.
 */
describe("T1515b — node-box models a component instance's own border", () => {
  it("an instance is the same definition's box plus the thicker top border", () => {
    const definition = registry.get("blur");
    expect(definition).toBeDefined();
    const plain = nodeBox(at("plain", "blur"), definition);
    const instance = nodeBox(at("instance", "component:audioAnalysis@1"), definition);
    expect(instance.height).toBe(plain.height + 1);
    expect(instance.width).toBe(plain.width);
  });
});
