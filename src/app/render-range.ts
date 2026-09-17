import type { LoomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { frameRangeLength, type FrameRange } from "@domain/types/graph.ts";
import type { ExportInterface, OutputRef } from "@runtime/export/index.ts";
import { createFrameRecorder } from "@runtime/export/index.ts";
import type { RecordingReport, VideoEncoderSink } from "@runtime/export/index.ts";
import type { TransportHandlers } from "./transport-commands.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * RENDERING THE TIMELINE OUT (T433, §V48, §V170).
 *
 * The other half of the timeline. An in/out range that can only be scrubbed is a
 * viewport onto the clock; the range earns its keep when you can hand it to something
 * and get a file back, and "render our timeline out" was half of what was asked for.
 *
 * ## Deterministic, and that is the whole design
 *
 * This is NOT a screen recording. Nothing here reads a clock, waits for a frame or
 * samples what the display happened to show. The transport is seeked to the in point —
 * which REPLAYS and clears temporal state (§V170), so a feedback graph starts the take
 * from the state that genuinely belongs to that frame — and then stepped one frame at a
 * time, synchronously. Output cadence selects source frames and gives the recorder
 * consecutive output indices; progress retains the sampled project-frame index (§V44). The same project, seed and range
 * produce the same file, on a fast machine and on a slow one.
 *
 * That is why the loop below does not use `recordSequence`, which is the same shape one
 * call shorter: it steps and THEN captures, so the frame the seek just rendered — the in
 * point itself — would never be offered, and the take would silently be `start+1..end+1`.
 * A range that renders the wrong frames while reporting the right count is exactly the
 * failure `RecordingReport` exists to make impossible.
 *
 * ## What it refuses, by name (§V288)
 *
 * A graph with no declared Output, a session with no transport, and a browser with no
 * `VideoEncoder` are three different reasons nothing can be rendered, and each says which
 * it is. Silence here would look like a broken button.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Renders the timeline's in/out range to a video file.
     *
     * The app session owns take-local range/rate overrides initialized from the project.
     * They are deliberately not command inputs, so every command caller renders the same
     * reviewed job without editing the composition's persisted clock.
     */
    "export.renderRange": {
      input: Record<string, never>;
      output: { rendered: boolean; frames: number; fileName: string | null };
    };
  }
}

/** What a take produced, or why there was none. */
export type RenderRangeOutcome =
  | { readonly kind: "rendered"; readonly frames: number; readonly fileName: string | null }
  | { readonly kind: "refused"; readonly diagnostic: RuntimeDiagnostic };

export interface RenderRangeHandlers {
  /** True while a take is in flight, so a second press reports rather than interleaving. */
  busy(): boolean;
  render(): Promise<RenderRangeOutcome>;
  /** Stops the active take at the next safe frame boundary. No-op while idle. */
  cancel?(): void;
}

/** Monotonic exact-frame progress. `completedFrames` advances only after encode accepts a frame. */
export interface RenderRangeProgress {
  readonly completedFrames: number;
  readonly totalFrames: number;
  readonly frameIndex: number | null;
}

export function renderedFrameCount(range: FrameRange): number {
  return frameRangeLength(range);
}

/** Project frames whose state is needed to cover every selected output-frame interval. */
export function sourceRangeForOutputRange(
  range: FrameRange,
  timelineFps: number,
  outputFps: number,
): FrameRange {
  return {
    start: Math.floor((range.start * timelineFps) / outputFps),
    end: Math.ceil(((range.end + 1) * timelineFps) / outputFps) - 1,
  };
}

export interface RenderRangeHolder {
  current: RenderRangeHandlers | null;
}

export function renderRangeHolderFor(bus: LoomBus): RenderRangeHolder {
  return commandHolder<RenderRangeHandlers>(bus, "export.renderRange");
}

/**
 * What a take needs from the transport — a NARROWER view than `TransportHandlers`.
 *
 * `latestFrame` is here and not on `TransportHandlers` because it belongs to the frame
 * LOOP rather than to the transport verbs: `useFrameLoop` already publishes it (§V16, a
 * ref read rather than a subscription) and a second copy on the holder would be a second
 * answer to "what was the last frame rendered".
 */
