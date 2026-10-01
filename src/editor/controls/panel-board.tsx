import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import {
  BOARD_MAX_COLUMNS,
  controlChannel,
  type BoardRect,
  type PanelBoard,
  type PanelBoardItem,
  type StoredBoard,
} from "@nodes/definitions/controls.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import {
  boardOperations,
  boardRectFits,
  boardWithColumns,
  boardWithLabel,
  boardWithLabelText,
  boardWithRect,
  boardWithout,
  removeFromPanelOperations,
} from "./panel-board-edit.ts";
import styles from "./panel-board.module.css";

/**
 * T1516b — A PANEL BOARD, DRAWN: every control at the rect `panelBoard` gives it, and free
 * text labels between them. One component for both places a board shows on the desk:
 *
 * - the Controls tab (`variant="tab"`) draws it at a FIXED, compact cell size — the board
 *   does not stretch to the pane; a big board scrolls — and offers EDIT mode;
 * - the Panel node's canvas body (`variant="canvas"`) scales the same grid to the node's
 *   width, square cells, play only.
 *
 * PLAY (the default) only operates the controls: no chips, no arrows, no handles. EDIT
 * (the pencil in the tab header) turns the controls inert and makes the board the thing
 * being edited — drag a control to move it by whole cells, drag its corner to resize,
 * select it to see what it drives (× unlinks) or take it off the Panel, add and edit text
 * labels. A drag shows its ghost live and writes ONE patch on drop (`panel-board-edit.ts`);
 * a drop the no-overlap rule refuses writes nothing.
 */

/** The tab's cell, in px: compact (owner: "hard to overview"), still a thumb's width. */
export const BOARD_CELL_PX = 52;
/** The tab's gap between cells, in px. A move steps by cell + gap. */
export const BOARD_GAP_PX = 4;
const PITCH = BOARD_CELL_PX + BOARD_GAP_PX;
/** Empty rows an edit-mode board offers below its last item, so a control can move down. */
const EDIT_SPARE_ROWS = 2;

const placement = (rect: BoardRect): CSSProperties => ({
  gridColumn: `${String(rect.x + 1)} / span ${String(rect.w)}`,
  gridRow: `${String(rect.y + 1)} / span ${String(rect.h)}`,
});

const rectAttr = (rect: BoardRect): string => `${String(rect.x)},${String(rect.y)},${String(rect.w)},${String(rect.h)}`;

/** What a board item is called in an accessible name. */
function boardItemName(item: PanelBoardItem): string {
  if (item.kind === "label") return item.text === "" ? "label" : item.text;
  const caption = item.node.parameters["caption"];
  return typeof caption === "string" && caption !== "" ? caption : controlChannel(item.node.parameters);
}

function Item({ item, write }: { readonly item: PanelBoardItem; readonly write: ControlWrite }) {
  if (item.kind === "label") return <div className={styles.label}>{item.text}</div>;
  return <ControlWidget nodeId={item.node.id} type={item.node.type} parameters={item.node.parameters as Record<string, unknown>} write={write} size="board" />;
}

export interface PanelBoardGridProps {
  readonly board: PanelBoard;
  readonly write: ControlWrite;
  readonly variant: "canvas" | "tab";
}

