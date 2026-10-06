import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode, ProjectSettings } from "../domain/types/graph.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { compileGraph } from "./compile.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { HIGH_HALF_CASES } from "./wgsl-high-half.cases.ts";
import { highHalfDivisions } from "./wgsl-high-half.ts";

/**
 * B263 — THE WARNING FOR A DIVIDE OF A HIGH HALF, AGAINST WHAT THE DEVICE DOES.
 *
 * `(h >> 16u) % 97u` is valid WGSL and returns a wrong value on Apple GPUs. The compiler says
 * so on the author's node and line. A warning is only worth having if it is RIGHT BOTH WAYS:
 * silent on a wrong line it teaches nothing, and loud on a right line it teaches authors to
 * ignore it. So the detector is held to the table measured on the device
 * (`wgsl-high-half.cases.ts`), line by line, in both directions.
 */

/** A line of the table as an author would write it: in a function, the value and the divisor from elsewhere. */
const inFunction = (expression: string): string => `fn lot(x: u32, d: u32) -> u32 {\n  return ${expression};\n}`;

describe("B263: the detector's verdict is the device's, on every measured line", () => {
  it("has both kinds of line to hold, and one the text cannot show", () => {
    expect(HIGH_HALF_CASES.filter((entry) => entry.measured === "wrong").length).toBeGreaterThanOrEqual(10);
    expect(HIGH_HALF_CASES.filter((entry) => entry.measured === "right").length).toBeGreaterThanOrEqual(20);
    expect(HIGH_HALF_CASES.filter((entry) => entry.unseen === true).map((entry) => entry.measured)).toEqual(["wrong"]);
  });

  it.each(HIGH_HALF_CASES.map((entry) => [entry.wgsl, entry] as const))("%s", (_, entry) => {
    const flagged = highHalfDivisions(inFunction(entry.wgsl)).length > 0;
    /* Flagged exactly where the device is wrong and the text shows why. */
    expect(flagged).toBe(entry.measured === "wrong" && entry.unseen !== true);
    /* The same verdict for the bare expression, which is what a Group predicate is. */
    expect(highHalfDivisions(`${entry.wgsl} == 0u`).length > 0).toBe(flagged);
  });
});

