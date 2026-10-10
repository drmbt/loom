import { describe, expect, it } from "vitest";
import { linearToSrgb } from "../export/pixel-format.ts";
import { FACADE_MASK_DEFAULTS, facadeMaskSettings, refineFacadeMask, type FacadeMaskSettings } from "./facade-mask.ts";
import { type FloatMap } from "./float-map.ts";
import { decodeDepthExr, encodeDepthExr } from "./depth-exr.ts";
import { makePreparedMap, paintMaskStroke, preparedMetadata } from "./prepared-map.ts";

function envelope(values: number[] = [1], width = values.length, height = 1): FloatMap {
  return makePreparedMap(new Float32Array(values), width, height, {
    kind: "mask", source: { sha256: "a".repeat(64), width: 6512, height: 4096 },
    model: { id: "topformer-ade20k", url: "https://models.example/topformer.onnx" },
    inputSide: 512, registration: "stretch",
  });
}

function photo(colors: readonly (readonly [number, number, number])[], width = colors.length, height = 1) {
  return { width, height, texels: new Float32Array(colors.flatMap(([r, g, b]) => [r, g, b, 1])) };
}

function withFacade(map: FloatMap, patch: Record<string, unknown>): FloatMap {
  return { ...map, metadata: { ...map.metadata, facade: { ...map.metadata!.facade as Record<string, unknown>, ...patch } } };
}

