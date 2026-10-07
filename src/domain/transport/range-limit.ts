import { RANGE_DAY_SECONDS } from "../types/graph.ts";

/**
 * THE RANGE CAP (VN71/T1687b): how long a timeline range may be, and the sentence a person
 * gets when one is clamped.
 *
 * One SMPTE day at the project's rate. It used to be `SEEK_FRAME_LIMIT`, 10 000 frames, because
 * a seek replayed from frame zero and the range was bounded by what a seek would replay. A seek
 * jumps now (one frame, at any distance), so the range is bounded only by sense.
 */

/** The last frame a range may end on at `fps`: one SMPTE day of frames, less one (inclusive). */
export function frameRangeLimit(fps: number): number {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 1;
  return Math.floor(RANGE_DAY_SECONDS * rate) - 1;
}

/**
 * The sentence for a frame past the range cap (T1687b keeps it): the frame asked for, the cap,
 * and what the cap is, so the number reads as a rule and not a bug.
 */
export function rangeLimitSentence(frame: number, fps: number): string {
  return `Frame ${String(frame)} is past the timeline limit ${String(frameRangeLimit(fps))}: one day at ${String(fps)} fps is the longest range a project holds.`;
}
