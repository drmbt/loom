// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { ProjectSettings } from "@domain/types/graph.ts";
import type { RenderRangeSession } from "./use-render-range.ts";
import { RenderVideoDialog } from "./render-video-dialog.tsx";

afterEach(cleanup);

const SETTINGS = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm-srgb",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  fps: 60,
  frameRange: { start: 0, end: 599 },
  limits: {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
} as ProjectSettings;

function session(overrides: Partial<RenderRangeSession> = {}): RenderRangeSession {
  return {
    rendering: false,
    cancelling: false,
    cancelAvailable: true,
    includeAudio: true,
    setIncludeAudio: vi.fn(),
    frames: 600,
    diagnostics: [],
    progress: { stage: "frames", completedFrames: 0, totalFrames: 600, frameIndex: null },
    spooledBytes: 0,
    encoderSupport: { supported: true, codec: "avc1.42002a", reason: null },
    audioSupport: null,
    audioRequirement: { kind: "none" },
    outputReady: true,
    cancel: vi.fn(),
    prepareDestination: vi.fn(async () => true),
    renderSettings: {
      resolution: SETTINGS.outputResolution,
      outputFps: 60,
      range: { start: 0, end: 599 },
    },
    setRenderSettings: vi.fn(),
    ...overrides,
  };
}

it("edits take-local settings without mutating the project and starts a supported render", () => {
  const setRenderSettings = vi.fn();
  const onRender = vi.fn();
  render(
    <RenderVideoDialog
      open
      onOpenChange={vi.fn()}
      settings={SETTINGS}
      session={session({ setRenderSettings })}
      onRender={onRender}
    />,
  );

  expect(screen.getByText("600 frames · 10.00 s · video only")).toBeTruthy();
  expect(screen.getByText("Soundtrack: one locked Audio File In · mono AAC · 48 kHz")).toBeTruthy();
  expect(screen.getByText(/H.264 ready/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "4K UHD" }));
  expect(setRenderSettings).toHaveBeenCalledWith({ resolution: { width: 3840, height: 2160 } });
  const fps = screen.getByRole("spinbutton", { name: "render fps" });
  fireEvent.change(fps, { target: { value: "30" } });
  fireEvent.keyDown(fps, { key: "Enter" });
  expect(setRenderSettings).toHaveBeenCalledWith({ outputFps: 30 });
  const rangeIn = screen.getByRole("spinbutton", { name: "render range in" });
  fireEvent.change(rangeIn, { target: { value: "12" } });
  fireEvent.keyDown(rangeIn, { key: "Enter" });
  expect(setRenderSettings).toHaveBeenCalledWith({ range: { start: 12, end: 599 } });

  fireEvent.click(screen.getByRole("button", { name: "Render MP4" }));
  expect(onRender).toHaveBeenCalledOnce();
});

it("shows a settled cancellation state while cleanup finishes", () => {
  render(
    <RenderVideoDialog
      open
      onOpenChange={vi.fn()}
      settings={SETTINGS}
      session={session({ rendering: true, cancelling: true })}
      onRender={vi.fn()}
    />,
  );
  expect((screen.getByRole("button", { name: "Cancelling…" }) as HTMLButtonElement).disabled).toBe(true);
});

