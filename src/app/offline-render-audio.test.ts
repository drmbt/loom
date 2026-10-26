import { describe, expect, it } from "vitest";

import { createFeatureTrackRecorder, SILENCE } from "@domain/audio/feature-track.ts";
import type { MediaTransportValues } from "@domain/media/transport.ts";
import { readTrackAtPlayhead } from "./audio-pre-analysis.ts";
import { createOfflineAudioMix } from "./offline-render-audio.ts";
import type { MonoPcm } from "./audio-pre-analysis.ts";
import type { OfflineAudioFrameState } from "./offline-render-audio.ts";
import type { FrameRange } from "@domain/types/graph.ts";

/**
 * One mono source through the stereo mix, read back as its LEFT channel after asserting the
 * right is identical (a mono source feeds both). The mix runs at the source's own rate here
 * so the expected samples are the source's own.
 */
function createOfflineAudioCapture(source: MonoPcm, _duration: number, range: FrameRange, timelineFps: number, outputFps = timelineFps) {
  const mix = createOfflineAudioMix([{ id: "a", channels: [source.samples], sampleRate: source.sampleRate }], range, timelineFps, outputFps, source.sampleRate);
  return {
    note: (state: OfflineAudioFrameState) => mix.note("a", state),
    source() {
      const stereo = mix.source();
      return {
        sampleRate: stereo.sampleRate,
        totalFrames: stereo.totalFrames,
        readFrames(offset: number, count: number): Float32Array {
          const interleaved = stereo.readFrames(offset, count);
          const left = Float32Array.from({ length: count }, (_v, i) => interleaved[i * 2] as number);
          const right = Float32Array.from({ length: count }, (_v, i) => interleaved[i * 2 + 1] as number);
          expect(right).toEqual(left);
          return left;
        },
      };
    },
  };
}

const TIMELINE: MediaTransportValues = {
  playMode: "timeline",
  play: true,
  speed: 1,
  cue: false,
  cuePoint: 0,
  trimStart: 0,
  trimEnd: 0,
  extend: "hold",
};