/** PLAY mode: the board, operable, nothing else. */
export function PanelBoardGrid({ board, write, variant }: PanelBoardGridProps) {
  const grid: CSSProperties =
    variant === "canvas"
      ? {
          gridTemplateColumns: `repeat(${String(board.columns)}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${String(board.rows)}, minmax(0, 1fr))`,
          aspectRatio: `${String(board.columns)} / ${String(board.rows)}`,
        }
      : {
          gridTemplateColumns: `repeat(${String(board.columns)}, ${String(BOARD_CELL_PX)}px)`,
          gridAutoRows: `${String(BOARD_CELL_PX)}px`,
          gap: `${String(BOARD_GAP_PX)}px`,
        };
  return (
    <div className={variant === "canvas" ? styles.canvas : styles.tab} style={grid} data-panel-board={variant} data-columns={board.columns} data-rows={board.rows}>
      {board.items.map((item) => (
        <div key={item.key} className={styles.item} style={placement(item.rect)} data-board-item={item.key} data-rect={rectAttr(item.rect)}>
          <Item item={item} write={write} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ edit mode */

export interface PanelBoardEditorProps {
  readonly graph: Pick<GraphDocument, "nodes" | "edges">;
  readonly panelId: NodeId;
  readonly board: PanelBoard;
  readonly write: ControlWrite;
  /** Sends ONE patch through the bus. */
  readonly apply: (operations: GraphPatchOperation[], label: string) => void;
  /** What a widget drives, as chips with × (the Controls tab's own, shared with T1513b). */
  readonly renderTargets: (widget: GraphNode) => ReactNode;
}

interface Drag {
  readonly key: string;
  readonly mode: "move" | "resize";
  readonly start: { readonly x: number; readonly y: number };
  readonly from: BoardRect;
  readonly moved: boolean;
}

/** The rect a drag of (dx, dy) whole cells asks for. */
const dragged = (drag: Drag, dx: number, dy: number): BoardRect =>
  drag.mode === "move"
    ? { ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy }
    : { ...drag.from, w: drag.from.w + dx, h: drag.from.h + dy };

const capture = (event: ReactPointerEvent<HTMLElement>): void => {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // jsdom and a few browsers refuse capture for synthetic pointers; the drag still works.
  }
};

export function PanelBoardEditor({ graph, panelId, board, write, apply, renderTargets }: PanelBoardEditorProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ readonly key: string; readonly rect: BoardRect; readonly fits: boolean } | null>(null);
  const drag = useRef<Drag | null>(null);
  const commit = (stored: StoredBoard | null, label: string): void => {
    if (stored !== null) apply(boardOperations(panelId, stored), label);
  };

  const begin = (item: PanelBoardItem, mode: Drag["mode"]) => (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    capture(event);
    drag.current = { key: item.key, mode, start: { x: event.clientX, y: event.clientY }, from: item.rect, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current === null) return;
    const dx = Math.round((event.clientX - current.start.x) / PITCH);
    const dy = Math.round((event.clientY - current.start.y) / PITCH);
    if (dx === 0 && dy === 0 && !current.moved) return;
    drag.current = { ...current, moved: true };
    const rect = dragged(current, dx, dy);
    setGhost({ key: current.key, rect, fits: boardRectFits(board, current.key, rect) });
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    drag.current = null;
    setGhost(null);
    if (current === null) return;
    if (!current.moved) {
      setSelected(current.key);
      return;
    }
    const rect = dragged(current, Math.round((event.clientX - current.start.x) / PITCH), Math.round((event.clientY - current.start.y) / PITCH));
    commit(boardWithRect(board, current.key, rect), current.mode === "move" ? "Move on panel" : "Resize on panel");
  };
  /** Arrow keys move a selected control a cell; with Shift they resize it. Same rule, same write. */
  const key = (item: PanelBoardItem) => (event: ReactKeyboardEvent<HTMLElement>) => {
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const [dx, dy] = step;
    const rect = event.shiftKey ? { ...item.rect, w: item.rect.w + dx, h: item.rect.h + dy } : { ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy };
    commit(boardWithRect(board, item.key, rect), event.shiftKey ? "Resize on panel" : "Move on panel");
  };

  const rows = board.rows + EDIT_SPARE_ROWS;
  const slots: BoardRect[] = [];
  for (let y = 0; y < rows; y += 1) for (let x = 0; x < board.columns; x += 1) slots.push({ x, y, w: 1, h: 1 });
  const chosen = board.items.find((item) => item.key === selected);

  return (
    <div className={styles.editor} data-board-editing>
      <div className={styles.toolbar}>
        <label className={styles.field}>
          Columns
          <input
            type="number"
            min={1}
            max={BOARD_MAX_COLUMNS}
            value={board.columns}
            className={styles.number}
            aria-label="Columns"
            onChange={(event) => commit(boardWithColumns(board, Number(event.target.value)), "Panel columns")}
          />
        </label>
        <button
          type="button"
          className={styles.tool}
          onClick={() => {
            const added = boardWithLabel(board, "Label");
            commit(added.stored, "Add label");
            setSelected(added.key);
          }}
        >
          + Label
        </button>
      </div>
      <div className={styles.workspace}>
        <div
          className={styles.tab}
          style={{
            gridTemplateColumns: `repeat(${String(board.columns)}, ${String(BOARD_CELL_PX)}px)`,
            gridTemplateRows: `repeat(${String(rows)}, ${String(BOARD_CELL_PX)}px)`,
            gap: `${String(BOARD_GAP_PX)}px`,
          }}
          data-panel-board="tab"
          data-columns={board.columns}
          data-rows={board.rows}
        >
          {slots.map((slot) => (
            <div key={`slot-${rectAttr(slot)}`} className={styles.slot} style={placement(slot)} aria-hidden="true" />
          ))}
          {board.items.map((item) => {
            const name = boardItemName(item);
            return (
              <div
                key={item.key}
                className={`${styles.item} ${styles.editable} ${selected === item.key ? styles.selected : ""}`}
                style={placement(item.rect)}
                data-board-item={item.key}
                data-rect={rectAttr(item.rect)}
              >
                {/* Inert: in edit mode a control is a thing to place, not to play. */}
                <div className={styles.inert} inert>
                  <Item item={item} write={write} />
                </div>
                <div
                  className={styles.mover}
                  role="button"
                  tabIndex={0}
                  aria-label={`Move ${name}`}
                  aria-pressed={selected === item.key}
                  title="Drag to move · arrows move · Shift+arrows resize"
                  onPointerDown={begin(item, "move")}
                  onPointerMove={move}
                  onPointerUp={end}
                  onKeyDown={key(item)}
                />
                <div
                  className={styles.handle}
                  role="button"
                  aria-label={`Resize ${name}`}
                  title="Drag to resize"
                  onPointerDown={begin(item, "resize")}
                  onPointerMove={move}
                  onPointerUp={end}
                />
              </div>
            );
          })}
          {ghost === null ? null : (
            <div className={`${styles.ghost} ${ghost.fits ? "" : styles.blocked}`} style={placement(ghost.rect)} data-board-ghost={ghost.fits ? "fits" : "blocked"} aria-hidden="true" />
          )}
        </div>
        <aside className={styles.inspect} data-board-inspect aria-label="Board item">
          {chosen === undefined ? (
            // The how-to lives on each control's tooltip (§V90); here, only the state.
            <p className={styles.hint}>Nothing selected</p>
          ) : chosen.kind === "widget" ? (
            <>
              <h3 className={styles.inspectTitle}>{boardItemName(chosen)}</h3>
              <p className={styles.inspectMeta}>Drives</p>
              {renderTargets(chosen.node)}
              <button
                type="button"
                className={styles.tool}
                onClick={() => {
                  apply(removeFromPanelOperations(graph, panelId, board, chosen.key), "Remove from panel");
                  setSelected(null);
                }}
              >
                Remove from panel
              </button>
            </>
          ) : (
            <LabelInspector
              key={chosen.key}
              text={chosen.text}
              onText={(text) => commit(boardWithLabelText(board, chosen.key, text), "Edit label")}
              onRemove={() => {
                commit(boardWithout(board, chosen.key), "Remove label");
                setSelected(null);
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

/** A label's text, written on Enter or when the field is left — one patch, not one per key. */
function LabelInspector({ text, onText, onRemove }: { readonly text: string; readonly onText: (text: string) => void; readonly onRemove: () => void }) {
  const [draft, setDraft] = useState(text);
  return (
    <>
      <label className={styles.field}>
        Text
        <input
          type="text"
          value={draft}
          className={styles.text}
          aria-label="Label text"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onText(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onText(draft);
          }}
        />
      </label>
      <button type="button" className={styles.tool} onClick={onRemove}>
        Remove label
      </button>
    </>
  );
}
