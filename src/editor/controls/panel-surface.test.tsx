// @vitest-environment jsdom
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { fixtureContext, installFlowStubs, nodeProps } from "@editor/graph-canvas/testing.tsx";
import { CanvasFixture } from "@editor/graph-canvas/canvas-fixture.tsx";
import { NodeView } from "@editor/nodes/node-view.tsx";
import { projectEdges } from "@editor/graph-canvas/derive.ts";
import { connectDropOperations } from "@editor/edges/connect-drop.ts";
import { incomingEdgesInOrder, parseHandleId } from "@domain/graph/edge-order.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { buildPhoneSnapshot } from "@devices/phone/phone-snapshot.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { useControlBodies } from "./control-bodies.tsx";
import type { ControlWrite } from "./control-widget.tsx";
import { ControlsPane } from "./controls-pane.tsx";
import { BOARD_CELL_PX, BOARD_GAP_PX } from "./panel-board.tsx";
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
    // The Controls input is a visible, labelled socket — ONE, unnumbered (T1518b).
    expect(panel.container.querySelector('[aria-label^="Input port Controls,"]')).not.toBeNull();

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

/**
 * T1516b — ONE BOARD, THREE PLACES: the Panel's canvas body, the Controls tab and the phone
 * snapshot place every control and label at the same rect on the same grid, because all
 * three read `panelBoard`. Read back from what each one actually draws or sends — the DOM's
 * grid placement and the snapshot's `board` — for a board with stored rects, a label, and a
 * member that flowed.
 */
describe("T1516b — the canvas body, the Controls tab and the phone draw the identical board", () => {
  /** Each item as `<node id or label text>@x,y,w,h`, in drawing order. */
  const drawn = (root: HTMLElement): string[] =>
    [...root.querySelectorAll("[data-board-item]")].map((item) => {
      const control = item.querySelector("[data-control-node]");
      return `${control?.getAttribute("data-control-node") ?? item.textContent ?? ""}@${item.getAttribute("data-rect") ?? ""}`;
    });

  it("for a board with stored rects, a label and a flowed member", async () => {
    const board = JSON.stringify({
      columns: 6,
      items: [
        { label: "Look", rect: { x: 0, y: 0, w: 3, h: 1 } },
        { member: "charlie", rect: { x: 3, y: 0, w: 3, h: 3 } },
        { member: "alpha", rect: { x: 0, y: 1, w: 3, h: 1 } },
      ],
    });
    const { runtime, ids } = await runtimeWith([
      add("a", "slider", "alpha"),
      add("b", "toggle", "bravo"),
      add("c", "xyPad", "charlie"),
      add("panel", "panel", "panel1", { remote: true, board }),
      wire("c", "panel"),
      wire("a", "panel"),
      wire("b", "panel"),
    ]);
    const canvas = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    const onCanvas = drawn(canvas.container.querySelector("[data-panel-body]") as HTMLElement);
    const tab = render(<Tab runtime={runtime} />);
    const inTab = drawn(tab.container.querySelector("[data-controls-pane]") as HTMLElement);
    const phone = buildPhoneSnapshot(runtime.bus.store.getGraph(), 1).panels[0]!.board!;
    const onPhone = phone.items.map(
      (item) => `${item.kind === "label" ? item.text : item.widget.handle}@${[item.rect.x, item.rect.y, item.rect.w, item.rect.h].join(",")}`,
    );
    expect(onCanvas).toEqual([`Look@0,0,3,1`, `${ids["$c"]}@3,0,3,3`, `${ids["$a"]}@0,1,3,1`, `${ids["$b"]}@0,2,2,1`]);
    expect(inTab).toEqual(onCanvas);
    expect(onPhone).toEqual(onCanvas);
    // The grid they share: six columns, three rows.
    expect(phone).toMatchObject({ columns: 6, rows: 3 });
    expect(canvas.container.querySelector("[data-panel-board='canvas']")?.getAttribute("data-columns")).toBe("6");
    expect(tab.container.querySelector("[data-panel-board='tab']")?.getAttribute("data-rows")).toBe("3");
  });
});

