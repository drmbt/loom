import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { nodeHasAnimatedParameters } from "@domain/channels/graph-channels.ts";
import { isComponentNodeType } from "@domain/components/component-type.ts";
import type { GraphStoreView } from "@domain/graph/store.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { BOARD_NAMED_TYPES, CONTROL_WIDGET_TYPES } from "@nodes/definitions/controls.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { revisionWatchFor } from "./revision-watch.ts";

/**
 * T1652b — THE DOCUMENT, FOR A SURFACE THAT SHOWS VALUES.
 *
 * The composition root renders for the document's STRUCTURE (`revision-watch.ts`): a
 * revision that only moved a value does not render `App`, so a `graph` prop handed down
 * from it would go on showing the value before. A pane that shows values therefore takes
 * its document here, from the store, and says WHICH values it shows:
 *
 *  - every structural revision re-renders it (the root renders then too, and hands it the
 *    rest of its props anew);
 *  - a values-only revision re-renders it when `shows` answers true for the nodes written
 *    — and not otherwise, which is the whole point: a slider moved on a phone renders the
 *    surfaces that draw that slider and no other pane.
 *
 * The SNAPSHOT is always the store's own document. A pane that was not re-rendered for a
 * value it does not show still reads that value correctly the next time it renders for
 * anything else (its selection moved, a prop changed), because it reads the store then,
 * not a copy held from its last render.
 *
 * `shows` is a claim about what the pane DRAWS, kept beside the pane's mount in `app.tsx`.
 * `pane-render-boundaries.test.tsx` counts the renders on both sides of each claim.
 */
export type ShowsValues = (written: readonly NodeId[], graph: GraphDocument) => boolean;

export function useLiveGraph(store: GraphStoreView, registry: NodeRegistryView, shows?: ShowsValues): GraphDocument {
  const watch = useMemo(() => revisionWatchFor(store, registry), [store, registry]);
  const showsNow = useRef(shows);
  showsNow.current = shows;
  const subscribe = useCallback(
    (notify: () => void) => {
      const offStructure = watch.subscribeStructure(notify);
      const offValues = watch.subscribeValues((revision) => {
        const claim = showsNow.current;
        if (claim === undefined || claim(revision.written, revision.graph)) notify();
      });
      return () => {
        offStructure();
        offValues();
      };
    },
    [watch],
  );
  return useSyncExternalStore(subscribe, store.getGraph, store.getGraph);
}

/**
 * What the GRAPH PANE draws a value of, itself: the handles it lays over a node's preview
 * tile, placed where the stored value puts them (`gizmoTilesFor`), and the camera a tile
 * is orbited from. A node's BODY is not the pane's: each node on the canvas hears its own
 * slice of the store, and a Panel's body hears the store whole (`panel-surface.tsx`). So a
 * control — a Slider, a Toggle, a Button, an XY Pad, which has no tile to lay a handle on —
 * is the one kind of write the pane does not render for.
 */
export const canvasShows: ShowsValues = (written, graph) =>
  written.some((nodeId) => {
    const type = graph.nodes[nodeId]?.type;
    return type === undefined || !CONTROL_WIDGET_TYPES.has(type);
  });

/**
 * What the INSPECTOR draws a value of: the nodes it inspects, and anything a node it
 * inspects READS. A node with an expression, a bind or a driven slot can read any other
 * node (§T1177: "no key local to the inspected node is safe"), so such a node shows every
 * write; a node with none shows only its own. A bank, a cue list, a Panel, a Layer and a
 * component instance draw what other nodes hold, and show every write too.
 */
export function inspectorShows(selection: readonly NodeId[]): ShowsValues {
  return (written, graph) =>
    selection.some((nodeId) => {
      if (written.includes(nodeId)) return true;
      const node = graph.nodes[nodeId];
      if (node === undefined) return false;
      return nodeHasAnimatedParameters(node) || node.type === "panel" || BOARD_NAMED_TYPES.has(node.type) || isComponentNodeType(node.type);
    });
}

/**
 * What the CONTROLS TAB's LAYOUT draws a value of: a Panel's own (its Phone switch, in the
 * header). T1668b: nothing else. The tab is laid out from structure, and each control on
 * it — a widget, a bank, a layer, a cue list — reads its own node (`useLiveNode` in
 * `src/editor/controls`), as the reset count and the Layers list read theirs. It used to
 * render whole for any control's value. A control an expression drives is sampled by the
 * tab itself (`ControlValuesContext`).
 */
export const controlsShow: ShowsValues = (written, graph) => written.some((nodeId) => graph.nodes[nodeId]?.type === "panel");
