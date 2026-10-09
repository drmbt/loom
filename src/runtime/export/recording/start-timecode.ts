import { rateOf, type FrameRate } from "../../../domain/time/ticks.ts";
import { formatTimecode, frameToTimecode, parseTimecodeEntry, supportsDropFrame } from "../../../domain/time/timecode.ts";
import { sampleDurationFor, timescaleFor } from "./mp4-muxer.ts";
import type { Mp4TimecodeTrack } from "./mp4-muxer.ts";

/**
 * VN104 — the start timecode a render writes into its file.
 *
 * A render's file is labelled from its first frame (`resolveStartTimecode` decides from
 * what), counted at the OUTPUT rate (the rate the file's frames are counted in).
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
 * The default start label for a take: 00:00:00:00 plus the in point, in output frames.
 * Drop-frame by default where the rate has it (29.97, 59.94), as NTSC deliverables are.
 */
export function defaultStartTimecode(inPointFrame: number, outputFps: number): string {
  const rate = rateOf(outputFps);
  return formatTimecode(frameToTimecode(Math.max(0, Math.round(inPointFrame)), rate, supportsDropFrame(rate)));
}

/**
 * TODO(VN72): the project's start timecode lives on the timeline's REFERENCE node (a start-TC
 * parameter on its movie / audio-file reference; Vincent's ruling, 2026-10-08). Until VN72
 * adds that parameter there is nothing to read, so this answers `undefined`. When it lands,
 * give it the graph, the in point and the output rate, and return the reference's start
 * label plus the in point's offset, as text at the output rate.
 */
export function referenceStartTimecode(): string | undefined {
  return undefined;
}

/**
 * THE ONE SEAM for a take's start timecode, in priority order:
 *   1. the render dialog's "Start timecode" field, when the user typed one;
 *   2. the timeline reference node's start timecode (VN72, `referenceStartTimecode`);
 *   3. 00:00:00:00 plus the in point's offset (`defaultStartTimecode`).
 * Returns the resolved start, or the parse error of whichever text it came from.
 */
export function resolveStartTimecode(
  dialogText: string | undefined,
  inPointFrame: number,
  outputFps: number,
): ExportStartTimecode | { readonly error: string } {
  const typed = dialogText?.trim();
  const text = typed !== undefined && typed !== ""
    ? typed
    : referenceStartTimecode() ?? defaultStartTimecode(inPointFrame, outputFps);
  return parseStartTimecode(text, outputFps);
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
