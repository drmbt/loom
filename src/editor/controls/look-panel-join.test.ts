import { describe, expect, it } from "vitest";
import type { LoomBus } from "../../domain/commands/bus.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { alice, contextFor } from "../../domain/commands/test-support.ts";
import { registerComponentCommands } from "../../domain/components/commands.ts";
import { createComponentSystem, type ComponentRegistry } from "../../domain/components/registry.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { layoutGraph } from "../../domain/graph/layout.ts";
import { boxesOverlap, nodeBox, nodeControlsHeight, NODE_WIDTH } from "../../domain/graph/node-box.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { serializePresetBank } from "../../domain/presets/bank.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { panelBoard, parsePanelBoard, soloPanelFor } from "../../nodes/definitions/controls.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { registerControlCommands } from "./control-commands.ts";
import { joinPanelOperations, panelUnderDrop } from "./panel-join.ts";

/**
 * T1541b — A LOOK'S INSTANCE ON A PANEL, BY THE DROP, AND THE ROOM ITS "+ panel" TAKES.
 *
 * A component instance whose definition holds a page bank is a bank from outside (§T1505b),
 * so dropping it on a Panel puts it on the board BY NAME, as a bank's strip — and while the
 * document has one Panel it lacks, it draws the bank's "+ panel" button, which the layout
 * model (`node-box.ts`, §V389) must count or a tidy lays the next node over it. Whether an
 * instance is a look is the catalogue's to say (`bankOf`): the same component with NO page
 * bank is not one, and with no catalogue no instance is. Through the real bus, the real
 * component system and the catalogue holder the canvas reads.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const ctx = contextFor(alice);

function definition(componentId: string, pageBank: boolean): GraphComponentDefinition {
  const presets = serializePresetBank({ version: 1, presets: [{ name: "calm", values: { parent: { glow: 2 } } }] });
  const nodes: Record<string, GraphNode> = {
    blur: { id: "blur", type: "blur", label: "blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { size: 4 } },
  };
  if (pageBank) {
    nodes["looks"] = { id: "looks", type: "presets", label: "looks", definitionVersion: 1, position: { x: 0, y: 200 }, parameters: { targets: "parent", presets } };
  }
  return {
    componentId,
    version: 1,
    name: componentId,
    graph: { revision: 0, nodes, edges: {}, groups: {} },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "blur", portId: "out" }],
    parameters: [{ key: "glow", definition: { type: "number", label: "Glow", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "blur", key: "size" }] }],
  };
}

const add = (ref: string, type: string, label: string, x: number, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x, y: 0 }, label, parameters }) as GraphPatchOperation;

async function desk(): Promise<{ bus: LoomBus; components: ComponentRegistry; ids: Record<string, NodeId> }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("j"), now: () => "2026-10-03T00:00:00.000Z" });
  const system = createComponentSystem(registry, [definition("look", true), definition("plain", false)]);
  const { bus } = createDomainBus({ store, registry: system.nodes });
  registerComponentCommands(bus, { components: system.components });
  const result = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: store.view.getRevision(),
      label: "setup",
      operations: [add("city", "component:look@1", "city", 0), add("other", "component:plain@1", "other", 0), add("bank", "presets", "bank", 0), add("panel", "panel", "panel1", 400)],
    },
    ctx,
  );
  expect(result.output.status).toBe("applied");
  return { bus, components: system.components, ids: result.output.createdIds as Record<string, NodeId> };
}

/** The Panel's box covers x 400…600; a node's centre at 480 is ON it, at 300 is not. */
const boxOf = (panelId: NodeId) => (id: NodeId) => (id === panelId ? { x: 400, y: 0, width: 200, height: 200 } : null);

describe("T1541b — dropping a look's instance on a Panel", () => {
  it("finds the Panel only for a look, and only with the catalogue; the join is one board write naming it", async () => {
    const { bus, components, ids } = await desk();
    const graph = bus.store.getGraph();
    const panel = ids["$panel"]!;

    expect(panelUnderDrop(graph, ids["$city"]!, { x: 480, y: 100 }, boxOf(panel), components)).toBe(panel);
    expect(panelUnderDrop(graph, ids["$city"]!, { x: 300, y: 100 }, boxOf(panel), components)).toBeNull();
    // A component with no page bank is not a bank; with no catalogue nothing says one is.
    expect(panelUnderDrop(graph, ids["$other"]!, { x: 480, y: 100 }, boxOf(panel), components)).toBeNull();
    expect(panelUnderDrop(graph, ids["$city"]!, { x: 480, y: 100 }, boxOf(panel))).toBeNull();
    expect(joinPanelOperations(graph, ids["$city"]!, panel)).toEqual([]);

    const operations = joinPanelOperations(graph, ids["$city"]!, panel, components);
    expect(operations.map((operation) => operation.op)).toEqual(["setParameters"]);
    const applied = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label: "drop", operations }, ctx);
    expect(applied.output.status).toBe("applied");

    const after = bus.store.getGraph();
    expect(parsePanelBoard(after.nodes[panel]!.parameters["board"]).items).toEqual([{ member: "city", rect: { x: 0, y: 0, w: 4, h: 1 } }]);
    // The board derivation keeps it (`boardNamesMember`), so the strip is drawn there.
    expect(panelBoard(after, after.nodes[panel]!)?.items.map((item) => (item.kind === "widget" ? item.node.id : item.text))).toEqual([ids["$city"]]);
    // On the board now: nothing left to join, and no "+ panel".
    expect(joinPanelOperations(after, ids["$city"]!, panel, components)).toEqual([]);
    expect(soloPanelFor(after, ids["$city"]!, components)).toBeNull();
  });
});

