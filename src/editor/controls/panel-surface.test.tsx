// @vitest-environment jsdom
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { fixtureContext, installFlowStubs, nodeProps } from "@editor/graph-canvas/testing.tsx";
import { CanvasFixture } from "@editor/graph-canvas/canvas-fixture.tsx";
import { NodeView } from "@editor/nodes/node-view.tsx";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { buildPhoneSnapshot } from "@devices/phone/phone-snapshot.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { useControlBodies } from "./control-bodies.tsx";
import type { ControlWrite } from "./control-widget.tsx";
import { ControlsPane } from "./controls-pane.tsx";
import { PANEL_EMPTY_HINT, type PhoneDoorView } from "./phone-door-copy.ts";

/**
 * T1512b — THE PANEL NODE IS THE SURFACE, as a person meets it on the canvas: the Panel's
 * body shows the widgets wired into it, live — a drag on its slider moves the SLIDER NODE,
 * in one undo step — and a fresh Panel says how to fill it. The Panel's body, the Controls
 * tab and the phone snapshot come from one derivation, so for the same document they list
 * the same widgets in the same order; this reads all three back and compares them.
 *
 * Mounted through the SAME seams the graph pane hands the canvas (`useControlBodies`), on
 * the real bus and registry.
 */
beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

async function runtimeWith(operations: GraphPatchOperation[]): Promise<{ runtime: AppRuntime; ids: Record<string, NodeId> }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), label: "setup", operations },
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return { runtime, ids: result.output.createdIds as Record<string, NodeId> };
}

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
const wire = (from: string, to: string): GraphPatchOperation =>
  ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: `$${to}`, portId: "controls" } }) as GraphPatchOperation;

/** One node on a canvas, with the product's control seams. */
function OnCanvas({ runtime, nodeId, phone }: { runtime: AppRuntime; nodeId: NodeId; phone?: PhoneDoorView }) {
  const editor = useMemo(() => createParameterEditor({ bus: runtime.bus, context: runtime.invocation }), [runtime]);
  useEffect(() => () => editor.dispose(), [editor]);
  const write = useMemo<ControlWrite>(() => (id, entries, phase) => editor.setStored(id, entries, phase), [editor]);
  const bodies = useControlBodies({ bus: runtime.bus, invocation: runtime.invocation, write, phone });
  const { value } = useMemo(
    () => fixtureContext({ store: runtime.bus.store, registry: runtime.bus.registry, ...bodies }),
    [runtime, bodies],
  );
  return (
    <CanvasFixture value={value}>
      <NodeView {...nodeProps(nodeId)} />
    </CanvasFixture>
  );
}

function Tab({ runtime }: { runtime: AppRuntime }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} />;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/** The widgets a surface shows, in the order it shows them. */
const shownOrder = (root: HTMLElement): string[] =>
  [...root.querySelectorAll("[data-control-node]")].map((element) => element.getAttribute("data-control-node")!);

function stubTrack(track: HTMLElement): void {
  track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
  track.setPointerCapture = () => undefined;
  track.releasePointerCapture = () => undefined;
  track.hasPointerCapture = () => true;
}

