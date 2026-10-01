import { useEffect, useMemo, useState } from "react";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { CONTROL_WIDGET_TYPES, panelBoard, panelTitle } from "@nodes/definitions/controls.ts";
import { isRemotePanel } from "@devices/phone/phone-snapshot.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import { unbindOperations } from "./parameter-controls.ts";
import { PanelBoardEditor, PanelBoardGrid } from "./panel-board.tsx";
import { PanelRows } from "./panel-surface.tsx";
import { PhoneDoorButton } from "./phone-door.tsx";
import { PANEL_EMPTY_HINT, type PhoneDoorView } from "./phone-door-copy.ts";
import styles from "./controls-pane.module.css";
import surface from "./panel-surface.module.css";

/**
 * T1388b — THE CONTROLS PANE: a Panel node's layout as a performance surface.
 *
 * With no Panel in the document the pane still works: it lays out every widget there is, so
 * dropping a Slider on the canvas is already a control you can perform with. Under every
 * widget there: what it drives — the parameters whose expression reads its channel — as
 * chips, each with a × that unbinds it.
 *
 * T1512b — with a Panel, this is a BIGGER VIEW OF THE PANEL NODE, with the same phone icon
 * (`PhoneDoorButton`) in the header.
 *
 * T1513b — the "map…" form is gone from the cards: mapping starts FROM THE PARAMETER
 * (§T1514b, owner ruling), and a card says only what its control drives, and lets go of it.
 *
 * T1516b — a wired Panel is a FREE BOARD (`panelBoard`), and this pane splits PLAYING it from
 * ARRANGING it. Play (the default) draws the board at fixed compact cells and only operates
 * the controls — no chips, no arrows. The pencil in the header is edit mode: controls go
 * inert, drag to move and resize on the grid, labels, the column count, and per control what
 * it drives (× unlink) and Remove from panel (`PanelBoardEditor`). The auto-fill grid and the
 * ‹ › reorder of T1513b are gone for wired Panels; a Panel laid out by the legacy override
 * text keeps its rows, with their chips.
 */

export interface ControlsPaneProps {
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** T1396b — the phone door; absent where no device attachment exists (tests, headless). */
  readonly phone?: PhoneDoorView;
}

const nameOf = (node: GraphNode): string => node.label ?? node.id;

/** One parameter a widget drives: the node, the key, and how a chip names it. */
interface Target {
  readonly nodeId: NodeId;
  readonly key: string;
  readonly label: string;
}

/** Every parameter in the document whose ACTIVE expression reads this widget. */
function targetsOf(graph: GraphDocument, widget: GraphNode): Target[] {
  const needle = `op('${nameOf(widget)}')`;
  const found: Target[] = [];
  for (const node of Object.values(graph.nodes)) {
    for (const [key, stored] of Object.entries(node.parameters)) {
      if (!isParameterSlot(stored)) continue;
      const expression = stored.bindings.expression;
      if (stored.mode === "expression" && expression?.kind === "expression" && expression.source.includes(needle)) {
        found.push({ nodeId: node.id, key, label: `${nameOf(node)}.${key}` });
      }
    }
  }
  return found;
}

/** The pencil: edit mode's switch. */
function Pencil() {
  return (
    <svg className={styles.icon} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 10l.6-2.4L8.2 2l1.8 1.8-5.6 5.6L2 10zM7.2 3l1.8 1.8" />
    </svg>
  );
}

