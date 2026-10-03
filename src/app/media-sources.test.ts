import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitMediaReady } from "./media-sources.ts";

afterEach(() => vi.useRealTimers());

class Media extends EventTarget {
  readyState = 0;
}

describe("awaitMediaReady cancellation", () => {
  it("aborts pending metadata and removes both media listeners, abort listener and timer", async () => {
    vi.useFakeTimers();
    const media = new Media();
    const controller = new AbortController();
    const remove = vi.spyOn(media, "removeEventListener");
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = awaitMediaReady(media, undefined, undefined, undefined, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBe(controller.signal.reason);
    expect(remove.mock.calls.map(call => call[0])).toEqual(["loadedmetadata", "error"]);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    media.dispatchEvent(new Event("loadedmetadata"));
    media.dispatchEvent(new Event("error"));
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("rejects an already-aborted signal even when metadata is ready, without scheduling", async () => {
    const media = new Media();
    media.readyState = 1;
    const controller = new AbortController();
    const reason = new Error("Capture retired");
    controller.abort(reason);
    const schedule = vi.fn();
    const add = vi.spyOn(media, "addEventListener");
    await expect(awaitMediaReady(media, 100, schedule, vi.fn(), controller.signal)).rejects.toBe(reason);
    expect(schedule).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("removes cancellation ownership after metadata succeeds", async () => {
    vi.useFakeTimers();
    const media = new Media();
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = awaitMediaReady(media, undefined, undefined, undefined, controller.signal);
    media.dispatchEvent(new Event("loadedmetadata"));
    await expect(waiting).resolves.toBeUndefined();
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});
