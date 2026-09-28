import { describe, expect, it } from "vitest";
import { DEFAULT_MATERIAL, type MaterialPayload } from "../../domain/types/scene.ts";
import { applyMaterialOverrides } from "./material-overrides.ts";

/**
 * T1415b — the override text, read. The Dawn claim (the overridden object's pixel moves and
 * the material's other wearer's does not) is material-wgsl.gpu.test.ts; this pins the
 * grammar and the refusals, each of which would otherwise draw the un-overridden material.
 */
const CODED: MaterialPayload = {
  ...DEFAULT_MATERIAL,
  model: "pbr",
  roughness: 0.5,
  metallic: 0,
  custom: {
    code: "",
    paramsDeclaration: "",
    fields: [
      { name: "jewelRoughness", wgsl: "f32" },
      { name: "heatColor", wgsl: "vec3f" },
    ],
    uniforms: { jewelRoughness: 0.03, heatColor: [1, 1, 1] },
  },
};

const apply = (text: string, material: MaterialPayload = CODED) => applyMaterialOverrides("geo", text, material);

describe("material overrides (T1415b)", () => {
  it("replaces the named values on this object's copy and nothing else", () => {
    const result = apply("roughness = 0.2; metallic=1\njewelRoughness = 0.12\nheatColor = 1, 0.5 0.25");
    if (!("material" in result)) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.material.roughness).toBe(0.2);
    expect(result.material.metallic).toBe(1);
    expect(result.material.custom?.uniforms).toEqual({ jewelRoughness: 0.12, heatColor: [1, 0.5, 0.25] });
    // The material the node published is untouched: another geometry wearing it reads 0.03.
    expect(CODED.custom?.uniforms["jewelRoughness"]).toBe(0.03);
    expect(CODED.roughness).toBe(0.5);
  });

  it("is the material itself when empty", () => {
    const result = apply("  \n ; ");
    expect("material" in result && result.material).toBe(CODED);
  });

  it("refuses an unknown name, a wrong count and a non-number, naming each", () => {
    const result = apply("jewelRoughnes = 0.1; heatColor = 1 0.5; roughness = soft; nonsense");
    if (!("diagnostics" in result)) throw new Error("expected a refusal");
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'Node "geo": the material has no "jewelRoughnes" to override.',
      'Node "geo": material override "heatColor" takes 3 numbers, got 2.',
      'Node "geo": material override "roughness" has a value that is not numbers: "soft".',
      'Node "geo": material override "nonsense" is not "name = value".',
    ]);
    expect(result.diagnostics.every((d) => d.severity === "error" && d.suggestion?.includes("jewelRoughness, heatColor") === true)).toBe(true);
  });

  it("offers a stock material only roughness and metallic", () => {
    const result = apply("jewelRoughness = 0.1", DEFAULT_MATERIAL);
    expect("diagnostics" in result && result.diagnostics[0]?.suggestion).toContain("overrides: roughness, metallic.");
  });
});
