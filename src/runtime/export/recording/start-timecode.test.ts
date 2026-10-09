import { describe, expect, it } from "vitest";
import { defaultStartTimecode, parseStartTimecode, resolveStartTimecode, timecodeTrackFor } from "./start-timecode.ts";

const NTSC = 30000 / 1001;

describe("export start timecode (VN104)", () => {
  it("defaults to 00:00:00:00 plus the in point, counted at the output rate", () => {
    expect(defaultStartTimecode(0, 30)).toBe("00:00:00:00");
    expect(defaultStartTimecode(75, 25)).toBe("00:00:03:00");
    expect(defaultStartTimecode(0, NTSC)).toBe("00:00:00;00");
    // 1800 frames at 29.97 drop-frame: labels ;00 and ;01 of minute 1 are skipped.
    expect(defaultStartTimecode(1800, NTSC)).toBe("00:01:00;02");
  });

  it("resolves the dialog's text first, else the in point's default", () => {
    expect(resolveStartTimecode("01:00:00:00", 90, 30)).toMatchObject({ frame: 108_000, label: "01:00:00:00" });
    expect(resolveStartTimecode("  ", 90, 30)).toMatchObject({ frame: 90, label: "00:00:03:00" });
    expect(resolveStartTimecode(undefined, 1800, NTSC)).toMatchObject({ frame: 1800, dropFrame: true, label: "00:01:00;02" });
    expect(resolveStartTimecode("nope", 0, 30)).toHaveProperty("error");
  });

  it("parses drop-frame labels to their frame count, not their digits", () => {
    expect(parseStartTimecode("01:00:00;02", NTSC)).toEqual({ frame: 107_894, dropFrame: true, label: "01:00:00;02", fps: NTSC });
    expect(parseStartTimecode("01:00:00:02", NTSC)).toMatchObject({ frame: 108_002, dropFrame: false, label: "01:00:00:02" });
    expect(parseStartTimecode("1.12", 25)).toMatchObject({ frame: 37, label: "00:00:01:12" });
  });

  it("refuses drop-frame at a rate without it, and labels drop-frame never uses", () => {
    expect(parseStartTimecode("01:00:00;00", 25)).toHaveProperty("error");
    expect(parseStartTimecode("00:01:00;00", NTSC)).toHaveProperty("error");
    expect(parseStartTimecode("abc", 30)).toHaveProperty("error");
  });

  it("counts the tmcd track in the video's timescale at the nominal rate", () => {
    expect(timecodeTrackFor({ frame: 5, dropFrame: true }, NTSC)).toEqual({
      startFrame: 5, dropFrame: true, framesPerSecond: 30, timescale: 29970, frameDuration: 1000,
    });
  });
});
