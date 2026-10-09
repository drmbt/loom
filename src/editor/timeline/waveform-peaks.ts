/**
 * VN64 — THE REFERENCE MEDIA'S WAVEFORM: min/max peaks plus four band energies per bin.
 *
 * Ported from ltc-lab `server/waveform.mjs` (`computeWaveformFromPcm`, v2): a fixed number
 * of bins per second, raw sample extremes per bin, and ONE STFT sweep (Hann window, fixed
 * hop, one reused FFT buffer) summing magnitude into sub (< 60 Hz), low (< 250 Hz), mid
 * (≤ 4 kHz) and high bands, each band normalised to its own 98th percentile. Input is the
 * 48 kHz mono PCM the app's pre-analysis decodes (`decodeAtFixedRate`), so there is no
 * mixdown here.
 *
 * Pure and allocation-bounded, so it runs the same in the worker and on the main thread.
 */

export interface WaveformPeaks {
  readonly binsPerSecond: number;
  readonly durationSeconds: number;
  readonly bins: number;
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly sub: Float32Array;
  readonly low: Float32Array;
  readonly mid: Float32Array;
  readonly high: Float32Array;
}

const FFT_SIZE = 2048;
const HOP_SIZE = 1024;
export const DEFAULT_BINS_PER_SECOND = 100;

const HANN = (() => {
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  return window;
})();

/** In-place iterative radix-2 FFT; length a power of two. */
function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]!; real[i] = real[j]!; real[j] = tr;
      const ti = imag[i]!; imag[i] = imag[j]!; imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < half; j += 1) {
        const a = i + j;
        const b = a + half;
        const vr = real[b]! * cr - imag[b]! * ci;
        const vi = real[b]! * ci + imag[b]! * cr;
        real[b] = real[a]! - vr;
        imag[b] = imag[a]! - vi;
        real[a] = real[a]! + vr;
        imag[a] = imag[a]! + vi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** Means per bin; a bin no STFT frame landed in takes its nearest preceding neighbour. */
function bandMeans(sum: Float64Array, counts: Int32Array): Float64Array {
  const out = new Float64Array(sum.length);
  let last = Number.NaN;
  for (let i = 0; i < sum.length; i += 1) {
    if (counts[i]! > 0) last = sum[i]! / counts[i]!;
    out[i] = last;
  }
  const first = out.findIndex((value) => !Number.isNaN(value));
  if (first < 0) return new Float64Array(sum.length);
  for (let i = 0; i < first; i += 1) out[i] = out[first]!;
  return out;
}

/** 0..1 against the band's 98th percentile. */
function normaliseBand(raw: Float64Array): Float32Array {
  const sorted = Float64Array.from(raw).sort();
  const p98 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(0.98 * (sorted.length - 1)))]!;
  const out = new Float32Array(raw.length);
  if (!(p98 > 0)) return out;
  for (let i = 0; i < raw.length; i += 1) out[i] = Math.min(1, Math.max(0, raw[i]! / p98));
  return out;
}

export function computeWaveformPeaks(samples: Float32Array, sampleRate: number, binsPerSecond = DEFAULT_BINS_PER_SECOND): WaveformPeaks {
  const rate = sampleRate > 0 ? sampleRate : 48_000;
  const frames = samples.length;
  const durationSeconds = frames / rate;
  const bins = Math.max(1, Math.ceil(durationSeconds * binsPerSecond));

  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  if (frames > 0) {
    min.fill(Infinity);
    max.fill(-Infinity);
    for (let f = 0; f < frames; f += 1) {
      const bin = Math.min(bins - 1, Math.floor((f * bins) / frames));
      const v = samples[f]!;
      if (v < min[bin]!) min[bin] = v;
      if (v > max[bin]!) max[bin] = v;
    }
    for (let i = 0; i < bins; i += 1) {
      if (!Number.isFinite(min[i]!)) min[i] = 0;
      if (!Number.isFinite(max[i]!)) max[i] = 0;
    }
  }

  const sums = [new Float64Array(bins), new Float64Array(bins), new Float64Array(bins), new Float64Array(bins)] as const;
  const counts = new Int32Array(bins);
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const binHz = rate / FFT_SIZE;
  for (let start = 0; start < frames; start += HOP_SIZE) {
    for (let k = 0; k < FFT_SIZE; k += 1) {
      const f = start + k;
      real[k] = (f < frames ? samples[f]! : 0) * HANN[k]!;
      imag[k] = 0;
    }
    fft(real, imag);
    let sub = 0, low = 0, mid = 0, high = 0;
    for (let k = 1; k <= FFT_SIZE / 2; k += 1) {
      const frequency = k * binHz;
      const magnitude = Math.hypot(real[k]!, imag[k]!);
      if (frequency < 60) sub += magnitude;
      else if (frequency < 250) low += magnitude;
      else if (frequency <= 4000) mid += magnitude;
      else high += magnitude;
    }
    const centre = Math.min(frames - 1, start + FFT_SIZE / 2);
    const bin = Math.min(bins - 1, Math.floor((centre * bins) / frames));
    sums[0][bin] = sums[0][bin]! + sub;
    sums[1][bin] = sums[1][bin]! + low;
    sums[2][bin] = sums[2][bin]! + mid;
    sums[3][bin] = sums[3][bin]! + high;
    counts[bin] = counts[bin]! + 1;
  }
  const [sub, low, mid, high] = sums.map((sum) => normaliseBand(bandMeans(sum, counts))) as [Float32Array, Float32Array, Float32Array, Float32Array];
  return { binsPerSecond, durationSeconds, bins, min, max, sub, low, mid, high };
}

/** One pixel column's reading: extremes, and the band mix as weights. */
export interface PeakColumn {
  readonly min: number;
  readonly max: number;
  /** sub + low, mid, high: the weights the colour is mixed from. */
  readonly lowWeight: number;
  readonly midWeight: number;
  readonly highWeight: number;
}

/**
 * The peaks between two media seconds, folded to one column: the extremes of every bin it
 * covers (so a transient narrower than a pixel still shows), and the bands' mean. Null when
 * the span lies outside the media.
 */
export function peakColumn(peaks: WaveformPeaks, fromSeconds: number, toSeconds: number): PeakColumn | null {
  const lo = Math.min(fromSeconds, toSeconds);
  const hi = Math.max(fromSeconds, toSeconds);
  if (hi < 0 || lo >= peaks.durationSeconds) return null;
  const first = Math.max(0, Math.floor(lo * peaks.binsPerSecond));
  const last = Math.min(peaks.bins - 1, Math.max(first, Math.ceil(hi * peaks.binsPerSecond) - 1));
  let min = Infinity, max = -Infinity, low = 0, mid = 0, high = 0;
  for (let bin = first; bin <= last; bin += 1) {
    min = Math.min(min, peaks.min[bin]!);
    max = Math.max(max, peaks.max[bin]!);
    low += peaks.sub[bin]! + peaks.low[bin]!;
    mid += peaks.mid[bin]!;
    high += peaks.high[bin]!;
  }
  const count = last - first + 1;
  return { min, max, lowWeight: low / count, midWeight: mid / count, highWeight: high / count };
}
