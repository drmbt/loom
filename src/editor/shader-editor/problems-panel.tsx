import { useMemo } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { Button } from "@ui/primitives/button.tsx";
import { cx } from "@ui/cx.ts";
import { formatDiagnosticLocation, partitionDiagnostics } from "./shader-diagnostics.ts";
import styles from "./problems-panel.module.css";

/**
 * §T1641b slice 2: something a problem's row can DO about it, beside saying it. One verb,
 * one command. A stored key the node does not declare has no row in the inspector to be
 * fixed from, so the Problems row that reports it is where its remedy has to be.
 */
export interface ProblemAction {
  /** The button's word: `remove`. */
  readonly label: string;
  /** What it does, in full, for the tooltip and the accessible name. */
  readonly description: string;
  readonly run: () => void;
}

export interface ProblemsPanelProps {
  /** Every diagnostic to show — shader compile messages, and later runtime ones. */
  diagnostics: readonly RuntimeDiagnostic[];
  /** Jump to a diagnostic's source position. */
  onSelect?: ((diagnostic: RuntimeDiagnostic) => void) | undefined;
  /** Copy for the "nothing wrong" state. */
  emptyHint?: string | undefined;
  /**
   * T465: empty the list. The list then REPOPULATES from the current compile, so a
   * live problem returns immediately — which is how you learn it is live — and a
   * resolved one does not. There is deliberately no acknowledged-state: nothing is
   * remembered as dismissed, nothing can be silenced while still true.
   */
  onClear?: (() => void) | undefined;
  /** §T1641b: the action a row offers, or null. Most problems have none. */
  actionFor?: ((diagnostic: RuntimeDiagnostic) => ProblemAction | null) | undefined;
}

type Tone = "error" | "warning" | "info";

const TONE_CLASS: Record<Tone, string> = {
  error: styles.errorTone ?? "",
  warning: styles.warningTone ?? "",
  info: styles.infoTone ?? "",
};

const ROW_CLASS: Record<Tone, string> = {
  error: styles.rowError ?? "",
  warning: styles.rowWarning ?? "",
  info: styles.rowInfo ?? "",
};

/**
 * The `problems` slot of the bottom dock (§V27).
 *
 * Errors and warnings are separate groups with separate headings, not one list sorted by
 * severity: a warning that scrolls in among twelve errors is a warning nobody reads, and
 * §V27 asks for them to display separately for exactly that reason.
 */
export function ProblemsPanel({ diagnostics, onSelect, emptyHint, onClear, actionFor }: ProblemsPanelProps) {
  const { errors, warnings, info } = useMemo(
    () => partitionDiagnostics(diagnostics),
    [diagnostics],
  );

  if (errors.length === 0 && warnings.length === 0 && info.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>
          <span>No problems</span>
          {/* §V91 — the state IS the whole answer here; a hint exists only when the
              next action is genuinely non-obvious, and "nothing is wrong" has none. */}
          {emptyHint === undefined ? null : <span className={styles.emptyHint}>{emptyHint}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} aria-label="Problems">
      {onClear === undefined ? null : (
        <div className={styles.toolbar}>
          <Button aria-label="Clear problems" onClick={onClear}>
            clear
          </Button>
        </div>
      )}
      <DiagnosticGroup tone="error" label="errors" items={errors} {...(onSelect ? { onSelect } : {})} {...(actionFor ? { actionFor } : {})} />
      <DiagnosticGroup tone="warning" label="warnings" items={warnings} {...(onSelect ? { onSelect } : {})} {...(actionFor ? { actionFor } : {})} />
      <DiagnosticGroup tone="info" label="info" items={info} {...(onSelect ? { onSelect } : {})} {...(actionFor ? { actionFor } : {})} />
    </div>
  );
}

interface DiagnosticGroupProps {
  tone: Tone;
  label: string;
  items: readonly RuntimeDiagnostic[];
  onSelect?: (diagnostic: RuntimeDiagnostic) => void;
  actionFor?: (diagnostic: RuntimeDiagnostic) => ProblemAction | null;
}

function DiagnosticGroup({ tone, label, items, onSelect, actionFor }: DiagnosticGroupProps) {
  if (items.length === 0) return null;
  return (
    <section className={styles.group} aria-label={label}>
      <header className={cx(styles.groupHeader, TONE_CLASS[tone])}>
        <span>{label}</span>
        <span className={styles.groupCount}>{items.length}</span>
      </header>
      {items.map((diagnostic, index) => {
        // Diagnostics have no identity of their own; position within the group is
        // stable for as long as the group is on screen.
        const key = `${diagnostic.code}:${index}`;
        const row = <DiagnosticRow key={key} tone={tone} diagnostic={diagnostic} {...(onSelect ? { onSelect } : {})} />;
        const action = actionFor?.(diagnostic) ?? null;
        if (action === null) return row;
        // A button beside the row, never inside it: the row is itself a button (V19).
        return (
          <div key={key} className={styles.entry}>
            {row}
            <Button className={styles.action} aria-label={action.description} title={action.description} onClick={action.run}>
              {action.label}
            </Button>
          </div>
        );
      })}
    </section>
  );
}

interface DiagnosticRowProps {
  tone: Tone;
  diagnostic: RuntimeDiagnostic;
  onSelect?: (diagnostic: RuntimeDiagnostic) => void;
}

/** A real `<button>`: focusable, Enter/Space activated, announced (V19). */
function DiagnosticRow({ tone, diagnostic, onSelect }: DiagnosticRowProps) {
  const location = formatDiagnosticLocation(diagnostic);
  return (
    <button
      type="button"
      className={cx(styles.row, ROW_CLASS[tone], TONE_CLASS[tone])}
      onClick={(event) => {
        // Selecting the text ends in a click, and jumping the editor mid-selection would
        // undo the thing the user was doing. If they highlighted something inside this row,
        // they were copying, not navigating.
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (
          selection !== null &&
          selection !== undefined &&
          selection.toString().length > 0 &&
          event.currentTarget.contains(selection.anchorNode)
        ) {
          return;
        }
        onSelect?.(diagnostic);
      }}
    >
      <span className={styles.marker} aria-hidden="true" />
      <span className={styles.message}>
        {diagnostic.message}
        <span className={styles.code}>{diagnostic.code}</span>
        {diagnostic.suggestion === undefined ? null : (
          <span className={styles.suggestion}>{diagnostic.suggestion}</span>
        )}
      </span>
      <span className={styles.location}>{location ?? ""}</span>
    </button>
  );
}
