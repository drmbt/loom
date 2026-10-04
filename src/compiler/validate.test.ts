import { describe, expect, it } from "vitest";
import { flatDocument } from "@compiler/test-support.ts";
import { validateGraph, validateRequiredInputs } from "./validate.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { createCompilerTestRegistry, testEdge, testGraph, testNode } from "./test-support.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";

const registry = createCompilerTestRegistry().view();

describe("validateGraph — definitions and parameters (T24)", () => {
  it("reports an unknown node type instead of throwing", () => {
    const graph = testGraph([testNode("a", "fx.nope")]);
    const result = validateGraph(flatDocument(graph), registry);

    expect(result.nodes.has("a")).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(CompilerDiagnosticCode.unknownNodeType);
  });

  it("fills declared parameters from their defaults", () => {
    const result = validateGraph(flatDocument(testGraph([testNode("a", "fx.blur")])), registry);
    expect(result.nodes.get("a")?.parameters).toEqual({ radius: 4 });
  });

  /** A wrong-typed value is a reported error and falls back to the default — never a silent cast. */
  it("rejects an out-of-range parameter and uses the default", () => {
    const graph = testGraph([testNode("a", "fx.blur", { parameters: { radius: 999 } })]);
    const result = validateGraph(flatDocument(graph), registry);

    expect(result.nodes.get("a")?.parameters["radius"]).toBe(4);
    expect(result.diagnostics.some((d) => d.severity === "error" && d.nodeId === "a")).toBe(true);
  });

  it("warns about a parameter the definition does not declare", () => {
    const graph = testGraph([testNode("a", "fx.blur", { parameters: { radius: 2, ghost: 1 } })]);
    const result = validateGraph(flatDocument(graph), registry);

    expect(
      result.diagnostics.some((d) => d.code === CompilerDiagnosticCode.parameterUnknown),
    ).toBe(true);
  });

  it("warns when the saved definition version differs from the registry's", () => {
    const graph = testGraph([testNode("a", "fx.blur", { definitionVersion: 0 })]);
    const result = validateGraph(flatDocument(graph), registry);

    expect(
      result.diagnostics.some((d) => d.code === CompilerDiagnosticCode.definitionVersion),
    ).toBe(true);
  });
});

