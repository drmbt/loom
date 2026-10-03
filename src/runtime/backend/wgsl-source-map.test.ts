import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { readExecutionPlan } from "./plan.ts";
import {
  authoredPosition,
  endOf,
  placed,
  placedAroundCut,
  readSourceMap,
  relocated,
  type WgslSourceMap,
} from "./wgsl-source-map.ts";

/**
 * T1523b — THE SOURCE MAP PUTS EVERY AUTHOR CHARACTER BACK WHERE IT WAS TYPED.
 *
 * The claim that matters is not "a span has these numbers" but "a position in the module
 * the device compiled names the author's character". So the strongest test here takes the
 * REAL emitters (the node compile, through the graph compiler and the plan reader the
 * backend uses), finds every identifier the author wrote in the generated text, and asserts
 * the map sends its generated position to the identifier's position in the author's text —
 * across a hoisted `struct Params`, a trimmed group predicate and a `// @use` prelude.
 */

/** Every distinct position of `token` in `text`, 1-based. */
function positionsOf(text: string, token: string): Array<{ line: number; column: number }> {
  const found: Array<{ line: number; column: number }> = [];
  text.split("\n").forEach((line, index) => {
    for (let at = line.indexOf(token); at !== -1; at = line.indexOf(token, at + 1)) {
      found.push({ line: index + 1, column: at + 1 });
    }
  });
  return found;
}

/** Tokens unique to the author's text: each appears exactly once there and once in the module. */
function assertTokensMapBack(map: WgslSourceMap, generated: string, authored: Record<string, string>, tokens: string[]): void {
  for (const token of tokens) {
    const owners = Object.entries(authored).filter(([, text]) => positionsOf(text, token).length === 1);
    expect(owners.length, token).toBe(1);
    const [parameter, text] = owners[0]!;
    const where = positionsOf(generated, token);
    expect(where.length, token).toBe(1);
    expect(authoredPosition(map, where[0]!), token).toEqual({ parameter, ...positionsOf(text, token)[0]! });
  }
}

const registry = createNodeRegistry(allNodeDefinitions).view();
const settings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};
const capabilities = {
  tier: "B" as const,
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"] as never,
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function passOf(graph: GraphDocument, suffix: string): { shader: string; sourceMap: WgslSourceMap } {
  const plan = compileGraph({ graph, settings, registry, capabilities });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  // Through the reader the backend uses: a map the plan reader drops would map nothing.
  const read = readExecutionPlan(plan);
  const pass = read.passes.find((entry) => entry.id.endsWith(suffix));
  if (pass === undefined || !("shader" in pass)) throw new Error(`no ${suffix} pass`);
  if (!("sourceMap" in pass) || pass.sourceMap === undefined) throw new Error(`${suffix} carries no source map`);
  return { shader: pass.shader, sourceMap: pass.sourceMap };
}

function pointsGraph(type: string, parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      sim: { id: "sim", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 8, seed: 7, ...parameters } },
      draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8, sizePixels: 6 } },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

const KERNEL = `// leading note
fn helperAlpha(v: vec3f) -> vec3f { return v * 0.5; }
struct Params {
  // @default 1
  speedKnob: f32,
}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = helperAlpha(p.position) * ctx.params.speedKnob;
  return q;
}`;

