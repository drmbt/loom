import { TICKS_PER_SECOND, nominalFps, ticksPerFrame, type FrameRate } from "./ticks.ts";

/**
 * VN61 — THE RULER'S LEVEL OF DETAIL.
 *
 * Zoomed out a ruler counts hours, then minutes, then seconds, then frames. The step at a
 * zoom is the smallest one on a fixed ladder whose labels sit at least `minPixels` apart,
 * so labels never collide and the unit changes at the zoom where it should. The ladder is
 * the human one (1, 2, 5, 10, 15, 30 of a unit), not powers of two: nobody reads "every
 * 16 seconds".
 *
 * Frame steps come from the RATE (1, 2, 5, 10 frames, and a half second), and are offered
 * only below a second; a 10-frame step at 30 fps is a third of a second, which is a
 * readable tick, but a 50-frame step is not a unit anyone counts in.
 */

export type RulerUnit = "frames" | "seconds" | "minutes" | "hours";

export interface RulerStep {
  /** The distance between labelled ticks, in ticks. */
  readonly ticks: number;
  /** The unit the label is written in at this zoom. */
  readonly unit: RulerUnit;
  /** How many of `unit` one step is. */
  readonly count: number;
}

const SECOND_COUNTS = [1, 2, 5, 10, 15, 30] as const;
const MINUTE_COUNTS = [1, 2, 5, 10, 15, 30] as const;
const HOUR_COUNTS = [1, 2, 3, 6, 12, 24] as const;
const FRAME_COUNTS = [1, 2, 5, 10] as const;

/** Every step this rate's ruler can show, smallest first. */
export function rulerLadder(rate: FrameRate): readonly RulerStep[] {
  const frame = ticksPerFrame(rate);
  const nominal = nominalFps(rate);
  const steps: RulerStep[] = [];
  for (const count of FRAME_COUNTS) if (count < nominal) steps.push({ ticks: frame * count, unit: "frames", count });
  // Half a second in whole frames, when the rate divides evenly (not at 25 fps's 12.5).
  if (nominal % 2 === 0 && nominal / 2 > 10) steps.push({ ticks: frame * (nominal / 2), unit: "frames", count: nominal / 2 });
  for (const count of SECOND_COUNTS) steps.push({ ticks: count * TICKS_PER_SECOND, unit: "seconds", count });
  for (const count of MINUTE_COUNTS) steps.push({ ticks: count * 60 * TICKS_PER_SECOND, unit: "minutes", count });
  for (const count of HOUR_COUNTS) steps.push({ ticks: count * 3600 * TICKS_PER_SECOND, unit: "hours", count });
  return steps;
}

/**
 * The step whose labels sit at least `minPixels` apart at `pixelsPerTick`. Zoomed so far
 * out that even a day is narrower than that, the coarsest step (a day).
 */
export function rulerStep(pixelsPerTick: number, rate: FrameRate, minPixels = 64): RulerStep {
  if (!(pixelsPerTick > 0) || !Number.isFinite(pixelsPerTick)) throw new RangeError(`pixelsPerTick must be positive and finite; got ${pixelsPerTick}.`);
  const ladder = rulerLadder(rate);
  for (const step of ladder) if (step.ticks * pixelsPerTick >= minPixels) return step;
  return ladder[ladder.length - 1] as RulerStep;
}

/** The tick positions of a step's marks inside [start, end], aligned to multiples of the step. */
export function rulerMarks(startTicks: number, endTicks: number, step: RulerStep): number[] {
  const marks: number[] = [];
  const first = Math.ceil(startTicks / step.ticks);
  for (let index = first; index * step.ticks <= endTicks; index += 1) marks.push(index * step.ticks);
  return marks;
}
