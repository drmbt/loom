import { describe, expect, it } from "vitest";
import { WIRE_GRAB_RADIUS, WIRE_RANGE_PX, wireAnswer, wireRangeInGraph, wireScale } from "./wire-range.ts";

/**
 * T1639b — the range a wire connects from, and what the port in range says.
 *
 * The owner's canvas runs from 15 % to 800 %. React Flow measures its `connectionRadius`
 * in graph units, so a fixed number there was 7 px of reach at 35 % and 160 px at 800 %.
 * What is held here is the rule in the units a person meets it in: pixels on screen.
 */

const onScreen = (zoom: number): number => wireRangeInGraph(zoom) * zoom;

describe("the range does not shrink with the canvas", () => {
  it("is the same number of screen pixels at every zoom from 100 % down", () => {
    for (const zoom of [1, 0.7, 0.5, 0.35, 0.15, 0.05]) {
      expect(onScreen(zoom)).toBeCloseTo(WIRE_RANGE_PX, 9);
    }
  });

  it("grows with the canvas above 100 %, where the port grows too", () => {
    for (const zoom of [1.5, 2, 4, 8]) {
      expect(wireRangeInGraph(zoom)).toBe(WIRE_RANGE_PX);
      expect(onScreen(zoom)).toBeCloseTo(WIRE_RANGE_PX * zoom, 9);
    }
    // The dot is 7 graph px wide. At 800 % the range still clears it by a wide margin.
    expect(onScreen(8)).toBeGreaterThan(8 * 7 * 3);
  });

  it("is continuous across 100 %", () => {
    expect(onScreen(0.999)).toBeCloseTo(onScreen(1.001), 0);
  });

  it("reads a zoom that is not a positive number as 100 % (an unlaid-out pane, §V66)", () => {
    for (const zoom of [0, -1, Number.NaN]) {
      expect(wireScale(zoom)).toBe(1);
      expect(wireRangeInGraph(zoom)).toBe(WIRE_RANGE_PX);
    }
  });

  it("reaches a few port rows and not a whole node", () => {
    // Rows are 18 px apart and a node is 178 px wide. More than a row, or the range is no
    // help; less than half a node, or a wire let go beside a node lands in it.
    expect(WIRE_RANGE_PX).toBeGreaterThan(18 * 2);
    expect(WIRE_RANGE_PX).toBeLessThan(178 / 2);
  });

  it("the grab zone on a wire's end is a different, smaller thing", () => {
    expect(WIRE_GRAB_RADIUS).toBeLessThan(WIRE_RANGE_PX / 2);
  });
});

describe("what the port in range says", () => {
  const output = { type: "source" };
  const input = { type: "target" };

  it("nothing in range: free", () => {
    expect(wireAnswer({ isValid: null, fromHandle: output, toHandle: null })).toBe("free");
  });

  it("a port the validity rule accepts: live", () => {
    expect(wireAnswer({ isValid: true, fromHandle: output, toHandle: input })).toBe("live");
    // Held by its input, landing on an output: the same answer the other way round.
    expect(wireAnswer({ isValid: true, fromHandle: input, toHandle: output })).toBe("live");
  });

  it("the right kind of end, refused by the rule: refused, never live", () => {
    expect(wireAnswer({ isValid: false, fromHandle: output, toHandle: input })).toBe("refused");
    expect(wireAnswer({ isValid: false, fromHandle: input, toHandle: output })).toBe("refused");
  });

  it("an end that could never be the other end is not refusing anything: free", () => {
    // Dragging from an output, every drag starts within range of the same node's other
    // outputs. They are not candidates, and marking them would mark every drag's start.
    expect(wireAnswer({ isValid: false, fromHandle: output, toHandle: output })).toBe("free");
    expect(wireAnswer({ isValid: false, fromHandle: input, toHandle: input })).toBe("free");
  });

  it("no connection in progress: free", () => {
    expect(wireAnswer({ isValid: null, fromHandle: null, toHandle: null })).toBe("free");
  });
});
