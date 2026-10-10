import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeDepthTiff, encodeDepthTiff } from "./depth-tiff.ts";

const EXTERNAL_SAMPLES = [0, 1, 65535, 65534, 255, 256, 40000, 3, 2];

/** Independent TIFF fixture: pixels precede its IFD and strips are physically reversed. */
function externalTiff({ little = false, compression = 1, predictor = 1, photometric = 1,
  shortArrays = false, excess = false } = {}): Uint8Array {
  const strips = [EXTERNAL_SAMPLES.slice(0, 6), EXTERNAL_SAMPLES.slice(6)].map((values, strip) => {
    const raw = new Uint8Array(values.length * 2 + (excess && strip === 0 ? 2 : 0));
    const view = new DataView(raw.buffer);
    values.forEach((value, index) => {
      const encoded = predictor === 2 && index % 3 > 0 ? (value - values[index - 1]!) & 65535 : value;
      view.setUint16(index * 2, encoded, little);
    });
    return compression === 1 ? raw : new Uint8Array(deflateSync(raw));
  });
  const stripOffsets = [8 + strips[1]!.length + 3, 8];
  const ifdOffset = Math.ceil((stripOffsets[0]! + strips[0]!.length + 5) / 2) * 2;
  const fields = [
    [256, 3, 3], [257, 3, 3], [258, 3, 16], [259, 3, compression], [262, 3, photometric],
    [266, 3, 1], [273, shortArrays ? 3 : 4, 0], [274, 3, 1], [277, 3, 1],
    [278, 3, 2], [279, shortArrays ? 3 : 4, 0], [284, 3, 1], [317, 3, predictor], [339, 3, 1],
  ];
  const offsetsOffset = ifdOffset + 2 + fields.length * 12 + 4;
  const countsOffset = offsetsOffset + 8;
  const bytes = new Uint8Array(countsOffset + 8);
  const view = new DataView(bytes.buffer);
  bytes.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, little);
  view.setUint32(4, ifdOffset, little);
  strips.forEach((strip, index) => bytes.set(strip, stripOffsets[index]!));
  view.setUint16(ifdOffset, fields.length, little);
  fields.forEach(([tag, type, value], index) => {
    const offset = ifdOffset + 2 + index * 12;
    view.setUint16(offset, tag!, little);
    view.setUint16(offset + 2, type!, little);
    view.setUint32(offset + 4, tag === 273 || tag === 279 ? 2 : 1, little);
    if (tag === 273 || tag === 279) {
      const values = tag === 273 ? stripOffsets : strips.map(strip => strip.length);
      if (shortArrays) values.forEach((item, itemIndex) => view.setUint16(offset + 8 + itemIndex * 2, item, little));
      else {
        const destination = tag === 273 ? offsetsOffset : countsOffset;
        view.setUint32(offset + 8, destination, little);
        values.forEach((item, itemIndex) => view.setUint32(destination + itemIndex * 4, item, little));
      }
    } else view.setUint16(offset + 8, value!, little);
  });
  return bytes;
}

/** Inspect field storage directly rather than using the production reader. */
function field(bytes: Uint8Array, tag: number) {
  const little = bytes[0] === 0x49;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = view.getUint32(4, little);
  for (let index = 0; index < view.getUint16(ifd, little); index++) {
    const entry = ifd + 2 + index * 12;
    if (view.getUint16(entry, little) === tag) {
      const type = view.getUint16(entry + 2, little), count = view.getUint32(entry + 4, little);
      const size = type === 3 ? 2 : type === 4 ? 4 : 1;
      const offset = count * size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      return { view, little, ifd, entry, type, count, offset,
        scalar: () => type === 3 ? view.getUint16(offset, little) : view.getUint32(offset, little) };
    }
  }
  throw new Error("Missing fixture tag " + tag);
}

function scalar(bytes: Uint8Array, tag: number, value: number): Uint8Array {
  const result = bytes.slice(), target = field(result, tag);
  if (target.type === 3) target.view.setUint16(target.offset, value, target.little);
  else target.view.setUint32(target.offset, value, target.little);
  return result;
}

