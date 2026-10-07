import { describe, expect, it } from "vitest";

import { newKey, newLane, serializeAutomation } from "../../domain/automation/model.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { automationNode, playheadTicks } from "./automation.ts";

const S = 240_000;
// A ramp from 0 at 1 s to 1 at 2 s, mapped to 0..100, and a stepped lane.
const LANES = serializeAutomation({
  version: 1,
  lanes: [
    newLane("lane1", "level", [newKey("a", S, 0, { interp: "linear" }), newKey("b", 2 * S, 1)], { min: 0, max: 100 }),
    newLane("lane2", "step", [newKey("a", 0, 0), newKey("b", 3 * S, 1)], { stepped: true }),
  ],
});

const frameAt = (frameIndex: number, fps?: number, subframes?: number): FrameEvaluationInput => ({
  frameIndex,
  timeSeconds: fps === undefined ? frameIndex / 60 : frameIndex / (fps * (subframes ?? 1)),
  deltaSeconds: 1 / 60,
  mode: "offline",
  randomSeed: 1,
  ...(fps === undefined ? {} : { fps }),
  ...(subframes === undefined ? {} : { subframes }),
});

const evaluate = (values: Record<string, ParameterValue>, frame: FrameEvaluationInput) =>
  automationNode.valueEvaluate!({ inputs: {}, values: { index: "playhead", indexValue: 0, sampleRate: 48_000, lanes: LANES, ...values }, frame, state: {} });

describe("VN61 — the automation node", () => {
  it("publishes one channel per lane, named for the lane, read at the playhead", () => {
    expect(evaluate({}, frameAt(45, 30))).toEqual({ level: 50, step: 0 });
    expect(evaluate({}, frameAt(60, 30))).toEqual({ level: 100, step: 0 });
    expect(evaluate({}, frameAt(0, 30))).toEqual({ level: 0, step: 0 });
    expect(evaluate({}, frameAt(90, 30))).toEqual({ level: 100, step: 1 });
  });

  it("the playhead is integer ticks at 29.97, with sub-frames, and timeSeconds without an fps", () => {
    expect(playheadTicks(frameAt(1800, 29.97))).toBe(1800 * 8_008);
    expect(playheadTicks(frameAt(3, 30, 2))).toBe(12_000);
    expect(playheadTicks(frameAt(30))).toBe(120_000);
  });

  it("reads Index Value in frames, seconds, samples or a fraction of the node's span", () => {
    expect(evaluate({ index: "frames", indexValue: 45 }, frameAt(0, 30)).level).toBe(50);
    expect(evaluate({ index: "seconds", indexValue: 1.25 }, frameAt(0, 30)).level).toBe(25);
    expect(evaluate({ index: "samples", indexValue: 72_000, sampleRate: 48_000 }, frameAt(0, 30)).level).toBe(50);
    // One span for the node: 0 (lane2's first key) to 3 s (its last). 0.5 → 1.5 s for EVERY lane.
    expect(evaluate({ index: "fraction", indexValue: 0.5 }, frameAt(0, 30))).toEqual({ level: 50, step: 0 });
    expect(evaluate({ index: "fraction", indexValue: 1 }, frameAt(0, 30))).toEqual({ level: 100, step: 1 });
  });

  it("lanes that do not parse publish no channels, so readers report the missing channel", () => {
    expect(evaluate({ lanes: "{" }, frameAt(0, 30))).toEqual({});
    expect(evaluate({ lanes: "" }, frameAt(0, 30))).toEqual({});
  });
});
