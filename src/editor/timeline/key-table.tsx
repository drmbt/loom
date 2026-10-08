import { useState } from "react";
import { HANDLE_TYPES, INTERPOLATIONS, denormalizeValue, normalizeValue, type AutomationDocument, type HandleType, type Interpolation } from "@domain/automation/model.ts";
import { framesToTicks, ticksToFrames, type FrameRate } from "@domain/time/ticks.ts";
import { setHandleType, setInterpolation, setKey, type KeyRef } from "./timeline-edits.ts";
import styles from "./timeline-pane.module.css";

/**
 * VN62 — THE TABLE VIEW (Houdini's): the selected keys as rows, for exact entry. Frame,
 * value in the lane's OUTPUT units (what a parameter will read), interpolation and handle
 * type. Each committed cell is one edit, one undo step, through the pane's write.
 */
export interface KeyTableProps {
  readonly document: AutomationDocument;
  readonly selection: readonly KeyRef[];
  readonly rate: FrameRate;
  readonly editable: boolean;
  readonly onChange: (next: AutomationDocument) => void;
}

function NumberCell({ value, label, disabled, onCommit }: { value: number; label: string; disabled: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (Number.isFinite(parsed)) onCommit(parsed);
  };
  return (
    <input
      className={styles.cell}
      aria-label={label}
      disabled={disabled}
      value={draft ?? String(Number(value.toFixed(6)))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        // A field's keys are the field's: Delete here edits text, never keys or nodes.
        event.stopPropagation();
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}

export function KeyTable({ document, selection, rate, editable, onChange }: KeyTableProps) {
  const rows = document.lanes.flatMap((lane) =>
    lane.keys.filter((key) => selection.some((ref) => ref.lane === lane.id && ref.key === key.id)).map((key) => ({ lane, key })),
  );
  if (rows.length === 0) return <div className={styles.tableEmpty}>no keys selected</div>;
  return (
    <table className={styles.table} data-key-table="">
      <thead>
        <tr>
          <th>lane</th>
          <th>frame</th>
          <th>value</th>
          <th>interp</th>
          <th>handle</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ lane, key }) => {
          const ref = { lane: lane.id, key: key.id };
          const disabled = !editable || lane.lock;
          return (
            <tr key={`${lane.id} ${key.id}`}>
              <td>{lane.name}</td>
              <td>
                <NumberCell value={ticksToFrames(key.t, rate)} label={`${lane.name} ${key.id} frame`} disabled={disabled} onCommit={(frame) => onChange(setKey(document, ref, { t: framesToTicks(Math.round(frame), rate) }))} />
              </td>
              <td>
                <NumberCell value={denormalizeValue(lane, key.v)} label={`${lane.name} ${key.id} value`} disabled={disabled} onCommit={(value) => onChange(setKey(document, ref, { v: normalizeValue(lane, value) }))} />
              </td>
              <td>
                <select className={styles.cell} aria-label={`${lane.name} ${key.id} interpolation`} value={key.interp} disabled={disabled} onChange={(event) => onChange(setInterpolation(document, [ref], event.target.value as Interpolation))}>
                  {INTERPOLATIONS.map((interp) => (
                    <option key={interp} value={interp}>{interp}</option>
                  ))}
                </select>
              </td>
              <td>
                <select className={styles.cell} aria-label={`${lane.name} ${key.id} handle`} value={key.handle} disabled={disabled} onChange={(event) => onChange(setHandleType(document, [ref], event.target.value as HandleType))}>
                  {HANDLE_TYPES.map((handle) => (
                    <option key={handle} value={handle}>{handle}</option>
                  ))}
                </select>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
