import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import { referenceCycleDiagnostics, referenceCyclesThrough } from "./reference-cycles.ts";

/**
 * The authoring-time `op()` cycle gate (T331, §V152, §V244).
 *
 * The runtime reader already NAMES such a loop instead of overflowing the stack, and
 * §V244 is about exactly that comfort: a document should never hold the cycle for the
 * guard to catch. So what is asserted here is refusal — with the path in the message,
 * because a user who joined two nodes has to be told which two.
 */

const expression = (source: string) => ({
  mode: "expression" as const,
  bindings: { expression: { kind: "expression" as const, source } },
});

function node(id: string, label: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type: "test.node", definitionVersion: 1, position: { x: 0, y: 0 }, label, parameters };
}

function graphOf(...nodes: GraphNode[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {},
    groups: {},
  };
}

describe("op() reference cycles (§V152)", () => {
  it("names the path of a two-node loop", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });

    const [found] = referenceCyclesThrough(graphOf(a, b), "n1");
    expect(found?.code).toBe("parameter.referenceCycle");
    // The PATH, not just the fact: "somewhere in your document" is not actionable.
    expect(found?.message).toContain("a.gain → b.gain → a");
  });

  it("catches a node referencing itself", () => {
    const self = node("n1", "a", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(self), "n1")).toHaveLength(1);
  });

  it("catches a loop that closes through a third node", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('c').par.gain") });
    const c = node("n3", "c", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(a, b, c), "n2")).toHaveLength(1);
  });

  it("sees a reference carried by a COMPONENT slot (§V113)", () => {
    // `color.r` is an ordinary carrier of an expression, so a loop can close through one
    // — and a gate that only walked bare keys would let exactly that through.
    const a = node("n1", "a", { "color.r": expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.color.g") });
    const [found] = referenceCyclesThrough(graphOf(a, b), "n1");
    // §B293: a compound resolves WHOLE, so its components are one member of a ring:
    // `color.g` is read through `color`, which `color.r` is part of.
    expect(found?.message).toContain("a.color.r → b.gain → a.color.r");
  });

  it("leaves a node that only READS a cycle alone", () => {
    // Reachability is not membership: `reader` is not part of the loop, and refusing its
    // edits would spread one document's damage over the nodes near it.
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const reader = node("n3", "reader", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(a, b, reader), "n3")).toEqual([]);
  });

  it("is not fooled by a diamond: two paths to one node are not a loop", () => {
    const src = node("n1", "src", { gain: 1 });
    const left = node("n2", "left", { gain: expression("op('src').par.gain") });
    const right = node("n3", "right", { gain: expression("op('src').par.gain") });
    const join = node("n4", "join", { gain: expression("op('left').par.gain + op('right').par.gain") });
    const graph = graphOf(src, left, right, join);
    expect(referenceCycleDiagnostics(graph)).toEqual([]);
    expect(referenceCyclesThrough(graph, "n4")).toEqual([]);
  });

  it("ignores a RETAINED expression on a parameter that is not in expression mode (§V108)", () => {
    // The corner mark's promise: an inactive payload is data, not a dependency. Counting
    // it would make flipping to Constant fail to break a loop the user just broke.
    const a = node("n1", "a", {
      gain: { mode: "static", bindings: { static: { kind: "static", value: 1 }, expression: { kind: "expression", source: "op('b').par.gain" } } },
    });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(a, b), "n1")).toEqual([]);
  });

  it("does not call a DANGLING reference a cycle", () => {
    // `op('ghost')` is reported at resolution, on the parameter that carries it. Refusing
    // the patch would make an expression unwritable until its target exists.
    const a = node("n1", "a", { gain: expression("op('ghost').par.gain") });
    expect(referenceCyclesThrough(graphOf(a), "n1")).toEqual([]);
  });

  it("reports a loop ONCE for the whole document, not once per member", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    expect(referenceCycleDiagnostics(graphOf(a, b))).toHaveLength(1);
  });

  it("reports two independent loops separately", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const c = node("n3", "c", { gain: expression("op('d').par.gain") });
    const d = node("n4", "d", { gain: expression("op('c').par.gain") });
    expect(referenceCycleDiagnostics(graphOf(a, b, c, d))).toHaveLength(2);
  });

  it("⚑ B293 — two nodes that read each other's UNRELATED parameters are not a ring", () => {
    /**
     * This test asserted the opposite, and said why: the reader resolved the target's whole
     * schema, so reading `b.gain` resolved `b.other` on the way past and the recursion was
     * real. It was what failed if someone made one half finer without the other (§V61).
     * Both halves moved: the reader resolves the one parameter it is asked for
     * (`node-references.test.ts` holds the same shape through the real resolve).
     */
    const a = node("n1", "a", { gain: expression("op('b').par.gain"), other: 2 });
    const b = node("n2", "b", { gain: 3, other: expression("op('a').par.other") });
    expect(referenceCyclesThrough(graphOf(a, b), "n1")).toEqual([]);
    expect(referenceCycleDiagnostics(graphOf(a, b))).toEqual([]);
  });
});

