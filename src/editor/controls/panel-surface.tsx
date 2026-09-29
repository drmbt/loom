import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { GraphStoreView } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { panelLayout, panelTitle } from "@nodes/definitions/controls.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import { PANEL_EMPTY_HINT } from "./phone-door-copy.ts";
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
 * put its mapping and ordering tools under each widget; the canvas body has none.
 */

export interface PanelRowsProps {
  readonly graph: Pick<GraphDocument, "nodes" | "edges">;
  readonly panel: GraphNode;
  readonly write: ControlWrite;
  readonly size: "node" | "panel";
  readonly renderMeta?: (widget: GraphNode) => ReactNode;
}

export function PanelRows({ graph, panel, write, size, renderMeta }: PanelRowsProps) {
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
                  <ControlWidget
                    nodeId={cell.node.id}
                    type={cell.node.type}
                    parameters={cell.node.parameters as Record<string, unknown>}
                    write={write}
                    size={size}
                  />
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
 * The Panel node's own body on the canvas: its title and its rows, live. Its own store
 * subscription, because the body shows OTHER nodes' values — a widget moved anywhere must
 * move here too, and the Panel node's own slice (§V16) never changes when it does.
 */
export function PanelNodeBody({ store, panelId, write }: { readonly store: GraphStoreView; readonly panelId: NodeId; readonly write: ControlWrite }) {
  const graph = useStore(store, (state) => state.graph);
  const panel = graph.nodes[panelId];
  if (panel === undefined) return null;
  return (
    <div className={styles.body} data-panel-body={panelId}>
      <div className={styles.title}>{panelTitle(panel)}</div>
      <PanelRows graph={graph} panel={panel} write={write} size="node" />
    </div>
  );
}
