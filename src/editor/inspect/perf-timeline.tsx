import { useCallback, useEffect, useRef, useState } from "react";
import type { TelemetrySource, TimelineWindow } from "@runtime/telemetry/index.ts";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { Button } from "@ui/primitives/button.tsx";
import { useVisibleSubscribe } from "@ui/hooks/use-visible-subscribe.ts";
import styles from "./inspect.module.css";

/**
 * The perf TIMELINE (§T1392b): the last 10–60 s of frames as a strip chart, so a spike is
 * still on screen after it happened.
 *
 * The owner: *"some sort of graph … over a time frame instead of having to only look at
 * momentary values which makes spotting spikes kinda tough"*.
 *
 * What is drawn, left (oldest) to right (now):
 *  - the frame INTERVAL — the time between two rendered frames, the main-thread cost a
 *    dropping fps is made of. A pause (transport stopped, tab hidden) is a break, not a
 *    spike;
 *  - the GPU time of each measured frame (dots), when the device reports timing;
 *  - the frame budget (1000 / fps) and the 33 ms line (30 fps), dashed;
 *  - a tick on top of every frame over twice the budget, so a one-frame spike cannot hide
 *    between pixels, and a vertical line at every recompile (and a warn line where GPU
 *    timing was lost), so "it spikes when I touch a knob" is visible as a line-up.
 *
 * Hover names the frame under the pointer: its interval, the GPU frame nearest it and that
 * frame's three dearest passes. Pause holds the picture (the ring keeps recording).
 *
 * Drawn on a canvas from the hub's <=10 Hz tick, never through React state per sample, and
 * not at all while the pane is hidden (the same visibility gate as the rest of the tab).
 */

const WINDOWS = [
  { value: "10", label: "10 s" },
  { value: "30", label: "30 s" },
  { value: "60", label: "60 s" },
] as const;

/** The vertical scale never shows less than this, so a quiet graph does not magnify noise. */
const MIN_SCALE_MS = 50;
const MAX_SCALE_MS = 200;

export interface PerfTimelineProps {
  readonly telemetry: TelemetrySource;
  /** The project's frame rate — where the budget line is drawn. */
  readonly fps: number;
}

interface Hover {
  readonly x: number;
  readonly text: string;
}

export function PerfTimeline({ telemetry, fps }: PerfTimelineProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [seconds, setSeconds] = useState<(typeof WINDOWS)[number]["value"]>("10");
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const held = useRef<TimelineWindow | null>(null);
  const shown = useRef<TimelineWindow | null>(null);

  const read = useCallback((): TimelineWindow | null => {
    if (paused && held.current !== null) return held.current;
    return telemetry.timeline?.(Number(seconds) * 1000) ?? null;
  }, [paused, seconds, telemetry]);

  const draw = useCallback(() => {
    const element = canvas.current;
    const window = read();
    shown.current = window;
    if (element === null || window === null) return;
    paint(element, window, fps);
  }, [fps, read]);

  const subscribe = useVisibleSubscribe(
    root,
    useCallback((listener: () => void) => telemetry.subscribe(listener), [telemetry]),
  );
  useEffect(() => subscribe(draw), [draw, subscribe]);
  useEffect(() => {
    draw();
  }, [draw]);

  const togglePause = () => {
    held.current = paused ? null : read();
    setPaused(!paused);
  };

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const window = shown.current;
    const element = canvas.current;
    if (window === null || element === null) return;
    const box = element.getBoundingClientRect();
    const x = event.clientX - box.left;
    setHover({ x, text: describeAt(window, x / Math.max(1, box.width)) });
  };

  if (telemetry.timeline === undefined) return null;

  return (
    <section ref={root} className={styles.timeline} aria-label="Frame timeline">
      <div className={styles.timelineBar}>
        <span className={styles.statLabel}>timeline</span>
        <EnumField
          label="Timeline window"
          value={seconds}
          options={[...WINDOWS]}
          onChange={(next) => setSeconds(next as (typeof WINDOWS)[number]["value"])}
        />
        <Button variant="outline" onClick={togglePause} aria-pressed={paused}>
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      <canvas
        ref={canvas}
        className={styles.timelineCanvas}
        data-testid="perf-timeline"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onClick={togglePause}
      />
      <div className={styles.timelineReadout} role="status">
        {hover === null ? `frame interval (line) · GPU (dots) · budget ${formatNumber(1000 / fps)} ms` : hover.text}
      </div>
    </section>
  );
}

function formatNumber(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(1);
}

