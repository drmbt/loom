import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";

/**
 * VN62 — ONE UNDO STEP FOR A GESTURE THAT WRITES SEVERAL NODES.
 *
 * `createParameterEditor` groups a gesture per (node, keys); a dope-sheet drag of the
 * summary row moves keys in several automation nodes at once, so it writes through here:
 * every patch of one gesture carries the SAME `transactionId`, which the store merges into
 * one undo group (§V15), the mechanism the parameter editor uses. Patches are serialized
 * (a stale `baseRevision` is refused, §V33) and coalesced: while one is in flight only the
 * newest pending patch is kept, since each is computed from the gesture's origin and the
 * last one carries everything.
 */
export interface GestureWriter {
  /** Queue this gesture's latest patch. */
  write: (operations: readonly GraphPatchOperation[]) => void;
  /** Send what is pending and close the gesture; resolves when it has landed. */
  end: () => Promise<void>;
}

let gestures = 0;

export function beginGesture(bus: LoomBus, invocation: InvocationContext, label: string): GestureWriter {
  gestures += 1;
  const context: InvocationContext = { ...invocation, transactionId: `timeline-${gestures}-${Math.random().toString(36).slice(2, 8)}` };
  let pending: readonly GraphPatchOperation[] | null = null;
  let flight: Promise<void> | null = null;

  const pump = (): Promise<void> => {
    if (flight !== null) return flight;
    if (pending === null) return Promise.resolve();
    const operations = pending;
    pending = null;
    flight = bus
      .execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [...operations], label }, context)
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        flight = null;
        return pump();
      });
    return flight;
  };

  return {
    write: (operations) => {
      if (operations.length === 0) return;
      pending = operations;
      void pump();
    },
    end: async () => {
      // Wait out the flight, then whatever arrived while it flew.
      while (flight !== null || pending !== null) await pump();
    },
  };
}
