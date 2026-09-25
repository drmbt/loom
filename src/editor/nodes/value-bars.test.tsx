import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ValuePlot } from "./value-plot.tsx";
import type { ValueHistory, ValueHistorySource } from "./value-history.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ValuePlotMode } from "@domain/types/graph.ts";

/**
 * The BAR picture, through the component the graph pane really mounts.
 *
 * Asserted at the DOM the user sees — the width of a fill, the mark at zero, the state on
 * a track — rather than at the geometry function, which `value-plot-mode.test.ts` already
 * pins at exact numbers. The two halves answer different questions: that one asks whether
 * the arithmetic is right, this one asks whether any of it reached the screen. A bar that
 * computes perfectly and renders at 0% passes the first and fails this.
 */

function historyOf(latest: Record<string, number>, channels?: readonly string[]): ValueHistory {
  const names = channels ?? Object.keys(latest);
  return {
    channels: names,
    plotted: names.slice(0, 4),
    series: names.slice(0, 4).map((name) => [latest[name] ?? 0]),
    latest,
    timeSeconds: 1,
  };
}

function sourceOf(latest: ValueHistory): ValueHistorySource {
  return { get: () => latest, subscribe: () => () => {} };
}

/** A stateful node — the kind whose default picture is the bar. */
function statefulDefinition(
  meta?: NodeDefinition["valueChannelMeta"],
): { definition: NodeDefinition; values: Record<string, never>; randomSeed: number } {
  const definition = {
    type: "test.lag",
    version: 1,
    title: "Lag",
    category: "value",
    description: "",
    tags: [],
    inputs: [],
    outputs: [],
    parameters: {},
    // No `valueChannel`, so `sampleValueFunction` finds no curve and the node is not pure.
    valueEvaluate: () => ({}),
    ...(meta === undefined ? {} : { valueChannelMeta: meta }),
    compile: () => [],
  } as unknown as NodeDefinition;
  return { definition, values: {}, randomSeed: 1 };
}

function mount(
  latest: Record<string, number>,
  options: {
    meta?: NodeDefinition["valueChannelMeta"];
    mode?: ValuePlotMode;
    channels?: readonly string[];
    onSetMode?: (mode: ValuePlotMode | null) => void;
  } = {},
) {
  render(
    <ValuePlot
      nodeId="lag"
      history={sourceOf(historyOf(latest, options.channels))}
      source={statefulDefinition(options.meta)}
      mode={options.mode}
      onSetMode={options.onSetMode}
    />,
  );
}

const track = (channel: string) => screen.getByTestId(`value-track-lag-${channel}`);
const fillWidth = (channel: string) =>
  (track(channel).firstElementChild as HTMLElement | null)?.style.inlineSize;
const fillStart = (channel: string) =>
  (track(channel).firstElementChild as HTMLElement | null)?.style.insetInlineStart;

beforeAll(() => {
  installDomStubs();
});

afterEach(cleanup);

