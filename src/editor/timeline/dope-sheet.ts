import type { AutomationDocument } from "@domain/automation/model.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { moveKeys, type KeyRef } from "./timeline-edits.ts";
import type { AutomationNodeView } from "./timeline-model.ts";
import { tickToX, type TimelineView } from "./timeline-view.ts";

/**
 * VN62 — THE DOPE SHEET: keys as diamonds on rows, for retiming cues across lanes at once.
 *
 * Row 0 is the SUMMARY: every key of every automation node. Below it, one row per node:
 * that node's lanes together. A diamond is a COLUMN, a tick at which at least one key in
 * the row's scope sits. Dragging a column moves every key on that tick in scope by the
 * same distance: a cue moves as one, across lanes and across nodes. Pure.
 */

export interface DopeRow {
  readonly id: string;
  readonly label: string;
  /** The nodes whose keys this row shows. */
  readonly nodes: readonly NodeId[];
  /** Distinct ticks holding a key in scope, ascending. */
  readonly columns: readonly number[];
}

export const DOPE_ROW_HEIGHT = 14;

function columnsOf(documents: readonly AutomationDocument[]): number[] {
  const ticks = new Set<number>();
  for (const document of documents) for (const lane of document.lanes) for (const key of lane.keys) ticks.add(key.t);
  return [...ticks].sort((a, b) => a - b);
}

export function dopeRows(nodes: readonly AutomationNodeView[]): DopeRow[] {
  const valid = nodes.filter((node) => node.document !== null);
  return [
    { id: "summary", label: "summary", nodes: valid.map((node) => node.id), columns: columnsOf(valid.map((node) => node.document!)) },
    ...valid.map((node) => ({ id: node.id, label: node.name ?? node.id, nodes: [node.id], columns: columnsOf([node.document!]) })),
  ];
}

/** The column under (x, y) in the strip, within `radius` px of its diamond. */
export function dopeHit(view: TimelineView, rows: readonly DopeRow[], x: number, y: number, radius = 5): { row: DopeRow; tick: number } | null {
  const row = rows[Math.floor(y / DOPE_ROW_HEIGHT)];
  if (row === undefined) return null;
  let best: number | null = null;
  let distance = radius;
  for (const tick of row.columns) {
    const d = Math.abs(tickToX(view, tick) - x);
    if (d <= distance) {
      best = tick;
      distance = d;
    }
  }
  return best === null ? null : { row, tick: best };
}

/** The keys on the given ticks in one document (unlocked lanes only). */
export function refsAtTicks(document: AutomationDocument, ticks: ReadonlySet<number>): KeyRef[] {
  const refs: KeyRef[] = [];
  for (const lane of document.lanes) {
    if (lane.lock) continue;
    for (const key of lane.keys) if (ticks.has(key.t)) refs.push({ lane: lane.id, key: key.id });
  }
  return refs;
}

/**
 * Move the given columns by `dt` in every document in scope, by ONE distance: each
 * document clamps its own move against its unselected neighbours, and the smallest
 * clamped move wins, so the cue stays together rather than tearing across lanes.
 * Returns only the documents that change.
 */
export function retimeColumns(
  documents: ReadonlyMap<NodeId, AutomationDocument>,
  ticks: ReadonlySet<number>,
  dt: number,
): { documents: Map<NodeId, AutomationDocument>; dt: number } {
  let applied = Math.round(dt);
  for (const document of documents.values()) {
    const refs = refsAtTicks(document, ticks);
    if (refs.length === 0) continue;
    const clamped = moveKeys(document, refs, applied, 0).dt;
    if (Math.abs(clamped) < Math.abs(applied)) applied = clamped;
  }
  const changed = new Map<NodeId, AutomationDocument>();
  if (applied === 0) return { documents: changed, dt: 0 };
  for (const [nodeId, document] of documents) {
    const refs = refsAtTicks(document, ticks);
    if (refs.length === 0) continue;
    changed.set(nodeId, moveKeys(document, refs, applied, 0).document);
  }
  return { documents: changed, dt: applied };
}
