import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { SHARED_WGSL_MODULES } from "../shaders/shared-modules.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { authoredPosition } from "../../runtime/backend/wgsl-source-map.ts";

/**
 * T1581b (F9) — a POINT KERNEL resolves `// @use`, as a Custom WGSL and a Material · WGSL
 * always have. Before this a kernel that wrote `// @use quat` compiled as if the line were
 * only a comment, and failed at the device on the first function it called.
 *
 * What is asserted is what the author gets: the module's functions are in the kernel's
 * compiled text ahead of their own, a module that does not exist or a name declared twice
 * is refused by name, and a device error on their line still points at their line.
 * What `quat` computes is `mesh-instances.gpu.test.ts`'s claim, on Dawn.
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

const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
]);

const TURNING = `// @use quat
struct Params {
  rate: f32, // @default 1
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.orient = quatAxisAngle(vec3f(0.0, 0.0, 1.0), ctx.time * ctx.params.rate);
  return q;
}`;

function graph(type: "pointKernel" | "pointKernelAdvanced", kernel: string, spawn = ""): GraphDocument {
  const parameters = type === "pointKernel" ? { capacity: 8, seed: 1, group: "", attributes: ATTRIBUTES, kernel, value1: 0, value2: 0, value3: 0, value4: 0 } : { capacity: 8, seed: 1, kernel, spawn };
  const nodes = [
    { id: "pts", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: "kernel_points" },
    { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8, sizePixels: 2 }, label: "points_draw" },
    { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "output_main" },
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "pts", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

const compile = (type: "pointKernel" | "pointKernelAdvanced", kernel: string, spawn = "") =>
  compileGraph({ graph: graph(type, kernel, spawn), settings: SETTINGS, registry, capabilities: CAPABILITIES });
const passNamed = (compiled: { passes: ReadonlyArray<unknown> }, name: string): DispatchPassDescriptor =>
  (compiled.passes as DispatchPassDescriptor[]).find((pass) => pass.kind === "dispatch" && pass.id.endsWith(`pts:${name}`)) as DispatchPassDescriptor;
const kernelPass = (compiled: { passes: ReadonlyArray<unknown> }): DispatchPassDescriptor => passNamed(compiled, "kernel");
/** The kernel's own refusals. (A consumer downstream refuses too, for want of a pointset; that is its sentence.) */
const PLAIN = "fn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}";

/** A spawn hook that turns each newborn about Z: the advanced kernel's SECOND module. */
const HOOK = `// @use quat
fn spawn(child: Point, ctx: PointCtx) -> Point {
  var c = child;
  c.position = quatRotate(quatAxisAngle(vec3f(0.0, 0.0, 1.0), 1.0), child.position);
  return c;
}`;

const errors = (compiled: { diagnostics: ReadonlyArray<{ severity: string; code: string; message: string; suggestion?: string; nodeId?: string }> }) =>
  compiled.diagnostics.filter((d) => d.severity === "error" && d.nodeId === "pts");
const allErrors = (compiled: { diagnostics: ReadonlyArray<{ severity: string }> }) => compiled.diagnostics.filter((d) => d.severity === "error");

