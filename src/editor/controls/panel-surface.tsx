import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { controlsContentWidth } from "@domain/graph/node-box.ts";
import { panelBoard, panelLayout, panelTitle } from "@nodes/definitions/controls.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import { PanelBoardGrid } from "./panel-board.tsx";
import { PANEL_EMPTY_HINT } from "./phone-door-copy.ts";
import { useLiveNode } from "./use-live-node.ts";
import styles from "./panel-surface.module.css";

/**
 * T1512b — A PANEL, DRAWN: its rows — headings, notes and widgets — from `panelLayout`,
 * the one derivation the phone snapshot reads too. The Panel node's body on the canvas and
 * the Controls tab both draw through this component, at two sizes, so "the Controls tab is
 * a bigger view of the same Panel" is a fact of the code rather than a promise: there is no
 * second list of members to drift.
 *
 * Every widget is the live `ControlWidget`, writing its node through the parameter editor
 * the caller hands in (one undo group per gesture, §V15). `renderMeta` lets the Controls tab
 * put what each widget drives under it; the canvas body has none.
 *
 * T1516b — since the board, these rows are what a Panel laid out by its legacy Layout
 * override draws (`panelBoard` is null for it). A wired Panel draws its board.
 */

/** A control in a row or a list, reading ITS OWN node (`useLiveNode`, T1668b). */
export function LiveControl({ bus, node, write, size }: { readonly bus: LoomBus; readonly node: GraphNode; readonly write: ControlWrite; readonly size: "node" | "panel" }) {
  const live = useLiveNode(bus, node);
  return <ControlWidget nodeId={live.id} type={live.type} parameters={live.parameters as Record<string, unknown>} write={write} size={size} />;
}

/** Where a surface that lays controls out gets the document's structure from, when its host has it. */
export interface StructureSource {
  subscribe(listener: () => void): () => void;
  get(): GraphDocument;
}

export interface PanelRowsProps {
  readonly graph: Pick<GraphDocument, "nodes" | "edges">;
  readonly panel: GraphNode;
  readonly bus: LoomBus;
  readonly write: ControlWrite;
  readonly size: "node" | "panel";
  readonly renderMeta?: (widget: GraphNode) => ReactNode;
}

export function PanelRows({ graph, panel, bus, write, size, renderMeta }: PanelRowsProps) {
  const { rows } = panelLayout(graph, panel);
  if (rows.length === 0) return <p className={styles.hint} data-panel-empty>{PANEL_EMPTY_HINT}</p>;
  return (
    <>
      {rows.map((row, index) =>
        row.kind !== "widgets" ? (
          row.kind === "heading" ? (
            <h3 key={index} className={styles.heading}>{row.text}</h3>
          ) : (
            <p key={index} className={styles.note}>{row.text}</p>
          )
        ) : (
          <div key={index} className={size === "panel" ? styles.grid : styles.stack} data-panel-row>
            {row.cells.map((cell, at) =>
              cell.kind === "missing" ? (
                <div key={`missing-${cell.name}-${String(at)}`} className={styles.missing}>no control named “{cell.name}”</div>
              ) : (
                <div key={cell.node.id} className={size === "panel" ? styles.cell : undefined}>
                  <LiveControl bus={bus} node={cell.node} write={write} size={size} />
                  {renderMeta?.(cell.node)}
                </div>
              ),
            )}
          </div>
        ),
      )}
    </>
  );
}

/**
 * The Panel node's own body on the canvas: its title and its board (T1516b) — or, for a
 * Panel laid out by the legacy override text, its rows — live. Its own subscription,
 * because the body shows OTHER nodes — and, T1668b, a subscription to the document's
 * STRUCTURE where the canvas has one to give (`structure`): which controls are on the board
 * and where. Each control on it reads its own value (`useLiveNode`), so a widget moved
 * anywhere moves here too without this body rendering. Without `structure` (a test, an
 * embed) it follows the store.
 *
 * The board is the tab's board scaled to the node's width (`PanelBoardGrid variant="canvas"`),
 * from the same `panelBoard`; it is played here and arranged in the Controls tab — or in
 * the popover the pencil on this node's header opens (T1518b, `panel-edit.tsx`).
 *
 * T1501b: handed the bus, not only its store — a board's bank, layer and cue-list items
 * press commands (`board-members.tsx`).
 */
export function PanelNodeBody({
  bus,
  invocation,
  panelId,
  write,
  structure,
}: {
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly panelId: NodeId;
  readonly write: ControlWrite;
  /** The document as of its last structural revision, and when that moves (the app's `revision-watch.ts`). */
  readonly structure?: StructureSource | undefined;
}) {
  const graph = useSyncExternalStore(structure?.subscribe ?? bus.store.subscribe, structure?.get ?? bus.store.getGraph);
  const panel = graph.nodes[panelId];
  if (panel === undefined) return null;
  const board = panelBoard(graph, panel);
  return (
    // T1619b: `data-control-panel` is which Panel a right-clicked control's "all on this Panel" means.
    <div className={styles.body} data-panel-body={panelId} data-control-panel={panelId}>
      <div className={styles.title}>{panelTitle(panel)}</div>
      {board === null ? (
        <PanelRows graph={graph} panel={panel} bus={bus} write={write} size="node" />
      ) : board.items.length === 0 ? (
        <p className={styles.hint} data-panel-empty>{PANEL_EMPTY_HINT}</p>
      ) : (
        // T1518b: the width the node gives its body, so type is sized for the real cell.
        <PanelBoardGrid board={board} write={write} bus={bus} invocation={invocation} variant="canvas" widthPx={controlsContentWidth(panel)} />
      )}
    </div>
  );
}
