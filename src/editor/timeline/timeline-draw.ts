import type { ResolvedLane } from "@domain/automation/evaluate.ts";
import { rulerMarks, rulerStep, type RulerStep } from "@domain/time/ruler.ts";
import { TICKS_PER_SECOND, ticksToFrames, type FrameRate } from "@domain/time/ticks.ts";
import { formatTimecode, ticksToTimecode, supportsDropFrame } from "@domain/time/timecode.ts";
import type { KeyRef } from "./timeline-edits.ts";
import { peakColumn, type WaveformPeaks } from "./waveform-peaks.ts";
import type { Rect } from "./timeline-hit.ts";
import { displayValue, sampleColumns, tickToX, valueToY, type TimelineView, type ValueMode } from "./timeline-view.ts";

/**
 * VN62 — PAINTING THE TIMELINE, Canvas 2D. Every colour is a token read from the canvas's
 * own computed style (§V17); a lane's colour is a token NAME (`signal`, `axis-z`), drawn as
 * `--<name>`, falling back to `--signal` when the name is not a token.
 *
 * Layout, top to bottom: the two-tier ruler (timecode or frames over min:sec), then the
 * curve area. The curve is one sample per pixel column (`sampleColumns`), solid between
 * the lane's first and last key and dashed outside them, where it is extrapolation.
 */

export const RULER_TOP = 18;
export const RULER_BOTTOM = 14;
export const RULER_HEIGHT = RULER_TOP + RULER_BOTTOM;

export interface DrawLane {
  readonly resolved: ResolvedLane;
  /** Drawn faint: muted, or not in the solo. */
  readonly faint: boolean;
}

export interface DrawState {
  readonly view: TimelineView;
  readonly mode: ValueMode;
  readonly rate: FrameRate;
  readonly lanes: readonly DrawLane[];
  readonly selection: readonly KeyRef[];
  readonly playheadTicks: number | null;
  /** The project's in/out, in ticks: outside it is shaded. */
  readonly range: readonly [number, number] | null;
  readonly marquee: Rect | null;
  /** The selection's box transform, when it has one. */
  readonly box: Rect | null;
  /** Label the ruler in frames rather than timecode. */
  readonly frameLabels: boolean;
  /** VN64: the reference media's waveform, drawn under the lanes. */
  readonly waveform?: DrawWaveform | null;
}

export interface DrawWaveform {
  readonly peaks: WaveformPeaks;
  /** Where in the media (seconds) the timeline is at these ticks; null where the media is not showing. */
  readonly mediaSecondsAt: (ticks: number) => number | null;
}

/**
 * The waveform, one column per CSS pixel, centred in the curve area: min/max extremes of the
 * bins under the column, coloured by the column's band mix (ltc-lab's look: low = the X
 * axis red, mid = the Y green, high = the Z blue, added at their weights) and made more
 * opaque the louder it is, so silence stays a faint line and the curves stay readable over it.
 */
