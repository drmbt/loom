import type { MediaTransportValues } from "@domain/media/transport.ts";
import { mediaPlayhead } from "@domain/media/transport.ts";
import { frameRangeLength } from "@domain/types/graph.ts";
import type { FrameRange } from "@domain/types/graph.ts";
import type { AudioPcmSource } from "@runtime/export/index.ts";
import { sourceRangeForOutputRange } from "./render-range.ts";

export interface OfflineAudioFrameState {
  readonly frameIndex: number;
  readonly timelineSeconds: number;
  readonly transport: MediaTransportValues;
  readonly volume: number;
}

/** What the per-frame sync writes into: one source's transport, volume and time, each frame. */
export interface OfflineAudioCapture {
  note(state: OfflineAudioFrameState): void;
}

/**
 * VN104 — one source in a stereo mix: decoded PCM, one Float32Array per channel (one for
 * mono, two for stereo), at its own sample rate. Each source has its own transport and
 * volume, noted per frame under its own id.
 */
export interface OfflineMixSource {
  readonly id: string;
  readonly channels: ReadonlyArray<Float32Array>;
  readonly sampleRate: number;
}

export interface OfflineAudioMix {
  note(sourceId: string, state: OfflineAudioFrameState): void;
  /** Interleaved stereo (L R L R …) at `sampleRate`. */
  source(): AudioPcmSource;
}

/**
 * Captures the exact transport values used while frames are stepped, then samples each
 * decoded file on that same piecewise frame grid. This keeps driven trim/speed/volume
 * deterministic without asking a live media element or wall clock where the sound was.
 *
 * VN104 — the soundtrack is a STEREO MIX of every timeline-locked source that plays in the
 * range. The arithmetic per source is `createOfflineAudioCapture`'s (the same piecewise frame
 * grid, the same `mediaPlayhead`, the same linear read); sources are then summed at their
 * own volume and clamped once. A mono source feeds both channels at unity; a stereo source
 * feeds L to L and R to R. Each source is read at ITS position × ITS rate, so sources at
 * different sample rates mix without a resampling pass. Pure: the same notes give the same
 * samples, so the same range gives the same bytes.
 */
export function createOfflineAudioMix(
  sources: ReadonlyArray<OfflineMixSource>,
  range: FrameRange,
  timelineFps: number,
  outputFps: number = timelineFps,
  sampleRate = 48_000,
): OfflineAudioMix {
  const sourceRange = sourceRangeForOutputRange(range, timelineFps, outputFps);
  const states = new Map<string, Map<number, OfflineAudioFrameState>>();
  for (const source of sources) {
    if (source.channels.length !== 1 && source.channels.length !== 2) {
      throw new RangeError(`Audio source ${source.id} has ${String(source.channels.length)} channels; a mix takes mono or stereo.`);
    }
    if (states.has(source.id)) throw new RangeError(`Audio source ${source.id} is in the mix twice.`);
    states.set(source.id, new Map());
  }

  return {
    note(sourceId, state) {
      if (state.frameIndex < sourceRange.start || state.frameIndex > sourceRange.end) return;
      const noted = states.get(sourceId);
      if (noted === undefined) throw new RangeError(`Audio source ${sourceId} is not in this mix.`);
      noted.set(state.frameIndex, state);
    },
    source() {
      for (const source of sources) {
        const noted = states.get(source.id) as Map<number, OfflineAudioFrameState>;
        for (let frame = sourceRange.start; frame <= sourceRange.end; frame += 1) {
          if (!noted.has(frame)) {
            throw new Error(`Audio export did not observe timeline frame ${String(frame)} for source ${source.id}.`);
          }
        }
      }
      const outputFrames = Math.round((frameRangeLength(range) * sampleRate) / outputFps);
      return {
        sampleRate,
        channelCount: 2,
        totalFrames: outputFrames,
        readFrames(offset, count) {
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) ||
            offset < 0 || count < 0 || offset + count > outputFrames) {
            throw new RangeError("Audio export requested a PCM batch outside the selected range.");
          }
          const mix = new Float32Array(count * 2);
          for (const source of sources) {
            const noted = states.get(source.id) as Map<number, OfflineAudioFrameState>;
            const left = source.channels[0] as Float32Array;
            const right = (source.channels[1] ?? left);
            const duration = left.length / source.sampleRate;
            for (let index = 0; index < count; index += 1) {
              const timelineSeconds = range.start / outputFps + (offset + index) / sampleRate;
              const sourceFrame = Math.min(sourceRange.end, Math.floor(timelineSeconds * timelineFps));
              const state = noted.get(sourceFrame) as OfflineAudioFrameState;
              const head = mediaPlayhead(state.transport, state.timelineSeconds + (timelineSeconds - sourceFrame / timelineFps), duration);
              if (!head.visible || state.volume === 0) continue;
              const position = head.position * source.sampleRate;
              mix[index * 2] = (mix[index * 2] as number) + sampleLinear(left, position) * state.volume;
              mix[index * 2 + 1] = (mix[index * 2 + 1] as number) + sampleLinear(right, position) * state.volume;
            }
          }
          for (let index = 0; index < mix.length; index += 1) mix[index] = clampAudio(mix[index] as number);
          return mix;
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
