import { useEffect, useMemo, useState } from "react";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { CONTROL_WIDGET_TYPES, panelLayout, panelTitle } from "@nodes/definitions/controls.ts";
import { isRemotePanel } from "@devices/phone/phone-snapshot.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import { movePanelMemberOperations } from "./panel-join.ts";
import { unbindOperations } from "./parameter-controls.ts";
import { PanelRows } from "./panel-surface.tsx";
import { PhoneDoorButton } from "./phone-door.tsx";
import type { PhoneDoorView } from "./phone-door-copy.ts";
import styles from "./controls-pane.module.css";
import surface from "./panel-surface.module.css";

/**
 * T1388b — THE CONTROLS PANE: a Panel node's layout as a performance surface.
 *
 * Headings, notes and rows of widgets, each one the live control of its node (drag it here
 * or on the canvas; both are the same parameters). Under every widget: what it drives — the
 * parameters whose expression reads its channel — as chips, each with a × that unbinds it.
 *
 * With no Panel in the document the pane still works: it lays out every widget there is, so
 * dropping a Slider on the canvas is already a control you can perform with.
 *
 * T1512b — with a Panel, this is a BIGGER VIEW OF THE PANEL NODE: the same rows from the
 * same `panelLayout` through the same `PanelRows` the node body draws, the same phone icon
 * (`PhoneDoorButton`) in the header, and — while the Panel follows its wiring — buttons
 * that move a widget earlier or later, rewriting the edge order through the bus.
 *
 * T1513b — the "map…" form is gone from the cards: mapping starts FROM THE PARAMETER
 * (§T1514b, owner ruling), and a card says only what its control drives, and lets go of it.
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

/** A small arrow, for the move-earlier / move-later buttons. */
function Arrow({ direction }: { direction: "left" | "right" }) {
  return (
    <svg className={styles.icon} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d={direction === "left" ? "M7.5 2.5 4 6l3.5 3.5" : "M4.5 2.5 8 6 4.5 9.5"} />
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
  const panel = panels.find((candidate) => candidate.id === chosen) ?? panels[0];
  const wired = panel !== undefined && panelLayout(graph, panel).source === "wiring";

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

  const renderMeta = (widget: GraphNode) => {
    const targets = targetsOf(graph, widget);
    const movable = wired && panel !== undefined;
    if (targets.length === 0 && !movable) return null;
    return (
      <div className={styles.meta}>
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
        {movable ? (
          <span className={styles.order}>
            <button type="button" className={styles.iconButton} aria-label={`Move ${nameOf(widget)} earlier`} title="Move earlier" onClick={() => apply(movePanelMemberOperations(graph, panel.id, widget.id, -1), "Reorder panel")}>
              <Arrow direction="left" />
            </button>
            <button type="button" className={styles.iconButton} aria-label={`Move ${nameOf(widget)} later`} title="Move later" onClick={() => apply(movePanelMemberOperations(graph, panel.id, widget.id, 1), "Reorder panel")}>
              <Arrow direction="right" />
            </button>
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div className={styles.pane} data-controls-pane>
      <header className={styles.header}>
        <h2 className={styles.title}>{panel === undefined ? "All controls" : panelTitle(panel)}</h2>
        {panels.length > 1 ? (
          <select aria-label="Panel" value={panel?.id ?? ""} onChange={(event) => setChosen(event.target.value)}>
            {panels.map((candidate) => <option key={candidate.id} value={candidate.id}>{panelTitle(candidate)}</option>)}
          </select>
        ) : null}
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
      ) : (
        <PanelRows graph={graph} panel={panel} write={write} size="panel" renderMeta={renderMeta} />
      )}
    </div>
  );
}
