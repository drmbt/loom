import type { Region } from "@domain/regions/model.ts";
import { regionEnd } from "@domain/regions/model.ts";
import { rulerMarks, rulerStep } from "@domain/time/ruler.ts";
import { TICKS_PER_SECOND, type FrameRate } from "@domain/time/ticks.ts";
import type { BeatGrid } from "./beat-grid.ts";
import { isOfflineMedia, lapTicks, mediaLabel, regionBadge } from "./clip-edits.ts";
import type { ClipTrackView } from "./timeline-model.ts";
import { formatMinSec, gridLines, tokenColour } from "./timeline-draw.ts";
import { tickToX, type TimelineView } from "./timeline-view.ts";

/**
 * VN106 — THE CLIP LANES, painted (Canvas 2D, tokens only, §V17) and hit-tested (pure).
 *
 * Layout, top to bottom: a one-tier ruler on the timeline's own view transform (min:sec,
 * the beat grid's marks), then one row per Clip Track node. A region is a block from its
 * start to its end: the FIRST PASS of its source solid, every further pass (a loop's
 * repeats, a bounce's way back) a GHOST of it behind a notch at the lap, a once-and-hold's
 * tail hatched as a hold and a once-and-clear's tail left empty. The block names its file
 * and carries a badge (mode, reverse, speed or beats). A region whose media the browser
 * cannot open (an imported filesystem path) is drawn OFFLINE: dim, dashed, saying so.
 */

export const CLIP_RULER_HEIGHT = 18;
export const CLIP_ROW_HEIGHT = 30;
/** How close to an edge (CSS px) a press grabs the edge rather than the body. */
export const EDGE_GRAB = 6;

export function clipStripHeight(rows: number): number {
  return rows === 0 ? 0 : CLIP_RULER_HEIGHT + rows * CLIP_ROW_HEIGHT;
}

export type ClipPart = "body" | "left" | "right";

export type ClipHit =
  | { readonly kind: "ruler" }
  | { readonly kind: "region"; readonly row: number; readonly region: Region; readonly part: ClipPart }
  | { readonly kind: "row"; readonly row: number }
  | null;

/** What is under (x, y) in the strip. Edges win within `EDGE_GRAB` px (a quarter of a narrow block). */
export function clipHit(view: TimelineView, rows: readonly ClipTrackView[], x: number, y: number): ClipHit {
  if (y < 0) return null;
  if (y < CLIP_RULER_HEIGHT) return { kind: "ruler" };
  const row = Math.floor((y - CLIP_RULER_HEIGHT) / CLIP_ROW_HEIGHT);
  const track = rows[row];
  if (track === undefined) return null;
  for (const region of track.track?.regions ?? []) {
    const x0 = tickToX(view, region.timelineStart);
    const x1 = tickToX(view, regionEnd(region));
    const grab = Math.min(EDGE_GRAB, (x1 - x0) / 4);
    if (x < x0 - grab || x > x1 + grab) continue;
    const part: ClipPart = x <= x0 + grab ? "left" : x >= x1 - grab ? "right" : "body";
    return { kind: "region", row, region, part };
  }
  return { kind: "row", row };
}

export interface ClipDrawState {
  readonly view: TimelineView;
  readonly rate: FrameRate;
  readonly rows: readonly ClipTrackView[];
  readonly selected: { readonly nodeId: string; readonly regionId: string } | null;
  readonly playheadTicks: number | null;
  readonly grid: BeatGrid | null;
}

