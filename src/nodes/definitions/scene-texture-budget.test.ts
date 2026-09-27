import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";

/**
 * T1406b — the Render names its SAMPLED-TEXTURE LEDGER when a lit pass goes over the
 * WebGPU baseline of 16.
 *
 * The bug: On Nothing's cars ran out of projectors at about seven. The compiler refused the
 * pass ("binds 17 sampled textures", remedy "composite in stages"), but nothing said that a
 * projector costs TWO (its cookie and its occlusion map), so the shot's author found the
 * arithmetic by hand and merged each car's headlights into one projector.
 *
 * Eight cookie-carrying, occluding projectors are exactly 16 — the legitimate edge the
 * warning must not swallow. Nine are 18: the Render names 9 cookies and 9 occlusion maps and
 * what to turn off, and on a baseline device the compiler's refusal still stands beside it.
 * On a device reporting 32, the pass is legal: the warning stays (the arithmetic is still
 * true), the refusal goes.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const capabilities = (limits: Record<string, number>) =>
  ({
    tier: "B",
    features: [],
    formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
    timestampQuery: false,
    limits: { maxTextureDimension2D: 8192, ...limits },
  }) as never;

function node(id: string, type: string, parameters: Record<string, unknown> = {}, label?: string): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(label === undefined ? {} : { label }) } as never;
}

function projectors(count: number): GraphDocument {
  const throws = Array.from({ length: count }, (_, index) => [
    node(`proj${index}`, "projector", { eye: [index * 0.2, 2, 3], lookAt: [0, 0, 0] }, `proj${index}1`),
  ]).flat();
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
        node("geo", "geometry", { mode: "surface" }, "geo1"),
        node("cam", "camera", { eye: [0, 2, 4], lookAt: [0, 0, 0] }, "cam1"),
        node("key", "light", { kind: "directional" }, "key1"),
        node("cookie", "solid", { color: [1, 1, 1, 1] }, "cookie1"),
        ...throws,
        node(
          "shot",
          "render",
          { scenes: "geo1", camera: "cam1", lights: "key1", projectors: throws.map((entry) => entry.label).join(" ") },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: Object.fromEntries([
      ["e1", { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } }],
      ["e2", { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } }],
      ...throws.map((entry) => [
        `c-${entry.id}`,
        { id: `c-${entry.id}`, source: { nodeId: "cookie", portId: "out" }, target: { nodeId: entry.id, portId: "cookie" } },
      ]),
    ]),
    groups: {},
  } as never;
}

const codes = (count: number, limits: Record<string, number> = {}) => {
  const plan = compileGraph({ graph: projectors(count), settings: SETTINGS, registry, capabilities: capabilities(limits) });
  return {
    ledger: plan.diagnostics.filter((diagnostic) => diagnostic.code === "node.scene.textureBudget"),
    refusals: plan.diagnostics.filter((diagnostic) => diagnostic.code === "compiler/binding-budget"),
  };
};

describe("T1406b: the Render names its sampled-texture ledger", () => {
  it("eight occluding, cookie-carrying projectors are exactly 16: no warning, no refusal", () => {
    const { ledger, refusals } = codes(8);
    expect(ledger).toEqual([]);
    expect(refusals).toEqual([]);
  });

  it("nine are 18: the Render names 9 cookies and 9 occlusion maps and what to turn off; a baseline device refuses", () => {
    const { ledger, refusals } = codes(9);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.severity).toBe("warning");
    expect(ledger[0]?.message).toContain("binds 18 sampled textures (9 projector cookies, 9 projector occlusion maps)");
    expect(ledger[0]?.message).toContain("maxSampledTexturesPerShaderStage");
    expect(ledger[0]?.suggestion).toContain("turn Occlusion off");
    expect(refusals.length).toBeGreaterThan(0);
  });

  it("on a device that reports 32, nine projectors are legal: the ledger stays, the refusal goes", () => {
    const { ledger, refusals } = codes(9, { maxSampledTexturesPerShaderStage: 32 });
    expect(ledger).toHaveLength(1);
    expect(refusals).toEqual([]);
  });
});