export function ControlsPane({ graph, registry, bus, invocation, phone }: ControlsPaneProps) {
  const editor = useMemo(() => createParameterEditor({ bus, context: invocation }), [bus, invocation]);
  useEffect(() => () => editor.dispose(), [editor]);
  const write = useMemo<ControlWrite>(() => (nodeId, entries, phase) => editor.setStored(nodeId, entries, phase), [editor]);

  const panels = useMemo(() => Object.values(graph.nodes).filter((node) => node.type === "panel"), [graph]);
  const widgets = useMemo(() => Object.values(graph.nodes).filter((node) => CONTROL_WIDGET_TYPES.has(node.type)), [graph]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const panel = panels.find((candidate) => candidate.id === chosen) ?? panels[0];
  const board = panel === undefined ? null : panelBoard(graph, panel);

  const apply = (operations: GraphPatchOperation[], label: string): void => {
    if (operations.length === 0) return;
    void bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label, operations }, invocation);
  };

  /**
   * T1513b — a chip's ×: the target parameter goes back to Constant holding the value it
   * retained, one patch, undoable. T1514b: the SAME unbind the Inspector's "← Heat" chip
   * and `control.unbindParameter` run (`unbindOperations`).
   */
  const unbind = (target: Target): void =>
    apply(unbindOperations(graph, registry, target.nodeId, [target.key]), `Unbind ${target.label}`);

  if (widgets.length === 0 && panel === undefined) {
    return (
      <div className={styles.empty}>
        <p>No controls</p>
        {phone === undefined ? null : <PhoneDoorButton door={phone} />}
      </div>
    );
  }

  /** What a widget drives, as chips with × — under a card, or in edit mode's side list. */
  const renderTargets = (widget: GraphNode) => {
    const targets = targetsOf(graph, widget);
    return (
      <ul className={styles.chips} aria-label={`${nameOf(widget)} drives`}>
        {targets.map((target) => (
          <li key={`${target.nodeId}.${target.key}`} className={styles.chip} title={target.label} data-target={target.label}>
            <span className={styles.chipLabel}>{target.label}</span>
            <button type="button" className={styles.chipRemove} aria-label={`Unbind ${target.label}`} title={`Unbind ${target.label}`} onClick={() => unbind(target)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    );
  };
  const renderMeta = (widget: GraphNode) =>
    targetsOf(graph, widget).length === 0 ? null : <div className={styles.meta}>{renderTargets(widget)}</div>;

  return (
    <div className={styles.pane} data-controls-pane>
      <header className={styles.header}>
        <h2 className={styles.title}>{panel === undefined ? "All controls" : panelTitle(panel)}</h2>
        {panels.length > 1 ? (
          <select aria-label="Panel" value={panel?.id ?? ""} onChange={(event) => setChosen(event.target.value)}>
            {panels.map((candidate) => <option key={candidate.id} value={candidate.id}>{panelTitle(candidate)}</option>)}
          </select>
        ) : null}
        {board === null ? null : (
          <button
            type="button"
            className={`${styles.iconButton} ${editing ? styles.active : ""}`}
            aria-label="Edit board"
            aria-pressed={editing}
            title={editing ? "Done arranging" : "Arrange the board"}
            onClick={() => setEditing(!editing)}
          >
            <Pencil />
          </button>
        )}
        {phone === undefined ? null : (
          <PhoneDoorButton
            door={phone}
            panel={
              panel === undefined
                ? undefined
                : {
                    published: isRemotePanel(panel),
                    publish: (on) =>
                      apply([{ op: "setParameters", nodeId: panel.id, parameters: { remote: on } }], on ? "Publish panel to phones" : "Stop publishing panel"),
                  }
            }
          />
        )}
      </header>
      {panel === undefined ? (
        <div className={surface.grid} data-panel-row>
          {widgets.map((widget) => (
            <div key={widget.id} className={surface.cell}>
              <ControlWidget nodeId={widget.id} type={widget.type} parameters={widget.parameters as Record<string, unknown>} write={write} size="panel" />
              {renderMeta(widget)}
            </div>
          ))}
        </div>
      ) : board === null ? (
        <PanelRows graph={graph} panel={panel} write={write} size="panel" renderMeta={renderMeta} />
      ) : editing ? (
        <PanelBoardEditor graph={graph} panelId={panel.id} board={board} write={write} apply={apply} renderTargets={renderTargets} />
      ) : board.items.length === 0 ? (
        <p className={surface.hint} data-panel-empty>{PANEL_EMPTY_HINT}</p>
      ) : (
        <PanelBoardGrid board={board} write={write} variant="tab" />
      )}
    </div>
  );
}