describe("facade surface refinement", () => {
  it("keeps opaque walls while cutting black openings and reflected cyan glass inside the same semantic envelope", () => {
    const reference = photo([[0.8, 0.7, 0.6], [0, 0, 0], [0.08, 0.55, 0.75], [1, 1, 1]]);
    const base = envelope([0.9, 0.9, 0.9, 0]);
    const refined = refineFacadeMask(base, reference);
    expect([...refined.values]).toEqual([Math.fround(0.9), 0, 0, 0]);
    const includingGlass = refineFacadeMask(base, reference, { ...FACADE_MASK_DEFAULTS, excludeBlueGlass: false });
    expect(includingGlass.values[2]).toBe(Math.fround(0.9));
    expect(includingGlass.values[1]).toBe(0);
    expect(includingGlass.values[3]).toBe(0);
  });

  it("feathers dark neutral walls continuously in linear light without binarizing envelope confidence", () => {
    const levels = [0.005, 0.012, 0.018, 0.024, 0.031];
    const reference = photo(levels.map((level) => {
      const srgb = linearToSrgb(level);
      return [srgb, srgb, srgb] as const;
    }));
    const refined = refineFacadeMask(envelope([0.8, 0.8, 0.8, 0.8, 0.8]), reference);
    expect(refined.values[0]).toBe(0);
    expect(refined.values[1]).toBeCloseTo(0.125, 6);
    expect(refined.values[2]).toBeCloseTo(0.4, 6);
    expect(refined.values[3]).toBeCloseTo(0.675, 6);
    expect(refined.values[4]).toBe(Math.fround(0.8));
    const sharp = refineFacadeMask(envelope(), photo([[0.1, 0.1, 0.1], [0.3, 0.3, 0.3]]), {
      ...FACADE_MASK_DEFAULTS, feather: 0,
    });
    expect([...sharp.values]).toEqual([0, 1]);
  });

  it("preserves subpixel gradients, float32 input bits and brush provenance through save/reopen", () => {
    const base = envelope([-0, 0.123456789, 1], 3);
    const baseBits = new Uint32Array(base.values.buffer).slice();
    const reference = photo(Array.from({ length: 9 }, () => [0.8, 0.8, 0.8] as const));
    const photoBits = new Uint32Array(reference.texels.buffer).slice();
    const metadataBefore = JSON.stringify(base.metadata);
    const refined = refineFacadeMask(base, reference);
    expect(refined.values[3]).toBeGreaterThan(0);
    expect(refined.values[3]).toBeLessThan(base.values[1]!);
    expect(refined.values[5]).toBeGreaterThan(base.values[1]!);
    expect(refined.values[5]).toBeLessThan(1);
    const painted = paintMaskStroke(refined, { x: 4, y: 0 }, { x: 4, y: 0 }, 0.25, 1);
    expect(painted.values[4]).toBe(1);
    expect(painted.values[3]).toBe(refined.values[3]);
    const reopened = decodeDepthExr(encodeDepthExr(painted));
    expect(new Uint32Array(reopened.values.buffer)).toEqual(new Uint32Array(painted.values.buffer));
    expect(facadeMaskSettings(reopened)).toEqual(facadeMaskSettings(refined));
    expect(new Uint32Array(base.values.buffer)).toEqual(baseBits);
    expect(new Uint32Array(reference.texels.buffer)).toEqual(photoBits);
    expect(JSON.stringify(base.metadata)).toBe(metadataBefore);
  });

  it("records detailed output separately from the 64-square envelope and 512-square AI input", () => {
    const base = envelope(Array.from({ length: 64 * 64 }, () => 0.75), 64, 64);
    const reference = { width: 1536, height: 1, texels: new Float32Array(1536 * 4).fill(1) };
    const refined = refineFacadeMask(base, reference);
    expect(refined.width).toBe(1536);
    expect(refined.values).toEqual(new Float32Array(1536).fill(0.75));
    expect(preparedMetadata(refined)).toEqual({
      version: 1, kind: "mask", source: preparedMetadata(base).source,
      model: { id: "facade-surfaces-v1", url: preparedMetadata(base).model.url },
      inputSide: 512, registration: "stretch", range: { low: 0, high: 1 },
    });
    expect(facadeMaskSettings(refined)).toEqual({
      version: 1, detailSide: 1536, envelopeWidth: 64, envelopeHeight: 64, ...FACADE_MASK_DEFAULTS,
    });
    expect(encodeDepthExr(refined).length).toBeLessThan(1536 * 4 + 1024);
    expect(facadeMaskSettings(base)).toBeUndefined();
  });

  it.each([
    { darkCutoff: -0.1 }, { darkCutoff: 1.1 }, { darkCutoff: NaN },
    { feather: -0.1 }, { feather: 1.1 }, { feather: Infinity }, { excludeBlueGlass: "true" },
  ])("rejects invalid settings %j without changing the envelope", (patch) => {
    const base = envelope([0.75]);
    expect(() => refineFacadeMask(base, photo([[1, 1, 1]]), { ...FACADE_MASK_DEFAULTS, ...patch } as FacadeMaskSettings)).toThrow(/Invalid facade mask/);
    expect(base.values[0]).toBe(0.75);
  });

  it("rejects invalid photos, non-probability envelopes and depth envelopes", () => {
    const base = envelope();
    const reference = photo([[1, 1, 1]]);
    for (const value of [-0.1, 1.1, NaN, Infinity]) {
      expect(() => refineFacadeMask(base, { ...reference, texels: new Float32Array([value, 1, 1, 1]) })).toThrow(/photo channel/);
    }
    expect(() => refineFacadeMask(base, { ...reference, width: 0 })).toThrow(/positive integer/);
    expect(() => refineFacadeMask(base, { ...reference, width: 1.5 })).toThrow(/positive integer/);
    expect(() => refineFacadeMask(base, { ...reference, width: 8001, height: 8000 })).toThrow(/dimensions/);
    expect(() => refineFacadeMask(base, { ...reference, texels: new Float32Array(3) })).toThrow(/sample count/);
    expect(() => refineFacadeMask({ ...base, values: new Float32Array([1.1]) }, reference)).toThrow(/probabilities/);
    expect(() => refineFacadeMask({ ...base, values: new Float32Array([NaN]) }, reference)).toThrow(/finite/);
    const preparation = preparedMetadata(base);
    const depth = makePreparedMap(new Float32Array([1]), 1, 1, { ...preparation, kind: "depth" });
    expect(() => refineFacadeMask(depth, reference)).toThrow(/envelope must be a prepared mask/);
  });

  it.each([
    { version: 2 }, { detailSide: 2 }, { detailSide: 0 }, { envelopeWidth: 0 }, { envelopeHeight: 1.5 },
    { envelopeWidth: 8001, envelopeHeight: 8000 }, { darkCutoff: NaN }, { feather: -1 },
    { excludeBlueGlass: 1 }, { extra: true },
  ])("rejects corrupt facade recipe %j instead of selecting defaults", (patch) => {
    const refined = refineFacadeMask(envelope(), photo([[1, 1, 1]]));
    expect(() => facadeMaskSettings(withFacade(refined, patch))).toThrow(/Invalid facade mask/);
  });

  it("requires the recipe when importing a recognized facade map", () => {
    const refined = refineFacadeMask(envelope(), photo([[1, 1, 1]]));
    expect(() => facadeMaskSettings({ ...refined, metadata: { preparation: refined.metadata!.preparation } })).toThrow(/facade metadata/);
    const incomplete = { ...refined.metadata!.facade as Record<string, unknown> };
    delete incomplete.feather;
    expect(() => facadeMaskSettings({ ...refined, metadata: { ...refined.metadata, facade: incomplete } })).toThrow(/facade metadata/);
  });
});
