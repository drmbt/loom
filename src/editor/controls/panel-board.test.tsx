// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { ControlsPane } from "./controls-pane.tsx";
import { BOARD_CELL_PX, BOARD_GAP_PX } from "./panel-board.tsx";

/**
 * T1516b — THE CONTROLS TAB SPLITS PLAYING A PANEL FROM ARRANGING IT, as the owner meets it:
 * "we're trying to do managing of controls and usage in a single spot and don't do either
 * well". PLAY (the default) operates the controls and shows nothing else. The pencil is EDIT:
 * the controls stop operating and become things to place — dragged by whole cells, resized
 * from the corner, refused when they would land on each other — and each gesture is one undo.
 *
 * Mounted on the real app runtime and bus; a drag is real pointer events on the real DOM,
 * with jsdom's zero-size layout standing in only where the slider reads its own track box.
 */
afterEach(cleanup);

const PITCH = BOARD_CELL_PX + BOARD_GAP_PX;
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
const wire = (from: string): GraphPatchOperation =>
  ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: "$panel", portId: "controls" } }) as GraphPatchOperation;

/** heat 4×1 at (0,0), invert 2×1 at (4,0), warp 3×3 at (0,1); blur1.size reads heat. */
async function desk(): Promise<{ runtime: AppRuntime; ids: Record<string, NodeId> }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        add("heat", "slider", "heat", { channel: "heat", caption: "Heat", value: 0.25 }),
        add("invert", "toggle", "invert", { channel: "invert", caption: "Invert" }),
        add("warp", "xyPad", "warp", { channel: "warp", caption: "Warp" }),
        add("panel", "panel", "panel1", {
          title: "Desk",
          board: serializePanelBoard({
            columns: 8,
            items: [
              { member: "heat", rect: { x: 0, y: 0, w: 4, h: 1 } },
              { member: "invert", rect: { x: 4, y: 0, w: 2, h: 1 } },
              { member: "warp", rect: { x: 0, y: 1, w: 3, h: 3 } },
            ],
          }),
        }),
        add("blur", "blur", "blur1", {
          size: { mode: "expression", bindings: { static: { kind: "static", value: 7 }, expression: { kind: "expression", source: "op('heat').chan.heat * 10" } } },
        }),
        wire("heat"),
        wire("invert"),
        wire("warp"),
      ],
    },
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return { runtime, ids: result.output.createdIds as Record<string, NodeId> };
}

function Pane({ runtime }: { runtime: AppRuntime }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} />;
}

const undoDepth = (runtime: AppRuntime) => runtime.bus.store.getHistory(runtime.invocation.actor).undo.length;
const rectOf = (key: string) => document.querySelector(`[data-controls-pane] [data-board-item="${key}"]`)?.getAttribute("data-rect");

async function edit(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Edit board" }));
    await settle();
  });
}

/** A pointer drag from `element` by whole cells, as a person's hand would do it. */
async function dragBy(element: HTMLElement, cells: { x: number; y: number }, drop = true): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(element, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(element, { clientX: 100 + (cells.x * PITCH) / 2, clientY: 100 + (cells.y * PITCH) / 2, pointerId: 1 });
    fireEvent.pointerMove(element, { clientX: 100 + cells.x * PITCH + 3, clientY: 100 + cells.y * PITCH - 3, pointerId: 1 });
    if (drop) fireEvent.pointerUp(element, { clientX: 100 + cells.x * PITCH + 3, clientY: 100 + cells.y * PITCH - 3, pointerId: 1 });
    await settle();
  });
}

describe("T1516b — PLAY mode only plays", () => {
  it("draws the board at fixed cells, operates a slider as one undo step, and shows no edit chrome", async () => {
    const { runtime, ids } = await desk();
    render(<Pane runtime={runtime} />);
    const board = document.querySelector("[data-controls-pane] [data-panel-board='tab']") as HTMLElement;
    // Fixed compact cells, not stretched to the pane.
    expect(board.style.gridTemplateColumns).toBe(`repeat(8, ${String(BOARD_CELL_PX)}px)`);
    expect(rectOf("member:heat")).toBe("0,0,4,1");
    // Nothing to arrange or unlink while playing.
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Resize / })).toBeNull();
    expect(document.querySelector("[data-target]")).toBeNull();

    const track = screen.getByRole("slider", { name: "Heat" });
    track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    track.setPointerCapture = () => undefined;
    track.releasePointerCapture = () => undefined;
    track.hasPointerCapture = () => true;
    const before = undoDepth(runtime);
    await act(async () => {
      fireEvent.pointerDown(track, { clientX: 30, clientY: 5, pointerId: 1 });
      fireEvent.pointerMove(track, { clientX: 50, clientY: 5, pointerId: 1 });
      fireEvent.pointerUp(track, { clientX: 60, clientY: 5, pointerId: 1 });
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[ids["$heat"]!]!.parameters["value"]).toBeCloseTo(0.6, 6);
    expect(undoDepth(runtime)).toBe(before + 1);
    // Caption and value read inside the one-row bar.
    expect(track.textContent).toBe("Heat0.60");
  });
});

