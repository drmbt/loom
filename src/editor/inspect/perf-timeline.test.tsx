import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createFrameTimeline, createTelemetryHub } from "@runtime/telemetry/index.ts";
import type { TimelineWindow } from "@runtime/telemetry/index.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { PerformancePanel } from "./performance-panel.tsx";
import { describeAt } from "./perf-timeline.tsx";

/**
 * §T1392b — the timeline's readout names the frame under the pointer, and the perf tab
 * actually mounts the chart over the REAL hub (a chart fed by nothing is the §V844 shape).
 */

beforeAll(installDomStubs);
afterEach(cleanup);

function windowOf(): TimelineWindow {
  const timeline = createFrameTimeline();
  for (const at of [1000, 1016, 1032, 1082, 1098]) timeline.noteFrame(at);
  timeline.noteGpu(1085, 12.25, { blur: 8, bloom: 3, out: 0.5 });
  return timeline.window(1100, 100);
}

describe("the timeline readout", () => {
  it("names the frame nearest the pointer, its interval, and the nearest GPU frame's dearest passes", () => {
    // 1082 is 82% of the way across 1000..1100: the 50 ms spike.
    expect(describeAt(windowOf(), 0.82)).toBe("0.0 s ago · frame 50.0 ms · GPU 12.3 ms (blur 8.0, bloom 3.0, out 0.5)");
  });

  it("says a frame came after a pause rather than calling the gap a frame time", () => {
    const timeline = createFrameTimeline();
    timeline.noteFrame(0);
    timeline.noteFrame(5000);
    expect(describeAt(timeline.window(5000, 6000), 1)).toBe("0.0 s ago · after a pause");
  });
});

describe("the performance tab", () => {
  it("mounts the timeline over the real hub, with the project's budget", () => {
    const hub = createTelemetryHub();
    render(<PerformancePanel telemetry={hub} fps={30} />);
    expect(screen.getByTestId("perf-timeline")).toBeTruthy();
    expect(screen.getByRole("status", { name: "" }).textContent ?? "").toContain("budget 33.3 ms");
    hub.dispose();
  });

  it("pauses and resumes from the button", () => {
    const hub = createTelemetryHub();
    render(<PerformancePanel telemetry={hub} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Resume" }).getAttribute("aria-pressed")).toBe("true");
    hub.dispose();
  });
});
