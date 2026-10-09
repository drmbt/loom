import { expect, test } from "@playwright/test";

/**
 * VN104 — the soundtrack is stereo. Two tones go in on two channels (440 Hz left, 1 kHz
 * right) through the shipped encoder and muxer; the file is decoded back by the browser and
 * each channel must carry its own tone and not the other's. Encoding the same input twice
 * must give the same bytes (the export is deterministic).
 */
test("a stereo soundtrack keeps its channels apart, and the same take gives the same bytes", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/runtime/export/recording/webcodecs.ts";
    const { createWebCodecsEncoder, probeWebCodecsAudioEncoder } = await import(/* @vite-ignore */ modulePath) as typeof import(
      "../../runtime/export/recording/webcodecs.ts"
    );
    const rate = 48_000;
    const frames = rate; // one second
    const interleaved = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      interleaved[i * 2] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4;
      interleaved[i * 2 + 1] = Math.sin((2 * Math.PI * 1000 * i) / rate) * 0.4;
    }
    const encodeOnce = async (): Promise<Uint8Array> => {
      const encoder = createWebCodecsEncoder({
        bitrate: 200_000,
        audioBitrate: 192_000,
        spool: "memory",
        audio: () => ({ sampleRate: rate, channelCount: 2, totalFrames: frames, readFrames: (offset, count) => interleaved.slice(offset * 2, (offset + count) * 2) }),
      });
      await encoder.configure({ width: 64, height: 64, fps: 30 });
      for (let frame = 0; frame < 30; frame += 1) {
        await encoder.encode({
          image: { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(frame) },
          frameIndex: frame,
          timestampMicros: Math.round((frame * 1_000_000) / 30),
          durationMicros: Math.round(1_000_000 / 30),
          keyFrame: frame === 0,
        });
      }
      const output = await encoder.finish();
      return output.bytes instanceof Blob ? new Uint8Array(await output.bytes.arrayBuffer()) : output.bytes;
    };
    const first = await encodeOnce();
    const second = await encodeOnce();
    const context = new AudioContext({ sampleRate: rate });
    const buffer = new ArrayBuffer(first.byteLength);
    new Uint8Array(buffer).set(first);
    const decoded = await context.decodeAudioData(buffer);
    await context.close();
    // Goertzel power of one frequency over the interior of a channel.
    const power = (channel: Float32Array, frequency: number): number => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / rate);
      let s1 = 0;
      let s2 = 0;
      const from = 4096;
      const to = channel.length - 4096;
      for (let i = from; i < to; i += 1) {
        const s0 = (channel[i] as number) + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return (s1 * s1 + s2 * s2 - coefficient * s1 * s2) / ((to - from) ** 2);
    };
    const left = decoded.getChannelData(0);
    const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
    return {
      stereoSupported: (await probeWebCodecsAudioEncoder(rate, 2)).supported,
      channels: decoded.numberOfChannels,
      duration: decoded.duration,
      left440: power(left, 440),
      left1000: power(left, 1000),
      right440: power(right, 440),
      right1000: power(right, 1000),
      identical: first.length === second.length && first.every((byte, index) => byte === second[index]),
    };
  });

  expect(result.stereoSupported).toBe(true);
  expect(result.channels).toBe(2);
  expect(result.duration).toBeGreaterThan(0.999);
  expect(result.duration).toBeLessThan(1.001);
  // A 0.4-amplitude sine has Goertzel power 0.04; crosstalk sits orders of magnitude below.
  expect(result.left440).toBeGreaterThan(0.02);
  expect(result.right1000).toBeGreaterThan(0.02);
  expect(result.left1000).toBeLessThan(result.left440 / 100);
  expect(result.right440).toBeLessThan(result.right1000 / 100);
  expect(result.identical).toBe(true);
});
