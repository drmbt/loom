import type { AudioFeatures } from "../types/frame.ts";

/**
 * T1347b — THE SPECTRUM AS CHANNELS: eighteen log-spaced bands, 80 Hz to 16 kHz, on every
 * audio source.
 *
 * The four musical bands (`low` / `lowMid` / `highMid` / `high`) answer "how much bass",
 * and nothing finer. The owner's reference (an Unreal audio graph) has an eighteen-row
 * equaliser on the source node, each row its own socket, and the chain that made a scene
 * move was *one* of those rows — 109 Hz for the beat, 968 Hz for a slow tail — normalised
 * and smoothed downstream. That is inexpressible on four bands: a kick and a bass note
 * share `low`, a snare's crack and a vocal share `lowMid`. So the record now carries the
 * spectrum at the resolution a person can pick from.
 *
 * ## The layout is a FORMULA, and the names are its centres
 *
 * Centres run 80 Hz × r^k for k = 0..17 with r = 200^(1/17) ≈ 1.3657 (one band per ~0.45
 * octave), so the eighteenth centre is exactly 16 kHz; each band spans a geometric half-step
 * either side of its centre, which makes the edges meet with no gap and no overlap. The
 * channel name is the centre rounded to a human number (`band109`, `band968`, `band1300`)
 * because a name a user reads in an expression has to be one they can say.
 *
 * At the shipped analyser grid (2048-point FFT at 48 kHz, 23.4 Hz per bin) the lowest band
 * covers ONE bin and the highest 213; the spectrum's own resolution is what it is, and a
 * band narrower than a bin would report that bin twice. The bins each band reads are
 * contiguous and disjoint by construction — `spectrum-bands.test.ts` pins that on the
 * shipped grid.
 *
 * ## Recorded contract (§V352)
 *
 * The edges and the names are part of what a feature track MEANS: a tuned edge would make
 * every recorded track describe a different sound while parsing perfectly. So the table
 * below is pinned by `feature-track.test.ts` and moving it is a versioning event, the same
 * rule the four bands and the detectors live under.
 */
export interface SpectrumBand {
  /** The channel name: `band` + the centre frequency rounded to something sayable. */
  readonly name: SpectrumBandName;
  readonly centreHz: number;
  readonly lowHz: number;
  readonly highHz: number;
}

export const SPECTRUM_BAND_COUNT = 18;
const SPECTRUM_LOW_HZ = 80;
const SPECTRUM_HIGH_HZ = 16000;
/** One band per r-fold of frequency: 200^(1/17). */
const SPECTRUM_RATIO = Math.pow(SPECTRUM_HIGH_HZ / SPECTRUM_LOW_HZ, 1 / (SPECTRUM_BAND_COUNT - 1));

/**
 * The names, spelled out rather than generated: a generated name is one rounding rule away
 * from renaming every channel in every document, and the type system can only see a
 * literal. The centre each one rounds is asserted against the formula in the test.
 */
export const SPECTRUM_BAND_NAMES = [
  "band80",
  "band109",
  "band149",
  "band204",
  "band278",
  "band380",
  "band519",
  "band709",
  "band968",
  "band1300",
  "band1800",
  "band2500",
  "band3400",
  "band4600",
  "band6300",
  "band8600",
  "band11700",
  "band16000",
] as const;

export type SpectrumBandName = (typeof SPECTRUM_BAND_NAMES)[number];

/** The per-band fields of the record, as a type the interface can extend. */
export type AudioSpectrumBands = { readonly [K in SpectrumBandName]: number };

export const AUDIO_SPECTRUM_BANDS: readonly SpectrumBand[] = SPECTRUM_BAND_NAMES.map((name, index) => {
  const centreHz = SPECTRUM_LOW_HZ * Math.pow(SPECTRUM_RATIO, index);
  const half = Math.sqrt(SPECTRUM_RATIO);
  return { name, centreHz, lowHz: centreHz / half, highHz: centreHz * half };
});

/** Every band at 0: what silence reads, and what a fixture starts from. */
export const SILENT_SPECTRUM_BANDS: AudioSpectrumBands = Object.fromEntries(
  SPECTRUM_BAND_NAMES.map((name) => [name, 0]),
) as AudioSpectrumBands;

/** The band fields of a feature bag, by name, for a consumer that wants them as a list. */
export function spectrumBandsOf(features: Pick<AudioFeatures, SpectrumBandName>): readonly number[] {
  return SPECTRUM_BAND_NAMES.map((name) => features[name]);
}
