import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { geometryNode } from "./scene.ts";
import { identityMatrix, normalMatrix, objectMatrix } from "../../domain/geometry/transform.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";

/**
 * T1588b — the object Transform on a Geometry, at the definition (no GPU): what it says
 * about itself, where it refuses, and that ONE matrix reaches every pass a Render emits.
 * What the matrix does to a picture is `object-transform.gpu.test.ts`'s claim, on Dawn.
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

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label }) as never;

/** A grid worn by one geometry, under a casting light, with every G-buffer layer on. */
function graph(geometry: Record<string, unknown>): GraphDocument {
  const nodes = [
    node("grid", "pointGrid", { cols: 4, rows: 4 }, "grid_points"),
    node("geo", "geometry", geometry, "geometry_object"),
    node("cam", "camera", {}, "camera_lens"),
    node("key", "light", { shadows: true }, "light_key"),
    node("shot", "render", { scenes: "geometry_object", camera: "camera_lens", lights: "light_key", normalOutput: true, albedoOutput: true, shadowOutput: true, depthOutput: true }, "render_shot"),
    node("out", "output", {}, "output_main"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

const compile = (document: GraphDocument) =>
  compileGraph({
    graph: document,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: ["normal", "albedo", "shadow", "depth"].map((portId) => ({ nodeId: "shot", portId, kind: "preview" as const })),
  } as never);

/** The plan's draws, each under the id its node gave it (the plan prefixes `<node>#`). */
const drawsOf = (compiled: { passes: ReadonlyArray<unknown> }): DrawPassDescriptor[] =>
  (compiled.passes as DrawPassDescriptor[]).filter((pass) => pass.kind === "draw").map((pass) => ({ ...pass, id: pass.id.slice(pass.id.indexOf("#") + 1) }));

const TRANSFORM = { translate: [1, 2, 3], rotate: [10, 20, 30], objectScale: [2, 1, 0.5], pivot: [0.5, 0, 0] };

describe("the object Transform on a Geometry (T1588b)", () => {
  it("composes scale, then turn, then translate, about the pivot", () => {
    // p ↦ translate + pivot + R · (S ∘ (p − pivot)), checked on the parts a person can do by hand.
    const apply = (matrix: number[], [x, y, z]: number[]): number[] =>
      [0, 1, 2].map((row) => matrix[row]! * x! + matrix[4 + row]! * y! + matrix[8 + row]! * z! + matrix[12 + row]!);
    const close = (actual: number[], expected: number[]): void => actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 12));
    const base = { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] } as const;

    expect(objectMatrix(base)).toEqual(identityMatrix());
    // A positive turn about +Z carries +X to +Y; about +X, +Y to +Z; about +Y, +Z to +X.
    close(apply(objectMatrix({ ...base, rotate: [0, 0, 90] }), [1, 0, 0]), [0, 1, 0]);
    close(apply(objectMatrix({ ...base, rotate: [90, 0, 0] }), [0, 1, 0]), [0, 0, 1]);
    close(apply(objectMatrix({ ...base, rotate: [0, 90, 0] }), [0, 0, 1]), [1, 0, 0]);
    // X first: +Y goes to +Z, and the Z turn leaves it there.
    close(apply(objectMatrix({ ...base, rotate: [90, 0, 90] }), [0, 1, 0]), [0, 0, 1]);
    // Scale before the turn: (1, 0, 0) doubled, then turned to +Y.
    close(apply(objectMatrix({ ...base, scale: [2, 1, 1], rotate: [0, 0, 90] }), [1, 0, 0]), [0, 2, 0]);
    // The pivot stays put under scale and turn; the translate moves it.
    close(apply(objectMatrix({ translate: [5, 0, 0], rotate: [0, 0, 90], scale: [3, 3, 3], pivot: [1, 2, 3] }), [1, 2, 3]), [6, 2, 3]);
  });

  it("turns normals by the inverse transpose's direction, whatever the scale", () => {
    expect(normalMatrix(identityMatrix())).toEqual(identityMatrix());
    const turn = (matrix: number[], [x, y, z]: number[]): number[] => [0, 1, 2].map((row) => matrix[row]! * x! + matrix[4 + row]! * y! + matrix[8 + row]! * z!);
    // Stretched 4× along X, a 45° slope's normal (1, 1, 0) leans toward Y: (1/4, 1, 0) in direction.
    const stretched = turn(normalMatrix(objectMatrix({ translate: [0, 0, 0], rotate: [0, 0, 0], scale: [4, 1, 1], pivot: [0, 0, 0] })), [1, 1, 0]);
    expect(stretched[0]! / stretched[1]!).toBeCloseTo(0.25, 12);
    // A thousandth of the size hands the shader a normal of ordinary length, not a millionth.
    const tiny = turn(normalMatrix(objectMatrix({ translate: [0, 0, 0], rotate: [0, 0, 0], scale: [0.001, 0.001, 0.001], pivot: [0, 0, 0] })), [0, 0, 1]);
    expect(tiny).toEqual([0, 0, 1]);
    // Mirrored in X, a +X normal still points out of the surface it was authored on: −X.
    const mirrored = turn(normalMatrix(objectMatrix({ translate: [0, 0, 0], rotate: [0, 0, 0], scale: [-1, 1, 1], pivot: [0, 0, 0] })), [1, 0, 0]);
    expect(mirrored).toEqual([-1, 0, 0]);
  });

  it("hands ONE matrix to every pass the Render emits for a surface", () => {
    const compiled = compile(graph({ mode: "surface", ...TRANSFORM }));
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const expected = objectMatrix({ translate: [1, 2, 3], rotate: [10, 20, 30], scale: [2, 1, 0.5], pivot: [0.5, 0, 0] });
    const draws = drawsOf(compiled).filter((pass) => /:(scene|gbuffer|gbuffer:albedo|gbuffer:shadow|shadow:0|depthOut):0$/.test(pass.id));
    // The lit draw, the three G-buffer layers, the light's sweep and the Depth output's.
    expect(draws.map((pass) => pass.id).sort()).toEqual(["shot:depthOut:0", "shot:gbuffer:0", "shot:gbuffer:albedo:0", "shot:gbuffer:shadow:0", "shot:scene:0", "shot:shadow:0:0"]);
    for (const pass of draws) expect([pass.id, pass.uniforms?.["model"]]).toEqual([pass.id, expected]);
    // The passes that shade carry the normal matrix beside it.
    for (const pass of draws.filter((entry) => !/shadow:0:0|depthOut/.test(entry.id))) {
      expect([pass.id, pass.uniforms?.["modelNormal"]]).toEqual([pass.id, normalMatrix(expected)]);
    }
  });

  it("is the identity when nothing is set, on every surface draw", () => {
    const compiled = compile(graph({ mode: "surface" }));
    const lit = drawsOf(compiled).find((pass) => pass.id === "shot:scene:0");
    expect(lit?.uniforms?.["model"]).toEqual(identityMatrix());
    expect(lit?.uniforms?.["modelNormal"]).toEqual(identityMatrix());
  });

  it.each(["instances", "points", "beam"])("refuses a Transform on a %s geometry by name, rather than dropping it", (mode) => {
    const compiled = compile(graph({ mode, ...(mode === "beam" ? { endpoint: "position" } : {}), translate: [1, 0, 0] }));
    const refusal = compiled.diagnostics.find((d) => d.code === "node.scene.transform");
    expect(refusal?.severity).toBe("error");
    expect(refusal?.message).toContain(`${mode === "instances" ? "a geometry drawing primitive instances" : `a ${mode} geometry`} does not take it yet`);
    // The same geometry with the Transform at its defaults compiles as it always did.
    const plain = compile(graph({ mode, ...(mode === "beam" ? { endpoint: "position" } : {}) }));
    expect(plain.diagnostics.some((d) => d.code === "node.scene.transform")).toBe(false);
  });

  it("says where the Transform applies, and keeps Size apart from the object's Scale (§V146)", () => {
    // The schema a placed Surface geometry carries, through the one funnel (§T903).
    const parameters = effectiveParameterSchema(geometryNode, { mode: "surface" });
    for (const key of ["translate", "rotate", "objectScale", "pivot"]) {
      const definition = parameters[key];
      expect([key, definition?.group]).toEqual([key, "Transform"]);
      expect([key, definition?.inactiveWhen?.({ mode: "surface" })]).toEqual([key, null]);
      for (const mode of ["instances", "points", "beam"]) {
        expect([key, mode, typeof definition?.inactiveWhen?.({ mode })]).toEqual([key, mode, "string"]);
      }
    }
    // Two different things, two different labels: the object's per-axis Scale, and the Size of one instance.
    expect(parameters["objectScale"]?.label).toBe("Scale");
    expect(parameters["scale"]?.label).toBe("Size");
    // None of them is structural: a moving object is a uniform write.
    for (const key of ["translate", "rotate", "objectScale", "pivot"]) expect([key, parameters[key]?.compileTime]).toEqual([key, undefined]);
  });
});
