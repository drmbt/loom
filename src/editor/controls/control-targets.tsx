import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { controlTargets, unbindOperations } from "./parameter-controls.ts";
import styles from "./controls-pane.module.css";

/**
 * T1513b — WHAT A CONTROL DRIVES, as chips with ×: the parameters whose active expression
 * reads the widget. Its own file since T1518b, because the board's edit surface shows it in
 * two places — the Controls tab and the popover the Panel node's pencil opens — and both
 * must list, and unbind, the same thing.
 */

export interface ControlTargetsProps {
  readonly graph: Pick<GraphDocument, "nodes" | "edges">;
  readonly registry: NodeRegistryView;
  readonly widget: GraphNode;
  /** Sends ONE patch through the bus. */
  readonly apply: (operations: GraphPatchOperation[], label: string) => void;
}

/**
 * The chips. A chip's ×: the target parameter goes back to Constant holding the value it
 * retained, one patch, undoable — the SAME unbind the Inspector's "← Heat" chip and
 * `control.unbindParameter` run (`unbindOperations`, T1514b).
 */
export function ControlTargets({ graph, registry, widget, apply }: ControlTargetsProps) {
  return (
    <ul className={styles.chips} aria-label={`${widget.label ?? widget.id} drives`}>
      {controlTargets(graph, widget).map((target) => (
        <li key={`${target.nodeId}.${target.key}`} className={styles.chip} title={target.label} data-target={target.label}>
          <span className={styles.chipLabel}>{target.label}</span>
          <button
            type="button"
            className={styles.chipRemove}
            aria-label={`Unbind ${target.label}`}
            title={`Unbind ${target.label}`}
            onClick={() => apply(unbindOperations(graph, registry, target.nodeId, [target.key]), `Unbind ${target.label}`)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
