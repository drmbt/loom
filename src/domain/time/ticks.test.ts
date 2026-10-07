import { describe, expect, it } from "vitest";

import {
  TICKS_PER_SECOND,
  framesToTicks,
  isOnFrame,
  rateFps,
  rateOf,
  retimeTicks,
  samplesToTicks,
  snapTicksToFrame,
  ticksPerFrame,
  ticksToFrames,
} from "./ticks.ts";

describe("VN61 — ticks, 240 000 per second", () => {
  it("every broadcast rate is a whole number of ticks per frame", () => {
    const table: [number, number][] = [
      [24, 10_000], [25, 9_600], [30, 8_000], [50, 4_800], [60, 4_000],
      [23.976, 10_010], [29.97, 8_008], [59.94, 4_004], [47.952, 5_005], [119.88, 2_002],
    ];
    for (const [fps, ticks] of table) expect([fps, ticksPerFrame(rateOf(fps))]).toEqual([fps, ticks]);
    expect(samplesToTicks(1, 48_000)).toBe(5);
  });

  it("recognises the 1001 family from any spelling and keeps it exact", () => {
    expect(rateOf(29.97)).toEqual({ num: 30_000, den: 1001 });
    expect(rateOf(30_000 / 1001)).toEqual({ num: 30_000, den: 1001 });
    expect(rateOf(59.94)).toEqual({ num: 60_000, den: 1001 });
    expect(rateOf(23.976)).toEqual({ num: 24_000, den: 1001 });
    expect(rateOf(30)).toEqual({ num: 30, den: 1 });
    // Not every decimal is NTSC: 29.5 stays itself.
    expect(rateOf(29.5)).toEqual({ num: 29.5, den: 1 });
    expect(rateFps(rateOf(29.97))).toBe(30_000 / 1001);
    expect(() => rateOf(0)).toThrow(/positive/);
  });

  it("frames ↔ ticks is integer-exact at 29.97 across a whole day", () => {
    const rate = rateOf(29.97);
    const day = Math.floor((24 * 3600 * 30_000) / 1001);
    for (const frame of [0, 1, 1800, 17_982, 107_892, day]) {
      const ticks = framesToTicks(frame, rate);
      expect(Number.isInteger(ticks)).toBe(true);
      expect(ticks).toBe(frame * 8_008);
      expect(ticksToFrames(ticks, rate)).toBe(frame);
      expect(isOnFrame(ticks, rate)).toBe(true);
      expect(isOnFrame(ticks + 1, rate)).toBe(false);
    }
    expect(framesToTicks(24 * 3600 * 60, rateOf(60))).toBe(24 * 3600 * TICKS_PER_SECOND);
  });

  it("snaps a tick to the nearest frame boundary", () => {
    const rate = rateOf(30);
    expect(snapTicksToFrame(3_999, rate)).toBe(0);
    expect(snapTicksToFrame(4_000, rate)).toBe(8_000);
    expect(snapTicksToFrame(12_001, rate)).toBe(16_000);
  });

  it("an fps change keeps time by default and can keep frames", () => {
    const from = rateOf(30);
    const to = rateOf(60);
    // Frame 30 at 30 fps is one second.
    expect(retimeTicks(240_000, "keepTime", from, to)).toBe(240_000);
    // Keep frames: frame 30 stays frame 30, which at 60 fps is half a second.
    expect(retimeTicks(240_000, "keepFrames", from, to)).toBe(120_000);
    expect(ticksToFrames(retimeTicks(framesToTicks(1234, rateOf(25)), "keepFrames", rateOf(25), rateOf(29.97)), rateOf(29.97))).toBe(1234);
  });
});
