import { describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { gridOf, gridWarpPoint, gridWarpSource } from "@nodes/definitions/grid-warp.ts";
import { createNodeRegistry } from "@nodes/registry/index.ts";

/**
 * §T1534b — A ROW OR COLUMN INSERTED AT A PLACE ON THE SURFACE, OR DELETED, THROUGH THE BUS.
 *
 * The real catalogue, a real bus and graph store; every claim is read back from the DOCUMENT
 * and its undo history. Expected points are hand-derived: an AFFINE grid is its own surface
 * under either interpolation, so a column inserted at picture u = 0.3 must hold the affine
 * map at u = 0.3 exactly, and under Linear a warped grid's drawn map must not change at all
 * (a bilinear cell split along a line is two bilinear cells).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const context = contextFor(alice);

/** x = 0.6u + 0.2v + 0.1, y = 0.1u + 0.7v + 0.05 — a Corner Pin parallelogram. */
const affine = (u: number, v: number): [number, number] => [0.6 * u + 0.2 * v + 0.1, 0.1 * u + 0.7 * v + 0.05];

function gridPoints(columns: number, rows: number, place: (u: number, v: number) => [number, number]): Record<string, number[]> {
  const points: Record<string, number[]> = {};
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) points[`p${c}${r}`] = place(c / (columns - 1), r / (rows - 1));
  return points;
}

const keysOf = (columns: number, rows: number): string[] =>
  [
    "columns",
    "feather",
    "interpolation",
    "rows",
    ...Object.keys(gridPoints(columns, rows, (u, v) => [u, v])),
    ...Array.from({ length: columns }, (_, c) => `u${c}`),
    ...Array.from({ length: rows }, (_, r) => `v${r}`),
  ].sort();

