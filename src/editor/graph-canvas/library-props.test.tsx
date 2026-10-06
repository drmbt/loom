// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useStoreApi } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { GraphCanvas } from "./graph-canvas.tsx";
import { createNodeRuntimeStore } from "./node-runtime.ts";
import { installFlowStubs } from "./testing.tsx";

/**
 * T1653b — WHAT THE CANVAS HANDS THE LIBRARY DOES NOT CHANGE IDENTITY BETWEEN TWO RENDERS
 * WITH THE SAME INPUTS.
 *
 * `panOnDrag={[...PAN_MOUSE_BUTTONS]}` was a new array per render. React Flow's zoom pane
 * keys an effect on that prop's identity; the effect re-binds its non-passive `wheel`
 * listener on the canvas root; and for a blocking wheel listener that changed, Chromium
 * re-derives the hit-test data of everything under it. One value written therefore
 * repainted every node of the document with no DOM change at all: its paint invalidator
 * visited 900 layout objects on a 54-node document where a frame without a write visits
 * 15, and the paint cost 0.1 ms a node (21 ms at 204 nodes, 80 at 804).
 *
 * That is a CLASS, not one prop: the library copies every prop into its store when the
 * prop's identity changes (`StoreUpdater`), and keys effects on several. So the gate is on
 * the class, three ways:
 *
 *  1. every prop handed to `<ReactFlow>` is the same object across a render of the canvas
 *     whose inputs did not change (exemptions by name, with the reason);
 *  2. across that render no listener is removed from or added to the canvas root, and the
 *     library's store is not written;
 *  3. a VALUE written to a node — which legitimately hands the library new nodes — still
 *     re-binds nothing on the canvas root. Nor does a pan; a zoom writes the store (the
 *     wire range, `WireRangeDriver`) and re-binds nothing.
 *
 * jsdom has no paint, so what is held here is the cause. The effect, counted from
 * Chromium's own trace, is `src/tests/e2e/canvas-paint.spec.ts`.
 */

const recorded = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  const Library = original.ReactFlow as unknown as (props: Record<string, unknown>) => ReactNode;
  return {
    ...original,
    ReactFlow: (props: Record<string, unknown>) => {
      recorded.props.push(props);
      return <Library {...props} />;
    },
  };
});

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(() => {
  cleanup();
  recorded.props = [];
});

const invocation = contextFor(alice);

/**
 * Props that MAY be another object on a render with the same inputs, and why that is safe.
 * Anything not named here must be identical, or this file fails naming it.
 */
const MAY_CHANGE: Readonly<Record<string, string>> = {
  children: "React elements are made per render; the library renders them and keys no effect and no store write on them.",
};

type FlowStore = ReturnType<typeof useStoreApi>;

/** Hands the library's store out of the canvas (`underlay` is rendered inside `<ReactFlow>`). */
function StoreProbe({ onStore }: { readonly onStore: (store: FlowStore) => void }) {
  onStore(useStoreApi());
  return null;
}

/** add/removeEventListener calls on the canvas's own elements, while `watch` runs. */
async function listenerChurn(root: Element, watch: () => Promise<void>): Promise<string[]> {
  const calls: string[] = [];
  const own = (target: unknown): target is Element => target instanceof Element && (target === root || root.contains(target)) && isRootElement(target);
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: [EventListenerOrEventListenerObject | null, (boolean | AddEventListenerOptions)?]) {
    if (own(this)) calls.push(`add ${type} on .${String(this.className).split(" ")[0] ?? ""}`);
    return add.call(this, type, ...rest);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, ...rest: [EventListenerOrEventListenerObject | null, (boolean | EventListenerOptions)?]) {
    if (own(this)) calls.push(`remove ${type} on .${String(this.className).split(" ")[0] ?? ""}`);
    return remove.call(this, type, ...rest);
  };
  try {
    await watch();
  } finally {
    EventTarget.prototype.addEventListener = add;
    EventTarget.prototype.removeEventListener = remove;
  }
  return calls;
}

/** The canvas root and the library's own root elements: where a pan, a zoom and a selection are heard. Not a node. */
const isRootElement = (element: Element): boolean =>
  element.matches('[data-testid="graph-canvas"], .react-flow, .react-flow__renderer, .react-flow__pane, .react-flow__viewport, .react-flow__selectionpane');

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function mountCanvas() {
  const { bus } = createHarness("c");
  const runtime = createNodeRuntimeStore({ intervalMs: 0 });
  await act(async () => {
    await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), [
        { op: "addNode", ref: "$solid", type: "test.solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 240, y: 40 } },
        { op: "connect", source: { nodeId: "$solid", portId: "out" }, target: { nodeId: "$blur", portId: "source" } },
      ], "seed"),
      invocation,
    );
  });
  let store: FlowStore | null = null;
  const underlay = <StoreProbe onStore={(found) => { store = found; }} />;
  const element = (canvasBus: LoomBus) => <GraphCanvas bus={canvasBus} invocation={invocation} runtime={runtime} underlay={underlay} />;
  const view = render(element(bus));
  await waitFor(() => expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2));
  // The library measures nodes on a later task and writes what it measured; wait that out.
  await settle();
  await settle();
  const root = view.container.querySelector('[data-testid="graph-canvas"]');
  if (root === null || store === null) throw new Error("the canvas did not mount");
  return { view, bus, root, store: store as FlowStore, again: () => view.rerender(element(bus)) };
}

