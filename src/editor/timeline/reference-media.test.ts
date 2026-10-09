import { describe, expect, it } from "vitest";
import type { GraphDocument } from "@domain/types/graph.ts";
import { frameRangeLimit } from "@domain/transport/range-limit.ts";
import { mediaSecondsMapper, rangeFromMedia } from "./reference-media.ts";

const S = 240_000;

describe("placing the reference waveform in timeline time (VN64)", () => {
  const graph = (parameters: Record<string, unknown>): GraphDocument =>
    ({ revision: 0, edges: {}, groups: {}, nodes: { m: { id: "m", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, label: "movie_reference", parameters } } }) as unknown as GraphDocument;
  const reference = { nodeId: "m" as never, type: "movieFileIn" as const, name: "movie_reference", how: "named" as const, warning: null };

  it("follows the node's own transport: trim in, speed, and an end that holds nothing", () => {
    const map = mediaSecondsMapper(graph({ playMode: "timeline", trimStart: 2, speed: 2, extend: "black" }), reference, 10);
    expect(map(0)).toBe(2);
    expect(map(1 * S)).toBe(4);
    // Past the out point at 2× the media is gone: nothing is drawn there.
    expect(map(5 * S)).toBeNull();
    expect(map(-1)).toBeNull();
  });

  it("reads plain media at the timeline second", () => {
    const map = mediaSecondsMapper(graph({ playMode: "timeline" }), reference, 10);
    expect(map(3.5 * S)).toBe(3.5);
  });
});

describe("the project length from the media", () => {
  it("is round(duration × fps) frames from the current start", () => {
    expect(rangeFromMedia(12.5, 30, { start: 0, end: 99 })).toEqual({ range: { start: 0, end: 374 }, notice: null });
    expect(rangeFromMedia(1.01, 24, { start: 10, end: 99 })).toEqual({ range: { start: 10, end: 33 }, notice: null });
    expect(rangeFromMedia(0, 30, { start: 0, end: 99 })).toBeNull();
  });

  it("stops at one day, and says so", () => {
    const planned = rangeFromMedia(25 * 3600, 30, { start: 0, end: 99 });
    expect(planned?.range).toEqual({ start: 0, end: frameRangeLimit(30) });
    expect(planned?.notice).toContain("one day");
  });
});
