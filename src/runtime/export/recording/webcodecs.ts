import { ExportDiagnosticCode, ExportError, exportDiagnostic } from "../types.ts";
import { avcCodecString, mp4FileTypeBox, mp4StreamParts, sampleDurationFor, timescaleFor } from "./mp4-muxer.ts";
import type { Mp4AudioSample, Mp4AudioTrack, Mp4Sample } from "./mp4-muxer.ts";
import { createMediaSpool } from "./media-spool.ts";
import type { MediaSpool, MediaSpoolMode } from "./media-spool.ts";
import type { EncodedVideo, EncoderConfig, EncoderFinishProgress, EncoderFrame, VideoEncoderSink } from "./types.ts";

/**
 * The WebCodecs encoder — the ONLY browser-only module in `src/runtime/export/**` (T111).
 *
 * It is deliberately not re-exported from `../index.ts`. A headless build, a Node test or a
 * worker without WebCodecs imports the export interface, the PNG path and the recorder
 * without this file ever being resolved; a consumer that wants realtime recording imports it
 * explicitly, or reaches it through `loadWebCodecsEncoder()`, which resolves it dynamically so
 * even a bundler-level reference is optional.
 *
 * `VideoEncoder` and `VideoFrame` are read off `globalThis`, not off `window`: the runtime is
 * lint-banned from `window`/`document` (§V63 / T92) precisely so it can move into a worker,
 * and WebCodecs is available there. Nothing in this file touches the DOM.
 *
 * Chrome ≥128 is the baseline (§C decided), which guarantees WebCodecs — so the availability
 * check exists for headless and for worker contexts, not as a fallback ladder to
 * MediaRecorder. There is no MediaRecorder stopgap, by decision.
 */

export function isWebCodecsAvailable(): boolean {
  const scope = globalThis as { VideoEncoder?: unknown; VideoFrame?: unknown };
  return typeof scope.VideoEncoder === "function" && typeof scope.VideoFrame === "function";
}

