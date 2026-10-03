import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { CUE_LIST_NODE_TYPE, PRESETS_NODE_TYPE, isPresetsNode, parsePresetTargets } from "@domain/presets/index.ts";
import type { CanvasBox } from "./panel-join.ts";

/**
 * T1531b — HOW A NODE BECOMES ONE OF A PRESETS BANK'S TARGETS, by gesture.
 *
 * Owner, 2026-10-03: two ways, and both write the same thing — the node's NAME appended to
 * the bank's `targets` text, as one `setParameters`, one undo step:
 *
 *  1. dropping the node ON the bank on the canvas (the Panel drop's gesture, `panel-join.ts`),
 *     riding in the move's patch;
 *  2. "Add N selected as targets" in the bank's inspector section, for the nodes selected
 *     alongside it.
 *
 * Nothing is written when there is nothing to add — a node already a target is not an
 * empty undo step. A bank, a Panel and a cue list are never targets: their parameters are
 * the bank's own kind of state (presets, a board, cues), and a recall rewriting them is a
 * bank recalling a bank — not something either gesture should do by accident.
 */

type Graph = Pick<GraphDocument, "nodes">;

/** The node kinds a bank never takes as a target. */
const NEVER_TARGETS: ReadonlySet<string> = new Set([PRESETS_NODE_TYPE, CUE_LIST_NODE_TYPE, "panel"]);

/**
 * The name a node is targeted BY, or null when it cannot be one. Targets resolve by name
 * (`nodeByName`, labels only), so a legacy node with no label has no name to write.
 */
function targetName(node: GraphNode): string | null {
  if (NEVER_TARGETS.has(node.type)) return null;
  return node.label ?? null;
}

/** The whole-node names `targets` already lists (`node.key` entries name one parameter, not the node). */
function listedNames(targets: unknown): Set<string> {
  return new Set(parsePresetTargets(targets).filter((target) => target.key === undefined).map((target) => target.node));
}

/**
 * Of `nodeIds`, the names this bank would GAIN as targets, in the order given: each one a
 * node that exists, is not the bank, can be a target and is not listed yet.
 */
export function bankTargetsToAdd(graph: Graph, bankId: NodeId, nodeIds: readonly NodeId[]): string[] {
  const bank = graph.nodes[bankId];
  // A Presets node's Targets: a look's instance bank keeps its Targets in its component (T1505b).
  if (bank === undefined || !isPresetsNode(bank)) return [];
  const listed = listedNames(bank.parameters["targets"]);
  const names: string[] = [];
  for (const nodeId of nodeIds) {
    const node = nodeId === bankId ? undefined : graph.nodes[nodeId];
    const name = node === undefined ? null : targetName(node);
    if (name === null || listed.has(name)) continue;
    listed.add(name);
    names.push(name);
  }
  return names;
}

/** `targets` with `names` appended, space-separated — the target picker's spelling. */
export function targetsWith(targets: string, names: readonly string[]): string {
  return [targets.trim(), ...names].filter((part) => part !== "").join(" ");
}

/** What adding these nodes to the bank's targets writes: one `setParameters`, or nothing. */
export function addBankTargetsOperations(graph: Graph, bankId: NodeId, nodeIds: readonly NodeId[]): GraphPatchOperation[] {
  const names = bankTargetsToAdd(graph, bankId, nodeIds);
  if (names.length === 0) return [];
  const stored = graph.nodes[bankId]?.parameters["targets"];
  return [{ op: "setParameters", nodeId: bankId, parameters: { targets: targetsWith(typeof stored === "string" ? stored : "", names) } }];
}

/**
 * The bank a node was dropped ON: the one whose box holds the node's centre — graph space,
 * the topmost-drawn (last in document order) when two overlap, exactly `panelUnderDrop`'s
 * rule. A node that can never be a target finds no bank, and a bank never finds itself.
 */
export function bankUnderDrop(
  graph: Graph,
  nodeId: NodeId,
  centre: { readonly x: number; readonly y: number },
  boxOf: (nodeId: NodeId) => CanvasBox | null,
): NodeId | null {
  const dropped = graph.nodes[nodeId];
  if (dropped === undefined || NEVER_TARGETS.has(dropped.type)) return null;
  let hit: NodeId | null = null;
  for (const node of Object.values(graph.nodes)) {
    if (!isPresetsNode(node) || node.id === nodeId) continue;
    const box = boxOf(node.id);
    if (box === null) continue;
    if (centre.x >= box.x && centre.x <= box.x + box.width && centre.y >= box.y && centre.y <= box.y + box.height) hit = node.id;
  }
  return hit;
}

/**
 * When a drop lands on BOTH a Panel and a bank (they overlap on the canvas), the one drawn
 * on top takes it — the later in document order, the rule each of them already uses among
 * its own kind. Either alone wins by default.
 */
export function topmostDropTarget(graph: Graph, panelId: NodeId | null, bankId: NodeId | null): NodeId | null {
  if (panelId === null || bankId === null) return panelId ?? bankId;
  const order = Object.keys(graph.nodes);
  return order.indexOf(bankId) > order.indexOf(panelId) ? bankId : panelId;
}
