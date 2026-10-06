import { describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { revisionWatchFor } from "./revision-watch.ts";
import type { ValuesRevision } from "./revision-watch.ts";

/**
 * T1652b — who hears which revision.
 *
 * The composition root listens for STRUCTURE and must not hear a moved value; a surface
 * that shows a value listens for VALUES and must hear every one; and the compile's lane
 * decides, before anyone else is told, whether a values-only revision can be followed
 * without a structural compile. When it cannot, the revision is structural for everyone —
 * which is the rule that keeps a pane from showing a value the plan did not take.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const actor = { actor: { kind: "human" as const, id: "tester" }, projectId: "p", capabilities: [] };

async function stage() {
  const store = createGraphStore();
  const { bus } = createDomainBus({ store, registry });
  const apply = async (operations: GraphPatchOperation[]) => {
    const result = await bus.execute("graph.applyPatch", { baseRevision: store.view.getRevision(), operations, label: "edit" }, actor);
    expect(result.status).toBe("applied");
    return result.output.createdIds as Record<string, NodeId>;
  };
  const ids = await apply([
    { op: "addNode", ref: "$slider", type: "slider", position: { x: 0, y: 0 }, label: "slider_gain", parameters: { caption: "Gain", channel: "gain", value: 0.5, min: 0, max: 1, step: 0, defaultValue: 0.5 } },
    { op: "addNode", ref: "$level", type: "level", position: { x: 300, y: 0 }, label: "level_grade", parameters: { brightness: 1 } },
  ] as GraphPatchOperation[]);
  const watch = revisionWatchFor(store.view, registry);
  const heard = { structure: 0, values: [] as ValuesRevision[] };
  const offStructure = watch.subscribeStructure(() => {
    heard.structure += 1;
  });
  const offValues = watch.subscribeValues((revision) => heard.values.push(revision));
  const value = (amount: number) => apply([{ op: "setParameters", nodeId: ids["$slider"] as NodeId, parameters: { value: amount } }]);
  return { store, bus, apply, ids, watch, heard, value, off: () => (offStructure(), offValues()) };
}

describe("T1652b: the revision watch", () => {
  it("is one object per store, so a revision is read once however many listen", async () => {
    const { store, watch } = await stage();
    expect(revisionWatchFor(store.view, registry)).toBe(watch);
  });

  it("tells a moved value to the values listeners only, and the structure does not move", async () => {
    const { store, watch, heard, value, ids } = await stage();
    const structure = watch.structure();
    await value(0.75);
    expect(heard.structure).toBe(0);
    expect(heard.values).toHaveLength(1);
    expect(heard.values[0]?.written).toEqual([ids["$slider"]]);
    expect(heard.values[0]?.graph).toBe(store.view.getGraph());
    expect(heard.values[0]?.previous).toBe(structure);
    // The structure is the document BEFORE the value: same nodes and wires, the value before.
    expect(watch.structure()).toBe(structure);
    expect(watch.structure().nodes[ids["$slider"] as NodeId]?.parameters["value"]).toBe(0.5);
    expect(watch.stats()).toEqual({ values: 1, escalated: 0, lastEscalation: null });
  });

  it("tells a structural revision to the structure listeners, and the structure is then the store's document", async () => {
    const { store, apply, watch, heard, value, ids } = await stage();
    await value(0.75);
    await apply([{ op: "setNodeLabel", nodeId: ids["$level"] as NodeId, label: "level_other" }]);
    expect(heard.structure).toBe(1);
    expect(heard.values).toHaveLength(1);
    expect(watch.structure()).toBe(store.view.getGraph());
    // And it carries the value that moved on the way: nothing was lost by not telling the root then.
    expect(watch.structure().nodes[ids["$slider"] as NodeId]?.parameters["value"]).toBe(0.75);
  });

  it("asks the lane FIRST, and a lane that cannot follow makes the revision structural for everyone", async () => {
    const { watch, heard, value, store } = await stage();
    const order: string[] = [];
    watch.subscribeValues(() => order.push("listener"));
    let refuse: string | null = null;
    const off = watch.setLane(() => {
      order.push("lane");
      return refuse;
    });

    await value(0.6);
    expect(order).toEqual(["lane", "listener"]);
    expect(heard.structure).toBe(0);

    refuse = "A node says something different about its new value.";
    await value(0.7);
    // The values listeners were NOT told: no pane shows a value the plan did not take.
    expect(order).toEqual(["lane", "listener", "lane"]);
    expect(heard.values).toHaveLength(1);
    expect(heard.structure).toBe(1);
    expect(watch.structure()).toBe(store.view.getGraph());
    expect(watch.stats()).toEqual({ values: 1, escalated: 1, lastEscalation: refuse });

    // The lane's remover takes away that lane and no other.
    const other = watch.setLane(() => null);
    off();
    await value(0.8);
    expect(heard.values).toHaveLength(2);
    other();
  });

  it("calls a settings edit structure, though no node moved", async () => {
    const { bus, heard } = await stage();
    const result = await bus.execute("project.setSettings", { settings: { previewFps: 12 }, label: "fps" }, actor);
    expect(result.status).toBe("applied");
    expect(heard.structure).toBe(1);
    expect(heard.values).toHaveLength(0);
  });

  it("hands out the store's own document while nobody listens (nothing can go stale unheard)", async () => {
    const { watch, value, store, off } = await stage();
    off();
    await value(0.3);
    expect(watch.structure()).toBe(store.view.getGraph());
  });
});
