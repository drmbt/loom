import { describe, expect, it } from "vitest";
import { scratchResourceId } from "../../compiler/resources.ts";
import { NODE_REPRODUCIBILITY } from "../../domain/render/reproducibility.ts";
import { NODE_SIDE_EFFECTS } from "../../domain/render/side-effects.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { allNodeDefinitions } from "./index.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { compileFittedMedia, MEDIA_TEXTURE_KEY, mediaNodeDefinitions, mediaSourceIdFor } from "./media.ts";
import { SCREEN_IN_TYPE, screenInNode } from "./screen-in.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { compileContext, readNodePlan } from "./test-support.ts";

describe("Screen In node contract", () => {
  it("registers separately from automatic media sources with no persisted capture handles", () => {
    expect(validateNodeDefinition(screenInNode)).toEqual([]);
    expect(createNodeRegistry(allNodeDefinitions).get(SCREEN_IN_TYPE)).toBe(screenInNode);
    expect(mediaNodeDefinitions).not.toContain(screenInNode);
    expect(Object.keys(effectiveParameterSchema(screenInNode, {}))).toEqual(["imageFit"]);
    expect(screenInNode.inputs).toEqual([]);
    expect(screenInNode.outputs).toEqual([{ id: "out", label: "Picture", type: RGBA_TEXTURE }]);
    expect(screenInNode.resolutionPolicy).toEqual({ kind: "project" });
    expect(screenInNode.compile).toBe(compileFittedMedia);
  });

  it("uses the existing external media resource and color conversion contract", () => {
    const nodeId = "screen:opaque-id";
    const compiled = screenInNode.compile(compileContext({ nodeId }));
    expect(compiled.scratch).toEqual([{
      key: MEDIA_TEXTURE_KEY,
      kind: "external",
      sourceId: mediaSourceIdFor(nodeId),
      format: "rgba8unorm-srgb",
    }]);
    const read = readNodePlan(compiled.passes, { nodeId, scratch: [MEDIA_TEXTURE_KEY] });
    expect(read.diagnostics).toEqual([]);
    expect(read.passes[0]).toMatchObject({
      kind: "effect",
      nodeId,
      target: "target:out",
      textures: [{ binding: "mediaTexture", resourceId: scratchResourceId(nodeId, MEDIA_TEXTURE_KEY) }],
    });
    expect(structuredClone(compiled)).toEqual(compiled);
  });

  it("creates no resource when its output is not materialized", () => {
    expect(screenInNode.compile(compileContext({ outputs: [] }))).toEqual({ passes: [] });
  });

  it("declares live non-reproducibility without world emission", () => {
    expect(NODE_REPRODUCIBILITY[SCREEN_IN_TYPE]).toBe("external-live");
    expect(NODE_SIDE_EFFECTS[SCREEN_IN_TYPE]).toBe("none");
  });
});
