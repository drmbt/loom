import { describe, expect, it } from "vitest";
import { scratchResourceId } from "../../compiler/resources.ts";
import { validateNodeDefinition } from "../registry/registry.ts";
import { DATA_TEXTURE } from "./common-ports.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { floatMapInNode, FLOAT_MAP_TEXTURE_KEY, floatMapSourceIdFor } from "./float-map-in.ts";
import { compileContext, readNodePlan } from "./test-support.ts";

describe("Float Map In", () => {
  it("declares a data source with float32 storage and project resolution", () => {
    expect(validateNodeDefinition(floatMapInNode)).toEqual([]);
    expect(floatMapInNode.inputs).toEqual([expect.objectContaining({ id: "picture", optional: true })]);
    expect(floatMapInNode.outputs[0]?.type).toEqual(DATA_TEXTURE);
    expect(floatMapInNode.formatPolicy).toEqual({ kind: "fixed", format: "r32float" });
    expect(floatMapInNode.resolutionPolicy).toEqual({ kind: "project" });
  });

  it("compiles an unfiltered numerical blit through the ordinary backend plan", () => {
    const compiled = floatMapInNode.compile(compileContext({ inputs: [] }));
    expect(compiled.scratch).toEqual([{
      key: FLOAT_MAP_TEXTURE_KEY, kind: "external", sourceId: floatMapSourceIdFor("n1"), format: "r32float",
    }]);
    const read = readNodePlan(compiled.passes, { inputs: [], scratch: [FLOAT_MAP_TEXTURE_KEY] });
    expect(read.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    const pass = read.passes[0];
    if (pass?.kind !== "effect") throw new Error("Float Map In did not compile an effect pass");
    expect(pass.textures).toEqual([{
      binding: "floatMapTexture", resourceId: scratchResourceId("n1", FLOAT_MAP_TEXTURE_KEY), sampled: "unfiltered",
    }]);
    expect(pass.samplers).toEqual([]);
    expect(pass.uniforms).toBeUndefined();
    expect(pass.shader).toContain("textureLoad(floatMapTexture, vec2i(position.xy), 0).r");
    expect(pass.shader).not.toMatch(/textureSample|srgb|pow\(/i);
  });

  it("uses stable opaque node identity across sizes and parameter changes", () => {
    const nodeId = "opaque:reference/α";
    for (const resolution of [[640, 480], [1920, 1080]] as const) {
      const compiled = floatMapInNode.compile(compileContext({
        nodeId, resolution, inputs: [], parameters: { interpretation: "depth", inputSide: "644", photo: "asset:photo" },
      }));
      expect(compiled.scratch?.[0]).toMatchObject({ sourceId: `${nodeId}:floatMap`, format: "r32float" });
    }
  });

  it("declares no pass or external source when its output is pruned", () => {
    expect(floatMapInNode.compile(compileContext({ inputs: [], outputs: [] }))).toEqual({ passes: [] });
  });

  it("prepares only on the explicit command pulse", () => {
    const parameters = effectiveParameterSchema(floatMapInNode, {});
    expect(parameters["file"]).toMatchObject({ type: "asset", kind: "binary" });
    expect(parameters["photo"]).toMatchObject({ type: "asset", kind: "image" });
    expect(parameters["interpretation"]).toMatchObject({ type: "enum", default: "raw" });
    expect(parameters["prepare"]).toMatchObject({ type: "pulse", fires: "photoMapping.prepare", input: { nodeIds: ["$node"] } });
    expect(parameters["photo"]?.inactiveWhen?.({ interpretation: "raw" })).toBeTruthy();
    expect(parameters["photo"]?.inactiveWhen?.({ interpretation: "depth" })).toBeNull();
    expect(parameters["photo"]?.inactiveWhen?.({ interpretation: "mask" })).toBeNull();
    expect(parameters["prepare"]?.inactiveWhen?.({ interpretation: "raw" })).toBeTruthy();
    expect(parameters["prepare"]?.inactiveWhen?.({ interpretation: "mask" })).toBeNull();
  });

  it("offers legal depth sizes only for depth preparation", () => {
    const inputSide = effectiveParameterSchema(floatMapInNode, {})["inputSide"];
    if (inputSide?.type !== "enum") throw new Error("Depth input size must be an enum");
    expect(inputSide.default).toBe("518");
    expect(inputSide.options.map(option => option.value)).toEqual(["266", "392", "518", "644", "770", "896", "1036", "1288"]);
    expect(inputSide.options.every(option => Number(option.value) % 14 === 0)).toBe(true);
    expect(inputSide.inactiveWhen?.({ interpretation: "depth" })).toBeNull();
    expect(inputSide.inactiveWhen?.({ interpretation: "mask" })).toBeTruthy();
    expect(inputSide.inactiveWhen?.({ interpretation: "raw" })).toBeTruthy();
  });
});