export interface WebCodecsEncoderOptions {
  /** Default: H.264 baseline 4.2 through 1080p, High 5.2 above 1080p. */
  readonly codec?: string;
  readonly bitrate?: number;
  readonly latencyMode?: "quality" | "realtime";
  readonly audio?: import("./types.ts").AudioPcmProvider;
  readonly audioBitrate?: number;
  readonly spool?: MediaSpoolMode;
  readonly onFinishProgress?: ((progress: EncoderFinishProgress) => void) | undefined;
  readonly onSpoolProgress?: ((writtenBytes: number) => void) | undefined;
  readonly yieldControl?: (() => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
}

// Match encoder backpressure cadence: one browser turn per 32 AAC packets is about
// 0.68 seconds of 48 kHz audio and does not create extra codec segment boundaries.
const AUDIO_PROGRESS_PACKET_INTERVAL = 32;

function cancelled(): Error {
  const error = new Error("Video encoding was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled();
}

async function awaitWithCancellation<T>(start: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return start();
  throwIfCancelled(signal);
  const work = start();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function unavailable(detail: string): ExportError {
  return new ExportError(
    exportDiagnostic(
      "error",
      ExportDiagnosticCode.encoderUnavailable,
      `WebCodecs video encoding is unavailable: ${detail}`,
      {
        suggestion:
          "Recording requires WebCodecs (Chrome/Edge ≥128, the §C baseline). There is no " +
          "MediaRecorder fallback by decision — it cannot capture exact frames.",
      },
    ),
  );
}

export interface WebCodecsSupport {
  readonly supported: boolean;
  readonly codec: string;
  readonly reason: string | null;
}

export async function probeWebCodecsAudioEncoder(
  sampleRate = 48_000,
  channelCount = 1,
  bitrate = 192_000,
): Promise<WebCodecsSupport> {
  const codec = "mp4a.40.2";
  if (
    typeof AudioEncoder !== "function" ||
    typeof AudioData !== "function" ||
    typeof AudioDecoder !== "function"
  ) {
    return {
      supported: false,
      codec,
      reason: "AudioEncoder, AudioDecoder, and AudioData are required for synchronized AAC export.",
    };
  }
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec,
      sampleRate,
      numberOfChannels: channelCount,
      bitrate,
    });
    const decoderSupport = await AudioDecoder.isConfigSupported({
      codec,
      sampleRate,
      numberOfChannels: channelCount,
    });
    return {
      supported: support.supported === true && decoderSupport.supported === true,
      codec,
      reason: support.supported === true && decoderSupport.supported === true
        ? null
        : `No AAC-LC encoder/decoder pair supports ${String(sampleRate)} Hz audio.`,
    };
  } catch (error) {
    return { supported: false, codec, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * H.264 policy for Loom's two production size classes.
 *
 * Baseline level 4.2 covers the ordinary 1080p path. UHD needs a profile/level that can
 * describe 3840x2160 at 60 fps, so it uses High level 5.2. This is selected before probing;
 * an unavailable hardware/software encoder is reported, never replaced silently.
 */
export function h264CodecFor(config: EncoderConfig): string {
  return config.width > 1920 || config.height > 1080 ? "avc1.640034" : "avc1.42002a";
}

function encoderConfigFor(
  config: EncoderConfig,
  options: WebCodecsEncoderOptions,
): VideoEncoderConfig {
  return {
    codec: options.codec ?? h264CodecFor(config),
    width: config.width,
    height: config.height,
    framerate: config.fps,
    avc: { format: "avc" },
    latencyMode: options.latencyMode ?? "quality",
    bitrate: config.bitrate ?? options.bitrate ?? estimateBitrate(config),
  };
}

export async function probeWebCodecsEncoder(
  config: EncoderConfig,
  options: WebCodecsEncoderOptions = {},
): Promise<WebCodecsSupport> {
  const codec = options.codec ?? h264CodecFor(config);
  if (!isWebCodecsAvailable()) {
    return { supported: false, codec, reason: "VideoEncoder is not available in this browser." };
  }
  const storage = (globalThis as typeof globalThis & {
    navigator?: Navigator & { storage?: { getDirectory?: unknown } };
  }).navigator?.storage;
  if ((options.spool ?? "opfs") === "opfs" && typeof storage?.getDirectory !== "function") {
    return {
      supported: false,
      codec,
      reason: "Origin-private file storage (OPFS) is required for bounded video export.",
    };
  }
  try {
    const support = await VideoEncoder.isConfigSupported(encoderConfigFor(config, options));
    return {
      supported: support.supported === true,
      codec,
      reason: support.supported === true
        ? null
        : `No H.264 encoder supports ${config.width}x${config.height} at ${config.fps} fps.`,
    };
  } catch (error) {
    return {
      supported: false,
      codec,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createWebCodecsEncoder(options: WebCodecsEncoderOptions = {}): VideoEncoderSink {
  let encoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let audioDecoder: AudioDecoder | null = null;
  let wakeAudioQueue: (() => void) | null = null;
  let config: EncoderConfig | null = null;
  let description: Uint8Array | null = null;
  let failure: unknown = null;
  const samples: Mp4Sample[] = [];
  let sampleDuration = 0;
  let spool: MediaSpool | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let pendingWriteBytes = 0;
  let writtenMediaBytes = 0;
  let maxQueuedFrames = 1;

  const writePacket = (bytes: Uint8Array): void => {
    if (failure) return;
    const target = spool;
    if (target === null) {
      failure = new Error("Encoded media arrived before its disk spool was ready.");
      return;
    }
    pendingWriteBytes += bytes.length;
    writeChain = writeChain.then(() => target.write(bytes)).then(
      () => {
        pendingWriteBytes -= bytes.length;
        writtenMediaBytes += bytes.length;
        options.onSpoolProgress?.(writtenMediaBytes);
      },
      (cause: unknown) => {
        pendingWriteBytes -= bytes.length;
        failure = cause;
      },
    );
  };

  return {
    async configure(next) {
      if (!isWebCodecsAvailable()) throw unavailable("VideoEncoder is not defined in this context.");
      config = next;
      try {
        spool = await createMediaSpool(options.spool ?? "opfs", mp4FileTypeBox());
      } catch (error) {
        throw unavailable(error instanceof Error ? error.message : String(error));
      }
      sampleDuration = sampleDurationFor(next.fps);
      maxQueuedFrames = Math.max(1, Math.floor((64 * 1024 * 1024) / (next.width * next.height * 4)));
      const encoderConfig = encoderConfigFor(next, options);

      const support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (support.supported !== true) {
        throw unavailable(
          `no encoder for ${encoderConfig.codec} at ${next.width}x${next.height} and ${next.fps} fps.`,
        );
      }

      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const described = metadata?.decoderConfig?.description;
          if (described && description === null) description = toBytes(described);
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          samples.push({
            byteLength: bytes.length,
            keyFrame: chunk.type === "key",
            duration: sampleDuration,
          });
          writePacket(bytes);
        },
        error: (cause) => {
          failure = cause;
        },
      });
      encoder.configure(encoderConfig);
    },

    encode(frame: EncoderFrame) {
      if (!encoder) throw new Error("Encoder used before configure().");
      if (failure) throw failure;
      const video = new VideoFrame(frame.image.data, {
        format: "RGBA",
        codedWidth: frame.image.width,
        codedHeight: frame.image.height,
        timestamp: frame.timestampMicros,
        duration: frame.durationMicros,
      });
      try {
        encoder.encode(video, { keyFrame: frame.keyFrame });
      } finally {
        // A VideoFrame holds a GPU/media resource until closed. Leaking them stalls the
        // encoder within a few dozen frames.
        video.close();
      }
      // Backpressure: the recorder's in-flight limit governs readback, but the encoder has
      // its own queue, and letting it grow unbounded is how a long take runs out of memory.
      const waits: Promise<unknown>[] = [];
      if (encoder.encodeQueueSize >= maxQueuedFrames) waits.push(drain(encoder));
      if (pendingWriteBytes >= 16 * 1024 * 1024) waits.push(writeChain);
      return waits.length === 0 ? undefined : Promise.all(waits).then(() => undefined);
    },

    async finish(): Promise<EncodedVideo> {
      if (!encoder || !config) throw new Error("Encoder finished before configure().");
      throwIfCancelled(options.signal);
      options.onFinishProgress?.({ stage: "video" });
      await options.yieldControl?.();
      await awaitWithCancellation(() => encoder!.flush(), options.signal);
      await awaitWithCancellation(() => writeChain, options.signal);
      encoder.close();
      encoder = null;
      if (failure) throw failure;
      if (description === null) {
        throw unavailable("the encoder never reported an avcC decoder description.");
      }
      const audio = options.audio === undefined
        ? undefined
        : await encodeAudioTrack(await options.audio(), options.audioBitrate);
      if (failure) throw failure;
      throwIfCancelled(options.signal);
      options.onFinishProgress?.({ stage: "finalizing" });
      await options.yieldControl?.();
      throwIfCancelled(options.signal);
      const muxInput = {
        width: config.width,
        height: config.height,
        timescale: timescaleFor(config.fps),
        samples,
        codecDescription: description,
        ...(audio === undefined ? {} : { audio }),
      };
      const target = spool;
      if (target === null) throw unavailable("the disk spool was closed before MP4 finalization.");
      // OPFS finalization owns one writable stream. Let it finish or fail before cleanup;
      // racing abort against these writes would close the same stream from two tasks.
      const stored = await target.finish(mp4StreamParts(muxInput));
      throwIfCancelled(options.signal);
      spool = null;
      return {
        mimeType: audio === undefined
          ? `video/mp4; codecs="${avcCodecString(description)}"`
          : `video/mp4; codecs="${avcCodecString(description)}, mp4a.40.2"`,
        bytes: stored.file,
        dispose: stored.dispose,
        frameCount: samples.length,
        durationSeconds: samples.length / config.fps,
      };
    },

    async close() {
      try {
        encoder?.close();
      } catch {
        // Closing an already-errored encoder throws; the take is being abandoned anyway.
      }
      encoder = null;
      try {
        audioEncoder?.close();
      } catch {
        // The take is already being abandoned.
      }
      audioEncoder = null;
      wakeAudioQueue?.();
      try {
        audioDecoder?.close();
      } catch {
        // The take is already being abandoned.
      }
      audioDecoder = null;
      const activeSpool = spool;
      spool = null;
      if (activeSpool !== null) await activeSpool.abort(failure);
    },
  };

  async function encodeAudioTrack(
    pcm: import("./types.ts").AudioPcmTrack | import("./types.ts").AudioPcmSource,
    bitrate = 192_000,
  ): Promise<Mp4AudioTrack> {
    if (
      typeof AudioEncoder !== "function" ||
      typeof AudioData !== "function" ||
      typeof AudioDecoder !== "function"
    ) {
      throw unavailable("AudioEncoder, AudioDecoder, and AudioData are required for synchronized AAC export.");
    }
    if (pcm.channelCount !== 1) {
      throw unavailable(`offline audio supplied ${String(pcm.channelCount)} channels; only mono is implemented.`);
    }
    const encoderConfig: AudioEncoderConfig = {
      codec: "mp4a.40.2",
      sampleRate: pcm.sampleRate,
      numberOfChannels: pcm.channelCount,
      bitrate,
    };
    const support = await AudioEncoder.isConfigSupported(encoderConfig);
    if (support.supported !== true) {
      throw unavailable(`no AAC-LC encoder for ${String(pcm.sampleRate)} Hz mono audio.`);
    }

    const primingFrames = await measureAacPriming(encoderConfig);
    const audioSamples: Mp4AudioSample[] = [];
    let codecDescription: Uint8Array | null = null;
    let audioFailure: unknown = null;
    audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        const described = metadata?.decoderConfig?.description;
        if (described && codecDescription === null) codecDescription = toBytes(described);
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        const duration = Math.max(
          1,
          Math.round(((chunk.duration ?? 0) * pcm.sampleRate) / 1_000_000),
        );
        audioSamples.push({ byteLength: bytes.length, duration });
        writePacket(bytes);
      },
      error: (cause) => {
        audioFailure = cause;
        wakeAudioQueue?.();
      },
    });
    audioEncoder.configure(encoderConfig);

    const packetFrames = 1024;
    const totalFrames = "samples" in pcm ? pcm.samples.length : pcm.totalFrames;
    options.onFinishProgress?.({ stage: "audio", completedFrames: 0, totalFrames });
    await options.yieldControl?.();
    throwIfCancelled(options.signal);
    let packetIndex = 0;
    for (let offset = 0; offset < totalFrames; offset += packetFrames) {
      throwIfCancelled(options.signal);
      const numberOfFrames = Math.min(packetFrames, totalFrames - offset);
      const data = "samples" in pcm
        ? pcm.samples.slice(offset, offset + numberOfFrames)
        : pcm.readFrames(offset, numberOfFrames);
      const audio = new AudioData({
        format: "f32-planar",
        sampleRate: pcm.sampleRate,
        numberOfFrames,
        numberOfChannels: pcm.channelCount,
        timestamp: Math.round((offset * 1_000_000) / pcm.sampleRate),
        data: new Float32Array(data),
      });
      try {
        audioEncoder.encode(audio);
      } finally {
        audio.close();
      }
      packetIndex += 1;
      if (audioEncoder.encodeQueueSize >= 32) {
        // flush ends an AAC segment and can insert a new priming/padding region.
        // Backpressure must wait for consumed input without ending the stream.
        const active = audioEncoder;
        await new Promise<void>((resolve, reject) => {
          const check = (): void => {
            const error = audioFailure ?? failure;
            if (!error && options.signal?.aborted !== true && active.state === "configured" && active.encodeQueueSize >= 32) return;
            active.removeEventListener("dequeue", check);
            options.signal?.removeEventListener("abort", check);
            wakeAudioQueue = null;
            if (error) reject(error);
            else if (options.signal?.aborted === true) reject(cancelled());
            else if (active.state !== "configured") reject(new Error("AAC encoding closed while waiting for capacity."));
            else resolve();
          };
          wakeAudioQueue = check;
          active.addEventListener("dequeue", check);
          options.signal?.addEventListener("abort", check, { once: true });
          check();
        });
        await writeChain;
        if (audioFailure) throw audioFailure;
        if (failure) throw failure;
      }
      const completedFrames = offset + numberOfFrames;
      if (packetIndex % AUDIO_PROGRESS_PACKET_INTERVAL === 0 || completedFrames === totalFrames) {
        options.onFinishProgress?.({ stage: "audio", completedFrames, totalFrames });
        await options.yieldControl?.();
        throwIfCancelled(options.signal);
      }
    }
    await awaitWithCancellation(() => audioEncoder!.flush(), options.signal);
    await awaitWithCancellation(() => writeChain, options.signal);
    audioEncoder.close();
    audioEncoder = null;
    if (audioFailure) throw audioFailure;
    if (failure) throw failure;
    if (codecDescription === null) {
      throw unavailable("the AAC encoder never reported an AudioSpecificConfig description.");
    }

    const encodedFrames = audioSamples.reduce((total, sample) => total + sample.duration, 0);
    if (encodedFrames < primingFrames + totalFrames) {
      throw unavailable("AAC output does not contain the complete primed soundtrack.");
    }
    return {
      sampleRate: pcm.sampleRate,
      channelCount: pcm.channelCount,
      samples: audioSamples,
      codecDescription,
      bitrate,
      mediaStart: primingFrames,
      presentationDuration: totalFrames,
    };
  }

