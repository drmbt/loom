import { describe, expect, it } from "vitest";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { TimelineReference } from "@domain/media/timeline-reference.ts";
import { audioFileInNode } from "@nodes/definitions/audio.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { defaultParameters } from "@domain/parameters/validate.ts";
import { rateOf, ticksToSeconds } from "@domain/time/ticks.ts";
import { beatGridOf, snapToGrid } from "./beat-grid.ts";
import { snapTicks } from "./timeline-edits.ts";
import { gridLines } from "./timeline-draw.ts";
import { DEFAULT_VIEW } from "./timeline-view.ts";

const S = 240_000;
const REFERENCE: TimelineReference = { nodeId: "a" as never, type: "audioFileIn", name: "audiofile_reference", how: "named", warning: null };

const graphWith = (parameters: Record<string, unknown>, type = "audioFileIn"): GraphDocument =>
  ({ revision: 0, edges: {}, groups: {}, nodes: { a: { id: "a", type, definitionVersion: 1, position: { x: 0, y: 0 }, label: "audiofile_reference", parameters } } }) as unknown as GraphDocument;

const DECLARED = { playMode: "timeline", tempoMode: "declared", bpm: 120, beatOffset: 0.5, beatsPerBar: 4 };

/** The node's own published beat clock at a timeline second: what a snapped key must agree with. */
function nodeChannels(parameters: Record<string, unknown>, seconds: number) {
  const values = { ...defaultParameters(effectiveParameterSchema(audioFileInNode, {})), ...parameters };
  const frame = { frameIndex: 0, timeSeconds: seconds, deltaSeconds: 1 / 60, mode: "offline", randomSeed: 1, fps: 60 } as FrameEvaluationInput;
  return audioFileInNode.valueEvaluate!({ inputs: {}, values, frame } as never) as Record<string, number>;
}

describe("the beat grid from the reference's declared tempo (VN68)", () => {
  it("snaps a position to the nearest bar, beat, eighth and sixteenth", () => {
    const grid = beatGridOf(graphWith(DECLARED), REFERENCE)!;
    // 120 bpm, beat one at 0.5 s: beats every 0.5 s from 0.5, bars every 2 s from 0.5.
    const at = 0.9 * S;
    expect(snapToGrid(at, grid, "beats")).toBe(1.0 * S);
    expect(snapToGrid(at, grid, "bars")).toBe(0.5 * S);
    expect(snapToGrid(at, grid, "eighths")).toBe(1.0 * S);
    expect(snapToGrid(at, grid, "sixteenths")).toBe(0.875 * S);
  });

  it("lands where the node itself counts a bar, under trim and speed", () => {
    const parameters = { ...DECLARED, trimStart: 1, speed: 2 };
    const grid = beatGridOf(graphWith(parameters), REFERENCE)!;
    for (const guess of [0.3, 1.7, 4.2]) {
      const snapped = snapToGrid(guess * S, grid, "bars");
      const channels = nodeChannels(parameters, ticksToSeconds(snapped));
      // On a bar line: the node's bar phase is zero (to the tick's rounding).
      expect(Math.min(channels["barPhase"]!, 1 - channels["barPhase"]!)).toBeLessThan(1e-4);
    }
  });

  it("is absent when no tempo is declared, for a movie, and under a held cue", () => {
    expect(beatGridOf(graphWith({ ...DECLARED, tempoMode: "auto" }), REFERENCE)).toBeNull();
    expect(beatGridOf(graphWith(DECLARED, "movieFileIn"), { ...REFERENCE, type: "movieFileIn" })).toBeNull();
    expect(beatGridOf(graphWith({ ...DECLARED, cue: true }), REFERENCE)).toBeNull();
    expect(beatGridOf(graphWith(DECLARED), null)).toBeNull();
  });

  it("snaps a drag by whole divisions, and leaves time alone in a beat mode with no grid", () => {
    const grid = beatGridOf(graphWith(DECLARED), REFERENCE)!;
    const rate = rateOf(30);
    expect(snapTicks(0.3 * S, "beats", rate, grid, true)).toBe(0.5 * S);
    expect(snapTicks(0.3 * S, "bars", rate, grid, true)).toBe(0);
    expect(snapTicks(12_345.4, "beats", rate, null)).toBe(12_345);
  });

  it("draws every beat when there is room, bars only when not, numbered from bar one", () => {
    const grid = beatGridOf(graphWith(DECLARED), REFERENCE)!;
    // DEFAULT_VIEW: 100 px a second, so a beat is 50 px.
    const lines = gridLines(grid, DEFAULT_VIEW, 300);
    expect(lines.map((line) => Math.round(line.x))).toEqual([0, 50, 100, 150, 200, 250, 300]);
    expect(lines.map((line) => line.bar)).toEqual([null, 1, null, null, null, 2, null]);
    // Zoomed out to 1 px a second: a beat is half a pixel, a bar 2 px, neither drawn.
    expect(gridLines(grid, { ...DEFAULT_VIEW, ticksPerPixel: S }, 300)).toEqual([]);
    // 4 px a second: beats 2 px apart (too dense), bars 8 px apart (drawn).
    const bars = gridLines(grid, { ...DEFAULT_VIEW, ticksPerPixel: S / 4 }, 40);
    expect(bars.every((line) => line.bar !== null)).toBe(true);
    expect(bars.map((line) => line.bar)).toEqual([1, 2, 3, 4, 5]);
  });
});