export interface RangeTransport {
  isPlaying(): boolean;
  togglePlay(): void;
  seek(frameIndex: number): number;
  stepOnce(): ReturnType<TransportHandlers["stepOnce"]>;
  latestFrame(): ReturnType<TransportHandlers["stepOnce"]>;
  /** T467: a take is a fresh performance — the absolute clock starts at zero. */
  resetAbsoluteClock(): void;
}

export interface RenderFrameRangeInputs {
  /** The sole readback surface (§V48). */
  readonly api: ExportInterface;
  readonly ref: OutputRef;
  readonly range: FrameRange;
  /** Frame rate of the project timeline being evaluated. */
  readonly timelineFps: number;
  /** Frame rate written to the output file. */
  readonly outputFps: number;
  readonly transport: RangeTransport;
  readonly encoder: VideoEncoderSink;
  readonly onDiagnostic?: ((diagnostic: RuntimeDiagnostic) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: RenderRangeProgress) => void) | undefined;
  /** Reports deterministic replay before a non-zero in point. */
  readonly onPreRollProgress?: ((completedFrames: number, totalFrames: number) => void) | undefined;
  /** Gives the app a paint/cancel turn during long deterministic replay. */
  readonly yieldControl?: (() => Promise<void>) | undefined;
  /**
   * T747: awaited after each frame is rendered, before anything steps past it.
   *
   * This is where an ASYNC NODE stops being wall-clock dependent. `depth` and `pose`
   * publish "the latest completed result", which live is correct (§V144: stale beats
   * stalled) and in a TAKE is a silently wrong file: two renders of one project pick up
   * whatever happened to have landed, and differ. Nothing in the file says so.
   *
   * With this hook the export awaits the inference belonging to the frame just rendered,
   * so the lag becomes EXACTLY ONE FRAME on every machine and every run instead of
   * "however many frames the model was behind". See `renderFrameRange` below for why one
   * rather than zero — it is a property of the pipeline, not a shortcut.
   */
  readonly onFrameRendered?: ((frameIndex: number) => Promise<void>) | undefined;
}

const PRE_ROLL_YIELD_INTERVAL = 8;

export class RenderRangeCancelledError extends Error {
  constructor() {
    super("The video render was cancelled.");
    this.name = "RenderRangeCancelledError";
  }
}

export interface RenderedRange {
  readonly mimeType: string;
  readonly bytes: Uint8Array | Blob;
  readonly report: RecordingReport;
  readonly dispose?: (() => Promise<void>) | undefined;
}

/**
 * Steps the range and encodes it. No DOM, no clock, no file — those belong to the caller.
 *
 * Split out from the command so the part that decides WHICH FRAME IS WHICH can be tested
 * against a fake transport and a fake encoder, with no GPU and no browser. That is the
 * part §V220 keeps catching: the orchestration is where an off-by-one lives, and it is
 * unreachable from a test that has to stand up a device first.
 */
