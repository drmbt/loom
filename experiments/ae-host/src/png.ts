// VN121: a minimal PNG decoder for the host's still images (the FX pixel map), on Node's own
// zlib. Outside the browser nothing decodes a picture file, so a Movie File In pointing at a
// PNG rendered black headless; this is the decode `createImageBitmap` does in the app.
//
// Scope, refused by name otherwise: 8-bit truecolour (RGB, colour type 2) or truecolour with
// alpha (RGBA, colour type 6), non-interlaced. That is what `fx-pixel-map-r2.png` is.
//
// The bytes come back exactly as stored: straight alpha, display-encoded, rows top to bottom.
// That is the app's `premultiplyAlpha: "none"` + `colorSpaceConversion: "default"` decode
// (use-media-sources.ts `openStill`): the external texture is rgba8unorm-srgb and the one
// decode to linear happens at sample time. gAMA / cHRM / iCCP are ignored for the same reason.
import { inflateSync } from "node:zlib";

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA8, straight alpha, rows top to bottom, width*height*4 bytes. */
  readonly bytes: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(file: Uint8Array, name = "PNG"): DecodedPng {
  if (file.length < 8 || SIGNATURE.some((b, i) => file[i] !== b)) throw new Error(`${name}: not a PNG (bad signature)`);
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idat: Uint8Array[] = [];
  let at = 8, sawEnd = false;
  while (at + 8 <= file.length) {
    const length = dv.getUint32(at);
    const type = String.fromCharCode(file[at + 4]!, file[at + 5]!, file[at + 6]!, file[at + 7]!);
    const data = file.subarray(at + 8, at + 8 + length);
    if (data.length !== length) throw new Error(`${name}: chunk ${type} is truncated`);
    if (type === "IHDR") {
      width = dv.getUint32(at + 8); height = dv.getUint32(at + 12);
      bitDepth = file[at + 16]!; colorType = file[at + 17]!; interlace = file[at + 20]!;
      if (file[at + 18] !== 0 || file[at + 19] !== 0) throw new Error(`${name}: unknown compression or filter method`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "PLTE" || type === "tRNS") {
      // Only meaningful for palette / greyscale / tRNS-keyed images, which are refused below.
      if (colorType === 3 || type === "tRNS") throw new Error(`${name}: ${type} (palette or colour-key transparency) is not supported`);
    } else if (type === "IEND") { sawEnd = true; break; }
    at += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error(`${name}: no IHDR`);
  if (!sawEnd) throw new Error(`${name}: no IEND (truncated file)`);
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`${name}: ${bitDepth}-bit colour type ${colorType} is not supported; the host decodes 8-bit RGB (2) or RGBA (6) only`);
  }
  if (interlace !== 0) throw new Error(`${name}: interlaced (Adam7) PNGs are not supported`);

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error(`${name}: image data is ${raw.length} bytes, expected ${height * (stride + 1)}`);

  // Unfilter in place, row by row (filters 0..4, bpp = channels).
  const pixels = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let v = line[i]!;
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`${name}: row ${y} has unknown filter type ${filter}`);
      }
      row[i] = v & 255;
    }
    prev = row;
  }
  if (channels === 4) return { width, height, bytes: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) {
    rgba[q] = pixels[p]!; rgba[q + 1] = pixels[p + 1]!; rgba[q + 2] = pixels[p + 2]!; rgba[q + 3] = 255;
  }
  return { width, height, bytes: rgba };
}
