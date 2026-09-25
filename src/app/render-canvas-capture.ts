import type { LoomBackend } from "@runtime/backend/index.ts";
import type { ExportOutput } from "@runtime/export/index.ts";
import type { CapturedVideoFrame, EncoderFrameTiming } from "@runtime/export/recording/types.ts";

/** Browser adapter: owns the surface; the encoder owns and closes each returned frame. */
export interface RenderCanvasCapture {
  captureFrame(timing: EncoderFrameTiming): CapturedVideoFrame;
  dispose(): void;
}

export function createRenderCanvasCapture(backend: LoomBackend, output: ExportOutput): RenderCanvasCapture {
  if (output.width % 2 !== 0 || output.height % 2 !== 0) {
    throw new Error("H.264 video export requires an even width and height.");
  }
  if (typeof OffscreenCanvas !== "function" || typeof VideoFrame !== "function") {
    throw new Error("Video export requires OffscreenCanvas and WebCodecs frame capture.");
  }
  // Presentation is a raw blit (§V70a). The declared picture sink supplies its display
  // transform; applying another here would double-encode the image.
  if (output.space !== "encoded" && output.format !== "rgba8unorm-srgb") {
    throw new Error("Video canvas capture requires a display-encoded Output.");
  }
  const canvas = new OffscreenCanvas(output.width, output.height);
  const generation = backend.status.deviceGeneration;
  const presentation = backend.present(canvas, { outputId: output.resourceId, label: "video-export" });
  let disposed = false;
  return {
    captureFrame(timing) {
      const status = backend.status;
      if (disposed) throw new Error("Video capture surface is closed.");
      if (status.disposed || status.halted || status.deviceGeneration !== generation) {
        throw new Error("The GPU device changed during video export. Start a new render.");
      }
      const report = presentation.describe?.();
      if (status.stale || report === undefined || !report.surfaceConfigured || !report.sourceBound || report.presentedFrames === 0) {
        throw new Error("The video export surface has no valid rendered Output.");
      }
      if (canvas.width !== output.width || canvas.height !== output.height) {
        throw new Error("The video export surface changed resolution during the take.");
      }
      return new VideoFrame(canvas, {
        timestamp: timing.timestampMicros,
        duration: timing.durationMicros,
        alpha: "discard",
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      presentation.dispose();
    },
  };
}
