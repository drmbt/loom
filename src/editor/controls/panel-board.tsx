import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import {
  BOARD_MAX_COLUMNS,
  type BoardRect,
  type PanelBoard,
  type PanelBoardItem,
  type StoredBoard,
} from "@nodes/definitions/controls.ts";
import { boardFit, boardValueEm, controlCaption, type BoardFit } from "./board-fit.ts";
import { ControlTargets } from "./control-targets.tsx";
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
 *   width, square cells, play only — its header's pencil opens the SAME editor in a
 *   popover (T1518b, `panel-edit.tsx`).
 *
 * PLAY (the default) only operates the controls: no chips, no arrows, no handles. EDIT
 * (the pencil in the tab header, or on the Panel node's) turns the controls inert and makes the board the thing
 * being edited — drag a control to move it by whole cells, drag its corner to resize,
 * select it to see what it drives (× unlinks) or take it off the Panel, add and edit text
 * labels. A drag shows its ghost live and writes ONE patch on drop (`panel-board-edit.ts`);
 * a drop the no-overlap rule refuses writes nothing.
 *
 * T1518b — every item is drawn at the type size its rect has room for, and says only what
 * fits (`board-fit.ts`): the value goes before the caption is cut, never both. The same
 * rule at the tab's fixed cells and at the canvas body's scaled ones.
 */

/** The pencil: edit mode's switch — in the Controls tab's header and on the Panel node's (T1518b). */
export function Pencil() {
  return (
    <svg className={styles.pencil} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 10l.6-2.4L8.2 2l1.8 1.8-5.6 5.6L2 10zM7.2 3l1.8 1.8" />
    </svg>
  );
}

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

/** `.canvas .item` — `padding: 1px`, both sides. */
const CANVAS_ITEM_PADDING_PX = 2;

/** How a board's cells are sized: the tab's fixed cells with a gap, or the canvas body's scaled ones. */
interface CellMetrics {
  readonly cellPx: number;
  /** The content width, in px, of an item `w` cells wide. */
  readonly widthOf: (w: number) => number;
}

const TAB_CELLS: CellMetrics = { cellPx: BOARD_CELL_PX, widthOf: (w) => w * BOARD_CELL_PX + (w - 1) * BOARD_GAP_PX };

/** The canvas body: `columns` square cells across `widthPx`, no gap, a hairline of padding. */
const canvasCells = (widthPx: number, columns: number): CellMetrics => {
  const cellPx = widthPx / columns;
  return { cellPx, widthOf: (w) => w * cellPx - CANVAS_ITEM_PADDING_PX };
};

/** T1518b — what this item has room to say at this cell size. */
function fitOf(item: PanelBoardItem, cells: CellMetrics): BoardFit {
  const widthPx = cells.widthOf(item.rect.w);
  if (item.kind === "label") return boardFit({ kind: "label", caption: item.text, valueEm: 0, widthPx, cellPx: cells.cellPx });
  const parameters = item.node.parameters as Record<string, unknown>;
  return boardFit({ kind: item.node.type, caption: controlCaption(parameters), valueEm: boardValueEm(item.node.type, parameters), widthPx, cellPx: cells.cellPx });
}

/** An item's box: its place on the grid, and the type size its rect has room for. */
const itemStyle = (item: PanelBoardItem, fit: BoardFit): CSSProperties => ({ ...placement(item.rect), fontSize: `${String(fit.fontPx)}px` });

const rectAttr = (rect: BoardRect): string => `${String(rect.x)},${String(rect.y)},${String(rect.w)},${String(rect.h)}`;

/** What a board item is called in an accessible name. */
function boardItemName(item: PanelBoardItem): string {
  if (item.kind === "label") return item.text === "" ? "label" : item.text;
  return controlCaption(item.node.parameters as Record<string, unknown>);
}

function Item({ item, write, fit }: { readonly item: PanelBoardItem; readonly write: ControlWrite; readonly fit: BoardFit }) {
  if (item.kind === "label") return <div className={styles.label}>{item.text}</div>;
  return (
    <ControlWidget nodeId={item.node.id} type={item.node.type} parameters={item.node.parameters as Record<string, unknown>} write={write} size="board" showValue={fit.value} />
  );
}

export interface PanelBoardGridProps {
  readonly board: PanelBoard;
  readonly write: ControlWrite;
  readonly variant: "canvas" | "tab";
  /** `variant="canvas"`: the width the board is scaled to, in px (`controlsContentWidth`), so type is sized for the real cell. */
  readonly widthPx?: number;
}

/** PLAY mode: the board, operable, nothing else. */
export function PanelBoardGrid({ board, write, variant, widthPx }: PanelBoardGridProps) {
  const cells = variant === "canvas" && widthPx !== undefined ? canvasCells(widthPx, board.columns) : TAB_CELLS;
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
      {board.items.map((item) => {
        const fit = fitOf(item, cells);
        return (
          <div key={item.key} className={styles.item} style={itemStyle(item, fit)} data-board-item={item.key} data-rect={rectAttr(item.rect)} data-caption-fit={fit.caption}>
            <Item item={item} write={write} fit={fit} />
          </div>
        );
      })}
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
  /** For the Drives chips' × (`ControlTargets`): unbinding reads the target's declared default. */
  readonly registry: NodeRegistryView;
}

interface Drag {
  readonly key: string;
  readonly mode: "move" | "resize";
  /** The pointer at the press, in BOARD space: client px plus the board area's scroll (T1518b). */
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

export function PanelBoardEditor({ graph, panelId, board, write, apply, registry }: PanelBoardEditorProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ readonly key: string; readonly rect: BoardRect; readonly fits: boolean } | null>(null);
  const drag = useRef<Drag | null>(null);
  /**
   * T1518b — the board area scrolls by itself (a short dock keeps the toolbar and reaches
   * the spare rows), so a drag is measured in BOARD space: scrolling it mid-drag moves the
   * control by what was scrolled, exactly as moving the pointer would.
   */
  const workspace = useRef<HTMLDivElement | null>(null);
  const at = (event: ReactPointerEvent<HTMLElement>): { x: number; y: number } => ({
    x: event.clientX + (workspace.current?.scrollLeft ?? 0),
    y: event.clientY + (workspace.current?.scrollTop ?? 0),
  });
  const cellsFrom = (current: Drag, event: ReactPointerEvent<HTMLElement>): [number, number] => {
    const now = at(event);
    return [Math.round((now.x - current.start.x) / PITCH), Math.round((now.y - current.start.y) / PITCH)];
  };
  const commit = (stored: StoredBoard | null, label: string): void => {
    if (stored !== null) apply(boardOperations(panelId, stored), label);
  };

  const begin = (item: PanelBoardItem, mode: Drag["mode"]) => (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    capture(event);
    drag.current = { key: item.key, mode, start: at(event), from: item.rect, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current === null) return;
    const [dx, dy] = cellsFrom(current, event);
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
    const rect = dragged(current, ...cellsFrom(current, event));
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
      <div className={styles.workspace} ref={workspace} data-board-workspace>
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
            const fit = fitOf(item, TAB_CELLS);
            return (
              <div
                key={item.key}
                className={`${styles.item} ${styles.editable} ${selected === item.key ? styles.selected : ""}`}
                style={itemStyle(item, fit)}
                data-board-item={item.key}
                data-rect={rectAttr(item.rect)}
                data-caption-fit={fit.caption}
              >
                {/* Inert: in edit mode a control is a thing to place, not to play. */}
                <div className={styles.inert} inert>
                  <Item item={item} write={write} fit={fit} />
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
              <ControlTargets graph={graph} registry={registry} widget={chosen.node} apply={apply} />
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