describe("validateGraph — connections (§V13, §V14)", () => {
  it("rejects a connection between different port types", () => {
    const graph = testGraph(
      [testNode("gen", "fx.generator"), testNode("mono", "fx.mono")],
      [testEdge("e1", ["gen", "out"], ["mono", "source"])],
    );
    const result = validateGraph(flatDocument(graph), registry);

    expect(result.edges).toHaveLength(0);
    const diagnostic = result.diagnostics.find(
      (d) => d.code === CompilerDiagnosticCode.portIncompatible,
    );
    expect(diagnostic?.severity).toBe("error");
    // §V13: the fix is a conversion node, and the message has to say so.
    expect(diagnostic?.suggestion).toMatch(/conversion/i);
  });

  it("rejects a second edge into a non-variadic input and keeps the first", () => {
    const graph = testGraph(
      [testNode("a", "fx.generator"), testNode("b", "fx.generator"), testNode("blur", "fx.blur")],
      [
        testEdge("e1", ["a", "out"], ["blur", "source"]),
        testEdge("e2", ["b", "out"], ["blur", "source"]),
      ],
    );
    const result = validateGraph(flatDocument(graph), registry);

    expect(result.edges.map((edge) => edge.id)).toEqual(["e1"]);
    expect(result.diagnostics.some((d) => d.code === CompilerDiagnosticCode.portOccupied)).toBe(true);
  });

  it("accepts many edges into a variadic input", () => {
    const graph = testGraph(
      [testNode("a", "fx.generator"), testNode("b", "fx.generator"), testNode("c", "fx.composite")],
      [
        testEdge("e1", ["a", "out"], ["c", "layers"]),
        testEdge("e2", ["b", "out"], ["c", "layers"]),
      ],
    );
    const result = validateGraph(flatDocument(graph), registry);

    expect(result.edges.map((edge) => edge.id)).toEqual(["e1", "e2"]);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("marks an edge leaving a declared temporal output as temporal (§V4)", () => {
    const graph = testGraph(
      [testNode("fb", "fx.feedback"), testNode("blur", "fx.blur")],
      [testEdge("e1", ["fb", "out"], ["blur", "source"])],
    );
    const result = validateGraph(flatDocument(graph), registry);
    expect(result.edges[0]?.temporal).toBe(true);
  });

  it("reports a required input with nothing connected, for kept nodes only", () => {
    const graph = testGraph([testNode("blur", "fx.blur"), testNode("lonely", "fx.blur")]);
    const result = validateGraph(flatDocument(graph), registry);

    const reported = validateRequiredInputs(result.nodes, result.edges, new Set(["blur"]));
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe(CompilerDiagnosticCode.inputMissing);
    expect(reported[0]?.nodeId).toBe("blur");
  });
});

/**
 * §B231 — the resolver's per-COMPONENT verdicts reach the compile's diagnostics.
 *
 * A compound written per component (`place.x`, §V113) resolves each component slot on its
 * own, and each carries its own diagnostic. The compile read only the bare key's, so an
 * unknown function in `place.x` fell back to §V108's retained value with nothing said,
 * while the identical mistake on a scalar knob was reported. The shipped node types, not
 * the test registry: the reported knob was a Point Kernel's reflected `vec3f`, and the
 * stock half (a Camera's `lookAt`) is the same key shape through a declared schema.
 * The Dawn half — the render itself holding the value — is in
 * `src/tests/headless/component-expression.gpu.test.ts`.
 */
describe("validateGraph — per-component expressions (§B231)", () => {
  const shipped = createNodeRegistry(allNodeDefinitions).view();
  const KERNEL = [
    "struct Params {",
    "  place: vec3f,",
    "}",
    "fn process(p: Point, ctx: PointCtx) -> Point { var q = p; q.position = q.position + ctx.params.place; return q; }",
  ].join("\n");
  const slot = (source: string, retained: number) => ({
    mode: "expression" as const,
    bindings: {
      static: { kind: "static" as const, value: retained },
      expression: { kind: "expression" as const, source },
    },
  });
  const expressionDiagnostics = (result: ReturnType<typeof validateGraph>) =>
    result.diagnostics.filter((d) => d.code === "parameter.expression");

  it("reports an unknown function on a reflected kernel component, naming node, key and function", () => {
    const graph = testGraph([
      testNode("k", "pointKernel", {
        parameters: { kernel: KERNEL, place: [1, 2, 3], "place.x": slot("saturate(abstime)", 0.25) },
      }),
    ]);
    const result = validateGraph(flatDocument(graph), shipped);
    const [reported, ...rest] = expressionDiagnostics(result);
    expect(rest).toEqual([]);
    expect(reported?.nodeId).toBe("k");
    expect(reported?.message).toContain('"place.x"');
    expect(reported?.message).toContain('unknown function "saturate"');
    // What the kernel is handed: the retained x, the bare key's y and z.
    expect(result.nodes.get("k")?.parameters["place"]).toEqual([0.25, 2, 3]);
  });

  it("reports an evaluation failure on a stock compound's component the same way", () => {
    const graph = testGraph([
      testNode("cam", "camera", { parameters: { "lookAt.y": slot("mod(abstime, 0)", 0.5) } }),
    ]);
    const [reported, ...rest] = expressionDiagnostics(validateGraph(flatDocument(graph), shipped));
    expect(rest).toEqual([]);
    expect(reported?.nodeId).toBe("cam");
    expect(reported?.message).toContain('"lookAt.y"');
    expect(reported?.message).toContain("mod(): the period is zero");
  });

  it("stays silent on a valid component expression, whose value is the one handed on", () => {
    const graph = testGraph([
      testNode("k", "pointKernel", {
        parameters: { kernel: KERNEL, place: [1, 2, 3], "place.x": slot("clamp(7, 0, 5) + abstime", 0.25) },
      }),
    ]);
    const result = validateGraph(flatDocument(graph), shipped);
    expect(result.diagnostics.filter((d) => d.nodeId === "k" && d.code.startsWith("parameter."))).toEqual([]);
    // `abstime` is 0 in the frameless compile (§V44's zero frame): 5, not the retained 0.25.
    expect(result.nodes.get("k")?.parameters["place"]).toEqual([5, 2, 3]);
  });
});