/** E81's board: a label, a 5-cell slider, a 2-cell toggle, a 3-cell button, a 3×3 pad — eight columns. */
const DESK_BOARD = JSON.stringify({
  columns: 8,
  items: [
    { label: "Picture", rect: { x: 0, y: 0, w: 5, h: 1 } },
    { member: "heat", rect: { x: 0, y: 1, w: 5, h: 1 } },
    { member: "invert", rect: { x: 0, y: 2, w: 2, h: 1 } },
    { member: "flash", rect: { x: 2, y: 2, w: 3, h: 1 } },
    { member: "warp", rect: { x: 5, y: 0, w: 3, h: 3 } },
  ],
});
const desk = () =>
  runtimeWith([
    add("heat", "slider", "heat", { channel: "heat", caption: "Heat", value: 1, min: 0, max: 2 }),
    add("invert", "toggle", "invert", { channel: "invert", caption: "Invert" }),
    add("flash", "button", "flash", { channel: "flash", caption: "Next hue" }),
    add("warp", "xyPad", "warp", { channel: "warp", caption: "Top-right pin", x: 0.82, y: 0.78 }),
    add("panel", "panel", "panel1", { title: "Phone Desk", board: DESK_BOARD }),
    wire("heat", "panel"),
    wire("invert", "panel"),
    wire("flash", "panel"),
    wire("warp", "panel"),
  ]);

/**
 * T1518b — ON THE CANVAS THE BOARD IS SMALL, AND SAYS WHAT FITS. The owner's screenshot of
 * E81: the 2-cell toggle read "I.. Off" and the pad "To… 0..". Here the same board, on the
 * same 178px node: each control shows its WHOLE caption and gives up its value where there
 * is no room for both — and the Controls tab, with 52px cells, still shows everything.
 */
