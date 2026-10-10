import type { FloatMap } from "./float-map.ts";
import { inflateDepthBytes } from "./depth-image-deflate.ts";
import { depthImageEnvelope, depthImageEnvelopeText, depthImageSampleCount, restoreDepthImage } from "./depth-image-envelope.ts";

// OpenEXR's regular single-part scanline layout:
// https://openexr.com/en/latest/OpenEXRFileLayout.html
const MAGIC = 20_000_630;
const MAX_HEADER_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(message: string): never { throw new Error(`Invalid depth EXR: ${message}`); }
function unsupported(message: string): never { throw new Error(`Unsupported depth EXR: ${message}`); }

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function attribute(name: string, type: string, value: Uint8Array): Uint8Array {
  const names = encoder.encode(`${name}\0${type}\0`);
  const bytes = new Uint8Array(names.length + 4 + value.length);
  bytes.set(names);
  new DataView(bytes.buffer).setInt32(names.length, value.length, true);
  bytes.set(value, names.length + 4);
  return bytes;
}

function float(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return bytes;
}

function windowBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setInt32(8, width - 1, true);
  view.setInt32(12, height - 1, true);
  return bytes;
}

/** Lossless numerical depth: one FLOAT32 Y channel, no colour conversion or compression. */
export function encodeDepthExr(map: FloatMap): Uint8Array {
  const text = depthImageEnvelopeText(depthImageEnvelope(map, "float32"));
  depthImageSampleCount(map.width, map.height);
  const channels = new Uint8Array(19);
  channels[0] = 0x59; // Y, then a NUL; FLOAT=2, pLinear=0, three reserved zero bytes.
  const channelView = new DataView(channels.buffer);
  channelView.setInt32(2, 2, true);
  channelView.setInt32(10, 1, true);
  channelView.setInt32(14, 1, true);
  const window = windowBytes(map.width, map.height);
  const header = concat([
    attribute("channels", "chlist", channels), attribute("compression", "compression", new Uint8Array([0])),
    attribute("dataWindow", "box2i", window), attribute("displayWindow", "box2i", window),
    attribute("lineOrder", "lineOrder", new Uint8Array([0])), attribute("pixelAspectRatio", "float", float(1)),
    attribute("screenWindowCenter", "v2f", new Uint8Array(8)), attribute("screenWindowWidth", "float", float(1)),
    attribute("loomDepth", "string", encoder.encode(text)), new Uint8Array([0]),
  ]);
  const chunkBytes = 8 + map.width * 4;
  const dataStart = 8 + header.length + map.height * 8;
  const bytes = new Uint8Array(dataStart + map.height * chunkBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  bytes.set(header, 8);
  for (let y = 0; y < map.height; y++) {
    const offset = dataStart + y * chunkBytes;
    view.setBigUint64(8 + header.length + y * 8, BigInt(offset), true);
    view.setInt32(offset, y, true);
    view.setInt32(offset + 4, map.width * 4, true);
    for (let x = 0; x < map.width; x++) view.setFloat32(offset + 8 + x * 4, map.values[y * map.width + x]!, true);
  }
  return bytes;
}

interface Attribute { readonly type: string; readonly bytes: Uint8Array }

function asciiZ(bytes: Uint8Array, position: number, limit: number, maximumName: number): { text: string; next: number } {
  let end = position;
  while (end < limit && bytes[end] !== 0) {
    const value = bytes[end]!;
    if (value < 32 || value > 126 || end - position >= maximumName) invalid("invalid or overlong header/channel name");
    end++;
  }
  if (end >= limit) invalid("unterminated header/channel name");
  return { text: decoder.decode(bytes.subarray(position, end)), next: end + 1 };
}

function readHeader(bytes: Uint8Array, maximumName: number): { attributes: Map<string, Attribute>; next: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const attributes = new Map<string, Attribute>();
  const limit = Math.min(bytes.length, 8 + MAX_HEADER_BYTES);
  let position = 8;
  while (position < limit) {
    const name = asciiZ(bytes, position, limit, maximumName);
    position = name.next;
    if (name.text === "") return { attributes, next: position };
    if (attributes.has(name.text)) invalid(`duplicate ${name.text} attribute`);
    if (attributes.size >= 256) invalid("too many header attributes");
    const type = asciiZ(bytes, position, limit, maximumName);
    position = type.next;
    if (type.text === "" || position + 4 > limit) invalid("truncated attribute header");
    const length = view.getInt32(position, true);
    position += 4;
    if (length < 0 || position + length > limit) invalid("truncated or oversized attribute payload");
    attributes.set(name.text, { type: type.text, bytes: bytes.subarray(position, position + length) });
    position += length;
  }
  invalid("truncated header or header exceeds 2 MiB");
}

function required(attributes: Map<string, Attribute>, name: string, type: string, length?: number): Uint8Array {
  const value = attributes.get(name);
  if (!value || value.type !== type || (length !== undefined && value.bytes.length !== length)) invalid(`missing or malformed ${name} attribute`);
  return value.bytes;
}

function readWindow(bytes: Uint8Array): { minX: number; minY: number; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minX = view.getInt32(0, true), minY = view.getInt32(4, true);
  const width = view.getInt32(8, true) - minX + 1, height = view.getInt32(12, true) - minY + 1;
  if (width < 1 || height < 1) invalid("empty or inverted image window");
  return { minX, minY, width, height };
}

function requireFiniteFloats(bytes: Uint8Array, positive: boolean, name: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let position = 0; position < bytes.length; position += 4) {
    const value = view.getFloat32(position, true);
    if (!Number.isFinite(value) || (positive && value <= 0)) invalid(`invalid ${name} value`);
  }
}

