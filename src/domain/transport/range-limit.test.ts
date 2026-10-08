import { describe, expect, it } from "vitest";

import { frameRangeLimit, rangeLimitSentence } from "./range-limit.ts";

describe("the range cap (VN71/T1687b)", () => {
  it("is one SMPTE day of frames at the project rate, inclusive", () => {
    expect(frameRangeLimit(60)).toBe(5_183_999);
    expect(frameRangeLimit(24)).toBe(2_073_599);
    // The gate's hour fits, and so does the three-minute piece T1687b could not hold.
    expect(frameRangeLimit(60)).toBeGreaterThan(216_000);
  });

  it("says what the cap is in the sentence a clamped range reports", () => {
    expect(rangeLimitSentence(1e9, 60)).toBe(
      "Frame 1000000000 is past the timeline limit 5183999: one day at 60 fps is the longest range a project holds.",
    );
  });
});