describe("T1653b — the canvas does not hand the library a new identity for an unchanged input", () => {
  it("every prop is the same object across a render with the same inputs; nothing is re-bound on the canvas root; the library's store is not written", async () => {
    const { root, store, again } = await mountCanvas();
    const before = recorded.props[recorded.props.length - 1] as Record<string, unknown>;
    const rendersBefore = recorded.props.length;
    let storeWrites = 0;
    const off = store.subscribe(() => {
      storeWrites += 1;
    });
    const churn = await listenerChurn(root, async () => {
      await act(async () => {
        again();
      });
      await settle();
    });
    off();

    // The render happened: the library was handed its props again.
    expect(recorded.props.length, "the canvas did not render again, so nothing was compared").toBeGreaterThan(rendersBefore);
    const after = recorded.props[recorded.props.length - 1] as Record<string, unknown>;
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    const moved = Object.keys(after).filter((key) => after[key] !== before[key] && MAY_CHANGE[key] === undefined);
    expect(moved, `props handed to <ReactFlow> that are another object for the same inputs: ${moved.join(", ")}`).toEqual([]);
    // The exemption list describes props that exist.
    expect(Object.keys(MAY_CHANGE).filter((key) => !(key in after))).toEqual([]);

    expect(churn, "listeners were re-bound on the canvas root for a render that changed nothing").toEqual([]);
    expect(storeWrites, "the library's store was written for a render that changed nothing").toBe(0);
  });

  it("a value written to a node hands the library new nodes and STILL re-binds nothing on the canvas root", async () => {
    const { bus, root } = await mountCanvas();
    const blur = Object.values(bus.store.getGraph().nodes).find((node) => node.type === "test.blur");
    if (blur === undefined) throw new Error("expected the blur node");
    const nodesBefore = (recorded.props[recorded.props.length - 1] as Record<string, unknown>)["nodes"];
    const churn = await listenerChurn(root, async () => {
      await act(async () => {
        const result = await bus.execute("graph.applyPatch", patch(bus.store.getRevision(), [{ op: "moveNodes", positions: { [blur.id as NodeId]: { x: 512, y: 96 } } }], "move"), invocation);
        expect(result.status).toBe("applied");
      });
      await settle();
    });
    // Not vacuous: the canvas rendered for it, with other nodes.
    expect((recorded.props[recorded.props.length - 1] as Record<string, unknown>)["nodes"]).not.toBe(nodesBefore);
    expect(churn, "a document change re-bound listeners on the canvas root").toEqual([]);
  });

  it("a VALUE written to a node hands the library nothing new: every prop the same object, its store not written (T1668b)", async () => {
    const { bus, root, store } = await mountCanvas();
    const blur = Object.values(bus.store.getGraph().nodes).find((node) => node.type === "test.blur");
    if (blur === undefined) throw new Error("expected the blur node");
    const before = recorded.props[recorded.props.length - 1] as Record<string, unknown>;
    const rendersBefore = recorded.props.length;
    let storeWrites = 0;
    const off = store.subscribe(() => {
      storeWrites += 1;
    });
    const churn = await listenerChurn(root, async () => {
      await act(async () => {
        const result = await bus.execute("graph.applyPatch", patch(bus.store.getRevision(), [{ op: "setParameters", nodeId: blur.id as NodeId, parameters: { radius: 9 } }], "value"), invocation);
        expect(result.status).toBe("applied");
      });
      await settle();
    });
    off();
    // The canvas may render for it or not; what it hands the library, when it does, is what it handed before.
    const after = recorded.props[recorded.props.length - 1] as Record<string, unknown>;
    const moved = Object.keys(after).filter((key) => after[key] !== before[key] && MAY_CHANGE[key] === undefined);
    expect(moved, `props handed to <ReactFlow> that are another object after a value was written (${String(recorded.props.length - rendersBefore)} renders): ${moved.join(", ")}`).toEqual([]);
    expect(storeWrites, "the library's store was written for a value").toBe(0);
    expect(churn).toEqual([]);
  });

  it("a pan writes nothing but the transform and re-binds nothing; a zoom moves the wire range in the store and re-binds nothing", async () => {
    const { root, store } = await mountCanvas();
    const radiusBefore = store.getState().connectionRadius;
    const [x, y, zoom] = store.getState().transform;
    let writes = 0;
    const off = store.subscribe(() => {
      writes += 1;
    });
    const pan = await listenerChurn(root, async () => {
      await act(async () => {
        store.setState({ transform: [x + 40, y + 12, zoom] });
      });
      await settle();
    });
    expect(pan, "a pan re-bound listeners on the canvas root").toEqual([]);
    expect(writes, "a pan wrote the library's store beyond the transform itself").toBe(1);
    expect(store.getState().connectionRadius).toBe(radiusBefore);

    writes = 0;
    const zoomed = await listenerChurn(root, async () => {
      await act(async () => {
        store.setState({ transform: [x + 40, y + 12, zoom * 2] });
      });
      await settle();
    });
    off();
    expect(zoomed, "a zoom re-bound listeners on the canvas root").toEqual([]);
    // The transform, and the range a wire connects from following it (T1639b): two writes, no more.
    expect(store.getState().connectionRadius).not.toBe(radiusBefore);
    expect(writes).toBe(2);
  });
});
