import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { controlNameOf } from "@nodes/definitions/controls.ts";
import { controlCaptionOf, unbindOperations, type BoundControl } from "./parameter-controls.ts";
import styles from "./controls-pane.module.css";

/**
 * T1514b — WHAT DRIVES THIS ROW, at the row: "← Heat" under a parameter a control reads,
 * with × to let go. The twin of the Controls cards' target chips (same look, same
 * `unbindOperations`), seen from the other end of the binding.
 *
 * One chip per control: a 2-vector an XY pad drives shows one "← Warp", and its × lets go
 * of both components in one patch, so one undo brings both back.
 */
export interface BoundControlChipsProps {
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly nodeId: NodeId;
  readonly bound: readonly BoundControl[];
}

export function BoundControlChips({ bus, invocation, nodeId, bound }: BoundControlChipsProps) {
  if (bound.length === 0) return null;
  const controls = new Map<NodeId, { control: GraphNode; keys: string[] }>();
  for (const { key, control } of bound) {
    const entry = controls.get(control.id) ?? { control, keys: [] };
    entry.keys.push(key);
    controls.set(control.id, entry);
  }
  const unlink = (keys: readonly string[], caption: string): void => {
    const operations = unbindOperations(bus.store.getGraph(), bus.registry, nodeId, keys);
    if (operations.length === 0) return;
    void bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label: `Unlink ${caption}`, operations }, invocation);
  };
  return (
    <ul className={styles.chips} aria-label="Driven by">
      {[...controls.values()].map(({ control, keys }) => {
        const caption = controlCaptionOf(control);
        return (
          <li key={control.id} className={styles.chip} title={`Driven by ${controlNameOf(control)}`} data-bound-control={controlNameOf(control)}>
            <span className={styles.chipLabel}>← {caption}</span>
            <button type="button" className={styles.chipRemove} aria-label={`Unlink ${caption}`} title={`Unlink ${caption}`} onClick={() => unlink(keys, caption)}>
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
