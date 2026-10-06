import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import type { KindLabelRegistry } from "@editor/nodes/kind-label.ts";

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
 * The canvas root comes from the same store (`domNode`), so the tier attribute lands on
 * THIS canvas's element and a second canvas on the same document keeps its own (§V97).
 */
export function KindLabelDriver({ registry }: { readonly registry: KindLabelRegistry }) {
  const api = useStoreApi();
  useEffect(() => {
    const sync = (): void => {
      const state = api.getState();
      registry.attach(state.domNode);
      registry.apply(state.transform[2]);
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
