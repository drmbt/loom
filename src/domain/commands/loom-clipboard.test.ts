import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { alice, contextFor } from "./test-support.ts";
import { createDomainBus } from "./index.ts";
import { decodeLoomClipboard, encodeLoomClipboard } from "./loom-clipboard.ts";
import type { SystemClipboard } from "./loom-clipboard.ts";

/**
 * §T1393b — copy in one window, paste in another. Two buses are two windows (two
 * documents); what joins them is one system clipboard. Asserted on the document each
 * paste produces, which is what the user reads back.
 */

const context = contextFor(alice);

/** One clipboard both "windows" share, holding text and Loom's slot like the browser's. */
function sharedClipboard(): SystemClipboard & { text: string | null; loom: string | null } {
  const clip = {
    text: null as string | null,
    loom: null as string | null,
    write(text: string, loom?: string) {
      clip.text = text;
      clip.loom = loom ?? null;
    },
    read: async () => ({ text: clip.text, loom: clip.loom }),
  };
  return clip;
}

async function windowWith(clipboard: SystemClipboard, prefix: string, nodes: ReadonlyArray<{ type: string; label?: string; parameters?: Record<string, unknown> }>) {
  const { bus } = createDomainBus({
    registry: createNodeRegistry(allNodeDefinitions).view(),
    ids: createSequentialIdFactory(prefix),
    systemClipboard: clipboard,
  });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: nodes.map((node, index) => ({
        op: "addNode" as const,
        ref: `$${String(index)}` as const,
        type: node.type,
        position: { x: index * 200, y: 0 },
        ...(node.label === undefined ? {} : { label: node.label }),
        ...(node.parameters === undefined ? {} : { parameters: node.parameters as never }),
      })),
    },
    context,
  );
  const ids = nodes.map((_, index) => created.output.createdIds[`$${String(index)}`] as NodeId);
  const node = (id: NodeId): GraphNode => bus.store.getGraph().nodes[id] as GraphNode;
  return { bus, ids, node };
}

describe("the Loom clipboard envelope", () => {
  it("round-trips each kind, and reads no foreign JSON as a Loom copy", () => {
    const channel = { kind: "channel", channel: { nodeName: "lfo1", channel: "value", value: 0.5 } } as const;
    expect(decodeLoomClipboard(encodeLoomClipboard(channel))).toEqual(channel);
    expect(decodeLoomClipboard('{"kind":"channel","channel":{"nodeName":"a","channel":"b"}}')).toBeNull();
    expect(decodeLoomClipboard("op('lfo1').chan.value")).toBeNull();
  });
});

describe("nodes cross windows", () => {
  it("pastes a node selection copied in another window, wires included, under new ids", async () => {
    const clipboard = sharedClipboard();
    const a = await windowWith(clipboard, "a", [{ type: "checker", label: "chk" }, { type: "blur", label: "soft" }]);
    await a.bus.execute("graph.applyPatch", {
      baseRevision: a.bus.store.getRevision(),
      operations: [{ op: "connect", source: { nodeId: a.ids[0]!, portId: "out" }, target: { nodeId: a.ids[1]!, portId: "input" } }],
    }, context);
    await a.bus.execute("graph.copySelection", { nodeIds: [...a.ids] }, context);

    const b = await windowWith(clipboard, "b", []);
    const pasted = await b.bus.execute("graph.paste", {}, context);
    expect(pasted.status).toBe("applied");
    const graph = b.bus.store.getGraph();
    expect(Object.values(graph.nodes).map((node) => [node.type, node.label]).sort()).toEqual([["blur", "soft"], ["checker", "chk"]]);
    expect(Object.values(graph.edges)).toHaveLength(1);
  });

  it("refuses BY NAME a component instance the other document does not have", async () => {
    const clipboard = sharedClipboard();
    clipboard.write(
      encodeLoomClipboard({
        kind: "nodes",
        nodes: [{ sourceId: "x", type: "component:bloomy@1", label: "glow", position: { x: 0, y: 0 }, parameters: {} }],
        edges: [],
      }),
    );
    const b = await windowWith(clipboard, "b", []);
    const pasted = await b.bus.execute("graph.paste", {}, context);
    expect(pasted.status).toBe("rejected");
    expect(pasted.diagnostics?.[0]?.message).toContain("component:bloomy@1");
    expect(Object.keys(b.bus.store.getGraph().nodes)).toEqual([]);
  });
});

