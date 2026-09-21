import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphEdge, GraphNode } from "@domain/types/graph.ts";
import type { EdgeId, NodeId } from "@domain/types/ids.ts";
import { mouseNode, valueLagNode, valueSelectNode } from "@nodes/definitions/value-graph-nodes.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { replaceEdgeOperations, spliceNodeOperations } from "./edge-drop.ts";

/**
 * T1350b — a per-channel wire through the two edge-drop gestures. The channel belongs to
 * the wire's SOURCE end: a re-target keeps it, a re-source takes the dragged socket's, and
 * a splice leaves it on the upstream half only, because the spliced node publishes a bag
 * of its own. Each case is the exact operation list (§V147).
 */
const registry = createNodeRegistry([mouseNode, valueSelectNode, valueLagNode]).view();
const node = (id: string, type: string): GraphNode => ({ id: id as NodeId, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} });
const picked: GraphEdge = { id: "e1" as EdgeId, source: { nodeId: "m" as NodeId, portId: "out" }, target: { nodeId: "pick" as NodeId, portId: "in" }, channel: "x" };
const graph: GraphDocument = {
  revision: 1,
  nodes: Object.fromEntries([node("m", "mouse"), node("pick", "valueSelect"), node("lag", "valueLag")].map((n) => [n.id, n])),
  edges: { e1: picked },
  groups: {},
};

describe("T1350b — edge drops keep or take the channel", () => {
  it("re-targeting a per-channel wire keeps its channel", () => {
    const operations = replaceEdgeOperations(graph, registry, picked, { nodeId: "lag" as NodeId, portId: "in", direction: "input" });
    expect(operations).toEqual([
      { op: "disconnect", edgeIds: ["e1"] },
      { op: "connect", source: { nodeId: "m", portId: "out" }, target: { nodeId: "lag", portId: "in" }, channel: "x" },
    ]);
  });

  it("re-sourcing from another channel socket of the SAME port is a real change, and carries the new channel", () => {
    const operations = replaceEdgeOperations(graph, registry, picked, { nodeId: "m" as NodeId, portId: "out", direction: "output", channel: "y" });
    expect(operations).toEqual([
      { op: "disconnect", edgeIds: ["e1"] },
      { op: "connect", source: { nodeId: "m", portId: "out" }, target: { nodeId: "pick", portId: "in" }, channel: "y" },
    ]);
    // The same socket it already hangs from: nothing to do.
    expect(replaceEdgeOperations(graph, registry, picked, { nodeId: "m" as NodeId, portId: "out", direction: "output", channel: "x" })).toEqual([]);
    // The whole-bag socket of the same port is a different wire too.
    expect(replaceEdgeOperations(graph, registry, picked, { nodeId: "m" as NodeId, portId: "out", direction: "output" })).toHaveLength(2);
  });

  it("splicing a node onto a per-channel wire keeps the channel on the upstream half only", () => {
    const operations = spliceNodeOperations(graph, registry, picked, "lag" as NodeId);
    expect(operations).toEqual([
      { op: "disconnect", edgeIds: ["e1"] },
      { op: "connect", source: { nodeId: "m", portId: "out" }, target: { nodeId: "lag", portId: "in" }, channel: "x" },
      { op: "connect", source: { nodeId: "lag", portId: "out" }, target: { nodeId: "pick", portId: "in" } },
    ]);
  });
});
