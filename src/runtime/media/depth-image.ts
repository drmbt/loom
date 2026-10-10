import type { FloatMap } from "./float-map.ts";
import { encodeDepthPng, decodeDepthPng } from "./depth-png.ts";
import { encodeDepthTiff, decodeDepthTiff } from "./depth-tiff.ts";
import { encodeDepthExr, decodeNumericalExr } from "./depth-exr.ts";

export const DEPTH_IMAGE_FORMATS = [
  { id: "png16", label: "16-bit PNG", extension: ".png", mime: "image/png" },
  { id: "tiff16", label: "16-bit TIFF", extension: ".tiff", mime: "image/tiff" },
  { id: "exr32", label: "32-bit float EXR", extension: ".exr", mime: "image/x-exr" },
] as const;
export type DepthImageFormat = (typeof DEPTH_IMAGE_FORMATS)[number]["id"];

export function encodeDepthImage(map: FloatMap, format: DepthImageFormat): Uint8Array {
  switch (format) {
    case "png16": return encodeDepthPng(map);
    case "tiff16": return encodeDepthTiff(map);
    case "exr32": return encodeDepthExr(map);
    default: throw new Error(`Unsupported depth image format: ${String(format)}`);
  }
}

/** Signatures select numerical decoders; file extensions and canvas never decide. */
export async function decodeNumericalMap(input: ArrayBuffer | Uint8Array): Promise<FloatMap> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const prefix = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return decodeDepthPng(bytes);
  if (bytes.length >= 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && prefix.getUint16(2, true) === 42) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && prefix.getUint16(2, false) === 42))) return decodeDepthTiff(bytes);
  if (bytes.length >= 8 && prefix.getUint32(0, true) === 20000630) return decodeNumericalExr(bytes);
  throw new Error("Unrecognized numerical map. Use .loom.exr, grayscale 16-bit PNG/TIFF or a single-channel FLOAT EXR.");
}