describe("T1518b — a small board cell keeps its caption and drops its value", () => {
  const item = (root: HTMLElement, key: string) => root.querySelector(`[data-board-item="${key}"]`) as HTMLElement;

  it("the canvas toggle is its caption and its switch — no On/Off; the pad its caption alone", async () => {
    const { runtime, ids } = await desk();
    const view = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    const body = view.container.querySelector("[data-panel-body]") as HTMLElement;

    const toggle = item(body, "member:invert");
    expect(toggle.getAttribute("data-caption-fit")).toBe("whole");
    const press = within(toggle).getByRole("switch");
    // The words in the cell are the caption, whole, and nothing else.
    expect(press.textContent).toBe("Invert");
    // The switch is still there (it is the state now), and the toggle still toggles.
    expect(press.querySelector("[aria-hidden='true']")).not.toBeNull();
    await act(async () => {
      fireEvent.click(press);
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[ids["$invert"]!]!.parameters["on"]).toBe(true);
    expect(within(item(body, "member:invert")).getByRole("switch").getAttribute("aria-checked")).toBe("true");

    const pad = item(body, "member:warp");
    expect(pad.getAttribute("data-caption-fit")).toBe("whole");
    expect(pad.textContent).toBe("Top-right pin");
    // A control with room for both keeps both: the 5-cell slider and the 3-cell button.
    expect(item(body, "member:heat").textContent).toBe("Heat1.00");
    expect(item(body, "member:flash").textContent).toBe("Next hue×0");
    // Type is sized per item, never under the readable minimum.
    for (const each of body.querySelectorAll<HTMLElement>("[data-board-item]")) {
      expect(Number.parseFloat(each.style.fontSize)).toBeGreaterThanOrEqual(8);
    }
  });

  it("the Controls tab's bigger cells show the same toggle with On/Off, and the pad with its numbers", async () => {
    const { runtime } = await desk();
    const tab = render(<Tab runtime={runtime} />);
    const pane = tab.container.querySelector("[data-controls-pane]") as HTMLElement;
    expect(within(item(pane, "member:invert")).getByRole("switch").textContent).toBe("InvertOff");
    expect(item(pane, "member:warp").textContent).toBe("Top-right pin0.82, 0.78");
  });
});

/**
 * T1518b — THE PANEL'S CONTROLS INPUT IS ONE SOCKET THAT TAKES MANY WIRES. It drew a
 * labelled socket per wire plus a spare ("Controls 1 … Controls 5"), a column taller than the
 * board. Now: one handle, every wire drawn to it, a count on the row — and the DOCUMENT is
 * what it was: the same edges on `controls`, the same `order` (§V131), a new wire appended.
 */
describe("T1518b — one Controls socket, many wires", () => {
  const handlesOf = (root: HTMLElement): string[] =>
    [...root.querySelectorAll<HTMLElement>(".react-flow__handle.target")].map((handle) => handle.dataset["handleid"] ?? "");

  it("draws one handle for four wires, and every wire is projected onto it", async () => {
    const { runtime, ids } = await desk();
    const view = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    const handles = handlesOf(view.container);
    expect(handles).toEqual(["controls"]);
    expect(view.container.querySelector("[data-wired]")?.textContent).toBe("4 wired");

    // The wires the canvas draws: all four end on the handle that exists. A wire stamped
    // `controls#2` would aim at a socket nobody drew and React Flow would draw nothing.
    const graph = runtime.bus.store.getGraph();
    const projected = projectEdges(graph.edges, graph.nodes, runtime.bus.registry).filter((edge) => edge.target === ids["$panel"]);
    expect(projected.map((edge) => edge.targetHandle)).toEqual(["controls", "controls", "controls", "controls"]);
    // …and the stored order is untouched: the wiring order, dense.
    expect(incomingEdgesInOrder(graph, ids["$panel"]!, "controls").map((edge) => [edge.source.nodeId, edge.order])).toEqual([
      [ids["$heat"], 0],
      [ids["$invert"], 1],
      [ids["$flash"], 2],
      [ids["$warp"], 3],
    ]);
  });

  it("a wire dropped on the one socket appends: the next order, the others untouched", async () => {
    const { runtime, ids } = await desk();
    const added = await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), label: "add", operations: [add("extra", "slider", "extra", { channel: "extra", caption: "Extra" })] },
      runtime.invocation,
    );
    const extra = (added.output.createdIds as Record<string, NodeId>)["$extra"]!;
    const view = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    const [handle] = handlesOf(view.container);

    // What the canvas's `onConnect` does with the handle the pointer was released on.
    const { portId, slot } = parseHandleId(handle!);
    expect(slot).toBeUndefined();
    const before = incomingEdgesInOrder(runtime.bus.store.getGraph(), ids["$panel"]!, "controls").map((edge) => edge.id);
    const drop = connectDropOperations({
      graph: runtime.bus.store.getGraph(),
      registry: runtime.bus.registry,
      source: { nodeId: extra, portId: "out" },
      target: { nodeId: ids["$panel"]!, portId },
    });
    expect(drop.kind).toBe("connect");
    if (drop.kind !== "connect") return;
    // An append, not a replace: nothing is disconnected to make room.
    expect(drop.operations.map((operation) => operation.op)).toEqual(["connect"]);
    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        { baseRevision: runtime.bus.store.getRevision(), label: drop.label, operations: drop.operations },
        runtime.invocation,
      );
      await settle();
    });
    const after = incomingEdgesInOrder(runtime.bus.store.getGraph(), ids["$panel"]!, "controls");
    expect(after.map((edge) => edge.order)).toEqual([0, 1, 2, 3, 4]);
    expect(after.slice(0, 4).map((edge) => edge.id)).toEqual(before);
    expect(after[4]!.source.nodeId).toBe(extra);
    // Still one socket; the count and the board follow.
    expect(handlesOf(view.container)).toEqual(["controls"]);
    expect(view.container.querySelector("[data-wired]")?.textContent).toBe("5 wired");
    expect(shownOrder(view.container.querySelector("[data-panel-body]") as HTMLElement)).toContain(extra);
  });

  it("an unwired Panel shows the socket with no count", async () => {
    const { runtime, ids } = await runtimeWith([add("panel", "panel", "panel1")]);
    const view = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    expect(handlesOf(view.container)).toEqual(["controls"]);
    expect(view.container.querySelector("[data-wired]")).toBeNull();
  });
});

/**
 * T1518b — THE PENCIL IS ON THE PANEL NODE TOO. Arranging the board meant a trip to the
 * Controls tab; the pencil on the node's header opens the SAME editor (`PanelBoardEditor`)
 * beside the node. Same gestures, same bus: a drag there is one patch and one undo, and the
 * node's own body — the board, live — follows.
 */