async function placeGridWarp() {
  const store = createGraphStore({ ids: createSequentialIdFactory("gl"), now: () => "2026-10-03T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry });
  const added = await bus.execute(
    "graph.applyPatch",
    { baseRevision: 0, operations: [{ op: "addNode", ref: "$warp", type: "gridWarp", label: "wall", position: { x: 0, y: 0 } }] },
    context,
  );
  const nodeId = added.output.createdIds["$warp"] as NodeId;
  const stored = (): Record<string, StoredParameter> => {
    const node = store.view.getGraph().nodes[nodeId];
    if (node === undefined) throw new Error("the Grid Warp left the document");
    return node.parameters;
  };
  const set = async (parameters: Record<string, StoredParameter>) => {
    const result = await bus.execute(
      "graph.applyPatch",
      { baseRevision: store.view.getRevision(), operations: [{ op: "setParameters", nodeId, parameters }] },
      context,
    );
    expect(result.status).toBe("applied");
  };
  const undos = () => store.view.getHistory(alice).undo.length;
  return { store, bus, nodeId, stored, set, undos };
}

function expectPoint(actual: StoredParameter | undefined, expected: readonly [number, number], label: string): void {
  const [x, y] = actual as [number, number];
  expect(x, `${label}.x`).toBeCloseTo(expected[0], 14);
  expect(y, `${label}.y`).toBeCloseTo(expected[1], 14);
}

describe("T1534b — gridWarp.insertLine", () => {
  it("a column at u = 0.3 of an affine 3 × 3 grid holds the affine map there; the rest keep their values; one undo restores", async () => {
    const { bus, nodeId, stored, set, undos } = await placeGridWarp();
    await set(gridPoints(3, 3, affine));
    const before = structuredClone(stored());
    const undoBefore = undos();

    const result = await bus.execute("gridWarp.insertLine", { nodeId, axis: "column", at: 0.3 }, context);
    expect(result.status).toBe("applied");
    expect(result.output).toEqual({ ok: true, columns: 4, rows: 3 });

    expect(Object.keys(stored()).sort()).toEqual(keysOf(4, 3));
    for (let r = 0; r < 3; r += 1) {
      expectPoint(stored()[`p1${r}`], affine(0.3, r / 2), `p1${r}`);
      // Old columns 0, 1, 2 are now 0, 2, 3 — bit for bit.
      expect(stored()[`p0${r}`]).toEqual(before[`p0${r}`]);
      expect(stored()[`p2${r}`]).toEqual(before[`p1${r}`]);
      expect(stored()[`p3${r}`]).toEqual(before[`p2${r}`]);
    }
    expect([stored()["u0"], stored()["u2"], stored()["u3"]]).toEqual([0, 0.5, 1]);
    expect(stored()["u1"]).toBeCloseTo(0.3, 15);
    expect(undos()).toBe(undoBefore + 1);

    await bus.execute("graph.undo", {}, context);
    expect(stored()).toEqual(before);
  });

  it("LINEAR: a row inserted into a warped grid leaves the drawn map the same at every sampled point", async () => {
    const { bus, nodeId, stored, set } = await placeGridWarp();
    await set({ interpolation: "linear", p11: [0.62, 0.58], p22: [0.93, 1.04], p01: [0.05, 0.47] });
    const before = gridOf(stored());
    // at 0.25 is grid coordinate 0.5: half way up cell 0.
    expect((await bus.execute("gridWarp.insertLine", { nodeId, axis: "row", at: 0.25 }, context)).status).toBe("applied");
    const after = gridOf(stored());
    expect([after.columns, after.rows]).toEqual([3, 4]);
    /** Old row coordinate → new: cell 0 splits in two halves, everything above moves up one. */
    const there = (gv: number): number => (gv <= 0.5 ? gv * 2 : gv <= 1 ? 1 + (gv - 0.5) * 2 : gv + 1);
    for (const gu of [0, 0.3, 1, 1.7, 2]) {
      for (const gv of [0, 0.2, 0.5, 0.8, 1, 1.4, 2]) {
        const [x, y] = gridWarpPoint(after, gu, there(gv));
        const [ox, oy] = gridWarpPoint(before, gu, gv);
        expect(x, `x at ${gu},${gv}`).toBeCloseTo(ox, 13);
        expect(y, `y at ${gu},${gv}`).toBeCloseTo(oy, 13);
        expect(gridWarpSource(after, gu, there(gv))[1], `v at ${gu},${gv}`).toBeCloseTo(gridWarpSource(before, gu, gv)[1], 13);
      }
    }
  });

  it("refuses at 8 columns, on an existing line and outside the surface — the document untouched, a named reason", async () => {
    const { bus, store, nodeId, set, stored } = await placeGridWarp();
    await set({ columns: 8 });
    const before = structuredClone(stored());
    const revision = store.view.getRevision();
    const full = await bus.execute("gridWarp.insertLine", { nodeId, axis: "column", at: 0.5 }, context);
    expect(full.status).toBe("rejected");
    expect(full.output).toEqual({ ok: false, columns: 8, rows: 3 });
    expect(full.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["gridWarp.line.max", 'Grid Warp "wall": the grid already has 8 columns, the most it can have.'],
    ]);
    const onLine = await bus.execute("gridWarp.insertLine", { nodeId, axis: "row", at: 0.5 }, context);
    expect(onLine.diagnostics.map((d) => d.code)).toEqual(["gridWarp.line.exists"]);
    const outside = await bus.execute("gridWarp.insertLine", { nodeId, axis: "row", at: 1.2 }, context);
    expect(outside.diagnostics.map((d) => d.code)).toEqual(["gridWarp.line.outside"]);
    expect(store.view.getRevision()).toBe(revision);
    expect(stored()).toEqual(before);
  });

  it("refuses a grid with a driven size, naming the key, and a node that is not a Grid Warp", async () => {
    const { bus, store, nodeId, set } = await placeGridWarp();
    await set({ rows: { mode: "expression", bindings: { expression: { kind: "expression", source: "3" }, static: { kind: "static", value: 3 } } } });
    const driven = await bus.execute("gridWarp.insertLine", { nodeId, axis: "column", at: 0.25 }, context);
    expect(driven.status).toBe("rejected");
    expect(driven.diagnostics.map((d) => d.code)).toEqual(["gridWarp.line.driven"]);
    expect(driven.diagnostics[0]?.message).toMatch(/rows is not a Constant value/);

    const blur = await bus.execute(
      "graph.applyPatch",
      { baseRevision: store.view.getRevision(), operations: [{ op: "addNode", ref: "$b", type: "blur", position: { x: 0, y: 100 } }] },
      context,
    );
    const blurId = blur.output.createdIds["$b"] as NodeId;
    const wrong = await bus.execute("gridWarp.deleteLine", { nodeId: blurId, axis: "row", index: 0 }, context);
    expect(wrong.diagnostics.map((d) => d.code)).toEqual(["gridWarp.node.type"]);
  });
});

describe("T1534b — gridWarp.deleteLine", () => {
  it("removes exactly that column: the others keep their values bit for bit, its keys are gone; one undo restores", async () => {
    const { bus, nodeId, stored, set, undos } = await placeGridWarp();
    await set({ columns: 4, ...gridPoints(4, 3, affine), p21: [0.66, 0.51] });
    const before = structuredClone(stored());
    const undoBefore = undos();

    const result = await bus.execute("gridWarp.deleteLine", { nodeId, axis: "column", index: 1 }, context);
    expect(result.output).toEqual({ ok: true, columns: 3, rows: 3 });
    expect(Object.keys(stored()).sort()).toEqual(keysOf(3, 3));
    for (let r = 0; r < 3; r += 1) {
      expect(stored()[`p0${r}`]).toEqual(before[`p0${r}`]);
      expect(stored()[`p1${r}`]).toEqual(before[`p2${r}`]);
      expect(stored()[`p2${r}`]).toEqual(before[`p3${r}`]);
    }
    // The picture positions of the lines that stay: 0, 2/3 and 1.
    expect([stored()["u0"], stored()["u1"], stored()["u2"]]).toEqual([before["u0"], before["u2"], before["u3"]]);
    expect(undos()).toBe(undoBefore + 1);

    await bus.execute("graph.undo", {}, context);
    expect(stored()).toEqual(before);
  });

  it("deleting the column an insert made gives back the grid it was inserted into, exactly", async () => {
    const { bus, nodeId, stored, set } = await placeGridWarp();
    await set({ p11: [0.62, 0.58], p22: [0.93, 1.04] });
    const before = structuredClone(stored());
    await bus.execute("gridWarp.insertLine", { nodeId, axis: "column", at: 0.8 }, context);
    // 0.8 is grid coordinate 1.6: the new column is column 2 (from 0).
    await bus.execute("gridWarp.deleteLine", { nodeId, axis: "column", index: 2 }, context);
    expect(stored()).toEqual(before);
  });

  it("refuses at 2 rows and for a row the grid lacks, the document untouched", async () => {
    const { bus, store, nodeId, set, stored } = await placeGridWarp();
    await set({ rows: 2 });
    const before = structuredClone(stored());
    const revision = store.view.getRevision();
    const fewest = await bus.execute("gridWarp.deleteLine", { nodeId, axis: "row", index: 0 }, context);
    expect(fewest.status).toBe("rejected");
    expect(fewest.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["gridWarp.line.min", 'Grid Warp "wall": the grid has 2 rows, the fewest it can have.'],
    ]);
    const missing = await bus.execute("gridWarp.deleteLine", { nodeId, axis: "column", index: 3 }, context);
    expect(missing.diagnostics.map((d) => d.code)).toEqual(["gridWarp.line.missing"]);
    expect(store.view.getRevision()).toBe(revision);
    expect(stored()).toEqual(before);
  });
});
