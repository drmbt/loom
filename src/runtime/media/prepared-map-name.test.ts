import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_DEPTH_REFINEMENT, DEFAULT_MARIGOLD_RECIPE, DEFAULT_PHOTO_DEPTH_RECIPE, MARIGOLD_BUNDLE_ID } from "../../domain/media/photo-depth-recipe.ts";
import { FACADE_MASK_DEFAULTS } from "./facade-mask.ts";
import { type FloatMap } from "./float-map.ts";
import { encodeDepthExr } from "./depth-exr.ts";
import { makePreparedMap, withDepthRecipe } from "./prepared-map.ts";
import { preparedMapFilename } from "./prepared-map-name.ts";

function map(kind: "depth" | "mask", modelId = kind === "depth" ? DEFAULT_PHOTO_DEPTH_RECIPE.modelId : "birefnet-lite-dynamic"): FloatMap {
  return makePreparedMap(new Float32Array(8).fill(kind === "mask" ? 1 : 0.5), 4, 2, {
    kind, source: { sha256: "a".repeat(64), width: 4, height: 2 },
    model: { id: modelId, url: "https://models.example/pinned/model.onnx" }, inputSide: kind === "depth" ? 518 : 1024,
    registration: "stretch",
  });
}
const fingerprint = (value: FloatMap) => createHash("sha256").update(encodeDepthExr(value)).digest("hex");
const filename = (value: FloatMap, name = "Facade photo.jpg") => preparedMapFilename(value, name, fingerprint(value));

function nativeMap(seed = DEFAULT_MARIGOLD_RECIPE.seed): FloatMap {
  const prepared = makePreparedMap(new Float32Array(512 * 256).fill(0.5), 512, 256, {
    kind: "depth", source: { sha256: "a".repeat(64), width: 4, height: 2 },
    model: { id: DEFAULT_MARIGOLD_RECIPE.modelId, url: `loom:model-bundle/${MARIGOLD_BUNDLE_ID}` },
    inputSide: 512, registration: "stretch",
  });
  return withDepthRecipe(prepared, { ...DEFAULT_MARIGOLD_RECIPE, seed }, null, "relative-log");
}

describe("prepared artifact filenames", () => {
  it("names native Marigold backend and seed and fingerprints the complete artifact", () => {
    const native = nativeMap();
    const originalBytes = encodeDepthExr(native);
    const originalFingerprint = fingerprint(native);
    expect(filename(native)).toBe(`Facade-photo-depth-marigold-v2-q4-in512-mlx-seed2025-native-${originalFingerprint.slice(0, 12)}.loom.exr`);
    const seeded = nativeMap(2026);
    expect(filename(seeded)).toContain("-mlx-seed2026-native-");
    expect(fingerprint(seeded)).not.toBe(originalFingerprint);
    expect(filename(seeded)).not.toBe(filename(native));
    const corrected = { ...native, values: native.values.slice() };
    corrected.values[31] = 0.5 + 2 ** -24;
    expect(fingerprint(corrected)).not.toBe(originalFingerprint);
    expect(filename(corrected)).toMatch(/^Facade-photo-depth-marigold-v2-q4-in512-mlx-seed2025-native-/);
    expect(filename(corrected)).not.toBe(filename(native));
    expect(encodeDepthExr(native)).toEqual(originalBytes);
  });

  it("names depth model, backend, native detail and stage", () => {
    const native = withDepthRecipe(map("depth", "depth-anything-v2-large-q4f16"), {
      ...DEFAULT_PHOTO_DEPTH_RECIPE, modelId: "depth-anything-v2-large-q4f16", backend: "webgpu",
    });
    expect(filename(native)).toMatch(/^Facade-photo-depth-depth-anything-v2-large-q4f16-in518-webgpu-native-[a-f0-9]{12}\.loom.exr$/);
    expect(filename(native)).toBe(filename(native));
    expect(filename(native)).not.toBe(filename(map("depth")));
  });
  it("distinguishes refined size and smoothing settings without changing source bytes", () => {
    const native = map("depth"), before = encodeDepthExr(native);
    const parent = { sha256: fingerprint(native), width: 4, height: 2 };
    const recipe = { ...DEFAULT_PHOTO_DEPTH_RECIPE, refinement: DEFAULT_DEPTH_REFINEMENT };
    const refined = withDepthRecipe(native, recipe, parent);
    expect(filename(refined)).toContain("refined-4x2-r2-s2-c0p1");
    const changed = withDepthRecipe(native, { ...recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT, colorSigma: 0.2 } }, parent);
    expect(filename(changed)).not.toBe(filename(refined));
    expect(encodeDepthExr(native)).toEqual(before);
  });
  it("names facade detail, opening cutoff and reflective-glass choices", () => {
    const prepared = makePreparedMap(new Float32Array(1536 * 1536).fill(1), 1536, 1536, {
      kind: "mask", source: { sha256: "a".repeat(64), width: 4, height: 2 },
      model: { id: "facade-surfaces-v1", url: "https://models.example/pinned/model.onnx" }, inputSide: 512, registration: "stretch",
    });
    const facade = { ...prepared, metadata: {
      ...prepared.metadata,
      facade: { version: 1, detailSide: 1536, envelopeWidth: 64, envelopeHeight: 64, ...FACADE_MASK_DEFAULTS },
    } };
    expect(filename(facade)).toMatch(/detail1536-open14-feather.*-glass-exclude-/);
    const changed = { ...facade, metadata: { ...facade.metadata, facade: { ...facade.metadata.facade, excludeBlueGlass: false } } };
    expect(filename(changed)).toContain("glass-keep");
    expect(filename(changed)).not.toBe(filename(facade));
  });
  it("distinguishes corrected masks and different source photos even at identical settings", () => {
    const original = map("mask");
    const corrected = { ...original, values: original.values.slice() }; corrected.values[0] = 0;
    expect(filename(corrected)).not.toBe(filename(original));
    const other = makePreparedMap(original.values, 4, 2, {
      kind: "mask", source: { sha256: "b".repeat(64), width: 4, height: 2 },
      model: { id: "birefnet-lite-dynamic", url: "https://models.example/pinned/model.onnx" }, inputSide: 1024, registration: "stretch",
    });
    expect(filename(other)).not.toBe(filename(original));
    expect(original.values[0]).toBe(1);
  });
  it("keeps Unicode names portable and bounded while preserving the distinguishing fingerprint", () => {
    const name = filename(map("mask"), `${"建築".repeat(120)} / ? glass.jpg`);
    expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(255);
    expect(name).not.toMatch(/[/:?]/);
    expect(name).toMatch(/-[a-f0-9]{12}\.loom.exr$/);
  });
  it("labels arbitrary float data explicitly and rejects malformed prepared provenance", () => {
    const raw = { width: 2, height: 1, values: new Float32Array([0, 1]) };
    expect(filename(raw, "samples")).toMatch(/^samples-data-2x1-[a-f0-9]{12}\.loom.exr$/);
    expect(() => preparedMapFilename(map("mask"), "mask", "unknown")).toThrow(/SHA-256/);
    expect(() => preparedMapFilename({ ...raw, metadata: { preparation: { version: 2 } } }, "bad", "a".repeat(64))).toThrow(/Invalid prepared map/);
  });
});
