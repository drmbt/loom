import type { FloatMap } from "./float-map.ts";
import { inflateDepthBytes } from "./depth-image-deflate.ts";
import { depthImageEnvelope, depthImageEnvelopeText, depthImageSampleCount,
  restoreDepthImage, unorm16DepthSamples } from "./depth-image-envelope.ts";

const DESCRIPTION_PREFIX = "LoomDepth:";
const MAX_DESCRIPTION_BYTES = 1_048_576 + DESCRIPTION_PREFIX.length + 1;

function invalid(message: string): never {
  throw new Error("Invalid 16-bit depth TIFF: " + message);
}

/** Classic TIFF 6.0: one unsigned scalar strip, numerical samples and ASCII metadata. */
export function encodeDepthTiff(map: FloatMap): Uint8Array {
  const envelope = depthImageEnvelope(map, "unorm16");
  const count = depthImageSampleCount(map.width, map.height);
  const text = depthImageEnvelopeText(envelope).replace(/[\u0080-\uffff]/g,
    character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
  const description = new TextEncoder().encode(DESCRIPTION_PREFIX + text + "\0");
  if (description.length > MAX_DESCRIPTION_BYTES) invalid("ASCII depth metadata exceeds 1 MiB.");
  const tags = [
    [256, 4, map.width], [257, 4, map.height], [258, 3, 16], [259, 3, 1], [262, 3, 1],
    [270, 2, 0], [273, 4, 0], [274, 3, 1], [277, 3, 1], [278, 4, map.height],
    [279, 4, count * 2], [339, 3, 1],
  ] as const;
  const descriptionOffset = 8 + 2 + tags.length * 12 + 4;
  const pixelsOffset = Math.ceil((descriptionOffset + description.length) / 2) * 2;
  const bytes = new Uint8Array(pixelsOffset + count * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, 8, true);
  view.setUint16(8, tags.length, true);
  for (const [index, [tag, type, value]] of tags.entries()) {
    const offset = 10 + index * 12;
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, tag === 270 ? description.length : 1, true);
    if (type === 3) view.setUint16(offset + 8, value, true);
    else view.setUint32(offset + 8, tag === 270 ? descriptionOffset : tag === 273 ? pixelsOffset : value, true);
  }
  // Uint8Array initialization supplies the terminating zero next-IFD pointer.
  bytes.set(description, descriptionOffset);
  const samples = unorm16DepthSamples(map, envelope);
  for (let index = 0; index < count; index++) view.setUint16(pixelsOffset + index * 2, samples[index]!, true);
  return bytes;
}

interface Field {
  readonly type: number;
  readonly count: number;
  readonly inlineOffset: number;
  readonly valueOffset: number;
}