function readChannel(bytes: Uint8Array, maximumName: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = asciiZ(bytes, 0, bytes.length, maximumName);
  if (name.text === "" || name.next + 17 > bytes.length) invalid("malformed channel list");
  const position = name.next;
  if (bytes[position + 16] !== 0 || bytes.length !== position + 17) unsupported("multiple channels; export one FLOAT32 Y, Z or Depth channel");
  if (!["Y", "Z", "Depth"].includes(name.text)) unsupported(`channel ${name.text}; export one FLOAT32 Y, Z or Depth channel`);
  if (view.getInt32(position, true) !== 2) unsupported("channel sample type; export FLOAT32 depth instead of HALF or UINT");
  if (bytes[position + 4]! > 1 || bytes.subarray(position + 5, position + 8).some(value => value !== 0)) invalid("invalid channel flags or reserved bytes");
  if (view.getInt32(position + 8, true) !== 1 || view.getInt32(position + 12, true) !== 1) unsupported("subsampled depth channels");
}

interface ExrProfile {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly minY: number;
  readonly compression: number;
  readonly linesPerChunk: number;
  readonly chunkCount: number;
  readonly table: number;
  readonly dataStart: number;
  readonly text: string | undefined;
}

function readProfile(bytes: Uint8Array, allowZip: boolean): ExrProfile {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) invalid("truncated signature/version");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) invalid("unrecognized OpenEXR signature");
  const version = view.getUint32(4, true);
  if ((version & 0xff) !== 2) unsupported("file version; only OpenEXR version 2 is supported");
  if (version & 0x1000) unsupported("multipart files");
  if (version & 0x800) unsupported("deep data");
  if (version & 0x200) unsupported("tiled images");
  if ((version & ~0x4ff) !== 0) unsupported("unknown file flags");
  const maximumName = version & 0x400 ? 255 : 31;
  const { attributes, next } = readHeader(bytes, maximumName);
  if (attributes.has("tiles")) unsupported("tiled images");
  const type = attributes.get("type");
  if (type && (type.type !== "string" || decoder.decode(type.bytes) !== "scanlineimage")) unsupported("non-scanline image type");
  readChannel(required(attributes, "channels", "chlist"), maximumName);
  const compression = required(attributes, "compression", "compression", 1)[0]!;
  if (compression !== 0 && !(allowZip && (compression === 2 || compression === 3)))
    unsupported(`compression ${compression}; use ${allowZip ? "NONE, ZIPS or ZIP" : "uncompressed"} FLOAT32 scanline depth`);
  const { minY, width, height } = readWindow(required(attributes, "dataWindow", "box2i", 16));
  const count = depthImageSampleCount(width, height);
  readWindow(required(attributes, "displayWindow", "box2i", 16));
  const lineOrder = required(attributes, "lineOrder", "lineOrder", 1)[0]!;
  if (lineOrder > 1) unsupported("random scanline order");
  requireFiniteFloats(required(attributes, "pixelAspectRatio", "float", 4), true, "pixelAspectRatio");
  requireFiniteFloats(required(attributes, "screenWindowCenter", "v2f", 8), false, "screenWindowCenter");
  requireFiniteFloats(required(attributes, "screenWindowWidth", "float", 4), true, "screenWindowWidth");
  const linesPerChunk = compression === 3 ? 16 : 1;
  const chunkCount = Math.ceil(height / linesPerChunk);
  if (attributes.has("chunkCount")) {
    const declaredCount = required(attributes, "chunkCount", "int", 4);
    if (new DataView(declaredCount.buffer, declaredCount.byteOffset, 4).getInt32(0, true) !== chunkCount)
      invalid("scanline chunk count does not match height and compression");
  }
  const envelope = attributes.get("loomDepth");
  if (envelope && envelope.type !== "string") invalid("loomDepth must be a string attribute");
  let text: string | undefined;
  if (envelope) {
    try { text = decoder.decode(envelope.bytes); }
    catch { invalid("loomDepth is not valid UTF-8"); }
  }
  const dataStart = next + chunkCount * 8;
  if (dataStart > bytes.length) invalid("truncated scanline offset table");
  return { bytes, view, width, height, count, minY, compression, linesPerChunk, chunkCount, table: next, dataStart, text };
}

