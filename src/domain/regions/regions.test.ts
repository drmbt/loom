import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND as S } from "../time/ticks.ts";
import {
  nextRegionAfter,
  regionAt,
  regionOpacityAt,
  regionRate,
  sampleTrack,
  sourceSecondsAt,
  sourceTimeAt,
} from "./evaluate.ts";
import {
  EMPTY_CLIP_TRACK_JSON,
  newRegion,
  parseClipTrack,
  serializeClipTrack,
  type ClipTrack,
  type Region,
} from "./model.ts";

/** Source 1 s .. 3 s (a 2 s span) placed at timeline 10 s for 20 s. */
const base = (fields: Partial<Region> = {}): Region =>
  newRegion("a", "clip.mp4", { sourceIn: S, sourceOut: 3 * S, timelineStart: 10 * S, length: 20 * S, ...fields });

const at = (region: Region, seconds: number, tempo?: number): number | null => sourceTimeAt(region, Math.round(seconds * S), tempo);

describe("VN101 sourceTimeAt: the region's source time at a playhead", () => {
  it("is blank outside the region: before its start, and from its end (exclusive)", () => {
    const region = base();
    expect(sourceTimeAt(region, 10 * S - 1)).toBeNull();
    expect(sourceTimeAt(region, 10 * S)).toBe(S);
    expect(sourceTimeAt(region, 30 * S - 1)).not.toBeNull();
    expect(sourceTimeAt(region, 30 * S)).toBeNull();
    expect(sourceTimeAt(region, Number.NaN)).toBeNull();
  });

  it("loop: mod over the span, wrapping exactly on the lap tick", () => {
    const region = base();
    expect(at(region, 10)).toBe(S);
    expect(at(region, 11.5)).toBe(2.5 * S);
    expect(sourceTimeAt(region, 12 * S - 1)).toBe(3 * S - 1);
    // The wrap: one tick past the lap is back at `in`, exactly.
    expect(sourceTimeAt(region, 12 * S)).toBe(S);
    expect(at(region, 13)).toBe(2 * S);
    expect(at(region, 29)).toBe(2 * S);
  });

  it("bounce: a triangle, turning at out after one span and at in after two", () => {
    const region = base({ playMode: "bounce" });
    expect(at(region, 10)).toBe(S);
    expect(at(region, 11)).toBe(2 * S);
    expect(at(region, 12)).toBe(3 * S); // turning point: out
    expect(at(region, 13)).toBe(2 * S); // on the way back
    expect(sourceTimeAt(region, 14 * S - 1)).toBe(S + 1);
    expect(at(region, 14)).toBe(S); // turning point: in
    expect(at(region, 15)).toBe(2 * S);
  });

  it("onceHold: one pass, then hold on out to the end of the region", () => {
    const region = base({ playMode: "onceHold" });
    expect(at(region, 11)).toBe(2 * S);
    expect(sourceTimeAt(region, 12 * S - 1)).toBe(3 * S - 1);
    expect(at(region, 12)).toBe(3 * S);
    expect(at(region, 29.9)).toBe(3 * S);
  });

  it("onceClear: one pass, then blank from the out instant on", () => {
    const region = base({ playMode: "onceClear" });
    expect(sourceTimeAt(region, 12 * S - 1)).toBe(3 * S - 1);
    expect(at(region, 12)).toBeNull();
    expect(at(region, 20)).toBeNull();
  });

  it("reverse mirrors inside the span, in every mode", () => {
    expect(at(base({ direction: "reverse" }), 10)).toBe(3 * S);
    expect(at(base({ direction: "reverse" }), 11.5)).toBe(1.5 * S);
    // Reverse loop wraps back to out.
    expect(sourceTimeAt(base({ direction: "reverse" }), 12 * S - 1)).toBe(S + 1);
    expect(at(base({ direction: "reverse" }), 12)).toBe(3 * S);
    expect(at(base({ direction: "reverse", playMode: "onceHold" }), 20)).toBe(S);
    expect(at(base({ direction: "reverse", playMode: "bounce" }), 12)).toBe(S);
    expect(at(base({ direction: "reverse", playMode: "onceClear" }), 12)).toBeNull();
  });

  it("speed scales the rate, and the lap with it; speed 0 freezes on the first frame", () => {
    const double = base({ speed: 2 });
    expect(at(double, 10.5)).toBe(2 * S);
    expect(at(double, 11)).toBe(S); // the lap is one second at 2×
    expect(at(double, 11.25)).toBe(1.5 * S);
    const half = base({ speed: 0.5 });
    expect(at(half, 12)).toBe(2 * S);
    expect(at(half, 14)).toBe(S);
    expect(at(base({ speed: 0 }), 25)).toBe(S);
    expect(at(base({ speed: 0, direction: "reverse" }), 25)).toBe(3 * S);
    expect(at(base({ speed: 0, playMode: "onceClear" }), 25)).toBe(S);
  });

  it("BPM sync fits the span to the beats at the tempo, replacing speed; no tempo falls back to speed", () => {
    // 4 beats at 120 bpm is 2 s: a 2 s span plays at 1×, whatever `speed` says.
    const synced = base({ bpmSync: { beats: 4 }, speed: 3 });
    expect(regionRate(synced, 120)).toBe(1);
    expect(at(synced, 11, 120)).toBe(2 * S);
    expect(at(synced, 12, 120)).toBe(S);
    // 8 beats at 120 bpm is 4 s: half speed, the lap is 4 s and wraps exactly on its tick.
    const slow = base({ bpmSync: { beats: 8 } });
    expect(regionRate(slow, 120)).toBe(0.5);
    expect(at(slow, 12, 120)).toBe(2 * S);
    expect(sourceTimeAt(slow, 14 * S, 120)).toBe(S);
    // 4 beats at 60 bpm: 4 s for the span.
    expect(at(synced, 12, 60)).toBe(2 * S);
    expect(regionRate(synced)).toBe(3);
    expect(regionRate(synced, 0)).toBe(3);
  });

  it("a non-integer rate stays inside the span at every tick of a lap", () => {
    const odd = base({ bpmSync: { beats: 3 }, sourceIn: 0, sourceOut: 7 * S + 13 });
    for (let tick = 10 * S; tick < 30 * S; tick += 4_999) {
      const value = sourceTimeAt(odd, tick, 133);
      expect(value).not.toBeNull();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7 * S + 13);
    }
  });

  it("reports seconds for a media element", () => {
    expect(sourceSecondsAt(base(), 11 * S)).toBe(2);
    expect(sourceSecondsAt(base(), 0)).toBeNull();
  });

  it("fades: linear in from the start and out to the end", () => {
    const region = base({ fadeIn: 2 * S, fadeOut: 4 * S });
    expect(regionOpacityAt(region, 10 * S)).toBe(0);
    expect(regionOpacityAt(region, 11 * S)).toBe(0.5);
    expect(regionOpacityAt(region, 12 * S)).toBe(1);
    expect(regionOpacityAt(region, 28 * S)).toBe(0.5);
    expect(regionOpacityAt(region, 30 * S)).toBe(0);
    expect(regionOpacityAt(base(), 15 * S)).toBe(1);
  });
});

