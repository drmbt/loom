import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { controlDefaultState, panelMembers } from "@nodes/definitions/controls.ts";

/**
 * T1619b S2 — what the desk says about a Panel's defaults, pure: how many of its controls are
 * away from theirs (the header's ↺ and its sentence) and which Panel a control's "all on this
 * Panel" means. The marks on the controls themselves, and the commands, read
 * `controlDefaultState` directly; this is the same answer, counted.
 */

type Graph = Pick<GraphDocument, "nodes" | "edges">;

export interface DefaultTally {
  /** Sliders, Toggles and XY Pads among the controls counted. */
  readonly total: number;
  /** Those with a value away from its default: what a reset would move. */
  readonly away: number;
  /** Those that hold no default: neither at one nor away, and not reset. */
  readonly missing: number;
}

/** Counted over the controls a surface shows: a Panel's members, or with no Panel every control. A Button counts for nothing. */
export function tallyDefaults(controls: readonly GraphNode[]): DefaultTally {
  let total = 0;
  let away = 0;
  let missing = 0;
  for (const node of controls) {
    const state = controlDefaultState(node);
    if (state === null) continue;
    total += 1;
    if (state.away.length > 0) away += 1;
    if (state.missing.length > 0) missing += 1;
  }
  return { total, away, missing };
}

const counted = (count: number): string => (count === 1 ? "1 control" : `${String(count)} controls`);

/** What the header's popover says before its one button: what a reset of this surface would move. */
export function resetAllSentence(title: string, tally: DefaultTally): string {
  if (tally.total === 0) return `${title} has no control that holds a default.`;
  const without = tally.missing === 0 ? "" : ` ${counted(tally.missing)} ${tally.missing === 1 ? "has" : "have"} no default yet.`;
  if (tally.away === 0) return `${title}: every control is at its default.${without}`;
  const verb = tally.away === 1 ? "is away from its default" : "are away from their defaults";
  return `${title}: ${String(tally.away)} of ${counted(tally.total)} ${verb}.${without}`;
}

/**
 * WHICH PANEL "all on this Panel" means for a right-clicked control: the Panel whose board it
 * was clicked on; else, for a control clicked on its own node, the one Panel it is on. On no
 * Panel, or on several with none in hand, there is no one answer and it is null — the menu
 * then offers the whole document instead.
 */
export function controlPanelOf(graph: Graph, target: { readonly nodeId?: NodeId | undefined; readonly panelId?: NodeId | undefined }): GraphNode | null {
  const named = target.panelId === undefined ? undefined : graph.nodes[target.panelId];
  if (named !== undefined && named.type === "panel") return named;
  if (target.nodeId === undefined) return null;
  const holding = Object.values(graph.nodes).filter((node) => node.type === "panel" && panelMembers(graph, node).some((member) => member.id === target.nodeId));
  return holding.length === 1 ? (holding[0] as GraphNode) : null;
}
