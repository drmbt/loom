import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { LAYER_NODE_TYPE, controlNameOf } from "@nodes/definitions/controls.ts";

/**
 * T1506b — THE LAYER STACKS A DOCUMENT HOLDS, derived from its wiring (the design doc §7.5:
 * "a Layers view listing the stack, derived by walking `below`"). Nothing here is stored:
 * the stack IS the graph, so a rewire is a new stack and there is no second copy to drift.
 *
 * The rule:
 *
 * - A layer sits ON the layer wired into its `below` input. Only a layer-to-layer wire
 *   counts: an FX node between two layers ends one stack and starts the next.
 * - A TOP is a layer no other layer stands on. Each top is one stack, walked down through
 *   `below` to its bottom. Two layers standing on one layer make two stacks that share it,
 *   so the shared layer is listed under both — each list is what that output shows.
 * - A layer wired to nothing is a stack of one.
 * - A stack is titled by WHERE ITS PICTURE ENDS UP: from the top layer, follow its first
 *   outgoing wire (document order), and that node's first, until a node feeds nothing —
 *   usually a Window Out. A top that feeds nothing is "Not connected".
 * - The walk never loops: a document can hold a loop of layers (a raw patch, a file —
 *   the compiler refuses it, the view must still draw), which has no top. Every layer not
 *   yet listed starts a stack of its own, in document order, and a walk stops at a layer
 *   it has already passed. So every layer is listed, and every walk ends.
 *
 * Stacks come in document order of their top layer; each lists its layers TOP FIRST, as an
 * image editor's layer list does.
 */
export interface LayerStack {
  /** The node the stack's picture ends up in; `null` when the top layer feeds nothing. */
  readonly output: NodeId | null;
  /** The output's name, or {@link NOT_CONNECTED}. */
  readonly title: string;
  /** Top first, bottom last. */
  readonly layers: readonly NodeId[];
}

/** The title of a stack whose top layer feeds nothing. */
export const NOT_CONNECTED = "Not connected";

/** The input a layer stands on (`layer.ts`: first, so bypass passes it through). */
const BELOW_PORT = "below";

export function layerStacks(graph: Pick<GraphDocument, "nodes" | "edges">): LayerStack[] {
  const layers = Object.values(graph.nodes).filter((node) => node.type === LAYER_NODE_TYPE);
  if (layers.length === 0) return [];
  const isLayer = (id: NodeId): boolean => graph.nodes[id]?.type === LAYER_NODE_TYPE;

  /** layer → the layer it stands on. */
  const below = new Map<NodeId, NodeId>();
  /** node → the nodes it feeds, in edge order. */
  const feeds = new Map<NodeId, NodeId[]>();
  for (const edge of Object.values(graph.edges)) {
    const from = edge.source.nodeId;
    const to = edge.target.nodeId;
    if (graph.nodes[from] === undefined || graph.nodes[to] === undefined) continue;
    const list = feeds.get(from);
    if (list === undefined) feeds.set(from, [to]);
    else list.push(to);
    if (edge.target.portId === BELOW_PORT && isLayer(to) && isLayer(from)) below.set(to, from);
  }
  const stoodOn = new Set(below.values());

  const listed = new Set<NodeId>();
  const outputOf = (top: NodeId): NodeId | null => {
    const passed = new Set<NodeId>([top]);
    let at = top;
    for (;;) {
      const next = (feeds.get(at) ?? []).find((id) => !passed.has(id));
      if (next === undefined) break;
      passed.add(next);
      at = next;
    }
    return at === top ? null : at;
  };
  const stackFrom = (top: NodeId): LayerStack => {
    const chain: NodeId[] = [];
    const passed = new Set<NodeId>();
    for (let at: NodeId | undefined = top; at !== undefined && !passed.has(at); at = below.get(at)) {
      passed.add(at);
      chain.push(at);
      listed.add(at);
    }
    const output = outputOf(top);
    const node = output === null ? undefined : graph.nodes[output];
    return { output, title: node === undefined ? NOT_CONNECTED : controlNameOf(node), layers: chain };
  };

  const stacks: LayerStack[] = [];
  for (const layer of layers) if (!stoodOn.has(layer.id)) stacks.push(stackFrom(layer.id));
  // A loop of layers has no top: start what is left at its first layer in document order.
  for (const layer of layers) if (!listed.has(layer.id)) stacks.push(stackFrom(layer.id));
  return stacks;
}

