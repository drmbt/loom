import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../types/graph.ts";
import type { EdgeId, NodeId } from "../types/ids.ts";
import { boxesOverlap, nodeBox } from "./node-box.ts";

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
  it("a Panel with four wired widgets is as tall as its body draws them, not four port rows taller", () => {
    const empty = boxOf(graphOf([...widgets, panel], []), "panel");
    const wired = boxOf(graphOf([...widgets, panel], ["heat", "invert", "flash", "warp"]), "panel");
    expect(empty.height).toBe(103);
    expect(wired.height).toBe(422);
    // Four more sockets on the variadic input are 4 × (14 + 2) = 64px; the rest is the body.
    expect(wired.height - empty.height).toBeGreaterThan(64 + 200);
  });

  it("each wired widget adds its own body: the XY pad's square outweighs a slider", () => {
    const withSlider = boxOf(graphOf([...widgets, panel], ["heat"]), "panel");
    const withPad = boxOf(graphOf([...widgets, panel], ["warp"]), "panel");
    expect(withPad.height - withSlider.height).toBeGreaterThan(100);
  });

  it("a widget that only EXISTS is not on the Panel — membership is the wire", () => {
    const unwired = boxOf(graphOf([...widgets, panel], []), "panel");
    expect(unwired.height).toBe(boxOf(graphOf([panel], []), "panel").height);
  });

  it("the gate can now see a note under a wired Panel", () => {
    const graph = graphOf([...widgets, panel], ["heat", "invert", "flash", "warp"]);
    // 200px below the Panel's top clears its title and port rows and lands on its body.
    const note: GraphNode = { ...at("note", "annotate"), position: { x: 0, y: 200 }, size: { width: 300, height: 100 } } as GraphNode;
    expect(boxesOverlap(boxOf(graph, "panel"), nodeBox(note, registry.get("annotate")))).toBe(true);
  });
});
