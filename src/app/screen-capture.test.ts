import { afterEach, describe, expect, it, vi } from "vitest";
import { browserScreenCaptureEnvironment } from "./screen-capture.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

class Track extends EventTarget {
  readonly kind: "video" | "audio";
  readonly label: string;
  readyState: MediaStreamTrackState = "live";
  readonly stop = vi.fn(() => { this.readyState = "ended"; });
  constructor(kind: "video" | "audio", label: string) { super(); this.kind = kind; this.label = label; }
  end(): void { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}

class Video extends EventTarget {
  videoWidth = 1920;
  videoHeight = 1080;
  readyState = 1;
  muted = false;
  playsInline = false;
  srcObject: MediaStream | null = null;
  error: { code: number } | null = null;
  readonly play = vi.fn(async () => {});
  readonly pause = vi.fn();
}

function fixture() {
  const tracks = [new Track("video", "Chrome tab"), new Track("video", "Window"), new Track("audio", "Unexpected audio")];
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter(track => track.kind === "video"),
  } as unknown as MediaStream;
  const video = new Video();
  const createElement = vi.fn(() => video);
  const getDisplayMedia = vi.fn<MediaDevices["getDisplayMedia"]>().mockResolvedValue(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
  vi.stubGlobal("document", { createElement });
  return { tracks, stream, video, getDisplayMedia, createElement };
}

describe("browserScreenCaptureEnvironment", () => {
  it("does not invoke the picker for an already cancelled owner", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(browserScreenCaptureEnvironment().open(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(f.getDisplayMedia).not.toHaveBeenCalled();
    expect(f.createElement).not.toHaveBeenCalled();
  });

  it("rejects a cancelled pending picker immediately and stops its late accepted stream", async () => {
    const f = fixture();
    let grant!: (stream: MediaStream) => void;
    f.getDisplayMedia.mockReturnValue(new Promise(resolve => { grant = resolve; }));
    const controller = new AbortController();
    const opening = browserScreenCaptureEnvironment().open(controller.signal);
    expect(f.getDisplayMedia).toHaveBeenCalledOnce();
    controller.abort();
    await expect(opening).rejects.toBe(controller.signal.reason);
    grant(f.stream);
    await Promise.resolve();
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(f.createElement).not.toHaveBeenCalled();
  });

  it("aborts acquired capture during metadata preparation and clears its timeout", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.video.readyState = 0;
    const controller = new AbortController();
    const opening = browserScreenCaptureEnvironment().open(controller.signal);
    for (let step = 0; step < 3; step += 1) await Promise.resolve();
    expect(f.video.srcObject).toBe(f.stream);
    expect(vi.getTimerCount()).toBe(1);
    const remove = vi.spyOn(f.video, "removeEventListener");
    controller.abort();
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await expect(opening).rejects.toBe(controller.signal.reason);
    expect(remove.mock.calls.map(call => call[0])).toEqual(["loadedmetadata", "error"]);
    expect(f.video.play).not.toHaveBeenCalled();
  });

  it("aborts hung playback promptly and observes its late rejection", async () => {
    const f = fixture();
    let failPlay!: (error: Error) => void;
    f.video.play.mockReturnValue(new Promise((_resolve, reject) => { failPlay = reject; }));
    const controller = new AbortController();
    const opening = browserScreenCaptureEnvironment().open(controller.signal);
    for (let step = 0; step < 3; step += 1) await Promise.resolve();
    expect(f.video.play).toHaveBeenCalledOnce();
    controller.abort();
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    await expect(opening).rejects.toBe(controller.signal.reason);
    failPlay(new DOMException("Playback was interrupted", "AbortError"));
    await Promise.resolve();
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("returned stop removes its abort listener and capture cleanup stays idempotent", async () => {
    const f = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const capture = await browserScreenCaptureEnvironment().open(controller.signal);
    capture.stop();
    expect(remove).toHaveBeenCalledWith("abort", capture.stop);
    controller.abort();
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("invokes the picker in the gesture and prepares a muted inline video", async () => {
    const f = fixture();
    let grant!: (stream: MediaStream) => void;
    f.getDisplayMedia.mockReturnValue(new Promise(resolve => { grant = resolve; }));
    const opening = browserScreenCaptureEnvironment().open();
    // Before any microtask: deferring this call would lose transient activation.
    expect(f.getDisplayMedia).toHaveBeenCalledOnce();
    expect(f.getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: 30, displaySurface: "browser" }, audio: false, surfaceSwitching: "include",
    });
    expect(f.createElement).not.toHaveBeenCalled();
    grant(f.stream);
    const capture = await opening;
    expect(f.createElement).toHaveBeenCalledOnce();
    expect(f.createElement).toHaveBeenCalledWith("video");
    expect(f.video).toMatchObject({ muted: true, playsInline: true, srcObject: f.stream });
    expect(f.video.play).toHaveBeenCalledOnce();
    expect(capture.element).toBe(f.video);
    expect(capture.label).toBe("Chrome tab");
    capture.stop();
  });

  it("waits for metadata and playback before handing ownership to the caller", async () => {
    const f = fixture();
    f.video.readyState = 0;
    let played!: () => void;
    f.video.play.mockReturnValue(new Promise(resolve => { played = resolve; }));
    const resolved = vi.fn();
    const opening = browserScreenCaptureEnvironment().open().then(capture => { resolved(); return capture; });
    await Promise.resolve();
    expect(f.video.play).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
    f.video.dispatchEvent(new Event("loadedmetadata"));
    await Promise.resolve();
    expect(f.video.play).toHaveBeenCalledOnce();
    expect(resolved).not.toHaveBeenCalled();
    played();
    const capture = await opening;
    expect(resolved).toHaveBeenCalledOnce();
    capture.stop();
  });

  it.each(["NotAllowedError", "AbortError"])("preserves %s from the picker without allocating video", async name => {
    const f = fixture();
    const error = new DOMException("Capture was not granted.", name);
    f.getDisplayMedia.mockRejectedValue(error);
    await expect(browserScreenCaptureEnvironment().open()).rejects.toBe(error);
    expect(f.createElement).not.toHaveBeenCalled();
    for (const track of f.tracks) expect(track.stop).not.toHaveBeenCalled();
  });

  it.each([undefined, {}])("reports an unsupported API explicitly", async mediaDevices => {
    fixture();
    vi.stubGlobal("navigator", { mediaDevices });
    await expect(browserScreenCaptureEnvironment().open()).rejects.toThrow("secure context (HTTPS or localhost)");
  });

  it("rejects a stream without a video track and frees every acquired track", async () => {
    const f = fixture();
    f.tracks.splice(0, 2);
    await expect(browserScreenCaptureEnvironment().open()).rejects.toThrow("no video track");
    expect(f.createElement).not.toHaveBeenCalled();
    expect(f.tracks[0]!.stop).toHaveBeenCalledOnce();
  });

  it("frees the stream when video creation fails", async () => {
    const f = fixture();
    const error = new Error("Video creation failed.");
    f.createElement.mockImplementation(() => { throw error; });
    await expect(browserScreenCaptureEnvironment().open()).rejects.toBe(error);
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("frees all tracks and detaches the video when metadata fails", async () => {
    const f = fixture();
    f.video.readyState = 0;
    const opening = browserScreenCaptureEnvironment().open();
    await Promise.resolve();
    f.video.error = { code: 3 };
    f.video.dispatchEvent(new Event("error"));
    await expect(opening).rejects.toThrow("could not be decoded (code 3)");
    expect(f.video.pause).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(f.video.play).not.toHaveBeenCalled();
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("frees all tracks when metadata never arrives", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.video.readyState = 0;
    const opening = browserScreenCaptureEnvironment().open();
    const rejection = expect(opening).rejects.toThrow("Timed out after 10000ms");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("frees all tracks and detaches the video when playback fails", async () => {
    const f = fixture();
    const error = new DOMException("Playback refused.", "NotAllowedError");
    f.video.play.mockRejectedValue(error);
    await expect(browserScreenCaptureEnvironment().open()).rejects.toBe(error);
    expect(f.video.pause).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("removes subscriptions and stops every track exactly once on owner cleanup", async () => {
    const f = fixture();
    const capture = await browserScreenCaptureEnvironment().open();
    const ended = vi.fn();
    const unsubscribe = capture.onEnded(ended);
    capture.stop(); capture.stop(); unsubscribe(); unsubscribe();
    for (const track of f.tracks) { expect(track.stop).toHaveBeenCalledOnce(); track.end(); }
    expect(f.video.pause).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(ended).not.toHaveBeenCalled();
  });

  it("subscribes only video tracks, isolates unsubscribe, and reports ended once per listener", async () => {
    const f = fixture();
    const capture = await browserScreenCaptureEnvironment().open();
    const removed = vi.fn(), active = vi.fn();
    const unsubscribe = capture.onEnded(removed);
    capture.onEnded(active);
    unsubscribe(); unsubscribe();
    f.tracks[2]!.end();
    expect(active).not.toHaveBeenCalled();
    f.tracks[0]!.end(); f.tracks[1]!.end();
    expect(active).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
    capture.stop();
  });

  it("reports sharing ended before listener registration instead of losing the event", async () => {
    const f = fixture();
    const capture = await browserScreenCaptureEnvironment().open();
    f.tracks[0]!.end();
    const ended = vi.fn();
    capture.onEnded(ended);
    expect(ended).toHaveBeenCalledOnce();
    f.tracks[1]!.end();
    expect(ended).toHaveBeenCalledOnce();
    capture.stop();
  });

  it("rejects capture that ended while video playback was being prepared", async () => {
    const f = fixture();
    f.video.play.mockImplementation(async () => { f.tracks[0]!.end(); });
    await expect(browserScreenCaptureEnvironment().open()).rejects.toThrow("ended before the video was ready");
    for (const track of f.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
  });
});