describe("offline soundtrack alignment", () => {
  it("keeps project-time audio duration when a 60 fps timeline is exported at 30 fps", () => {
    const source = Float32Array.from({ length: 4800 }, (_, index) => index / 4800);
    const capture = createOfflineAudioCapture(
      { samples: source, sampleRate: 480 },
      10,
      { start: 0, end: 29 },
      60,
      30,
    );
    for (let frame = 0; frame < 60; frame += 1) {
      capture.note({ frameIndex: frame, timelineSeconds: frame / 60, transport: TIMELINE, volume: 1 });
    }
    const rendered = capture.source();
    expect(rendered.totalFrames).toBe(480);
    const pcm = rendered.readFrames(0, rendered.totalFrames);
    expect(pcm).toEqual(Float32Array.from({ length: 480 }, (_, index) => index / 4800));
  });

  it("renders exactly the selected video range against absolute timeline time", () => {
    const source = Float32Array.from({ length: 32 }, (_, index) => index / 32);
    const capture = createOfflineAudioCapture(
      { samples: source, sampleRate: 8 },
      4,
      { start: 2, end: 3 },
      2,
    );
    capture.note({ frameIndex: 2, timelineSeconds: 1, transport: TIMELINE, volume: 1 });
    capture.note({ frameIndex: 3, timelineSeconds: 1.5, transport: TIMELINE, volume: 1 });

    const rendered = capture.source();
    expect(rendered.sampleRate).toBe(8);
    expect(rendered.totalFrames).toBe(8);
    expect(rendered.readFrames(0, 8)).toEqual(source.slice(8, 16));
  });

  it("uses the transport and volume captured for each rendered frame", () => {
    const source = Float32Array.from({ length: 16 }, (_, index) => index / 16);
    const capture = createOfflineAudioCapture(
      { samples: source, sampleRate: 4 },
      4,
      { start: 0, end: 1 },
      2,
    );
    capture.note({
      frameIndex: 0,
      timelineSeconds: 0,
      transport: { ...TIMELINE, trimStart: 1 },
      volume: 0.5,
    });
    capture.note({
      frameIndex: 1,
      timelineSeconds: 0.5,
      transport: { ...TIMELINE, speed: 2 },
      volume: 1,
    });

    expect(Array.from(capture.source().readFrames(0, 4))).toEqual([0.125, 0.15625, 0.25, 0.375]);
  });

  it("lands audible frame boundaries on the same source positions as visual feature reads", () => {
    const fps = 2;
    const sampleRate = 8;
    const source = Float32Array.from({ length: 64 }, (_, index) => index / 64);
    const features = createFeatureTrackRecorder(fps);
    for (let frame = 0; frame < source.length / (sampleRate / fps); frame += 1) {
      features.capture(frame, {
        ...SILENCE,
        level: source[frame * (sampleRate / fps)] as number,
      });
    }
    const range = { start: 2, end: 4 };
    const transports = [
      { ...TIMELINE, trimStart: 1 },
      { ...TIMELINE, speed: 2 },
      { ...TIMELINE, trimStart: 0.5, speed: 0.5 },
    ];
    const capture = createOfflineAudioCapture(
      { samples: source, sampleRate },
      source.length / sampleRate,
      range,
      fps,
    );
    for (let frame = range.start; frame <= range.end; frame += 1) {
      capture.note({
        frameIndex: frame,
        timelineSeconds: frame / fps,
        transport: transports[frame - range.start] as MediaTransportValues,
        volume: 1,
      });
    }

    const track = capture.source();
    const rendered = track.readFrames(0, track.totalFrames);
    const samplesPerFrame = sampleRate / fps;
    for (let frame = range.start; frame <= range.end; frame += 1) {
      const transport = transports[frame - range.start] as MediaTransportValues;
      const visual = readTrackAtPlayhead(
        features.track(),
        transport,
        frame / fps,
        source.length / sampleRate,
        0,
      );
      expect(rendered[(frame - range.start) * samplesPerFrame]).toBeCloseTo(visual.level, 6);
    }
  });

  it("samples across frame and chunk boundaries identically, including the final partial batch", () => {
    const source = Float32Array.from({ length: 64 }, (_, index) => Math.sin(index * 0.3));
    const capture = createOfflineAudioCapture({ samples: source, sampleRate: 11 }, 64 / 11,
      { start: 1, end: 3 }, 3);
    for(let frame=1;frame<=3;frame++) capture.note({ frameIndex:frame,timelineSeconds:frame/3,
      transport:{ ...TIMELINE,speed:frame*0.3,trimStart:frame*0.1 },volume:1/frame });
    const track=capture.source();
    const contiguous=track.readFrames(0,track.totalFrames);
    const partitioned=new Float32Array(track.totalFrames);
    for(let offset=0;offset<track.totalFrames;offset+=4) {
      const batch=track.readFrames(offset,Math.min(4,track.totalFrames-offset));
      expect(batch.length).toBeLessThanOrEqual(4);
      partitioned.set(batch,offset);
    }
    expect(partitioned).toEqual(contiguous);
    expect(track.readFrames(track.totalFrames,0)).toHaveLength(0);
    expect(()=>track.readFrames(-1,1)).toThrow(RangeError);
    expect(()=>track.readFrames(0,track.totalFrames+1)).toThrow(RangeError);
    expect(()=>track.readFrames(0.5,1)).toThrow(RangeError);
  });

  it("exposes a long take without allocating its full PCM output", () => {
    const sampleRate=48_000, fps=30, frameCount=18_000;
    const capture=createOfflineAudioCapture({ samples:new Float32Array([0.5,0.5]),sampleRate },2/sampleRate,
      {start:0,end:frameCount-1},fps);
    for(let frame=0;frame<frameCount;frame++) capture.note({ frameIndex:frame,timelineSeconds:frame/fps,transport:TIMELINE,volume:1 });
    const track=capture.source();
    expect(track.totalFrames).toBe(28_800_000);
    expect("samples" in (track as object)).toBe(false);
    expect(track.readFrames(track.totalFrames-1024,1024)).toEqual(new Float32Array(1024).fill(0.5));
  });

  it("refuses a soundtrack when any selected frame did not cross the capture seam", () => {
    const capture = createOfflineAudioCapture(
      { samples: new Float32Array(8), sampleRate: 4 },
      2,
      { start: 4, end: 5 },
      2,
    );
    capture.note({ frameIndex: 4, timelineSeconds: 2, transport: TIMELINE, volume: 1 });
    expect(() => capture.source()).toThrow("Audio export did not observe timeline frame 5 for source a");
  });
});

