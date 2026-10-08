import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import type { KindLabelBox, KindLabelRegistry } from "@editor/nodes/kind-label.ts";
import { ANNOTATION_NODE_TYPE } from "./derive.ts";

/**
 * Tells the low-zoom kind labels the canvas's zoom (T1597b), and renders nothing.
 *
 * A child of `<ReactFlow>`, like the grid and the reference lines, because the zoom lives
 * in React Flow's store. Unlike them it does not SELECT from that store: a selector hook
 * re-renders its component when the value changes, and the whole point here is that a
 * zoom re-renders nothing. `useStoreApi().subscribe` hands every store event to the
 * registry, which compares one number and returns unless the zoom itself moved (§V142: a
 * camera move must cost nothing, and a pan is not a zoom).
 *
 * VNB15: it also hands the registry the nodes' boxes when the LAYOUT changes, so an
 * instance's label knows how far it may reach past its node (`instanceReach`). A zoom or a
 * pan replaces no node array and reaches none of that.
 *
 * The canvas root comes from the same store (`domNode`), so the tier attribute lands on
 * THIS canvas's element and a second canvas on the same document keeps its own (§V97).
 */
export function KindLabelDriver({ registry }: { readonly registry: KindLabelRegistry }) {
  const api = useStoreApi();
  useEffect(() => {
    // VNB15: the node array React Flow holds is replaced when a node moves, is measured,
    // appears or leaves, and never by a pan or a zoom. Its identity is the layout signal.
    let laidOut: unknown = null;
    const sync = (): void => {
      const state = api.getState();
      registry.attach(state.domNode);
      registry.apply(state.transform[2]);
      if (state.nodes === laidOut) return;
      laidOut = state.nodes;
      const boxes: KindLabelBox[] = [];
      for (const node of state.nodeLookup.values()) {
        // A note is a region behind the nodes, not a node a label could run into.
        if (node.type === ANNOTATION_NODE_TYPE) continue;
        const width = node.measured.width ?? node.width ?? 0;
        const height = node.measured.height ?? node.height ?? 0;
        if (!(width > 0)) continue;
        // No Loom node has a parent (`derive.ts` sets none), so its position IS its place on the canvas.
        const { x, y } = node.position;
        boxes.push({ nodeId: node.id, x, y, width, height });
      }
      registry.layout(boxes);
    };
    sync();
    const unsubscribe = api.subscribe(sync);
    return () => {
      unsubscribe();
      registry.attach(null);
    };
  }, [api, registry]);
  return null;
}
