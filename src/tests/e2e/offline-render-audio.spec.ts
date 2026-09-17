import { expect, test } from "@playwright/test";

test("WebCodecs produces one H.264/AAC MP4 through the shipped encoder and muxer", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const entries = root as unknown as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
    for await (const name of entries.keys()) {
      if (name.startsWith(".loom-render-")) await root.removeEntry(name);
    }
    const modulePath = "/src/runtime/export/recording/webcodecs.ts";
    const { createWebCodecsEncoder, probeWebCodecsAudioEncoder } = await import(/* @vite-ignore */ modulePath) as typeof import(
      "../../runtime/export/recording/webcodecs.ts"
    );
    const audioSupport = await probeWebCodecsAudioEncoder();
    const soundtrack = Float32Array.from(
      { length: 144_000 },
      (_value, index) => Math.sin((2 * Math.PI * 440 * index) / 48_000) * 0.5,
    );
    const encoder = createWebCodecsEncoder({
      bitrate: 500_000,
      audioBitrate: 96_000,
      audio: () => ({ sampleRate: 48_000, channelCount: 1, samples: soundtrack }),
    });
    await encoder.configure({ width: 64, height: 64, fps: 30 });
    await encoder.encode({
      image: { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) },
      frameIndex: 0,
      timestampMicros: 0,
      durationMicros: 33_333,
      keyFrame: true,
    });
    const output = await encoder.finish();
    const outputBytes = output.bytes instanceof Blob
      ? new Uint8Array(await output.bytes.arrayBuffer())
      : output.bytes;
    await output.dispose?.();
    let temporaryFiles = 0;
    for await (const name of entries.keys()) {
      if (name.startsWith(".loom-render-")) temporaryFiles += 1;
    }
    const audioContext = new AudioContext();
    const mp4 = new ArrayBuffer(outputBytes.byteLength);
    new Uint8Array(mp4).set(outputBytes);
    const decoded = await audioContext.decodeAudioData(mp4);
    const channel = decoded.getChannelData(0);
    let audioPeak = 0;
    for (const sample of channel) audioPeak = Math.max(audioPeak, Math.abs(sample));
    let minimumWindowRms = Infinity;
    // Ignore codec priming edges, but inspect every interior 5.3 ms window. A peak-only
    // test misses the periodic silence introduced by flushing each AAC input batch.
    for (let start = 4096; start + 256 < channel.length - 4096; start += 256) {
      let power = 0;
      for (let i = start; i < start + 256; i += 1) power += channel[i]! ** 2;
      minimumWindowRms = Math.min(minimumWindowRms, Math.sqrt(power / 256));
    }
    await audioContext.close();
    return {
      mimeType: output.mimeType,
      frameCount: output.frameCount,
      hasVideoTrack: new TextDecoder("latin1").decode(outputBytes).includes("vide"),
      hasAudioTrack: new TextDecoder("latin1").decode(outputBytes).includes("soun"),
      byteLength: outputBytes.length,
      decodedAudioFrames: decoded.length,
      decodedDuration: decoded.duration,
      audioPeak,
      minimumWindowRms,
      audioSupported: audioSupport.supported,
      temporaryFiles,
    };
  });

  expect(result).toMatchObject({
    frameCount: 1,
    hasVideoTrack: true,
    hasAudioTrack: true,
    audioSupported: true,
    temporaryFiles: 0,
  });
  expect(result.mimeType).toContain("avc1");
  expect(result.mimeType).toContain("mp4a.40.2");
  expect(result.byteLength).toBeGreaterThan(100);
  expect(result.decodedAudioFrames).toBeGreaterThan(140_000);
  expect(result.decodedDuration).toBeGreaterThan(2.999);
  expect(result.decodedDuration).toBeLessThan(3.001);
  expect(result.audioPeak).toBeGreaterThan(0.1);
  expect(result.minimumWindowRms).toBeGreaterThan(0.25);
});
