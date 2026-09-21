import { SPECTRUM_BAND_NAMES, type AudioSpectrumBands } from "./spectrum-bands.ts";

/**
 * T1347b — a test fixture's eighteen band fields, each a DIFFERENT number (§V461): band k
 * reads `scale × (20 + k)`, so a dropped, crossed or permuted band cannot round-trip. Kept
 * beside the table rather than in the production module, because a production export
 * nobody but tests calls is the "built, never wired" shape this project gates against.
 */
export function distinctSpectrumBands(scale: number): AudioSpectrumBands {
  return Object.fromEntries(SPECTRUM_BAND_NAMES.map((name, index) => [name, scale * (20 + index)])) as AudioSpectrumBands;
}
