export const DEPTH_PALETTES = [
  { id: "grayscale", label: "Grayscale", stops: [[0, 0, 0], [255, 255, 255]] },
  { id: "ocean", label: "Ocean", stops: [[12, 20, 55], [22, 85, 133], [30, 167, 163], [149, 224, 174], [245, 249, 206]] },
  { id: "heat", label: "Heat", stops: [[16, 8, 35], [90, 27, 113], [184, 54, 100], [245, 126, 61], [252, 245, 190]] },
  { id: "spectrum", label: "Spectrum", stops: [[40, 27, 100], [39, 125, 208], [31, 203, 174], [223, 222, 69], [247, 142, 39], [168, 24, 48]] },
] as const;

export type DepthPalette = (typeof DEPTH_PALETTES)[number]["id"];

/** Display-only colour table. Input is already normalized near brightness. */
export function depthPaletteLut(palette: DepthPalette): Uint8ClampedArray {
  const scheme = DEPTH_PALETTES.find(item => item.id === palette);
  if (scheme === undefined) throw new Error(`Unknown depth palette: ${palette}`);
  const table = new Uint8ClampedArray(256 * 3);
  for (let index = 0; index < 256; index++) {
    const position = index / 255 * (scheme.stops.length - 1);
    const segment = Math.min(scheme.stops.length - 2, Math.floor(position));
    const weight = position - segment;
    for (let channel = 0; channel < 3; channel++) {
      const low = scheme.stops[segment]![channel]!;
      const high = scheme.stops[segment + 1]![channel]!;
      table[index * 3 + channel] = Math.round(low + (high - low) * weight);
    }
  }
  return table;
}