/**
 * §B293 — A RING IS OVER (node, key). Found by a camera whose Look At z was written as the
 * length of its own Heading and refused as "a cycle": one node, two parameters, no ring.
 */
describe("B293 — the ring is over (node, key)", () => {
  it("⚑ one key reading another key of the SAME node is not a ring, and neither is a chain of three", () => {
    const one = node("n1", "a", { gain: expression("op('a').par.other * 2"), other: 3 });
    expect(referenceCyclesThrough(graphOf(one), "n1")).toEqual([]);
    const three = node("n1", "a", { first: expression("op('a').par.second + 1"), second: expression("op('a').par.third + 1"), third: 1 });
    expect(referenceCyclesThrough(graphOf(three), "n1")).toEqual([]);
    expect(referenceCycleDiagnostics(graphOf(three))).toEqual([]);
  });

  it("⚑ a reads b reads a on ONE node is a ring, named by its two parameters", () => {
    const ring = node("n1", "a", { gain: expression("op('a').par.other"), other: expression("op('a').par.gain") });
    const [found, ...rest] = referenceCyclesThrough(graphOf(ring), "n1");
    expect(rest).toEqual([]);
    expect(found?.code).toBe("parameter.referenceCycle");
    expect(found?.message).toBe("Parameter reference chain is circular: a.gain → a.other → a.gain.");
    expect(found?.nodeId).toBe("n1");
  });

  it("a parameter reading ITSELF is a ring of one", () => {
    const self = node("n1", "a", { gain: expression("op('a').par.gain + 1") });
    expect(referenceCyclesThrough(graphOf(self), "n1")[0]?.message).toBe("Parameter reference chain is circular: a.gain → a.gain.");
    // One component of a vector reading another is the vector reading itself: it resolves whole.
    const vector = node("n1", "a", { "aim.z": expression("op('a').par.aim.x") });
    expect(referenceCyclesThrough(graphOf(vector), "n1")[0]?.message).toBe("Parameter reference chain is circular: a.aim.z → a.aim.z.");
  });

  it("a ring through two nodes names all four of its hops' parameters, in order", () => {
    const a = node("n1", "a", { gain: expression("op('b').par.other") });
    const b = node("n2", "b", { other: expression("op('a').par.gain") });
    expect(referenceCycleDiagnostics(graphOf(a, b))[0]?.message).toBe("Parameter reference chain is circular: a.gain → b.other → a.gain.");
  });

  it("⚑ a ring through a CHANNEL the node composes from its own parameters is a ring, and names the channel", () => {
    // A camera's `chan.distance` is composed from its Eye and Look At (the definition says so).
    const channels = (target: GraphNode): readonly string[] | null => (target.type === "test.camera" ? ["eye", "lookAt"] : null);
    const camera = { ...node("n1", "cam", { "lookAt.z": expression("0 - op('cam').chan.distance") }), type: "test.camera" };
    const [found] = referenceCyclesThrough(graphOf(camera), "n1", channels);
    expect(found?.message).toBe("Parameter reference chain is circular: cam.lookAt.z → cam.chan.distance → cam.lookAt.z.");
    // A parameter the channel is NOT composed from may read it: that is the consumer's own use.
    const fine = { ...node("n1", "cam", { fov: expression("op('cam').chan.distance * 10") }), type: "test.camera" };
    expect(referenceCyclesThrough(graphOf(fine), "n1", channels)).toEqual([]);
    // And with nobody to say what the channel is composed from, a channel read is no edge.
    expect(referenceCyclesThrough(graphOf(camera), "n1")).toEqual([]);
  });

  it("a value node's channel is made from ALL its parameters: reading it from one of them is a ring", () => {
    const all = (): "all" => "all";
    const lfo = node("n1", "lfo", { rate: expression("op('lfo').chan.value + 1") });
    expect(referenceCyclesThrough(graphOf(lfo), "n1", all)[0]?.message).toBe("Parameter reference chain is circular: lfo.rate → lfo.chan.value → lfo.rate.");
    // Two value nodes reading each other's channels, as before the grain changed.
    const a = node("n1", "a", { rate: expression("op('b').chan.value") });
    const b = node("n2", "b", { rate: expression("op('a').chan.value") });
    expect(referenceCycleDiagnostics(graphOf(a, b), all)).toHaveLength(1);
  });

  it("a ring that is part BIND and part op() is seen; a ring of binds alone is the bind gate's", () => {
    const bind = (ref: string) => ({ mode: "bind" as const, bindings: { bind: { kind: "bind" as const, ref } } });
    const mixed = node("n1", "a", { gain: bind("other"), other: expression("op('a').par.gain") });
    expect(referenceCyclesThrough(graphOf(mixed), "n1")[0]?.message).toBe("Parameter reference chain is circular: a.other → a.gain → a.other.");
    const binds = node("n1", "a", { gain: bind("other"), other: bind("gain") });
    expect(referenceCycleDiagnostics(graphOf(binds))).toEqual([]);
  });

  it("a long chain is walked without a ring, and a ring at its end is found from the far node", () => {
    // 400 nodes, each reading the next: no ring. Close it and it is one ring, 400 long.
    const chain = Array.from({ length: 400 }, (_, index) => node(`n${String(index)}`, `v${String(index)}`, { gain: index === 399 ? 1 : expression(`op('v${String(index + 1)}').par.gain`) }));
    expect(referenceCycleDiagnostics(graphOf(...chain))).toEqual([]);
    chain[399] = node("n399", "v399", { gain: expression("op('v0').par.gain") });
    const found = referenceCycleDiagnostics(graphOf(...chain));
    expect(found).toHaveLength(1);
    expect(referenceCyclesThrough(graphOf(...chain), "n200")).toHaveLength(1);
  });
});

describe("the feedback kind is EXEMPT (T350/§V285)", () => {
  it("a feedback reference closing a loop is not a refusable cycle — closing it is its job", () => {
    // over reads op('echo') in an expression; echo names over as its source. Through
    // the walk that is a cycle — and it is exactly the legal one the temporal split
    // exists for. The gate rules on `reference` chains only.
    const graph = {
      revision: 1,
      nodes: {
        mix: {
          id: "mix",
          type: "over",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {
            opacity: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('echo1').par.persistence" } } },
          },
          label: "over1",
        },
        echo: {
          id: "echo",
          type: "feedback",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { source: "over1" },
          label: "echo1",
        },
      },
      edges: {},
      groups: {},
    } as never;
    expect(referenceCycleDiagnostics(graph)).toEqual([]);
  });
});
