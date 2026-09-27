import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { ParameterDefinition } from "@domain/types/parameters.ts";

/**
 * What a §T1390b channel picker may offer: the channels arriving on the value input its
 * parameter declares in `channelsFrom`, for every such row of `node`.
 *
 * The picker's other half, as `referenceParameters` is `ReferenceField`'s: the control
 * knows how a channel list reads, this knows the document. A channel ARRIVES when a wire
 * into that input comes from a node that publishes it — so the answer is each wired
 * source's current bag, in wire order then publication order, without repeats. A wire
 * that carries one channel (a §T1350b document) offers that channel only, because that is
 * all it delivers.
 *
 * `channelsOf` is the same live-or-structural name lookup expression completion uses
 * (`use-value-graph.ts`), keyed by LABEL (§B170). An unlabelled source cannot be looked
 * up and offers nothing; so does a host with no value graph. The picker then says nothing
 * is arriving rather than inventing a list.
 */
export function channelPickAvailable(
  graph: GraphDocument,
  node: GraphNode,
  entries: readonly { readonly key: string; readonly definition: ParameterDefinition }[],
  channelsOf: ((nodeName: string) => readonly string[]) | undefined,
): ReadonlyMap<string, readonly string[]> {
  const rows = new Map<string, readonly string[]>();
  for (const { key, definition } of entries) {
    if (definition.type !== "string" || definition.channelsFrom === undefined) continue;
    const seen = new Set<string>();
    for (const edge of Object.values(graph.edges)) {
      if (edge.target.nodeId !== node.id || edge.target.portId !== definition.channelsFrom) continue;
      const label = graph.nodes[edge.source.nodeId]?.label;
      if (label === undefined || label === "" || channelsOf === undefined) continue;
      const published = channelsOf(label);
      for (const name of edge.channel === undefined ? published : published.filter((entry) => entry === edge.channel)) {
        seen.add(name);
      }
    }
    rows.set(key, [...seen]);
  }
  return rows;
}
