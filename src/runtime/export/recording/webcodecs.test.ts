import { afterEach, expect, it, vi } from "vitest";

import { createWebCodecsEncoder, h264CodecFor } from "./webcodecs.ts";

afterEach(() => vi.unstubAllGlobals());

it("selects an H.264 level that can describe the requested production size class", () => {
  expect(h264CodecFor({ width: 1920, height: 1080, fps: 60 })).toBe("avc1.42002a");
  expect(h264CodecFor({ width: 3840, height: 2160, fps: 60 })).toBe("avc1.640034");
});

it("encodes supplied PCM as AAC and returns one MP4 with video and sound tracks", async () => {
  let stalledVideoFlush: Promise<void> | null = null;
  let stalledVideoFlushStarted = false;
  class FakeVideoFrame {
    close(): void {}
  }
  class FakeVideoEncoder {
    static isConfigSupported = async (config: VideoEncoderConfig) => ({ supported: true, config });
    readonly encodeQueueSize = 0;
    private readonly init: VideoEncoderInit;
    constructor(init: VideoEncoderInit) { this.init = init; }
    configure(): void {}
    encode(): void {
      this.init.output({
        byteLength: 3,
        type: "key",
        copyTo: (target: AllowSharedBufferSource) => new Uint8Array(target as ArrayBuffer).set([1, 2, 3]),
      } as EncodedVideoChunk, {
        decoderConfig: { codec: "avc1.42002a", description: Uint8Array.from([1, 0x42, 0, 0x2a]) },
      });
    }
    flush(): Promise<void> {
      if (stalledVideoFlush !== null) stalledVideoFlushStarted = true;
      return stalledVideoFlush ?? Promise.resolve();
    }
    close(): void {}
  }
  class FakeAudioData {
    close(): void {}
  }
  const audioEncoders: FakeAudioEncoder[] = [];
  class FakeAudioEncoder extends EventTarget {
    static isConfigSupported = async (config: AudioEncoderConfig) => ({ supported: true, config });
    private readonly init: AudioEncoderInit;
    encodeQueueSize = 0;
    state = "configured";
    flushes = 0;
    maxQueue = 0;
    constructor(init: AudioEncoderInit) { super(); this.init = init; audioEncoders.push(this); }
    configure(): void {}
    encode(): void {
      this.encodeQueueSize++;
      this.maxQueue = Math.max(this.maxQueue, this.encodeQueueSize);
      queueMicrotask(() => {
        this.encodeQueueSize--;
        this.init.output({
          byteLength: 2,
          duration: 21_333,
          copyTo: (target: AllowSharedBufferSource) => new Uint8Array(target as ArrayBuffer).set([4, 5]),
        } as EncodedAudioChunk, {
          decoderConfig: {
            codec: "mp4a.40.2",
            sampleRate: 48_000,
            numberOfChannels: 1,
            description: Uint8Array.from([0x11, 0x90]),
          },
        });
        this.dispatchEvent(new Event("dequeue"));
      });
    }
    flush(): Promise<void> { this.flushes++; return Promise.resolve(); }
    close(): void { this.state = "closed"; }
  }
  class FakeAudioDecoder {
    private readonly init: AudioDecoderInit;
    constructor(init: AudioDecoderInit) { this.init = init; }
    configure(): void {}
    decode(): void {
      this.init.output({
        numberOfFrames: 1024,
        copyTo: (target: AllowSharedBufferSource) => {
          const samples = target instanceof Float32Array ? target : new Float32Array(target as ArrayBuffer);
          samples[0] = 1;
        },
        close: () => undefined,
      } as unknown as AudioData);
    }
    flush(): Promise<void> { return Promise.resolve(); }
    close(): void {}
  }
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
  vi.stubGlobal("AudioData", FakeAudioData);
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
  vi.stubGlobal("AudioDecoder", FakeAudioDecoder);

  const reads: Array<readonly [number, number]> = [];
  const progress: string[] = [];
  const spoolBytes: number[] = [];
  const yieldControl = vi.fn(async () => undefined);
  const encoder = createWebCodecsEncoder({
    spool: "memory",
    onFinishProgress: update => progress.push(update.stage),
    onSpoolProgress: bytes => spoolBytes.push(bytes),
    yieldControl,
    audio: () => ({
      sampleRate: 48_000,
      channelCount: 1,
      totalFrames: 70 * 1024 + 452,
      readFrames(offset, count) {
        reads.push([offset, count]);
        return new Float32Array(count);
      },
    }),
  });
  await encoder.configure({ width: 2, height: 2, fps: 60 });
  await encoder.encode({
    image: { width: 2, height: 2, data: new Uint8Array(16) },
    frameIndex: 0,
    timestampMicros: 0,
    durationMicros: 16_667,
    keyFrame: true,
  });
  const video = await encoder.finish();

  expect(video.mimeType).toContain("mp4a.40.2");
  const bytes = video.bytes instanceof Blob
    ? new Uint8Array(await video.bytes.arrayBuffer())
    : video.bytes;
  expect(new TextDecoder("latin1").decode(bytes)).toContain("soun");
  expect(video.frameCount).toBe(1);
  expect(reads).toHaveLength(71);
  expect(reads.at(-1)).toEqual([70 * 1024, 452]);
  expect(audioEncoders.map(instance => instance.flushes)).toEqual([1, 1]);
  expect(audioEncoders[1]!.maxQueue).toBe(32);
  expect(progress[0]).toBe("video");
  expect(progress).toContain("audio");
  expect(progress.at(-1)).toBe("finalizing");
  expect(yieldControl.mock.calls.length).toBeGreaterThan(2);
  expect(spoolBytes.length).toBeGreaterThan(1);
  expect(spoolBytes.every((bytes, index) => index === 0 || bytes > (spoolBytes[index - 1] ?? 0))).toBe(true);

  const controller = new AbortController();
  const cancelledEncoder = createWebCodecsEncoder({
    spool: "memory",
    signal: controller.signal,
    audio: () => ({
      sampleRate: 48_000,
      channelCount: 1,
      totalFrames: 1024,
      readFrames: (_offset, count) => new Float32Array(count),
    }),
    onFinishProgress(update) {
      if (update.stage === "audio") controller.abort();
    },
    yieldControl: async () => undefined,
  });
  await cancelledEncoder.configure({ width: 2, height: 2, fps: 60 });
  await cancelledEncoder.encode({
    image: { width: 2, height: 2, data: new Uint8Array(16) },
    frameIndex: 0,
    timestampMicros: 0,
    durationMicros: 16_667,
    keyFrame: true,
  });
  await expect(cancelledEncoder.finish()).rejects.toMatchObject({ name: "AbortError" });
  await cancelledEncoder.close?.();

  let releaseVideoFlush!: () => void;
  stalledVideoFlush = new Promise<void>(resolve => { releaseVideoFlush = resolve; });
  const videoController = new AbortController();
  const stalledEncoder = createWebCodecsEncoder({
    spool: "memory",
    signal: videoController.signal,
  });
  await stalledEncoder.configure({ width: 2, height: 2, fps: 60 });
  await stalledEncoder.encode({
    image: { width: 2, height: 2, data: new Uint8Array(16) },
    frameIndex: 0,
    timestampMicros: 0,
    durationMicros: 16_667,
    keyFrame: true,
  });
  const finishing = stalledEncoder.finish();
  await Promise.resolve();
  expect(stalledVideoFlushStarted).toBe(true);
  videoController.abort();
  await expect(finishing).rejects.toMatchObject({ name: "AbortError" });
  await stalledEncoder.close?.();
  releaseVideoFlush();
});
