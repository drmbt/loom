import { describe, expect, it, vi } from "vitest";
import { mediaPlayhead, type MediaTransportValues } from "@domain/media/transport.ts";
import { type MediaSteppedTransport, type PlayableMedia } from "./media-playback.ts";
import { createMovieAudioPlayback } from "./movie-audio-playback.ts";

const BASE: MediaTransportValues = {
  playMode: "freeRun", play: true, speed: 1, cue: false, cuePoint: 0,
  trimStart: 0, trimEnd: 0, extend: "loop",
};
function stepped(audio = true, volume = 0.5, transport = BASE, elapsed = 0): MediaSteppedTransport {
  return { transport, head: mediaPlayhead(transport, elapsed, 10), continuous: false, correction: 0,
    read: key => key === "audio" ? audio : key === "volume" ? volume : undefined };
}
class Activation extends EventTarget {
  readonly listeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.add(listener);
    super.addEventListener(type, listener);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.delete(listener);
    super.removeEventListener(type, listener);
  }
}
function fixture() {
  const element = {
    currentTime: 0, playbackRate: 1, duration: 10, paused: true, muted: true, volume: 1,
    play: vi.fn<PlayableMedia["play"]>(() => { element.paused = false; }),
    pause: vi.fn(() => { element.paused = true; }),
  };
  const activation = new Activation();
  const report = vi.fn();
  const controller = createMovieAudioPlayback(element, activation, report);
  return { element, activation, report, controller };
}

describe("movie audio uses the video element's own decoder and transport", () => {
  it("preserves silent defaults, enables native volume, and silences black/zero/disabled output", () => {
    const f = fixture();
    f.controller.sync(stepped(false, 1), "realtime");
    expect(f.element.muted).toBe(true);
    f.controller.sync(stepped(true, 0.3), "realtime");
    expect(f.element.muted).toBe(false);
    expect(f.element.volume).toBe(0.3);
    f.controller.sync(stepped(true, 0), "realtime");
    expect(f.element.muted).toBe(true);
    f.controller.sync(stepped(true, 0.3, { ...BASE, extend: "black", trimEnd: 2 }, 3), "realtime");
    expect(f.element.muted).toBe(true);
    expect(f.element.paused).toBe(true);
    f.controller.dispose();
  });

  it("shares speed, trim, cue and pause with the picture without creating another element", () => {
    const f = fixture();
    f.controller.sync(stepped(true, 0.8, { ...BASE, speed: 2, trimStart: 1, trimEnd: 4 }, 1), "realtime");
    expect(f.element.playbackRate).toBe(2);
    expect(f.element.currentTime).toBe(3);
    const cued = stepped(true, 0.8, { ...BASE, cue: true, cuePoint: 2, trimStart: 1, trimEnd: 4 });
    f.controller.sync(cued, "realtime");
    expect(f.element.currentTime).toBe(cued.head.position);
    expect(f.element.paused).toBe(true);
    expect(f.element.muted).toBe(true);
    f.controller.sync(stepped(), "realtime");
    expect(f.element.paused).toBe(false);
    f.controller.pause();
    expect(f.element.paused).toBe(true);
    expect(f.element.muted).toBe(true);
    f.controller.dispose();
  });

  it("mutes fixed-step/offline frames and explicit realtime export ownership", () => {
    const f = fixture();
    f.controller.sync(stepped(), "fixed-step");
    expect(f.element.muted).toBe(true);
    f.controller.sync(stepped(), "offline");
    expect(f.element.muted).toBe(true);
    f.controller.sync(stepped(), "realtime");
    expect(f.element.muted).toBe(false);
    f.controller.setRenderMuted(true);
    expect(f.element.muted).toBe(true);
    f.controller.sync(stepped(), "realtime");
    expect(f.element.muted).toBe(true);
    f.controller.setRenderMuted(false);
    expect(f.element.muted).toBe(false);
    f.controller.dispose();
  });

  it("makes only one native play request while pending, then reports DOMException denial without retry storms", async () => {
    const f = fixture();
    let reject!: (reason: unknown) => void;
    f.element.play.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail; }));
    for (let frame = 0; frame < 60; frame++) f.controller.sync(stepped(), "realtime");
    expect(f.element.play).toHaveBeenCalledOnce();
    reject({ name: "NotAllowedError", message: "Autoplay denied" });
    await Promise.resolve();
    expect(f.report).toHaveBeenCalledWith(expect.stringContaining("browser autoplay"));
    expect(f.activation.listeners.size).toBe(1); // One callback shared by pointer and key activation.
    for (let frame = 0; frame < 60; frame++) f.controller.sync(stepped(), "realtime");
    expect(f.element.play).toHaveBeenCalledOnce();
    expect(f.report).toHaveBeenCalledOnce();
    f.element.play.mockImplementation(() => { f.element.paused = false; return Promise.resolve(); });
    f.activation.dispatchEvent(new Event("pointerdown"));
    expect(f.element.play).toHaveBeenCalledTimes(2); // Before awaiting: preserves activation.
    await Promise.resolve();
    expect(f.activation.listeners.size).toBe(0);
    expect(f.report).toHaveBeenLastCalledWith(null);
    f.activation.dispatchEvent(new Event("keydown"));
    expect(f.element.play).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });

  it.each(["cue", "hold", "reverse"])("removes activation while a blocked paused element enters %s", async kind => {
    const f = fixture();
    f.element.play.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    f.controller.sync(stepped(), "realtime");
    await Promise.resolve();
    expect(f.activation.listeners.size).toBe(1);
    const transport = { ...BASE, ...(kind === "cue" ? { cue: true } : kind === "hold" ? { play: false } : { speed: -1 }) };
    f.controller.sync(stepped(true, 0.5, transport), "realtime");
    expect(f.activation.listeners.size).toBe(0);
    expect(f.element.muted).toBe(true);
    f.activation.dispatchEvent(new Event("pointerdown"));
    expect(f.element.play).toHaveBeenCalledOnce();
    f.controller.dispose();
  });

  it("cancels pending ownership on pause/dispose so late playback cannot restart sound", async () => {
    const f = fixture();
    let resolve!: () => void;
    f.element.play.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    f.controller.sync(stepped(), "realtime");
    f.controller.pause();
    f.element.paused = false; // A stale browser play completes after transport pause.
    resolve();
    await Promise.resolve();
    expect(f.element.paused).toBe(true);
    expect(f.element.muted).toBe(true);
    f.controller.sync(stepped(), "realtime");
    f.controller.dispose(); f.controller.dispose();
    f.element.paused = false;
    resolve();
    await Promise.resolve();
    expect(f.element.paused).toBe(true);
    expect(f.element.muted).toBe(true);
    expect(f.report).not.toHaveBeenCalled();
    expect(f.activation.listeners.size).toBe(0);
  });

  it("cleans an active denial subscription on dispose and reports synchronous play failures", () => {
    const f = fixture();
    f.element.play.mockImplementation(() => { throw new Error("Decoder unavailable"); });
    f.controller.sync(stepped(), "realtime");
    expect(f.report).toHaveBeenCalledWith(expect.stringContaining("Decoder unavailable"));
    f.controller.dispose();
    expect(f.activation.listeners.size).toBe(0);
    f.activation.dispatchEvent(new Event("pointerdown"));
    expect(f.element.play).toHaveBeenCalledOnce();
    expect(() => f.controller.sync(stepped(), "realtime")).toThrow("closed");
  });
});
