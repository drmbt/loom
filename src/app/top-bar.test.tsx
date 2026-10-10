// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createTelemetryHub } from "@runtime/telemetry/hub.ts";
import type { TelemetrySnapshot, TelemetrySource } from "@runtime/telemetry/types.ts";
import { FrameMsReadout } from "./gpu-readout.tsx";
import { TopBar } from "./top-bar.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

/**
 * T1256 — the top bar is transport, fps and GPU ms, and nothing that is not live.
 *
 * The `tier B` chip sat beside the GPU readout for the life of the app: a fact about the
 * device, read once at probe time, occupying the bar's scarcest space ten hours a day.
 * The owner's words: "taking up valuable space". The performance pane's GPU block already
 * carried the same value (`dock-panes.test.tsx` asserts it still does), so the chip was a
 * duplicate and it left. This test fails the moment it comes back — with any prop, under
 * any name — because it asserts on the RENDERED TEXT, not on the prop surface.
 */
describe("top bar — no capability tier (T1256)", () => {
  it("renders transport, fps and GPU ms and never the word tier", () => {
    const noop = () => {};
    render(
      <TooltipProvider>
        <TopBar onPlayPause={noop} onStep={noop} onResetTime={noop} fps={60} gpuMs={4.25} />
      </TooltipProvider>,
    );

    expect(screen.getByRole("group", { name: "Transport" })).toBeDefined();
    expect(screen.getByLabelText("Frames per second").textContent).toBe("60.0");
    expect(screen.getByLabelText("GPU time per frame").textContent).toBe("4.25 ms");
    expect(screen.queryByText(/\btier\b/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\btier\b/i);
  });
});

it("opens rendering from the transport's record control, without duplicate status text", () => {
  const onRenderRange = vi.fn();
  const view = render(<TooltipProvider><TopBar onRenderRange={onRenderRange} renderFrames={240} playing={false} onPlayPause={() => {}} /></TooltipProvider>);
  const transport = screen.getByRole("group", { name: "Transport" });
  fireEvent.click(within(transport).getByRole("button", { name: "Record / render output" }));
  expect(onRenderRange).toHaveBeenCalledOnce();
  expect(screen.queryByText(/^(idle|live|render)$/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Record audio features" })).toBeNull();
  expect(within(transport).getByRole("button", { name: "Play" }).getAttribute("aria-pressed")).toBe("false");
  view.rerender(<TooltipProvider><TopBar onRenderRange={onRenderRange} renderFrames={240} playing onPlayPause={() => {}} /></TooltipProvider>);
  expect(within(transport).getByRole("button", { name: "Pause" }).getAttribute("aria-pressed")).toBe("true");
});

it("shows FPS, GPU and CPU timing in one group", () => {
  render(<TooltipProvider><TopBar fps={60} gpuMs={4.25} cpuMs={1.5} /></TooltipProvider>);
  const fps = screen.getByLabelText("Frames per second");
  const gpu = screen.getByLabelText("GPU time per frame");
  const cpu = screen.getByLabelText("CPU encode time per frame");
  expect(cpu.textContent).toBe("1.50 ms");
  expect(fps.parentElement?.parentElement).toBe(gpu.parentElement?.parentElement);
  expect(cpu.parentElement?.parentElement).toBe(gpu.parentElement?.parentElement);
});

it("disables record while rendering and hides it when there is no output", () => {
  const onRenderRange = vi.fn();
  const view = render(<TooltipProvider><TopBar onRenderRange={onRenderRange} renderFrames={240} rendering /></TooltipProvider>);
  const record = screen.getByRole("button", { name: "Record / render output" });
  expect(record.getAttribute("aria-pressed")).toBe("true");
  expect(record.hasAttribute("disabled")).toBe(true);
  view.rerender(<TooltipProvider><TopBar onRenderRange={onRenderRange} renderFrames={0} /></TooltipProvider>);
  expect(screen.queryByRole("button", { name: "Record / render output" })).toBeNull();
});

it("keeps GPU and CPU measurements separate and leaves unmeasured CPU time absent", () => {
  const hub = createTelemetryHub();
  let snapshot: TelemetrySnapshot = hub.snapshot();
  const listeners = new Set<() => void>();
  const telemetry: TelemetrySource = {
    ...hub,
    snapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  render(<TooltipProvider><TopBar gpuMetric={<FrameMsReadout telemetry={telemetry} />} cpuMetric={<FrameMsReadout telemetry={telemetry} metric="cpu" />} /></TooltipProvider>);
  const cpu = screen.getByLabelText("CPU encode time per frame");
  const gpu = screen.getByLabelText("GPU time per frame");
  expect(cpu.textContent).toBe("—");
  act(() => {
    snapshot = {
      ...snapshot,
      frame: { ...snapshot.frame, availability: "measured", gpuMs: 4.25 },
      cpuTimingAvailable: true,
      categories: [
        { category: "filter", nodeCount: 1, passCount: 1, cpu: { availability: "measured", ms: 1.25 }, gpu: { availability: "measured", ms: 4.25 } },
        { category: "generator", nodeCount: 1, passCount: 1, cpu: { availability: "measured", ms: 0.5 }, gpu: { availability: "pending", ms: null } },
      ],
    };
    for (const listener of listeners) listener();
  });
  expect(cpu.textContent).toBe("1.75 ms");
  expect(gpu.textContent).toBe("4.25 ms");
  act(() => {
    snapshot = { ...snapshot, categories: snapshot.categories.map(row => ({ ...row, cpu: { availability: "pending", ms: null } })) };
    for (const listener of listeners) listener();
  });
  expect(cpu.textContent).toBe("—");
  expect(gpu.textContent).toBe("4.25 ms");
  hub.dispose();
});
