import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { blurNode } from "@nodes/definitions/filters.ts";
import { solidNode } from "@nodes/definitions/solid.ts";
import { mouseNode, valueLagNode } from "@nodes/definitions/value-graph-nodes.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { parameterDropOperations } from "./parameter-drop.ts";

/**
 * T1351b — a channel socket dropped on a parameter row writes the §T897 expression and
 * keeps the old value as the retained static. Exact operations (§V147); every refusal is
 * the empty list, which is what the canvas reads as "nothing happened".
 */
const registry = createNodeRegistry([mouseNode, valueLagNode, blurNode, solidNode]).view();
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id: id as NodeId,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters: {},
  ...extra,
});
const graph: GraphDocument = {
  revision: 1,
  nodes: Object.fromEntries(
    [
      node("m", "mouse", { label: "mouse1" }),
      node("lag", "valueLag", { label: "lag1", parameters: { lag: 0.6 } }),
      node("blur", "blur", { label: "blur1" }),
      node("solid", "solid", { label: "solid1" }),
      node("ghost", "mouse"),
    ].map((n) => [n.id, n]),
  ),
  edges: {},
  groups: {},
};
const from = (channel?: string) => ({ nodeId: "m" as NodeId, portId: "out", ...(channel === undefined ? {} : { channel }) });

describe("T1351b — a channel socket onto a parameter", () => {
  it("writes `op('<label>').chan.<channel>` and retains the value that was there", () => {
    expect(parameterDropOperations(graph, registry, from("x"), { nodeId: "lag" as NodeId, key: "lag" })).toEqual([
      {
        op: "setParameters",
        nodeId: "lag",
        parameters: {
          lag: {
            mode: "expression",
            bindings: { static: { kind: "static", value: 0.6 }, expression: { kind: "expression", source: "op('mouse1').chan.x" } },
          },
        },
      },
    ]);
    // A parameter never set retains the definition's default.
    const [op] = parameterDropOperations(graph, registry, from("y"), { nodeId: "lag" as NodeId, key: "releaseRatio" });
    expect(op).toMatchObject({ op: "setParameters", parameters: { releaseRatio: { bindings: { static: { value: 1 } } } } });
  });

  it("refuses silently: the whole-bag socket, a texture source, a compound parameter, an unlabelled source, a missing key", () => {
    expect(parameterDropOperations(graph, registry, from(), { nodeId: "lag" as NodeId, key: "lag" })).toEqual([]);
    expect(parameterDropOperations(graph, registry, { nodeId: "solid" as NodeId, portId: "out", channel: "r" }, { nodeId: "lag" as NodeId, key: "lag" })).toEqual([]);
    expect(parameterDropOperations(graph, registry, from("x"), { nodeId: "solid" as NodeId, key: "color" })).toEqual([]);
    expect(parameterDropOperations(graph, registry, { nodeId: "ghost" as NodeId, portId: "out", channel: "x" }, { nodeId: "lag" as NodeId, key: "lag" })).toEqual([]);
    expect(parameterDropOperations(graph, registry, from("x"), { nodeId: "lag" as NodeId, key: "nope" })).toEqual([]);
  });

  it("drives a number on a texture node too — the target only has to be a number or a toggle", () => {
    const [op] = parameterDropOperations(graph, registry, from("buttons"), { nodeId: "blur" as NodeId, key: "size" });
    expect(op).toMatchObject({ op: "setParameters", nodeId: "blur", parameters: { size: { bindings: { expression: { source: "op('mouse1').chan.buttons" } } } } });
  });
});
