import { pngChunk, PNG_SIGNATURE, zlibStored } from "../export/png.ts";
import { depthImageEnvelope, depthImageEnvelopeText, unorm16DepthSamples,
  depthImageSampleCount, restoreDepthImage } from "./depth-image-envelope.ts";
import { inflateDepthBytes } from "./depth-image-deflate.ts";
import type { FloatMap } from "./float-map.ts";

const ENVELOPE = "loDf";
const MAX_METADATA_BYTES = 1_048_576;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function invalid(reason: string): never { throw new Error(`Invalid numerical depth PNG: ${reason}`); }
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

/** Numerical grayscale16, big-endian samples; colour palettes never enter this encoder. */
export function encodeDepthPng(map: FloatMap): Uint8Array {
  depthImageSampleCount(map.width, map.height);
  const envelope = depthImageEnvelope(map, "unorm16");
  const samples = unorm16DepthSamples(map, envelope);
  const rowBytes = map.width * 2;
  const raw = new Uint8Array((rowBytes + 1) * map.height);
  const pixels = new DataView(raw.buffer);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) pixels.setUint16(y * (rowBytes + 1) + 1 + x * 2, samples[y * map.width + x]!);
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, map.width); header.setUint32(4, map.height);
  ihdr[8] = 16;
  return concatenate([Uint8Array.from(PNG_SIGNATURE), pngChunk("IHDR", ihdr),
    pngChunk(ENVELOPE, new TextEncoder().encode(depthImageEnvelopeText(envelope))),
    pngChunk("IDAT", zlibStored(raw)), pngChunk("IEND", new Uint8Array(0))]);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const a = Math.abs(estimate - left), b = Math.abs(estimate - above), c = Math.abs(estimate - upperLeft);
  return a <= b && a <= c ? left : b <= c ? above : upperLeft;
}

/** Decode bytes directly, supporting all PNG byte filters and standard zlib compression. */
export async function decodeDepthPng(bytes: Uint8Array): Promise<FloatMap> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) invalid("unrecognized signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0;
  let headerSeen = false, imageSeen = false, imageEnded = false, endSeen = false;
  let envelopeText: string | undefined;
  const imageData: Uint8Array[] = [];
  let compressedBytes = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) invalid("truncated chunk");
    const length = view.getUint32(offset);
    if (length > 0x7fffffff || length > bytes.length - offset - 12) invalid("invalid or truncated chunk length");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid("invalid chunk type");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (view.getUint32(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) invalid(`CRC mismatch in ${type}`);
    if (!headerSeen && type !== "IHDR") invalid("IHDR must be first");
    if (imageSeen && type !== "IDAT") imageEnded = true;
    switch (type) {
      case "IHDR": {
        if (headerSeen || length !== 13) invalid("duplicate or malformed IHDR");
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
        depthImageSampleCount(width, height);
        if (data[8] !== 16 || data[9] !== 0) invalid("only 16-bit grayscale without alpha is supported");
        if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) invalid("unsupported compression, filter method or interlace");
        headerSeen = true;
        break;
      }
      case "IDAT":
        if (imageEnded) invalid("IDAT chunks must be consecutive");
        imageSeen = true; imageData.push(data); compressedBytes += data.length;
        if (compressedBytes > (width * 2 + 1) * height + MAX_METADATA_BYTES) invalid("compressed depth exceeds its bounded image profile");
        break;
      case ENVELOPE:
        if (envelopeText !== undefined || length < 1 || length > MAX_METADATA_BYTES) invalid("duplicate or oversized depth metadata");
        try { envelopeText = new TextDecoder("utf-8", { fatal: true }).decode(data); }
        catch { invalid("depth metadata is not valid UTF-8"); }
        break;
      case "IEND":
        if (length !== 0 || !imageSeen) invalid("malformed IEND or missing image data");
        endSeen = true;
        break;
      case "gAMA": case "sRGB": case "iCCP": case "cHRM": case "cICP": case "mDCV": case "cLLI":
        // These are display instructions. Numerical depth reads the original
        // grayscale codes without gamma, ICC or other colour transformation.
        break;
      case "tRNS": case "acTL": case "fcTL": case "fdAT":
        return invalid(`transparency or animation chunk ${type} is unsupported for numerical depth`);
      default:
        if (type[0] === type[0]!.toUpperCase()) invalid(`unsupported critical chunk ${type}`);
    }
    offset += length + 12;
    if (endSeen) { if (offset !== bytes.length) invalid("bytes follow IEND"); break; }
  }
  if (!headerSeen || !endSeen || compressedBytes === 0) invalid("missing header, image data or trailer");
  const rowBytes = width * 2;
  const raw = await inflateDepthBytes(concatenate(imageData), (rowBytes + 1) * height);
  if (raw.length !== (rowBytes + 1) * height) invalid("inflated sample length does not match dimensions");
  const samples = new Float32Array(depthImageSampleCount(width, height));
  let previous = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const start = y * (rowBytes + 1), filter = raw[start]!;
    if (filter > 4) invalid(`unsupported scanline filter ${filter}`);
    for (let x = 0; x < rowBytes; x++) {
      const left = x < 2 ? 0 : current[x - 2]!;
      const above = previous[x]!, upperLeft = x < 2 ? 0 : previous[x - 2]!;
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      current[x] = (raw[start + 1 + x]! + prediction) & 255;
    }
    for (let x = 0; x < width; x++) samples[y * width + x] = (current[x * 2]! * 256 + current[x * 2 + 1]!) / 65535;
    [previous, current] = [current, previous];
  }
  return restoreDepthImage(width, height, samples, envelopeText, "unorm16", "png16");
}
