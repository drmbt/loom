import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphEdge, GraphNode } from "@domain/types/graph.ts";
import type { EdgeId, NodeId } from "@domain/types/ids.ts";
import { NOT_CONNECTED, layerStacks } from "./layer-stacks.ts";

/**
 * T1506b — THE LAYER STACKS ARE THE WIRING. The Layers tab is how a performer reads what is
 * on top of what; if it disagreed with the graph, they would switch off the wrong layer
 * mid-show. So every case here is a wiring and the stack it MUST read as: top first, as an
 * image editor lists layers, and as the compiler composites them (a layer is drawn over
 * whatever is wired into its `below`).
 */

const node = (id: string, type: string): GraphNode =>
  ({ id: id as NodeId, type, definitionVersion: 1, position: { x: 0, y: 0 }, label: id, parameters: {} }) as GraphNode;
const layer = (id: string) => node(id, "layer");

let edgeSerial = 0;
/** `from.out → to.port` */
const wire = (from: string, to: string, port: string): GraphEdge => {
  edgeSerial += 1;
  const id = `e${String(edgeSerial)}` as EdgeId;
  return { id, source: { nodeId: from as NodeId, portId: "out" }, target: { nodeId: to as NodeId, portId: port } } as GraphEdge;
};

function graph(nodes: GraphNode[], edges: GraphEdge[]): Pick<GraphDocument, "nodes" | "edges"> {
  return {
    nodes: Object.fromEntries(nodes.map((each) => [each.id, each])),
    edges: Object.fromEntries(edges.map((each) => [each.id, each])),
  };
}

describe("T1506b — layer stacks derived from the wiring", () => {
  it("reads a below-chain top first, whatever order the nodes were made in, titled by where the picture ends up", () => {
    // Made top first, so document order is the reverse of the stack: the order must come from the wires.
    const doc = graph(
      [layer("glow"), layer("smoke"), layer("city"), node("camera", "videoIn"), node("pin", "cornerPin"), node("main", "window")],
      [wire("camera", "city", "below"), wire("city", "smoke", "below"), wire("smoke", "glow", "below"), wire("glow", "pin", "input"), wire("pin", "main", "input")],
    );
    expect(layerStacks(doc)).toEqual([{ output: "main", title: "main", layers: ["glow", "smoke", "city"] }]);
  });

  it("swapping two layers' wires swaps them in the list — the view has no order of its own", () => {
    const doc = graph(
      [layer("city"), layer("smoke"), node("main", "window")],
      [wire("smoke", "city", "below"), wire("city", "main", "input")],
    );
    expect(layerStacks(doc)[0]?.layers).toEqual(["city", "smoke"]);
  });

  it("each output is its own stack, titled by it", () => {
    const doc = graph(
      [layer("a1"), layer("a2"), layer("b1"), node("left", "window"), node("right", "window")],
      [wire("a1", "a2", "below"), wire("a2", "left", "input"), wire("b1", "right", "input")],
    );
    expect(layerStacks(doc)).toEqual([
      { output: "left", title: "left", layers: ["a2", "a1"] },
      { output: "right", title: "right", layers: ["b1"] },
    ]);
  });

  it("a layer wired to nothing is a stack of one, Not connected", () => {
    const doc = graph([layer("spare"), layer("lit"), node("main", "window")], [wire("lit", "main", "input")]);
    expect(layerStacks(doc)).toEqual([
      { output: null, title: NOT_CONNECTED, layers: ["spare"] },
      { output: "main", title: "main", layers: ["lit"] },
    ]);
  });

  it("an FX node between two layers ends one stack: only a layer-to-layer `below` stacks", () => {
    const doc = graph(
      [layer("under"), node("blur", "blur"), layer("over"), node("main", "window")],
      [wire("under", "blur", "input"), wire("blur", "over", "below"), wire("over", "main", "input")],
    );
    expect(layerStacks(doc)).toEqual([
      { output: "main", title: "main", layers: ["under"] },
      { output: "main", title: "main", layers: ["over"] },
    ]);
  });

  it("a layer wired into another's PICTURE is not under it — picture is what a layer shows, below is what it sits on", () => {
    const doc = graph(
      [layer("inset"), layer("frame"), node("main", "window")],
      [wire("inset", "frame", "picture"), wire("frame", "main", "input")],
    );
    expect(layerStacks(doc).map((stack) => stack.layers)).toEqual([["inset"], ["frame"]]);
  });

  it("two layers standing on one: two stacks, and the shared layer is in both — each list is what its output shows", () => {
    const doc = graph(
      [layer("base"), layer("left"), layer("right"), node("l", "window"), node("r", "window")],
      [wire("base", "left", "below"), wire("base", "right", "below"), wire("left", "l", "input"), wire("right", "r", "input")],
    );
    expect(layerStacks(doc)).toEqual([
      { output: "l", title: "l", layers: ["left", "base"] },
      { output: "r", title: "r", layers: ["right", "base"] },
    ]);
  });

  it("a loop of layers — refused by the compiler, but a file can hold one — still ends, and lists every layer exactly once", () => {
    const doc = graph(
      [layer("a"), layer("b"), layer("c"), layer("self")],
      [wire("a", "b", "below"), wire("b", "c", "below"), wire("c", "a", "below"), wire("self", "self", "below")],
    );
    const stacks = layerStacks(doc);
    expect(stacks.flatMap((stack) => stack.layers).sort()).toEqual(["a", "b", "c", "self"]);
    // The loop starts at its first layer in document order and walks down until it comes round.
    expect(stacks.map((stack) => stack.layers)).toEqual([["a", "c", "b"], ["self"]]);
  });

  it("a document with no layer has no stacks", () => {
    expect(layerStacks(graph([node("main", "window")], []))).toEqual([]);
  });
});