export function paintClipLanes(canvas: HTMLCanvasElement, state: ClipDrawState): void {
  const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = clipStripHeight(state.rows.length);
  if (canvas.width !== Math.floor(width * ratio)) canvas.width = Math.floor(width * ratio);
  if (canvas.height !== Math.floor(height * ratio)) canvas.height = Math.floor(height * ratio);
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const colour = (name: string): string => tokenColour(canvas, name);
  const { view } = state;
  const font = getComputedStyle(canvas).getPropertyValue("--font-mono").trim() || "monospace";

  context.fillStyle = colour("bg-sunken");
  context.fillRect(0, 0, width, height);

  // ── Ruler ──
  context.fillStyle = colour("bg-panel");
  context.fillRect(0, 0, width, CLIP_RULER_HEIGHT);
  context.font = `10px ${font}`;
  context.textBaseline = "middle";
  context.strokeStyle = colour("line");
  context.fillStyle = colour("text-dim");
  context.lineWidth = 1;
  // min:sec labels, so never finer than a second (the curve's ruler below reads frames).
  const fine = rulerStep(1 / view.ticksPerPixel, state.rate, 84);
  const step = fine.unit === "frames" ? { ticks: TICKS_PER_SECOND, unit: "seconds" as const, count: 1 } : fine;
  for (const mark of rulerMarks(view.startTicks, view.startTicks + width * view.ticksPerPixel, step)) {
    const x = Math.round(tickToX(view, mark)) + 0.5;
    context.beginPath();
    context.moveTo(x, CLIP_RULER_HEIGHT - 5);
    context.lineTo(x, height);
    context.stroke();
    context.fillText(formatMinSec(mark), x + 3, CLIP_RULER_HEIGHT / 2);
  }
  const lines = state.grid === null ? [] : gridLines(state.grid, view, width);
  for (const line of lines) {
    const x = Math.round(line.x) + 0.5;
    context.globalAlpha = line.bar === null ? 0.3 : 0.6;
    context.strokeStyle = colour("text-dim");
    context.beginPath();
    context.moveTo(x, line.bar === null ? CLIP_RULER_HEIGHT - 3 : CLIP_RULER_HEIGHT - 7);
    context.lineTo(x, height);
    context.stroke();
  }
  context.globalAlpha = 1;

  // ── Rows ──
  context.font = `9px ${font}`;
  state.rows.forEach((row, index) => {
    const top = CLIP_RULER_HEIGHT + index * CLIP_ROW_HEIGHT;
    context.strokeStyle = colour("line");
    context.beginPath();
    context.moveTo(0, top + 0.5);
    context.lineTo(width, top + 0.5);
    context.stroke();
    if (row.track === null) {
      context.fillStyle = colour("error");
      context.fillText(`${row.name ?? row.id}: ${row.error ?? "unreadable"}`, 4, top + CLIP_ROW_HEIGHT / 2);
      return;
    }
    for (const region of row.track.regions) {
      paintRegion(context, canvas, view, width, top, region, row.tempo, state.selected?.nodeId === row.id && state.selected.regionId === region.id);
    }
    context.fillStyle = colour("text-dim");
    context.globalAlpha = 0.8;
    context.fillText(row.name ?? row.id, 4, top + 6);
    context.globalAlpha = 1;
  });

  if (state.playheadTicks !== null) {
    const x = Math.round(tickToX(view, state.playheadTicks)) + 0.5;
    if (x >= 0 && x <= width) {
      context.strokeStyle = colour("signal");
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
  }
}

function paintRegion(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  view: TimelineView,
  width: number,
  top: number,
  region: Region,
  tempo: number,
  selected: boolean,
): void {
  const colour = (name: string): string => tokenColour(canvas, name);
  const x0 = tickToX(view, region.timelineStart);
  const x1 = tickToX(view, regionEnd(region));
  if (x1 < 0 || x0 > width) return;
  const y = top + 3;
  const h = CLIP_ROW_HEIGHT - 6;
  const offline = isOfflineMedia(region.media);
  const lap = lapTicks(region, tempo);
  const firstEnd = Math.min(x1, tickToX(view, region.timelineStart + lap));
  context.save();
  context.beginPath();
  context.rect(x0, y, x1 - x0, h);
  context.clip();
  // The first pass, solid.
  context.globalAlpha = offline ? 0.25 : 0.55;
  context.fillStyle = colour("signal");
  context.fillRect(x0, y, Math.max(1, firstEnd - x0), h);
  // The rest: ghosts of the pass (loop, bounce), a hold, or nothing (clear).
  if (firstEnd < x1) {
    if (region.playMode === "loop" || region.playMode === "bounce") {
      context.globalAlpha = offline ? 0.12 : 0.25;
      context.fillRect(firstEnd, y, x1 - firstEnd, h);
      context.globalAlpha = 0.8;
      context.strokeStyle = colour("bg-sunken");
      const lapPixels = lap / view.ticksPerPixel;
      if (lapPixels >= 3) {
        for (let at = firstEnd; at < x1 - 0.5; at += lapPixels) {
          context.beginPath();
          context.moveTo(Math.round(at) + 0.5, y);
          context.lineTo(Math.round(at) + 0.5, y + h);
          context.stroke();
        }
      }
    } else if (region.playMode === "onceHold") {
      context.globalAlpha = 0.3;
      context.strokeStyle = colour("signal");
      for (let at = firstEnd - h; at < x1; at += 6) {
        context.beginPath();
        context.moveTo(at, y + h);
        context.lineTo(at + h, y);
        context.stroke();
      }
    }
  }
  // Fades, as ramps across the block's top.
  context.globalAlpha = 0.6;
  context.strokeStyle = colour("text");
  if (region.fadeIn > 0 || region.fadeOut > 0) {
    context.beginPath();
    context.moveTo(x0, y + h);
    context.lineTo(tickToX(view, region.timelineStart + region.fadeIn), y);
    context.lineTo(tickToX(view, regionEnd(region) - region.fadeOut), y);
    context.lineTo(x1, y + h);
    context.stroke();
  }
  // Caption: the file, then the badge.
  context.globalAlpha = 1;
  context.fillStyle = colour(offline ? "text-dim" : "text");
  const caption = offline ? `offline · ${mediaLabel(region.media)}` : mediaLabel(region.media);
  context.fillText(caption, Math.max(x0, 0) + 4, y + h / 2 - 1);
  context.fillStyle = colour("text-dim");
  context.fillText(regionBadge(region), Math.max(x0, 0) + 4, y + h - 4);
  context.restore();
  // Outline: selected, offline (dashed), or plain.
  context.globalAlpha = 1;
  context.lineWidth = selected ? 2 : 1;
  context.strokeStyle = colour(selected ? "text" : offline ? "warn" : "signal");
  context.setLineDash(offline ? [3, 3] : []);
  context.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), h - 1);
  context.setLineDash([]);
  context.lineWidth = 1;
}
