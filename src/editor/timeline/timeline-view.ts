import { denormalizeValue, type AutomationDocument, type AutomationLane } from "@domain/automation/model.ts";
import { evaluateNormalized, type ResolvedLane } from "@domain/automation/evaluate.ts";

/**
 * VN62 — THE CURVE EDITOR'S VIEW: where a tick and a value land on screen.
 *
 * Pure, so zoom, pan, frame-all and follow are tested without a canvas.
 *
 * Two value modes. `normalized` (the default, VN61's ruling) draws every lane in its OWN
 * 0..1, bottom of the editor = 0, top = 1, so a 0..1 opacity and a −360..360 rotation are
 * edited the same way and overlay on one graph. `values` draws each lane in its output
 * units (`min + v·(max − min)`) on one shared axis, to read actual numbers. The view's
 * vertical window is in whichever unit the mode draws.
 */

export type ValueMode = "normalized" | "values";

export interface TimelineView {
  /** The tick at the left edge of the curve area. */
  readonly startTicks: number;
  /** Ticks per CSS pixel. */
  readonly ticksPerPixel: number;
  /** The display value at the bottom and top edges (normalized units, or output units). */
  readonly valueLow: number;
  readonly valueHigh: number;
}

export const DEFAULT_VIEW: TimelineView = { startTicks: 0, ticksPerPixel: 240_000 / 100, valueLow: -0.05, valueHigh: 1.05 };

/** The closest the editor zooms: a frame at 240 fps is 1 000 ticks; 4 ticks a pixel is 250 px a frame there. */
export const MIN_TICKS_PER_PIXEL = 4;
/** The farthest: a whole SMPTE day across 400 px. */
export const MAX_TICKS_PER_PIXEL = (24 * 3600 * 240_000) / 400;

export const tickToX = (view: TimelineView, ticks: number): number => (ticks - view.startTicks) / view.ticksPerPixel;
export const xToTick = (view: TimelineView, x: number): number => view.startTicks + x * view.ticksPerPixel;

export function valueToY(view: TimelineView, height: number, value: number): number {
  const span = view.valueHigh - view.valueLow;
  return height - ((value - view.valueLow) / (span === 0 ? 1 : span)) * height;
}

export function yToValue(view: TimelineView, height: number, y: number): number {
  return view.valueLow + ((height - y) / Math.max(1, height)) * (view.valueHigh - view.valueLow);
}

/** A lane's normalized value → the value the editor plots in `mode`. */
export function displayValue(lane: Pick<AutomationLane, "min" | "max">, normalized: number, mode: ValueMode): number {
  return mode === "normalized" ? normalized : denormalizeValue(lane, normalized);
}

/** The inverse: a plotted value → the lane's normalized value. */
export function storedValue(lane: Pick<AutomationLane, "min" | "max">, display: number, mode: ValueMode): number {
  if (mode === "normalized") return display;
  const width = lane.max - lane.min;
  return width === 0 ? 0 : (display - lane.min) / width;
}

/** A plotted Δvalue → a normalized Δv (handles and drags are deltas). */
export function storedDelta(lane: Pick<AutomationLane, "min" | "max">, delta: number, mode: ValueMode): number {
  if (mode === "normalized") return delta;
  const width = lane.max - lane.min;
  return width === 0 ? 0 : delta / width;
}

const clampZoom = (ticksPerPixel: number): number => Math.min(MAX_TICKS_PER_PIXEL, Math.max(MIN_TICKS_PER_PIXEL, ticksPerPixel));

/** Zoom time by `factor` (>1 zooms OUT) keeping the tick under `x` where it is. */
export function zoomTimeAt(view: TimelineView, x: number, factor: number): TimelineView {
  const anchor = xToTick(view, x);
  const ticksPerPixel = clampZoom(view.ticksPerPixel * factor);
  return { ...view, ticksPerPixel, startTicks: anchor - x * ticksPerPixel };
}