  async function measureAacPriming(config: AudioEncoderConfig): Promise<number> {
    let decoderConfig: AudioDecoderConfig | null = null;
    let encodeFailure: unknown = null;
    const chunks: EncodedAudioChunk[] = [];
    audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        chunks.push(chunk);
        if (metadata?.decoderConfig) decoderConfig = metadata.decoderConfig;
      },
      error: (cause) => {
        encodeFailure = cause;
      },
    });
    audioEncoder.configure(config);
    const calibration = new Float32Array(1024);
    calibration[0] = 1;
    const audio = new AudioData({
      format: "f32-planar",
      sampleRate: config.sampleRate,
      numberOfFrames: calibration.length,
      numberOfChannels: config.numberOfChannels,
      timestamp: 0,
      data: calibration,
    });
    try {
      audioEncoder.encode(audio);
    } finally {
      audio.close();
    }
    await audioEncoder.flush();
    audioEncoder.close();
    audioEncoder = null;
    if (encodeFailure) throw encodeFailure;
    if (decoderConfig === null) throw unavailable("AAC priming probe received no decoder configuration.");

    let decodedOffset = 0;
    let maximum = 0;
    let maximumIndex = -1;
    let decodeFailure: unknown = null;
    audioDecoder = new AudioDecoder({
      output: (decoded) => {
        const plane = new Float32Array(decoded.numberOfFrames);
        decoded.copyTo(plane, { planeIndex: 0 });
        for (let index = 0; index < plane.length; index += 1) {
          const magnitude = Math.abs(plane[index] as number);
          if (magnitude > maximum) {
            maximum = magnitude;
            maximumIndex = decodedOffset + index;
          }
        }
        decodedOffset += plane.length;
        decoded.close();
      },
      error: (cause) => {
        decodeFailure = cause;
      },
    });
    audioDecoder.configure(decoderConfig);
    for (const chunk of chunks) audioDecoder.decode(chunk);
    await audioDecoder.flush();
    audioDecoder.close();
    audioDecoder = null;
    if (decodeFailure) throw decodeFailure;
    if (maximumIndex < 0 || maximum < 0.01) {
      throw unavailable("AAC priming could not be measured from the calibration impulse.");
    }
    return maximumIndex;
  }
}

function toBytes(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  const view = source as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function drain(encoder: VideoEncoder): Promise<void> {
  return encoder.flush();
}

/** ~0.12 bits per pixel per frame — a defensible default for screen-captured graphics. */
function estimateBitrate(config: EncoderConfig): number {
  return Math.round(config.width * config.height * config.fps * 0.12);
}
