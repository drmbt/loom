import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphEdge, GraphNode } from "@domain/types/graph.ts";
import type { ParameterDefinition } from "@domain/types/parameters.ts";
import { channelPickAvailable } from "./channel-pick-parameters.ts";

/**
 * §T1390b — what a channel picker may offer is what ARRIVES on its declared input: each
 * wired source's published channels, in wire order then publication order. Asserted on
 * the list the picker shows, since that list is the whole of what a user can choose.
 */

const node = (id: string, label?: string): GraphNode => ({
  id,
  type: "valueSelect",
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters: {},
  ...(label === undefined ? {} : { label }),
});

function graphOf(nodes: GraphNode[], edges: GraphEdge[]): GraphDocument {
  return {
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
  } as unknown as GraphDocument;
}

const channels: ParameterDefinition = { type: "string", label: "Channels", default: "*", channelsFrom: "in" };
const plain: ParameterDefinition = { type: "string", label: "Name", default: "" };
const published: Record<string, readonly string[]> = {
  audio1: ["level", "low", "band109"],
  mouse1: ["x", "y", "low"],
};
const channelsOf = (name: string) => published[name] ?? [];

describe("the channels a picker offers", () => {
  it("unions every wired source in wire order, without repeats, and only for declared rows", () => {
    const graph = graphOf(
      [node("pick"), node("a", "audio1"), node("m", "mouse1")],
      [
        { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "pick", portId: "in" } },
        { id: "e2", source: { nodeId: "m", portId: "out" }, target: { nodeId: "pick", portId: "in" } },
      ],
    );
    const rows = channelPickAvailable(
      graph,
      graph.nodes["pick"] as GraphNode,
      [
        { key: "channels", definition: channels },
        { key: "name", definition: plain },
      ],
      channelsOf,
    );
    expect(rows.get("channels")).toEqual(["level", "low", "band109", "x", "y"]);
    expect(rows.has("name")).toBe(false);
  });

  it("offers only the channel a channel-carrying wire delivers", () => {
    const graph = graphOf(
      [node("pick"), node("a", "audio1")],
      [{ id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "pick", portId: "in" }, channel: "band109" }],
    );
    const rows = channelPickAvailable(graph, graph.nodes["pick"] as GraphNode, [{ key: "channels", definition: channels }], channelsOf);
    expect(rows.get("channels")).toEqual(["band109"]);
  });

  it("offers nothing from a wire into another port, an unlabelled source, or a host with no lookup", () => {
    const graph = graphOf(
      [node("pick"), node("a", "audio1"), node("u")],
      [
        { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "pick", portId: "other" } },
        { id: "e2", source: { nodeId: "u", portId: "out" }, target: { nodeId: "pick", portId: "in" } },
      ],
    );
    const entries = [{ key: "channels", definition: channels }];
    expect(channelPickAvailable(graph, graph.nodes["pick"] as GraphNode, entries, channelsOf).get("channels")).toEqual([]);
    const wired = graphOf(
      [node("pick"), node("a", "audio1")],
      [{ id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "pick", portId: "in" } }],
    );
    expect(channelPickAvailable(wired, wired.nodes["pick"] as GraphNode, entries, undefined).get("channels")).toEqual([]);
  });
});
