import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from "react";

/**
 * T1518b — A POPOVER OPENED FROM A NODE KEEPS ITS OWN PRESSES AND KEYS.
 *
 * A popover is portalled out of the node in the DOM but NOT in React: its events still
 * bubble through the React tree to the node and the graph pane. Measured in the browser,
 * on both popovers a Panel node's header opens (the pencil's editor, the phone door): a
 * press on a button inside reached the pane's `onPointerDown` (`keymap/pane.ts`), which
 * takes focus, which Radix reads as focus leaving the popover — it closed between
 * pointerdown and click, and the click never landed. "Stop publishing" did nothing;
 * "Remove from panel" did nothing. The same path hands an arrow key meant for a control in
 * the popover to React Flow's node nudge, and a double click to the header's rename.
 *
 * Spread these on the popover's content. KEYS are stopped selectively — only the ones
 * React Flow's node wrapper acts on (arrows nudge the node, Enter and Space select it).
 * Every other key keeps bubbling: stopping it here stops the native event too, and with it
 * the keymap's window listener — undo, in the middle of arranging a board.
 */
const stop = (event: SyntheticEvent): void => event.stopPropagation();

const stopNodeKeys = (event: ReactKeyboardEvent): void => {
  if (event.key.startsWith("Arrow") || event.key === "Enter" || event.key === " ") event.stopPropagation();
};

export const popoverEventStops = {
  onPointerDown: stop,
  onMouseDown: stop,
  onClick: stop,
  onDoubleClick: stop,
  onKeyDown: stopNodeKeys,
} as const;
