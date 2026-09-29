import { useCallback } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { isRemotePanel } from "@devices/phone/phone-snapshot.ts";
import { CONTROL_WIDGET_TYPES } from "@nodes/definitions/controls.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import { joinPanelOperations, soloPanelFor } from "./panel-join.ts";
import { PanelNodeBody } from "./panel-surface.tsx";
import { PhoneDoorButton } from "./phone-door.tsx";
import type { PhoneDoorView } from "./phone-door-copy.ts";
import styles from "./control-widget.module.css";

/**
 * T1388b/T1512b — WHAT A CONTROL NODE DRAWS ON THE CANVAS, as the two seams the graph
 * canvas offers (`renderControls` for the body, `renderHeaderControls` for the header).
 *
 * - A widget's body IS its control, plus — while the document has exactly one Panel the
 *   widget is not on — a small "add to panel" button: the one-press version of wiring it.
 * - A Panel's body is the Panel itself, live (`PanelNodeBody`), and its header carries the
 *   phone icon (`PhoneDoorButton`) that publishes it and opens the door's popover there.
 *
 * Here rather than in the graph pane so the tests mount the SAME seams the product does.
 * Every closure is keyed on stable things (the bus, the writer, the door view) so the
 * canvas context — and with it every node view — does not move with the document (T714).
 * The door view changes when the door does (open, a phone arrives), which is rare.
 */

export interface ControlBodiesOptions {
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly write: ControlWrite;
  /** The phone door; absent where a Panel cannot be published (tests, inside a component). */
  readonly phone?: PhoneDoorView | undefined;
}

export interface ControlBodies {
  renderControls(nodeId: NodeId): ReactNode;
  renderHeaderControls(nodeId: NodeId): ReactNode;
}

function apply(bus: LoomBus, invocation: InvocationContext, operations: GraphPatchOperation[], label: string): void {
  if (operations.length === 0) return;
  void bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label, operations }, invocation);
}

/** A widget's "add to panel" — offered only while there is exactly one Panel to add it to. */
function AddToPanel({ bus, invocation, widgetId }: { bus: LoomBus; invocation: InvocationContext; widgetId: NodeId }) {
  const panelId = useStore(bus.store, (state) => soloPanelFor(state.graph, widgetId));
  if (panelId === null) return null;
  return (
    <button
      type="button"
      className={styles.addToPanel}
      aria-label="Add to panel"
      title="Add to panel"
      onClick={() => apply(bus, invocation, joinPanelOperations(bus.store.getGraph(), widgetId, panelId), "Add to panel")}
    >
      + panel
    </button>
  );
}

/** A Panel's header phone icon, following the Panel's own Phone switch. */
function PanelPhone({ bus, invocation, panelId, door }: { bus: LoomBus; invocation: InvocationContext; panelId: NodeId; door: PhoneDoorView }) {
  const published = useStore(bus.store, (state) => {
    const node = state.graph.nodes[panelId];
    return node !== undefined && isRemotePanel(node);
  });
  const publish = useCallback(
    (on: boolean) =>
      apply(
        bus,
        invocation,
        [{ op: "setParameters", nodeId: panelId, parameters: { remote: on } }],
        on ? "Publish panel to phones" : "Stop publishing panel",
      ),
    [bus, invocation, panelId],
  );
  return <PhoneDoorButton door={door} panel={{ published, publish }} />;
}

export function useControlBodies({ bus, invocation, write, phone }: ControlBodiesOptions): ControlBodies {
  const renderControls = useCallback(
    (nodeId: NodeId): ReactNode => {
      const node = bus.store.getGraph().nodes[nodeId];
      if (node === undefined) return null;
      if (node.type === "panel") return <PanelNodeBody store={bus.store} panelId={nodeId} write={write} />;
      if (!CONTROL_WIDGET_TYPES.has(node.type)) return null;
      return (
        <>
          <ControlWidget nodeId={nodeId} type={node.type} parameters={node.parameters} write={write} />
          <AddToPanel bus={bus} invocation={invocation} widgetId={nodeId} />
        </>
      );
    },
    [bus, invocation, write],
  );
  const renderHeaderControls = useCallback(
    (nodeId: NodeId): ReactNode => {
      if (phone === undefined || bus.store.getGraph().nodes[nodeId]?.type !== "panel") return null;
      return <PanelPhone bus={bus} invocation={invocation} panelId={nodeId} door={phone} />;
    },
    [bus, invocation, phone],
  );
  return { renderControls, renderHeaderControls };
}
