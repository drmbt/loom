import { deflateSync, inflateSync } from "node:zlib";
import type { StudyImage } from "./types.ts";

/**
 * VN91 inputs. Every image is computed from integers, so every backend and every run gets the
 * same bytes, with nothing read from disk. The card is deliberately asymmetric (a corner mark,
 * left/right and top/bottom ramps) so a flipped or mirrored path cannot pass a comparison.
 */
export function testCard(width: number, height: number, phase = 0): StudyImage {
  const rgba = new Uint8Array(width * height * 4);
  const shift = Math.round(phase * 997);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = (x + shift) % width;
      rgba[i] = Math.floor((u * 255) / Math.max(1, width - 1));
      rgba[i + 1] = Math.floor((y * 255) / Math.max(1, height - 1));
      rgba[i + 2] = ((u >> 3) ^ (y >> 3)) & 1 ? 200 : 40;
      rgba[i + 3] = 255;
      // A bright block in the top-left eighth: orientation is visible at a glance.
      if (x < width / 8 && y < height / 8) { rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; }
    }
  }
  return { width, height, rgba };
}

/** Bottom-first ↔ top-first. */
export function flipRows(image: StudyImage): StudyImage {
  const { width, height, rgba } = image;
  const out = new Uint8Array(rgba.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) out.set(rgba.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return { width, height, rgba: out };
}

export function pixelOf(image: StudyImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return Array.from(image.rgba.subarray(i, i + 4));
}

export function sameBytes(a: StudyImage, b: StudyImage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.rgba.length !== b.rgba.length) return false;
  for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) return false;
  return true;
}

/** FNV-1a over the bytes: a short stable name for a frame in a report. */
export function digest(image: StudyImage): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < image.rgba.length; i++) { hash ^= image.rgba[i]!; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${image.width}x${image.height}:${hash.toString(16).padStart(8, "0")}`;
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** A PNG of the image, for the report. RGBA8, no filtering. */
export function encodePng(image: StudyImage): Uint8Array {
  const { width, height, rgba } = image;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  header[8] = 8; header[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Decodes an 8-bit, non-interlaced RGB/RGBA/grey PNG (what Arena's monitor writes) to RGBA8. */
export function decodePng(bytes: Uint8Array): StudyImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47) throw new Error("Not a PNG");
  let offset = 8, width = 0, height = 0, colour = 0, depth = 0, interlace = 0;
  const data: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0); height = header.getUint32(4); depth = body[8]!; colour = body[9]!; interlace = body[12]!;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : colour === 0 ? 1 : colour === 4 ? 2 : 0;
  if (depth !== 8 || interlace !== 0 || channels === 0) throw new Error(`Unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  const joined = new Uint8Array(data.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of data) { joined.set(part, at); at += part.length; }
  const raw = inflateSync(joined);
  const stride = width * channels, rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[y * stride + x - channels]! : 0, b = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels]! : 0;
      let value = line[x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      rows[y * stride + x] = value & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (channels >= 3) { rgba[i * 4] = rows[s]!; rgba[i * 4 + 1] = rows[s + 1]!; rgba[i * 4 + 2] = rows[s + 2]!; rgba[i * 4 + 3] = channels === 4 ? rows[s + 3]! : 255; }
    else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = rows[s]!; rgba[i * 4 + 3] = channels === 2 ? rows[s + 1]! : 255; }
  }
  return { width, height, rgba };
}

/** The `w`x`h` region of `image` whose top-left is (x, y). */
export function crop(image: StudyImage, x: number, y: number, w: number, h: number): StudyImage {
  const rgba = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) rgba.set(image.rgba.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + w) * 4), row * w * 4);
  return { width: w, height: h, rgba };
}
