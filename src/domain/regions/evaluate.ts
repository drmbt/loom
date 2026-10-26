import { TICKS_PER_SECOND } from "../time/ticks.ts";
import { regionEnd, type ClipTrack, type Region } from "./model.ts";

/**
 * VN101 — WHERE IN ITS SOURCE A REGION IS, AT A PLAYHEAD. Pure: ticks in, ticks out, no
 * clock, no element (§V44). The player (`clip-track.ts`'s door) and an offline render both
 * ask this one function, so a take and a live run cannot disagree about which frame shows.
 *
 * ## The rate
 *
 * Source ticks per timeline tick. `speed` (1 = real time, 0 = a freeze on the first frame);
 * with `bpmSync`, the rate that plays `sourceIn .. sourceOut` in exactly `beats` beats at the
 * grid tempo, `(out − in) / (beats × 60 / bpm)` seconds per second, REPLACING `speed` — as
 * Resolume's BPM Sync transport does. With no tempo given, a synced region falls back to its
 * `speed`, so a document without a grid still plays.
 *
 * ## Exact in ticks where the maths allows
 *
 * The wrap is taken on the TIMELINE, not on the source: a lap is `span / rate` timeline ticks,
 * and the position within the lap is scaled once. At speed 1 the lap is the span itself, an
 * integer, so "the loop wraps on tick N" is an integer test; at BPM sync the lap is
 * `beats × 60 × 240 000 / bpm` ticks, whole for every tempo that divides 14 400 000 × beats.
 *
 * ## The modes, on the forward phase p ∈ [0, span]
 *
 * - loop: p mod span, so [in, out) and back to `in` at the lap;
 * - bounce: a triangle of period 2·span; the turning points are `out` (after one span) and
 *   `in` (after two);
 * - onceHold: p clamped at span: after one pass the region holds on `out`;
 * - onceClear: p until span, then BLANK (null) — the region shows nothing for the rest of
 *   its length, as Resolume's "play once and clear" ejects the clip.
 *
 * Reverse MIRRORS the result inside the span (`in + out − t`): reverse loop starts on `out`
 * and runs down to `in`, reverse once-hold holds on `in`. `out` is the instant the span ends;
 * a player shows the last frame before it (an element seeked to its duration shows its last
 * frame), which is what a held clip shows.
 */

/** Source ticks per timeline tick for this region, at `tempoBpm` (or its speed without one). */
export function regionRate(region: Region, tempoBpm?: number): number {
  if (region.bpmSync !== undefined && tempoBpm !== undefined && Number.isFinite(tempoBpm) && tempoBpm > 0) {
    // (out − in) ticks of source over (beats × 60 / bpm) seconds of timeline, both in ticks.
    return ((region.sourceOut - region.sourceIn) * tempoBpm) / (region.bpmSync.beats * 60 * TICKS_PER_SECOND);
  }
  return region.speed;
}

/** `a mod m` into [0, m) for m > 0, negative `a` included. */
const mod = (a: number, m: number): number => {
  const r = a % m;
  return r < 0 ? r + m : r;
};

/**
 * The forward phase (source ticks from `sourceIn`) at `local` timeline ticks into the region,
 * or null for blank. Wraps on the timeline so a lap boundary is exact.
 */
function forwardPhase(region: Region, local: number, rate: number): number | null {
  const span = region.sourceOut - region.sourceIn;
  if (rate <= 0) return 0;
  // Timeline ticks one pass of the span takes. Exact at speed 1 (it is the span).
  const lap = rate === 1 ? span : span / rate;
  const scale = (t: number): number => (rate === 1 ? t : Math.min(span, t * rate));
  switch (region.playMode) {
    case "loop": {
      const phase = scale(mod(local, lap));
      // Floating rounding can land a hair under the lap and scale to the span itself.
      return phase >= span ? 0 : phase;
    }
    case "bounce": {
      const q = mod(local, 2 * lap);
      return q <= lap ? scale(q) : scale(2 * lap - q);
    }
    case "onceHold":
      return local >= lap ? span : scale(local);
    case "onceClear":
      return local >= lap ? null : scale(local);
  }
}

/**
 * The source time, in ticks, a region shows at `playheadTicks`, or null when it shows
 * nothing: the playhead is outside the region, or a once-and-clear pass has finished.
 */
export function sourceTimeAt(region: Region, playheadTicks: number, tempoBpm?: number): number | null {
  if (!Number.isFinite(playheadTicks)) return null;
  const local = playheadTicks - region.timelineStart;
  if (local < 0 || local >= region.length) return null;
  const phase = forwardPhase(region, local, regionRate(region, tempoBpm));
  if (phase === null) return null;
  return region.direction === "forward" ? region.sourceIn + phase : region.sourceOut - phase;
}

/** `sourceTimeAt` in seconds, for a media element's `currentTime`. */
export function sourceSecondsAt(region: Region, playheadTicks: number, tempoBpm?: number): number | null {
  const ticks = sourceTimeAt(region, playheadTicks, tempoBpm);
  return ticks === null ? null : ticks / TICKS_PER_SECOND;
}

/**
 * The region's opacity at the playhead from its fades: 0 → 1 across `fadeIn` from the start,
 * 1 → 0 across `fadeOut` to the end, 0 outside. Linear (a fade's curve is an automation
 * lane's job).
 */
export function regionOpacityAt(region: Region, playheadTicks: number): number {
  const local = playheadTicks - region.timelineStart;
  if (!(local >= 0 && local < region.length)) return 0;
  const fadeIn = region.fadeIn > 0 ? Math.min(1, local / region.fadeIn) : 1;
  const fadeOut = region.fadeOut > 0 ? Math.min(1, (region.length - local) / region.fadeOut) : 1;
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

/** Index of the region under the playhead, or -1. Binary search over the sorted regions. */
export function regionIndexAt(track: Pick<ClipTrack, "regions">, playheadTicks: number): number {
  const regions = track.regions;
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const region = regions[middle] as Region;
    if (playheadTicks < region.timelineStart) high = middle - 1;
    else if (playheadTicks >= regionEnd(region)) low = middle + 1;
    else return middle;
  }
  return -1;
}

/** The region under the playhead, or null in a gap. */
export function regionAt(track: Pick<ClipTrack, "regions">, playheadTicks: number): Region | null {
  const index = regionIndexAt(track, playheadTicks);
  return index < 0 ? null : (track.regions[index] as Region);
}

/** The first region that starts after the playhead (the one to pre-roll), or null. */
export function nextRegionAfter(track: Pick<ClipTrack, "regions">, playheadTicks: number): Region | null {
  for (const region of track.regions) {
    if (region.timelineStart > playheadTicks) return region;
  }
  return null;
}

/** What a track shows at a playhead: the region, its source time and opacity, or blank. */
export interface TrackSample {
  readonly region: Region;
  /** Source ticks. */
  readonly sourceTicks: number;
  readonly opacity: number;
}

export function sampleTrack(track: Pick<ClipTrack, "regions">, playheadTicks: number, tempoBpm?: number): TrackSample | null {
  const region = regionAt(track, playheadTicks);
  if (region === null) return null;
  const sourceTicks = sourceTimeAt(region, playheadTicks, tempoBpm);
  if (sourceTicks === null) return null;
  return { region, sourceTicks, opacity: regionOpacityAt(region, playheadTicks) };
}
