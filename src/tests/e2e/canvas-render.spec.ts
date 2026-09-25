import { expect, test } from "@playwright/test";

test("canvas capture preserves temporal stepping, MP4 audio, and cancellation without scene readback", async ({ page }) => {
  // Use an isolated module page: no editor rendering competes with this generic fixture.
  await page.goto("/experiments/canvas-export/");
  const result = await page.evaluate(async () => {
    const backendPath = "/src/runtime/backend/index.ts";
    const fixturePath = "/src/runtime/backend/vgpu/plan-fixture.ts";
    const wgslPath = "/src/runtime/backend/wgsl.ts";
    const { wgsl } = await import(/* @vite-ignore */ wgslPath) as typeof import("../../runtime/backend/wgsl.ts");
    const sharedPath = "/src/runtime/backend/shared-uniforms.ts";
    const exportsPath = "/src/runtime/export/index.ts";
    const capturePath = "/src/app/render-canvas-capture.ts";
    const rangePath = "/src/app/render-range.ts";
    const { createVgpuBackend, browserGpuHost } = await import(/* @vite-ignore */ backendPath) as typeof import("../../runtime/backend/index.ts");
    const { fixturePlan } = await import(/* @vite-ignore */ fixturePath) as typeof import("../../runtime/backend/vgpu/plan-fixture.ts");
    const { SHARED_UNIFORMS_WGSL } = await import(/* @vite-ignore */ sharedPath) as typeof import("../../runtime/backend/shared-uniforms.ts");
    const { createExportInterface, readbackSourceFromBackend, loadVideoEncoder } = await import(/* @vite-ignore */ exportsPath) as typeof import("../../runtime/export/index.ts");
    const { createRenderCanvasCapture } = await import(/* @vite-ignore */ capturePath) as typeof import("../../app/render-canvas-capture.ts");
    const { renderFrameRange } = await import(/* @vite-ignore */ rangePath) as typeof import("../../app/render-range.ts");
    const backend = createVgpuBackend({ host: browserGpuHost() });
    const diagnostics: string[] = [];
    backend.onDiagnostic(d => { if (d.severity === "error") diagnostics.push(d.message); });
    await backend.initialize({});
    const width = 256, height = 128;
    const plan = await backend.compile(fixturePlan({ size: [width, height], generateShader: wgsl`${SHARED_UNIFORMS_WGSL}
      struct Params { amount:f32, tint:f32 };
      @group(0) @binding(0) var<uniform> frameU:SharedFrame;
      @group(0) @binding(1) var<uniform> params:Params;
      @fragment fn fs(@location(0) uv:vec2f)->@location(0) vec4f {
        let bit=(u32(frameU.frameIndex)>>u32(uv.x*8.0))&1u;
        return vec4f(vec3f(f32(bit)*params.amount+params.tint),1.0);
      }` }));
    const output = { ref: { nodeId: "out", portId: "out" }, resourceId: "output", width, height,
      format: "rgba8unorm" as const, space: "encoded" as const };
    const api = createExportInterface({ source: readbackSourceFromBackend(backend), outputs: () => [output], isPlaying: () => false });
    let current = 0;
    const rendered: number[] = [];
    const at = () => ({ frame: { frameIndex: current, timeSeconds: current / 60, deltaSeconds: 1 / 60,
      mode: "offline" as const, randomSeed: 75 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [width, height] as const });
    const step = () => { rendered.push(current); backend.render(plan, at()); return at(); };
    const transport = { isPlaying: () => false, togglePlay() {}, resetAbsoluteClock() {},
      seek(index: number) { current = index; backend.resetTemporalHistory(); step(); return current; },
      stepOnce() { current++; return step(); }, latestFrame: at };
    // Establish the actual feedback graph's pixel oracle through the old readback seam.
    // Its composite samples retained history, so its marker is not the generator's
    // current index. The capture path must preserve that temporal result exactly.
    const expectedSequence: number[] = [];
    transport.seek(0);
    for (let index = 0; index < 24; index++) {
      if (index > 0) transport.stepOnce();
      if (index % 2 !== 0) continue;
      const image = await api.read(output.ref, { reason: "test" });
      let marker = 0;
      for (let bit = 0; bit < 8; bit++) if (image.bytes[64 * image.rowStride + (bit * 32 + 16) * 4]! > 127) marker |= 1 << bit;
      expectedSequence.push(marker);
    }
    const readbacksBeforeTake = backend.status.readbacks;
    rendered.length = 0;
    const root = await navigator.storage.getDirectory();
    const temporaryFiles = async () => {
      const names: string[] = [];
      for await (const name of (root as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) {
        if (name.startsWith(".loom-render-")) names.push(name);
      }
      return names;
    };
    const before = await temporaryFiles();
    const capture = createRenderCanvasCapture(backend, output);
    let take: Awaited<ReturnType<typeof renderFrameRange>> | undefined;
    let audio: AudioContext | undefined;
    let url: string | undefined;
    try {
      const bytesWritten: number[] = [];
      const encoder = await loadVideoEncoder({ captureFrame: capture.captureFrame,
        onSpoolProgress: n => bytesWritten.push(n),
        audio: () => ({ sampleRate: 48000, channelCount: 1,
          samples: Float32Array.from({ length: 19200 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / 48000) * 0.5) }) });
      if (!encoder) throw new Error("WebCodecs unavailable");
      take = await renderFrameRange({ api, ref: output.ref, encoder, transport,
        timelineFps: 60, outputFps: 30, range: { start: 0, end: 11 } });
      capture.dispose();
      const framesStepped = [...rendered];
      const blob = take.bytes instanceof Blob ? take.bytes : new Blob([new Uint8Array(take.bytes)]);
      const video = document.createElement("video");
      video.muted = true;
      url = URL.createObjectURL(blob);
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("MP4 video decode failed")); video.src = url!; });
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("No decode pixel reader");
      const sequence: number[] = [];
      for (let index = 0; index < 12; index++) {
        await new Promise<void>(resolve => { video.onseeked = () => resolve(); video.currentTime = (index + 0.25) / 30; });
        context.drawImage(video, 0, 0);
        let marker = 0;
        for (let bit = 0; bit < 8; bit++) if (context.getImageData(bit * 32 + 16, 64, 1, 1).data[0]! > 127) marker |= 1 << bit;
        sequence.push(marker);
      }
      audio = new AudioContext({ sampleRate: 48000 });
      const decoded = await audio.decodeAudioData(await blob.arrayBuffer());
      const samples = decoded.getChannelData(0);
      let minimumRms = Infinity;
      for (let i = 4096; i + 256 < samples.length - 4096; i += 256) {
        let power = 0;
        for (let j = i; j < i + 256; j++) power += samples[j]! ** 2;
        minimumRms = Math.min(minimumRms, Math.sqrt(power / 256));
      }
      await take.dispose?.(); take = undefined;
      const cancelledCapture = createRenderCanvasCapture(backend, output);
      const controller = new AbortController();
      let cancelMessage = "";
      try {
        const cancelledEncoder = await loadVideoEncoder({ captureFrame: cancelledCapture.captureFrame, signal: controller.signal });
        if (!cancelledEncoder) throw new Error("WebCodecs unavailable");
        await renderFrameRange({ api, ref: output.ref, encoder: cancelledEncoder, transport,
          timelineFps: 60, outputFps: 30, range: { start: 0, end: 59 }, signal: controller.signal,
          onProgress: progress => { if (progress.completedFrames === 3) controller.abort(); } });
      } catch (error) { cancelMessage = String(error); }
      finally { cancelledCapture.dispose(); }
      return { framesStepped, sequence, expectedSequence, minimumRms, audioDuration: decoded.duration, videoDuration: video.duration,
        readbacks: backend.status.readbacks - readbacksBeforeTake, writes: bytesWritten.length, cancelMessage,
        before, after: await temporaryFiles(), diagnostics };
    } finally {
      capture.dispose();
      await take?.dispose?.();
      await audio?.close();
      if (url) URL.revokeObjectURL(url);
      backend.dispose();
    }
  });
  expect(result.framesStepped).toEqual(Array.from({ length: 24 }, (_, i) => i));
  expect(result.sequence).toEqual(result.expectedSequence);
  expect(new Set(result.sequence).size).toBe(12);
  expect(result.audioDuration).toBeCloseTo(0.4, 3);
  expect(result.videoDuration).toBeCloseTo(0.4, 3);
  expect(result.minimumRms).toBeGreaterThan(0.25);
  expect(result.readbacks).toBe(0);
  expect(result.writes).toBeGreaterThan(0);
  expect(result.cancelMessage).toContain("cancelled");
  expect(result.after).toEqual(result.before);
  expect(result.diagnostics).toEqual([]);
});