describe("numerical 16-bit depth TIFF", () => {
  it("writes unsigned little-endian scalar words, including distinctions below 8-bit precision", async () => {
    const integers = [0, 1, 2, 255, 256, 257, 32767, 32768, 65535];
    const map = { width: 3, height: 3, values: new Float32Array(integers.map(value => value / 65535)) };
    const bytes = encodeDepthTiff(map);
    expect([...bytes.subarray(0, 8)]).toEqual([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    for (const [tag, expected] of [[256, 3], [257, 3], [258, 16], [259, 1], [262, 1], [274, 1], [277, 1], [278, 3], [279, 18], [339, 1]]) {
      expect(field(bytes, tag!).scalar()).toBe(expected);
    }
    expect(field(bytes, 258)).toMatchObject({ type: 3, count: 1 });
    const offset = field(bytes, 273).scalar(), view = new DataView(bytes.buffer);
    expect(integers.map((_, index) => view.getUint16(offset + index * 2, true))).toEqual(integers);
    expect([...bytes.subarray(offset + 8, offset + 12)]).toEqual([0, 1, 1, 1]);
    const decoded = await decodeDepthTiff(bytes);
    expect(decoded.values).toEqual(map.values);
    expect(decoded.values[1]).not.toBe(decoded.values[2]);
  });

  it("retains signed source range, Unicode metadata and preparation registration in the ASCII envelope", async () => {
    const preparation = { version: 1, kind: "depth", source: { sha256: "a".repeat(64), width: 2, height: 2 },
      model: { id: "fixture", url: "loom:fixture" }, inputSide: 518, registration: "stretch", range: { low: -7, high: 10 } };
    const metadata = { preparation, note: "façade 🗿", controls: { strength: 2 } };
    const map = { width: 2, height: 2, values: new Float32Array([-7, -0.2, 2, 10]), metadata };
    const bytes = encodeDepthTiff(map), description = field(bytes, 270);
    expect(description.type).toBe(2);
    const textBytes = bytes.subarray(description.offset, description.offset + description.count);
    expect(textBytes.every(value => value < 128)).toBe(true);
    expect(textBytes[textBytes.length - 1]).toBe(0);
    const text = new TextDecoder().decode(textBytes.subarray(0, -1));
    expect(text).toContain("LoomDepth:");
    expect(text).toContain("\\u00e7");
    expect(text).toContain("\\ud83d\\uddff");
    const result = await decodeDepthTiff(bytes);
    expect(result.metadata).toEqual({ ...metadata, interchange: { version: 1, format: "tiff16", encoding: "unorm16" } });
    result.values.forEach((value, index) => expect(Math.abs(value - map.values[index]!)).toBeLessThan(17 / 65535));
    expect(map.values).toEqual(new Float32Array([-7, -0.2, 2, 10]));
  });

  it("restores constant depth and respects byte views with nonzero offsets", async () => {
    const bytes = encodeDepthTiff({ width: 2, height: 1, values: new Float32Array([42, 42]) });
    const padded = new Uint8Array(bytes.length + 11);
    padded.set(bytes, 7);
    const result = await decodeDepthTiff(padded.subarray(7, 7 + bytes.length));
    expect(result.values).toEqual(new Float32Array([42, 42]));
  });

  it.each([false, true])("reads independent multi-strip TIFF with endian %s and raw 0..1 values", async little => {
    const result = await decodeDepthTiff(externalTiff({ little }));
    expect(result.width).toBe(3);
    expect(result.height).toBe(3);
    expect(result.metadata).toBeUndefined();
    expect(result.values).toEqual(new Float32Array(EXTERNAL_SAMPLES.map(value => value / 65535)));
  });

  it.each([false, true])("reads inline SHORT strip arrays with endian %s", async little => {
    const result = await decodeDepthTiff(externalTiff({ little, shortArrays: true }));
    expect(result.values).toEqual(new Float32Array(EXTERNAL_SAMPLES.map(value => value / 65535)));
  });

  it("honors WhiteIsZero without applying colour transfer or guessed depth scale", async () => {
    const result = await decodeDepthTiff(externalTiff({ photometric: 0 }));
    expect(result.values).toEqual(new Float32Array(EXTERNAL_SAMPLES.map(value => 1 - value / 65535)));
    expect(result.values[0]).toBe(1);
    expect(result.values[2]).toBe(0);
  });

  it.each([8, 32946])("reads separately compressed Deflate strips with tag %i", async compression => {
    const result = await decodeDepthTiff(externalTiff({ compression }));
    expect(result.values).toEqual(new Float32Array(EXTERNAL_SAMPLES.map(value => value / 65535)));
  });

  it.each([false, true])("reverses 16-bit horizontal prediction with row resets and endian %s", async little => {
    const result = await decodeDepthTiff(externalTiff({ little, compression: 8, predictor: 2 }));
    expect(result.values).toEqual(new Float32Array(EXTERNAL_SAMPLES.map(value => value / 65535)));
  });

  it.each([[258, 8], [277, 3], [339, 2], [339, 3], [262, 2], [274, 6], [266, 2],
    [284, 2], [259, 5], [259, 32773], [317, 3], [317, 2]])("rejects unsupported TIFF tag %i value %i", async (tag, value) => {
    await expect(decodeDepthTiff(scalar(externalTiff(), tag, value))).rejects.toThrow(/TIFF/);
  });

  it("rejects tiles, extra sample channels, duplicate fields and multiple/cyclic directories", async () => {
    for (const replacement of [322, 338, 256]) {
      const bytes = externalTiff(), target = field(bytes, replacement === 256 ? 257 : 339);
      target.view.setUint16(target.entry, replacement, target.little);
      await expect(decodeDepthTiff(bytes)).rejects.toThrow(/tiled|channels|duplicate/);
    }
    const bytes = externalTiff(), target = field(bytes, 256);
    const next = target.ifd + 2 + target.view.getUint16(target.ifd, target.little) * 12;
    target.view.setUint32(next, target.ifd, target.little);
    await expect(decodeDepthTiff(bytes)).rejects.toThrow(/multiple/);
  });

  it("rejects truncated structures, impossible dimensions and malformed strip locations/counts", async () => {
    for (const length of [0, 7]) await expect(decodeDepthTiff(new Uint8Array(length))).rejects.toThrow(/header/);
    const good = externalTiff();
    await expect(decodeDepthTiff(good.subarray(0, good.length - 1))).rejects.toThrow(/bounds|truncated/);
    await expect(decodeDepthTiff(scalar(good, 256, 0))).rejects.toThrow(/dimensions/);
    await expect(decodeDepthTiff(scalar(scalar(good, 256, 65535), 257, 65535))).rejects.toThrow(/dimensions/);
    for (const offset of [0, good.length + 1, field(good, 256).ifd]) {
      const bytes = good.slice(), offsets = field(bytes, 273);
      offsets.view.setUint32(offsets.offset, offset, offsets.little);
      await expect(decodeDepthTiff(bytes)).rejects.toThrow(/bounds|overlap/);
    }
    const short = good.slice(), lengths = field(short, 279);
    lengths.view.setUint32(lengths.offset, 11, lengths.little);
    await expect(decodeDepthTiff(short)).rejects.toThrow(/byte count/);
    const count = good.slice(), offsets = field(count, 273);
    offsets.view.setUint32(offsets.entry + 4, 1, offsets.little);
    await expect(decodeDepthTiff(count)).rejects.toThrow(/strip counts/);
  });

  it("rejects invalid signatures, BigTIFF and corrupt/out-of-bounds image directories", async () => {
    const signature = externalTiff(); signature[0] = 0;
    await expect(decodeDepthTiff(signature)).rejects.toThrow(/signature/);
    const big = externalTiff(), header = new DataView(big.buffer); header.setUint16(2, 43, false);
    await expect(decodeDepthTiff(big)).rejects.toThrow(/classic/);
    for (const offset of [0, big.length - 1, 0xffffffff]) {
      const bytes = externalTiff(); new DataView(bytes.buffer).setUint32(4, offset, false);
      await expect(decodeDepthTiff(bytes)).rejects.toThrow(/bounds|truncated/);
    }
  });

  it("rejects corrupt tagged metadata instead of importing substitute raw depth", async () => {
    const bytes = encodeDepthTiff({ width: 1, height: 1, values: new Float32Array([1]) });
    const description = field(bytes, 270);
    const badAscii = bytes.slice(); badAscii[description.offset] = 255;
    await expect(decodeDepthTiff(badAscii)).rejects.toThrow(/ASCII/);
    const noTerminator = bytes.slice(); noTerminator[description.offset + description.count - 1] = 1;
    await expect(decodeDepthTiff(noTerminator)).rejects.toThrow(/null-terminated/);
    const invalid = bytes.slice(); invalid[description.offset + "LoomDepth:".length] = 0x5b;
    await expect(decodeDepthTiff(invalid)).rejects.toThrow();
    const outside = bytes.slice(); new DataView(outside.buffer).setUint32(description.entry + 8, bytes.length, true);
    await expect(decodeDepthTiff(outside)).rejects.toThrow(/bounds/);
  });

  it("bounds Deflate output and rejects mismatched decoded strips", async () => {
    await expect(decodeDepthTiff(externalTiff({ compression: 8, excess: true }))).rejects.toThrow(/exceeds/);
    const bytes = externalTiff({ compression: 8 }), lengths = field(bytes, 279);
    lengths.view.setUint32(lengths.offset, lengths.view.getUint32(lengths.offset, lengths.little) - 1, lengths.little);
    await expect(decodeDepthTiff(bytes)).rejects.toThrow();
  });

  it.each([null, "not-a-record", ["not-a-record"]])("rejects tagged metadata with a non-object value: %j", async metadata => {
    const bytes = encodeDepthTiff({ width: 1, height: 1, values: new Float32Array([1]),
      metadata: { note: "reserve".repeat(30) } });
    const description = field(bytes, 270);
    const payload = bytes.subarray(description.offset, description.offset + description.count);
    const envelope = JSON.parse(new TextDecoder().decode(payload.subarray("LoomDepth:".length, -1)));
    envelope.metadata = metadata;
    const text = new TextEncoder().encode("LoomDepth:" + JSON.stringify(envelope));
    expect(text.length).toBeLessThan(payload.length);
    payload.fill(0x20, 0, payload.length - 1);
    payload.set(text);
    await expect(decodeDepthTiff(bytes)).rejects.toThrow(/metadata/);
  });

  it("refuses invalid numerical maps before encoding", () => {
    expect(() => encodeDepthTiff({ width: 2, height: 1, values: new Float32Array([1]) })).toThrow(/sample count/);
    expect(() => encodeDepthTiff({ width: 1, height: 1, values: new Float32Array([NaN]) })).toThrow(/finite/);
  });
});