describe("a stateful value node draws BARS by default", () => {
  it("renders bars and no curve at all", () => {
    /*
     * The default flip, asserted from both sides. "Bars appeared" alone would still pass
     * if the SVG were also drawn — which is the version of this change that costs the
     * per-tick path build it was partly meant to avoid.
     */
    mount({ value: 0.5 });
    expect(screen.getByTestId("value-bars-lag")).toBeTruthy();
    expect(document.querySelectorAll("svg path")).toHaveLength(0);
  });

  it("gives EVERY channel a row, past the four the curve caps at", () => {
    /*
     * The cap exists because four legible LINES is what the body holds. A bar is a row,
     * so the cap does not apply — and this is the case T1297 could only half solve: the
     * fifth channel onward had a number and no picture.
     */
    mount({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    for (const channel of ["a", "b", "c", "d", "e", "f"]) {
      expect(screen.getByTestId(`value-bar-lag-${channel}`)).toBeTruthy();
    }
  });
});

describe("a declared range draws a different bar from an observed one", () => {
  it("fills against the DECLARED range, and says it is declared", () => {
    // 0.25 of 0..1 is a quarter of the track — not "a quarter of what this channel has
    // done so far", which with one sample would be the whole of it.
    mount({ value: 0.25 }, { meta: { value: { kind: "bounded", low: 0, high: 1 } } });
    expect(track("value").dataset["state"]).toBe("declared");
    expect(fillStart("value")).toBe("0%");
    expect(fillWidth("value")).toBe("25%");
  });

  it("marks an observed track as observed rather than drawing it like a fact", () => {
    /*
     * The misreading a bar can produce that a number cannot: full means "the top of a
     * range the node published" on one track and "the most I have seen this session" on
     * the other, and nothing in the number tells them apart.
     */
    mount({ value: 5 });
    expect(track("value").dataset["state"]).toBe("unscaled");
  });

  it("applies a node's blanket declaration to channels it cannot name", () => {
    /*
     * Trigger and Normalize both republish their INPUT's channel names, so neither can
     * declare `value` or `low` or `bpm` by name — and both have an exact range. Without
     * the wildcard the two most declarable nodes in the family declare nothing.
     */
    mount({ kick: 1, snare: 0 }, { meta: { "*": { kind: "boolean" } } });
    expect(screen.getByTestId("value-pill-lag-kick").dataset["state"]).toBe("on");
    expect(screen.getByTestId("value-pill-lag-snare").dataset["state"]).toBe("off");
  });

  it("lets a NAMED entry beat the blanket one", () => {
    mount(
      { x: 0.5, other: 1 },
      {
        meta: {
          "*": { kind: "boolean" },
          x: { kind: "bounded", low: 0, high: 1 },
        },
      },
    );
    expect(track("x").dataset["state"]).toBe("declared");
    expect(screen.getByTestId("value-pill-lag-other")).toBeTruthy();
  });
});

describe("a bipolar channel reads as bipolar", () => {
  it("grows LEFT from the centre for a negative value, and marks where zero is", () => {
    /*
     * The whole reason the declared range carries the zero. Filled from the left edge
     * instead, -0.5 against -1..1 is a quarter-full track — the same picture a positive
     * value would make, with the sign gone.
     */
    mount({ value: -0.5 }, { meta: { value: { kind: "bounded", low: -1, high: 1 } } });
    expect(fillStart("value")).toBe("25%");
    expect(fillWidth("value")).toBe("25%");
    expect(track("value").querySelectorAll("[class*='barZero']")).toHaveLength(1);
  });

  it("draws NO zero mark on a range that does not contain zero", () => {
    // It would sit exactly on the left edge and read as part of the frame.
    mount({ value: 0.5 }, { meta: { value: { kind: "bounded", low: 0, high: 1 } } });
    expect(track("value").querySelectorAll("[class*='barZero']")).toHaveLength(0);
  });
});

describe("a value outside its declared range", () => {
  it("is flagged rather than silently pinned at full", () => {
    /*
     * Against a DECLARED range this means the declaration is wrong or the node broke its
     * own contract. Clamped with no flag it is indistinguishable from a channel sitting
     * legitimately at its maximum, which is the reading that hides the bug.
     */
    mount({ value: 4 }, { meta: { value: { kind: "bounded", low: 0, high: 1 } } });
    expect(track("value").dataset["clipped"]).toBe("true");
    expect(fillWidth("value")).toBe("100%");
  });

  it("does NOT flag a value legitimately at the top of its range", () => {
    // The guard has to leave the legitimate case alone or it is just noise at full scale.
    mount({ value: 1 }, { meta: { value: { kind: "bounded", low: 0, high: 1 } } });
    expect(track("value").dataset["clipped"]).toBeUndefined();
    expect(fillWidth("value")).toBe("100%");
  });
});

describe("the mode button", () => {
  it("switches a bar node to the curve, through the callback and nothing else", () => {
    const asked: (ValuePlotMode | null)[] = [];
    mount({ value: 0.5 }, { onSetMode: (mode) => asked.push(mode) });
    fireEvent.click(screen.getByTestId("value-plot-mode-lag"));
    expect(asked).toEqual(["trail"]);
  });

  it("CLEARS the field when the choice returns to the node's own default", () => {
    /*
     * Two documents that draw identically must be the same bytes. `sync.test.ts` compares
     * examples byte for byte against their source, so a `valuePlotMode: "bar"` written
     * onto a node whose default is already bar would be a diff that changes no pixel.
     */
    const asked: (ValuePlotMode | null)[] = [];
    mount({ value: 0.5 }, { mode: "trail", onSetMode: (mode) => asked.push(mode) });
    fireEvent.click(screen.getByTestId("value-plot-mode-lag"));
    expect(asked).toEqual([null]);
  });

  it("is absent entirely when no one is listening for the change", () => {
    // A control that does nothing when pressed is worse than no control.
    mount({ value: 0.5 });
    expect(screen.queryByTestId("value-plot-mode-lag")).toBeNull();
  });

  it("does not let the press reach the canvas underneath", () => {
    /*
     * The canvas reads a click on a node as a selection gesture. Pressing a control inside
     * the body is not that, and a bar toggle that also re-selects the node would fight
     * whatever the user had selected.
     */
    let reachedCanvas = 0;
    render(
      <div onClick={() => (reachedCanvas += 1)}>
        <ValuePlot
          nodeId="lag"
          history={sourceOf(historyOf({ value: 0.5 }))}
          source={statefulDefinition()}
          onSetMode={() => {}}
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId("value-plot-mode-lag"));
    expect(reachedCanvas).toBe(0);
  });
});

describe("a node with nothing to show", () => {
  it("says so instead of drawing an empty bar at zero", () => {
    /*
     * §V91, in the mode that makes it easiest to get wrong: an empty track IS a picture of
     * zero, and "has produced nothing" is a different claim from "produced 0".
     */
    // A stable snapshot: a fixture returning a NEW object per call re-renders forever
    // through `useSyncExternalStore`, which is the store contract, not a component bug.
    const empty = historyOf({});
    render(
      <ValuePlot
        nodeId="lag"
        history={{ get: () => empty, subscribe: () => () => {} }}
        source={statefulDefinition()}
      />,
    );
    expect(screen.getByText("no signal yet")).toBeTruthy();
    expect(screen.queryByTestId("value-bars-lag")).toBeNull();
  });
});
