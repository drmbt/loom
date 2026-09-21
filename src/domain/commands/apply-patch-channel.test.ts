import { beforeEach, describe, expect, it } from "vitest";

import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { graphEdgeSchema, graphPatchOperationSchema } from "../types/schemas.ts";
import type { LoomBus } from "./bus.ts";
import { createDomainBus } from "./index.ts";
import { alice, contextFor, patch } from "./test-support.ts";

/**
 * T1350b — a per-channel wire at the PATCH layer, against the real registry (the shared
 * test registry has no value node, and a value port is the whole point).
 *
 * What a `connect` with `channel` must do: land on a value port with the channel on the
 * edge; REFUSE by name on any other port kind (a texture has no channels, and a silent
 * accept would write a field nothing reads); count two channels from one port as two
 * wires; survive copy → paste; and parse at both schema boundaries.
 */
let store: GraphStore;
let bus: LoomBus;

beforeEach(() => {
  store = createGraphStore({ ids: createSequentialIdFactory("c"), now: () => "2026-09-21T00:00:00.000Z" });
  bus = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() }).bus;
});

const apply = (operations: GraphPatchOperation[], label = "test") =>
  bus.execute("graph.applyPatch", patch(store.view.getRevision(), operations, label), contextFor(alice));

const edges = () => Object.values(store.view.getGraph().edges);

describe("T1350b — connect with a channel", () => {
  it("lands on a value port with the channel on the edge, and two channels from one port are two wires", async () => {
    const result = await apply([
      { op: "addNode", ref: "$m", type: "mouse", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$math", type: "valueMath", position: { x: 200, y: 0 } },
      { op: "connect", source: { nodeId: "$m", portId: "out" }, target: { nodeId: "$math", portId: "a" }, channel: "x" },
      { op: "connect", source: { nodeId: "$m", portId: "out" }, target: { nodeId: "$math", portId: "b" }, channel: "y" },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("applied");
    expect(edges().map((edge) => [edge.target.portId, edge.channel])).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
    // A wire with no channel keeps no field at all — the document shape before T1350b (§V68).
    const mouse = Object.values(store.view.getGraph().nodes).find((node) => node.type === "mouse")!.id;
    const plain = await apply([
      { op: "addNode", ref: "$pick", type: "valueSelect", position: { x: 200, y: 200 } },
      { op: "connect", source: { nodeId: mouse, portId: "out" }, target: { nodeId: "$pick", portId: "in" } },
    ]);
    expect(plain.diagnostics).toEqual([]);
    expect(plain.status).toBe("applied");
    expect(edges().find((edge) => edge.target.portId === "in")).not.toHaveProperty("channel");
  });

  it("refuses by name on a texture port — a texture has no channels to wire one of", async () => {
    const result = await apply([
      { op: "addNode", ref: "$s", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "blur", position: { x: 200, y: 0 } },
      { op: "connect", source: { nodeId: "$s", portId: "out" }, target: { nodeId: "$b", portId: "input" }, channel: "r" },
    ]);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((d) => d.code)).toContain("port.channel");
    expect(Object.keys(store.view.getGraph().nodes)).toEqual([]);
  });

  it("does not bypass §V14: a second channel aimed at an occupied value port is refused as occupied", async () => {
    await apply([
      { op: "addNode", ref: "$m", type: "mouse", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$pick", type: "valueSelect", position: { x: 200, y: 0 } },
    ]);
    const [m, pick] = Object.keys(store.view.getGraph().nodes);
    const first = await apply([{ op: "connect", source: { nodeId: m!, portId: "out" }, target: { nodeId: pick!, portId: "in" }, channel: "x" }]);
    expect(first.status).toBe("applied");
    const other = await apply([{ op: "connect", source: { nodeId: m!, portId: "out" }, target: { nodeId: pick!, portId: "in" }, channel: "y" }]);
    expect(other.status).toBe("rejected");
    expect(other.diagnostics.map((d) => d.code)).toContain("port.occupied");
    expect(edges().map((edge) => edge.channel)).toEqual(["x"]);
  });

  it("survives copy → paste: the pasted wire names the same channel", async () => {
    await apply([
      { op: "addNode", ref: "$m", type: "mouse", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$pick", type: "valueSelect", position: { x: 200, y: 0 } },
      { op: "connect", source: { nodeId: "$m", portId: "out" }, target: { nodeId: "$pick", portId: "in" }, channel: "buttons" },
    ]);
    const nodeIds = Object.keys(store.view.getGraph().nodes);
    const copied = await bus.execute("graph.copySelection", { nodeIds }, contextFor(alice));
    expect(copied.status).toBe("applied");
    const pasted = await bus.execute("graph.paste", {}, contextFor(alice));
    expect(pasted.status).toBe("applied");
    expect(edges().map((edge) => edge.channel)).toEqual(["buttons", "buttons"]);
  });

  it("parses at both boundaries: the document edge and the patch operation", () => {
    expect(graphEdgeSchema.safeParse({ id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" }, channel: "band109" }).success).toBe(true);
    expect(graphPatchOperationSchema.safeParse({ op: "connect", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" }, channel: "band109" }).success).toBe(true);
    // An empty channel name is not a channel.
    expect(graphEdgeSchema.safeParse({ id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" }, channel: "" }).success).toBe(false);
  });
});
