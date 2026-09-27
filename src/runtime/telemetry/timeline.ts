/**
 * The performance TIMELINE (§T1392b): what every recent frame cost, kept long enough to
 * see a spike after it happened.
 *
 * The owner: *"some sort of graph … to get a quick overview over a time frame instead of
 * having to only look at momentary values which makes spotting spikes kinda tough"*. The
 * rest of the telemetry is a 10 Hz snapshot of the LATEST numbers, and a spike that lasts
 * one frame is gone by the next tick. So this keeps a fixed ring per kind of reading:
 *
 *  - frames: the time a frame was noted and the interval since the previous one (the
 *    main-thread cost the owner sees as a drop in fps);
 *  - gpu: the submit extent of a measured frame and its three dearest passes, stamped
 *    when the timer resolves (a few frames after the frame itself);
 *  - marks: events worth lining up against a spike — a recompile, lost GPU timing.
 *
 * Fixed-capacity typed arrays written in place: noting a frame allocates nothing (§V16),
 * and nothing here notifies anyone — the hub's own tick does that. Readers get copies of
 * the window they ask for, so a pause can hold a picture while the ring keeps running.
 */

export type TimelineMarkKind = "compile" | "timing-lost";

export interface TimelineGpuSample {
  readonly at: number;
  readonly gpuMs: number;
  /** The dearest passes of that frame, most expensive first, at most three. */
  readonly top: ReadonlyArray<{ readonly passId: string; readonly ms: number }>;
}

export interface TimelineMark {
  readonly at: number;
  readonly kind: TimelineMarkKind;
}

/** A window of the timeline, oldest first, in the `performance.now()` domain. */
export interface TimelineWindow {
  readonly start: number;
  readonly end: number;
  /** Frame times and the interval before each, in ms, parallel arrays. NaN = after a pause. */
  readonly frameAt: readonly number[];
  readonly intervalMs: readonly number[];
  readonly gpu: readonly TimelineGpuSample[];
  readonly marks: readonly TimelineMark[];
}

export interface FrameTimeline {
  noteFrame(at: number): void;
  noteGpu(at: number, gpuMs: number, spans: Readonly<Record<string, number>>): void;
  mark(at: number, kind: TimelineMarkKind): void;
  /** Everything from `now - spanMs` to `now`. */
  window(now: number, spanMs: number): TimelineWindow;
  clear(): void;
}

/** At 120 Hz, 60 s of frames. */
export const TIMELINE_FRAME_CAPACITY = 7200;
const GPU_CAPACITY = 7200;
const MARK_CAPACITY = 256;
/** Longer than this between two frames is a pause, not a frame time. */
export const GAP_MS = 1000;

export function createFrameTimeline(frameCapacity = TIMELINE_FRAME_CAPACITY): FrameTimeline {
  const frameAt = new Float64Array(frameCapacity);
  const interval = new Float32Array(frameCapacity);
  let frameHead = 0;
  let frameCount = 0;
  let lastFrame: number | null = null;

  const gpu: Array<TimelineGpuSample | undefined> = new Array(GPU_CAPACITY);
  let gpuHead = 0;
  let gpuCount = 0;

  const marks: Array<TimelineMark | undefined> = new Array(MARK_CAPACITY);
  let markHead = 0;
  let markCount = 0;

  return {
    noteFrame(at) {
      frameAt[frameHead] = at;
      // A gap longer than GAP_MS is a pause (transport stopped, tab hidden), not a slow
      // frame: it is recorded as a break in the line (NaN), never as a spike.
      interval[frameHead] = lastFrame === null || at - lastFrame > GAP_MS ? Number.NaN : at - lastFrame;
      lastFrame = at;
      frameHead = (frameHead + 1) % frameCapacity;
      if (frameCount < frameCapacity) frameCount += 1;
    },
    noteGpu(at, gpuMs, spans) {
      const top = Object.entries(spans)
        .filter(([, ms]) => Number.isFinite(ms))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([passId, ms]) => ({ passId, ms }));
      gpu[gpuHead] = { at, gpuMs, top };
      gpuHead = (gpuHead + 1) % GPU_CAPACITY;
      if (gpuCount < GPU_CAPACITY) gpuCount += 1;
    },
    mark(at, kind) {
      marks[markHead] = { at, kind };
      markHead = (markHead + 1) % MARK_CAPACITY;
      if (markCount < MARK_CAPACITY) markCount += 1;
    },
    window(now, spanMs) {
      const start = now - spanMs;
      const outAt: number[] = [];
      const outInterval: number[] = [];
      for (let index = 0; index < frameCount; index += 1) {
        const slot = (frameHead - frameCount + index + frameCapacity) % frameCapacity;
        const at = frameAt[slot] as number;
        if (at < start || at > now) continue;
        outAt.push(at);
        outInterval.push(interval[slot] as number);
      }
      const outGpu: TimelineGpuSample[] = [];
      for (let index = 0; index < gpuCount; index += 1) {
        const sample = gpu[(gpuHead - gpuCount + index + GPU_CAPACITY) % GPU_CAPACITY];
        if (sample !== undefined && sample.at >= start && sample.at <= now) outGpu.push(sample);
      }
      const outMarks: TimelineMark[] = [];
      for (let index = 0; index < markCount; index += 1) {
        const entry = marks[(markHead - markCount + index + MARK_CAPACITY) % MARK_CAPACITY];
        if (entry !== undefined && entry.at >= start && entry.at <= now) outMarks.push(entry);
      }
      return { start, end: now, frameAt: outAt, intervalMs: outInterval, gpu: outGpu, marks: outMarks };
    },
    clear() {
      frameHead = 0;
      frameCount = 0;
      lastFrame = null;
      gpuHead = 0;
      gpuCount = 0;
      markHead = 0;
      markCount = 0;
    },
  };
}
