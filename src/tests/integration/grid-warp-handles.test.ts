import { describe, expect, it } from "vitest";
import { createAgentToolSurface } from "@agent/surface.ts";
import type { PatchToolData } from "@agent/tool-support.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { resolveParameters } from "@domain/parameters/resolve.ts";
import type { Actor } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { gizmoTilesFor } from "@editor/viewer/gizmo-tiles.ts";
import { createVec3GizmoStore } from "@editor/viewer/vec3-gizmo-store.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/index.ts";

/**
 * §T1509b, §T1532b — GRID WARP'S POINTS ARE THE T935 GIZMO'S HANDLES, AS MANY AS THE GRID
 * HAS, AND CHANGING THE GRID'S SIZE KEEPS THE WARP.
 *
 * The real catalogue, a real bus and graph store, the inspector's own `ParameterEditor` (the
 * one door a gizmo writes through, §V29), the pane's own tile derivation (`gizmoTilesFor`)
 * and the agent's tool surface. Claims are read back from the DOCUMENT and its undo history:
 * the handle set follows Columns × Rows with no change to the gizmo machinery, a drag is one
 * undo group writing one key, and a size change rewrites every point onto the current
 * surface in the SAME undo step — whichever door it came through — with nothing of the old
 * size left stored.
 *
 * The expected points are derived by hand, not by calling the node's resample:
 *  - an AFFINE grid is reproduced exactly by both interpolations, so its resample is the
 *    affine map at the new identity points;
 *  - a 3 × 3 grid whose centre is raised by d: at the new 4 × 3 grid's middle-row points
 *    (grid coordinates 2/3 and 4/3) Catmull-Rom weighs the displacements −d (the straight
 *    continuation past the left edge), 0, d, 0 by −1/27, 9/27, 21/27, −2/27 — 22/27 of d —
 *    and bilinear takes 2/3 of d. The bottom and top rows carry no displacement.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const context = contextFor(alice);
/** Immediate: the editor's default scheduler is rAF, and a live frame must reach the bus. */
const schedule = (run: () => void): (() => void) => {
  run();
  return () => {};
};

/** x = 0.6u + 0.2v + 0.1, y = 0.1u + 0.7v + 0.05 — a Corner Pin parallelogram. */
const affine = (u: number, v: number): [number, number] => [0.6 * u + 0.2 * v + 0.1, 0.1 * u + 0.7 * v + 0.05];

/** Every point of a columns × rows grid, keyed `p{c}{r}`, placed by `place` at its identity position. */
function gridPoints(columns: number, rows: number, place: (u: number, v: number) => [number, number]): Record<string, number[]> {
  const points: Record<string, number[]> = {};
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) points[`p${c}${r}`] = place(c / (columns - 1), r / (rows - 1));
  return points;
}

const STATIC_KEYS = ["columns", "feather", "interpolation", "rows"];
const keysOf = (columns: number, rows: number): string[] => [...STATIC_KEYS, ...Object.keys(gridPoints(columns, rows, (u, v) => [u, v]))].sort();

function expectPoint(actual: StoredParameter | undefined, expected: readonly [number, number], label: string): void {
  expect(Array.isArray(actual), `${label} is stored as a point`).toBe(true);
  const [x, y] = actual as [number, number];
  expect(x, `${label}.x`).toBeCloseTo(expected[0], 14);
  expect(y, `${label}.y`).toBeCloseTo(expected[1], 14);
}

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
  const stored = (): Record<string, StoredParameter> => {
    const node = store.view.getGraph().nodes[nodeId];
    if (node === undefined) throw new Error("the Grid Warp left the document");
    return node.parameters;
  };
  const values = () => {
    const node = store.view.getGraph().nodes[nodeId];
    const definition = registry.get("gridWarp");
    if (node === undefined || definition === undefined) throw new Error("the Grid Warp left the document");
    return resolveParameters(node, definition).values;
  };
  const set = async (entries: Record<string, StoredParameter>) => {
    editor.setStored(nodeId, entries, "commit");
    await editor.settled();
  };
  return { store, bus, editor, gizmos, nodeId, handles, stored, values, set };
}