/** Unsigned 16-bit grayscale strips only; no canvas, palettes or colour transfer. */
export async function decodeDepthTiff(bytes: Uint8Array): Promise<FloatMap> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8) invalid("truncated TIFF header.");
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) invalid("unsupported byte-order signature.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) invalid("requires a classic TIFF 6.0 header.");
  const bounds = (offset: number, length: number): void => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 8 || length < 1 ||
      offset + length > bytes.byteLength) invalid("truncated or out-of-bounds field/strip.");
  };
  const ifdOffset = view.getUint32(4, little);
  bounds(ifdOffset, 2);
  const entries = view.getUint16(ifdOffset, little);
  const ifdLength = 2 + entries * 12 + 4;
  bounds(ifdOffset, ifdLength);
  if (view.getUint32(ifdOffset + ifdLength - 4, little) !== 0) invalid("multiple TIFF image directories are unsupported.");
  const fields = new Map<number, Field>();
  for (let index = 0; index < entries; index++) {
    const offset = ifdOffset + 2 + index * 12;
    const tag = view.getUint16(offset, little);
    if (fields.has(tag)) invalid("duplicate TIFF tag " + tag + ".");
    fields.set(tag, { type: view.getUint16(offset + 2, little), count: view.getUint32(offset + 4, little),
      inlineOffset: offset + 8, valueOffset: view.getUint32(offset + 8, little) });
  }
  if ([322, 323, 324, 325].some(tag => fields.has(tag))) invalid("tiled TIFF depth images are unsupported.");
  if (fields.has(330)) invalid("TIFF sub-image directories are unsupported.");
  if (fields.has(338)) invalid("extra TIFF sample channels are unsupported.");
  const metadataRanges: [number, number][] = [[ifdOffset, ifdOffset + ifdLength]];
  const integerField = (tag: number) => {
    const field = fields.get(tag);
    if (!field) invalid("missing TIFF tag " + tag + ".");
    if (![3, 4].includes(field.type) || field.count < 1) invalid("TIFF tag " + tag + " must contain unsigned SHORT/LONG values.");
    const size = field.type === 3 ? 2 : 4;
    const length = field.count * size;
    const offset = length <= 4 ? field.inlineOffset : field.valueOffset;
    bounds(offset, length);
    if (length > 4) metadataRanges.push([offset, offset + length]);
    return { count: field.count, at: (index: number) => size === 2
      ? view.getUint16(offset + index * size, little) : view.getUint32(offset + index * size, little) };
  };
  const scalar = (tag: number, definedDefault?: number): number => {
    if (!fields.has(tag) && definedDefault !== undefined) return definedDefault;
    const field = integerField(tag);
    if (field.count !== 1) invalid("TIFF tag " + tag + " must contain one scalar.");
    return field.at(0);
  };
  const width = scalar(256), height = scalar(257);
  const count = depthImageSampleCount(width, height);
  // These absent-field values are the defaults defined by TIFF 6.0.
  if (scalar(258) !== 16 || scalar(277, 1) !== 1 || scalar(339, 1) !== 1)
    invalid("requires single-channel unsigned 16-bit grayscale samples.");
  const photometric = scalar(262);
  if (photometric !== 0 && photometric !== 1) invalid("requires BlackIsZero or WhiteIsZero grayscale.");
  if (scalar(274, 1) !== 1) invalid("only top-left TIFF orientation is supported.");
  if (scalar(266, 1) !== 1 || scalar(284, 1) !== 1) invalid("unsupported TIFF fill order or planar configuration.");
  const compression = scalar(259, 1);
  if (![1, 8, 32946].includes(compression)) invalid("unsupported TIFF compression; use uncompressed or Deflate.");
  const predictor = scalar(317, 1);
  if (![1, 2].includes(predictor)) invalid("unsupported TIFF predictor.");
  if (predictor === 2 && compression === 1) invalid("horizontal prediction requires Deflate TIFF compression.");
  const rowsPerStrip = scalar(278, 0xffffffff);
  if (rowsPerStrip < 1) invalid("RowsPerStrip must be positive.");
  const stripCount = Math.ceil(height / rowsPerStrip);
  const offsets = integerField(273), lengths = integerField(279);
  if (offsets.count !== stripCount || lengths.count !== stripCount) invalid("strip counts do not match image dimensions.");

  let envelopeText: string | undefined;
  const description = fields.get(270);
  if (description) {
    if (description.type !== 2 || description.count < 1 || description.count > MAX_DESCRIPTION_BYTES)
      invalid("invalid ASCII image description.");
    const offset = description.count <= 4 ? description.inlineOffset : description.valueOffset;
    bounds(offset, description.count);
    if (description.count > 4) metadataRanges.push([offset, offset + description.count]);
    const textBytes = bytes.subarray(offset, offset + description.count);
    if (textBytes[textBytes.length - 1] !== 0 || textBytes.some(value => value > 127))
      invalid("image description must be null-terminated ASCII.");
    const text = new TextDecoder().decode(textBytes.subarray(0, -1));
    if (text.startsWith(DESCRIPTION_PREFIX)) envelopeText = text.slice(DESCRIPTION_PREFIX.length);
  }
  // Validate all locations before allocating the numerical image.
  for (let strip = 0; strip < stripCount; strip++) {
    const offset = offsets.at(strip), length = lengths.at(strip);
    bounds(offset, length);
    if (metadataRanges.some(([start, end]) => offset < end && offset + length > start))
      invalid("TIFF strips overlap directory/metadata storage.");
    const expected = Math.min(rowsPerStrip, height - strip * rowsPerStrip) * width * 2;
    if (compression === 1 && length !== expected) invalid("strip byte count does not match its rows.");
  }
  const samples = new Float32Array(count);
  for (let strip = 0; strip < stripCount; strip++) {
    const rows = Math.min(rowsPerStrip, height - strip * rowsPerStrip);
    const expected = rows * width * 2;
    const offset = offsets.at(strip), length = lengths.at(strip);
    const encoded = bytes.subarray(offset, offset + length);
    const data = compression === 1 ? encoded : await inflateDepthBytes(encoded, expected);
    if (data.byteLength !== expected) invalid("decoded strip length does not match its rows.");
    const pixels = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let row = 0; row < rows; row++) {
      let previous = 0;
      for (let column = 0; column < width; column++) {
        const index = row * width + column;
        const raw = pixels.getUint16(index * 2, little);
        const value = predictor === 2 && column > 0 ? (raw + previous) & 65535 : raw;
        previous = value;
        samples[(strip * rowsPerStrip + row) * width + column] = photometric === 0 ? 1 - value / 65535 : value / 65535;
      }
    }
  }
  return restoreDepthImage(width, height, samples, envelopeText, "unorm16", "tiff16");
}
