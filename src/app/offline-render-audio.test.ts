import { describe, expect, it } from "vitest";

import { createFeatureTrackRecorder, SILENCE } from "@domain/audio/feature-track.ts";
import type { MediaTransportValues } from "@domain/media/transport.ts";
import { readTrackAtPlayhead } from "./audio-pre-analysis.ts";
import { createOfflineAudioCapture } from "./offline-render-audio.ts";

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
    expect("samples" in track).toBe(false);
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
    expect(() => capture.source()).toThrow("Audio export did not observe timeline frame 5");
  });
});