describe("VN101 tracks: lookup and pre-roll", () => {
  const track: ClipTrack = {
    version: 1, id: "t", name: "t",
    regions: [
      newRegion("a", "a.mp4", { timelineStart: 0, length: 2 * S, sourceOut: S }),
      newRegion("b", "b.mp4", { timelineStart: 2 * S, length: S, sourceOut: S }),
      newRegion("c", "c.mp4", { timelineStart: 5 * S, length: S, sourceOut: S }),
    ],
  };

  it("finds the region under the playhead, back to back and across a gap", () => {
    expect(regionAt(track, 0)?.id).toBe("a");
    expect(regionAt(track, 2 * S - 1)?.id).toBe("a");
    expect(regionAt(track, 2 * S)?.id).toBe("b");
    expect(regionAt(track, 3 * S)).toBeNull();
    expect(regionAt(track, 5 * S)?.id).toBe("c");
    expect(regionAt(track, 6 * S)).toBeNull();
    expect(regionAt(track, -1)).toBeNull();
  });

  it("names the next region to pre-roll", () => {
    expect(nextRegionAfter(track, 0)?.id).toBe("b");
    expect(nextRegionAfter(track, 3 * S)?.id).toBe("c");
    expect(nextRegionAfter(track, 5 * S)).toBeNull();
  });

  it("samples a track: region a loops its 1 s span inside its 2 s length", () => {
    expect(sampleTrack(track, 1.5 * S)).toEqual({ region: track.regions[0], sourceTicks: 0.5 * S, opacity: 1 });
    expect(sampleTrack(track, 4 * S)).toBeNull();
  });
});

