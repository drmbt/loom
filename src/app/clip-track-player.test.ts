import { describe, expect, it } from "vitest";
import { newRegion, type ClipTrack } from "@domain/regions/model.ts";
import { TICKS_PER_SECOND as S } from "@domain/time/ticks.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { createClipTrackPlayer, type ClipTrackDoor } from "./clip-track-player.ts";
import type { PresentableMedia } from "./media-playback.ts";
import type { MediaElement } from "./media-sources.ts";

/** A `<video>` stand-in that records seeks; frames are counted on demand. */
function fake(url: string) {
  const self = {
    url, videoWidth: 4, videoHeight: 4, duration: 10, playbackRate: 1, paused: true, seeking: false, released: false,
    seeks: [] as number[], time: 0, listeners: new Set<() => void>(),
    get currentTime() { return self.time; },
    // The seek "completes" at once: `seeked` fires synchronously (no presented-frame callback).
    set currentTime(value: number) {
      self.time = value;
      self.seeks.push(value);
      for (const listener of [...self.listeners]) listener();
    },
    addEventListener(type: string, listener: () => void) { if (type === "seeked") self.listeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { self.listeners.delete(listener); },
    play() { self.paused = false; },
    pause() { self.paused = true; },
  };
  return self;
}
type Fake = ReturnType<typeof fake>;

function rig(fail: ReadonlySet<string> = new Set()) {
  const opened: Fake[] = [];
  const reports: string[] = [];
  const door: ClipTrackDoor = {
    open: async (url) => {
      if (fail.has(url)) throw new Error(`cannot decode ${url}`);
      const element = fake(url);
      opened.push(element);
      return element as unknown as MediaElement & PresentableMedia;
    },
    blank: () => ({ bytes: new Uint8Array(64) }),
    release: (element) => { (element as unknown as Fake).released = true; },
    frames: () => ({ source: { currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(64) }) }, dispose() {} }),
    report: (region, message) => reports.push(`${region.id}: ${message}`),
  };
  return { player: createClipTrackPlayer(door), opened, reports };
}

const frame = (seconds: number, mode: FrameEvaluationInput["mode"] = "realtime"): FrameEvaluationInput => ({
  timeSeconds: seconds, deltaSeconds: 1 / 30, frameIndex: Math.round(seconds * 30), mode, randomSeed: 1, fps: 30,
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const TRACK: ClipTrack = {
  version: 1, id: "t", name: "t",
  regions: [
    newRegion("a", "a.mp4", { sourceIn: 2 * S, sourceOut: 4 * S, timelineStart: 0, length: 3 * S }),
    newRegion("b", "b.mp4", { sourceIn: 0, sourceOut: S, timelineStart: 4 * S, length: 2 * S, playMode: "bounce" }),
  ],
};

describe("VN101 clip-track player", () => {
  it("seeks once on entry, then lets a playing element run (the movie door's tolerance policy)", async () => {
    const { player, opened } = rig();
    player.sync(frame(0.5), TRACK, 120);
    await settle();
    player.sync(frame(0.5), TRACK, 120);
    const a = opened.find((element) => element.url === "a.mp4") as Fake;
    expect(a.seeks).toEqual([2.5]);
    expect(a.paused).toBe(false);
    expect(player.showing()).toBe("a");
    // Playing on: the element advanced itself; the next frames write nothing.
    a.time = 2.5 + 1 / 30;
    player.sync(frame(0.5 + 1 / 30), TRACK, 120);
    a.time = 2.5 + 2 / 30;
    player.sync(frame(0.5 + 2 / 30), TRACK, 120);
    expect(a.seeks).toEqual([2.5]);
  });

  it("a loop lap is an exact seek back to the in point", async () => {
    const { player, opened } = rig();
    player.sync(frame(1.9), TRACK, 120);
    await settle();
    player.sync(frame(1.9), TRACK, 120);
    const a = opened[0] as Fake;
    a.time = 3.9 + 1 / 30;
    player.sync(frame(2.0), TRACK, 120);
    expect(a.seeks.at(-1)).toBe(2);
  });

  it("pre-rolls the next region two seconds ahead, parked paused on its first frame, and releases what left", async () => {
    const { player, opened } = rig();
    player.sync(frame(1.0), TRACK, 120);
    await settle();
    expect(opened.map((element) => element.url)).toEqual(["a.mp4"]); // b is three seconds away
    player.sync(frame(2.5), TRACK, 120);
    await settle();
    player.sync(frame(2.6), TRACK, 120);
    const b = opened.find((element) => element.url === "b.mp4") as Fake;
    expect(b).toBeDefined();
    expect(b.paused).toBe(true);
    expect(b.time).toBe(0);
    // In the gap: A is released, B stays parked, nothing shows.
    player.sync(frame(3.5), TRACK, 120);
    expect((opened[0] as Fake).released).toBe(true);
    expect(b.released).toBe(false);
    expect(player.showing()).toBeNull();
    // The cut: B was ready, so it shows on its first frame.
    player.sync(frame(4.0), TRACK, 120);
    expect(player.showing()).toBe("b");
    expect(b.paused).toBe(false);
  });

  it("a bounce's way back is reverse: the element is paused and stepped, frame by frame", async () => {
    const { player, opened } = rig();
    player.sync(frame(5.5), TRACK, 120);
    await settle();
    player.sync(frame(5.5), TRACK, 120);
    const b = opened.find((element) => element.url === "b.mp4") as Fake;
    expect(b.paused).toBe(true);
    expect(b.time).toBeCloseTo(0.5, 9);
    player.sync(frame(5.6), TRACK, 120);
    expect(b.time).toBeCloseTo(0.4, 9);
  });

  it("an offline frame pre-seeks through prepare and the step then seeks nothing", async () => {
    const { player, opened } = rig();
    const take = frame(1.5, "offline");
    await player.prepare(take, TRACK, 120);
    const a = opened[0] as Fake;
    expect(a.seeks).toEqual([3.5]);
    expect(a.paused).toBe(true);
    player.sync(take, TRACK, 120);
    expect(a.seeks).toEqual([3.5]);
  });

  it("a region whose media will not open is reported once by name and shows transparent", async () => {
    const { player, reports } = rig(new Set(["a.mp4"]));
    player.sync(frame(0.5), TRACK, 120);
    await settle();
    player.sync(frame(0.6), TRACK, 120);
    expect(reports).toEqual(["a: cannot decode a.mp4"]);
    expect(player.showing()).toBeNull();
    expect(player.source.currentFrame()?.bytes).toBeDefined();
  });

  it("a track that does not parse releases everything", async () => {
    const { player, opened } = rig();
    player.sync(frame(0.5), TRACK, 120);
    await settle();
    player.sync(frame(0.6), null, 120);
    expect((opened[0] as Fake).released).toBe(true);
    expect(player.showing()).toBeNull();
  });

  it("the composite frame id advances on a switch between a region and the gap", async () => {
    const { player } = rig();
    const first = player.source.currentFrame()?.frameId ?? 0;
    player.sync(frame(0.5), TRACK, 120);
    await settle();
    player.sync(frame(0.5), TRACK, 120);
    const inRegion = player.source.currentFrame()?.frameId ?? 0;
    expect(inRegion).toBeGreaterThan(first);
    expect(player.source.currentFrame()?.frameId).toBe(inRegion); // unchanged: nothing new to upload
    player.sync(frame(3.5), TRACK, 120);
    expect(player.source.currentFrame()?.frameId).toBeGreaterThan(inRegion);
  });
});