export async function renderFrameRange(inputs: RenderFrameRangeInputs): Promise<RenderedRange> {
  const { api, ref, range, timelineFps, outputFps, transport, encoder } = inputs;
  const recorder = createFrameRecorder({
    api,
    ref,
    encoder,
    fps: outputFps,
    ...(inputs.onDiagnostic === undefined ? {} : { onDiagnostic: inputs.onDiagnostic }),
  });

  const totalFrames = renderedFrameCount(range);
  const sourceRange = sourceRangeForOutputRange(range, timelineFps, outputFps);
  const cancelled = (): boolean => inputs.signal?.aborted === true;
  const stopIfCancelled = (): void => {
    if (!cancelled()) return;
    throw new RenderRangeCancelledError();
  };

  const wasPlaying = transport.isPlaying();
  let completed = false;
  try {
    stopIfCancelled();
    // Pausing first is not politeness: a running loop would keep advancing the timeline
    // between our steps, so the take would carry frames nobody asked for and the recorder
    // would report duplicates it did not cause.
    if (wasPlaying) transport.togglePlay();

    await recorder.start();
    stopIfCancelled();
    inputs.onProgress?.({ completedFrames: 0, totalFrames, frameIndex: null });
    /*
     * T467 — A TAKE IS A FRESH PERFORMANCE. `absFrameIndex` counts from transport
     * creation, so without this a project rendered on two different days would carry a
     * different abstime into every frame — and different PIXELS wherever an expression or
     * shader reads it, breaking "the same project renders the same file" (T431). Zeroed
     * before the seek so the replayed frames 0..start carry abs 0..start, deterministic.
     * The LIVE clock is untouched: only a render resets it (T461's rule kept whole).
     */
    transport.resetAbsoluteClock();
    // §V170 — build the in point's true temporal state from frame zero. `seek(start)` did
    // the same replay in one synchronous loop, which froze the page and made later ranges
    // look hung. Reset through the canonical seek, then expose each required replay step
    // to cancellation and the browser scheduler without skipping any temporal work.
    transport.seek(0);
    let frame = transport.latestFrame();
    let sourceFrameIndex = 0;
    let completedFrames = 0;
    let settledSourceFrame: number | null = null;
    if (frame !== null) {
      await inputs.onFrameRendered?.(0);
      settledSourceFrame = 0;
    }
    while (frame !== null && sourceFrameIndex < sourceRange.start) {
      stopIfCancelled();
      frame = transport.stepOnce();
      sourceFrameIndex += 1;
      if (frame === null) break;
      if (frame.frame.frameIndex !== sourceFrameIndex) {
        const diagnostic: RuntimeDiagnostic = {
          severity: "error",
          code: "export.recordingSourceFrameMismatch",
          message: `Timeline step expected frame ${String(sourceFrameIndex)} but rendered ${String(frame.frame.frameIndex)}.`,
        };
        inputs.onDiagnostic?.(diagnostic);
        throw new Error(diagnostic.message);
      }
      await inputs.onFrameRendered?.(sourceFrameIndex);
      settledSourceFrame = sourceFrameIndex;
      inputs.onPreRollProgress?.(sourceFrameIndex, sourceRange.start);
      if (sourceFrameIndex % PRE_ROLL_YIELD_INTERVAL === 0 || sourceFrameIndex === sourceRange.start) {
        await inputs.yieldControl?.();
      }
      stopIfCancelled();
    }
    for (let outputOffset = 0; outputOffset < totalFrames; outputOffset += 1) {
      stopIfCancelled();
      if (frame === null) break;
      const outputFrameIndex = range.start + outputOffset;
      const targetSourceFrame = Math.min(
        sourceRange.end,
        Math.floor((outputFrameIndex * timelineFps) / outputFps),
      );
      while (sourceFrameIndex < targetSourceFrame) {
        frame = transport.stepOnce();
        sourceFrameIndex += 1;
        if (frame === null) break;
        if (frame.frame.frameIndex !== sourceFrameIndex) {
          const diagnostic: RuntimeDiagnostic = {
            severity: "error",
            code: "export.recordingSourceFrameMismatch",
            message: `Timeline step expected frame ${String(sourceFrameIndex)} but rendered ${String(frame.frame.frameIndex)}.`,
          };
          inputs.onDiagnostic?.(diagnostic);
          throw new Error(diagnostic.message);
        }
        await inputs.onFrameRendered?.(sourceFrameIndex);
        settledSourceFrame = sourceFrameIndex;
        stopIfCancelled();
      }
      if (frame === null) break;
      /*
       * T747 — SETTLE THE FRAME THAT WAS JUST RENDERED, BEFORE STEPPING PAST IT.
       *
       * The render fills an inference node's model-input buffer; this awaits the model
       * reading it. The result is uploaded by the NEXT render, so a take shows frame N's
       * inference at frame N+1 — a lag of exactly one frame, fixed, on every machine.
       *
       * ONE rather than ZERO, and it is not a compromise that could be tightened later.
       * Zero would need the frame re-rendered after the result exists, and a second render
       * of the same frame ADVANCES EVERY TEMPORAL NODE A SECOND TIME — feedback, caches,
       * simulations. E2, E12 and every reaction-diffusion document would render a take at
       * double their true rate. A deterministic one-frame lag is correct; a corrupted
       * simulation is not, and the difference is invisible in the file.
       *
       * The value of this is not the lag, it is that the lag is now a CONSTANT. Before it
       * was however far behind the model happened to be — wall-clock dependent, different
       * on every run and every machine, and nothing in the take said so.
       */
      if (settledSourceFrame !== sourceFrameIndex) {
        await inputs.onFrameRendered?.(sourceFrameIndex);
        settledSourceFrame = sourceFrameIndex;
      }
      stopIfCancelled();
      await recorder.captureFrame({ ...frame.frame, frameIndex: outputFrameIndex });
      stopIfCancelled();
      completedFrames += 1;
      inputs.onProgress?.({ completedFrames, totalFrames, frameIndex: outputFrameIndex });
    }
    // Audio capture records transport/volume at project-frame boundaries. A lower output
    // rate may not photograph the tail project frames, but the soundtrack still spans the
    // full selected timeline range and must observe them before its lazy PCM source opens.
    while (frame !== null && sourceFrameIndex < sourceRange.end) {
      frame = transport.stepOnce();
      sourceFrameIndex += 1;
      if (frame !== null) {
        if (frame.frame.frameIndex !== sourceFrameIndex) {
          const diagnostic: RuntimeDiagnostic = {
            severity: "error",
            code: "export.recordingSourceFrameMismatch",
            message: `Timeline step expected frame ${String(sourceFrameIndex)} but rendered ${String(frame.frame.frameIndex)}.`,
          };
          inputs.onDiagnostic?.(diagnostic);
          throw new Error(diagnostic.message);
        }
        await inputs.onFrameRendered?.(sourceFrameIndex);
      }
      stopIfCancelled();
    }
    stopIfCancelled();
    const result = await recorder.finish();
    stopIfCancelled();
    completed = true;
    return {
      mimeType: result.video.mimeType,
      bytes: result.video.bytes,
      report: result.report,
      ...(result.video.dispose === undefined ? {} : { dispose: result.video.dispose }),
    };
  } catch (error) {
    // Also closes an encoder-owned disk spool. A failed mux/write must not leave an OPFS
    // payload behind merely because cancellation was not the cause.
    try {
      await recorder.cancel();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The video render failed and its temporary storage could not be fully removed.",
        { cause: cleanupError },
      );
    }
    if (cancelled() && !(error instanceof RenderRangeCancelledError)) {
      throw new RenderRangeCancelledError();
    }
    throw error;
  } finally {
    // A seek replays every frame from zero. Rewinding here can queue thousands of
    // expensive frames after Cancel and lock the page again. Keep the valid current
    // simulation state; cancelled/failed takes stay paused at the last computed frame.
    if (completed && wasPlaying && !transport.isPlaying()) transport.togglePlay();
  }
}