describe("T1518b — the canvas Panel's pencil opens the board's edit surface", () => {
  const PITCH = BOARD_CELL_PX + BOARD_GAP_PX;
  const undoDepth = (runtime: AppRuntime) => runtime.bus.store.getHistory(runtime.invocation.actor).undo.length;

  it("opens edit mode from the node header, and a drag there is one undo", async () => {
    const { runtime, ids } = await desk();
    const view = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    const body = view.container.querySelector("[data-panel-body]") as HTMLElement;
    const rectOnNode = () => body.querySelector('[data-board-item="member:invert"]')?.getAttribute("data-rect");
    // Closed: the node plays, nothing to arrange.
    expect(document.querySelector("[data-board-editing]")).toBeNull();

    const pencil = within(view.container).getByRole("button", { name: "Edit board" });
    // Header chrome: a press on it is not a node drag (§V20).
    expect(pencil.classList.contains("nodrag")).toBe(true);
    await act(async () => {
      fireEvent.click(pencil);
      await settle();
    });
    const editor = document.querySelector("[data-board-popover] [data-board-editing]") as HTMLElement;
    expect(editor).not.toBeNull();
    expect(pencil.getAttribute("aria-pressed")).toBe("true");
    // The tab's editor, not a lookalike: its toolbar and its inert, movable controls.
    expect(within(editor).getByRole("spinbutton", { name: "Columns" })).not.toBeNull();
    expect(within(editor).getByRole("slider", { name: "Heat", hidden: true }).closest("[inert]")).not.toBeNull();

    const mover = within(editor).getByRole("button", { name: "Move Invert" });
    const before = undoDepth(runtime);
    // One cell down, into the free row under the board — several moves, one drop.
    await act(async () => {
      fireEvent.pointerDown(mover, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(mover, { clientX: 100 + PITCH, clientY: 100 + PITCH / 2, pointerId: 1 });
      fireEvent.pointerMove(mover, { clientX: 100, clientY: 100 + PITCH + 3, pointerId: 1 });
      fireEvent.pointerUp(mover, { clientX: 100, clientY: 100 + PITCH + 3, pointerId: 1 });
      await settle();
    });
    expect(undoDepth(runtime)).toBe(before + 1);
    // The node's own board followed the drag made in the popover.
    expect(rectOnNode()).toBe("0,3,2,1");
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
      await settle();
    });
    expect(rectOnNode()).toBe("0,2,2,1");
    expect(screen.getByRole("button", { name: "Move Invert" })).not.toBeNull();
  });

  it("a press or an arrow key in the editor stays in the editor; undo's keys still leave it", async () => {
    // The popover is portalled out of the node in the DOM but not in React, so its events
    // bubble to the node and the graph pane. Measured in the browser before this guard: a
    // press on "Remove from panel" reached the pane's own onPointerDown, which takes focus,
    // which Radix reads as focus leaving the popover — it closed before the click landed.
    // An arrow meant for a board control would likewise nudge the node (React Flow).
    const { runtime, ids } = await desk();
    const reached: string[] = [];
    const view = render(
      <div
        onPointerDown={() => reached.push("pointerdown")}
        onDoubleClick={() => reached.push("doubleclick")}
        onKeyDown={(event) => reached.push(`key:${event.key}`)}
      >
        <OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />
      </div>,
    );
    await act(async () => {
      fireEvent.click(within(view.container).getByRole("button", { name: "Edit board" }));
      await settle();
    });
    const editor = document.querySelector("[data-board-popover] [data-board-editing]") as HTMLElement;
    const mover = within(editor).getByRole("button", { name: "Move Invert" });
    await act(async () => {
      fireEvent.pointerDown(within(editor).getByRole("button", { name: "+ Label" }), { pointerId: 1 });
      fireEvent.doubleClick(mover);
      fireEvent.keyDown(mover, { key: "ArrowDown" });
      await settle();
    });
    expect(reached).toEqual([]);
    // The arrow did its own job: the control moved a cell down.
    expect(view.container.querySelector('[data-panel-body] [data-board-item="member:invert"]')?.getAttribute("data-rect")).toBe("0,3,2,1");
    // The legitimate case the guard must not swallow: any other key still bubbles — the
    // keymap listens on the window, and undo has to work in the middle of arranging.
    fireEvent.keyDown(mover, { key: "z", metaKey: true });
    expect(reached).toEqual(["key:z"]);
  });

  it("a Panel laid out by its legacy Layout text has no board, and no pencil", async () => {
    const { runtime, ids } = await runtimeWith([
      add("a", "slider", "alpha"),
      add("panel", "panel", "panel1", { layout: "# One\nalpha" }),
    ]);
    const view = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    expect(within(view.container).queryByRole("button", { name: "Edit board" })).toBeNull();
  });
});
