import { describe, expect, it } from "vitest";

import { resolveLane } from "@domain/automation/evaluate.ts";
import { newKey, newLane } from "@domain/automation/model.ts";
import { hitTest, marquee } from "./timeline-hit.ts";
import { evaluateNormalized } from "@domain/automation/evaluate.ts";
import { automationNodes, currentAutomationNode, laneReferenceCounts, timelineReadout } from "./timeline-model.ts";
import { formatMinSec, frameAtX, topLabel } from "./timeline-draw.ts";
import { rateOf } from "@domain/time/ticks.ts";
import {
  displayValue,
  followPage,
  frameAll,
  pan,
  sampleColumns,
  storedValue,
  tickToX,
  valueToY,
  xToTick,
  zoomTimeAt,
  zoomValueAt,
  type TimelineView,
} from "./timeline-view.ts";

const S = 240_000;
const view: TimelineView = { startTicks: 0, ticksPerPixel: S / 100, valueLow: 0, valueHigh: 1 };
const ramp = resolveLane(newLane("a", "ramp", [newKey("k1", 0, 0, { interp: "linear" }), newKey("k2", S, 1)], { min: -10, max: 10 }));

describe("VN62 — the view", () => {
  it("maps ticks and values to pixels and back", () => {
    expect(tickToX(view, S)).toBe(100);
    expect(xToTick(view, 50)).toBe(S / 2);
    expect(valueToY(view, 200, 0.25)).toBe(150);
    expect(displayValue(ramp.lane, 0.75, "values")).toBe(5);
    expect(storedValue(ramp.lane, 5, "values")).toBe(0.75);
  });

  it("zoom keeps the tick under the cursor, and the value under it", () => {
    const zoomed = zoomTimeAt(view, 37, 0.5);
    expect(xToTick(zoomed, 37)).toBeCloseTo(xToTick(view, 37), 6);
    expect(zoomed.ticksPerPixel).toBe(S / 200);
    const value = zoomValueAt(view, 200, 60, 2);
    expect(value.valueLow + ((200 - 60) / 200) * (value.valueHigh - value.valueLow)).toBeCloseTo(0.7, 12);
    expect(pan(view, 200, 10, 0).startTicks).toBe(-10 * (S / 100));
  });

  it("frame-all includes handles", () => {
    const lane = resolveLane(newLane("a", "x", [newKey("k1", S, 0.5, { handle: "free", out: [S, 0.5] }), newKey("k2", 3 * S, 0.5, { handle: "free", in: [-S, -0.5] })]));
    const framed = frameAll([lane], 400, "normalized", 0);
    expect(framed.valueLow).toBe(0);
    expect(framed.valueHigh).toBe(1);
    expect(framed.startTicks).toBe(S);
    expect(framed.startTicks + 400 * framed.ticksPerPixel).toBe(3 * S);
  });

  it("follow pages only when the playhead leaves the window", () => {
    expect(followPage(view, 100, S / 2)).toBe(view);
    expect(followPage(view, 100, 3 * S).startTicks).toBe(3 * S - 5 * (S / 100));
  });

  it("samples the curve once per pixel column, not per frame", () => {
    const samples = sampleColumns(ramp, view, 100, "normalized");
    expect(samples).toHaveLength(100);
    expect(samples[49]).toBeCloseTo(0.495, 12);
    expect(sampleColumns(ramp, { ...view, ticksPerPixel: S / 1000 }, 1000, "normalized")).toHaveLength(1000);
  });
});

describe("VN62 — hit-testing and the marquee", () => {
  const geometry = { view, height: 100, mode: "normalized" as const };
  it("finds a key, and a selected key's handle before it", () => {
    expect(hitTest(geometry, [ramp], 100, 1, () => false)).toEqual({ kind: "key", ref: { lane: "a", key: "k2" } });
    expect(hitTest(geometry, [ramp], 60, 50, () => false)).toEqual({ kind: "none" });
    const handled = resolveLane(newLane("h", "h", [newKey("k1", 0, 0.5, { handle: "free", out: [S / 2, 0] }), newKey("k2", S, 0.5)]));
    expect(hitTest(geometry, [handled], 50, 50, () => true)).toEqual({ kind: "handle", ref: { lane: "h", key: "k1" }, side: "out" });
    expect(hitTest(geometry, [handled], 50, 50, () => false)).toEqual({ kind: "none" });
  });

  it("catches keys inside; with none inside, the segments it crosses", () => {
    expect(marquee(geometry, [ramp], { x0: -5, y0: 90, x1: 5, y1: 110 }, evaluateNormalized)).toEqual([{ lane: "a", key: "k1" }]);
    expect(marquee(geometry, [ramp], { x0: 40, y0: 40, x1: 60, y1: 60 }, evaluateNormalized)).toEqual([{ lane: "a", key: "k1" }, { lane: "a", key: "k2" }]);
    expect(marquee(geometry, [ramp], { x0: 40, y0: 0, x1: 60, y1: 10 }, evaluateNormalized)).toEqual([]);
  });
});

describe("VN62 — the model, the readout and the ruler labels", () => {
  const node = (id: string, label: string | undefined, parameters: Record<string, unknown> = {}) =>
    ({ id, type: "automation", definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(label === undefined ? {} : { label }) }) as never;
  const graph = {
    revision: 1,
    groups: {},
    edges: {},
    nodes: {
      b: node("b", "automation_b"),
      a: node("a", "automation_a", { lanes: "{" }),
      reader: { id: "reader", type: "constant", definitionVersion: 1, position: { x: 0, y: 0 }, label: "constant_r",
        parameters: { value: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('automation_b').chan.x + op('automation_b').chan.x + op('automation_b').chan.y" } } } } },
    },
  } as never;

  it("lists automation nodes by name, picks the current one, and counts references", () => {
    const nodes = automationNodes(graph);
    expect(nodes.map((each) => each.id)).toEqual(["a", "b"]);
    expect(nodes[0]!.error).toMatch(/not valid JSON/);
    expect(currentAutomationNode(nodes, "b", "a")?.id).toBe("b");
    expect(currentAutomationNode(nodes, "reader", "b")?.id).toBe("b");
    expect(currentAutomationNode(nodes, null, null)?.id).toBe("a");
    expect([...laneReferenceCounts(graph, "automation_b")]).toEqual([["x", 2], ["y", 1]]);
  });

  it("reads timecode, frame, elapsed and remaining; drop-frame at 29.97", () => {
    expect(timelineReadout(1800, 29.97, { start: 0, end: 3599 })).toEqual({ timecode: "00:01:00;02", frame: "1800", elapsed: "00:01:00;02", remaining: "00:00:59;29" });
    expect(timelineReadout(30, 30, { start: 10, end: 99 })).toEqual({ timecode: "00:00:01:00", frame: "30", elapsed: "00:00:00:20", remaining: "00:00:02:09" });
  });

  it("labels the ruler and maps a ruler click to the frame under it", () => {
    expect(formatMinSec(65 * S)).toBe("1:05");
    expect(formatMinSec(3605 * S)).toBe("1:00:05");
    expect(topLabel(S, { ticks: S, unit: "seconds", count: 1 }, rateOf(30), false)).toBe("00:00:01:00");
    expect(topLabel(16_000, { ticks: 8_000, unit: "frames", count: 1 }, rateOf(30), false)).toBe("2");
    expect(frameAtX(view, 50, rateOf(30))).toBe(15);
    expect(frameAtX(view, -10, rateOf(30))).toBe(0);
  });
});
