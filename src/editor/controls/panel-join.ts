import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { incomingEdgesInOrder } from "@domain/graph/edge-order.ts";
import { CONTROL_WIDGET_TYPES, PANEL_INPUT } from "@nodes/definitions/controls.ts";

/**
 * T1512b — HOW A WIDGET JOINS A PANEL, as patch operations.
 *
 * Membership is wiring (`panelLayout`, `controls.ts`), so every gesture that changes it is
 * an edge edit through the bus: dropping a widget node on a Panel and the widget's own "add
 * to panel" button both come here, and the answer is one patch — undoable as one step — or
 * nothing at all. Where a member SITS is the Panel's board (T1516b, `panel-board-edit.ts`),
 * which replaced the Controls tab's move-earlier/later buttons.
 */

type Graph = Pick<GraphDocument, "nodes" | "edges">;

/** The widget's `out` wired into the Panel's Controls, or nothing when it already is. */
export function joinPanelOperations(graph: Graph, widgetId: NodeId, panelId: NodeId): GraphPatchOperation[] {
  const widget = graph.nodes[widgetId];
  const panel = graph.nodes[panelId];
  if (widget === undefined || panel === undefined) return [];
  if (!CONTROL_WIDGET_TYPES.has(widget.type) || panel.type !== "panel") return [];
  if (incomingEdgesInOrder(graph, panelId, PANEL_INPUT).some((edge) => edge.source.nodeId === widgetId)) return [];
  return [{ op: "connect", source: { nodeId: widgetId, portId: "out" }, target: { nodeId: panelId, portId: PANEL_INPUT } }];
}

/** A node's box on the canvas, in graph space. */
export interface CanvasBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The Panel a widget was dropped ON: the one whose box holds the widget's centre. Graph
 * space both sides, so it means the same thing at every zoom (§V142, as T213's splice).
 * The topmost-drawn Panel wins when two overlap — the last in document order, which is
 * the one React Flow paints last.
 */
export function panelUnderDrop(
  graph: Graph,
  widgetId: NodeId,
  centre: { readonly x: number; readonly y: number },
  boxOf: (nodeId: NodeId) => CanvasBox | null,
): NodeId | null {
  if (!CONTROL_WIDGET_TYPES.has(graph.nodes[widgetId]?.type ?? "")) return null;
  let hit: NodeId | null = null;
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "panel") continue;
    const box = boxOf(node.id);
    if (box === null) continue;
    if (centre.x >= box.x && centre.x <= box.x + box.width && centre.y >= box.y && centre.y <= box.y + box.height) hit = node.id;
  }
  return hit;
}

/**
 * The document's only Panel, when the widget is not on it yet — what the widget's own
 * "add to panel" button offers. With two Panels there is no one answer, so it offers none.
 */
export function soloPanelFor(graph: Graph, widgetId: NodeId): NodeId | null {
  let only: GraphNode | null = null;
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "panel") continue;
    if (only !== null) return null;
    only = node;
  }
  if (only === null) return null;
  return joinPanelOperations(graph, widgetId, only.id).length === 0 ? null : only.id;
}
