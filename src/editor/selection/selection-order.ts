import type { NodeId } from "@domain/types/ids.ts";

/**
 * T1531b — THE SELECTION KEEPS THE ORDER IT WAS MADE IN, AND ITS LAST ENTRY IS THE PRIMARY.
 *
 * Owner, 2026-10-03: the inspector shows the LAST-CLICKED node of a multi-selection, as
 * Figma, TouchDesigner and Blender do — not whichever selected node happens to come first
 * in the canvas's own order. React Flow reports a selection in ITS node order (a render
 * detail), so the canvas re-orders every report through `orderSelection` before it leaves,
 * and every reader of the selection gets the order it was made in:
 *
 *  - **A node joining alone becomes the primary**: a click, a modifier-click, a keyboard
 *    select, a marquee step that reaches one more node. It is appended.
 *  - **Several joining in one report leave the primary where it is** (select all, a marquee
 *    step that crosses two nodes at once): they go in just before it, in canvas order. With
 *    no primary still selected — a marquee (React Flow clears the selection when one
 *    starts), a paste or duplicate selecting what it made — they are appended in canvas
 *    order, so the primary is the last of them on the canvas.
 *  - **A node leaving drops out**; when it was the primary, the most recently added node
 *    still selected becomes it — which is simply the new last entry.
 *  - **A click on a node already selected promotes it** (`promoteInSelection`): React Flow
 *    keeps the whole selection on such a click (so the group can be dragged), and without
 *    this there would be no way to make one member of a marquee the primary.
 *
 * A report naming the same set as before returns the previous array UNCHANGED: React Flow
 * re-fires its selection effect whenever the handler's identity changes, in canvas order,
 * and that must not undo a promotion.
 */
export function orderSelection(previous: readonly NodeId[], reported: readonly NodeId[]): readonly NodeId[] {
  const now = new Set(reported);
  const before = new Set(previous);
  const kept = previous.filter((id) => now.has(id));
  const added = [...new Set(reported)].filter((id) => !before.has(id));
  if (added.length === 0) return kept.length === previous.length ? previous : kept;
  const primary = previous.at(-1);
  if (added.length > 1 && primary !== undefined && now.has(primary)) {
    // `primary` was `previous`'s last entry and is still selected, so it is `kept`'s last.
    return [...kept.slice(0, -1), ...added, primary];
  }
  return [...kept, ...added];
}

/** The clicked node made the primary, when it is already selected; otherwise the selection as it was. */
export function promoteInSelection(selection: readonly NodeId[], clicked: NodeId): readonly NodeId[] {
  if (!selection.includes(clicked) || selection.at(-1) === clicked) return selection;
  return [...selection.filter((id) => id !== clicked), clicked];
}

/** The node a multi-selection is ABOUT — the one the inspector shows: the last entry. */
export function primaryOf(selection: readonly NodeId[]): NodeId | null {
  return selection.at(-1) ?? null;
}
