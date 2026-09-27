import { describe, expect, it } from "vitest";
import { createFrameTimeline } from "./timeline.ts";

/**
 * §T1392b — the timeline keeps every recent frame so a ONE-frame spike is still there to
 * see after the 10 Hz snapshot has moved on. Asserted on the window a chart reads.
 */
describe("the frame timeline", () => {
  it("keeps each frame's interval, so a single slow frame survives as its own sample", () => {
    const timeline = createFrameTimeline();
    for (const at of [0, 16, 32, 48, 98, 114]) timeline.noteFrame(at);
    const window = timeline.window(114, 1000);
    expect(window.frameAt).toEqual([0, 16, 32, 48, 98, 114]);
    // The first frame has nothing before it; the 50 ms frame is the spike.
    expect(window.intervalMs.slice(1)).toEqual([16, 16, 16, 50, 16]);
    expect(Number.isNaN(window.intervalMs[0])).toBe(true);
  });

  it("records a pause as a BREAK, never as a spike", () => {
    const timeline = createFrameTimeline();
    for (const at of [0, 16, 5016, 5032]) timeline.noteFrame(at);
    const intervals = timeline.window(5032, 10_000).intervalMs;
    expect(Number.isNaN(intervals[2])).toBe(true);
    expect(intervals[3]).toBe(16);
  });

  it("returns only the requested window, and forgets the oldest past capacity", () => {
    const timeline = createFrameTimeline(4);
    for (const at of [0, 10, 20, 30, 40, 50]) timeline.noteFrame(at);
    expect(timeline.window(50, 1000).frameAt).toEqual([20, 30, 40, 50]);
    expect(timeline.window(50, 15).frameAt).toEqual([40, 50]);
  });

  it("keeps each GPU frame's three dearest passes, dearest first, and the events", () => {
    const timeline = createFrameTimeline();
    timeline.noteGpu(10, 7.5, { blur: 3, bloom: 2.5, out: 0.5, noise: 1.5 });
    timeline.mark(12, "compile");
    const window = timeline.window(20, 100);
    expect(window.gpu).toEqual([
      { at: 10, gpuMs: 7.5, top: [{ passId: "blur", ms: 3 }, { passId: "bloom", ms: 2.5 }, { passId: "noise", ms: 1.5 }] },
    ]);
    expect(window.marks).toEqual([{ at: 12, kind: "compile" }]);
  });
});