describe("T1509b — Grid Warp's points on its own picture", () => {
  it("a fresh node offers its nine 3 × 3 points as picture handles, at the identity", async () => {
    const { handles } = await placeGridWarp();
    expect(handles()).toEqual([
      ["p00", [0, 0]],
      ["p10", [0.5, 0]],
      ["p20", [1, 0]],
      ["p01", [0, 0.5]],
      ["p11", [0.5, 0.5]],
      ["p21", [1, 0.5]],
      ["p02", [0, 1]],
      ["p12", [0.5, 1]],
      ["p22", [1, 1]],
    ]);
  });

  it("the handle set follows Columns × Rows — 20 at 5 × 4, an undistorted grid staying undistorted", async () => {
    const { handles, set } = await placeGridWarp();
    await set({ columns: 5, rows: 4 });
    const now = new Map(handles() as Array<[string, StoredParameter]>);
    expect(now.size).toBe(20);
    // The resample evaluates the surface in f64: the identity to the last bit or two.
    expectPoint(now.get("p11"), [0.25, 1 / 3], "p11");
    // A corner both grids share is exact.
    expect(now.get("p43")).toEqual([1, 1]);
  });

  it("a drag writes ONE point through the bus as ONE undo step", async () => {
    const { store, bus, editor, gizmos, nodeId, handles, values } = await placeGridWarp();
    const undoBefore = store.view.getHistory(alice).undo.length;
    const handle = { space: "picture" as const, key: "p11", label: "Point 2,2", value: [0.5, 0.5] as const, refusal: null };
    expect(gizmos.begin(nodeId, handle)).toBeNull();
    gizmos.drag(nodeId, "p11", [0.55, 0.52]);
    gizmos.drag(nodeId, "p11", [0.62, 0.58]);
    gizmos.drag(nodeId, "p11", [0.7, 0.6]);
    gizmos.end(nodeId, "p11");
    await editor.settled();

    expect(values()["p11"]).toEqual([0.7, 0.6]);
    expect(values()["p21"]).toEqual([1, 0.5]);
    expect(store.view.getHistory(alice).undo.length).toBe(undoBefore + 1);
    expect(handles()).toContainEqual(["p11", [0.7, 0.6]]);

    await bus.execute("graph.undo", {}, context);
    expect(values()["p11"]).toEqual([0.5, 0.5]);
  });
});

