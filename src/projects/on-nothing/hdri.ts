import { readFileSync } from "node:fs";

/**
 * T1407b — node-only: a Radiance `.hdr` equirect (Poly Haven's CC0 HDRIs), decoded to linear
 * float and packed RGBM into RGBA8 bytes so it rides the ordinary 8-bit picture path (the app
 * refuses float pictures today). The environment pass decodes rgb × a × RGBM_RANGE.
 */

export const RGBM_RANGE = 16;

export interface Hdri {
  readonly width: number;
  readonly height: number;
  /** Linear rgb, row-major, top row first. */
  readonly rgb: Float32Array;
}

export function readHdr(path: string): Hdri {
  const bytes = new Uint8Array(readFileSync(path));
  let at = 0;
  const line = (): string => {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    const text = new TextDecoder().decode(bytes.subarray(at, end));
    at = end + 1;
    return text;
  };
  if (!line().startsWith("#?")) throw new Error(`${path}: not a Radiance HDR file.`);
  for (;;) {
    const header = line();
    if (header === "") break;
    if (header.startsWith("FORMAT=") && header !== "FORMAT=32-bit_rle_rgbe") throw new Error(`${path}: unsupported ${header}.`);
  }
  const size = /^-Y (\d+) \+X (\d+)$/.exec(line());
  if (size === null) throw new Error(`${path}: only -Y H +X W orientation is supported.`);
  const height = Number(size[1]);
  const width = Number(size[2]);
  const rgb = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (bytes[at] === 2 && bytes[at + 1] === 2 && ((bytes[at + 2]! << 8) | bytes[at + 3]!) === width && width >= 8 && width < 32768) {
      at += 4;
      for (let channel = 0; channel < 4; channel++) {
        let x = 0;
        while (x < width) {
          let count = bytes[at++]!;
          if (count > 128) {
            count -= 128;
            const value = bytes[at++]!;
            for (let k = 0; k < count; k++) scan[(x++) * 4 + channel] = value;
          } else {
            for (let k = 0; k < count; k++) scan[(x++) * 4 + channel] = bytes[at++]!;
          }
        }
      }
    } else {
      scan.set(bytes.subarray(at, at + width * 4));
      at += width * 4;
    }
    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3]!;
      const f = e === 0 ? 0 : Math.pow(2, e - 136);
      const o = (y * width + x) * 3;
      rgb[o] = scan[x * 4]! * f;
      rgb[o + 1] = scan[x * 4 + 1]! * f;
      rgb[o + 2] = scan[x * 4 + 2]! * f;
    }
  }
  return { width, height, rgb };
}

/** Resample (bilinear, wrapping in x) to `size` and pack RGBM: rgb = byte.rgb/255 × byte.a/255 × RGBM_RANGE. */
export function rgbmBytes(hdri: Hdri, size: readonly [number, number]): Uint8Array {
  const [w, h] = size;
  const out = new Uint8Array(w * h * 4);
  const sample = (u: number, v: number, channel: number): number => {
    const x = u * hdri.width - 0.5;
    const y = Math.min(Math.max(v * hdri.height - 0.5, 0), hdri.height - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (xx: number, yy: number): number => {
      const wx = ((xx % hdri.width) + hdri.width) % hdri.width;
      const wy = Math.min(Math.max(yy, 0), hdri.height - 1);
      return hdri.rgb[(wy * hdri.width + wx) * 3 + channel]!;
    };
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / h;
      const r = sample(u, v, 0) / RGBM_RANGE;
      const g = sample(u, v, 1) / RGBM_RANGE;
      const b = sample(u, v, 2) / RGBM_RANGE;
      const m = Math.min(1, Math.max(r, g, b, 1e-6));
      const a = Math.ceil(m * 255) / 255;
      const o = (y * w + x) * 4;
      out[o] = Math.round(Math.min(1, r / a) * 255);
      out[o + 1] = Math.round(Math.min(1, g / a) * 255);
      out[o + 2] = Math.round(Math.min(1, b / a) * 255);
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}
