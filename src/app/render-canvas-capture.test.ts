import { afterEach, expect, it, vi } from "vitest";
import type { LoomBackend, PresentationReport } from "@runtime/backend/index.ts";
import type { ExportOutput } from "@runtime/export/index.ts";
import { createRenderCanvasCapture } from "./render-canvas-capture.ts";

afterEach(() => vi.unstubAllGlobals());

const output: ExportOutput = {
  ref: { nodeId: "out", portId: "out" }, resourceId: "target:out:out",
  width: 2160, height: 3840, format: "rgba16float", space: "encoded",
};
const timing = { frameIndex: 7, timestampMicros: 233333, durationMicros: 33333, keyFrame: false };

function fixture() {
  const constructed = vi.fn();
  vi.stubGlobal("OffscreenCanvas", class {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
  });
  vi.stubGlobal("VideoFrame", class {
    constructor(canvas: unknown, init: unknown) { constructed(canvas, init); }
    close() {}
  });
  const status = { deviceGeneration: 1, disposed: false, halted: false, stale: false };
  const report: PresentationReport = {
    id: "export", outputId: output.resourceId, surfaceConfigured: true,
    sourceBound: true, blitReady: true, presentedFrames: 1, lastPresentTime: 0, deviceGeneration: 1,
  };
  let currentReport = report;
  const dispose = vi.fn();
  const present = vi.fn<LoomBackend["present"]>(() => ({ id: "export", outputId: output.resourceId, setOutput() {}, dispose, describe: () => currentReport }));
  const backend = { status, present } as unknown as LoomBackend;
  return { backend, status, present, dispose, constructed, setReport: (patch: Partial<PresentationReport>) => {
    currentReport = { ...currentReport, ...patch };
  } };
}

it("owns an exact-size offscreen surface and preserves timestamps without an extra render", () => {
  const f = fixture();
  const capture = createRenderCanvasCapture(f.backend, output);
  const canvas = f.present.mock.calls[0]?.[0];
  expect(canvas).toMatchObject({ width: 2160, height: 3840 });
  capture.captureFrame(timing);
  expect(f.constructed).toHaveBeenCalledWith(canvas, { timestamp: 233333, duration: 33333, alpha: "discard" });
  capture.dispose(); capture.dispose();
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(() => capture.captureFrame(timing)).toThrow("closed");
});

it.each(["halted", "disposed", "generation"] as const)("refuses %s instead of encoding an old frame", kind => {
  const f = fixture();
  const capture = createRenderCanvasCapture(f.backend, output);
  if (kind === "generation") f.status.deviceGeneration++;
  else f.status[kind] = true;
  expect(() => capture.captureFrame(timing)).toThrow("GPU device changed");
  expect(f.constructed).not.toHaveBeenCalled();
  capture.dispose();
});

it.each([{ presentedFrames: 0 }, { sourceBound: false }, { surfaceConfigured: false }])("refuses an unrendered or invalid presentation %o", patch => {
  const f = fixture();
  const capture = createRenderCanvasCapture(f.backend, output);
  f.setReport(patch);
  expect(() => capture.captureFrame(timing)).toThrow("no valid rendered Output");
  expect(f.constructed).not.toHaveBeenCalled();
  capture.dispose();
});

it("rejects unsupported capture and unencoded output explicitly", () => {
  const f = fixture();
  expect(() => createRenderCanvasCapture(f.backend, { ...output, space: "linear" })).toThrow("display-encoded");
  vi.stubGlobal("OffscreenCanvas", undefined);
  expect(() => createRenderCanvasCapture(f.backend, output)).toThrow("requires OffscreenCanvas");
  expect(f.present).not.toHaveBeenCalled();
});

it.each([[641, 480], [640, 481]])("rejects odd %i×%i before allocating a presentation", (width, height) => {
  const f = fixture();
  expect(() => createRenderCanvasCapture(f.backend, { ...output, width, height })).toThrow("even width and height");
  expect(f.present).not.toHaveBeenCalled();
});
