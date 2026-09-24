import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1370b — the structure nodes, by their own arithmetic (§V147): a ramp of slope 2 rises by
 * exactly 2 across a 1 s window; a hit every 15 frames at 60 fps is exactly 4 per second; a
 * step from 1 to 3 is novelty |3−1| ÷ (3+1) = 0.5 once both windows hold one side each; a
 * counter counts crossings, not frames, and honours its hold-off; a delay of 2 hands back
 * frame k−2. Driven through the real session with a `constant` rewritten per frame.
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const FPS = 60;
const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / FPS,
  deltaSeconds: 1 / FPS,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

function run(type: string, parameters: Record<string, unknown>, signal: readonly number[]): Array<Record<string, number>> {
  const doc = {
    revision: 1,
    groups: {},
    nodes: {
      src: { id: "src", type: "constant", definitionVersion: 1, position: { x: 0, y: 0 }, label: "src1", parameters: { value: 0 } },
      subject: { id: "subject", type, definitionVersion: 1, position: { x: 0, y: 0 }, label: "subject1", parameters },
    },
    edges: { e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "subject", portId: "in" } } },
  } as unknown as GraphDocument;
  const session = createValueGraphSession(registry);
  return signal.map((value, index) => {
    (doc.nodes["src"]!.parameters as Record<string, unknown>)["value"] = value;
    const result = session.evaluate(doc, frameAt(index));
    expect(result.diagnostics).toEqual([]);
    return result.byName.get("subject1")!;
  });
}

describe("T1370b — the structure nodes", () => {
  it("Trend: a ramp of slope 2 rises by exactly 1 across a 0.5 s window, however it is offset", () => {
    // Half a second, not one: at a 1 s window "the rise across the window" and "the slope per
    // second" are the same number, and a test that cannot tell them apart proves neither.
    const ramp = Array.from({ length: 120 }, (_, k) => 5 + (2 * k) / FPS);
    const read = run("valueTrend", { window: 0.5 }, ramp);
    expect(read[0]!["value"]).toBe(0); // one sample fits no line
    expect(read[119]!["value"]).toBeCloseTo(1, 9);
    // A held signal has no trend.
    expect(run("valueTrend", { window: 1 }, new Array(90).fill(0.7))[89]!["value"]).toBeCloseTo(0, 12);
  });

  it("Rate: a hit every 15 frames at 60 fps is exactly 4 per second over a 1 s window", () => {
    const hits = Array.from({ length: 180 }, (_, k) => (k % 15 === 0 ? 1 : 0));
    const read = run("valueRate", { window: 1 }, hits);
    for (const frame of [60, 99, 179]) expect(read[frame]!["value"]).toBe(4);
  });

  it("Novelty: a step from 1 to 3 reads |3−1| ÷ (3+1) = 0.5 once each window holds one side", () => {
    const step = Array.from({ length: 200 }, (_, k) => (k < 100 ? 1 : 3));
    const read = run("valueNovelty", { recent: 0.5, reference: 1 }, step);
    expect(read[99]!["novelty"]).toBe(0); // the same sound on both sides
    // 30 frames after the step the recent 0.5 s is all 3 and the reference 1 s before it all 1.
    expect(read[129]!["novelty"]).toBeCloseTo(0.5, 12);
    // …and once the reference has also turned over, it is the same sound again.
    expect(read[199]!["novelty"]).toBe(0);
  });

  it("Count: counts crossings, not held frames, honours the hold-off, and reports seconds since", () => {
    //            frame: 0  1  2  3  4  5  6  7  8  9
    const pulses = [0, 1, 1, 0, 1, 0, 0, 0, 0, 1];
    // Hold-off 0.05 s = 3 frames: the crossing on frame 4 is 3 frames after frame 1 → counts;
    // with a hold-off of 0.1 s (6 frames) it would not.
    const read = run("valueCount", { threshold: 0.5, holdoff: 0.05 }, pulses);
    expect(read.map((bag) => bag["value"])).toEqual([0, 1, 1, 1, 2, 2, 2, 2, 2, 3]);
    expect(read[8]!["valueSince"]).toBeCloseTo(4 / FPS, 12);
    expect(read[9]!["valueSince"]).toBe(0);
    const strict = run("valueCount", { threshold: 0.5, holdoff: 0.1 }, pulses);
    expect(strict.map((bag) => bag["value"])).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  });

  it("Delay: two frames back, the first value until the history exists", () => {
    const read = run("valueDelay", { frames: 2 }, [10, 20, 30, 40, 50]);
    expect(read.map((bag) => bag["value"])).toEqual([10, 10, 10, 20, 30]);
  });
});