/** The frame nearest `fraction` across the window, in words. Exported for its test. */
// eslint-disable-next-line react-refresh/only-export-components -- the readout's arithmetic, tested as numbers.
export function describeAt(window: TimelineWindow, fraction: number): string {
  const at = window.start + fraction * (window.end - window.start);
  let best = -1;
  for (let index = 0; index < window.frameAt.length; index += 1) {
    if (best < 0 || Math.abs((window.frameAt[index] as number) - at) < Math.abs((window.frameAt[best] as number) - at)) best = index;
  }
  if (best < 0) return "no frames in this window";
  const frameAt = window.frameAt[best] as number;
  const interval = window.intervalMs[best] as number;
  const ago = ((window.end - frameAt) / 1000).toFixed(1);
  const head = Number.isNaN(interval) ? `${ago} s ago · after a pause` : `${ago} s ago · frame ${formatNumber(interval)} ms`;
  let gpu = -1;
  for (let index = 0; index < window.gpu.length; index += 1) {
    if (gpu < 0 || Math.abs(window.gpu[index]!.at - frameAt) < Math.abs(window.gpu[gpu]!.at - frameAt)) gpu = index;
  }
  if (gpu < 0) return head;
  const sample = window.gpu[gpu]!;
  const top = sample.top.map((pass) => `${pass.passId} ${formatNumber(pass.ms)}`).join(", ");
  return `${head} · GPU ${formatNumber(sample.gpuMs)} ms${top === "" ? "" : ` (${top})`}`;
}

/** Token values, read from the canvas's own computed style (§V17: no literal colours). */
function token(element: HTMLElement, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

function paint(element: HTMLCanvasElement, window: TimelineWindow, fps: number): void {
  const ratio = element.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const width = Math.max(1, Math.floor(element.clientWidth * ratio));
  const height = Math.max(1, Math.floor(element.clientHeight * ratio));
  if (element.width !== width) element.width = width;
  if (element.height !== height) element.height = height;
  const context = element.getContext("2d");
  if (context === null) return;
  context.clearRect(0, 0, width, height);

  const budget = 1000 / Math.max(1, fps);
  let peak = 0;
  for (const value of window.intervalMs) if (Number.isFinite(value) && value > peak) peak = value;
  for (const sample of window.gpu) if (sample.gpuMs > peak) peak = sample.gpuMs;
  const scale = Math.min(MAX_SCALE_MS, Math.max(MIN_SCALE_MS, peak * 1.1, budget * 2.2));
  const span = Math.max(1, window.end - window.start);
  const x = (at: number) => ((at - window.start) / span) * width;
  const y = (ms: number) => height - (Math.min(ms, scale) / scale) * height;

  // Reference lines: the budget and 30 fps.
  context.lineWidth = ratio;
  context.setLineDash([4 * ratio, 4 * ratio]);
  for (const [ms, colour] of [
    [budget, token(element, "--ok")],
    [1000 / 30, token(element, "--warn")],
  ] as const) {
    if (ms > scale) continue;
    context.strokeStyle = colour;
    context.beginPath();
    context.moveTo(0, y(ms));
    context.lineTo(width, y(ms));
    context.stroke();
  }
  context.setLineDash([]);

  // Events: recompiles, lost timing.
  for (const mark of window.marks) {
    context.strokeStyle = token(element, mark.kind === "compile" ? "--text-dim" : "--error");
    context.beginPath();
    context.moveTo(x(mark.at), 0);
    context.lineTo(x(mark.at), height);
    context.stroke();
  }

  // Frame intervals, broken at pauses.
  context.strokeStyle = token(element, "--signal");
  context.lineWidth = 1.5 * ratio;
  context.beginPath();
  let drawing = false;
  for (let index = 0; index < window.frameAt.length; index += 1) {
    const value = window.intervalMs[index] as number;
    if (!Number.isFinite(value)) {
      drawing = false;
      continue;
    }
    const px = x(window.frameAt[index] as number);
    if (drawing) context.lineTo(px, y(value));
    else context.moveTo(px, y(value));
    drawing = true;
  }
  context.stroke();

  // Spikes: every frame over twice the budget gets a tick on top, so it cannot vanish
  // between pixels at 60 s wide.
  context.fillStyle = token(element, "--error");
  for (let index = 0; index < window.frameAt.length; index += 1) {
    const value = window.intervalMs[index] as number;
    if (Number.isFinite(value) && value > budget * 2) context.fillRect(x(window.frameAt[index] as number) - ratio, 0, 2 * ratio, 4 * ratio);
  }

  // GPU time per measured frame.
  context.fillStyle = token(element, "--port-value");
  for (const sample of window.gpu) context.fillRect(x(sample.at) - ratio, y(sample.gpuMs) - ratio, 2 * ratio, 2 * ratio);
}
