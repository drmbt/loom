import type { NodeId } from "@domain/types/ids.ts";
import type { SlotBox } from "@runtime/previews/index.ts";

/**
 * Each node's preview slot, as an offset + size WITHIN ITS OWN NODE (design note §3;
 * §V111, §V112).
 *
 * Deliberately NOT an absolute graph-space or screen rect: `NodePreviewSlot` measures
 * the slot relative to its node's own `.react-flow__node` wrapper once on mount and
 * again whenever it resizes, which is why the value survives an uncommitted drag with
 * no re-measurement — the offset within the node does not change while the node moves,
 * only its absolute position does, and that is read LIVE from React Flow (never the
 * document, which lags for the whole drag) by whoever adds it back on, every tick, in
 * `use-node-previews.ts`. The composition root's rAF tick reads this store to build
 * that. Plain — no React, no coalescing — because both sides already rate-limit
 * themselves: a `ResizeObserver` on the write side, one tick on the read side.
 */
export interface PreviewSlotBoundsStore {
  publish(nodeId: NodeId, box: SlotBox): void;
  clear(nodeId: NodeId): void;
  get(nodeId: NodeId): SlotBox | undefined;
  /**
   * T892 — every measured slot at once, for the chrome that is DRAWN on the tiles.
   *
   * The rAF tick asks for one node at a time and keeps doing so; the overlay layer
   * (`preview-inspect-overlay.tsx`) is React and needs a value it can render from and a
   * signal when a slot arrives, moves or leaves. Copy-on-write is what serves both: the
   * map identity IS the change notification, so `useSyncExternalStore` can hold it
   * directly, while `get` stays a plain `Map.get` for the per-frame reader.
   *
   * Cheap because the write side is already rare — a slot publishes on mount and on a
   * genuine resize, never per frame — and a re-publish of an IDENTICAL box does not copy
   * or notify at all, which is what keeps a zoom (where every slot is re-measured to the
   * same node-local numbers) from churning React.
   */
  snapshot(): ReadonlyMap<NodeId, SlotBox>;
  subscribe(listener: () => void): () => void;
  /**
   * T1655b — the tiles whose CHROME CORNER (bottom-right, where the camera toggle or its
   * sentence is drawn) lies under a node that paints in front.
   *
   * The compositor already clips a tile by the nodes in front of it (T1102); the chrome
   * layer is a sibling of the compositing surface, above every node, and clipped nothing.
   * Seen in the owner's own document, where nodes overlap: a covered geometry's "No object
   * drawn on this tile." was painted across the material tile in front of it, which plainly
   * draws one. Chrome that lands on another node's picture says something false about it.
   *
   * Written by the preview tick, which is the one reader of the DOM's stacking order; the
   * snapshot's identity moves when membership does, so the overlay re-renders on it.
   */
  setCornerCovered(nodeIds: ReadonlySet<NodeId>): void;
  cornerCovered(nodeId: NodeId): boolean;
}

function sameBox(a: SlotBox, b: SlotBox): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function createPreviewSlotBounds(): PreviewSlotBoundsStore {
  let boxes = new Map<NodeId, SlotBox>();
  let covered: ReadonlySet<NodeId> = new Set();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    publish(nodeId, box) {
      const previous = boxes.get(nodeId);
      if (previous !== undefined && sameBox(previous, box)) return;
      boxes = new Map(boxes).set(nodeId, box);
      notify();
    },
    clear(nodeId) {
      if (!boxes.has(nodeId)) return;
      boxes = new Map(boxes);
      boxes.delete(nodeId);
      notify();
    },
    get(nodeId) {
      return boxes.get(nodeId);
    },
    snapshot() {
      return boxes;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setCornerCovered(nodeIds) {
      if (nodeIds.size === covered.size && [...nodeIds].every((nodeId) => covered.has(nodeId))) return;
      covered = new Set(nodeIds);
      // The map's identity is the change notification (see `snapshot`).
      boxes = new Map(boxes);
      notify();
    },
    cornerCovered(nodeId) {
      return covered.has(nodeId);
    },
  };
}
