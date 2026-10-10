import { describe, expect, it } from "vitest";
import { DEFAULT_PHOTO_DEPTH_RECIPE } from "../../domain/media/photo-depth-recipe.ts";
import { type FloatMap } from "./float-map.ts";
import { decodeDepthExr, encodeDepthExr } from "./depth-exr.ts";
import { makePreparedMap, preparedMetadata, withDepthRecipe } from "./prepared-map.ts";
import { createDepthRangeMask, DEFAULT_DEPTH_RANGE, depthRangeMaskSettings, depthRangeSchema, remapDepthValues } from "./depth-tools.ts";

const parentSha256 = "b".repeat(64);
const source = { sha256: "a".repeat(64), width: 8, height: 1 };
function depth(values = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 0.875, 1]): FloatMap {
  return makePreparedMap(new Float32Array(values), values.length, 1, {
    kind: "depth", source, inputSide: 518, registration: "stretch",
    model: { id: DEFAULT_PHOTO_DEPTH_RECIPE.modelId, url: "https://models.example/pinned/depth.onnx" },
  });
}

describe("registered depth range tools", () => {
  it("keeps a full-frame default mask entirely white, including the nearest and farthest samples", () => {
    const native = depth(), before = encodeDepthExr(native);
    const mask = createDepthRangeMask(native, 8, 1, DEFAULT_DEPTH_RANGE, parentSha256);
    expect(mask.values).toEqual(new Float32Array(8).fill(1));
    expect(preparedMetadata(mask)).toMatchObject({ kind: "mask", source, inputSide: 8,
      registration: "stretch", range: { low: 0, high: 1 }, model: { id: "loom-depth-range-mask", url: "loom:depth-range-mask" } });
    expect(depthRangeMaskSettings(mask)).toEqual({ version: 1, ...DEFAULT_DEPTH_RANGE, parentSha256 });
    const reopened = decodeDepthExr(encodeDepthExr(mask));
    expect(depthRangeMaskSettings(reopened)).toEqual(depthRangeMaskSettings(mask));
    expect(reopened.values).toEqual(mask.values);
    expect(encodeDepthExr(native)).toEqual(before);
    mask.values.fill(0);
    expect(encodeDepthExr(native)).toEqual(before);
  });

  it("clips and reranges a working near-bright copy without changing any signed native bits", () => {
    const native = depth([-10, -5, -0, 5, 10]);
    const original = new Uint32Array(native.values.buffer).slice(), before = encodeDepthExr(native);
    const values = remapDepthValues(native, 5, 1, { low: 0.25, high: 0.75, softness: 0 });
    expect(values).toEqual(new Float32Array([0, 0, 0.5, 1, 1]));
    expect(values).not.toBe(native.values);
    values.fill(99);
    expect(new Uint32Array(native.values.buffer)).toEqual(original);
    expect(encodeDepthExr(native)).toEqual(before);
  });

  it("includes both cutoff boundaries in a hard band and rejects samples on either side", () => {
    const mask = createDepthRangeMask(depth(), 8, 1, { low: 0.25, high: 0.75, softness: 0 }, parentSha256);
    expect(mask.values).toEqual(new Float32Array([0, 0, 1, 1, 1, 1, 0, 0]));
  });

  it("feathers both band boundaries smoothly in float32 without 8-bit confidence rounding", () => {
    const settings = { low: 0.25, high: 0.75, softness: 0.125 };
    const values = [0, 0.125, 0.1875, 0.25, 0.3125, 0.375, 0.5, 0.625,
      0.6875, 0.75, 0.8125, 0.875, 1];
    const mask = createDepthRangeMask(depth(values), values.length, 1, settings, parentSha256);
    expect([...mask.values]).toEqual([0, 0, 0.15625, 0.5, 0.84375, 1, 1, 1, 0.84375, 0.5, 0.15625, 0, 0]);
    expect(mask.values[2]! * 255).not.toBe(Math.round(mask.values[2]! * 255));
    expect(mask.values[3]! * 255).not.toBe(Math.round(mask.values[3]! * 255));
  });

  it("does not fade a selected band at full-range endpoints even with softness", () => {
    const native = depth();
    const farEnd = createDepthRangeMask(native, 8, 1, { low: 0, high: 0.75, softness: 0.1 }, parentSha256);
    const nearEnd = createDepthRangeMask(native, 8, 1, { low: 0.25, high: 1, softness: 0.1 }, parentSha256);
    expect(farEnd.values[0]).toBe(1);
    expect(farEnd.values[7]).toBe(0);
    expect(nearEnd.values[0]).toBe(0);
    expect(nearEnd.values[7]).toBe(1);
  });

  it("normalizes signed relative-log depth to the same near-bright convention before remapping or masking", () => {
    const native = withDepthRecipe(depth([-10, 0, 10]), DEFAULT_PHOTO_DEPTH_RECIPE, null, "relative-log");
    const before = encodeDepthExr(native);
    expect(remapDepthValues(native, 3, 1, DEFAULT_DEPTH_RANGE)).toEqual(new Float32Array([1, 0.5, 0]));
    const mask = createDepthRangeMask(native, 3, 1, { low: 0.75, high: 1, softness: 0 }, parentSha256);
    expect(mask.values).toEqual(new Float32Array([1, 0, 0]));
    expect(preparedMetadata(native)).toMatchObject({ semantics: "relative-log", range: { low: -10, high: 10 } });
    expect(encodeDepthExr(native)).toEqual(before);
  });

  it("registers a rectangular source without sampling square-model padding into the derived mask", () => {
    const native = makePreparedMap(new Float32Array([
      -999, -999, -999, -999, -10, -5, 0, 10, -10, -5, 0, 10, 999, 999, 999, 999,
    ]), 4, 4, { kind: "depth", source: { ...source, width: 4, height: 2 },
      inputSide: 518, registration: "letterbox", model: preparedMetadata(depth()).model });
    const mask = createDepthRangeMask(native, 4, 2, { low: 0.25, high: 0.5, softness: 0 }, parentSha256);
    expect([mask.width, mask.height]).toEqual([4, 2]);
    expect(mask.values).toEqual(new Float32Array([0, 1, 1, 0, 0, 1, 1, 0]));
    expect(preparedMetadata(mask)).toMatchObject({ inputSide: 4, registration: "stretch", source: { width: 4, height: 2 } });
  });

  it.each([
    { low: -0.01 }, { low: NaN }, { high: Infinity }, { high: 1.01 }, { high: 0 },
    { low: 0.75, high: 0.5 }, { softness: -0.01 }, { softness: 0.251 }, { softness: NaN }, { extra: true },
  ])("refuses invalid settings %j before deriving a working map", patch => {
    const settings = { ...DEFAULT_DEPTH_RANGE, ...patch };
    expect(() => depthRangeSchema.parse(settings)).toThrow();
    expect(() => remapDepthValues(depth(), 8, 1, settings)).toThrow();
    expect(() => createDepthRangeMask(depth(), 8, 1, settings, parentSha256)).toThrow();
  });

  it("rejects invalid parent identities and output dimensions", () => {
    const native = depth();
    for (const parent of ["", "unknown", "A".repeat(64), "a".repeat(63)]) {
      expect(() => createDepthRangeMask(native, 8, 1, DEFAULT_DEPTH_RANGE, parent)).toThrow(/SHA-256/);
    }
    for (const [width, height] of [[0, 1], [2.5, 1], [8, 0], [64_000_001, 1]]) {
      expect(() => createDepthRangeMask(native, width!, height!, DEFAULT_DEPTH_RANGE, parentSha256)).toThrow(/Invalid prepared map/);
      expect(() => remapDepthValues(native, width!, height!, DEFAULT_DEPTH_RANGE)).toThrow(/Invalid prepared map/);
    }
  });

  it("ignores other valid model identities but refuses malformed recognized mask recipes", () => {
    const mask = createDepthRangeMask(depth(), 8, 1, DEFAULT_DEPTH_RANGE, parentSha256);
    expect(depthRangeMaskSettings(depth())).toBeUndefined();
    for (const depthMask of [undefined, null, [], {}, { version: 2, ...DEFAULT_DEPTH_RANGE, parentSha256 },
      { version: 1, ...DEFAULT_DEPTH_RANGE, parentSha256: "unknown" },
      { version: 1, ...DEFAULT_DEPTH_RANGE, high: 0, parentSha256 },
      { version: 1, ...DEFAULT_DEPTH_RANGE, parentSha256, extra: true }]) {
      expect(() => depthRangeMaskSettings({ ...mask, metadata: { ...mask.metadata, depthMask } })).toThrow(/Invalid depth range mask/);
    }
    const preparation = preparedMetadata(mask);
    expect(() => depthRangeMaskSettings({ ...mask, metadata: { ...mask.metadata,
      preparation: { ...preparation, inputSide: 1 } } })).toThrow(/inputSide/);
    expect(() => depthRangeMaskSettings({ ...mask, metadata: { ...mask.metadata,
      preparation: { ...preparation, model: { ...preparation.model, url: "other" } } } })).toThrow(/identify a depth range mask/);
    expect(() => depthRangeMaskSettings({ ...mask, values: new Float32Array(8).fill(1.1) })).toThrow(/confidence/);
    expect(() => createDepthRangeMask(mask, 8, 1, DEFAULT_DEPTH_RANGE, parentSha256)).toThrow(/source must be a prepared depth/);
  });
});
