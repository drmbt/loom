import { describe, expect, it } from "vitest";

import { rateOf } from "./ticks.ts";
import {
  formatTimecode,
  frameToTimecode,
  parseTimecodeEntry,
  supportsDropFrame,
  ticksToTimecode,
  timecodeToFrame,
  timecodeToTicks,
} from "./timecode.ts";

const tc = (frame: number, fps: number, df = false): string => formatTimecode(frameToTimecode(frame, rateOf(fps), df));

describe("VN61 — SMPTE timecode", () => {
  it("non-drop counts the nominal rate", () => {
    expect(tc(0, 25)).toBe("00:00:00:00");
    expect(tc(25 * 3661 + 7, 25)).toBe("01:01:01:07");
    expect(tc(1800, 29.97)).toBe("00:01:00:00");
  });

  it("drop-frame skips 00 and 01 each minute except every tenth (29.97)", () => {
    expect(tc(1799, 29.97, true)).toBe("00:00:59;29");
    expect(tc(1800, 29.97, true)).toBe("00:01:00;02");
    expect(tc(17_981, 29.97, true)).toBe("00:09:59;29");
    expect(tc(17_982, 29.97, true)).toBe("00:10:00;00");
    // One hour of DF labels is 107 892 frames: the 3.6 s NDF loses.
    expect(tc(107_892, 29.97, true)).toBe("01:00:00;00");
    expect(tc(107_892, 29.97, false)).toBe("00:59:56:12");
  });

  it("drop-frame at 59.94 skips four labels", () => {
    expect(tc(3599, 59.94, true)).toBe("00:00:59;59");
    expect(tc(3600, 59.94, true)).toBe("00:01:00;04");
    expect(tc(215_784, 59.94, true)).toBe("01:00:00;00");
  });

  it("round-trips every frame of a whole day, DF and NDF", () => {
    for (const fps of [29.97, 59.94]) {
      const rate = rateOf(fps);
      const day = Math.round((24 * 3600 * rate.num) / rate.den);
      // Every 997th frame (prime, so it lands on every minute phase) plus the minute edges.
      const probes = new Set<number>();
      for (let frame = 0; frame < day; frame += 997) probes.add(frame);
      for (let minute = 0; minute < 24 * 60; minute += 1) {
        const label = timecodeToFrame({ hours: Math.floor(minute / 60), minutes: minute % 60, seconds: 0, frames: minute % 10 === 0 ? 0 : fps > 30 ? 4 : 2, dropFrame: true }, rate);
        probes.add(label);
        probes.add(label - 1);
      }
      for (const frame of probes) {
        if (frame < 0) continue;
        for (const df of [true, false]) expect(timecodeToFrame(frameToTimecode(frame, rate, df), rate)).toBe(frame);
      }
    }
  });

  it("refuses a label drop-frame never uses, and DF at a rate that has none", () => {
    expect(() => timecodeToFrame({ hours: 0, minutes: 1, seconds: 0, frames: 0, dropFrame: true }, rateOf(29.97))).toThrow(/not a drop-frame label/);
    expect(() => frameToTimecode(10, rateOf(25), true)).toThrow(/no drop-frame/);
    expect(supportsDropFrame(rateOf(29.97))).toBe(true);
    expect(supportsDropFrame(rateOf(23.976))).toBe(false);
    expect(supportsDropFrame(rateOf(30))).toBe(false);
  });

  it("ticks ↔ timecode go through the frame", () => {
    const rate = rateOf(29.97);
    const label = { hours: 0, minutes: 10, seconds: 0, frames: 0, dropFrame: true };
    expect(timecodeToTicks(label, rate)).toBe(17_982 * 8_008);
    expect(formatTimecode(ticksToTimecode(17_982 * 8_008 + 8_007, rate, true))).toBe("00:10:00;00");
  });

  it("typed entry is right-aligned and carries overflow", () => {
    const rate = rateOf(30);
    expect(parseTimecodeEntry("1.12", rate)).toEqual({ frame: 42 });
    expect(parseTimecodeEntry("11200", rate)).toEqual({ frame: (60 + 12) * 30 });
    expect(parseTimecodeEntry("01:00:00:00", rate)).toEqual({ frame: 108_000 });
    expect(parseTimecodeEntry("90", rate)).toEqual({ frame: 90 });
    expect(parseTimecodeEntry("00:01:00;02", rateOf(29.97))).toEqual({ frame: 1800 });
    expect(parseTimecodeEntry("00:01:00;00", rateOf(29.97))).toHaveProperty("error");
    expect(parseTimecodeEntry("1h", rate)).toHaveProperty("error");
    expect(parseTimecodeEntry("1:2:3:4:5", rate)).toHaveProperty("error");
  });
});
