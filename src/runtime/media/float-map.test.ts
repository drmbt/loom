import { describe, expect, it } from "vitest";
import { validateFloatMap, type FloatMap } from "./float-map.ts";

describe("numerical float map validation", () => {
  it("accepts finite raw depth, signed zero, subnormals and JSON metadata without changing them", () => {
    const values = new Float32Array([0, -0, -4321.75, 1, 1 + 2 ** -23, 2 ** -149, 2 ** 100, 0.000000123]);
    const bits = new Uint32Array(values.buffer).slice();
    const metadata = { model: "depth-v2", crop: [0, 0, 1, 1], settings: { inverted: false, units: null }, note: "relief 🗿" };
    const map = { width: 4, height: 2, values, metadata };
    expect(validateFloatMap(map)).toBe(8);
    expect(new Uint32Array(values.buffer)).toEqual(bits);
    expect(Object.is(values[1], -0)).toBe(true);
    expect(map.metadata).toBe(metadata);
  });

  it("validates nonzero-offset Float32Array views using their actual sample count", () => {
    const values = new Float32Array([99, -0, 0.125, 77]).subarray(1, 3);
    expect(validateFloatMap({ width: 2, height: 1, values })).toBe(2);
    expect(Object.is(values[0], -0)).toBe(true);
    expect(values[1]).toBe(0.125);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 64_000_001, Number.MAX_SAFE_INTEGER])("rejects invalid dimension %s in either axis", dimension => {
    const values = new Float32Array([1]);
    expect(() => validateFloatMap({ width: dimension, height: 1, values })).toThrow(/dimensions/);
    expect(() => validateFloatMap({ width: 1, height: dimension, values })).toThrow(/dimensions/);
  });

  it("enforces the sample budget before inspecting storage and requires exact sample counts", () => {
    expect(() => validateFloatMap({ width: 8001, height: 8000, values: new Float32Array([1]) })).toThrow(/dimensions/);
    expect(() => validateFloatMap({ width: 8000, height: 8000, values: new Float32Array([1]) })).toThrow(/sample count/);
    expect(() => validateFloatMap({ width: 2, height: 1, values: new Float32Array([1]) })).toThrow(/sample count/);
    expect(() => validateFloatMap({ width: 1, height: 1, values: new Float32Array([1, 2]) })).toThrow(/sample count/);
  });

  it.each([new Float64Array([1]), [1], new Uint16Array([1])])("requires Float32Array numerical storage: %j", values => {
    expect(() => validateFloatMap({ width: 1, height: 1, values } as unknown as FloatMap)).toThrow(/sample count/);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite sample %s", value => {
    expect(() => validateFloatMap({ width: 1, height: 1, values: new Float32Array([value]) })).toThrow(/finite/);
  });

  it.each([null, [], "metadata", new Date(0), new Uint8Array([1])])("requires metadata to be a JSON object: %j", metadata => {
    expect(() => validateFloatMap({ width: 1, height: 1, values: new Float32Array([1]), metadata } as unknown as FloatMap))
      .toThrow(/metadata must be a JSON object/);
  });

  it("rejects lossy nested metadata coercions and unsupported JSON values", () => {
    for (const value of [undefined, NaN, Infinity, new Date(0), () => 1, 1n, Symbol("value"), new Uint8Array([1])]) {
      expect(() => validateFloatMap({ width: 1, height: 1, values: new Float32Array([1]), metadata: { nested: { value } } }))
        .toThrow(/metadata/);
    }
  });

  it("rejects object and array cycles while accepting shared noncyclic JSON references", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const array: unknown[] = []; array.push(array);
    for (const metadata of [cycle, { array }]) {
      expect(() => validateFloatMap({ width: 1, height: 1, values: new Float32Array([1]), metadata })).toThrow(/cycles/);
    }
    const shared = { settings: [false, null, 1, "value"] };
    expect(validateFloatMap({ width: 1, height: 1, values: new Float32Array([1]), metadata: { left: shared, right: shared } })).toBe(1);
  });

  it("accepts absent metadata and plain dictionaries with a null prototype", () => {
    const map = { width: 1, height: 1, values: new Float32Array([1]) };
    expect(validateFloatMap(map)).toBe(1);
    const metadata = Object.assign(Object.create(null), { source: "facade", data: [1, null, true] });
    expect(validateFloatMap({ ...map, metadata })).toBe(1);
  });
});
