import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pngChunk, PNG_SIGNATURE } from "../export/png.ts";
import { DEFAULT_PHOTO_DEPTH_RECIPE } from "../../domain/media/photo-depth-recipe.ts";
import { makePreparedMap, preparedMetadata, withDepthRecipe } from "./prepared-map.ts";
import { encodeDepthPng, decodeDepthPng } from "./depth-png.ts";
import type { FloatMap } from "./float-map.ts";

function join(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function chunks(bytes: Uint8Array) {
  const result: { type: string; data: Uint8Array }[] = [], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    result.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), data: bytes.slice(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  return result;
}
function externalPng(raw: Uint8Array, width = 3, height = 5, change?: (header: Uint8Array) => void,
  extra: readonly Uint8Array[] = []): Uint8Array {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 16; change?.(header);
  return join([Uint8Array.from(PNG_SIGNATURE), pngChunk("IHDR", header), ...extra,
    pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))]);
}
const filteredRows = Uint8Array.from([
  0, 1, 2, 3, 4, 5, 6,
  1, 1, 2, 4, 6, 4, 8,
  2, 1, 2, 1, 2, 3, 4,
  3, 3, 6, 5, 7, 9, 14,
  4, 4, 8, 10, 14, 20, 28,
]);

describe("numerical grayscale16 PNG interchange", () => {
  it("exports real big-endian 16-bit grayscale with independently inflated precise samples", () => {
    const map: FloatMap = { width: 4, height: 1, values: new Float32Array([0, 0.0001, 0.001, 1]) };
    const original = new Uint32Array(map.values.buffer).slice();
    const parsed = chunks(encodeDepthPng(map));
    expect(parsed.map(chunk => chunk.type)).toEqual(["IHDR", "loDf", "IDAT", "IEND"]);
    const header = parsed[0]!.data;
    expect([...header.slice(8)]).toEqual([16, 0, 0, 0, 0]);
    const raw = inflateSync(parsed.find(chunk => chunk.type === "IDAT")!.data);
    expect(raw[0]).toBe(0);
    expect([...new Uint8Array(raw)]).toEqual([0, 0, 0, 0, 7, 0, 66, 255, 255]);
    expect(raw.readUInt16BE(3)).toBeGreaterThan(0); expect(raw.readUInt16BE(3)).toBeLessThan(257);
    expect(new Uint32Array(map.values.buffer)).toEqual(original);
  });

  it("reads all five independently specified byte filters from a compressed external fixture", async () => {
    const decoded = await decodeDepthPng(externalPng(filteredRows));
    const expected = [258, 772, 1286, 258, 1288, 2320, 516, 1546, 3092, 1032, 2576, 5152, 2064, 5150, 10300];
    expect([decoded.width, decoded.height]).toEqual([3, 5]);
    expect(decoded.metadata).toBeUndefined();
    expect(decoded.values).toEqual(Float32Array.from(expected, value => value / 65535));
  });

  it("decodes negative filter differences and byte overflow at two-byte pixel strides", async () => {
    const raw = Uint8Array.from([1, 255, 250, 1, 9, 0, 254]);
    const decoded = await decodeDepthPng(externalPng(raw, 3, 1));
    expect(decoded.values).toEqual(Float32Array.from([65530, 3, 1], value => value / 65535));
  });

  it("retains signed log-depth range and preparation semantics through its embedded envelope", async () => {
    const map = withDepthRecipe(makePreparedMap(new Float32Array([-3, -2.25, 1]), 3, 1,
      { kind: "depth", source: { sha256: "a".repeat(64), width: 3, height: 1 },
        model: { id: DEFAULT_PHOTO_DEPTH_RECIPE.modelId, url: "https://model.test/depth" }, inputSide: 518, registration: "stretch" }),
    DEFAULT_PHOTO_DEPTH_RECIPE, null, "relative-log");
    const original = new Uint32Array(map.values.buffer).slice();
    const bytes = encodeDepthPng(map), decoded = await decodeDepthPng(bytes);
    expect(preparedMetadata(decoded)).toEqual(preparedMetadata(map));
    expect(decoded.metadata?.interchange).toEqual({ version: 1, format: "png16", encoding: "unorm16" });
    for (let index = 0; index < 3; index++) expect(Math.abs(decoded.values[index]! - map.values[index]!)).toBeLessThanOrEqual(4 / 65535);
    expect(new Uint32Array(map.values.buffer)).toEqual(original);
    const raw = inflateSync(chunks(bytes).find(chunk => chunk.type === "IDAT")!.data);
    expect(raw.readUInt16BE(1)).toBe(65535); expect(raw.readUInt16BE(5)).toBe(0);
  });

  it("round trips constant signed depth without inventing a range", async () => {
    const decoded = await decodeDepthPng(encodeDepthPng({ width: 2, height: 1, values: new Float32Array([-7, -7]) }));
    expect([...decoded.values]).toEqual([-7, -7]);
  });

  it("accepts split consecutive IDAT chunks and harmless ancillary text", async () => {
    const base = chunks(externalPng(filteredRows)), compressed = base[1]!.data;
    const bytes = join([Uint8Array.from(PNG_SIGNATURE), pngChunk("IHDR", base[0]!.data),
      pngChunk("tEXt", new TextEncoder().encode("Author\0Independent reader")),
      pngChunk("IDAT", compressed.slice(0, 5)), pngChunk("IDAT", compressed.slice(5)), pngChunk("IEND", new Uint8Array(0))]);
    expect((await decodeDepthPng(bytes)).values[0]).toBeCloseTo(258 / 65535, 7);
  });

  it("ignores gamma and standard colour instructions while reading the original sixteen-bit codes", async () => {
    const gamma = new Uint8Array(4); new DataView(gamma.buffer).setUint32(0, 45455);
    const tagged = externalPng(filteredRows, 3, 5, undefined, [pngChunk("gAMA", gamma), pngChunk("sRGB", Uint8Array.of(0))]);
    const decoded = await decodeDepthPng(tagged), untagged = await decodeDepthPng(externalPng(filteredRows));
    expect(decoded.values).toEqual(untagged.values);
    expect(decoded.values[0]).toBe(Math.fround(258 / 65535));
    expect(decoded.metadata).toBeUndefined();
    const corrupt = tagged.slice(); corrupt[41] = corrupt[41]! ^ 1;
    await expect(decodeDepthPng(corrupt)).rejects.toThrow(/CRC mismatch in gAMA/);
  });

  it.each(["iCCP", "cHRM", "cICP", "mDCV", "cLLI"])("ignores display-only %s without altering depth", async type => {
    const decoded = await decodeDepthPng(externalPng(filteredRows, 3, 5, undefined, [pngChunk(type, new Uint8Array(4))]));
    expect(decoded.values).toEqual((await decodeDepthPng(externalPng(filteredRows))).values);
  });

  it.each(["tRNS", "acTL", "PLTE"])("refuses unsupported image profile chunk %s", async type => {
    await expect(decodeDepthPng(externalPng(filteredRows, 3, 5, undefined, [pngChunk(type, new Uint8Array(4))]))).rejects.toThrow(/unsupported/);
  });

  it.each(["depth", "channels", "interlace", "compression", "filter"])("rejects unsupported IHDR %s", async setting => {
    const indices: Record<string, number> = { depth: 8, channels: 9, compression: 10, filter: 11, interlace: 12 };
    const bytes = externalPng(filteredRows, 3, 5, header => { header[indices[setting]!] = setting === "depth" ? 8 : 1; });
    await expect(decodeDepthPng(bytes)).rejects.toThrow(/16-bit grayscale|unsupported/);
  });

  it("rejects corrupt CRC, signatures, truncated chunks and bytes after IEND", async () => {
    const bytes = externalPng(filteredRows);
    const crc = bytes.slice(); crc[20] = crc[20]! ^ 1;
    await expect(decodeDepthPng(crc)).rejects.toThrow(/CRC/);
    const signature = bytes.slice(); signature[0] = 0;
    await expect(decodeDepthPng(signature)).rejects.toThrow(/signature/);
    for (const length of [7, 12, 30, bytes.length - 1]) await expect(decodeDepthPng(bytes.slice(0, length))).rejects.toThrow();
    await expect(decodeDepthPng(join([bytes, Uint8Array.of(0)]))).rejects.toThrow(/follow IEND/);
  });

  it("rejects malformed ordering, duplicate metadata, unknown critical chunks and invalid UTF-8", async () => {
    const base = chunks(externalPng(filteredRows));
    const signature = Uint8Array.from(PNG_SIGNATURE), header = pngChunk("IHDR", base[0]!.data), data = pngChunk("IDAT", base[1]!.data), end = pngChunk("IEND", new Uint8Array(0));
    await expect(decodeDepthPng(join([signature, data, header, end]))).rejects.toThrow(/IHDR must be first/);
    await expect(decodeDepthPng(join([signature, header, header, data, end]))).rejects.toThrow(/duplicate/);
    await expect(decodeDepthPng(join([signature, header, data, pngChunk("tEXt", new Uint8Array(0)), data, end]))).rejects.toThrow(/consecutive/);
    await expect(decodeDepthPng(join([signature, header, pngChunk("ABCD", new Uint8Array(0)), data, end]))).rejects.toThrow(/critical chunk/);
    const text = pngChunk("loDf", new TextEncoder().encode("{}"));
    await expect(decodeDepthPng(join([signature, header, text, text, data, end]))).rejects.toThrow(/duplicate/);
    await expect(decodeDepthPng(join([signature, header, pngChunk("loDf", Uint8Array.of(255)), data, end]))).rejects.toThrow(/UTF-8/);
    await expect(decodeDepthPng(join([signature, header, text, data, end]))).rejects.toThrow(/metadata/);
  });

  it("bounds dimensions, envelope bytes and inflated scanlines before publishing samples", async () => {
    await expect(decodeDepthPng(externalPng(Uint8Array.of(0), 64_000_001, 1))).rejects.toThrow(/64 million/);
    await expect(decodeDepthPng(externalPng(Uint8Array.of(0), 0, 1))).rejects.toThrow(/dimensions/);
    await expect(decodeDepthPng(externalPng(new Uint8Array(20), 1, 1))).rejects.toThrow(/decompression exceeds/);
    await expect(decodeDepthPng(externalPng(Uint8Array.of(0, 0), 1, 1))).rejects.toThrow(/sample length/);
    await expect(decodeDepthPng(externalPng(Uint8Array.of(5, 0, 0), 1, 1))).rejects.toThrow(/scanline filter/);
    await expect(decodeDepthPng(externalPng(filteredRows, 3, 5, undefined, [pngChunk("loDf", new Uint8Array(1_048_577))]))).rejects.toThrow(/oversized/);
    expect(() => encodeDepthPng({ width: 1, height: 1, values: new Float32Array([NaN]) })).toThrow(/finite/);
  });
});
