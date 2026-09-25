import { describe, expect, it } from "vitest";
import {
  barGeometry,
  channelScale,
  isChannelOn,
  observeChannels,
  resolveValuePlotMode,
} from "./value-plot-mode.ts";
import type { ObservedRange } from "./value-plot-mode.ts";

describe("which picture a value node draws by default", () => {
  it("leaves a pure periodic node on its curve", () => {
    /*
     * The whole of T459 is that a bar cannot carry what an LFO is for. If this ever
     * flips, a user opening a sine source sees a filled track and no frequency, no
     * waveform and no phase — every fact the node was drawn to show.
     */
    expect(resolveValuePlotMode(undefined, true)).toBe("trail");
  });

  it("puts everything else on the bar", () => {
    expect(resolveValuePlotMode(undefined, false)).toBe("bar");
  });

  it("obeys the document over the default, in both directions", () => {
    // The default is a guess about the node; a stored mode is the user's answer, and a
    // default that could override it would make the toggle look broken on exactly the
    // nodes whose default the user disagreed with.
    expect(resolveValuePlotMode("bar", true)).toBe("bar");
    expect(resolveValuePlotMode("trail", false)).toBe("trail");
  });
});

describe("bar geometry", () => {
  it("fills from the left on a unipolar range", () => {
    expect(barGeometry(0.25, 0, 1)).toEqual({ anchor: 0, start: 0, end: 0.25, clipped: false });
  });

  it("fills from the CENTRE on a bipolar range, downward for a negative value", () => {
    /*
     * The reason the range carries the zero instead of a separate flag. Against -1..1,
     * -0.5 is a bar reaching left from the middle. Fill from the left edge instead and
     * -0.5 draws a quarter-full track that is indistinguishable from +(-0.5 remapped) —
     * i.e. the sign, the one thing you look at a bipolar meter to see, disappears.
     */
    expect(barGeometry(-0.5, -1, 1)).toEqual({ anchor: 0.5, start: 0.25, end: 0.5, clipped: false });
    expect(barGeometry(0.5, -1, 1)).toEqual({ anchor: 0.5, start: 0.5, end: 0.75, clipped: false });
  });

  it("anchors at the right edge when the range is entirely negative", () => {
    // -1..0: zero is the top of the range, so the bar hangs from the right.
    expect(barGeometry(-0.25, -1, 0)).toEqual({ anchor: 1, start: 0.75, end: 1, clipped: false });
  });

  it("clamps a value outside the range and SAYS it clamped", () => {
    /*
     * Against a declared range this is the node breaking its own contract, and the flag
     * is the only way the picture can differ from a value legitimately at full scale.
     */
    expect(barGeometry(1.5, 0, 1)).toEqual({ anchor: 0, start: 0, end: 1, clipped: true });
    expect(barGeometry(-0.2, 0, 1)).toEqual({ anchor: 0, start: 0, end: 0, clipped: true });
    expect(barGeometry(1, 0, 1)?.clipped).toBe(false);
  });

  it("draws NO bar for a zero-width range", () => {
    /*
     * The state every observed channel is in after one sample. A half-filled track would
     * be a picture of a ratio nobody computed; the caller falls back to the number alone.
     */
    expect(barGeometry(5, 5, 5)).toBeNull();
    expect(barGeometry(5, 10, 0)).toBeNull();
  });

  it("draws no bar for a non-finite reading or range", () => {
    expect(barGeometry(Number.NaN, 0, 1)).toBeNull();
    expect(barGeometry(0.5, 0, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("observed extremes", () => {
  it("covers EVERY published channel, not just the ones with a curve", () => {
    /*
     * The reason this reads `latest` rather than `ValueHistory.series`. The series stop
     * at MAX_PLOTTED_CHANNELS, so a range derived from them leaves audioIn's other
     * seventeen channels with no scale — which is most of the node.
     */
    const observed = new Map<string, ObservedRange>();
    observeChannels(observed, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    expect([...observed.keys()]).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("widens to the extremes seen so far and never narrows", () => {
    const observed = new Map<string, ObservedRange>();
    observeChannels(observed, { x: 0 });
    observeChannels(observed, { x: 5 });
    observeChannels(observed, { x: -2 });
    observeChannels(observed, { x: 1 });
    expect(observed.get("x")).toEqual({ low: -2, high: 5 });
  });

  it("ignores a non-finite reading instead of poisoning the range forever", () => {
    /*
     * A range is cumulative, so a single NaN or Infinity is not a bad frame — it is a
     * channel whose every later bar is drawn against garbage, with no way back short of
     * closing the pane.
     */
    const observed = new Map<string, ObservedRange>();
    observeChannels(observed, { x: 0 });
    observeChannels(observed, { x: Number.NaN });
    observeChannels(observed, { x: Number.POSITIVE_INFINITY });
    observeChannels(observed, { x: 1 });
    expect(observed.get("x")).toEqual({ low: 0, high: 1 });
  });

  it("does nothing before the first sample", () => {
    const observed = new Map<string, ObservedRange>();
    observeChannels(observed, null);
    expect(observed.size).toBe(0);
  });
});

describe("which scale a channel is drawn against", () => {
  it("prefers the declared range and marks it declared", () => {
    const scale = channelScale({ kind: "bounded", low: -1, high: 1 }, { low: -0.1, high: 0.1 });
    expect(scale).toEqual({ kind: "bounded", low: -1, high: 1, declared: true });
  });

  it("falls back to what was observed, and marks it NOT declared", () => {
    /*
     * The flag is the whole difference between "60% of -1..1" and "60% of whatever this
     * channel has done since you opened the pane". Both are drawable; only one is a fact
     * about the node, and a renderer that cannot tell them apart will draw them alike.
     */
    expect(channelScale(undefined, { low: -3.2, high: 8.1 })).toEqual({
      kind: "bounded",
      low: -3.2,
      high: 8.1,
      declared: false,
    });
  });

  it("keeps a boolean out of the bounded lane entirely", () => {
    // Not { low: 0, high: 1 }: a half-filled boolean is not a state it has.
    expect(channelScale({ kind: "boolean" }, { low: 0, high: 1 })).toEqual({ kind: "boolean" });
  });

  it("has no scale at all before the channel has been seen", () => {
    expect(channelScale(undefined, undefined)).toBeNull();
  });
});

describe("boolean readings", () => {
  it("is on for any non-zero and off for zero", () => {
    expect(isChannelOn(1)).toBe(true);
    expect(isChannelOn(-1)).toBe(true);
    expect(isChannelOn(0)).toBe(false);
  });

  it("is off for a non-finite reading rather than quietly on", () => {
    // `NaN !== 0` is true, so the naive test lights the pill on a broken channel.
    expect(isChannelOn(Number.NaN)).toBe(false);
  });
});
