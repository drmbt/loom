import { rateOf, type FrameRate } from "../../../domain/time/ticks.ts";
import { formatTimecode, frameToTimecode, parseTimecodeEntry, supportsDropFrame } from "../../../domain/time/timecode.ts";
import { sampleDurationFor, timescaleFor } from "./mp4-muxer.ts";
import type { Mp4TimecodeTrack } from "./mp4-muxer.ts";

/**
 * VN104 — the start timecode a render writes into its file.
 *
 * A render's file is labelled from its first frame: the project's start timecode plus the in
 * point's offset, counted at the OUTPUT rate (the rate the file's frames are counted in).
 * Labels are parsed and produced by `src/domain/time/timecode.ts`, the one SMPTE
 * implementation, so drop-frame at 29.97 / 59.94 is the same arithmetic the timeline uses.
 */

/** A start timecode resolved against an output rate. */
export interface ExportStartTimecode {
  /** Frames since 00:00:00:00 at `fps` — what the `tmcd` sample stores. */
  readonly frame: number;
  readonly dropFrame: boolean;
  /** Canonical label, `01:00:00;02` drop-frame or `01:00:00:00` non-drop. */
  readonly label: string;
  readonly fps: number;
}

/**
 * THE SEAM FOR VN72. The project has no start timecode yet, so a project starts at frame 0
 * (00:00:00:00). When VN72 adds one, its frame count at the output rate is the one argument
 * that changes here; nothing else in the export path names a project start.
 */
export function projectStartTimecodeFrame(): number {
  return 0;
}

/**
 * The default start label for a take: the project start plus the in point, in output frames.
 * Drop-frame by default where the rate has it (29.97, 59.94), as NTSC deliverables are.
 */
export function defaultStartTimecode(inPointFrame: number, outputFps: number, projectStartFrame = projectStartTimecodeFrame()): string {
  const rate = rateOf(outputFps);
  const frame = Math.max(0, Math.round(projectStartFrame + inPointFrame));
  return formatTimecode(frameToTimecode(frame, rate, supportsDropFrame(rate)));
}

/**
 * Parses typed entry (`01:00:00:00`, `01:00:00;02`, `1.12`) at the output rate. A `;` asks
 * for drop-frame; a rate without drop-frame refuses it by name.
 */
export function parseStartTimecode(text: string, outputFps: number): ExportStartTimecode | { readonly error: string } {
  const rate = rateOf(outputFps);
  const dropFrame = text.includes(";");
  if (dropFrame && !supportsDropFrame(rate)) {
    return { error: `${outputFps} fps has no drop-frame timecode; separate the frames with ":".` };
  }
  const parsed = parseTimecodeEntry(text, rate, dropFrame);
  if ("error" in parsed) return parsed;
  if (parsed.frame > 0xffff_ffff) return { error: `${text} is past the largest frame count a timecode track can hold.` };
  return {
    frame: parsed.frame,
    dropFrame,
    label: formatTimecode(frameToTimecode(parsed.frame, rate, dropFrame)),
    fps: outputFps,
  };
}

/** The muxer's `tmcd` track for a resolved start, in the video track's own timescale. */
export function timecodeTrackFor(start: Pick<ExportStartTimecode, "frame" | "dropFrame">, fps: number): Mp4TimecodeTrack {
  const rate: FrameRate = rateOf(fps);
  return {
    startFrame: start.frame,
    dropFrame: start.dropFrame,
    framesPerSecond: Math.round(rate.num / rate.den),
    timescale: timescaleFor(fps),
    frameDuration: sampleDurationFor(fps),
  };
}
