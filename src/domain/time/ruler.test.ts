import { describe, expect, it } from "vitest";

import { rulerMarks, rulerStep } from "./ruler.ts";
import { TICKS_PER_SECOND, rateOf } from "./ticks.ts";

describe("VN61 — the ruler's level of detail", () => {
  const rate = rateOf(30);
  // pixels per tick for "this many pixels per second".
  const zoom = (pixelsPerSecond: number): number => pixelsPerSecond / TICKS_PER_SECOND;

  it("walks frames → seconds → minutes → hours as it zooms out", () => {
    expect(rulerStep(zoom(30 * 64), rate)).toEqual({ ticks: 8_000, unit: "frames", count: 1 });
    expect(rulerStep(zoom(30 * 64) / 4, rate)).toEqual({ ticks: 40_000, unit: "frames", count: 5 });
    expect(rulerStep(zoom(64), rate)).toEqual({ ticks: TICKS_PER_SECOND, unit: "seconds", count: 1 });
    expect(rulerStep(zoom(64 / 60), rate).unit).toBe("minutes");
    expect(rulerStep(zoom(64 / 3600), rate)).toEqual({ ticks: 3600 * TICKS_PER_SECOND, unit: "hours", count: 1 });
    // Further out than a day per 64 px: the coarsest step, never a throw.
    expect(rulerStep(zoom(1e-6), rate).count).toBe(24);
  });

  it("labels sit at least minPixels apart at every zoom", () => {
    for (let pixelsPerSecond = 1e-3; pixelsPerSecond < 1e5; pixelsPerSecond *= 1.7) {
      const step = rulerStep(zoom(pixelsPerSecond), rate, 50);
      if (step.count === 24 && step.unit === "hours") continue;
      expect(step.ticks * zoom(pixelsPerSecond)).toBeGreaterThanOrEqual(50);
    }
  });

  it("frame steps follow the rate (whole ticks at 29.97)", () => {
    expect(rulerStep(zoom(30 * 64), rateOf(29.97))).toEqual({ ticks: 8_008, unit: "frames", count: 1 });
  });

  it("marks are aligned to multiples of the step", () => {
    expect(rulerMarks(100_000, 800_000, { ticks: 240_000, unit: "seconds", count: 1 })).toEqual([240_000, 480_000, 720_000]);
  });
});
