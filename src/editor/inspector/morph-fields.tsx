import { useState } from "react";
import { MORPH_CURVES, type MorphCurve } from "@domain/presets/index.ts";
import { EnumField, type EnumOption } from "@ui/controls/enum-field.tsx";
import rows from "./preset-sections.module.css";

/**
 * A MORPH, AS A ROW EDITS IT: its seconds and its curve. Shared by the cue table (a cue's
 * own morph, T1501b) and the bank section (a preset's own morph, T1527b), which differ
 * only in what a blank time falls back to — the placeholder says which.
 */

const CURVE_OPTIONS: readonly EnumOption[] = [
  { value: "linear", label: "Linear" },
  { value: "smooth", label: "Smooth" },
  { value: "in", label: "Ease in" },
  { value: "out", label: "Ease out" },
];

/**
 * A morph time: blank means the row carries none (the next rung of the morph ladder,
 * the design doc §5.1, applies — `placeholder` names it). A draft, committed on Enter or
 * when the field is left — one patch, not one per key. Mount it under a key of the stored
 * value, so an undo or an agent's edit replaces the draft.
 */
export function MorphSeconds({
  label,
  stored,
  placeholder,
  onCommit,
}: {
  readonly label: string;
  readonly stored: string;
  readonly placeholder: string;
  readonly onCommit: (seconds: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(stored);
  const commit = (): void => {
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (trimmed === stored) return;
    if (trimmed === "") onCommit(undefined);
    else if (Number.isFinite(parsed) && parsed >= 0) onCommit(parsed);
    else setDraft(stored);
  };
  return (
    <input
      className={rows.number}
      type="number"
      min={0}
      step="0.1"
      placeholder={placeholder}
      value={draft}
      aria-label={label}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit();
      }}
    />
  );
}

/** A morph's curve; disabled while the row carries no morph of its own, since there is nothing to curve. */
export function MorphCurveField({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: MorphCurve;
  readonly disabled: boolean;
  readonly onChange: (curve: MorphCurve) => void;
}) {
  return (
    <EnumField
      label={label}
      value={value}
      options={CURVE_OPTIONS}
      disabled={disabled}
      onChange={(curve) => {
        if (MORPH_CURVES.includes(curve as MorphCurve)) onChange(curve as MorphCurve);
      }}
    />
  );
}
