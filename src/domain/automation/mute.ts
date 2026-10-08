import { evaluateNormalized, resolveLane } from "./evaluate.ts";
import { parseAutomation, serializeAutomation } from "./model.ts";

/**
 * VN61 — MUTING A LANE HOLDS THE VALUE IT HAD WHEN IT WAS MUTED (Vincent, 2026-10-07).
 *
 * The held value is written INTO the lanes text (`mute: true` + `mutedValue`), never kept
 * as runtime state: the node stays a pure function of the frame and its parameters, a
 * render reproduces it, and VN62's mute toggle applies the returned text as one
 * `setParameters`, so one undo restores the lane and its held value together. Unmuting
 * clears `mutedValue` and the lane follows its curve again.
 *
 * Its own module rather than `model.ts` because it evaluates the curve, and `evaluate.ts`
 * imports the model.
 */
export function setLaneMute(
  text: unknown,
  laneId: string,
  muted: boolean,
  /** The tick to hold the value of, normally the playhead. Read only when muting. */
  atTicks: number,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const parsed = parseAutomation(text);
  if (!parsed.ok) return parsed;
  const lane = parsed.document.lanes.find((each) => each.id === laneId);
  if (lane === undefined) return { ok: false, reason: `No lane with the id "${laneId}".` };
  if (muted && !Number.isFinite(atTicks)) return { ok: false, reason: `Cannot mute at ${atTicks} ticks: the time must be finite.` };
  const lanes = parsed.document.lanes.map((each) => {
    if (each.id !== laneId) return each;
    const { mutedValue: _previous, ...rest } = each;
    if (!muted) return { ...rest, mute: false };
    // Read with the lane UNMUTED: re-muting a muted lane holds the curve's value there, not the old hold.
    const held = evaluateNormalized(resolveLane({ ...rest, mute: false }), atTicks);
    return { ...rest, mute: true, mutedValue: each.clamp ? Math.min(1, Math.max(0, held)) : held };
  });
  return { ok: true, text: serializeAutomation({ ...parsed.document, lanes }) };
}
