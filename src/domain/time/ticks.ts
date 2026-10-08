/**
 * VN61 — TIME AS INTEGER TICKS, 240 000 PER SECOND.
 *
 * Every broadcast rate is a whole number of ticks per frame (24 → 10 000, 25 → 9 600,
 * 29.97 → 8 008, 59.94 → 4 004, 119.88 → 2 002) and a 48 kHz sample is 5 ticks, so "is
 * this key on frame N" is an integer test with no epsilon, a key keeps its time through
 * an fps change, and frames / seconds / samples / timecode are all views. A whole SMPTE
 * day is 2.07 × 10¹⁰ ticks, well inside a double's exact-integer range.
 *
 * A RATE is a rational `num / den` frames per second. The 1001-based rates are stored as
 * `n·1000 / 1001` rather than as their decimal approximations: `29.97` is NOT 30000/1001,
 * and a key placed on frame 1800 at the decimal would sit 0.06 ticks off its frame. A
 * project's fps arrives as a plain number (`ProjectSettings`), so `rateOf` recognises
 * the 1001 family by distance and hands back the exact rational.
 */

export const TICKS_PER_SECOND = 240_000;

/** Frames per second as `num / den`. Integer rates have `den` 1; the NTSC family 1001. */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

/** How far a decimal may sit from `n·1000/1001` and still mean it (29.97 is 0.00003 off). */
const NTSC_TOLERANCE = 0.0015;

/**
 * The exact rate a plain fps number means. `29.97`, `29.97002997…` and `30000/1001` are
 * one rate; `30` is 30/1; anything else (a 7.5 fps preview) is carried as it is, `den` 1,
 * and its tick arithmetic is honest floating point rather than pretended integers.
 */
export function rateOf(fps: number): FrameRate {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError(`A frame rate must be a positive finite number; got ${fps}.`);
  const rounded = Math.round(fps);
  if (Math.abs(fps - rounded) < 1e-9) return { num: rounded, den: 1 };
  const nominal = Math.round((fps * 1001) / 1000);
  if (Math.abs(fps - (nominal * 1000) / 1001) < NTSC_TOLERANCE) return { num: nominal * 1000, den: 1001 };
  return { num: fps, den: 1 };
}

/** The rate as a plain number, for display and for `FrameEvaluationInput.fps`. */
export function rateFps(rate: FrameRate): number {
  return rate.num / rate.den;
}

/** The whole-number rate a timecode counts in: 30 for 29.97, 60 for 59.94. */
export function nominalFps(rate: FrameRate): number {
  return Math.round(rate.num / rate.den);
}

/** Is this one of the 1001-based rates (23.976, 29.97, 59.94, …)? */
export function isNtscRate(rate: FrameRate): boolean {
  return rate.den === 1001;
}

/** Ticks in one frame: 8 008 at 29.97. A whole number for every broadcast rate. */
export function ticksPerFrame(rate: FrameRate): number {
  return (TICKS_PER_SECOND * rate.den) / rate.num;
}

/**
 * Frames → ticks. The product is formed before the division so a 1001 rate comes out an
 * exact integer: frame 1800 at 29.97 is 1800 · 240 000 · 1001 / 30 000 = 14 414 400.
 */
export function framesToTicks(frames: number, rate: FrameRate): number {
  return (frames * TICKS_PER_SECOND * rate.den) / rate.num;
}

/** Ticks → frames, fractional. `Math.floor` it for "the frame this tick falls in". */
export function ticksToFrames(ticks: number, rate: FrameRate): number {
  return (ticks * rate.num) / (TICKS_PER_SECOND * rate.den);
}

/** The tick of the nearest frame boundary — what snapping to frames does while editing. */
export function snapTicksToFrame(ticks: number, rate: FrameRate): number {
  return Math.round(framesToTicks(Math.round(ticksToFrames(ticks, rate)), rate));
}

/** Is this tick exactly on a frame boundary? Integer arithmetic, no epsilon, for every broadcast rate. */
export function isOnFrame(ticks: number, rate: FrameRate): boolean {
  return (ticks * rate.num) % (TICKS_PER_SECOND * rate.den) === 0;
}

export function secondsToTicks(seconds: number): number {
  return seconds * TICKS_PER_SECOND;
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

/** Samples at `sampleRate` → ticks. A 48 kHz sample is exactly 5 ticks. */
export function samplesToTicks(samples: number, sampleRate: number): number {
  return (samples * TICKS_PER_SECOND) / sampleRate;
}

export function ticksToSamples(ticks: number, sampleRate: number): number {
  return (ticks * sampleRate) / TICKS_PER_SECOND;
}

/**
 * Changing fps, Houdini's question (VN61, Vincent 2026-10-06). `keepTime` (the default)
 * leaves the tick where it is, so the key lands on a different frame NUMBER; `keepFrames`
 * keeps the frame number and scales the tick by old/new rate, rounded to a whole tick.
 * Applied to a duration (a handle's Δt) it scales the same way, so a handle keeps its
 * shape in frames.
 */
export type FpsChangeMode = "keepTime" | "keepFrames";

export function retimeTicks(ticks: number, mode: FpsChangeMode, from: FrameRate, to: FrameRate): number {
  if (mode === "keepTime") return ticks;
  return Math.round((ticks * from.num * to.den) / (from.den * to.num));
}
