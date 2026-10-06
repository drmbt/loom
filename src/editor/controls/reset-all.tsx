import { useMemo, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import { CONTROL_RESET_ALL_COMMAND, CONTROL_RESET_COMMAND } from "@domain/commands/control-default-commands.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import { panelTitle } from "@nodes/definitions/controls.ts";
import { Button, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger, cx } from "@ui/index.ts";
import { resetAllSentence, tallyDefaults } from "./control-defaults.ts";
import { popoverEventStops } from "./popover-events.ts";
import styles from "./reset-all.module.css";

/**
 * T1619b S2 — RESET ALL, on the desk: a ↺ in the Controls tab's header that says how many
 * of the shown Panel's controls are away from their defaults, and a popover with that
 * sentence and ONE button.
 *
 * Two presses in two places, never one: the design's rule is that nothing resets from one
 * press, and a reset in the middle of a show is seen by the room before an undo can take it
 * back. There is no further question after the button: it is one command, one patch and one
 * undo group, so ⌘Z puts every value back together.
 *
 * It names the Panel by its id, which the command reads as the controls on it
 * (`control.reset`). With no Panel the tab lists every control in the document, and the
 * button is the whole document (`control.resetAll`).
 */

/** A counter-clockwise arrow back to a mark: "return to where it was set". */
function ResetIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.2 5.2A5.5 5.5 0 1 1 2.5 8" />
      <path d="M2.6 2.2v3.2h3.2" />
    </svg>
  );
}

export interface ResetAllButtonProps {
  /** The controls the tab shows: the Panel's members, or with no Panel every control. */
  readonly controls: readonly GraphNode[];
  /** The Panel the tab shows; absent when it lists every control ("All controls"). */
  readonly panel: GraphNode | undefined;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** Arranging the board, or learning MIDI: playing gestures are off, and so is this. */
  readonly disabled?: boolean;
}

export function ResetAllButton({ controls, panel, bus, invocation, disabled = false }: ResetAllButtonProps) {
  const [shown, setShown] = useState(false);
  const tally = useMemo(() => tallyDefaults(controls), [controls]);
  const title = panel === undefined ? "All controls" : panelTitle(panel);
  const sentence = resetAllSentence(title, tally);
  const reset = (): void => {
    setShown(false);
    void (panel === undefined
      ? bus.execute(CONTROL_RESET_ALL_COMMAND, {}, invocation)
      : bus.execute(CONTROL_RESET_COMMAND, { nodeIds: [panel.id] }, invocation));
  };
  return (
    <PopoverRoot open={shown} onOpenChange={setShown}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cx(styles.trigger, tally.away > 0 && styles.away)}
          aria-label={tally.away > 0 ? `Reset controls · ${String(tally.away)} away from default` : "Reset controls"}
          title={sentence}
          disabled={disabled}
          data-reset-all={tally.away}
        >
          <ResetIcon />
          {tally.away > 0 ? <span className={styles.count}>{tally.away}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className={styles.popover} aria-label="Reset controls" {...popoverEventStops}>
        <PopoverHeader>Reset to defaults</PopoverHeader>
        <p className={styles.sentence} data-reset-sentence>{sentence}</p>
        <Button variant="outline" onClick={reset} disabled={tally.away === 0} data-reset-confirm>
          {tally.away === 0 ? "Nothing to reset" : `Reset ${String(tally.away)}`}
        </Button>
      </PopoverContent>
    </PopoverRoot>
  );
}