describe("a point kernel pulls shared WGSL in with // @use (T1581b F9)", () => {
  it("places the module ahead of the kernel's own code, in both kernel nodes", () => {
    for (const type of ["pointKernel", "pointKernelAdvanced"] as const) {
      // The advanced kernel's default attributes carry no `orient`; it turns its position instead.
      const source = type === "pointKernel" ? TURNING : TURNING.replace("q.orient = quatAxisAngle(vec3f(0.0, 0.0, 1.0), ctx.time * ctx.params.rate);", "q.position = quatRotate(quatAxisAngle(vec3f(0.0, 0.0, 1.0), ctx.params.rate), p.position);");
      const compiled = compile(type, source);
      expect([type, allErrors(compiled)]).toEqual([type, []]);
      const text = String(kernelPass(compiled).shader);
      // The whole module, verbatim, and before the author's `process` that calls into it.
      const module = SHARED_WGSL_MODULES["quat"]!.source;
      expect([type, text.includes(module)]).toEqual([type, true]);
      expect([type, text.indexOf(module) < text.indexOf("fn process(")]).toEqual([type, true]);
    }
  });

  it("costs nothing when nothing is asked for", () => {
    const text = String(kernelPass(compile("pointKernel", PLAIN)).shader);
    expect(text).not.toContain("quatMul");
    expect(text).not.toContain("hashU32");
  });

  it("refuses a module that does not exist, by name, and says which do", () => {
    const refusal = errors(compile("pointKernel", "// @use quaternion\nfn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}"));
    expect(refusal.map((d) => d.code)).toEqual(["node.points.module"]);
    expect(refusal[0]?.message).toContain("`// @use quaternion` names a shared WGSL module that does not exist");
    expect(refusal[0]?.suggestion).toContain("quat");
    expect(refusal[0]?.suggestion).toContain("hash");
  });

  it("refuses a name the kernel and a module both declare, rather than shadowing one", () => {
    const own = "// @use quat\nfn quatMul(a: vec4f, b: vec4f) -> vec4f {\n  return a;\n}\nfn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}";
    const refusal = errors(compile("pointKernel", own));
    expect(refusal.map((d) => d.code)).toEqual(["node.points.module"]);
    expect(refusal[0]?.message).toContain('this kernel declares "quatMul", which the shared module "quat" also declares');
  });

  it("still points a device error on the author's line at the author's line", () => {
    const pass = kernelPass(compile("pointKernel", TURNING));
    const map = pass.sourceMap ?? [];
    const generated = String(pass.shader).split("\n");
    const authored = TURNING.split("\n");
    const lineOf = (lines: readonly string[], text: string) => lines.findIndex((line) => line.includes(text)) + 1;
    // The module's text went in FRONT of the kernel and moved every one of its lines down.
    // A position in the author's call still reads back as the author's line and column.
    for (const text of ["q.orient = quatAxisAngle(", "fn process(", "return q;"]) {
      const at = { line: lineOf(generated, text), column: generated[lineOf(generated, text) - 1]!.indexOf(text) + 1 };
      const from = { line: lineOf(authored, text), column: authored[lineOf(authored, text) - 1]!.indexOf(text) + 1 };
      expect([text, at.line > 0, authoredPosition(map, at)]).toEqual([text, true, { parameter: "kernel", ...from }]);
    }
    // And a line of the module itself is nobody's parameter: it is not the author's text.
    expect(authoredPosition(map, { line: lineOf(generated, "fn quatMul("), column: 1 })).toBeUndefined();
  });

  it("gives the spawn hook what the HOOK asked for: its module is its own", () => {
    const compiled = compile("pointKernelAdvanced", PLAIN, HOOK);
    expect(allErrors(compiled)).toEqual([]);
    const hook = passNamed(compiled, "spawnHook");
    const text = String(hook.shader);
    const module = SHARED_WGSL_MODULES["quat"]!.source;
    expect(text.includes(module)).toBe(true);
    expect(text.indexOf(module) < text.indexOf("fn spawn(")).toBe(true);
    // The kernel did not ask, and is not handed it.
    expect(String(kernelPass(compiled).shader)).not.toContain("quatMul");
    // The hook's own line is still the hook's own line.
    const generated = text.split("\n");
    const line = generated.findIndex((entry) => entry.includes("c.position = quatRotate(")) + 1;
    expect(authoredPosition(hook.sourceMap ?? [], { line, column: 3 })).toEqual({ parameter: "spawn", line: 4, column: 3 });
  });

  it("refuses the hook's missing module and its clash, naming the hook", () => {
    const missing = errors(compile("pointKernelAdvanced", PLAIN, HOOK.replace("// @use quat", "// @use quaternion")));
    expect(missing.map((d) => [d.code, d.message])).toEqual([["node.points.module", 'Node "pts": `// @use quaternion` names a shared WGSL module that does not exist.']]);
    const clash = errors(compile("pointKernelAdvanced", PLAIN, `${HOOK}\nfn quatSlerp(a: vec4f, b: vec4f, t: f32) -> vec4f {\n  return a;\n}`));
    expect(clash.map((d) => d.code)).toEqual(["node.points.module"]);
    expect(clash[0]?.message).toContain('this spawn hook declares "quatSlerp", which the shared module "quat" also declares');
  });
});
