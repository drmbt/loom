import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../../../domain/expressions/evaluate.ts";
import { shutterClock } from "./motion.ts";

/**
 * T1407b (prism) — render.ts --final averages 8 sub-frames per output frame, stepping abstime
 * across the whole frame. The prism's fast rise, clocked on abstime, smeared the figure and
 * its shadow into ghosts. A shot that shoots at a narrow shutter must see every sub-frame of
 * frame k inside the first shutter/360 of that frame, and a draft (one sub-frame) must see
 * exactly k/24 — so a draft and a final agree on where each frame starts.
 */
const at = (source: string, abstime: number, fps = 24): number => {
  const result = evaluateExpression(source, { abstime, fps });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
};

describe("shutterClock", () => {
  it("squeezes a frame's eight sub-frames into its first 90 degrees", () => {
    const clock = shutterClock(90);
    for (const frame of [0, 5, 13]) {
      const times = Array.from({ length: 8 }, (_, j) => at(clock, (frame * 8 + j) / (24 * 8)));
      expect(times[0]).toBeCloseTo(frame / 24, 6);
      // the last sub-frame is 7/8 of the way through a quarter of the frame, not 7/8 of the frame
      expect(times[7]! - times[0]!).toBeCloseTo((7 / 8) * (90 / 360) / 24, 6);
      for (const t of times) expect(t).toBeLessThan((frame + 0.25) / 24);
    }
  });

  it("is abstime itself on a whole frame (a draft renders one sub-frame per frame)", () => {
    const clock = shutterClock(90);
    for (const frame of [0, 1, 7, 23, 100]) expect(at(clock, frame / 24)).toBeCloseTo(frame / 24, 6);
  });

  it("at 360 degrees steps across the whole frame, as abstime does", () => {
    const clock = shutterClock(360);
    for (const j of [0, 3, 7]) expect(at(clock, (5 * 8 + j) / 192)).toBeCloseTo((5 * 8 + j) / 192, 6);
  });
});