export function paintWaveform(context: CanvasRenderingContext2D, canvas: Element, view: TimelineView, width: number, height: number, waveform: DrawWaveform): void {
  // The three band colours are tokens; a column's mix is the three ADDED ("lighter") at
  // their weights, so no colour is ever written here, only derived from the palette.
  const bands = [tokenColour(canvas, "axis-x"), tokenColour(canvas, "axis-y"), tokenColour(canvas, "axis-z")] as const;
  const centre = height / 2;
  const reach = height * 0.45;
  const previous = { alpha: context.globalAlpha, composite: context.globalCompositeOperation };
  context.globalCompositeOperation = "lighter";
  for (let x = 0; x < width; x += 1) {
    const from = waveform.mediaSecondsAt(view.startTicks + x * view.ticksPerPixel);
    const to = waveform.mediaSecondsAt(view.startTicks + (x + 1) * view.ticksPerPixel);
    if (from === null || to === null) continue;
    const column = peakColumn(waveform.peaks, from, to);
    if (column === null) continue;
    const sum = column.lowWeight + column.midWeight + column.highWeight;
    const weights = sum > 0 ? [column.lowWeight / sum, column.midWeight / sum, column.highWeight / sum] : [1 / 3, 1 / 3, 1 / 3];
    const amplitude = Math.min(1, Math.max(Math.abs(column.min), Math.abs(column.max)));
    const opacity = 0.25 + 0.45 * amplitude;
    const y0 = centre - column.max * reach;
    const y1 = centre - column.min * reach;
    for (let band = 0; band < 3; band += 1) {
      if (weights[band]! <= 0) continue;
      context.globalAlpha = opacity * weights[band]!;
      context.fillStyle = bands[band]!;
      context.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
  context.globalAlpha = previous.alpha;
  context.globalCompositeOperation = previous.composite;
}

/** `--<name>` from the element's computed style, falling back to `--signal` for a name that is not a token. */
export function tokenColour(element: Element, name: string): string {
  const style = getComputedStyle(element);
  const value = style.getPropertyValue(`--${name}`).trim();
  return value === "" ? style.getPropertyValue("--signal").trim() : value;
}

/** "1:05", "12:00:05" — the lower ruler tier's wall-clock reading. */
export function formatMinSec(ticks: number): string {
  const total = Math.floor(ticks / TICKS_PER_SECOND);
  const sign = total < 0 ? "-" : "";
  const seconds = Math.abs(total);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, "0")}:${ss}` : `${sign}${m}:${ss}`;
}

/** The upper tier's label for a mark: a frame number when zoomed to frames or asked for, else timecode. */
export function topLabel(ticks: number, step: RulerStep, rate: FrameRate, frameLabels: boolean): string {
  if (frameLabels || step.unit === "frames") return String(Math.round(ticks === 0 ? 0 : ticksToFrames(ticks, rate)));
  if (ticks < 0) return "";
  return formatTimecode(ticksToTimecode(ticks, rate, supportsDropFrame(rate)));
}

export function paintTimeline(canvas: HTMLCanvasElement, state: DrawState): void {
  const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.floor(width * ratio)) canvas.width = Math.floor(width * ratio);
  if (canvas.height !== Math.floor(height * ratio)) canvas.height = Math.floor(height * ratio);
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const colour = (name: string): string => tokenColour(canvas, name);
  const { view } = state;
  const curveHeight = Math.max(1, height - RULER_HEIGHT);

  context.fillStyle = colour("bg-sunken");
  context.fillRect(0, 0, width, height);

  // Outside the project's in/out.
  if (state.range !== null) {
    context.fillStyle = colour("bg-void");
    const inX = tickToX(view, state.range[0]);
    const outX = tickToX(view, state.range[1]);
    if (inX > 0) context.fillRect(0, RULER_HEIGHT, Math.min(width, inX), curveHeight);
    if (outX < width) context.fillRect(Math.max(0, outX), RULER_HEIGHT, width - Math.max(0, outX), curveHeight);
  }

  // ── Ruler ──
  context.fillStyle = colour("bg-panel");
  context.fillRect(0, 0, width, RULER_HEIGHT);
  context.font = `10px ${getComputedStyle(canvas).getPropertyValue("--font-mono").trim() || "monospace"}`;
  context.textBaseline = "middle";
  const start = view.startTicks;
  const end = view.startTicks + width * view.ticksPerPixel;
  const top = rulerStep(1 / view.ticksPerPixel, state.rate, 84);
  context.strokeStyle = colour("line");
  context.fillStyle = colour("text-dim");
  context.lineWidth = 1;
  for (const mark of rulerMarks(start, end, top)) {
    const x = Math.round(tickToX(view, mark)) + 0.5;
    context.beginPath();
    context.moveTo(x, RULER_TOP - 6);
    context.lineTo(x, RULER_TOP);
    context.moveTo(x, RULER_HEIGHT);
    context.lineTo(x, height);
    context.stroke();
    context.fillText(topLabel(mark, top, state.rate, state.frameLabels), x + 3, RULER_TOP / 2);
  }
  const lower = rulerStep(1 / view.ticksPerPixel, state.rate, 64);
  const lowerStep: RulerStep = lower.unit === "frames" ? { ticks: TICKS_PER_SECOND, unit: "seconds", count: 1 } : lower;
  for (const mark of rulerMarks(start, end, lowerStep)) {
    const x = Math.round(tickToX(view, mark)) + 0.5;
    context.beginPath();
    context.moveTo(x, RULER_HEIGHT - 4);
    context.lineTo(x, RULER_HEIGHT);
    context.stroke();
    context.fillText(formatMinSec(mark), x + 3, RULER_TOP + RULER_BOTTOM / 2);
  }
  context.strokeStyle = colour("line");
  context.beginPath();
  context.moveTo(0, RULER_HEIGHT - 0.5);
  context.lineTo(width, RULER_HEIGHT - 0.5);
  context.stroke();

  // ── Curve area ──
  context.save();
  context.beginPath();
  context.rect(0, RULER_HEIGHT, width, curveHeight);
  context.clip();
  context.translate(0, RULER_HEIGHT);
  if (state.waveform !== undefined && state.waveform !== null) paintWaveform(context, canvas, view, width, curveHeight, state.waveform);
  // The 0 and 1 lines of the normalized view.
  if (state.mode === "normalized") {
    context.strokeStyle = colour("line");
    context.setLineDash([2, 3]);
    for (const value of [0, 1]) {
      const y = Math.round(valueToY(view, curveHeight, value)) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.setLineDash([]);
  }

  const selected = new Set(state.selection.map((ref) => `${ref.lane} ${ref.key}`));
  for (const { resolved, faint } of state.lanes) {
    const lane = resolved.lane;
    const stroke = tokenColour(canvas, lane.color);
    const samples = sampleColumns(resolved, view, width, state.mode);
    const first = resolved.keys[0];
    const last = resolved.keys[resolved.keys.length - 1];
    if (first === undefined || last === undefined) continue;
    const firstX = tickToX(view, first.t);
    const lastX = tickToX(view, last.t);
    context.globalAlpha = faint ? 0.35 : 1;
    context.strokeStyle = stroke;
    context.lineWidth = 1.5;
    // Solid inside the keys, dashed outside (extrapolation).
    for (const dashed of [false, true]) {
      context.setLineDash(dashed ? [4, 4] : []);
      context.beginPath();
      let pen = false;
      for (let column = 0; column < samples.length; column += 1) {
        const x = column + 0.5;
        const inside = x >= firstX && x <= lastX;
        if (inside === dashed) {
          pen = false;
          continue;
        }
        const y = valueToY(view, curveHeight, samples[column]!);
        if (pen) context.lineTo(x, y);
        else context.moveTo(x, y);
        pen = true;
      }
      context.stroke();
    }
    context.setLineDash([]);
    // Keys, and the handles of selected keys.
    for (const key of resolved.keys) {
      const x = tickToX(view, key.t);
      const y = valueToY(view, curveHeight, displayValue(lane, key.v, state.mode));
      const isSelected = selected.has(`${lane.id} ${key.key.id}`);
      if (isSelected) {
        context.strokeStyle = colour("text-dim");
        context.lineWidth = 1;
        for (const handle of [key.in, key.out]) {
          if (handle[0] === 0 && handle[1] === 0) continue;
          const hx = tickToX(view, key.t + handle[0]);
          const hy = valueToY(view, curveHeight, displayValue(lane, key.v + handle[1], state.mode));
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(hx, hy);
          context.stroke();
          context.beginPath();
          context.arc(hx, hy, 3, 0, Math.PI * 2);
          context.fillStyle = colour("text");
          context.fill();
        }
      }
      context.fillStyle = isSelected ? colour("text") : stroke;
      context.strokeStyle = colour("bg-sunken");
      context.beginPath();
      context.moveTo(x, y - 4.5);
      context.lineTo(x + 4.5, y);
      context.lineTo(x, y + 4.5);
      context.lineTo(x - 4.5, y);
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  if (state.box !== null) {
    const { x0, y0, x1, y1 } = state.box;
    context.strokeStyle = colour("text-dim");
    context.lineWidth = 1;
    context.strokeRect(Math.round(x0) - 3.5, Math.round(y0) - 3.5, x1 - x0 + 7, y1 - y0 + 7);
    context.fillStyle = colour("text-dim");
    for (const [hx, hy] of [[x0 - 3, (y0 + y1) / 2], [x1 + 3, (y0 + y1) / 2], [(x0 + x1) / 2, y0 - 3], [(x0 + x1) / 2, y1 + 3]] as const) {
      context.fillRect(hx - 2.5, hy - 2.5, 5, 5);
    }
  }

  if (state.marquee !== null) {
    const { x0, y0, x1, y1 } = state.marquee;
    context.strokeStyle = colour("signal");
    context.setLineDash([3, 3]);
    context.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    context.setLineDash([]);
  }
  context.restore();

  // ── Playhead, over everything ──
  if (state.playheadTicks !== null) {
    const x = Math.round(tickToX(view, state.playheadTicks)) + 0.5;
    if (x >= 0 && x <= width) {
      context.strokeStyle = colour("signal");
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
  }
}

/** The frame a ruler click at `x` seeks to: the frame whose span is under the pointer. */
export function frameAtX(view: TimelineView, x: number, rate: FrameRate): number {
  return Math.max(0, Math.floor(ticksToFrames(view.startTicks + x * view.ticksPerPixel, rate)));
}
