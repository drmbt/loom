import { describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { resolveParameters } from "@domain/parameters/resolve.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { gizmoTilesFor } from "@editor/viewer/gizmo-tiles.ts";
import { createVec3GizmoStore } from "@editor/viewer/vec3-gizmo-store.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/index.ts";

/**
 * §T1509b — GRID WARP'S POINTS ARE THE T935 GIZMO'S HANDLES, AS MANY AS THE GRID HAS.
 *
 * The real catalogue, a real bus and graph store, the inspector's own `ParameterEditor` (the
 * one door a gizmo writes through, §V29) and the pane's own tile derivation (`gizmoTilesFor`).
 * Claims are read back from the DOCUMENT and its undo history: the handle set follows
 * Columns × Rows with no change to the gizmo machinery, a drag is one undo group writing one
 * key, and each grid size keeps its own points.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const context = contextFor(alice);
/** Immediate: the editor's default scheduler is rAF, and a live frame must reach the bus. */
const schedule = (run: () => void): (() => void) => {
  run();
  return () => {};
};

async function placeGridWarp() {
  const store = createGraphStore({ ids: createSequentialIdFactory("gw"), now: () => "2026-10-03T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry });
  const added = await bus.execute(
    "graph.applyPatch",
    { baseRevision: 0, operations: [{ op: "addNode", ref: "$warp", type: "gridWarp", position: { x: 0, y: 0 } }] },
    context,
  );
  const nodeId = added.output.createdIds["$warp"] as NodeId;
  const editor = createParameterEditor({ bus, context, schedule });
  const gizmos = createVec3GizmoStore({ editor });
  const handles = () =>
    gizmoTilesFor([{ nodeId, portId: "out", size: [640, 360] }], store.view.getGraph().nodes, registry)
      .get(nodeId)
      ?.handles.map((handle) => [handle.key, handle.value]) ?? [];
  const values = () => {
    const node = store.view.getGraph().nodes[nodeId];
    const definition = registry.get("gridWarp");
    if (node === undefined || definition === undefined) throw new Error("the Grid Warp left the document");
    return resolveParameters(node, definition).values;
  };
  const set = async (entries: Record<string, number>) => {
    editor.setStored(nodeId, entries, "commit");
    await editor.settled();
  };
  return { store, bus, editor, gizmos, nodeId, handles, values, set };
}

describe("T1509b — Grid Warp's points on its own picture", () => {
  it("a fresh node offers its nine 3 × 3 points as picture handles, at the identity", async () => {
    const { handles } = await placeGridWarp();
    expect(handles()).toEqual([
      ["p00_3x3", [0, 0]],
      ["p10_3x3", [0.5, 0]],
      ["p20_3x3", [1, 0]],
      ["p01_3x3", [0, 0.5]],
      ["p11_3x3", [0.5, 0.5]],
      ["p21_3x3", [1, 0.5]],
      ["p02_3x3", [0, 1]],
      ["p12_3x3", [0.5, 1]],
      ["p22_3x3", [1, 1]],
    ]);
  });

  it("the handle set follows Columns × Rows — 20 at 5 × 4, the new size undistorted", async () => {
    const { handles, set } = await placeGridWarp();
    await set({ columns: 5, rows: 4 });
    const now = handles();
    expect(now).toHaveLength(20);
    expect(now.every(([key]) => String(key).endsWith("_5x4"))).toBe(true);
    expect(now).toContainEqual(["p11_5x4", [0.25, 1 / 3]]);
  });

  it("a drag writes ONE point through the bus as ONE undo step; each size keeps its own warp", async () => {
    const { store, bus, editor, gizmos, nodeId, handles, values, set } = await placeGridWarp();
    const centre = handles().find(([key]) => key === "p11_3x3");
    expect(centre).toBeDefined();
    const undoBefore = store.view.getHistory(alice).undo.length;
    const handle = { space: "picture" as const, key: "p11_3x3", label: "Point 2,2", value: [0.5, 0.5] as const, refusal: null };
    expect(gizmos.begin(nodeId, handle)).toBeNull();
    gizmos.drag(nodeId, "p11_3x3", [0.55, 0.52]);
    gizmos.drag(nodeId, "p11_3x3", [0.62, 0.58]);
    gizmos.drag(nodeId, "p11_3x3", [0.7, 0.6]);
    gizmos.end(nodeId, "p11_3x3");
    await editor.settled();

    expect(values()["p11_3x3"]).toEqual([0.7, 0.6]);
    expect(values()["p21_3x3"]).toEqual([1, 0.5]);
    expect(store.view.getHistory(alice).undo.length).toBe(undoBefore + 1);
    expect(handles()).toContainEqual(["p11_3x3", [0.7, 0.6]]);

    // Another size is another grid: 4 × 3 starts undistorted, and no 3 × 3 handle shows.
    await set({ columns: 4 });
    expect(handles()).toContainEqual(["p11_4x3", [1 / 3, 0.5]]);
    expect(handles().some(([key]) => String(key).endsWith("_3x3"))).toBe(false);
    // Back to 3 × 3: the moved point is where the drag left it.
    await set({ columns: 3 });
    expect(handles()).toContainEqual(["p11_3x3", [0.7, 0.6]]);

    // And one undo per edit: the two size changes, then the whole drag.
    await bus.execute("graph.undo", {}, context);
    await bus.execute("graph.undo", {}, context);
    await bus.execute("graph.undo", {}, context);
    expect(values()["p11_3x3"]).toEqual([0.5, 0.5]);
  });
});