describe("parameters and channels cross windows, and paste chooses the form", () => {
  it("pastes another window's parameter as its reference, its value, or its node's NAME", async () => {
    const clipboard = sharedClipboard();
    const a = await windowWith(clipboard, "a", [{ type: "blur", label: "soft", parameters: { size: 7 } }]);
    await a.bus.execute("parameter.copy", { nodeId: a.ids[0]!, parameterKey: "size" }, context);
    // The text a person pastes by hand is the reference (§V148).
    expect(clipboard.text).toBe("op('soft').par.size");

    const b = await windowWith(clipboard, "b", [{ type: "blur", label: "other" }, { type: "window", label: "win" }]);
    await b.bus.execute("parameter.paste", { nodeId: b.ids[0]!, parameterKey: "size", as: "value" }, context);
    expect(b.node(b.ids[0]!).parameters["size"]).toBe(7);
    await b.bus.execute("parameter.paste", { nodeId: b.ids[0]!, parameterKey: "size", as: "reference" }, context);
    expect(b.node(b.ids[0]!).parameters["size"]).toMatchObject({ mode: "expression", bindings: { expression: { source: "op('soft').par.size" } } });
    await b.bus.execute("parameter.paste", { nodeId: b.ids[1]!, parameterKey: "source", as: "name" }, context);
    expect(b.node(b.ids[1]!).parameters["source"]).toBe("soft");
  });

  it("copies a CHANNEL: reference drives a parameter live, name fills a Select, value lands the reading", async () => {
    const clipboard = sharedClipboard();
    const a = await windowWith(clipboard, "a", [{ type: "lfo", label: "lfo1" }]);
    const copied = await a.bus.execute("channel.copy", { nodeId: a.ids[0]!, channel: "value", value: 0.25 }, context);
    expect(copied.output.text).toBe("op('lfo1').chan.value");

    const b = await windowWith(clipboard, "b", [{ type: "blur", label: "soft" }, { type: "valueSelect", label: "pick" }]);
    await b.bus.execute("parameter.paste", { nodeId: b.ids[0]!, parameterKey: "size", as: "reference" }, context);
    expect(b.node(b.ids[0]!).parameters["size"]).toMatchObject({ mode: "expression", bindings: { expression: { source: "op('lfo1').chan.value" } } });
    await b.bus.execute("parameter.paste", { nodeId: b.ids[0]!, parameterKey: "size", as: "value" }, context);
    expect(b.node(b.ids[0]!).parameters["size"]).toMatchObject({ mode: "static", bindings: { static: { value: 0.25 } } });
    await b.bus.execute("parameter.paste", { nodeId: b.ids[1]!, parameterKey: "channels", as: "name" }, context);
    expect(b.node(b.ids[1]!).parameters["channels"]).toBe("value");
  });

  it("refuses a name onto a number, and a value from a channel copied without a reading, by name", async () => {
    const clipboard = sharedClipboard();
    const a = await windowWith(clipboard, "a", [{ type: "lfo", label: "lfo1" }]);
    await a.bus.execute("channel.copy", { nodeId: a.ids[0]!, channel: "value" }, context);
    const b = await windowWith(clipboard, "b", [{ type: "blur", label: "soft" }]);
    const name = await b.bus.execute("parameter.paste", { nodeId: b.ids[0]!, parameterKey: "size", as: "name" }, context);
    expect(name.output.diagnostics[0]?.code).toBe("parameter.paste.nameNotText");
    const value = await b.bus.execute("parameter.paste", { nodeId: b.ids[0]!, parameterKey: "size", as: "value" }, context);
    expect(value.output.diagnostics[0]?.code).toBe("parameter.paste.channelNoReading");
  });
});