describe("T1532b — changing Columns/Rows resamples the warp, in the size change's own undo step", () => {
  it("an AFFINE 3 × 3 grid at 4 columns is the same affine map at the new points; one undo restores the 3 × 3 exactly", async () => {
    const { store, bus, stored, set, handles } = await placeGridWarp();
    await set(gridPoints(3, 3, affine));
    const before = structuredClone(stored());
    const undoBefore = store.view.getHistory(alice).undo.length;

    await set({ columns: 4 });

    // Every point of the new grid, on the old surface; nothing else stored.
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 4; c += 1) expectPoint(stored()[`p${c}${r}`], affine(c / 3, r / 2), `p${c}${r}`);
    expect(Object.keys(stored()).sort()).toEqual(keysOf(4, 3));
    expect(handles()).toHaveLength(12);
    // ONE undo step for the size and its twelve points.
    expect(store.view.getHistory(alice).undo.length).toBe(undoBefore + 1);

    await bus.execute("graph.undo", {}, context);
    expect(stored()).toEqual(before);

    // And redo brings the resampled grid back, not a fresh one.
    await bus.execute("graph.redo", {}, context);
    expect(stored()["columns"]).toBe(4);
    expectPoint(stored()["p11"], affine(1 / 3, 1 / 2), "p11 after redo");
  });

  it.each([
    ["smooth", 22 / 27],
    ["linear", 2 / 3],
  ] as const)("a raised centre (%s) resamples to the hand-computed points", async (interpolation, share) => {
    const { stored, set } = await placeGridWarp();
    await set({ interpolation, p11: [0.7, 0.6] });
    await set({ columns: 4 });
    for (const c of [1, 2]) expectPoint(stored()[`p${c}1`], [c / 3 + share * 0.2, 0.5 + share * 0.1], `p${c}1`);
    for (const c of [0, 1, 2, 3]) {
      expectPoint(stored()[`p${c}0`], [c / 3, 0], `p${c}0`);
      expectPoint(stored()[`p${c}2`], [c / 3, 1], `p${c}2`);
    }
  });

  it("shrinking drops the points the smaller grid lacks, and growing back RESAMPLES rather than remembering", async () => {
    const { stored, set } = await placeGridWarp();
    await set({ p21: [0.9, 0.6] });
    await set({ columns: 2 });
    expect(Object.keys(stored()).sort()).toEqual(keysOf(2, 3));
    // The right edge of the 2 × 3 grid IS the old right column, raised point included.
    expectPoint(stored()["p11"], [0.9, 0.6], "p11");
    await set({ columns: 3 });
    expect(Object.keys(stored()).sort()).toEqual(keysOf(3, 3));
    // The middle column is now the midpoint of a 2-wide grid's straight edges: no memory of
    // what 3 × 3 once held there.
    expectPoint(stored()["p11"], [0.45, 0.55], "p11 after growing back");
  });

  it("an edit naming a size AND its points (a preset, a paste) keeps the points it names", async () => {
    const { stored, set } = await placeGridWarp();
    await set({ columns: 4, rows: 4, ...gridPoints(4, 4, affine) });
    expect(Object.keys(stored()).sort()).toEqual(keysOf(4, 4));
    for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) expect(stored()[`p${c}${r}`]).toEqual(affine(c / 3, r / 3));
  });

  it("preset recall of a 4 × 4 grid onto a 3 × 3 node lands the preset's grid exactly, in one undo step", async () => {
    const { store, bus, nodeId, stored, set } = await placeGridWarp();
    const label = store.view.getGraph().nodes[nodeId]?.label ?? "";
    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: store.view.getRevision(),
        operations: [{ op: "addNode", ref: "$bank", type: "presets", label: "looks", position: { x: 0, y: 200 }, parameters: { targets: label } }],
      },
      context,
    );
    const bankId = Object.values(store.view.getGraph().nodes).find((node) => node.type === "presets")?.id as NodeId;
    await set({ columns: 4, rows: 4, ...gridPoints(4, 4, affine) });
    expect((await bus.execute("preset.store", { nodeId: bankId, name: "wall" }, context)).status).toBe("applied");
    await set({ columns: 3, rows: 3, ...gridPoints(3, 3, (u, v) => [u, v]) });
    const before = structuredClone(stored());

    expect((await bus.execute("preset.recall", { nodeId: bankId, name: "wall" }, context)).status).toBe("applied");
    expect(Object.keys(stored()).sort()).toEqual(keysOf(4, 4));
    for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) expect(stored()[`p${c}${r}`]).toEqual(affine(c / 3, r / 3));

    await bus.execute("graph.undo", {}, context);
    expect(stored()).toEqual(before);
  });
});

describe("T1532b — the agent's set_parameters resamples too, and its undo takes it back", () => {
  it("columns 3 → 4 on a raised centre: the computed points, no stale keys, one undo to the 3 × 3", async () => {
    const store = createGraphStore({ ids: createSequentialIdFactory("ag"), now: () => "2026-10-03T00:00:00.000Z" });
    const { bus } = createDomainBus({ store, registry });
    const agent: Actor = { kind: "agent", id: "claude" };
    const surface = createAgentToolSurface({ bus, actor: agent, projectId: "project-1", now: () => 1_000 });
    const added = await surface.callTool("add_node", { type: "gridWarp" });
    const nodeId = (added.data as PatchToolData).createdIds["$node"] as NodeId;
    const stored = (): Record<string, StoredParameter> => store.view.getGraph().nodes[nodeId]?.parameters ?? {};

    expect((await surface.callTool("set_parameters", { nodeId, parameters: { p11: [0.7, 0.6] } })).status).toBe("ok");
    const before = structuredClone(stored());
    expect((await surface.callTool("set_parameters", { nodeId, parameters: { columns: 4 } })).status).toBe("ok");

    expect(Object.keys(stored()).sort()).toEqual(keysOf(4, 3));
    for (const c of [1, 2]) expectPoint(stored()[`p${c}1`], [c / 3 + (22 / 27) * 0.2, 0.5 + (22 / 27) * 0.1], `p${c}1`);
    expectPoint(stored()["p31"], [1, 0.5], "p31");

    expect((await surface.callTool("undo", {})).status).toBe("ok");
    expect(stored()).toEqual(before);
  });
});
