/**
 * VN64 — the waveform peaks off the main thread. The work is `computeWaveformPeaks`, the
 * same function the main-thread fallback calls, so where it ran cannot change the result.
 */
import { computeWaveformPeaks, type WaveformPeaks } from "./waveform-peaks.ts";

export interface PeaksRequest {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

export type PeaksResponse = { readonly peaks: WaveformPeaks } | { readonly failure: string };

const scope = self as unknown as {
  postMessage(message: PeaksResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: PeaksRequest }) => void): void;
};

scope.addEventListener("message", (event) => {
  try {
    const peaks = computeWaveformPeaks(event.data.samples, event.data.sampleRate);
    scope.postMessage({ peaks }, [peaks.min.buffer, peaks.max.buffer, peaks.sub.buffer, peaks.low.buffer, peaks.mid.buffer, peaks.high.buffer]);
  } catch (error) {
    scope.postMessage({ failure: error instanceof Error ? error.message : String(error) });
  }
});
