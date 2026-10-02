import { useState } from "react";
import { useStore } from "zustand";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { panelBoard, panelLayoutOverride, panelTitle } from "@nodes/definitions/controls.ts";
import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger, cx } from "@ui/index.ts";
import type { ControlWrite } from "./control-widget.tsx";
import { PanelBoardEditor, Pencil } from "./panel-board.tsx";
import { popoverEventStops } from "./popover-events.ts";
import boardStyles from "./panel-board.module.css";
import doorStyles from "./phone-door.module.css";

/**
 * T1518b — THE PENCIL ON THE PANEL NODE'S HEADER: arrange the board from the canvas, without
 * a trip to the Controls tab. It opens the SAME `PanelBoardEditor` the tab's pencil shows —
 * one component, so a gesture means the same thing in both places — in a popover beside the
 * node, writing through the same bus (one patch, one undo per gesture). The node's own body
 * stays the live board and follows every drop.
 *
 * Offered only for a Panel that HAS a board: one laid out by the legacy Layout text has
 * none to arrange (`panelBoard` is null for it).
 */

interface PanelEditProps {
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly panelId: NodeId;
  readonly write: ControlWrite;
}

/** The edit surface itself, mounted only while the popover is open: it reads the whole document. */
function PanelEditSurface({ bus, invocation, panelId, write }: PanelEditProps) {
  const graph = useStore(bus.store, (state) => state.graph);
  const panel = graph.nodes[panelId];
  const board = panel === undefined ? null : panelBoard(graph, panel);
  if (panel === undefined || board === null) return null;
  return (
    <>
      <PopoverHeader>{panelTitle(panel)}</PopoverHeader>
      <PanelBoardEditor
        graph={graph}
        panelId={panelId}
        board={board}
        write={write}
        bus={bus}
        invocation={invocation}
        apply={(operations, label) => {
          if (operations.length === 0) return;
          void bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label, operations }, invocation);
        }}
        registry={bus.registry}
      />
    </>
  );
}

export function PanelEdit({ bus, invocation, panelId, write }: PanelEditProps) {
  const [editing, setEditing] = useState(false);
  const hasBoard = useStore(bus.store, (state) => {
    const node = state.graph.nodes[panelId];
    return node !== undefined && panelLayoutOverride(node) === null;
  });
  if (!hasBoard) return null;
  return (
    <PopoverRoot open={editing} onOpenChange={setEditing}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cx(doorStyles.trigger, "nodrag", "nopan", editing && doorStyles.published)}
          aria-label="Edit board"
          aria-pressed={editing}
          title={editing ? "Done arranging" : "Arrange the board"}
          // §V20: a press on header chrome must not start a node drag or a canvas pan.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Pencil />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={boardStyles.popover}
        aria-label="Edit board"
        data-board-popover={panelId}
        // The editor's presses and node keys stay in the editor (`popover-events.ts`).
        {...popoverEventStops}
      >
        <PanelEditSurface bus={bus} invocation={invocation} panelId={panelId} write={write} />
      </PopoverContent>
    </PopoverRoot>
  );
}