/** Zoom values by `factor` (>1 zooms OUT) keeping the value under `y` where it is. */
export function zoomValueAt(view: TimelineView, height: number, y: number, factor: number): TimelineView {
  const anchor = yToValue(view, height, y);
  const span = Math.max(1e-6, (view.valueHigh - view.valueLow) * factor);
  const below = (anchor - view.valueLow) / (view.valueHigh - view.valueLow);
  return { ...view, valueLow: anchor - below * span, valueHigh: anchor - below * span + span };
}

/** Pan by a pointer movement in pixels (drag right = earlier time comes into view). */
export function pan(view: TimelineView, height: number, dx: number, dy: number): TimelineView {
  const valuePerPixel = (view.valueHigh - view.valueLow) / Math.max(1, height);
  return {
    ...view,
    startTicks: view.startTicks - dx * view.ticksPerPixel,
    valueLow: view.valueLow + dy * valuePerPixel,
    valueHigh: view.valueHigh + dy * valuePerPixel,
  };
}

/**
 * Frame-all (H): every key of the given lanes AND their handles in view, with a margin
 * of `margin` (a fraction of each span) on every side. Handles count because a handle
 * outside the window cannot be grabbed (Keyframer's rule). With no keys, the view is left
 * alone; a single instant (one key) gets one second of width.
 */
export function frameAll(
  lanes: readonly ResolvedLane[],
  width: number,
  mode: ValueMode,
  margin = 0.08,
  fallback: TimelineView = DEFAULT_VIEW,
): TimelineView {
  let tLow = Infinity;
  let tHigh = -Infinity;
  let vLow = Infinity;
  let vHigh = -Infinity;
  for (const resolved of lanes) {
    for (const key of resolved.keys) {
      for (const [t, v] of [
        [key.t, key.v],
        [key.t + key.in[0], key.v + key.in[1]],
        [key.t + key.out[0], key.v + key.out[1]],
      ] as const) {
        const shown = displayValue(resolved.lane, v, mode);
        tLow = Math.min(tLow, t);
        tHigh = Math.max(tHigh, t);
        vLow = Math.min(vLow, shown);
        vHigh = Math.max(vHigh, shown);
      }
    }
  }
  if (!Number.isFinite(tLow)) return fallback;
  if (tHigh - tLow < 1) {
    tLow -= 120_000;
    tHigh += 120_000;
  }
  if (vHigh - vLow < 1e-6) {
    vLow -= 0.5;
    vHigh += 0.5;
  }
  const tSpan = (tHigh - tLow) * (1 + 2 * margin);
  const vPad = (vHigh - vLow) * margin;
  const ticksPerPixel = clampZoom(tSpan / Math.max(1, width));
  return {
    startTicks: (tLow + tHigh) / 2 - (ticksPerPixel * width) / 2,
    ticksPerPixel,
    valueLow: vLow - vPad,
    valueHigh: vHigh + vPad,
  };
}

/**
 * Follow-playhead PAGING (not continuous scrolling, which makes keys unreadable): when the
 * playhead leaves the window, the window jumps a page so the playhead sits near the left
 * edge again. Inside the window the view does not move.
 */
export function followPage(view: TimelineView, width: number, playheadTicks: number, lead = 0.05): TimelineView {
  const end = xToTick(view, width);
  if (playheadTicks >= view.startTicks && playheadTicks <= end) return view;
  return { ...view, startTicks: playheadTicks - lead * width * view.ticksPerPixel };
}

/**
 * The curve at SCREEN resolution: one display value per pixel column, `columns` long —
 * not one per frame, so a zoomed-in curve is smooth and a zoomed-out one costs the same
 * (Keyframer sampled 512 values per frame range and drew those).
 */
export function sampleColumns(resolved: ResolvedLane, view: TimelineView, columns: number, mode: ValueMode): Float64Array {
  const samples = new Float64Array(Math.max(0, Math.floor(columns)));
  for (let column = 0; column < samples.length; column += 1) {
    samples[column] = displayValue(resolved.lane, evaluateNormalized(resolved, xToTick(view, column + 0.5)), mode);
  }
  return samples;
}

/** The lanes of a document whose keys the view may frame (solo filters, mute does not). */
export function visibleLanes(document: AutomationDocument, solo: string | null): readonly AutomationLane[] {
  return solo === null ? document.lanes : document.lanes.filter((lane) => lane.id === solo);
}
