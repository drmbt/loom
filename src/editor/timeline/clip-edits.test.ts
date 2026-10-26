import { describe, expect, it } from "vitest";
import { sourceTimeAt } from "@domain/regions/evaluate.ts";
import { newRegion, parseClipTrack, serializeClipTrack, type ClipTrack } from "@domain/regions/model.ts";
import { createFileReference } from "@domain/media/file-reference.ts";
import {
  deleteRegion,
  freshRegionId,
  isOfflineMedia,
  lapTicks,
  mediaLabel,
  moveRegion,
  placeRegion,
  regionBadge,
  setRegionFields,
  trimRegionEnd,
  trimRegionStart,
} from "./clip-edits.ts";

const S = 240_000;
const FRAME = S / 30;

/** A at 0..2 s (source 0..2 s), B at 4..6 s (source 1..3 s). */
const TRACK: ClipTrack = {
  version: 1, id: "t", name: "t",
  regions: [
    newRegion("a", "blob:a", { sourceIn: 0, sourceOut: 2 * S, timelineStart: 0, length: 2 * S }),
    newRegion("b", "blob:b", { sourceIn: S, sourceOut: 3 * S, timelineStart: 4 * S, length: 2 * S }),
  ],
};

/** Every result must still parse: the model's invariants hold after every edit. */
function valid(track: ClipTrack): ClipTrack {
  const parsed = parseClipTrack(serializeClipTrack(track));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.track;
}
const region = (track: ClipTrack, id: string) => track.regions.find((each) => each.id === id)!;

