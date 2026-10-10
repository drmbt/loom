import { describe, expect, it } from "vitest";
import { parseFfglManifest } from "../../../nodes/definitions/ffgl-manifest.ts";
import { crop, decodePng, encodePng, flipRows, pixelOf, sameBytes, testCard } from "./images.ts";
import { parseArenaParameters } from "./resolume-backend.ts";
import { controlParity, controlsOf, maskTo } from "./study.ts";

// VN91 harness, the parts that need no GPU and no Arena.
describe("study images", () => {
  it("round-trips a card through PNG exactly, and the card is asymmetric", () => {
    const card = testCard(64, 36);
    expect(sameBytes(decodePng(encodePng(card)), card)).toBe(true);
    expect(sameBytes(flipRows(card), card)).toBe(false);
    expect(sameBytes(flipRows(flipRows(card)), card)).toBe(true);
    expect(pixelOf(card, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelOf(crop(card, 10, 5, 4, 4), 0, 0)).toEqual(pixelOf(card, 10, 5));
  });
  it("masks to the captured regions only", () => {
    const card = testCard(16, 16);
    const masked = maskTo(card, [{ x: 2, y: 3, width: 4, height: 2 }]);
    expect(pixelOf(masked, 2, 3)).toEqual(pixelOf(card, 2, 3));
    expect(pixelOf(masked, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelOf(masked, 6, 3)).toEqual([0, 0, 0, 0]);
  });
});

// Verbatim from Arena 7.28's clip.get for a clip carrying VignettePlus (2026-10-08).
const ARENA_CLIP = `    Effects (2):
      #1 Transform (id: 1791397374908) [default]
      #2 VignettePlus (id: 1791397379541)
        video/effect2/BlackBG: false [boolean] (parameter: 1791397379530)
        video/effect2/Curve: SineInOut #6 (14 options) [choice] (parameter: 1791397379536)
        video/effect2/Morph: 0.5 (0-10) [range] (parameter: 1791397379532)
        video/effect2/Opacity: 1 (0-1) [range] (parameter: 1791397379543)
        video/effect2/Preset: None #0 (3 options) [choice] (parameter: 1791397379531)
        video/effect2/Ratio: 0.5 (0-1) [range] (parameter: 1791397379529)
        video/effect2/Recall: event [event] (parameter: 1791397379533)`;

describe("Arena's presentation of a plugin", () => {
  it("reads the effect's parameters, without Arena's own effect Opacity", () => {
    const parsed = parseArenaParameters(ARENA_CLIP, "video/effect2/");
    expect(parsed.map(p => [p.name, p.kind])).toEqual([["BlackBG", "boolean"], ["Curve", "choice"], ["Morph", "range"],
      ["Preset", "choice"], ["Ratio", "range"], ["Recall", "event"]]);
    expect(parsed[0]!.path).toBe("video/effect2/BlackBG");
  });

  it("compares controls as hosts present them: label (truncated), kind, range, options", () => {
    const manifest = parseFfglManifest({ format: 1, id: "TOXC", name: "ToxicCRT", version: "1.0", parameters: [
      { index: 0, name: "Gain", type: 10, default: 0.6, range: { min: 0, max: 1 }, elements: [] },
      { index: 1, name: "PaletteA", type: 200, default: 0.3, range: { min: 0, max: 1 }, elements: [] },
      { index: 2, name: "PaletteA_saturation", type: 201, default: 1, range: { min: 0, max: 1 }, elements: [] },
      { index: 3, name: "PaletteA_brightness", type: 202, default: 1, range: { min: 0, max: 1 }, elements: [] },
      { index: 4, name: "PaletteA_alpha", type: 203, default: 1, range: { min: 0, max: 1 }, elements: [] },
      { index: 5, name: "PaletteBase", type: 11, default: 0, range: { min: 0, max: 1 }, elements: [{ name: "A", value: 0 }, { name: "B", value: 1 }] }] });
    const native = controlsOf(manifest);
    expect(native).toEqual([{ label: "Gain", kind: "float", min: 0, max: 1 }, { label: "PaletteA", kind: "color" }, { label: "PaletteBase", kind: "menu", options: 2 }]);
    expect(controlParity(native, native)).toEqual([]);
    expect(controlParity(native, [native[0]!, { label: "PaletteA", kind: "float", min: 0, max: 1 }, native[2]!])).toEqual([
      { index: 1, field: "kind", a: "color", b: "float" }, { index: 1, field: "range", a: [undefined, undefined], b: [0, 1] }]);
    expect(controlParity([{ label: "Person Segmentation", kind: "toggle" }], [{ label: "Person Segmentat", kind: "toggle" }], 16)).toEqual([]);
  });
});