describe("VN101 parseClipTrack: the invariants", () => {
  const doc = (regions: unknown[]) => JSON.stringify({ version: 1, id: "t", name: "t", regions });
  const region = (fields: Record<string, unknown>) => ({
    id: "a", media: "x.mp4", sourceIn: 0, sourceOut: S, timelineStart: 0, length: S, ...fields,
  });

  it("round-trips a track byte for byte, and the empty default parses", () => {
    const text = doc([region({}), region({ id: "b", timelineStart: S, bpmSync: { beats: 4 }, playMode: "bounce" })]);
    const parsed = parseClipTrack(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const again = serializeClipTrack(parsed.track);
    expect(serializeClipTrack((parseClipTrack(again) as { track: ClipTrack }).track)).toBe(again);
    expect(parsed.track.regions[0]).toMatchObject({ playMode: "loop", speed: 1, direction: "forward", fadeIn: 0, fadeOut: 0 });
    expect(parsed.track.regions[1]?.bpmSync).toEqual({ beats: 4 });
    expect(parseClipTrack(EMPTY_CLIP_TRACK_JSON).ok).toBe(true);
  });

  it("allows a region to start exactly where the previous ends", () => {
    expect(parseClipTrack(doc([region({}), region({ id: "b", timelineStart: S })])).ok).toBe(true);
  });

  const refusals: Array<[string, unknown[] | string, RegExp]> = [
    ["overlap", [region({ length: 2 * S }), region({ id: "b", timelineStart: S })], /overlap/],
    ["overlap by one tick", [region({}), region({ id: "b", timelineStart: S - 1 })], /overlap/],
    ["unsorted", [region({ timelineStart: 5 * S }), region({ id: "b", timelineStart: 0 })], /sorted/],
    ["zero length", [region({ length: 0 })], /length must be greater than 0/],
    ["negative length", [region({ length: -S })], /length must be greater than 0/],
    ["in == out", [region({ sourceIn: S, sourceOut: S })], /sourceIn must be before sourceOut/],
    ["in > out", [region({ sourceIn: 2 * S, sourceOut: S })], /sourceIn must be before sourceOut/],
    ["negative in", [region({ sourceIn: -1 })], /sourceIn must not be negative/],
    ["fractional tick", [region({ timelineStart: 0.5 })], /whole number of ticks/],
    ["infinite", [region({ length: Number.POSITIVE_INFINITY })], /finite/],
    ["missing out", [{ id: "a", timelineStart: 0, length: S }], /sourceOut must be a finite/],
    ["NaN speed", [region({ speed: "fast" })], /speed must be a finite number/],
    ["negative speed", [region({ speed: -1 })], /reverse is the direction/],
    ["bad mode", [region({ playMode: "random" })], /playMode must be one of/],
    ["bad direction", [region({ direction: "sideways" })], /direction/],
    ["bad beats", [region({ bpmSync: { beats: 0 } })], /beats must be a finite number > 0/],
    ["fades too long", [region({ fadeIn: S, fadeOut: 1 })], /fit inside/],
    ["duplicate ids", [region({}), region({ timelineStart: S })], /share the id/],
    ["empty id", [region({ id: "" })], /id must be a non-empty string/],
  ];
  for (const [name, input, reason] of refusals) {
    it(`refuses ${name}, by name`, () => {
      const parsed = parseClipTrack(typeof input === "string" ? input : doc(input));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(reason);
    });
  }

  it("refuses text that is not a track", () => {
    expect(parseClipTrack("{").ok).toBe(false);
    expect(parseClipTrack("[]").ok).toBe(false);
    expect(parseClipTrack(JSON.stringify({ version: 2, regions: [] })).ok).toBe(false);
    expect(parseClipTrack(JSON.stringify({ version: 1 })).ok).toBe(false);
  });
});
