import { framesToTicks, isNtscRate, rateFps, nominalFps, ticksToFrames, type FrameRate } from "./ticks.ts";

/**
 * VN61 — SMPTE TIMECODE, INCLUDING DROP-FRAME.
 *
 * A timecode LABELS a frame; it is display, never storage (keys are ticks). At 29.97 a
 * label counts 30 frames a second, so an hour of labels runs 3.6 s longer than an hour of
 * frames. Drop-frame fixes that by skipping LABELS (never frames): frame numbers 00 and 01
 * of every minute are not used, except in every tenth minute — 2 per minute at 29.97, 4
 * at 59.94. The result is 108 labels an hour fewer, which is the 3.6 s.
 *
 * Keyframer's timecode broke at 29.97 because it counted labels as frames; this module is
 * the one place both directions are done, and its tests run a whole day round-trip.
 *
 * Drop-frame is written with `;` before the frames (`01:00:00;02`), non-drop with `:`.
 */

export interface Timecode {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly frames: number;
  readonly dropFrame: boolean;
}

/** Labels skipped per minute: 2 at 29.97, 4 at 59.94. Zero for any non-DF rate. */
export function droppedPerMinute(rate: FrameRate): number {
  if (!isNtscRate(rate)) return 0;
  const nominal = nominalFps(rate);
  return nominal % 30 === 0 ? (nominal / 30) * 2 : 0;
}

/** Whether `rate` can be counted drop-frame at all (29.97, 59.94, 119.88). */
export function supportsDropFrame(rate: FrameRate): boolean {
  return droppedPerMinute(rate) > 0;
}

/** Frame number (0-based, from 00:00:00:00) → its timecode label. */
export function frameToTimecode(frame: number, rate: FrameRate, dropFrame = false): Timecode {
  if (!Number.isInteger(frame) || frame < 0) throw new RangeError(`A timecode labels a whole, non-negative frame; got ${frame}.`);
  const nominal = nominalFps(rate);
  let label = frame;
  const drop = dropFrame ? droppedPerMinute(rate) : 0;
  if (dropFrame && drop === 0) throw new RangeError(`${rateFps(rate).toFixed(3)} fps has no drop-frame timecode.`);
  if (drop > 0) {
    const perMinute = nominal * 60 - drop;
    const perTenMinutes = nominal * 600 - drop * 9;
    const tens = Math.floor(frame / perTenMinutes);
    const rest = frame % perTenMinutes;
    // The first minute of each ten keeps all its labels; each later one starts `drop` in.
    label += drop * 9 * tens + (rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0);
  }
  return {
    hours: Math.floor(label / (nominal * 3600)),
    minutes: Math.floor(label / (nominal * 60)) % 60,
    seconds: Math.floor(label / nominal) % 60,
    frames: label % nominal,
    dropFrame: drop > 0,
  };
}

/**
 * A timecode label → its frame number. Refuses a label drop-frame never uses
 * (`00:01:00;00`) by name rather than quietly mapping it onto a neighbour.
 */
export function timecodeToFrame(timecode: Timecode, rate: FrameRate): number {
  const nominal = nominalFps(rate);
  const { hours, minutes, seconds, frames } = timecode;
  for (const [what, value, limit] of [["minutes", minutes, 60], ["seconds", seconds, 60], ["frames", frames, nominal]] as const) {
    if (!Number.isInteger(value) || value < 0 || value >= limit) throw new RangeError(`Timecode ${what} must be 0..${limit - 1}; got ${value}.`);
  }
  if (!Number.isInteger(hours) || hours < 0) throw new RangeError(`Timecode hours must be a whole number ≥ 0; got ${hours}.`);
  const drop = timecode.dropFrame ? droppedPerMinute(rate) : 0;
  if (timecode.dropFrame && drop === 0) throw new RangeError(`${rateFps(rate).toFixed(3)} fps has no drop-frame timecode.`);
  const totalMinutes = hours * 60 + minutes;
  if (drop > 0 && seconds === 0 && frames < drop && minutes % 10 !== 0) {
    throw new RangeError(`${formatTimecode(timecode)} is not a drop-frame label: frames 00–${String(drop - 1).padStart(2, "0")} are skipped at the start of every minute except each tenth.`);
  }
  return (hours * 3600 + minutes * 60 + seconds) * nominal + frames - drop * (totalMinutes - Math.floor(totalMinutes / 10));
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** `01:02:03:04`, or `01:02:03;04` drop-frame. */
export function formatTimecode(timecode: Timecode): string {
  return `${pad(timecode.hours)}:${pad(timecode.minutes)}:${pad(timecode.seconds)}${timecode.dropFrame ? ";" : ":"}${pad(timecode.frames)}`;
}

/** Ticks → the label of the frame they fall in. */
export function ticksToTimecode(ticks: number, rate: FrameRate, dropFrame = false): Timecode {
  return frameToTimecode(Math.floor(ticksToFrames(ticks, rate) + 1e-9), rate, dropFrame);
}

/** A label → the tick its frame starts on. */
export function timecodeToTicks(timecode: Timecode, rate: FrameRate): number {
  return framesToTicks(timecodeToFrame(timecode, rate), rate);
}

/**
 * Typed entry, right-aligned (Keyframer's, and every NLE's): the LAST field is frames,
 * then seconds, minutes, hours. Fields are separated by any of `: ; . ,` or, with no
 * separator, read as digit pairs from the right — so `1.12` is 1 s 12 f and `11200` is
 * 1 min 12 s 00 f. Fields may overflow (`90` frames at 30 fps is 3 s), the way typed
 * entry does everywhere. A `;` anywhere asks for drop-frame.
 *
 * Returns the FRAME number, or an error string naming what was wrong.
 */
export function parseTimecodeEntry(text: string, rate: FrameRate, dropFrame = false): { frame: number } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { error: "Enter a timecode, e.g. 01:00:00:00 or 1.12 (1 s 12 f)." };
  if (!/^[0-9:;.,]+$/.test(trimmed)) return { error: `"${text}" is not a timecode: use digits separated by ":" (or ";" for drop-frame).` };
  const df = dropFrame || trimmed.includes(";");
  let fields: string[];
  if (/[:;.,]/.test(trimmed)) fields = trimmed.split(/[:;.,]/);
  else {
    fields = [];
    for (let end = trimmed.length; end > 0; end -= 2) fields.unshift(trimmed.slice(Math.max(0, end - 2), end));
  }
  if (fields.length > 4) return { error: `"${text}" has ${fields.length} fields; a timecode has at most four (hh:mm:ss:ff).` };
  const [frames = 0, seconds = 0, minutes = 0, hours = 0] = fields.reverse().map((field) => (field === "" ? 0 : Number(field)));
  const nominal = nominalFps(rate);
  // Carry overflow the way typed entry does, then hand the canonical label to the one converter.
  let total = ((hours * 60 + minutes) * 60 + seconds) * nominal + frames;
  const label = {
    hours: Math.floor(total / (nominal * 3600)),
    minutes: Math.floor((total %= nominal * 3600) / (nominal * 60)),
    seconds: Math.floor((total %= nominal * 60) / nominal),
    frames: total % nominal,
    dropFrame: df,
  };
  try {
    return { frame: timecodeToFrame(label, rate) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