describe("T1516b — EDIT mode arranges, through the bus", () => {
  it("the pencil makes the controls inert: a press on a control in edit mode writes nothing", async () => {
    const { runtime, ids } = await desk();
    render(<Pane runtime={runtime} />);
    await edit();
    expect(screen.getByRole("button", { name: "Edit board" }).getAttribute("aria-pressed")).toBe("true");
    const slider = document.querySelector(`[data-controls-pane] [data-control-node="${ids["$heat"]}"]`) as HTMLElement;
    expect(slider.closest("[inert]")).not.toBeNull();
    // The press lands on the mover laid over the control, which selects — it does not play.
    const before = undoDepth(runtime);
    await dragBy(screen.getByRole("button", { name: "Move Heat" }), { x: 0, y: 0 });
    expect(undoDepth(runtime)).toBe(before);
    expect(runtime.bus.store.getGraph().nodes[ids["$heat"]!]!.parameters["value"]).toBe(0.25);
  });

  it("dragging a control moves it by whole cells, one undo step, and the canvas and phone follow", async () => {
    const { runtime } = await desk();
    render(<Pane runtime={runtime} />);
    await edit();
    const before = undoDepth(runtime);
    await dragBy(screen.getByRole("button", { name: "Move Invert" }), { x: 2, y: 1 });
    expect(rectOf("member:invert")).toBe("6,1,2,1");
    expect(undoDepth(runtime)).toBe(before + 1);
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
      await settle();
    });
    expect(rectOf("member:invert")).toBe("4,0,2,1");
  });

  it("T1518b — the board area scrolls under a held control: scrolled a row, it lands a row lower", async () => {
    // In a short dock the spare rows are below the fold of the board area, which scrolls by
    // itself (the toolbar stays). A drag is measured in board space, so wheeling the board
    // while holding a control carries it down exactly as moving the pointer would.
    const { runtime } = await desk();
    render(<Pane runtime={runtime} />);
    await edit();
    const workspace = document.querySelector("[data-controls-pane] [data-board-workspace]") as HTMLElement;
    const mover = screen.getByRole("button", { name: "Move Invert" });
    const before = undoDepth(runtime);
    await act(async () => {
      fireEvent.pointerDown(mover, { clientX: 100, clientY: 100, pointerId: 1 });
      workspace.scrollTop = PITCH;
      // The pointer has not moved on screen; the board moved under it.
      fireEvent.pointerMove(mover, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(mover, { clientX: 100, clientY: 100, pointerId: 1 });
      await settle();
    });
    expect(workspace.scrollTop).toBe(PITCH);
    expect(rectOf("member:invert")).toBe("4,1,2,1");
    expect(undoDepth(runtime)).toBe(before + 1);
  });

  it("dragging the corner resizes, one undo step", async () => {
    const { runtime } = await desk();
    render(<Pane runtime={runtime} />);
    await edit();
    const before = undoDepth(runtime);
    await dragBy(screen.getByRole("button", { name: "Resize Warp" }), { x: 1, y: -1 });
    expect(rectOf("member:warp")).toBe("0,1,4,2");
    expect(undoDepth(runtime)).toBe(before + 1);
  });

  it("a drag onto another control shows a refused ghost and its drop writes nothing", async () => {
    const { runtime } = await desk();
    render(<Pane runtime={runtime} />);
    await edit();
    const mover = screen.getByRole("button", { name: "Move Invert" });
    await dragBy(mover, { x: -2, y: 0 }, false);
    expect(document.querySelector("[data-board-ghost]")?.getAttribute("data-board-ghost")).toBe("blocked");
    const before = undoDepth(runtime);
    await act(async () => {
      fireEvent.pointerUp(mover, { clientX: 100 - 2 * PITCH, clientY: 100, pointerId: 1 });
      await settle();
    });
    expect(undoDepth(runtime)).toBe(before);
    expect(rectOf("member:invert")).toBe("4,0,2,1");
    expect(document.querySelector("[data-board-ghost]")).toBeNull();
    // Into free cells the ghost says it fits.
    await dragBy(mover, { x: 2, y: 2 }, false);
    expect(document.querySelector("[data-board-ghost]")?.getAttribute("data-board-ghost")).toBe("fits");
  });

  it("adds a label, renames it, removes it — each one patch", async () => {
    const { runtime } = await desk();
    render(<Pane runtime={runtime} />);
    await edit();
    const before = undoDepth(runtime);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ Label" }));
      await settle();
    });
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(rectOf("label:0")).toBe("6,0,2,1");
    const text = screen.getByRole("textbox", { name: "Label text" });
    await act(async () => {
      fireEvent.change(text, { target: { value: "Look" } });
      fireEvent.keyDown(text, { key: "Enter" });
      await settle();
    });
    expect(undoDepth(runtime)).toBe(before + 2);
    expect(document.querySelector("[data-controls-pane] [data-board-item='label:0']")?.textContent).toBe("Look");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove label" }));
      await settle();
    });
    expect(document.querySelector("[data-controls-pane] [data-board-item='label:0']")).toBeNull();
  });

  it("a selected control lists what it drives with × unlink, and Remove from panel disconnects it", async () => {
    const { runtime, ids } = await desk();
    render(<Pane runtime={runtime} />);
    await edit();
    await dragBy(screen.getByRole("button", { name: "Move Heat" }), { x: 0, y: 0 });
    const inspect = document.querySelector("[data-board-inspect]") as HTMLElement;
    expect(within(inspect).getByText("blur1.size")).not.toBeNull();
    const before = undoDepth(runtime);
    await act(async () => {
      fireEvent.click(within(inspect).getByRole("button", { name: "Remove from panel" }));
      await settle();
    });
    expect(undoDepth(runtime)).toBe(before + 1);
    const edges = Object.values(runtime.bus.store.getGraph().edges);
    expect(edges.some((edge) => edge.source.nodeId === ids["$heat"])).toBe(false);
    expect(rectOf("member:heat")).toBeUndefined();
  });
});
