import { createVgpuBackend, browserGpuHost } from '../../src/runtime/backend/index.ts';
import { SHARED_UNIFORMS_WGSL } from '../../src/runtime/backend/shared-uniforms.ts';
import { toRgba8At } from '../../src/runtime/export/image.ts';
import { h264CodecFor } from '../../src/runtime/export/recording/webcodecs.ts';

// This isolates capture + encode. Both paths use the same codec, queue budget, frame
// timestamps, GPU fixture, and explicit final flush. No scene-specific optimizations.
const { OffscreenCanvas, VideoFrame, VideoEncoder, VideoDecoder, performance, console, URLSearchParams, location } = globalThis;
const fps = 30;
const shader = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
  let uv=p.xy/frameU.resolution;
  let cell=u32(uv.x*8.0);
  let values=array<f32,8>(0.0,0.003,0.04,0.18,0.5,0.73,0.95,1.0);
  if(uv.y<0.25){
    let bit=(u32(frameU.frameIndex)>>cell)&1u;
    return vec4f(vec3f(f32(bit)),1.0);
  }
  if(uv.y<0.5){return vec4f(values[cell],values[7u-cell],0.3,1.0);}
  if(uv.y<0.625){return vec4f(vec3f(values[cell]),1.0);}
  return vec4f(uv.x,uv.y,fract(frameU.frameIndex/31.0),1.0);
}`;

function at(index, width, height) {
  return {
    frame: { frameIndex: index, timeSeconds: index / fps, deltaSeconds: 1 / fps,
      mode: 'offline', randomSeed: 75 },
    pointer: { x: 0, y: 0, buttons: 0 }, resolution: [width, height],
  };
}

async function setup(width, height, format, canvasKind, varyingAlpha = false) {
  const backend = createVgpuBackend({ host: browserGpuHost() });
  const errors = [];
  backend.onDiagnostic(d => { if (d.severity === 'error') errors.push(d.message); });
  await backend.initialize({});
  const plan = await backend.compile({
    resources: [{ kind: 'target', id: 'output', size: [width, height], format }],
    passes: [{ kind: 'effect', id: 'fixture', target: 'output',
      shader: varyingAlpha ? shader.replace('fract(frameU.frameIndex/31.0),1.0)', 'fract(frameU.frameIndex/31.0),f32(cell%4u)*0.5)') : shader,
      sharedBinding: 'frameU' }],
    diagnostics: [],
  });
  const canvas = canvasKind === 'offscreen' ? new OffscreenCanvas(width, height) : null;
  // Intentionally unattached: export must not depend on a visible viewer or compositor.
  const presentation = canvas === null ? null : backend.present(canvas, { outputId: 'output', label: 'export-prototype' });
  return { backend, plan, canvas, errors, dispose() { presentation?.dispose(); backend.dispose(); } };
}

async function pixels(frame) {
  const data = new Uint8Array(frame.codedWidth * frame.codedHeight * 4);
  await frame.copyTo(data, { format: 'RGBA', colorSpace: 'srgb' });
  return data;
}

async function parity(format, canvasKind, varyingAlpha = false) {
  const width = 256, height = 128;
  const fixture = await setup(width, height, format, canvasKind, varyingAlpha);
  const frames = [];
  let maximum = 0, total = 0, channels = 0;
  const references = [];
  try {
    for (let index = 0; index < 12; index++) {
      fixture.backend.render(fixture.plan, at(index, width, height));
      // Snapshot synchronously before any asynchronous readback or next render.
      frames.push(new VideoFrame(fixture.canvas, { timestamp: Math.round(index * 1e6 / fps) }));
      references.push(toRgba8At(await fixture.backend.readOutput('output'), width, height, { space: 'encoded' }).data);
    }
    // Read after subsequent renders to prove frames retain their own snapshot.
    for (let index = 0; index < frames.length; index++) {
      const actual = await pixels(frames[index]);
      const expected = references[index];
      for (let i = 0; i < actual.length; i++) {
        const error = Math.abs(actual[i] - (i % 4 === 3 ? 255 : expected[i]));
        maximum = Math.max(maximum, error); total += error; channels++;
      }
    }
    return { format, canvasKind, varyingAlpha, maxChannelError: maximum, meanChannelError: total / channels,
      snapshots: frames.length, errors: fixture.errors, passed: maximum <= 1 && fixture.errors.length === 0 };
  } finally {
    for (const frame of frames) frame.close();
    fixture.dispose();
  }
}

async function capture(mode, width, height, count, keepChunks = false) {
  const fixture = await setup(width, height, 'rgba16float', mode === 'canvas' ? 'offscreen' : 'none');
  const config = { codec: h264CodecFor({ width, height }), width, height, framerate: fps,
    bitrate: Math.round(width * height * fps * 0.12), latencyMode: 'quality', avc: { format: 'avc' } };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) { fixture.dispose(); throw new Error(`Unsupported codec: ${config.codec}`); }
  let failure;
  let outputs = 0, bytes = 0, maxQueue = 0, description, inputColorSpace, inputFormat;
  const chunks = [], originals = [];
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      outputs++; bytes += chunk.byteLength;
      if (metadata?.decoderConfig) description = metadata.decoderConfig;
      if (keepChunks) {
        chunks.push(chunk);
      }
    }, error(error) { failure = error; },
  });
  const timings = [];
  try {
    encoder.configure(config);
    const readbacksBefore = fixture.backend.status.readbacks;
    const started = performance.now();
    const queueLimit = Math.max(1, Math.floor(64 * 1024 * 1024 / (width * height * 4)));
    for (let index = 0; index < count; index++) {
      const start = performance.now();
      fixture.backend.render(fixture.plan, at(index, width, height));
      const init = { timestamp: Math.round(index * 1e6 / fps), duration: Math.round(1e6 / fps) };
      let frame;
      if (mode === 'canvas') frame = new VideoFrame(fixture.canvas, init);
      else {
        const raw = await fixture.backend.readOutput('output');
        const rgba = toRgba8At(raw, width, height, { space: 'encoded' });
        if (keepChunks) originals.push(rgba.data);
        frame = new VideoFrame(rgba.data, { ...init, format: 'RGBA', codedWidth: width, codedHeight: height });
      }
      inputColorSpace ??= frame.colorSpace.toJSON();
      inputFormat ??= frame.format;
      try { encoder.encode(frame, { keyFrame: index % 60 === 0 }); }
      finally { frame.close(); }
      maxQueue = Math.max(maxQueue, encoder.encodeQueueSize);
      // Match the production encoder's current flush-based queue backpressure.
      if (encoder.encodeQueueSize >= queueLimit) await encoder.flush();
      if (failure) throw failure;
      timings.push(performance.now() - start);
    }
    await encoder.flush();
    if (failure) throw failure;
    const elapsedMs = performance.now() - started;
    if (outputs !== count) throw new Error(`Encoded ${outputs} of ${count} frames`);
    if (fixture.errors.length) throw new Error(fixture.errors.join('\n'));
    return { mode, width, height, count, elapsedMs, fps: count * 1000 / elapsedMs,
      readbacks: fixture.backend.status.readbacks - readbacksBefore,
      maxQueue, bytes, timings, inputColorSpace, inputFormat, decoderColorSpace:description?.colorSpace, ...(keepChunks ? { chunks, description, originals } : {}) };
  } finally {
    encoder.close(); fixture.dispose();
  }
}

async function decode(capture) {
  const pending = [];
  let failure;
  const decoder = new VideoDecoder({
    output(frame) {
      pending.push(pixels(frame).then(data => ({ timestamp: frame.timestamp, data })).finally(() => frame.close()));
    }, error(error) { failure = error; },
  });
  try {
    decoder.configure(capture.description);
    for (const chunk of capture.chunks) decoder.decode(chunk);
    await decoder.flush();
    if (failure) throw failure;
    return await Promise.all(pending);
  } finally { decoder.close(); }
}

async function encodedParity() {
  const width=1024,height=512;
  const source = await capture('readback', width, height, 12, true);
  const target = await capture('canvas', width, height, 12, true);
  const reference = await decode(source);
  const candidate = await decode(target);
  const metadata = [source, target].map(r => ({ mode:r.mode, inputColorSpace:r.inputColorSpace, inputFormat:r.inputFormat, decoderColorSpace:r.description.colorSpace }));
  let maximum = 0, total = 0, channels = 0;
  const sequence = [];
  const patches = [];
  for (let index = 0; index < reference.length; index++) {
    if (candidate[index]?.timestamp !== reference[index].timestamp) throw new Error('Decoded timestamps differ');
    const a = reference[index].data, b = candidate[index].data;
    // Barcode centres must identify the actual image, not merely its timestamp.
    let barcode = 0;
    for (let bit = 0; bit < 8; bit++) if (b[((height/8) * width + bit * (width/8) + width/16) * 4] > 127) barcode |= 1 << bit;
    sequence.push(barcode);
    if (index === 0) for(let cell=0;cell<8;cell++) {
      const offset=((height*3/8)*width+cell*(width/8)+width/16)*4;
      patches.push({readback:[...a.slice(offset,offset+4)],canvas:[...b.slice(offset,offset+4)]});
    }
    for (let i = 0; i < a.length; i++) { const error = Math.abs(a[i] - b[i]); maximum = Math.max(maximum, error); total += error; channels++; }
  }
  const sourceQuality = quality(reference, source.originals);
  const canvasQuality = quality(candidate, source.originals);
  return { metadata, patches, sourceQuality, canvasQuality, frames: candidate.length, sequence,
    maxChannelError: maximum, meanChannelError: total / channels,
    passed: candidate.length === 12 && sequence.every((value, index) => value === index)
      && canvasQuality.psnr >= 35 && canvasQuality.psnr >= sourceQuality.psnr - 1
      && canvasQuality.mean <= sourceQuality.mean + 0.25 && canvasQuality.p95 <= sourceQuality.p95 + 1 };
}

function quality(decoded, originals) {
  const histogram = new Uint32Array(256);
  let sum = 0, squares = 0, count = 0, maximum = 0;
  for (let frame = 0; frame < decoded.length; frame++) {
    const actual = decoded[frame].data, expected = originals[frame];
    for (let i = 0; i < actual.length; i++) {
      if (i % 4 === 3) continue;
      const error = Math.abs(actual[i] - expected[i]);
      histogram[error]++; sum += error; squares += error * error; count++;
      maximum = Math.max(maximum, error);
    }
  }
  const percentile = fraction => {
    let cumulative = 0;
    for(let i=0;i<histogram.length;i++) { cumulative += histogram[i]; if(cumulative >= count*fraction) return i; }
    throw new Error('Empty image comparison');
  };
  return { mean: sum/count, p95: percentile(0.95), p99: percentile(0.99), maximum,
    psnr: 10*Math.log10(255*255/(squares/count)) };
}

globalThis.canvasExportProbe = async () => {
  const parityResults = [];
  for (const varyingAlpha of [false, true]) for (const format of ['rgba16float', 'rgba8unorm', 'rgba8unorm-srgb']) {
    const result = await parity(format, 'offscreen', varyingAlpha); parityResults.push(result);
    console.log('PROBE ' + JSON.stringify(result));
  }
  const encoded = await encodedParity();
  console.log('PROBE ' + JSON.stringify(encoded));
  const benchmarks = [];
  // ABBA order limits first-run bias. Each batch includes encoder drain in elapsed time.
  for (const mode of (new URLSearchParams(location.search).has('parityOnly') ? [] : ['readback', 'canvas', 'canvas', 'readback'])) {
    const result = await capture(mode, 2160, 3840, 60); benchmarks.push(result);
    console.log('PROBE ' + JSON.stringify({ ...result, timings: undefined }));
  }
  return { parity: parityResults, encoded, benchmarks, passed: parityResults.every(r => r.passed) && encoded.passed };
};
