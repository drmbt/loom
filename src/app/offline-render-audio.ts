import type { MediaTransportValues } from "@domain/media/transport.ts";
import { mediaPlayhead } from "@domain/media/transport.ts";
import { frameRangeLength } from "@domain/types/graph.ts";
import type { FrameRange } from "@domain/types/graph.ts";
import type { AudioPcmSource } from "@runtime/export/index.ts";
import { sourceRangeForOutputRange } from "./render-range.ts";
import type { MonoPcm } from "./audio-pre-analysis.ts";

export interface OfflineAudioFrameState {
  readonly frameIndex: number;
  readonly timelineSeconds: number;
  readonly transport: MediaTransportValues;
  readonly volume: number;
}

export interface OfflineAudioCapture {
  note(state: OfflineAudioFrameState): void;
  source(): AudioPcmSource;
}

/**
 * Captures the exact transport values used while frames are stepped, then samples the
 * decoded file on that same piecewise frame grid. This keeps driven trim/speed/volume
 * deterministic without asking a live media element or wall clock where the sound was.
 */
export function createOfflineAudioCapture(
  source: MonoPcm,
  sourceDuration: number,
  range: FrameRange,
  timelineFps: number,
  outputFps: number = timelineFps,
): OfflineAudioCapture {
  const states = new Map<number, OfflineAudioFrameState>();
  const sourceRange = sourceRangeForOutputRange(range, timelineFps, outputFps);

  return {
    note(state) {
      if (state.frameIndex < sourceRange.start || state.frameIndex > sourceRange.end) return;
      states.set(state.frameIndex, state);
    },
    source() {
      for (let frame = sourceRange.start; frame <= sourceRange.end; frame += 1) {
        if (!states.has(frame)) {
          throw new Error(`Audio export did not observe timeline frame ${String(frame)}.`);
        }
      }

      const videoFrames = frameRangeLength(range);
      const outputFrames = Math.round((videoFrames * source.sampleRate) / outputFps);
      return {
        sampleRate: source.sampleRate,
        channelCount: 1,
        totalFrames: outputFrames,
        readFrames(offset, count) {
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) ||
            offset < 0 || count < 0 || offset + count > outputFrames) {
            throw new RangeError("Audio export requested a PCM batch outside the selected range.");
          }
          const samples = new Float32Array(count);
          for (let index = 0; index < count; index += 1) {
            const timelineSeconds = range.start / outputFps + (offset + index) / source.sampleRate;
            const sourceFrame = Math.min(sourceRange.end, Math.floor(timelineSeconds * timelineFps));
            const state = states.get(sourceFrame) as OfflineAudioFrameState;
            const withinFrame = timelineSeconds - sourceFrame / timelineFps;
            const head = mediaPlayhead(
              state.transport,
              state.timelineSeconds + withinFrame,
              sourceDuration,
            );
            if (!head.visible) continue;
            const value = sampleLinear(source.samples, head.position * source.sampleRate);
            samples[index] = clampAudio(value * state.volume);
          }
          return samples;
        },
      };
    },
  };
}

function sampleLinear(samples: Float32Array, position: number): number {
  if (samples.length === 0 || position < 0) return 0;
  const low = Math.min(samples.length - 1, Math.floor(position));
  const high = Math.min(samples.length - 1, low + 1);
  const mix = Math.max(0, Math.min(1, position - low));
  return (samples[low] as number) * (1 - mix) + (samples[high] as number) * mix;
}

function clampAudio(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}