describe("a pass's source map sends every author token home (T1523b)", () => {
  it("a point kernel: before the hoisted struct, inside it, after it, and the group predicate", () => {
    const group = "\n\n   p.position.x > groupLimitZeta(0.0)";
    const kernel = `${KERNEL}\nfn groupLimitZeta(x: f32) -> f32 { return x; }`;
    const { shader, sourceMap } = passOf(pointsGraph("pointKernel", { kernel, group }), ":kernel");
    assertTokensMapBack(sourceMap, shader, { kernel, group }, ["leading note", "// @default 1", "helperAlpha(p.position)", "q.position =", "fn groupLimitZeta", "p.position.x > groupLimitZeta"]);
    // A line of generated code maps to nobody.
    expect(authoredPosition(sourceMap, positionsOf(shader, "fn main(")[0]!)).toBeUndefined();
  });

  it("a spawn hook: the hook's own text, and the kernel struct hoisted above it", () => {
    const spawn = `\n  fn spawn(child: Point, ctx: PointCtx) -> Point {\n    var c = child;\n    c.position = c.position * ctx.params.speedKnob;\n    return c;\n  }\n`;
    const { shader, sourceMap } = passOf(pointsGraph("pointKernelAdvanced", { kernel: KERNEL, spawn }), ":spawnHook");
    assertTokensMapBack(sourceMap, shader, { kernel: KERNEL, spawn }, ["// @default 1", "var c = child", "c.position = c.position"]);
  });

  it("a Custom WGSL behind a `// @use` prelude", () => {
    const source = `// @use grid
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cellOmega = gridCellAt(uv, vec2f(4.0, 4.0));
  return textureSample(inputTexture, inputSampler, cellOmega.origin);
}`;
    const graph = {
      revision: 1,
      nodes: {
        solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        fx: { id: "fx", type: "customWgsl", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { source } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
        e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as unknown as GraphDocument;
    const { shader, sourceMap } = passOf(graph, ":custom");
    expect(positionsOf(shader, "let cellOmega")[0]!.line).toBeGreaterThan(positionsOf(source, "let cellOmega")[0]!.line);
    assertTokensMapBack(sourceMap, shader, { source }, ["let cellOmega", "cellOmega.origin"]);
    // The prelude is a shared module's text, not the author's.
    expect(authoredPosition(sourceMap, { line: 1, column: 1 })).toBeUndefined();
  });
});

describe("a Material · WGSL's tokens map home through the Render's pass, naming the material (T1535b)", () => {
  it("two materials on one Render: each surface pass sends its tokens to its own node's line", () => {
    const first = `// @use hash
fn helperAlpha(c: vec4f) -> vec4f { return c; }
struct Params {
  glowKnob: f32, // @default 0.5  Glow.
};
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = helperAlpha(o.albedo) * p.glowKnob;
  return o;
}`;
    const second = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var betaOut = surfaceDefaults(s);
  return betaOut;
}`;
    const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
      id,
      type,
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters,
      label,
    });
    const nodes = [
      node("grid", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid1"),
      node("matA", "materialWgsl", { model: "lambert", source: first }, "materialA"),
      node("geoA", "geometry", { mode: "surface", material: "materialA" }, "geometryA"),
      node("matB", "materialWgsl", { model: "pbr", source: second }, "materialB"),
      node("geoB", "geometry", { mode: "surface", material: "materialB" }, "geometryB"),
      node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
      node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
      node("shot", "render", { scenes: "geometryA geometryB", camera: "cam1", lights: "sun1" }, "shot1"),
      node("out", "output", {}, "out1"),
    ];
    const graph = {
      revision: 1,
      nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
      edges: {
        a: { id: "a", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geoA", portId: "points" } },
        b: { id: "b", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geoB", portId: "points" } },
        o: { id: "o", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as unknown as GraphDocument;
    const cases = [
      { pass: ":scene:0", nodeId: "matA", text: first, tokens: ["fn helperAlpha", "  glowKnob: f32, // @default", "helperAlpha(o.albedo)"] },
      { pass: ":scene:1", nodeId: "matB", text: second, tokens: ["var betaOut", "return betaOut"] },
    ];
    for (const { pass, nodeId, text, tokens } of cases) {
      const { shader, sourceMap } = passOf(graph, pass);
      for (const token of tokens) {
        const where = positionsOf(shader, token);
        expect(where.length, token).toBe(1);
        expect(where[0]!.line, token).not.toBe(positionsOf(text, token)[0]!.line);
        expect(authoredPosition(sourceMap, where[0]!), token).toEqual({ parameter: "source", nodeId, ...positionsOf(text, token)[0]! });
      }
      // The generator's own fragment entry is nobody's.
      expect(authoredPosition(sourceMap, positionsOf(shader, "fn fs(")[0]!)).toBeUndefined();
    }
  });
});

describe("the span arithmetic (T1523b)", () => {
  it("T1535b: a map counted in one text moves with it; only the first line shifts sideways", () => {
    const map = [{ ...placed("source", "ab\ncd", { line: 1, column: 3 }, { line: 4, column: 1 }), nodeId: "mat" }];
    const moved = relocated(map, { line: 10, column: 5 });
    expect(moved).toEqual([{ parameter: "source", nodeId: "mat", at: { line: 10, column: 7 }, from: { line: 4, column: 1 }, lines: 2 }]);
    expect(authoredPosition(moved, { line: 10, column: 8 })).toEqual({ parameter: "source", nodeId: "mat", line: 4, column: 2 });
    expect(authoredPosition(moved, { line: 11, column: 2 })).toEqual({ parameter: "source", nodeId: "mat", line: 5, column: 2 });
    const second = relocated([{ ...map[0]!, at: { line: 3, column: 2 } }], { line: 10, column: 5 });
    expect(second[0]!.at).toEqual({ line: 12, column: 2 });
  });


  it("a span shifts columns on its first line only, and a column left of the author's text is generated", () => {
    const map = [placed("group", "a > b\nc", { line: 10, column: 11 })];
    expect(authoredPosition(map, { line: 10, column: 15 })).toEqual({ parameter: "group", line: 1, column: 5 });
    expect(authoredPosition(map, { line: 11, column: 1 })).toEqual({ parameter: "group", line: 2, column: 1 });
    expect(authoredPosition(map, { line: 10, column: 10 })).toBeUndefined();
    expect(authoredPosition(map, { line: 12, column: 1 })).toBeUndefined();
  });

  it("a cut that starts mid-line keeps the start line's prefix and shifts what follows", () => {
    const source = "aa\nbb struct X {\n}\ncc";
    const start = source.indexOf("struct");
    const end = source.indexOf("}") + 1;
    const rest = `${source.slice(0, start)}${source.slice(end)}`; // "aa\nbb \ncc"
    const map = placedAroundCut("kernel", source, start, end, { line: 5, column: 1 });
    expect(rest.split("\n")).toEqual(["aa", "bb ", "cc"]);
    expect(authoredPosition(map, { line: 6, column: 2 })).toEqual({ parameter: "kernel", line: 2, column: 2 });
    expect(authoredPosition(map, { line: 7, column: 2 })).toEqual({ parameter: "kernel", line: 4, column: 2 });
    expect(authoredPosition(map, { line: 8, column: 1 })).toBeUndefined();
  });

  it("a cut that starts a line joins onto the END line, so text after the `}` keeps its column", () => {
    const source = "aa\nstruct X {\n} tail\ncc";
    const start = source.indexOf("struct");
    const end = source.indexOf("}") + 1;
    // Remainder: "aa\n tail\ncc" — its line 2 is the author's line 3 from column 2 on.
    const map = placedAroundCut("kernel", source, start, end, { line: 5, column: 1 });
    expect(authoredPosition(map, { line: 5, column: 2 })).toEqual({ parameter: "kernel", line: 1, column: 2 });
    expect(authoredPosition(map, { line: 6, column: 2 })).toEqual({ parameter: "kernel", line: 3, column: 3 });
    expect(authoredPosition(map, { line: 7, column: 1 })).toEqual({ parameter: "kernel", line: 4, column: 1 });
  });

  it("endOf counts from 1:1", () => {
    expect(endOf("")).toEqual({ line: 1, column: 1 });
    expect(endOf("abc")).toEqual({ line: 1, column: 4 });
    expect(endOf("abc\n\nde")).toEqual({ line: 3, column: 3 });
  });

  it("the plan reader refuses a malformed map rather than trusting it", () => {
    expect(readSourceMap(undefined)).toBeUndefined();
    expect(readSourceMap([{ parameter: "kernel", at: { line: 1, column: 1 }, from: { line: 1, column: 1 }, lines: 2 }])).toEqual([
      { parameter: "kernel", at: { line: 1, column: 1 }, from: { line: 1, column: 1 }, lines: 2 },
    ]);
    expect(readSourceMap([{ parameter: "source", at: { line: 1, column: 1 }, from: { line: 1, column: 1 }, lines: 1, nodeId: "mat" }])).toEqual([
      { parameter: "source", at: { line: 1, column: 1 }, from: { line: 1, column: 1 }, lines: 1, nodeId: "mat" },
    ]);
    expect(readSourceMap([{ parameter: "source", at: { line: 1, column: 1 }, from: { line: 1, column: 1 }, lines: 1, nodeId: 7 }])).toBeNull();
    expect(readSourceMap({})).toBeNull();
    expect(readSourceMap([{ parameter: "", at: { line: 1, column: 1 }, from: { line: 1, column: 1 }, lines: 1 }])).toBeNull();
    expect(readSourceMap([{ parameter: "k", at: { line: 0, column: 1 }, from: { line: 1, column: 1 }, lines: 1 }])).toBeNull();
    expect(readSourceMap([{ parameter: "k", at: { line: 1, column: 1 }, from: { line: 1, column: 1 }, lines: 0 }])).toBeNull();
  });
});