describe("T1512b — the Panel's body on the canvas", () => {
  it("shows the wired widgets, and a drag on its slider writes the slider node in one undo step", async () => {
    const { runtime, ids } = await runtimeWith([
      add("fader", "slider", "fader1", { channel: "heat", value: 0.25 }),
      add("strobe", "toggle", "toggle1", { channel: "strobe" }),
      add("panel", "panel", "panel1", { title: "Furnace" }),
      wire("strobe", "panel"),
      wire("fader", "panel"),
    ]);
    const view = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    const body = view.container.querySelector(`[data-panel-body="${ids["$panel"]}"]`) as HTMLElement;
    expect(body).not.toBeNull();
    expect(within(body).getByText("Furnace")).not.toBeNull();
    expect(shownOrder(body)).toEqual([ids["$strobe"], ids["$fader"]]);
    // The body sits in the node's no-drag region: a press on the slider is not a node drag (§V20).
    expect(body.closest(".nodrag")).not.toBeNull();

    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;
    const track = within(body).getByRole("slider", { name: "heat" });
    stubTrack(track);
    await act(async () => {
      fireEvent.pointerDown(track, { clientX: 40, clientY: 5, pointerId: 1 });
      fireEvent.pointerMove(track, { clientX: 60, clientY: 5, pointerId: 1 });
      fireEvent.pointerMove(track, { clientX: 70, clientY: 5, pointerId: 1 });
      fireEvent.pointerUp(track, { clientX: 80, clientY: 5, pointerId: 1 });
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[ids["$fader"]!]!.parameters["value"]).toBeCloseTo(0.8, 6);
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);
    // …and the Panel's body shows the new value, although only the SLIDER node changed.
    expect(within(body).getByRole("slider", { name: "heat" }).getAttribute("aria-valuenow")).toBe("0.8");
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[ids["$fader"]!]!.parameters["value"]).toBe(0.25);
  });

  it("a fresh Panel says how to fill it, and a widget's add-to-panel wires it in", async () => {
    const { runtime, ids } = await runtimeWith([add("fader", "slider", "fader1"), add("panel", "panel", "panel1")]);
    const panel = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    expect(within(panel.container).getByText(PANEL_EMPTY_HINT)).not.toBeNull();
    // The Controls input is a visible, labelled socket.
    expect(panel.container.querySelector('[aria-label^="Input port Controls 1"]')).not.toBeNull();

    const widget = render(<OnCanvas runtime={runtime} nodeId={ids["$fader"]!} />);
    await act(async () => {
      fireEvent.click(within(widget.container).getByRole("button", { name: "Add to panel" }));
      await settle();
    });
    const edges = Object.values(runtime.bus.store.getGraph().edges);
    expect(edges.map((edge) => [edge.source.nodeId, edge.target.nodeId, edge.target.portId])).toEqual([[ids["$fader"], ids["$panel"], "controls"]]);
    expect(within(panel.container).queryByText(PANEL_EMPTY_HINT)).toBeNull();
    expect(shownOrder(panel.container)).toEqual([ids["$fader"]]);
    // On the Panel now, so the widget no longer offers it.
    expect(within(widget.container).queryByRole("button", { name: "Add to panel" })).toBeNull();
  });
});

describe("T1512b — the canvas body, the Controls tab and the phone agree", () => {
  const cases: ReadonlyArray<[string, GraphPatchOperation[]]> = [
    [
      "a Panel following its wiring",
      [
        add("a", "slider", "alpha"),
        add("b", "toggle", "bravo"),
        add("c", "xyPad", "charlie"),
        add("panel", "panel", "panel1", { remote: true }),
        wire("c", "panel"),
        wire("a", "panel"),
        wire("b", "panel"),
      ],
    ],
    [
      "a Panel laid out by its override text",
      [
        add("a", "slider", "alpha"),
        add("b", "toggle", "bravo"),
        add("c", "xyPad", "charlie"),
        add("panel", "panel", "panel1", { remote: true, layout: "# One\nbravo\n# Two\ncharlie alpha" }),
        wire("a", "panel"),
      ],
    ],
  ];

  for (const [name, operations] of cases) {
    it(`for ${name}`, async () => {
      const { runtime, ids } = await runtimeWith(operations);
      const canvas = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
      const onCanvas = shownOrder(canvas.container.querySelector("[data-panel-body]") as HTMLElement);
      const tab = render(<Tab runtime={runtime} />);
      const inTab = shownOrder(tab.container.querySelector("[data-controls-pane]") as HTMLElement);
      const onPhone = buildPhoneSnapshot(runtime.bus.store.getGraph(), 1).panels.flatMap((panel) =>
        panel.rows.flatMap((row) => (row.kind === "widgets" ? row.widgets.map((widget) => widget.handle) : [])),
      );
      expect(onCanvas).toHaveLength(3);
      expect(inTab).toEqual(onCanvas);
      expect(onPhone).toEqual(onCanvas);
    });
  }
});