it("describes an enabled soundtrack as mono AAC instead of video only", () => {
  render(
    <RenderVideoDialog
      open
      onOpenChange={vi.fn()}
      settings={SETTINGS}
      session={session({
        audioRequirement: { kind: "required" },
        audioSupport: { supported: true, codec: "mp4a.40.2", reason: null },
      })}
      onRender={vi.fn()}
    />,
  );

  expect(screen.getByText("600 frames · 10.00 s · video + mono AAC")).toBeTruthy();
  expect(screen.getByText("AAC ready (mp4a.40.2 · mono · 48 kHz)")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Render MP4" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows exact progress and exposes cancellation while a render runs", () => {
  const cancel = vi.fn();
  render(
    <RenderVideoDialog
      open
      onOpenChange={vi.fn()}
      settings={SETTINGS}
      session={session({
        rendering: true,
        progress: { stage: "frames", completedFrames: 150, totalFrames: 600, frameIndex: 149 },
        cancel,
      })}
      onRender={vi.fn()}
    />,
  );

  const progress = screen.getByRole("progressbar", { name: "Video render progress" });
  expect(progress.getAttribute("aria-valuenow")).toBe("25");
  expect(screen.getByText("150 / 600 frames (25%)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel render" }));
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([
  [
    { stage: "preroll", completedFrames: 0, totalFrames: 600, frameIndex: null, completedPreRollFrames: 300, totalPreRollFrames: 600 },
    "Preparing timeline · 300 / 600 frames (50%)",
    "50",
  ],
  [
    { stage: "audio", completedFrames: 600, totalFrames: 600, frameIndex: 599, completedAudioFrames: 24_000, totalAudioFrames: 48_000 },
    "Encoding audio · 24000 / 48000 samples (50%)",
    "50",
  ],
  [
    { stage: "finalizing", completedFrames: 600, totalFrames: 600, frameIndex: 599 },
    "Finalizing MP4…",
    null,
  ],
  [
    { stage: "saving", completedFrames: 600, totalFrames: 600, frameIndex: 599 },
    "Saving MP4…",
    null,
  ],
] as const)("shows post-capture progress for %s", (progress, label, valueNow) => {
  render(
    <RenderVideoDialog
      open
      onOpenChange={vi.fn()}
      settings={SETTINGS}
      session={session({ rendering: true, progress })}
      onRender={vi.fn()}
    />,
  );
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText("Temporary storage · 0.0 MB")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Video render progress" }).getAttribute("aria-valuenow")).toBe(valueNow);
  cleanup();
});

it("blocks render when H.264 preflight refuses the selected size and rate", () => {
  render(
    <RenderVideoDialog
      open
      onOpenChange={vi.fn()}
      settings={SETTINGS}
      session={session({
        encoderSupport: {
          supported: false,
          codec: "avc1.640034",
          reason: "No H.264 encoder supports 3840x2160 at 60 fps.",
        },
      })}
      onRender={vi.fn()}
    />,
  );

  expect(screen.getByText(/H.264 unavailable/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Render MP4" }) as HTMLButtonElement).disabled).toBe(true);
});

it("blocks a soundtrack source that cannot be reproduced offline", () => {
  render(
    <RenderVideoDialog
      open
      onOpenChange={vi.fn()}
      settings={SETTINGS}
      session={session({
        audioRequirement: { kind: "invalid", reason: "Audio File In must be Locked to Timeline." },
      })}
      onRender={vi.fn()}
    />,
  );

  expect(screen.getByText(/Audio unavailable: Audio File In must be Locked to Timeline/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Render MP4" }) as HTMLButtonElement).disabled).toBe(true);
});


it("shows the take-local dimensions, rate and range", () => {
  const setRenderSettings=vi.fn();
  render(<RenderVideoDialog open onOpenChange={vi.fn()} settings={{...SETTINGS,outputResolution:{width:1080,height:1920},fps:24,frameRange:{start:48,end:95}}} session={session({frames:48,renderSettings:{resolution:{width:1080,height:1920},outputFps:24,range:{start:48,end:95}},setRenderSettings})} onRender={vi.fn()} />);
  expect(screen.getByLabelText("render width").getAttribute("aria-valuenow")).toBe("1080");
  expect(screen.getByLabelText("render height").getAttribute("aria-valuenow")).toBe("1920");
  expect(screen.getByLabelText("render fps").getAttribute("aria-valuenow")).toBe("24");
  expect(screen.getByText("48 frames · 2.00 s · video only")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"4K UHD"}));
  expect(setRenderSettings).toHaveBeenLastCalledWith({resolution:{width:2160,height:3840}});
});

it("allows video only when an excluded soundtrack is invalid and exposes the audio toggle",()=>{
  const setIncludeAudio=vi.fn();
  render(<RenderVideoDialog open onOpenChange={vi.fn()} settings={SETTINGS} session={session({includeAudio:false,setIncludeAudio,audioRequirement:{kind:"invalid",reason:"Microphone input cannot be replayed."}})} onRender={vi.fn()} />);
  expect(screen.getByText("600 frames · 10.00 s · video only")).toBeTruthy();
  expect((screen.getByRole("button",{name:"Render MP4"}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("switch",{name:"Include audio"}));
  expect(setIncludeAudio).toHaveBeenCalledWith(true);
});
