import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import { wireRangeInGraph } from "@editor/edges/wire-range.ts";

/**
 * Keeps React Flow's `connectionRadius` equal to the wire range at the canvas's zoom
 * (T1639b), and renders nothing.
 *
 * The library measures that radius in graph units and reads it from its store when a
 * handle, or the end of an edge, is pressed. The range is a screen size below 100 % zoom
 * (`wire-range.ts`), so the number in the store has to follow the zoom. A prop could not
 * do it: it would be state on the canvas, and a zoom step would re-render the canvas to
 * change a number only a press reads.
 *
 * So this is `KindLabelDriver`'s shape: a child of `<ReactFlow>` that subscribes to the
 * store without selecting from it. Every store event compares one number; a pan is not a
 * zoom and writes nothing (§V142). `connectionRadius` is deliberately NOT passed as a prop
 * to `<ReactFlow>`: the library copies a prop into its store when the prop changes, and
 * the two writers would then disagree about who had the last word.
 */
export function WireRangeDriver() {
  const api = useStoreApi();
  useEffect(() => {
    let zoom = Number.NaN;
    const sync = (): void => {
      const state = api.getState();
      const next = state.transform[2];
      if (next === zoom) return;
      zoom = next;
      const radius = wireRangeInGraph(next);
      if (state.connectionRadius !== radius) api.setState({ connectionRadius: radius });
    };
    sync();
    return api.subscribe(sync);
  }, [api]);
  return null;
}
