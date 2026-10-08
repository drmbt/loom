import { describe, expect, it } from "vitest";
import { scratchResourceId } from "../../compiler/resources.ts";
import { compileContext, inputResourceId, outputResourceId } from "./test-support.ts";
import { FFGL_EVENT_COMMAND, FFGL_INPUT_KEY, FFGL_RESULT_KEY, ffglNode, ffglParameterSchema, ffglSourceIdFor } from "./ffgl.ts";
import { ffglControls, ffglParameterWrites, hsbToRgb, parseFfglManifest, rgbToHsb, type FfglControlValue } from "./ffgl-manifest.ts";

// The tables as the native host read them from the shipped bundles (VN85 probe, 2026-10-08).
const row = (index: number, name: string, type: number, fallback: number | string, elements: string[] = [], range = { min: 0, max: 1 }) =>
  ({ index, name, type, default: fallback, range, elements: elements.map((label, value) => ({ name: label, value })) });
const VIGNETTE = JSON.stringify({ format: 1, id: "VGNP", name: "VignettePlus", version: "1.1", pluginType: 0, parameters: [
  row(0, "Size", 10, 0.5), row(1, "Softness", 10, 0.25), row(2, "Roundness", 10, 0.5), row(3, "Ratio", 10, 0.5), row(4, "BlackBG", 0, 0),
  row(5, "Preset", 11, 0, ["None", "talk", "tonka"]), row(6, "Morph", 10, 0.5, [], { min: 0, max: 10 }), row(7, "Recall", 1, 0)] });
const TOXIC = JSON.stringify({ format: 1, id: "TXCR", name: "ToxicCRT", version: "1.0", parameters: [
  row(0, "Mix", 10, 1), row(1, "PaletteFlip", 1, 0), row(2, "PaletteA", 200, 0.36641), row(3, "PaletteA_saturation", 201, 1),
  row(4, "PaletteA_brightness", 202, 1), row(5, "PaletteA_alpha", 203, 1)] });
const FIGLET = JSON.stringify({ format: 1, id: "FIGT", name: "FigletText", version: "1.4", pluginType: 1, parameters: [row(0, "Text", 100, "HELLO")] });

describe("FFGL node schema (reflected from the stored plugin table)", () => {
  it("has only its own keys until a plugin table is stored", () => {
    expect(Object.keys(ffglParameterSchema({}))).toEqual(["plugin", "manifest", "bpm"]);
    expect(Object.keys(ffglParameterSchema({ manifest: "{not json" }))).toEqual(["plugin", "manifest", "bpm"]);
  });

  it("shows the plugin's parameters in its order: ranges, toggles, menus of element values, events as pulses", () => {
    const schema = ffglParameterSchema({ manifest: VIGNETTE });
    expect(Object.keys(schema)).toEqual(["plugin", "manifest", "bpm", "size", "softness", "roundness", "ratio", "blackBG", "preset", "morph", "recall"]);
    expect(schema["size"]).toMatchObject({ type: "number", default: 0.5, min: 0, max: 1, label: "Size", group: "VignettePlus" });
    expect(schema["morph"]).toMatchObject({ type: "number", min: 0, max: 10 });
    expect(schema["blackBG"]).toMatchObject({ type: "boolean", default: false });
    expect(schema["preset"]).toMatchObject({ type: "enum", default: "0", options: [{ value: "0", label: "None" }, { value: "1", label: "talk" }, { value: "2", label: "tonka" }] });
    // An event is a pulse that fires the native host's event command for THIS node.
    expect(schema["recall"]).toEqual({ type: "pulse", label: "Recall", group: "VignettePlus", fires: FFGL_EVENT_COMMAND, input: { nodeIds: ["$node"], event: "recall" } });
    // The same text yields the same (shared, cached) schema object.
    expect(ffglParameterSchema({ manifest: VIGNETTE })).toBe(schema);
  });

  it("shows an HSBA quad as ONE display colour, the SDK's own HSB→RGB of its default", () => {
    const schema = ffglParameterSchema({ manifest: TOXIC });
    expect(Object.keys(schema)).toEqual(["plugin", "manifest", "bpm", "mix", "paletteFlip", "paletteA"]);
    expect(schema["paletteA"]).toMatchObject({ type: "color", space: "display", default: [...hsbToRgb(0.36641, 1, 1), 1] });
  });

  it("writes a frame's values back as FFGL parameters: a colour as its quad, a menu as its element value", () => {
    const controls = ffglControls(parseFfglManifest(JSON.parse(TOXIC)));
    const [r, g, b] = hsbToRgb(0.36641, 1, 1);
    const writes = ffglParameterWrites(controls, key => ({ mix: 0.25, paletteFlip: true, paletteA: [r, g, b, 0.5] } as Record<string, FfglControlValue>)[key]);
    expect(writes.map(([index]) => index)).toEqual([0, 2, 3, 4, 5]);
    expect(writes[0]).toEqual([0, 0.25]);
    const [, h] = writes[1]!, [, s] = writes[2]!, [, v] = writes[3]!, [, a] = writes[4]!;
    expect([h, s, v, a].map(n => Math.round(Number(n) * 1e5) / 1e5)).toEqual([0.36641, 1, 1, 0.5]);
    expect(rgbToHsb(0.5, 0.5, 0.5)).toEqual([0, 0, 0.5]);
    const menu = ffglControls(parseFfglManifest(JSON.parse(VIGNETTE)));
    expect(ffglParameterWrites(menu, key => (key === "preset" ? "2" : undefined))).toEqual([[5, 2]]);
  });
});

