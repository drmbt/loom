import { describe, expect, it } from "vitest";
import { alice, contextFor } from "../commands/test-support.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { decodeLoomClipboard, encodeLoomClipboard, type SystemClipboard } from "../commands/loom-clipboard.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { registerComponentCommands } from "./commands.ts";
import { componentNodeType } from "./component-type.ts";
import { createComponentSystem, type ComponentRegistry } from "./registry.ts";
import { bloomComponent, blurKnob, graphOf, instanceNode, node } from "./test-support.ts";

/**
 * T1493b — a component instance copied in one document and pasted in another, which used
 * to be refused whenever the target lacked the definition (§T1393b). The copy now carries
 * the definitions and the paste installs them by the §T1395b identity rule (owner ruling
 * 2026-09-29): same id + version + content is the SAME component and is reused; an id a
 * different component holds is left alone and the arriving one is renamed.
 *
 * Two runtimes are two documents; what joins them is one system clipboard. Every test
 * reads back what a user would: which components the target document holds (and with what
 * content), and which component the pasted node is an instance OF.
 */

const ctx = contextFor(alice);

/** One clipboard both documents share, holding text and Loom's slot like the browser's. */
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

interface Doc {
  store: GraphStore;
  bus: LoomBus;
  components: ComponentRegistry;
  nodes(): GraphNode[];
}

function documentWith(
  clipboard: SystemClipboard,
  prefix: string,
  definitions: readonly GraphComponentDefinition[],
  nodes: readonly GraphNode[] = [],
  edges: Parameters<typeof graphOf>[1] = {},
): Doc {
  const store = createGraphStore({
    ids: createSequentialIdFactory(prefix),
    now: () => "2026-10-02T00:00:00.000Z",
    initialGraph: graphOf([...nodes], edges),
  });
  const system = createComponentSystem(createTestRegistry().view(), definitions);
  const { bus } = createDomainBus({ store, registry: system.nodes, systemClipboard: clipboard });
  registerComponentCommands(bus, { components: system.components });
  return { store, bus, components: system.components, nodes: () => Object.values(store.view.getGraph().nodes) };
}

/** A bloom whose three internal radii read `radius` — the content the rule compares. */
function bloomWith(radius: number): GraphComponentDefinition {
  const base = bloomComponent("bloom", 1, [blurKnob]);
  const nodes = Object.fromEntries(
    Object.entries(base.graph.nodes).map(([id, each]) => [id, { ...each, parameters: { radius } }]),
  );
  return {
    ...base,
    graph: { ...base.graph, nodes },
    parameters: [{ ...blurKnob, definition: { ...blurKnob.definition, default: radius } as typeof blurKnob.definition }],
  };
}

/** A component that NESTS a bloom: bloom → tail. */
function stackOverBloom(): GraphComponentDefinition {
  return {
    componentId: "stack",
    version: 1,
    name: "Stack",
    graph: graphOf(
      [instanceNode("inner", "bloom", 1), node("tail", "test.blur", { radius: 2 }, { position: { x: 200, y: 0 } })],
      { e1: { id: "e1", source: { nodeId: "inner", portId: "out" }, target: { nodeId: "tail", portId: "source" } } },
    ),
    inputs: [{ externalId: "source", label: "Source", nodeId: "inner", portId: "source" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "tail", portId: "out" }],
    parameters: [],
  };
}

const catalogueOf = (components: ComponentRegistry): string[] =>
  components.all().map((each) => `${each.componentId}@${each.version}:${each.name}`);

const radiusIn = (components: ComponentRegistry, componentId: string): unknown =>
  components.get(componentId, 1)?.graph.nodes.blurA?.parameters.radius;

const copy = (doc: Doc, nodeIds: readonly NodeId[]) => doc.bus.execute("graph.copySelection", { nodeIds: [...nodeIds] }, ctx);
const paste = (doc: Doc) => doc.bus.execute("graph.paste", {}, ctx);