describe("T1541b — the layout model counts a look's “+ panel” (§V389)", () => {
  it("is a bank's button: the same height on the look as on a Presets node, none on a plain instance, gone once it has joined", async () => {
    const { bus, components, ids } = await desk();
    const graph = bus.store.getGraph();
    const city = graph.nodes[ids["$city"]!]!;
    const bankButton = nodeControlsHeight(graph.nodes[ids["$bank"]!]!, graph, components);
    expect(bankButton).toBeGreaterThan(0);

    expect(nodeControlsHeight(city, graph, components)).toBe(bankButton);
    expect(nodeControlsHeight(graph.nodes[ids["$other"]!]!, graph, components)).toBe(0);
    // Without the catalogue the model cannot know the instance is a look — the canvas,
    // which reads the same holder, would not draw the button either.
    expect(nodeControlsHeight(city, graph)).toBe(0);
    const definitionOf = bus.registry.get(city.type);
    expect(nodeBox(city, definitionOf, undefined, graph, components).height).toBe(nodeBox(city, definitionOf, undefined, graph).height + Math.round(bankButton));

    const join = joinPanelOperations(graph, ids["$city"]!, ids["$panel"]!, components);
    await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label: "join", operations: join }, ctx);
    const after = bus.store.getGraph();
    expect(nodeControlsHeight(after.nodes[ids["$city"]!]!, after, components)).toBe(0);
  });

  it("a tidy with the catalogue leaves room under the look for its button", async () => {
    const { bus, components, ids } = await desk();
    const graph = bus.store.getGraph();
    const city = graph.nodes[ids["$city"]!]!;
    const height = nodeBox(city, bus.registry.get(city.type), undefined, graph, components).height;
    const positions = layoutGraph(graph, bus.registry, { catalogue: components, rowGap: 40 });
    // Whatever sits below the look in its column starts below its FULL box, button included.
    const below = Object.entries(positions).filter(([id, at]) => id !== city.id && at.x === positions[city.id]!.x && at.y > positions[city.id]!.y);
    expect(below.length).toBeGreaterThan(0);
    for (const [, at] of below) expect(at.y).toBeGreaterThanOrEqual(positions[city.id]!.y + height + 40);
  });
});

describe("T1547b — Control from Panel places its control clear of a look's “+ panel” (§V389)", () => {
  it("steps the new slider below the look's FULL box, button included, by the row gap", async () => {
    // A look's instance with a Level just beside it, the Level's top 5 px below the look's
    // body: inside the strip the look's "+ panel" button takes (the document's one Panel
    // lacks it). Sized without the catalogue the look ends above the Level's top, so the
    // slider was placed at the Level's height — on the button.
    const store = createGraphStore({ ids: createSequentialIdFactory("k"), now: () => "2026-10-03T00:00:00.000Z" });
    const system = createComponentSystem(registry, [definition("look", true)]);
    const { bus } = createDomainBus({ store, registry: system.nodes });
    registerComponentCommands(bus, { components: system.components });
    registerControlCommands(bus);
    const components = system.components;

    const probe: GraphNode = { id: "probe", type: "component:look@1", label: "city", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} };
    const levelY = nodeBox(probe, bus.registry.get(probe.type)).height + 5;
    const setup = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: store.view.getRevision(),
        label: "setup",
        operations: [
          add("city", "component:look@1", "city", 0),
          { op: "addNode", ref: "$level", type: "level", position: { x: NODE_WIDTH + 80, y: levelY }, label: "level1", parameters: {} },
          add("panel", "panel", "panel1", 2000),
        ],
      },
      ctx,
    );
    expect(setup.output.status).toBe("applied");
    const ids = setup.output.createdIds as Record<string, NodeId>;
    const before = bus.store.getGraph();
    const look = before.nodes[ids["$city"]!]!;
    const lookBox = nodeBox(look, bus.registry.get(look.type), undefined, before, components);
    // The premise: the look draws its button, and the Level's top is inside it.
    expect(nodeControlsHeight(look, before, components)).toBeGreaterThan(5);
    expect(lookBox.y + lookBox.height).toBeGreaterThan(levelY);

    const made = await bus.execute("control.fromParameter", { nodeId: ids["$level"]!, parameterKey: "brightness" }, ctx);
    expect(made.output.status).toBe("applied");

    const after = bus.store.getGraph();
    const slider = Object.values(after.nodes).find((node) => node.type === "slider")!;
    const sliderBox = nodeBox(slider, bus.registry.get(slider.type), undefined, after, components);
    // In the look's column, below its whole box — the box the canvas draws — by the row gap.
    expect(sliderBox.x).toBe(lookBox.x);
    expect(sliderBox.y).toBe(lookBox.y + lookBox.height + 40);
    // On top of nothing, every box sized the way the canvas sizes it.
    const boxes = Object.values(after.nodes).map((node) => nodeBox(node, bus.registry.get(node.type), undefined, after, components));
    boxes.forEach((box, index) => boxes.slice(index + 1).forEach((other) => expect(boxesOverlap(box, other)).toBe(false)));
  });
});
