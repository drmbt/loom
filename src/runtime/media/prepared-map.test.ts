import { describe, expect, it } from "vitest";
import { decodeFloatMap, encodeFloatMap, type FloatMap } from "./float-map.ts";
import { makePreparedMap, paintMaskStroke, preparedMetadata, rasterizeFloatMap, type PreparedMapMetadata } from "./prepared-map.ts";

function input(kind: "depth" | "mask" = "depth", width = 6, height = 6): Omit<PreparedMapMetadata, "version" | "range"> {
  return {
    kind, source: { sha256: "a".repeat(64), width, height },
    model: { id: "test-model-v1", url: "https://models.example/model.onnx" },
    inputSide: 6, registration: kind === "depth" ? "letterbox" : "stretch",
  };
}

function withMetadata(map: FloatMap, patch: Record<string, unknown>): FloatMap {
  return { ...map, metadata: { preparation: { ...map.metadata!.preparation as Record<string, unknown>, ...patch } } };
}

describe("prepared maps", () => {
  it("keeps native signed float32 bits through preparation, raw sampling and reopening", () => {
    const values = new Float32Array([-0, 1, 1 + 2 ** -23, 1 + 2 ** -22, 2 ** -149, -17.75]);
    const bits = new Uint32Array(values.buffer).slice();
    const map = makePreparedMap(values, 3, 2, { ...input(), registration: "stretch" });
    const reopened = decodeFloatMap(encodeFloatMap(map));
    expect(new Uint32Array(map.values.buffer)).toEqual(bits);
    expect(new Uint32Array(reopened.values.buffer)).toEqual(bits);
    expect(new Uint32Array(rasterizeFloatMap(reopened, "raw", 3, 2).buffer)).toEqual(bits);
    expect(preparedMetadata(reopened)).toEqual(preparedMetadata(map));
    expect(map.values).not.toBe(values);
    values.fill(99);
    expect(new Uint32Array(map.values.buffer)).toEqual(bits);
  });

  it.each(["wide", "tall"] as const)("registers asymmetric %s depth without padding affecting its range or interpolation", (orientation) => {
    const values = new Float32Array(36);
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const across = orientation === "wide" ? x : y;
        const band = orientation === "wide" ? y : x;
        values[y * 6 + x] = band === 0 ? -1000 : band === 5 ? 1000 : across + 10 * band;
      }
    }
    const map = makePreparedMap(values, 6, 6, input("depth", orientation === "wide" ? 4 : 2, orientation === "wide" ? 2 : 4));
    expect(preparedMetadata(map).range).toEqual({ low: 10, high: 45 });
    const samples = rasterizeFloatMap(map, "depth", orientation === "wide" ? 3 : 2, orientation === "wide" ? 2 : 3);
    const expected = orientation === "wide" ? [8, 10, 12, 23, 25, 27] : [8, 23, 10, 25, 12, 27];
    samples.forEach((sample, index) => expect(sample).toBeCloseTo(expected[index]! / 35, 6));
    expect(map.values).toEqual(values);
  });

  it("clamps bilinear sampling to occupied texels instead of bleeding letterbox artefacts", () => {
    const values = new Float32Array(36).fill(900);
    values.set([10, 12, 14, 16, 18, 20], 12);
    values.set([20, 22, 24, 26, 28, 30], 18);
    const map = makePreparedMap(values, 6, 6, input("depth", 3, 1));
    expect(preparedMetadata(map).range).toEqual({ low: 10, high: 30 });
    const samples = rasterizeFloatMap(map, "depth", 30, 30);
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(1);
    expect(Math.min(...samples)).toBe(0);
    expect(Math.max(...samples)).toBe(1);
    const center = rasterizeFloatMap(map, "depth", 3, 1);
    expect([...center]).toEqual([Math.fround(0.3), 0.5, Math.fround(0.7)]);
  });

  it("treats flat depth as the mathematical midpoint without altering the base map", () => {
    const map = makePreparedMap(new Float32Array(4).fill(234.5), 2, 2, input());
    expect(preparedMetadata(map).range).toEqual({ low: 234.5, high: 234.5 });
    expect(rasterizeFloatMap(map, "depth", 3, 4)).toEqual(new Float32Array(12).fill(0.5));
    expect(map.values).toEqual(new Float32Array(4).fill(234.5));
  });

  it("bilinearly resamples raw values and mask confidence without color conversion or normalization", () => {
    const raw = { width: 2, height: 2, values: new Float32Array([-10, 2, 4, 16]) };
    expect([...rasterizeFloatMap(raw, "raw", 1, 1)]).toEqual([3]);
    const mask = makePreparedMap(new Float32Array([0.1, 0.2, 0.3, 0.4]), 2, 2, input("mask"));
    expect(preparedMetadata(mask).range).toEqual({ low: 0, high: 1 });
    expect(rasterizeFloatMap(mask, "mask", 1, 1)[0]).toBeCloseTo(0.25, 7);
    expect(rasterizeFloatMap(mask, "mask", 2, 2)).toEqual(mask.values);
  });

  it("paints a continuous native mask stroke while preserving untouched confidence and provenance", () => {
    const base = new Float32Array(35).fill(0.123456789);
    base[0] = -0;
    const mask = makePreparedMap(base, 7, 5, input("mask", 70, 50));
    const depth = makePreparedMap(new Float32Array([7, 8, 9, 10]), 2, 2, input());
    const depthBits = new Uint32Array(depth.values.buffer).slice();
    const painted = paintMaskStroke(mask, { x: 1, y: 2 }, { x: 5, y: 2 }, 0.6, 1);
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        expect(Object.is(painted.values[y * 7 + x], y === 2 && x >= 1 && x <= 5 ? 1 : base[y * 7 + x])).toBe(true);
      }
    }
    expect(mask.values).toEqual(base);
    expect(preparedMetadata(painted)).toEqual(preparedMetadata(mask));
    expect(new Uint32Array(depth.values.buffer)).toEqual(depthBits);
    const erased = paintMaskStroke(painted, { x: 3, y: 2 }, { x: 3, y: 2 }, 0.5, 0);
    expect(erased.values[17]).toBe(0);
    expect(painted.values[17]).toBe(1);
    expect(erased.values[16]).toBe(1);
    expect(decodeFloatMap(encodeFloatMap(erased)).values).toEqual(erased.values);
  });

  it("clips brushes to the map and fills diagonal strokes without gaps", () => {
    const mask = makePreparedMap(new Float32Array(25), 5, 5, input("mask"));
    const painted = paintMaskStroke(mask, { x: -2, y: -2 }, { x: 6, y: 6 }, 0.2, 1);
    expect([...painted.values]).toEqual([
      1, 0, 0, 0, 0,
      0, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 1, 0,
      0, 0, 0, 0, 1,
    ]);
  });

  it.each([
    { version: 2 }, { kind: "picture" }, { registration: "auto" }, { extra: true },
    { source: { sha256: "unknown", width: 1, height: 1 } },
    { source: { sha256: "a".repeat(64), width: 0, height: 1 } },
    { source: { sha256: "a".repeat(64), width: 1, height: 1, crop: [] } },
    { model: { id: "", url: "model" } }, { model: { id: "model" } },
    { inputSide: 0 }, { inputSide: 1.5 }, { range: { low: NaN, high: 1 } },
    { range: { low: 2, high: 1 } }, { range: { low: 0, high: Infinity } },
  ])("rejects malformed provenance %j", (patch) => {
    const map = makePreparedMap(new Float32Array([1]), 1, 1, input());
    expect(() => preparedMetadata(withMetadata(map, patch))).toThrow(/Invalid prepared map/);
  });

  it("rejects absent provenance, mismatched interpretations and invalid prepared masks", () => {
    const raw = { width: 1, height: 1, values: new Float32Array([1]) };
    const depth = makePreparedMap(raw.values, 1, 1, input());
    expect(() => preparedMetadata(raw)).toThrow(/preparation metadata/);
    expect(() => rasterizeFloatMap(raw, "depth", 1, 1)).toThrow(/preparation metadata/);
    expect(() => rasterizeFloatMap(depth, "mask", 1, 1)).toThrow(/does not match/);
    expect(() => paintMaskStroke(depth, { x: 0, y: 0 }, { x: 0, y: 0 }, 1, 1)).toThrow(/prepared mask/);
    expect(() => makePreparedMap(new Float32Array([-0.1]), 1, 1, input("mask"))).toThrow(/probabilities/);
    expect(() => makePreparedMap(new Float32Array([1.1]), 1, 1, input("mask"))).toThrow(/probabilities/);
    expect(() => makePreparedMap(raw.values, 1, 1, { ...input("mask"), registration: "letterbox" })).toThrow(/mask registration/);
    const mask = makePreparedMap(raw.values, 1, 1, input("mask"));
    expect(() => preparedMetadata(withMetadata(mask, { range: { low: 0.1, high: 1 } }))).toThrow(/mask range/);
  });

  it("rejects nonfinite samples, invalid dimensions and bands too narrow to represent", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => makePreparedMap(new Float32Array([value]), 1, 1, input())).toThrow(/finite/);
    }
    expect(() => makePreparedMap(new Float32Array([1]), 0, 1, input())).toThrow(/positive integer/);
    expect(() => makePreparedMap(new Float32Array([1]), 2, 1, input())).toThrow(/sample count/);
    expect(() => makePreparedMap(new Float32Array([1]), 8001, 8000, input())).toThrow(/dimensions/);
    expect(() => makePreparedMap(new Float32Array(4), 2, 2, input("depth", 1000, 1))).toThrow(/no native samples/);
    const map = makePreparedMap(new Float32Array([1]), 1, 1, input());
    expect(() => rasterizeFloatMap(map, "raw", 0, 1)).toThrow(/positive integer/);
    expect(() => rasterizeFloatMap({ ...map, values: new Float32Array([NaN]) }, "raw", 1, 1)).toThrow(/finite/);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid brush radius %s", (radius) => {
    const map = makePreparedMap(new Float32Array([0.5]), 1, 1, input("mask"));
    expect(() => paintMaskStroke(map, { x: 0, y: 0 }, { x: 0, y: 0 }, radius, 1)).toThrow(/brush|finite/);
    expect(map.values[0]).toBe(0.5);
  });

  it("rejects nonfinite brush coordinates, overflow and invalid paint values", () => {
    const map = makePreparedMap(new Float32Array([0.5]), 1, 1, input("mask"));
    expect(() => paintMaskStroke(map, { x: NaN, y: 0 }, { x: 0, y: 0 }, 1, 1)).toThrow(/finite/);
    expect(() => paintMaskStroke(map, { x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 0 }, 1, 1)).toThrow(/brush length/);
    expect(() => paintMaskStroke(map, { x: 0, y: 0 }, { x: 0, y: 0 }, 1, 0.5 as 0)).toThrow(/brush value/);
    expect(map.values[0]).toBe(0.5);
  });
});