describe("B263: the shape, as an author writes it", () => {
  /* The consumer's own lines (SPEC B263), in a Material · WGSL's surface function. */
  const CONSUMER = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let a = u32(p.pair + 0.5);
  let m = ((a + 2931u) * 2654435761u) >> 16u;
  let low = m & 255u;
  let scaled = (m * 100u) >> 16u;
  let quotient = m / 97u;
  let lot = m % 97u;
  let percent = m % 100u;
  let byHand = m - (m / 100u) * 100u;
  let control = (a + 2931u) % 100u;
  o.emissive = vec3f(f32(quotient + lot + percent + byHand + control + low + scaled));
  return o;
}`;

  it("flags each of the consumer's four divisions at its own line, and neither the mask, the scale nor the control", () => {
    expect(highHalfDivisions(CONSUMER).map((hit) => [hit.line, hit.text])).toEqual([
      [7, "m / 97u"],
      [8, "m % 97u"],
      [9, "m % 100u"],
      [10, "m / 100u"],
    ]);
    /* The column is the operator's, counted as a device counts. */
    expect(highHalfDivisions(CONSUMER)[0]).toMatchObject({ line: 7, column: 20 });
  });

  it("follows a name bound to a name, a named constant, and a vector's component", () => {
    const text = (body: string): string => `const LOTS = 97u;\nfn f(h: u32, v: vec2u) -> u32 {\n${body}\n}`;
    expect(highHalfDivisions(text("  let top = h >> 16u;\n  let same = top;\n  return same % 97u;")).map((hit) => hit.text)).toEqual(["same % 97u"]);
    expect(highHalfDivisions(text("  let top = h >> 16u;\n  return top % LOTS;")).map((hit) => hit.text)).toEqual(["top % LOTS"]);
    expect(highHalfDivisions(text("  let n = 97u;\n  return (h >> 16u) % n;")).map((hit) => hit.text)).toEqual(["(h >> 16u) % n"]);
    expect(highHalfDivisions(text("  let tops = v >> vec2u(16u);\n  return tops.x % 97u;")).map((hit) => hit.text)).toEqual(["tops.x % 97u"]);
    expect(highHalfDivisions(text("  let a = h >> 10u;\n  let b = a >> 6u;\n  return b / 3u;")).map((hit) => hit.text)).toEqual(["b / 3u"]);
  });

  it("is silent where precedence, a call or another function puts something between the half and the divide", () => {
    const text = (body: string): string => `fn half(h: u32) -> u32 { return h >> 16u; }\nfn f(h: u32, n: u32, p: Probe) -> u32 {\n  let m = h >> 16u;\n${body}\n}`;
    for (const body of [
      "  return 3u * m % 97u;", // the product is divided
      "  return m * 3u % 97u;",
      "  return ~m % 97u;",
      "  return f32(m) / 97.0 > 0.5;", // a float divide
      "  return u32(f32(m) / 97);",
      "  return m % n;", // a divisor from elsewhere
      "  return m / 64u;", // a power of two
      "  return m % 1u;",
      "  return 97u / m;", // the half is the divisor
      "  return 97u % m;",
      "  return p.m % 97u;", // a member of something else
      "  return hashU32(m) % 97u;", // a call's result
      "  return min(m, 9u) % 97u;",
      "  var w = h >> 16u;\n  w %= 97u;\n  return w;", // a `var` is not followed
    ]) {
      expect([body, highHalfDivisions(text(body)).map((hit) => hit.text)]).toEqual([body, []]);
    }
    /* Another function's `m` is another value. */
    expect(highHalfDivisions("fn a(h: u32) -> u32 {\n  let m = h >> 16u;\n  return m;\n}\nfn b(m: u32) -> u32 {\n  return m % 97u;\n}")).toEqual([]);
  });

  it("reads no comment and no quoted run, and keeps the line of what follows one", () => {
    const quiet = [
      "fn f(h: u32) -> u32 {",
      "  // let m = h >> 16u; return m % 97u;",
      "  /* (h >> 16u) % 97u, and a nested /* (h >> 16u) / 3u */ comment */",
      '  /* "(h >> 16u) % 97u" */',
      "  return h;",
      "}",
    ].join("\n");
    expect(highHalfDivisions(quiet)).toEqual([]);
    /* A comment between the half and the divide is no operand: the division is still read, on its own line. */
    const split = "fn f(h: u32) -> u32 {\n  /* two\n     lines */\n  return (h >> 16u) /* the high half */ % 97u; // and (h >> 16u) / 3u\n}";
    expect(highHalfDivisions(split).map((hit) => [hit.line, hit.text])).toEqual([[4, "(h >> 16u) /* the high half */ % 97u"]]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Through the compiler: every surface an author writes WGSL on                          */
/* ------------------------------------------------------------------------------------ */

const registry = createNodeRegistry(allNodeDefinitions).view();
const settings: ProjectSettings = {
  outputResolution: { width: 32, height: 32 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 20,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: registry.get(type)?.version ?? 1, position: { x: 0, y: 0 }, parameters, label: id };
}
const edge = (id: string, from: string, to: string, port: string): GraphDocument["edges"][string] => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });
const graphOf = (nodes: GraphNode[], edges: Array<GraphDocument["edges"][string]>): GraphDocument => ({
  revision: 1,
  nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
  edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
  groups: {},
});

/** The compiler's warnings of this kind, as [node, message]. */
function warned(graph: GraphDocument): Array<[string | undefined, string]> {
  const plan = compileGraph({ graph, settings, registry, capabilities: TIER_B_CAPABILITIES });
  expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  return plan.diagnostics.filter((diagnostic) => diagnostic.code === CompilerDiagnosticCode.wgslHighHalfDivide).map((diagnostic) => [diagnostic.nodeId, diagnostic.message]);
}

const WRONG = "let m = (h * 2654435761u) >> 16u;\n  let lot = m % 97u;";
const RIGHT = "let lot = hashLot(h * 2654435761u, 97u);";

const kernel = (lines: string, use = ""): string => `${use}fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  let h = ctx.index + 1u;\n  ${lines}\n  q.position = vec3f(f32(lot), 0.0, 0.0);\n  return q;\n}`;
const material = (lines: string, use = ""): string => `${use}fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {\n  var o = surfaceDefaults(s);\n  let h = s.instanceId + 1u;\n  ${lines}\n  o.emissive = vec3f(f32(lot));\n  return o;\n}`;
const ATTRS = '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]';

const kernelGraph = (source: string): GraphDocument =>
  graphOf(
    [node("kernel_lot", "pointKernel", { capacity: 8, kernel: source }), node("points_draw", "renderPoints", { count: 8, sizePixels: 2 }), node("output_frame", "output", {})],
    [edge("e1", "kernel_lot", "points_draw", "points"), edge("e2", "points_draw", "output_frame", "input")],
  );

/** A floor wearing a Material · WGSL; or, with a Group, primitive boxes wearing a stock material (a Material · WGSL does not run on those). */
const materialGraph = (source: string, group = ""): GraphDocument =>
  graphOf(
    [
      node("grid_floor", "pointGrid", { cols: 4, rows: 4, count: 16, sizeX: 4, sizeY: 4 }),
      node("kernel_floor", "pointKernel", { capacity: 16, attributes: ATTRS, kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}" }),
      node("geometry_floor", "geometry", group === "" ? { mode: "surface", material: "material_lot" } : { mode: "instances", shape: "box", scale: 0.2, material: "material_lot", group }),
      group === "" ? node("material_lot", "materialWgsl", { model: "unlit", source }) : node("material_lot", "materialUnlit", {}),
      node("camera_c", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }),
      node("render_shot", "render", { scenes: "geometry_floor", camera: "camera_c", lights: "" }),
      node("output_frame", "output", {}),
    ],
    [edge("e1", "grid_floor", "kernel_floor", "in"), edge("e2", "kernel_floor", "geometry_floor", "points"), edge("e3", "render_shot", "output_frame", "input")],
  );

describe("B263: the compiler warns on the author's node and line, on every surface that takes WGSL", () => {
  it("a Point Kernel's code", () => {
    expect(warned(kernelGraph(kernel(WRONG)))).toEqual([
      ["kernel_lot", 'Node "kernel_lot": `m % 97u` in its kernel, line 5 divides the high half of a 32-bit value by a constant. The WGSL is valid, and Apple GPUs return a wrong value for it.'],
    ]);
    expect(warned(kernelGraph(kernel(RIGHT, "// @use lot\n")))).toEqual([]);
  });

  it("a Material · WGSL's code, once, on the material and not on the Render that draws it", () => {
    expect(warned(materialGraph(material(WRONG)))).toEqual([
      ["material_lot", 'Node "material_lot": `m % 97u` in its source, line 5 divides the high half of a 32-bit value by a constant. The WGSL is valid, and Apple GPUs return a wrong value for it.'],
    ]);
    expect(warned(materialGraph(material(RIGHT, "// @use lot\n")))).toEqual([]);
  });

  it("a Group predicate", () => {
    const flagged = warned(materialGraph("", "(u32(p.position.x * 65536.0) >> 16u) % 3u == 0u"));
    expect(flagged).toEqual([
      ["render_shot", 'Node "render_shot": `(u32(p.position.x * 65536.0) >> 16u) % 3u` in the shader this node generates divides the high half of a 32-bit value by a constant. The WGSL is valid, and Apple GPUs return a wrong value for it.'],
    ]);
    expect(warned(materialGraph("", "u32(p.position.x * 65536.0) % 3u == 0u"))).toEqual([]);
  });

  it("a Custom WGSL's source", () => {
    const source = (lines: string, use = ""): string =>
      `${use}@group(0) @binding(0) var inputSampler: sampler;\n@group(0) @binding(1) var inputTexture: texture_2d<f32>;\n\n@fragment\nfn fs(@location(0) uv: vec2f) -> @location(0) vec4f {\n  let h = u32(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).r * 65536.0);\n  ${lines}\n  return vec4f(f32(lot), 0.0, 0.0, 1.0);\n}`;
    const graph = (text: string): GraphDocument =>
      graphOf([node("solid_in", "solid", {}), node("wgsl_lot", "customWgsl", { source: text }), node("output_frame", "output", {})], [edge("e0", "solid_in", "wgsl_lot", "input"), edge("e1", "wgsl_lot", "output_frame", "input")]);
    expect(warned(graph(source(WRONG)))).toEqual([
      ["wgsl_lot", 'Node "wgsl_lot": `m % 97u` in its source, line 8 divides the high half of a 32-bit value by a constant. The WGSL is valid, and Apple GPUs return a wrong value for it.'],
    ]);
    expect(warned(graph(source(RIGHT, "// @use lot\n")))).toEqual([]);
  });

  it("says what to write instead", () => {
    const plan = compileGraph({ graph: kernelGraph(kernel(WRONG)), settings, registry, capabilities: TIER_B_CAPABILITIES });
    const warning = plan.diagnostics.find((diagnostic) => diagnostic.code === CompilerDiagnosticCode.wgslHighHalfDivide);
    expect(warning?.severity).toBe("warning");
    expect(warning?.suggestion).toBe('For a lot in 0..n-1 from a hash, add "// @use lot" and write hashLot(h, n). Otherwise take the bits with extractBits(x, 16u, 16u) before dividing; both are right on every GPU.');
  });
});
