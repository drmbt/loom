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
import { STORED_READ, effectiveParameterSchema, resolveParameters } from "@domain/parameters/resolve.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/index.ts";
import { PreviewGizmoOverlays } from "./preview-gizmo-overlay.tsx";
import type { PreviewGizmoTile } from "./preview-gizmo-overlay.tsx";
import { createPreviewSlotBounds } from "./preview-slot-bounds.ts";
import { createVec3GizmoStore, pictureHandlesFor } from "./vec3-gizmo-store.ts";

/**
 * §T1491b — CORNER PIN'S PINS ARE DRAGGED ON ITS OWN PICTURE, THROUGH THE BUS, ONE UNDO STEP.
 *
 * The whole seam, with nothing recorded in place of the real thing: the real Corner Pin
 * manifest in the real registry, a real bus and graph store, the inspector's own
 * `ParameterEditor` (the only door a gizmo may write through, §V29), and the overlay placing
 * the handles on a texture tile with no camera. The claims are read back from the DOCUMENT
 * and its undo history, not from which function was called.
 *
 * The letterbox bites here as it does in `preview-gizmo-overlay.test.tsx` (same numbers): a
 * square picture in a 170×96 slot, so a pin placed on the slot rather than the picture would
 * sit 37 px off in x and the drag arithmetic would divide by the wrong width.
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
/** The picture on screen: fitted { 41, 26, 96×96 } → graph { 141, 76 } → screen ×2 + pan. */
const RECT = { x: 322, y: 162, width: 192, height: 192 };

const registry = createNodeRegistry(allNodeDefinitions).view();
const context = contextFor(alice);
/** Immediate: the editor's default scheduler is rAF, and a live frame must reach the bus. */
const schedule = (run: () => void): (() => void) => {
  run();
  return () => {};
};

type FlowApi = ReturnType<typeof useStoreApi>;

function FlowState({ nodes }: { nodes: Node[] }) {
  const api: FlowApi = useStoreApi();
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

async function mountCornerPin() {
  const store = createGraphStore({ ids: createSequentialIdFactory("cp"), now: () => "2026-09-29T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry });
  const added = await bus.execute(
    "graph.applyPatch",
    { baseRevision: 0, operations: [{ op: "addNode", ref: "$pin", type: "cornerPin", position: { x: 0, y: 0 } }] },
    context,
  );
  const nodeId = added.output.createdIds["$pin"] as NodeId;
  const editor = createParameterEditor({ bus, context, schedule });
  const gizmos = createVec3GizmoStore({ editor });

  /** The effective values, as the app resolves them — read fresh, so a handle follows the document. */
  const values = (): Readonly<Record<string, ParameterValue>> => {
    const node = store.view.getGraph().nodes[nodeId];
    const definition = registry.get("cornerPin");
    if (node === undefined || definition === undefined) throw new Error("the Corner Pin left the document");
    return resolveParameters(node, definition, STORED_READ).values;
  };
  const tile = (id: NodeId): PreviewGizmoTile | null => {
    if (id !== nodeId) return null;
    const node = store.view.getGraph().nodes[nodeId];
    const definition = registry.get("cornerPin");
    if (node === undefined || definition === undefined) return null;
    const resolved = resolveParameters(node, definition, STORED_READ);
    const handles = pictureHandlesFor({
      schema: effectiveParameterSchema(definition, node.parameters),
      resolved: resolved.entries,
      values: resolved.values,
    });
    // A texture tile: no basis, no orbit — the picture rect is the whole frame.
    return { orbit: undefined, source: SOURCE, handles };
  };
  const bounds = createPreviewSlotBounds();
  const nodes: Node[] = [{ id: nodeId, position: NODE_POSITION, data: {}, width: 178, height: 120 }];
  render(
    <ReactFlowProvider>
      <FlowState nodes={nodes} />
      <PreviewGizmoOverlays bounds={bounds} tile={tile} store={gizmos} active />
    </ReactFlowProvider>,
  );
  act(() => bounds.publish(nodeId, SLOT_BOX));
  const handleOf = (key: string) => screen.getByTestId(`preview-gizmo-${nodeId}-${key}`);
  return { bus, store, editor, nodeId, values, handleOf };
}

describe("T1491b — Corner Pin's pins on its own picture", () => {
  it("draws each pin at its corner of the LETTERBOXED picture, y up", async () => {
    const { handleOf } = await mountCornerPin();
    const place = (key: string) => [handleOf(key).style.left, handleOf(key).style.top];
    // Bottom left is (0, 0) in the value and the rect's bottom-left on screen.
    expect(place("pinbl")).toEqual([`${RECT.x}px`, `${RECT.y + RECT.height}px`]);
    expect(place("pinbr")).toEqual([`${RECT.x + RECT.width}px`, `${RECT.y + RECT.height}px`]);
    expect(place("pintr")).toEqual([`${RECT.x + RECT.width}px`, `${RECT.y}px`]);
    expect(place("pintl")).toEqual([`${RECT.x}px`, `${RECT.y}px`]);
  });

  it("dragging a pin writes it through the bus as ONE undo step, and the handle follows", async () => {
    const { store, bus, editor, values, handleOf } = await mountCornerPin();
    const undoBefore = store.view.getHistory(alice).undo.length;
    const element = handleOf("pintr");
    // Pressed on the handle's centre (no grab offset), then a quarter of the picture left
    // and half of it down, in three frames' worth of moves: (0.75, 0.5) in the value.
    fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: 514, clientY: 162 });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 500, clientY: 190 });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 480, clientY: 230 });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 466, clientY: 258 });
    fireEvent.pointerUp(element, { pointerId: 1 });
    await act(async () => {
      await editor.settled();
    });

    expect(values()["pintr"]).toEqual([0.75, 0.5]);
    // The other three corners did not move: the gesture wrote its own key only.
    expect(values()["pinbl"]).toEqual([0, 0]);
    expect(values()["pintl"]).toEqual([0, 1]);
    // Three live frames and a commit, and the history grew by exactly one group (§V15).
    expect(store.view.getHistory(alice).undo.length).toBe(undoBefore + 1);

    // The handle is drawn where the DOCUMENT now says the pin is.
    await frames();
    expect(handleOf("pintr").style.left).toBe(`${RECT.x + 0.75 * RECT.width}px`);
    expect(handleOf("pintr").style.top).toBe(`${RECT.y + 0.5 * RECT.height}px`);

    // One undo takes the whole drag back — not to an intermediate frame.
    await bus.execute("graph.undo", {}, context);
    expect(values()["pintr"]).toEqual([1, 1]);
  });
});
