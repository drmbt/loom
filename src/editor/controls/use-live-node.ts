import { useCallback, useSyncExternalStore } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";

/**
 * T1668b — WHO READS A CONTROL'S VALUE ON A SURFACE: the item that draws it, and only it.
 *
 * A board is a list. The Controls tab and a Panel node's body used to render the whole of
 * it from the document for every value written to any control on it: the board re-derived
 * (its stored layout parsed, its members looked up), every item's fit measured, every bank's
 * presets parsed — about a millisecond of each write on a project of 150 board items, to
 * arrive at one widget that had changed.
 *
 * The rule, in one place: A SURFACE IS LAID OUT FROM THE DOCUMENT'S STRUCTURE — which
 * controls, where, under what names — AND EACH ITEM READS ITS OWN NODE. `useLiveNode` is
 * that read. The store hands an untouched node the same object across revisions, so the
 * snapshot is the node itself: an item renders when ITS node is another object, which is
 * when one of its values (or anything else of it) moved.
 *
 * The surface hands in the node it laid the item out from. That one may be older than the
 * store's (a surface fed structure does not render for a value), which is the point; and it
 * is what the item shows for the moment between a node leaving the document and the surface
 * rendering without it.
 *
 * `value-write-boundaries.test.tsx` holds it by counts, for every kind of control a board
 * can hold: a value written renders that control's items and no other item of any surface.
 */
export function useLiveNode(bus: LoomBus, laidOut: GraphNode): GraphNode {
  const read = useCallback((): GraphNode => bus.store.getGraph().nodes[laidOut.id] ?? laidOut, [bus, laidOut]);
  return useSyncExternalStore(bus.store.subscribe, read, read);
}

/**
 * The whole document, at every revision: for a surface that IS a view across many nodes'
 * values and is on screen only while someone works in it (the Layers list, a board being
 * arranged). Not for a surface that is played: that one is laid out from structure and its
 * items use `useLiveNode`.
 */
export function useLiveDocument(bus: LoomBus): GraphDocument {
  return useSyncExternalStore(bus.store.subscribe, bus.store.getGraph, bus.store.getGraph);
}
