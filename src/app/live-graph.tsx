import type { ReactNode } from "react";
import type { GraphStoreView } from "@domain/graph/store.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { useLiveGraph, type ShowsValues } from "./use-live-graph.ts";

export interface LiveGraphProps {
  readonly store: GraphStoreView;
  readonly registry: NodeRegistryView;
  /** Which written nodes this surface draws a value of. Absent: every one (the canvas). */
  readonly shows?: ShowsValues | undefined;
  readonly children: (graph: GraphDocument) => ReactNode;
}

/** `useLiveGraph` (T1652b) as an element, for a pane mounted from the composition root. */
export function LiveGraph({ store, registry, shows, children }: LiveGraphProps) {
  return <>{children(useLiveGraph(store, registry, shows))}</>;
}