describe("VN106 clip edits", () => {
  it("moves a region, clamping against its neighbours instead of overlapping", () => {
    expect(region(valid(moveRegion(TRACK, "a", S)), "a").timelineStart).toBe(S);
    // Into B: stops where B starts.
    expect(region(valid(moveRegion(TRACK, "a", 3 * S)), "a").timelineStart).toBe(2 * S);
    // Back past A's end: stops at A's end; before 0: stops at 0.
    expect(region(valid(moveRegion(TRACK, "b", S)), "b").timelineStart).toBe(2 * S);
    expect(region(valid(moveRegion(TRACK, "a", -S)), "a").timelineStart).toBe(0);
  });

  it("trims the start and slips the source so the rest of the region plays the same frames", () => {
    const trimmed = valid(trimRegionStart(TRACK, "b", 5 * S, 120, FRAME));
    const b = region(trimmed, "b");
    expect(b).toMatchObject({ timelineStart: 5 * S, length: S, sourceIn: 2 * S, sourceOut: 3 * S });
    // The frame under 5.5 s is the frame that was there before the trim.
    expect(sourceTimeAt(b, 5.5 * S)).toBe(sourceTimeAt(region(TRACK, "b"), 5.5 * S));
    // Out again: not before the file's start (sourceIn 0), nor into A.
    const out = region(valid(trimRegionStart(TRACK, "b", 0, 120, FRAME)), "b");
    expect(out).toMatchObject({ timelineStart: 3 * S, sourceIn: 0, length: 3 * S });
    // Never shorter than a frame.
    expect(region(valid(trimRegionStart(TRACK, "a", 10 * S, 120, FRAME)), "a").length).toBeGreaterThanOrEqual(FRAME);
  });

  it("a plain right-edge drag trims up to one pass of the source; Alt extends it to loop", () => {
    expect(region(valid(trimRegionEnd(TRACK, "a", S, { extend: false, tempoBpm: 120, minLength: FRAME })), "a").length).toBe(S);
    // Past the source end without Alt: stops at the lap (2 s).
    expect(region(valid(trimRegionEnd(TRACK, "b", 9 * S, { extend: false, tempoBpm: 120, minLength: FRAME })), "b").length).toBe(2 * S);
    // With Alt: as long as asked, and the region loops in it.
    const extended = region(valid(trimRegionEnd(TRACK, "b", 9 * S, { extend: true, tempoBpm: 120, minLength: FRAME })), "b");
    expect(extended.length).toBe(5 * S);
    expect(sourceTimeAt(extended, 6.5 * S)).toBe(1.5 * S);
    // A's extension stops at B.
    expect(region(valid(trimRegionEnd(TRACK, "a", 9 * S, { extend: true, tempoBpm: 120, minLength: FRAME })), "a").length).toBe(4 * S);
  });

  it("a region that already loops keeps extending without Alt", () => {
    const looping: ClipTrack = { ...TRACK, regions: [newRegion("a", "blob:a", { sourceOut: S, length: 3 * S })] };
    expect(region(valid(trimRegionEnd(looping, "a", 8 * S, { extend: false, tempoBpm: 120, minLength: FRAME })), "a").length).toBe(8 * S);
  });

  it("the lap follows speed and BPM sync, and a BPM-synced slip keeps the rate", () => {
    expect(lapTicks(newRegion("x", "", { sourceOut: 2 * S, speed: 2 }), 120)).toBe(S);
    expect(lapTicks(newRegion("x", "", { speed: 0 }), 120)).toBe(Infinity);
    // 2 s of source in 8 beats at 120 BPM = 4 s of timeline.
    const synced: ClipTrack = { ...TRACK, regions: [newRegion("s", "blob:s", { sourceOut: 2 * S, length: 4 * S, bpmSync: { beats: 8 } })] };
    expect(lapTicks(synced.regions[0]!, 120)).toBe(4 * S);
    const slipped = region(valid(trimRegionStart(synced, "s", 2 * S, 120, FRAME)), "s");
    expect(slipped).toMatchObject({ sourceIn: S, length: 2 * S, bpmSync: { beats: 4 } });
    expect(lapTicks(slipped, 120)).toBe(2 * S);
  });

  it("a reverse region's start trim moves its source out down", () => {
    const reverse: ClipTrack = { ...TRACK, regions: [newRegion("r", "blob:r", { sourceOut: 2 * S, length: 2 * S, direction: "reverse" })] };
    const trimmed = region(valid(trimRegionStart(reverse, "r", S, 120, FRAME)), "r");
    expect(trimmed).toMatchObject({ sourceIn: 0, sourceOut: S, timelineStart: S, length: S });
    expect(sourceTimeAt(trimmed, 1.5 * S)).toBe(sourceTimeAt(reverse.regions[0]!, 1.5 * S));
  });

  it("fields, fades, delete, fresh ids", () => {
    const faded: ClipTrack = { ...TRACK, regions: [newRegion("a", "blob:a", { sourceOut: 2 * S, length: 2 * S, fadeIn: S, fadeOut: S })] };
    const shortened = region(valid(trimRegionEnd(faded, "a", S, { extend: false, tempoBpm: 120, minLength: FRAME })), "a");
    expect(shortened.fadeIn + shortened.fadeOut).toBeLessThanOrEqual(shortened.length);
    const set = region(valid(setRegionFields(TRACK, "a", { playMode: "bounce", direction: "reverse", bpmSync: { beats: 4 } })), "a");
    expect(set).toMatchObject({ playMode: "bounce", direction: "reverse", bpmSync: { beats: 4 } });
    const unsynced = valid(setRegionFields({ ...TRACK, regions: [set] }, "a", { bpmSync: undefined }));
    expect("bpmSync" in unsynced.regions[0]!).toBe(false);
    expect(valid(deleteRegion(TRACK, "a")).regions.map((each) => each.id)).toEqual(["b"]);
    expect(freshRegionId(TRACK)).toBe("region1");
  });

  it("places a dropped region in the free room, never over a neighbour", () => {
    const fresh = newRegion("n", "blob:n", { sourceOut: 3 * S, length: 3 * S });
    // Dropped inside A: moves to A's end and is cut to end where B starts.
    const placed = valid(placeRegion(TRACK, { ...fresh, timelineStart: S }, FRAME)!);
    expect(region(placed, "n")).toMatchObject({ timelineStart: 2 * S, length: 2 * S });
    expect(placed.regions.map((each) => each.id)).toEqual(["a", "n", "b"]);
    // After B: whole.
    expect(region(valid(placeRegion(TRACK, { ...fresh, timelineStart: 7 * S }, FRAME)!), "n").length).toBe(3 * S);
    // Less than a frame of room after A: refused rather than a sliver.
    const full: ClipTrack = { ...TRACK, regions: [newRegion("a", "", { length: 2 * S }), newRegion("b", "", { timelineStart: 2 * S + FRAME / 2, length: 2 * S })] };
    expect(placeRegion(full, { ...fresh, timelineStart: S }, FRAME)).toBeNull();
  });

  it("labels and offline media", () => {
    expect(mediaLabel(createFileReference("id", "video", "My clip.mp4"))).toBe("My clip.mp4");
    expect(mediaLabel("blob:http://x/abc#Loop%201.webm")).toBe("Loop 1.webm");
    expect(mediaLabel("/Volumes/Show/Clips/intro.mov")).toBe("intro.mov");
    expect(mediaLabel("C:\\Clips\\intro.mov")).toBe("intro.mov");
    expect(mediaLabel("")).toBe("no media");
    expect(isOfflineMedia("/Volumes/Show/Clips/intro.mov")).toBe(true);
    expect(isOfflineMedia("C:\\Clips\\intro.mov")).toBe(true);
    expect(isOfflineMedia("blob:http://x/abc")).toBe(false);
    expect(isOfflineMedia(createFileReference("id", "video", "a.mp4"))).toBe(false);
    expect(regionBadge(newRegion("a", "", { playMode: "bounce", direction: "reverse", speed: 2 }))).toBe("bounce rev ×2");
    expect(regionBadge(newRegion("a", "", { bpmSync: { beats: 8 } }))).toBe("loop 8 beats");
  });
});