describe("FFGL node compile", () => {
  it("copies its input into its own sRGB target and blits the native result: two passes, two scratch resources", () => {
    const plan = ffglNode.compile(compileContext({ nodeId: "ffgl1", inputs: ["input"], parameters: { plugin: "VignettePlus", manifest: VIGNETTE } }));
    expect(plan.passes.map(pass => (pass as { id: string }).id)).toEqual(["ffgl1:ffgl-input", "ffgl1:ffgl-result"]);
    expect(plan.passes[0]).toMatchObject({ target: scratchResourceId("ffgl1", FFGL_INPUT_KEY), textures: [{ resourceId: inputResourceId("input") }] });
    expect(plan.passes[1]).toMatchObject({ target: outputResourceId("out"), textures: [{ resourceId: scratchResourceId("ffgl1", FFGL_RESULT_KEY) }] });
    expect(plan.scratch).toEqual([
      { key: FFGL_INPUT_KEY, format: "rgba8unorm-srgb" },
      { key: FFGL_RESULT_KEY, kind: "external", sourceId: ffglSourceIdFor("ffgl1"), format: "rgba8unorm-srgb" },
    ]);
  });

  it("asks nothing of the host with no plugin table, or an effect with no input (§V585); a source plugin needs no input", () => {
    expect(ffglNode.compile(compileContext({ inputs: ["input"], parameters: { plugin: "VignettePlus" } })).passes).toEqual([]);
    expect(ffglNode.compile(compileContext({ parameters: { plugin: "VignettePlus", manifest: VIGNETTE } })).passes).toEqual([]);
    const source = ffglNode.compile(compileContext({ nodeId: "fig", parameters: { plugin: "FigletText", manifest: FIGLET } }));
    expect(source.passes.map(pass => (pass as { id: string }).id)).toEqual(["fig:ffgl-result"]);
    expect(source.scratch).toEqual([{ key: FFGL_RESULT_KEY, kind: "external", sourceId: ffglSourceIdFor("fig"), format: "rgba8unorm-srgb" }]);
  });

  it("is desktop macOS only and says so", () => {
    expect(ffglNode.requires).toEqual(["desktop", "macos"]);
  });
});