describe("paste across documents carries the component (T1493b)", () => {
  it("installs a component the target lacks and places the instance, with its values and wires", async () => {
    const clipboard = sharedClipboard();
    const a = documentWith(
      clipboard,
      "a",
      [bloomWith(4)],
      [
        { ...instanceNode("glow", "bloom", 1, { blur: 11 }), label: "glow" },
        node("soft", "test.blur", { radius: 3 }, { label: "soft", position: { x: 200, y: 0 } }),
      ],
      { e1: { id: "e1", source: { nodeId: "glow", portId: "out" }, target: { nodeId: "soft", portId: "source" } } },
    );
    await copy(a, ["glow", "soft"]);

    const b = documentWith(clipboard, "b", []);
    const pasted = await paste(b);

    expect(pasted.status, pasted.diagnostics?.map((d) => d.message).join("; ")).toBe("applied");
    expect(catalogueOf(b.components)).toEqual(["bloom@1:Bloom"]);
    // The definition A held, not a stand-in: the content the instance was copied for.
    expect(radiusIn(b.components, "bloom")).toBe(4);
    const instance = b.nodes().find((each) => each.label === "glow");
    expect(instance?.type).toBe(componentNodeType("bloom", 1));
    // The instance's own published value crossed with it.
    expect(instance?.parameters.blur).toBe(11);
    // And the wire out of the instance — which only connects if its type resolves here.
    const edges = Object.values(b.store.view.getGraph().edges);
    expect(edges.map((edge) => [edge.source.nodeId, edge.source.portId, edge.target.portId])).toEqual([
      [instance?.id, "out", "source"],
    ]);

    // ONE undo step: the nodes go, the installed definition stays (as component.import).
    await b.bus.execute("graph.undo", {}, ctx);
    expect(b.nodes()).toEqual([]);
    expect(catalogueOf(b.components)).toEqual(["bloom@1:Bloom"]);
  });

  it("REUSES an identical component the target already holds — no duplicate", async () => {
    const clipboard = sharedClipboard();
    const a = documentWith(clipboard, "a", [bloomWith(4)], [instanceNode("glow", "bloom", 1)]);
    await copy(a, ["glow"]);

    const b = documentWith(clipboard, "b", [bloomWith(4)]);
    const before = b.components.get("bloom", 1);
    const pasted = await paste(b);

    expect(pasted.status).toBe("applied");
    expect(catalogueOf(b.components)).toEqual(["bloom@1:Bloom"]);
    // Not re-registered: the very definition object the document already had.
    expect(b.components.get("bloom", 1)).toBe(before);
    expect(b.nodes().map((each) => each.type)).toEqual([componentNodeType("bloom", 1)]);
  });

  it("pastes a DIFFERENT component under the same id as bloom1, and the pasted node points at it", async () => {
    const clipboard = sharedClipboard();
    const a = documentWith(clipboard, "a", [bloomWith(9)], [instanceNode("glow", "bloom", 1), node("soft", "test.blur")]);
    await copy(a, ["glow"]);

    const b = documentWith(clipboard, "b", [bloomWith(4)], [instanceNode("own", "bloom", 1)]);
    const pasted = await paste(b);

    expect(pasted.status, pasted.diagnostics?.map((d) => d.message).join("; ")).toBe("applied");
    expect(catalogueOf(b.components)).toEqual(["bloom@1:Bloom", "bloom1@1:Bloom1"]);
    // Neither merged nor overwritten: the document's own bloom still reads 4, and the
    // copied content arrived intact under the new id.
    expect(radiusIn(b.components, "bloom")).toBe(4);
    expect(radiusIn(b.components, "bloom1")).toBe(9);
    // The document's own instance is untouched; the pasted one is an instance of bloom1.
    expect(b.store.view.getGraph().nodes.own?.type).toBe(componentNodeType("bloom", 1));
    expect(b.nodes().filter((each) => each.id !== "own").map((each) => each.type)).toEqual([
      componentNodeType("bloom1", 1),
    ]);

    // Pasting again — from this bus's clipboard, then from a NEW copy in A, which is
    // planned afresh — reuses bloom1 rather than minting bloom2.
    expect((await paste(b)).status).toBe("applied");
    await copy(a, ["glow", "soft"]);
    expect((await paste(b)).status).toBe("applied");
    expect(catalogueOf(b.components)).toEqual(["bloom@1:Bloom", "bloom1@1:Bloom1"]);
    expect(b.nodes().filter((each) => each.type === componentNodeType("bloom1", 1))).toHaveLength(3);
  });

  it("carries a NESTED component, and a renamed nested one renames what contains it", async () => {
    const clipboard = sharedClipboard();
    const a = documentWith(clipboard, "a", [bloomWith(9), stackOverBloom()], [instanceNode("pile", "stack", 1)]);
    await copy(a, ["pile"]);

    // A target with neither: both arrive, under their own ids.
    const empty = documentWith(clipboard, "b", []);
    expect((await paste(empty)).status).toBe("applied");
    expect(catalogueOf(empty.components)).toEqual(["bloom@1:Bloom", "stack@1:Stack"]);
    expect(radiusIn(empty.components, "bloom")).toBe(9);

    // A target whose bloom is a different component: the nested one is renamed and the
    // stack that arrives contains THAT one, not the target's bloom.
    const clash = documentWith(clipboard, "c", [bloomWith(4)]);
    expect((await paste(clash)).status).toBe("applied");
    expect(catalogueOf(clash.components)).toEqual(["bloom@1:Bloom", "bloom1@1:Bloom1", "stack@1:Stack"]);
    expect(clash.components.get("stack", 1)?.graph.nodes.inner?.type).toBe(componentNodeType("bloom1", 1));
    expect(radiusIn(clash.components, "bloom1")).toBe(9);
    expect(clash.nodes().map((each) => each.type)).toEqual([componentNodeType("stack", 1)]);
  });

  it("refuses BY NAME a copy without definitions, or with ones that do not read, as before", async () => {
    const clipboard = sharedClipboard();
    const a = documentWith(clipboard, "a", [bloomWith(9)], [{ ...instanceNode("glow", "bloom", 1), label: "glow" }]);
    await copy(a, ["glow"]);
    const carried = decodeLoomClipboard(clipboard.loom);
    if (carried?.kind !== "nodes") throw new Error("the copy did not write a nodes payload");
    expect(carried.components).toHaveLength(1);

    for (const components of [undefined, [{ componentId: "bloom", version: 1 }]]) {
      // An older build's copy carried no definitions; a damaged one carries unreadable ones.
      const text = encodeLoomClipboard({
        kind: "nodes",
        nodes: carried.nodes,
        edges: carried.edges,
        ...(components === undefined ? {} : { components }),
      });
      clipboard.write(text, text);
      const b = documentWith(clipboard, "b", []);
      const pasted = await paste(b);
      expect(pasted.status).toBe("rejected");
      expect(pasted.diagnostics?.[0]?.message).toContain('"glow" is an instance of component:bloom@1');
      expect(b.nodes()).toEqual([]);
      expect(catalogueOf(b.components)).toEqual([]);
    }
  });

  it("a paste that does not land installs nothing", async () => {
    const clipboard = sharedClipboard();
    const a = documentWith(clipboard, "a", [bloomWith(9)], [instanceNode("glow", "bloom", 1)]);
    await copy(a, ["glow"]);
    const carried = decodeLoomClipboard(clipboard.loom);
    if (carried?.kind !== "nodes") throw new Error("the copy did not write a nodes payload");
    // The definitions are sound and plan cleanly; the PATCH is what fails — a wire to a
    // socket the instance does not have.
    const text = encodeLoomClipboard({
      ...carried,
      edges: [{ source: { nodeId: "glow", portId: "out" }, target: { nodeId: "glow", portId: "no-such-socket" } }],
    });
    clipboard.write(text, text);

    const b = documentWith(clipboard, "b", []);
    const pasted = await paste(b);

    expect(pasted.status).toBe("rejected");
    expect(b.nodes()).toEqual([]);
    // §V32: refused whole. The definition registered for the patch came back out.
    expect(catalogueOf(b.components)).toEqual([]);
  });

  it("leaves a paste inside the same document as it was: no definition is installed or renamed", async () => {
    const clipboard = sharedClipboard();
    const a = documentWith(clipboard, "a", [bloomWith(4)], [instanceNode("glow", "bloom", 1)]);
    const before = a.components.get("bloom", 1);
    await copy(a, ["glow"]);

    expect((await paste(a)).status).toBe("applied");
    expect(a.components.get("bloom", 1)).toBe(before);
    expect(catalogueOf(a.components)).toEqual(["bloom@1:Bloom"]);
    expect(a.nodes().map((each) => each.type)).toEqual([componentNodeType("bloom", 1), componentNodeType("bloom", 1)]);
  });
});