describe("stereo soundtrack mix (VN104)", () => {
  const tone = (frequency: number, rate: number, seconds: number): Float32Array =>
    Float32Array.from({ length: rate * seconds }, (_v, i) => Math.sin((2 * Math.PI * frequency * i) / rate) * 0.25);

  it("sums every source at its own volume, mono to both channels and stereo channel to channel", () => {
    const rate = 1000;
    const mono = tone(50, rate, 2);
    const left = tone(100, rate, 2);
    const right = tone(200, rate, 2);
    const mix = createOfflineAudioMix(
      [
        { id: "mono", channels: [mono], sampleRate: rate },
        { id: "stereo", channels: [left, right], sampleRate: rate },
      ],
      { start: 0, end: 9 },
      10,
      10,
      rate,
    );
    for (let frame = 0; frame < 10; frame += 1) {
      mix.note("mono", { frameIndex: frame, timelineSeconds: frame / 10, transport: TIMELINE, volume: 0.5 });
      mix.note("stereo", { frameIndex: frame, timelineSeconds: frame / 10, transport: TIMELINE, volume: 1 });
    }
    const track = mix.source();
    expect(track.channelCount).toBe(2);
    expect(track.totalFrames).toBe(1000);
    const pcm = track.readFrames(0, 1000);
    for (const index of [0, 1, 7, 333, 999]) {
      expect(pcm[index * 2]).toBeCloseTo((mono[index] as number) * 0.5 + (left[index] as number), 6);
      expect(pcm[index * 2 + 1]).toBeCloseTo((mono[index] as number) * 0.5 + (right[index] as number), 6);
    }
  });

  it("silences a source that its transport hides, leaving the others", () => {
    const rate = 100;
    const a = new Float32Array(rate).fill(0.25);
    const b = new Float32Array(rate).fill(0.5);
    const mix = createOfflineAudioMix(
      [{ id: "a", channels: [a], sampleRate: rate }, { id: "b", channels: [b], sampleRate: rate }],
      { start: 0, end: 1 }, 2, 2, rate,
    );
    for (let frame = 0; frame < 2; frame += 1) {
      mix.note("a", { frameIndex: frame, timelineSeconds: frame / 2, transport: TIMELINE, volume: 1 });
      mix.note("b", { frameIndex: frame, timelineSeconds: frame / 2, transport: TIMELINE, volume: frame === 0 ? 1 : 0 });
    }
    const pcm = mix.source().readFrames(0, 100);
    expect(pcm[0]).toBeCloseTo(0.75, 6);
    expect(pcm[2 * 60]).toBeCloseTo(0.25, 6);
  });

  it("refuses a source that is not in the mix, or a frame one source never saw", () => {
    const mix = createOfflineAudioMix(
      [{ id: "a", channels: [new Float32Array(8)], sampleRate: 4 }, { id: "b", channels: [new Float32Array(8)], sampleRate: 4 }],
      { start: 0, end: 0 }, 2, 2, 4,
    );
    expect(() => mix.note("c", { frameIndex: 0, timelineSeconds: 0, transport: TIMELINE, volume: 1 })).toThrow(/not in this mix/);
    mix.note("a", { frameIndex: 0, timelineSeconds: 0, transport: TIMELINE, volume: 1 });
    expect(() => mix.source()).toThrow("Audio export did not observe timeline frame 0 for source b");
  });
});
