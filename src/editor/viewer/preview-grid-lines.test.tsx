// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import type { Node } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/index.ts";
import { gizmoTilesFor } from "./gizmo-tiles.ts";
import { PreviewGizmoOverlays } from "./preview-gizmo-overlay.tsx";
import type { GridLineActions, PreviewGizmoTile } from "./preview-gizmo-overlay.tsx";
import { createPreviewSlotBounds } from "./preview-slot-bounds.ts";
import { createVec3GizmoStore } from "./vec3-gizmo-store.ts";

/**
 * §T1534b — A GRID WARP'S ROWS AND COLUMNS, INSERTED AND DELETED ON ITS OWN PICTURE.
 *
 * The whole seam: the real Grid Warp in the real registry, a real bus and graph store, the
 * pane's own tile derivation (`gizmoTilesFor`, which hands the overlay the grid), and the
 * overlay itself. The line actions dispatch `gridWarp.insertLine` / `gridWarp.deleteLine`
 * on the bus exactly as `graph-pane.tsx` does. Claims are read back from the DOCUMENT and
 * its undo history.
 *
 * Geometry as `preview-gizmo-picture.test.tsx`: a square picture letterboxed in a 170×96
 * slot lands on screen at { 322, 162, 192×192 }; the layer sits at the client origin in
 * jsdom, so a client point IS a pane point. Output (u, v) is at (322 + 192u, 162 + 192(1 − v)).
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
});
afterEach(cleanup);

const NODE_POSITION = { x: 100, y: 50 };
const SLOT_BOX = { x: 4, y: 26, width: 170, height: 96 };
const VIEWPORT = { x: 40, y: 10, zoom: 2 };
const SOURCE: readonly [number, number] = [96, 96];
const RECT = { x: 322, y: 162, width: 192, height: 192 };
const screenAt = (u: number, v: number) => ({ clientX: RECT.x + u * RECT.width, clientY: RECT.y + (1 - v) * RECT.height });

const registry = createNodeRegistry(allNodeDefinitions).view();
const context = contextFor(alice);
const schedule = (run: () => void): (() => void) => {
  run();
  return () => {};
};

function FlowState({ nodes }: { nodes: Node[] }) {
  const api = useStoreApi();
  useEffect(() => {
    api.getState().setNodes(nodes);
    api.setState({ transform: [VIEWPORT.x, VIEWPORT.y, VIEWPORT.zoom] });
  }, [api, nodes]);
  return null;
}

async function frames(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  }
}

async function mountGridWarp(parameters: Record<string, StoredParameter> = {}) {
  const store = createGraphStore({ ids: createSequentialIdFactory("gw"), now: () => "2026-10-03T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry });
  const added = await bus.execute(
    "graph.applyPatch",
    { baseRevision: 0, operations: [{ op: "addNode", ref: "$warp", type: "gridWarp", position: { x: 0, y: 0 }, parameters }] },
    context,
  );
  const nodeId = added.output.createdIds["$warp"] as NodeId;
  const editor = createParameterEditor({ bus, context, schedule });
  const gizmos = createVec3GizmoStore({ editor });
  const pending: Array<Promise<unknown>> = [];
  // graph-pane.tsx's adapter: the overlay's two line actions, dispatched on the bus.
  const lines: GridLineActions = {
    insert: (id, axis, at) => void pending.push(bus.execute("gridWarp.insertLine", { nodeId: id, axis, at }, context)),
    remove: (id, axis, index) => void pending.push(bus.execute("gridWarp.deleteLine", { nodeId: id, axis, index }, context)),
  };
  const tile = (id: NodeId): PreviewGizmoTile | null => {
    const facts = gizmoTilesFor([{ nodeId, portId: "out", size: SOURCE }], store.view.getGraph().nodes, registry).get(id);
    return facts === undefined ? null : { ...facts, orbit: undefined };
  };
  const bounds = createPreviewSlotBounds();
  const nodes: Node[] = [{ id: nodeId, position: NODE_POSITION, data: {}, width: 178, height: 120 }];
  render(
    <ReactFlowProvider>
      <FlowState nodes={nodes} />
      <PreviewGizmoOverlays bounds={bounds} tile={tile} store={gizmos} active lines={lines} />
    </ReactFlowProvider>,
  );
  act(() => bounds.publish(nodeId, SLOT_BOX));
  const stored = (): Record<string, StoredParameter> => store.view.getGraph().nodes[nodeId]?.parameters ?? {};
  const settled = async () => {
    await act(async () => {
      await Promise.all(pending);
      await editor.settled();
    });
    await frames();
  };
  const surface = () => screen.queryByTestId(`preview-grid-surface-${nodeId}`);
  const holdAlt = (shift = false) => act(() => void fireEvent.keyDown(window, { key: "Alt", altKey: true, shiftKey: shift }));
  const releaseAlt = () => act(() => void fireEvent.keyUp(window, { key: "Alt", altKey: false }));
  const undos = () => store.view.getHistory(alice).undo.length;
  return { bus, store, nodeId, stored, settled, surface, holdAlt, releaseAlt, undos };
}

describe("T1534b — Option/Alt-click on a Grid Warp's picture inserts a line there", () => {
  it("offers nothing to a plain press: the capture surface exists only while alt is held", async () => {
    const { surface, holdAlt, releaseAlt } = await mountGridWarp();
    await frames();
    expect(surface()).toBeNull();
    holdAlt();
    expect(surface()).not.toBeNull();
    releaseAlt();
    expect(surface()).toBeNull();
  });

  it("hovering draws the column a click would insert; the click inserts it through the bus as ONE undo step", async () => {
    const { bus, stored, settled, surface, holdAlt, undos } = await mountGridWarp();
    await frames();
    holdAlt();
    const element = surface() as HTMLElement;
    fireEvent.pointerMove(element, { ...screenAt(0.25, 0.5), altKey: true });
    // The preview runs the full height of the surface: 2 cells × 16 mesh steps + 1 points.
    const line = screen.getByTestId(/^preview-grid-line-/);
    expect(line.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(33);

    const before = structuredClone(stored());
    const undoBefore = undos();
    fireEvent.pointerDown(element, { ...screenAt(0.25, 0.5), button: 0, altKey: true });
    await settled();

    expect(stored()["columns"]).toBe(4);
    expect(stored()["u1"]).toBeCloseTo(0.25, 12);
    for (const r of [0, 1, 2]) {
      const [x, y] = stored()[`p1${r}`] as [number, number];
      expect(x).toBeCloseTo(0.25, 12);
      expect(y).toBeCloseTo(r / 2, 12);
    }
    expect(stored()["p20"]).toEqual(before["p10"]);
    expect(undos()).toBe(undoBefore + 1);

    await bus.execute("graph.undo", {}, context);
    expect(stored()).toEqual(before);
  });

  it("with Shift too, the click inserts a ROW", async () => {
    const { stored, settled, surface, holdAlt } = await mountGridWarp();
    await frames();
    holdAlt(true);
    fireEvent.pointerDown(surface() as HTMLElement, { ...screenAt(0.4, 0.75), button: 0, altKey: true, shiftKey: true });
    await settled();
    expect([stored()["columns"], stored()["rows"]]).toEqual([3, 4]);
    expect(stored()["v2"]).toBeCloseTo(0.75, 12);
  });

  it("a click off the warped surface does nothing", async () => {
    // The surface shrunk to the middle of the picture: its corners at 0.25 and 0.75.
    const shrunk: Record<string, StoredParameter> = {};
    for (const r of [0, 1, 2]) for (const c of [0, 1, 2]) shrunk[`p${c}${r}`] = [0.25 + c / 4, 0.25 + r / 4];
    const { store, stored, settled, surface, holdAlt } = await mountGridWarp(shrunk);
    await frames();
    const revision = store.view.getRevision();
    holdAlt();
    fireEvent.pointerDown(surface() as HTMLElement, { ...screenAt(0.1, 0.9), button: 0, altKey: true });
    await settled();
    expect(store.view.getRevision()).toBe(revision);
    expect(stored()["columns"]).toBe(3);
    // ...and the same click inside it does insert, at the surface's own coordinate: output
    // x = 0.375 is a quarter of the way across a surface spanning 0.25..0.75.
    fireEvent.pointerDown(surface() as HTMLElement, { ...screenAt(0.375, 0.5), button: 0, altKey: true });
    await settled();
    expect(stored()["columns"]).toBe(4);
    expect(stored()["u1"]).toBeCloseTo(0.25, 9);
  });
});

describe("T1534b — right-click a Grid Warp point to delete its row or column", () => {
  it("'Delete column 2' removes the point's column through the bus; at 2 rows 'Delete row' is disabled, saying why", async () => {
    const { bus, stored, settled, nodeId, undos } = await mountGridWarp({ rows: 2, p11: [0.6, 0.9] });
    await frames();
    const before = structuredClone(stored());
    const undoBefore = undos();
    fireEvent.contextMenu(screen.getByTestId(`preview-gizmo-${nodeId}-p11`), { clientX: 400, clientY: 200 });
    const row = screen.getByRole("menuitem", { name: /Delete row 2/ });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("2 is the fewest");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Delete column 2/ }));
    });
    await settled();

    expect([stored()["columns"], stored()["rows"]]).toEqual([2, 2]);
    // The outer columns stay, bit for bit; the middle one (and its raised point) is gone.
    expect([stored()["p00"], stored()["p10"], stored()["p01"], stored()["p11"]]).toEqual([before["p00"], before["p20"], before["p01"], before["p21"]]);
    expect(Object.keys(stored()).filter((key) => /^p2|^u2/.test(key))).toEqual([]);
    expect(undos()).toBe(undoBefore + 1);
    await bus.execute("graph.undo", {}, context);
    expect(stored()).toEqual(before);
  });

  it("a Grid Warp point still DRAGS with the left button: one key, one undo step", async () => {
    const { stored, settled, nodeId, undos } = await mountGridWarp();
    await frames();
    const undoBefore = undos();
    const handle = screen.getByTestId(`preview-gizmo-${nodeId}-p11`);
    // Pressed on the centre point (0.5, 0.5), released at (0.75, 0.5).
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, ...screenAt(0.5, 0.5) });
    fireEvent.pointerMove(handle, { pointerId: 1, ...screenAt(0.6, 0.5) });
    fireEvent.pointerMove(handle, { pointerId: 1, ...screenAt(0.75, 0.5) });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await settled();
    expect(stored()["p11"]).toEqual([0.75, 0.5]);
    expect(stored()["columns"]).toBe(3);
    expect(undos()).toBe(undoBefore + 1);
  });
});
