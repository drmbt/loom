import { parseFileReference } from "@domain/media/file-reference.ts";
import { retainedFiles, type RetainedFiles } from "@ui/files/retained-files.ts";
import { computeWaveformPeaks, type WaveformPeaks } from "./waveform-peaks.ts";
import type { PeaksRequest, PeaksResponse } from "./waveform-peaks.worker.ts";

/**
 * VN64 — FROM A MEDIA NODE'S `file` TO ITS WAVEFORM, once per file per session.
 *
 * The file is read the way the media node reads it: a retained `loom-file:` reference is
 * leased from `retainedFiles()` until its object URL is ready (a permission prompt or a
 * missing file is a refusal with the store's own sentence), a `blob:` or plain URL is read
 * directly. The bytes are decoded at the pre-analysis rate (48 kHz mono, the same
 * `OfflineAudioContext` route as `decodeAtFixedRate`, so a video's audio track decodes too
 * where Chromium takes the container), and the peaks are computed in a Worker, or on the
 * main thread where none can be made.
 *
 * Cached by the reference string: the same retained file is the same reference across
 * nodes and reloads, and a session `blob:` URL is unique to its file.
 */

export const WAVEFORM_SAMPLE_RATE = 48_000;

export interface WaveformEnvironment {
  readonly files: Pick<RetainedFiles, "acquire" | "snapshot" | "subscribe">;
  readonly fetchBytes: (url: string) => Promise<ArrayBuffer>;
  readonly decode: (bytes: ArrayBuffer) => Promise<{ samples: Float32Array; sampleRate: number }>;
  readonly compute: (samples: Float32Array, sampleRate: number) => Promise<WaveformPeaks>;
}

async function decodeMono(bytes: ArrayBuffer): Promise<{ samples: Float32Array; sampleRate: number }> {
  if (typeof OfflineAudioContext === "undefined") throw new Error("This browser has no OfflineAudioContext to decode the reference audio with.");
  const context = new OfflineAudioContext(1, 1, WAVEFORM_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(bytes.slice(0));
  const samples = new Float32Array(buffer.length);
  const channels = Math.max(1, buffer.numberOfChannels);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i += 1) samples[i] = samples[i]! + data[i]! / channels;
  }
  return { samples, sampleRate: buffer.sampleRate };
}

function computeOffThread(samples: Float32Array, sampleRate: number): Promise<WaveformPeaks> {
  if (typeof Worker === "undefined") return Promise.resolve(computeWaveformPeaks(samples, sampleRate));
  return new Promise<WaveformPeaks>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./waveform-peaks.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(computeWaveformPeaks(samples, sampleRate));
      return;
    }
    const fallback = (): void => {
      worker.terminate();
      resolve(computeWaveformPeaks(samples, sampleRate));
    };
    worker.onmessage = (event: MessageEvent<PeaksResponse>) => {
      worker.terminate();
      if ("peaks" in event.data) resolve(event.data.peaks);
      else fallback();
    };
    worker.onerror = fallback;
    // Copied, not transferred: the fallback still needs the samples if the worker fails.
    worker.postMessage({ samples, sampleRate } satisfies PeaksRequest);
  });
}

const browserEnvironment = (): WaveformEnvironment => ({
  files: retainedFiles(),
  fetchBytes: async (url) => (await fetch(url)).arrayBuffer(),
  decode: decodeMono,
  compute: computeOffThread,
});

/** The object URL a reference reads from, waiting for a retained file to resolve. */
async function urlOf(reference: string, files: WaveformEnvironment["files"]): Promise<{ url: string; release(): void }> {
  if (parseFileReference(reference) === null) return { url: reference.split("#")[0] ?? reference, release: () => {} };
  const lease = files.acquire(reference);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const check = (): boolean => {
        const snapshot = files.snapshot(reference);
        if (snapshot.kind === "ready") resolve(snapshot.url.split("#")[0] ?? snapshot.url);
        else if (snapshot.kind !== "pending") reject(new Error(snapshot.message));
        else return false;
        return true;
      };
      if (check()) return;
      const unsubscribe = files.subscribe(() => {
        if (check()) unsubscribe();
      });
    });
    return { url, release: () => lease.release() };
  } catch (error) {
    lease.release();
    throw error;
  }
}

const cache = new Map<string, Promise<WaveformPeaks>>();

/** The waveform of the file a media node holds. A failure is not cached: relinking retries. */
export function waveformPeaksFor(reference: string, environment: WaveformEnvironment = browserEnvironment()): Promise<WaveformPeaks> {
  const cached = cache.get(reference);
  if (cached !== undefined) return cached;
  const loading = (async () => {
    const { url, release } = await urlOf(reference, environment.files);
    try {
      const bytes = await environment.fetchBytes(url);
      const { samples, sampleRate } = await environment.decode(bytes);
      return await environment.compute(samples, sampleRate);
    } finally {
      release();
    }
  })();
  cache.set(reference, loading);
  loading.catch(() => {
    if (cache.get(reference) === loading) cache.delete(reference);
  });
  return loading;
}
