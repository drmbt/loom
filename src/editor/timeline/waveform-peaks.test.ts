import { describe, expect, it } from "vitest";
import { computeWaveformPeaks, peakColumn } from "./waveform-peaks.ts";
import { paintWaveform } from "./timeline-draw.ts";
import { DEFAULT_VIEW } from "./timeline-view.ts";

const RATE = 48_000;

/** `seconds` of a sine at `hz` and `amplitude`, then `silence` seconds of zero. */
function tone(hz: number, amplitude: number, seconds: number, silence = 0): Float32Array {
  const out = new Float32Array(Math.round((seconds + silence) * RATE));
  for (let i = 0; i < seconds * RATE; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

describe("waveform peaks (VN64, ported from ltc-lab)", () => {
  it("has one bin per hundredth of a second, holding the exact sample extremes", () => {
    // 1 kHz at 48 kHz is 48 samples a cycle, so sample 12 is the crest exactly.
    const peaks = computeWaveformPeaks(tone(1000, 0.5, 1, 1), RATE);
    expect(peaks.bins).toBe(200);
    expect(peaks.durationSeconds).toBe(2);
    expect(peaks.max[10]).toBe(0.5);
    expect(peaks.min[10]).toBe(-0.5);
    expect(peaks.max[150]).toBe(0);
    expect(peaks.min[150]).toBe(0);
  });

  it("moves energy between bands as the sound does: 1 kHz then 100 Hz", () => {
    // Each band is normalised to its own 98th percentile over the file (ltc-lab's rule), so a
    // band reads how active it is NOW against the rest of the track, not against other bands.
    const samples = new Float32Array(2 * RATE);
    samples.set(tone(1000, 0.5, 1), 0);
    samples.set(tone(100, 0.5, 1), RATE);
    const peaks = computeWaveformPeaks(samples, RATE);
    const first = peakColumn(peaks, 0.3, 0.7)!;
    const second = peakColumn(peaks, 1.3, 1.7)!;
    expect(first.midWeight).toBeGreaterThan(0.9);
    expect(second.midWeight).toBeLessThan(0.2);
    expect(second.lowWeight).toBeGreaterThan(first.lowWeight * 5);
  });

  it("folds every bin under a column, so a transient narrower than a pixel still shows", () => {
    const samples = new Float32Array(RATE);
    samples[RATE / 2 + 7] = 0.9;
    const peaks = computeWaveformPeaks(samples, RATE);
    expect(peakColumn(peaks, 0.4, 0.6)!.max).toBeCloseTo(0.9, 6);
    expect(peakColumn(peaks, 0.1, 0.2)!.max).toBe(0);
    expect(peakColumn(peaks, 1.5, 1.6)).toBeNull();
  });
});

describe("painting the waveform", () => {
  const strongestAt = (columns: Array<{ x: number; colour: string; alpha: number }>, x: number): string =>
    columns.filter((column) => column.x === x).reduce((best, column) => (column.alpha > best.alpha ? column : best)).colour;

  /** A context that records the columns drawn. */
  function recorder() {
    const columns: Array<{ x: number; y: number; h: number; colour: string; alpha: number }> = [];
    const context = {
      fillStyle: "",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      fillRect(x: number, y: number, _w: number, h: number) {
        columns.push({ x, y, h, colour: this.fillStyle, alpha: this.globalAlpha });
      },
    };
    return { columns, context: context as unknown as CanvasRenderingContext2D };
  }
  const canvas = { ownerDocument: globalThis.document } as unknown as Element;

  it("draws the media only where the timeline plays it, with heights from the peaks", () => {
    // 0.5 s of full-scale tone, then 0.5 s of silence; the media starts 1 s into the timeline.
    const peaks = computeWaveformPeaks(tone(1000, 1, 0.5, 0.5), RATE);
    const { columns, context } = recorder();
    const original = globalThis.getComputedStyle;
    // Each token reads back as its own name, so the test sees which token a column drew with.
    globalThis.getComputedStyle = (() => ({ getPropertyValue: (name: string) => name })) as unknown as typeof getComputedStyle;
    try {
      // DEFAULT_VIEW: 100 px a second from tick 0.
      paintWaveform(context, canvas, DEFAULT_VIEW, 300, 100, {
        peaks,
        mediaSecondsAt: (ticks) => {
          const seconds = ticks / 240_000 - 1;
          return seconds < 0 || seconds > 1 ? null : seconds;
        },
      });
    } finally {
      globalThis.getComputedStyle = original;
    }
    const xs = columns.map((column) => column.x);
    expect(Math.min(...xs)).toBe(100);
    expect(Math.max(...xs)).toBeLessThanOrEqual(200);
    // Loud columns reach 45 % of the height either side of the centre; silent ones are a line.
    expect(columns.find((column) => column.x === 120)!.h).toBeCloseTo(90, 5);
    expect(columns.find((column) => column.x === 170)!.h).toBe(1);

  });

  it("colours a column by its band mix, from the axis tokens: mid is the Y green, low the X red", () => {
    const samples = new Float32Array(2 * RATE);
    samples.set(tone(1000, 0.5, 1), 0);
    samples.set(tone(100, 0.5, 1), RATE);
    const peaks = computeWaveformPeaks(samples, RATE);
    const { columns, context } = recorder();
    const original = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (() => ({ getPropertyValue: (name: string) => name })) as unknown as typeof getComputedStyle;
    try {
      paintWaveform(context, canvas, DEFAULT_VIEW, 200, 100, { peaks, mediaSecondsAt: (ticks) => ticks / 240_000 });
    } finally {
      globalThis.getComputedStyle = original;
    }
    expect(strongestAt(columns, 50)).toBe("--axis-y");
    expect(strongestAt(columns, 150)).toBe("--axis-x");
  });
});
