import { describe, expect, it } from "vitest";
import { decodeFloatMap, encodeFloatMap, FLOAT_MAP_EXTENSION, FLOAT_MAP_MIME_TYPE } from "./float-map.ts";

/** Independent file construction exercises the reader separately from the writer. */
function file(header: unknown, samples: number[] = [1]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(16 + json.length + samples.length * 4);
  bytes.set([0x4c, 0x4f, 0x4f, 0x4d, 0x46, 0x33, 0x32, 0]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 1, true);
  view.setUint32(12, json.length, true);
  bytes.set(json, 16);
  samples.forEach((value, index) => view.setFloat32(16 + json.length + index * 4, value, true));
  return bytes;
}

describe("float map", () => {
  it("preserves raw depth bits, scale, sign, subnormals and metadata", () => {
    const values = new Float32Array([0, -0, -4321.75, 1, 1 + 2 ** -23, 2 ** -149, 2 ** 100, 0.000000123]);
    const metadata = { model: "depth-v2", source: "sculpture", crop: [0, 0, 1, 1], settings: { inverted: false, units: null }, note: "relief 🗿" };
    const bytes = encodeFloatMap({ width: 4, height: 2, values, metadata });
    const result = decodeFloatMap(bytes);
    expect(result.width).toBe(4);
    expect(result.height).toBe(2);
    expect(result.metadata).toEqual(metadata);
    expect(new Uint32Array(result.values.buffer)).toEqual(new Uint32Array(values.buffer));
    expect(Object.is(result.values[1], -0)).toBe(true);
    expect(FLOAT_MAP_EXTENSION).toBe(".loomf32");
    expect(FLOAT_MAP_MIME_TYPE).toBe("application/x-loom-f32");
  });

  it("writes little-endian samples and reads independently constructed bytes", () => {
    const bytes = encodeFloatMap({ width: 1, height: 1, values: new Float32Array([1]) });
    expect([...bytes.subarray(-4)]).toEqual([0, 0, 0x80, 0x3f]);
    expect([...bytes.subarray(8, 12)]).toEqual([1, 0, 0, 0]);
    expect(decodeFloatMap(file({ width: 2, height: 1 }, [-10.25, 300.5])).values).toEqual(new Float32Array([-10.25, 300.5]));
    expect(decodeFloatMap(bytes.buffer as ArrayBuffer).metadata).toBeUndefined();
  });

  it("respects input and sample views with nonzero offsets", () => {
    const samples = new Float32Array([99, -0, 0.125, 77]);
    const bytes = encodeFloatMap({ width: 2, height: 1, values: samples.subarray(1, 3) });
    const padded = new Uint8Array(bytes.length + 13);
    padded.fill(255);
    padded.set(bytes, 7);
    const result = decodeFloatMap(padded.subarray(7, 7 + bytes.length));
    expect(Object.is(result.values[0], -0)).toBe(true);
    expect(result.values[1]).toBe(0.125);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 64_000_001, Number.MAX_SAFE_INTEGER])("rejects invalid dimension %s on encode and decode", (width) => {
    expect(() => encodeFloatMap({ width, height: 1, values: new Float32Array([1]) })).toThrow(/dimensions/);
    expect(() => decodeFloatMap(file({ width, height: 1 }))).toThrow(/dimensions/);
  });

  it("rejects excessive sample counts before allocation and mismatched arrays", () => {
    expect(() => decodeFloatMap(file({ width: 8001, height: 8000 }))).toThrow(/dimensions/);
    expect(() => encodeFloatMap({ width: 2, height: 1, values: new Float32Array([1]) })).toThrow(/sample count/);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite sample %s on both paths", (sample) => {
    expect(() => encodeFloatMap({ width: 1, height: 1, values: new Float32Array([sample]) })).toThrow(/finite/);
    expect(() => decodeFloatMap(file({ width: 1, height: 1 }, [sample]))).toThrow(/finite/);
  });

  it("rejects truncation, trailing bytes, signatures, versions and header lengths", () => {
    const good = file({ width: 1, height: 1 });
    for (const length of [0, 7, 15, 16, good.length - 1]) {
      expect(() => decodeFloatMap(good.subarray(0, length))).toThrow(/Invalid float map/);
    }
    const trailing = new Uint8Array(good.length + 1);
    trailing.set(good);
    expect(() => decodeFloatMap(trailing)).toThrow(/payload length/);
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(() => decodeFloatMap(badMagic)).toThrow(/signature/);
    const badVersion = good.slice();
    new DataView(badVersion.buffer).setUint32(8, 2, true);
    expect(() => decodeFloatMap(badVersion)).toThrow(/version/);
    for (const length of [0, 1_048_577, 0xffffffff]) {
      const badHeaderLength = good.slice();
      new DataView(badHeaderLength.buffer).setUint32(12, length, true);
      expect(() => decodeFloatMap(badHeaderLength)).toThrow(/header length/);
    }
  });

  it.each([null, [], {}, { width: 1 }, { height: 1 }, { width: 1, height: 1, channels: 4 }, { width: 1, height: 1, metadata: [] }, { width: 1, height: 1, metadata: null }])("rejects malformed header %j", (header) => {
    expect(() => decodeFloatMap(file(header))).toThrow(/Invalid float map/);
  });

  it("rejects malformed JSON and invalid UTF-8", () => {
    for (const firstByte of [0x21, 0xff]) {
      const bytes = file({ width: 1, height: 1 });
      bytes[16] = firstByte;
      expect(() => decodeFloatMap(bytes)).toThrow(/UTF-8 JSON/);
    }
  });

  it("rejects lossy metadata coercions and cycles", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const metadata of [{ invalid: undefined }, { invalid: NaN }, { invalid: new Date() }, { invalid: () => 1 }, cycle]) {
      expect(() => encodeFloatMap({ width: 1, height: 1, values: new Float32Array([1]), metadata })).toThrow(/metadata/);
    }
  });
});
