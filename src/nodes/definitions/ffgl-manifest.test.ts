import { describe, expect, it } from "vitest";
import { diffFfglTables, ffglControls, parseFfglManifest, type FfglRawParameter } from "./ffgl-manifest.ts";

// Rows as the native host read them from the shipped bundles (VN85 probe, 2026-10-08).
const row = (index: number, name: string, type: number, fallback: number | string, elements: string[] = [], max = 1): FfglRawParameter =>
  ({ index, name, type, default: fallback, range: { min: 0, max }, elements: elements.map((label, value) => ({ name: label, value })) });
const PRESET_BLOCK = (start: number) => [
  row(start, "Preset", 11, 0, ["None", "talk"]), row(start + 1, "Morph", 10, 0.5, [], 10), row(start + 2, "Recall", 1, 0),
  row(start + 3, "Rescan", 1, 0), row(start + 4, "Snap", 0, 0), row(start + 5, "Curve", 11, 6, ["Linear", "QuadIn"]),
];
const VIGNETTE = [row(0, "Size", 10, 0.5), row(1, "Softness", 10, 0.25), row(2, "Roundness", 10, 0.5), row(3, "Ratio", 10, 0.5),
  row(4, "BlackBG", 0, 0), ...PRESET_BLOCK(5)];
const TOXIC = [row(0, "Mix", 10, 1), row(1, "Gain", 10, 0.6), row(2, "PaletteFlip", 1, 0), row(3, "PaletteBase", 11, 0, ["A", "B"]),
  row(4, "PaletteA", 200, 0.36641), row(5, "PaletteA_saturation", 201, 1), row(6, "PaletteA_brightness", 202, 1), row(7, "PaletteA_alpha", 203, 1),
  row(8, "PaletteB", 200, 0.7585), row(9, "PaletteB_saturation", 201, 1), row(10, "PaletteB_brightness", 202, 1), row(11, "PaletteB_alpha", 203, 1)];
const manifest = (parameters: FfglRawParameter[]) => ({ format: 1, id: "VGNP", name: "VignettePlus", version: "1.1", parameters });

describe("FFGL manifest → controls", () => {
  it("keeps the plugin's order, its 0..1 ranges, events as pulses and options as menus of element values", () => {
    const controls = ffglControls(parseFfglManifest(manifest(VIGNETTE)));
    expect(controls.map(c => [c.kind, c.key])).toEqual([
      ["float", "size"], ["float", "softness"], ["float", "roundness"], ["float", "ratio"], ["toggle", "blackBG"],
      ["menu", "preset"], ["float", "morph"], ["pulse", "recall"], ["pulse", "rescan"], ["toggle", "snap"], ["menu", "curve"],
    ]);
    expect(controls[0]).toEqual({ kind: "float", key: "size", label: "Size", index: 0, default: 0.5, min: 0, max: 1 });
    // A range the plugin declares is kept, not normalised away (Morph reports 0..10).
    expect(controls[6]).toMatchObject({ min: 0, max: 10 });
    expect(controls[10]).toEqual({ kind: "menu", key: "curve", label: "Curve", index: 10, default: 6,
      options: [{ label: "Linear", value: 0 }, { label: "QuadIn", value: 1 }] });
  });

  it("folds each HUE/SATURATION/BRIGHTNESS/ALPHA run into ONE colour, as Resolume shows it", () => {
    const controls = ffglControls(parseFfglManifest(manifest(TOXIC)));
    expect(controls.map(c => c.kind)).toEqual(["float", "float", "pulse", "menu", "hsba", "hsba"]);
    expect(controls[4]).toEqual({ kind: "hsba", key: "paletteA", label: "PaletteA", indices: [4, 5, 6, 7], default: [0.36641, 1, 1, 1] });
    expect(controls[5]).toMatchObject({ key: "paletteB", indices: [8, 9, 10, 11] });
    // A lone hue (no quad after it) stays a plain float rather than inventing a colour.
    expect(ffglControls(parseFfglManifest(manifest([row(0, "Hue", 200, 0.2)])))[0]).toMatchObject({ kind: "float", key: "hue" });
  });

  it("never lets a reflected key take a node-owned key or collide with another", () => {
    const controls = ffglControls(parseFfglManifest(manifest([row(0, "Plugin", 10, 0), row(1, "Amount", 10, 0), row(2, "amount", 10, 0), row(3, "3D", 10, 0)])));
    expect(controls.map(c => c.key)).toEqual(["plugin2", "amount", "amount2", "p3D"]);
  });

  it("refuses a malformed manifest with the reason", () => {
    expect(() => parseFfglManifest({ format: 2 })).toThrow(/format 1/);
    expect(() => parseFfglManifest(manifest([row(1, "Size", 10, 0.5)]))).toThrow(/out of order/);
    expect(() => parseFfglManifest({ ...manifest([]), id: "TOOLONG" })).toThrow(/4cc/);
  });
});

describe("FFGL table parity", () => {
  it("reports each field that differs, and compares truncated names when a host truncates", () => {
    expect(diffFfglTables(VIGNETTE, VIGNETTE)).toEqual([]);
    const other = VIGNETTE.map(p => (p.index === 1 ? { ...p, default: 0.3 } : p.index === 2 ? { ...p, type: 0 } : p));
    expect(diffFfglTables(VIGNETTE, other)).toEqual([
      { index: 1, field: "default", a: 0.25, b: 0.3 }, { index: 2, field: "type", a: 10, b: 0 }]);
    expect(diffFfglTables(VIGNETTE, VIGNETTE.slice(0, 5))).toEqual([{ index: -1, field: "count", a: 11, b: 5 }]);
    const long = [row(0, "PaletteA_saturation", 201, 1)], cut = [row(0, "PaletteA_saturat", 201, 1)];
    expect(diffFfglTables(long, cut)).toHaveLength(1);
    expect(diffFfglTables(long, cut, { nameLength: 16 })).toEqual([]);
  });
});
