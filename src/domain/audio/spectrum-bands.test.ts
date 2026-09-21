import { describe, expect, it } from "vitest";

import { AUDIO_SPECTRUM_BANDS, SPECTRUM_BAND_COUNT, SPECTRUM_BAND_NAMES, SILENT_SPECTRUM_BANDS, spectrumBandsOf } from "./spectrum-bands.ts";
import { distinctSpectrumBands } from "./spectrum-bands.fixture.ts";

/**
 * T1347b — the spectrum layout, by its own arithmetic (§V147: exact where exact exists).
 *
 * The table is generated from one formula and the names are typed by hand, so the thing
 * that can silently go wrong is the two disagreeing: a name that says `band709` over a
 * centre that computes to 968. The first test holds each name to its centre. The second
 * holds the layout to the analyser it will be read on: bands that meet edge to edge are
 * only useful if the BINS they read are contiguous and disjoint too, and at 23.4 Hz per
 * bin the lowest band covers exactly one, which is where a gap or an overlap would appear.
 */
describe("T1347b — the eighteen spectrum bands", () => {
  it("run 80 Hz × 200^(k/17): the centres are the formula and each name is its centre, rounded", () => {
    expect(AUDIO_SPECTRUM_BANDS).toHaveLength(SPECTRUM_BAND_COUNT);
    expect(SPECTRUM_BAND_COUNT).toBe(18);
    const ratio = Math.pow(200, 1 / 17);
    AUDIO_SPECTRUM_BANDS.forEach((band, index) => {
      expect(band.centreHz).toBeCloseTo(80 * Math.pow(ratio, index), 9);
      expect(band.lowHz * band.highHz).toBeCloseTo(band.centreHz * band.centreHz, 6);
      // The name rounds the centre to two significant figures above 1 kHz and to the
      // hertz below it — so a reader says "band709" and "band1300", not "band1322".
      const spoken = Number(band.name.slice(4));
      const expected = band.centreHz >= 1000 ? Math.round(band.centreHz / 100) * 100 : Math.round(band.centreHz);
      expect(spoken).toBe(expected);
    });
    expect(AUDIO_SPECTRUM_BANDS[0]!.centreHz).toBe(80);
    expect(AUDIO_SPECTRUM_BANDS[17]!.centreHz).toBeCloseTo(16000, 9);
    // Edges meet: band k's top IS band k+1's bottom.
    for (let index = 1; index < AUDIO_SPECTRUM_BANDS.length; index += 1) {
      expect(AUDIO_SPECTRUM_BANDS[index]!.lowHz).toBeCloseTo(AUDIO_SPECTRUM_BANDS[index - 1]!.highHz, 9);
    }
  });

  it.each([48_000, 44_100])("read contiguous, disjoint bins on a 2048-point FFT at %i Hz — no bin twice, no bin skipped", (sampleRate) => {
    const binHz = sampleRate / 2048;
    const ranges = AUDIO_SPECTRUM_BANDS.map((band) => [Math.ceil(band.lowHz / binHz), Math.floor(band.highHz / binHz)] as const);
    for (const [first, last] of ranges) expect(last).toBeGreaterThanOrEqual(first);
    for (let index = 1; index < ranges.length; index += 1) expect(ranges[index]![0]).toBe(ranges[index - 1]![1] + 1);
    // At 48 kHz the lowest band is ONE bin (bin 3, 70.3 Hz) and the highest 213.
    if (sampleRate === 48_000) {
      expect(ranges[0]).toEqual([3, 3]);
      expect(ranges[17]).toEqual([585, 797]);
    }
  });

  it("names, silence and the list view agree on the order", () => {
    expect(Object.keys(SILENT_SPECTRUM_BANDS)).toEqual([...SPECTRUM_BAND_NAMES]);
    expect(Object.values(SILENT_SPECTRUM_BANDS)).toEqual(new Array(18).fill(0));
    expect(spectrumBandsOf(distinctSpectrumBands(1))).toEqual(SPECTRUM_BAND_NAMES.map((_, index) => 20 + index));
  });
});