const NO_SESSION: RuntimeDiagnostic = {
  severity: "warning",
  code: "export.noSession",
  message: "No running session is holding a renderer, so there is nothing to render out.",
  suggestion: "The render path is created with the GPU device — a build with no WebGPU has none.",
};

/** Idempotent: the bus has no unregister, and React mounts more than once. */
export function registerRenderRangeCommand(bus: LoomBus): RenderRangeHolder {
  const holder = renderRangeHolderFor(bus);
  if (bus.hasCommand("export.renderRange")) return holder;

  bus.registerCommand({
    name: "export.renderRange",
    description: "Render the timeline's in/out range to a video file.",
    handler: async (_input, context) => {
      const revision = context.store.getRevision();
      const handlers = holder.current;
      if (handlers === null) {
        return {
          status: "rejected",
          revision,
          diagnostics: [NO_SESSION],
          output: { rendered: false, frames: 0, fileName: null },
        };
      }
      if (handlers.busy()) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "export.renderInFlight",
              message: "A render is already running; it steps the same transport this one would.",
            },
          ],
          output: { rendered: false, frames: 0, fileName: null },
        };
      }
      if (context.dryRun) {
        return { status: "validated", revision, output: { rendered: false, frames: 0, fileName: null } };
      }

      const outcome = await handlers.render();
      if (outcome.kind === "refused") {
        return {
          status: "rejected",
          revision,
          diagnostics: [outcome.diagnostic],
          output: { rendered: false, frames: 0, fileName: null },
        };
      }
      // A cancelled save picker is not a failure — the same rule the project save and the
      // audio track follow. The frames were rendered either way, and the count says so.
      return {
        status: "applied",
        revision,
        output: {
          rendered: outcome.fileName !== null,
          frames: outcome.frames,
          fileName: outcome.fileName,
        },
      };
    },
    rejectionOutput: () => ({ rendered: false, frames: 0, fileName: null }),
  });

  return holder;
}
