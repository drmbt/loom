import type { ValuePlotMode } from "@domain/types/graph.ts";
import type { ValueChannelMeta } from "@domain/types/node-definition.ts";

/**
 * Which picture a value node draws, and where a bar's scale comes from.
 *
 * Pure and React-free so the geometry can be asserted as numbers. Everything here is a
 * question about ONE channel at ONE instant; the component holds the state.
 */

/**
 * The picture a node draws when the document does not say (§V91's rule, applied to a
 * choice rather than a value).
 *
 * A pure periodic node keeps its curve. The bar is strictly worse for it: T459 exists
 * because a fast LFO aliased into a polygon, and the fix was to draw the real function
 * across one cycle — frequency, waveform and phase, none of which survive being reduced
 * to a single filled track. For a Lag, a Slope, an Analyze or an audio channel the trade
 * runs the other way: the curve's own docblock notes the range must be auto-fitted, and
 * an auto-fitted curve cannot tell you a gate is HIGH, only that it went up.
 */
export function resolveValuePlotMode(
  stored: ValuePlotMode | undefined,
  isPurePeriodic: boolean,
): ValuePlotMode {
  if (stored !== undefined) return stored;
  return isPurePeriodic ? "trail" : "bar";
}

/** The extremes a channel has actually reached while the plot has been watching. */
export interface ObservedRange {
  low: number;
  high: number;
}

/**
 * Fold this frame's readings into the running extremes, in place.
 *
 * In place, and per channel, because the alternative is the thing the bar exists to
 * avoid: `ValueHistory.series` only carries the four channels that get a curve, so a
 * range derived from it would leave `audioIn`'s other seventeen with no scale at all.
 * Reading `latest` instead gives every published channel a range, at the cost of one
 * comparison per channel per tick and no stored window.
 *
 * Non-finite readings are SKIPPED rather than folded in: one NaN would otherwise poison
 * the range permanently and every later bar on that channel would be drawn against it.
 */
export function observeChannels(
  observed: Map<string, ObservedRange>,
  latest: Readonly<Record<string, number>> | null,
): void {
  if (latest === null) return;
  for (const [channel, value] of Object.entries(latest)) {
    if (!Number.isFinite(value)) continue;
    const seen = observed.get(channel);
    if (seen === undefined) {
      observed.set(channel, { low: value, high: value });
      continue;
    }
    if (value < seen.low) seen.low = value;
    if (value > seen.high) seen.high = value;
  }
}

/** Where a bar's fill starts, ends and anchors, all in 0..1 across the track. */
export interface BarGeometry {
  /** Where zero sits. The fill grows FROM here, which is what makes a bipolar bar read. */
  readonly anchor: number;
  readonly start: number;
  readonly end: number;
  /**
   * The value is outside the range the bar is drawn against.
   *
   * Worth its own flag rather than a silent clamp: against a DECLARED range it means the
   * declaration is wrong or the node broke its own contract, and a bar pinned at full
   * that looks identical to one legitimately at full would hide both.
   */
  readonly clipped: boolean;
}

/**
 * The bar for `value` against `low..high`, or null when the range is degenerate.
 *
 * Null rather than a half-filled track: a zero-width range carries no information about
 * where the value sits inside it, and drawing the bar at 50% would be a picture of a
 * ratio nobody computed. The caller shows the number alone — which is the honest
 * rendering of "seen once, no range yet", the state every observed channel starts in.
 */
export function barGeometry(value: number, low: number, high: number): BarGeometry | null {
  const span = high - low;
  if (!Number.isFinite(span) || span <= 0) return null;
  if (!Number.isFinite(value)) return null;
  const raw = (value - low) / span;
  const unit = Math.min(1, Math.max(0, raw));
  // Clamped to the track, so a range that excludes zero still anchors somewhere real:
  // 0..1 anchors at the left, -1..0 at the right, -1..1 in the middle.
  const anchor = Math.min(1, Math.max(0, (0 - low) / span));
  return {
    anchor,
    start: Math.min(anchor, unit),
    end: Math.max(anchor, unit),
    clipped: raw !== unit,
  };
}

/**
 * A reading, as the node body prints it.
 *
 * Shared by both pictures rather than copied into each: the bar's tooltip states a range
 * and the readout states a value, and two nodes' worth of digits that disagree about
 * where they round is a difference a reader will try to interpret.
 */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  return value.toFixed(3);
}

/** A channel is ON when it is not zero. Half a boolean is not a state it has. */
export function isChannelOn(value: number): boolean {
  return Number.isFinite(value) && value !== 0;
}

/** The scale a channel's bar is drawn against, and whether anyone declared it. */
export type ChannelScale =
  | { readonly kind: "boolean" }
  | { readonly kind: "bounded"; readonly low: number; readonly high: number; readonly declared: boolean };

/**
 * The declared scale where there is one, the observed extremes otherwise.
 *
 * The `declared` flag travels with the scale rather than being recomputed by the
 * renderer, because the renderer is where it would be forgotten: an observed bar drawn
 * with a declared bar's chrome is a claim that 60% means 0.6 of a real range, when it
 * means 0.6 of whatever this channel has happened to do since the pane opened.
 */
export function channelScale(
  meta: ValueChannelMeta | undefined,
  observed: ObservedRange | undefined,
): ChannelScale | null {
  if (meta !== undefined) {
    if (meta.kind === "boolean") return { kind: "boolean" };
    return { kind: "bounded", low: meta.low, high: meta.high, declared: true };
  }
  if (observed === undefined) return null;
  return { kind: "bounded", low: observed.low, high: observed.high, declared: false };
}