function readChunk(profile: ExrProfile, index: number) {
  const { view, bytes, dataStart, width, height, linesPerChunk, table, minY, compression } = profile;
  const rawOffset = view.getBigUint64(table + index * 8, true);
  if (rawOffset > BigInt(Number.MAX_SAFE_INTEGER)) invalid("scanline offset is not a safe integer");
  const offset = Number(rawOffset);
  if (offset < dataStart || offset + 8 > bytes.length || (compression === 0 && (offset - dataStart) % (8 + width * 4) !== 0))
    invalid("scanline offset is out of bounds or overlaps another chunk");
  const firstRow = index * linesPerChunk;
  // Table order is increasing y even when physical blocks are in decreasing order.
  if (view.getInt32(offset, true) !== minY + firstRow) invalid("scanline y does not match its offset table entry");
  const rows = Math.min(linesPerChunk, height - firstRow);
  const rawBytes = width * rows * 4;
  const packedBytes = view.getInt32(offset + 4, true);
  if (packedBytes < 1 || packedBytes > rawBytes || (compression === 0 && packedBytes !== rawBytes))
    invalid("scanline data size does not match the FLOAT32 channel block");
  const end = offset + 8 + packedBytes;
  if (end > bytes.length) invalid("truncated scanline payload");
  return { offset, firstRow, rawBytes, packedBytes, end, payload: bytes.subarray(offset + 8, end) };
}

/** Validate every table entry and physical block without an object per row or a size guess. */
function validateChunks(profile: ExrProfile): void {
  for (let index = 0; index < profile.chunkCount; index++) readChunk(profile, index);
  let position = profile.dataStart;
  for (let physical = 0; physical < profile.chunkCount; physical++) {
    if (position + 8 > profile.bytes.length) invalid("truncated physical scanline block");
    const firstRow = profile.view.getInt32(position, true) - profile.minY;
    if (firstRow < 0 || firstRow >= profile.height || firstRow % profile.linesPerChunk !== 0)
      invalid("physical scanline y is outside the declared block grid");
    const chunk = readChunk(profile, firstRow / profile.linesPerChunk);
    if (chunk.offset !== position) invalid("scanline offset overlaps another chunk or leaves a gap");
    position = chunk.end;
  }
  if (position !== profile.bytes.length) invalid("scanline payload length does not match dimensions and chunk count");
}

function copySamples(profile: ExrProfile, firstRow: number, bytes: Uint8Array, values: Float32Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const destination = firstRow * profile.width;
  for (let sample = 0; sample < bytes.length / 4; sample++) values[destination + sample] = view.getFloat32(sample * 4, true);
}

function restore(profile: ExrProfile, values: Float32Array): FloatMap {
  return restoreDepthImage(profile.width, profile.height, values, profile.text, "float32", "exr32");
}

function decodeUncompressed(profile: ExrProfile): FloatMap {
  const values = new Float32Array(profile.count);
  for (let index = 0; index < profile.chunkCount; index++) {
    const chunk = readChunk(profile, index);
    copySamples(profile, chunk.firstRow, chunk.payload, values);
  }
  return restore(profile, values);
}

/** Synchronous canonical reader: one FLOAT32 channel with uncompressed scanlines. */
export function decodeDepthExr(bytes: Uint8Array): FloatMap {
  const profile = readProfile(bytes, false);
  validateChunks(profile);
  return decodeUncompressed(profile);
}

/** Import common lossless FLOAT32 EXR files: NONE, ZIPS (one row) and ZIP (16 rows). */
export async function decodeNumericalExr(bytes: Uint8Array): Promise<FloatMap> {
  const profile = readProfile(bytes, true);
  validateChunks(profile);
  if (profile.compression === 0) return decodeUncompressed(profile);
  const values = new Float32Array(profile.count);
  for (let index = 0; index < profile.chunkCount; index++) {
    const chunk = readChunk(profile, index);
    // OpenEXR stores original bytes when ZIP does not reduce a block's size.
    if (chunk.packedBytes === chunk.rawBytes) {
      copySamples(profile, chunk.firstRow, chunk.payload, values);
      continue;
    }
    let predicted: Uint8Array;
    try { predicted = await inflateDepthBytes(chunk.payload, chunk.rawBytes); }
    catch (error) { invalid(`ZIP decompression failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (predicted.length !== chunk.rawBytes) invalid("ZIP decompressed byte count does not match its scanline block");
    // The first predictor byte is literal; reconstruct all following bytes in place.
    // Reference: OpenEXR/src/lib/OpenEXR/ImfZip.cpp, reconstruct_scalar/interleave_scalar.
    for (let byte = 1; byte < predicted.length; byte++) predicted[byte] = (predicted[byte - 1]! + predicted[byte]! - 128) & 255;
    const raw = new Uint8Array(predicted.length), half = Math.ceil(predicted.length / 2);
    for (let byte = 0; byte < raw.length; byte++) raw[byte] = predicted[byte % 2 === 0 ? byte / 2 : half + Math.floor(byte / 2)]!;
    copySamples(profile, chunk.firstRow, raw, values);
  }
  return restore(profile, values);
}
