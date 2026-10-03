import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { BackendDiagnosticCode } from "../diagnostics.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1521b — WHAT THE DEVICE SAID WHILE A PASS WAS BUILT BELONGS TO THAT PASS'S NODE.
 *
 * `custom-wgsl.gpu.test.ts` holds the row's literal repro: a WGSL error, told on the node in
 * the compiler's words. These are the two cases that fix could have got wrong on the way.
 * Each pass is now built inside a device error scope, and the scope's answer is DROPPED when
 * the failure already says it — which is only safe if "already says it" is decided by what
 * the two messages are, not by the fact that both exist.
 *
 * The error here is not WGSL at all: one more sampled texture than the device granted a
 * shader stage. The bind group layout is refused, the pipeline then fails with "is invalid
 * due to a previous error", and the shader itself compiles clean.
 */

function greedyPlan(textureCount: number, body: string, unwirable = false): LogicalExecutionPlan {
  const declarations = Array.from(
    { length: textureCount },
    (_, index) => `@group(0) @binding(${index}) var t${index}: texture_2d<f32>;`,
  ).join("\n");
  const sum = Array.from({ length: textureCount }, (_, index) => `textureLoad(t${index}, vec2i(0), 0)`).join(" + ");
  const shader = `${declarations}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return ${body}(${sum});
}`;
  return {
    id: "greedy",
    resources: [
      { kind: "target", id: "source", size: [8, 8], format: "rgba8unorm" },
      { kind: "target", id: "output", size: [8, 8], format: "rgba8unorm" },
    ],
    passes: [
      {
        kind: "effect",
        id: "greedy:pass",
        nodeId: "greedy",
        shader,
        target: "output",
        textures: Array.from({ length: textureCount }, (_, index) => ({ binding: `t${index}`, resourceId: "source" })),
      },
      // A binding the shader never declared: vgpu refuses it on the CPU side, which stops the
      // whole build AFTER the pass above has been handed to the device.
      ...(unwirable
        ? [
            {
              kind: "effect",
              id: "lost:pass",
              nodeId: "lost",
              shader: `@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}`,
              target: "output",
              textures: [{ binding: "undeclared", resourceId: "source" }],
            },
          ]
        : []),
    ],
  } as unknown as LogicalExecutionPlan;
}

async function compileRefused(
  body: string,
  unwirable = false,
): Promise<{ diagnostics: RuntimeDiagnostic[]; granted: number }> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  try {
    const capabilities = await backend.initialize({});
    const granted = capabilities.limits["maxSampledTexturesPerShaderStage"] ?? 16;
    await expect(backend.compile(greedyPlan(granted + 1, body, unwirable))).rejects.toBeDefined();
    // Anything left on the device's uncaptured path lands a turn after the compile rejects.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { diagnostics, granted };
  } finally {
    backend.dispose();
  }
}

describe("what the device says while a pass is built is told on that pass's node (T1521b, §V27)", () => {
  it("a layout over the device limit is the failure's reason when the WGSL itself is clean", async () => {
    const { diagnostics, granted } = await compileRefused("vec4f");
    // ONE row, on the node, and it says which limit — not that something earlier went wrong.
    expect(diagnostics.map((d) => [d.code, d.nodeId])).toEqual([[BackendDiagnosticCode.compileFailed, "greedy"]]);
    expect(diagnostics[0]!.message).toContain(
      `The number of sampled textures (${granted + 1}) in the Fragment stage exceeds the maximum per-stage limit (${granted})`,
    );
  }, 60_000);

  it("a layout error is NOT dropped because the same pass also has a WGSL error to report", async () => {
    const { diagnostics, granted } = await compileRefused("notAFunction");
    const said = diagnostics.map((d) => [d.code, d.nodeId]);
    // Two different errors, two rows, and both name the node: the compiler's is the reason
    // the pass failed, and the layout's is not swallowed as if it were a restatement of it.
    expect(said).toContainEqual([BackendDiagnosticCode.compileFailed, "greedy"]);
    expect(said).toContainEqual([BackendDiagnosticCode.frameError, "greedy"]);
    expect(diagnostics.filter((d) => d.nodeId !== "greedy")).toEqual([]);
    const failure = diagnostics.find((d) => d.code === BackendDiagnosticCode.compileFailed)!;
    expect(failure.message).toContain("unresolved call target 'notAFunction'");
    const layout = diagnostics.find((d) => d.code === BackendDiagnosticCode.frameError)!;
    expect(layout.message).toContain(
      `The number of sampled textures (${granted + 1}) in the Fragment stage exceeds the maximum per-stage limit (${granted})`,
    );
  }, 60_000);

  it("and is still told when another pass stops the build before any verdict is read", async () => {
    const { diagnostics, granted } = await compileRefused("vec4f", true);
    // The build threw on the pass it could not wire, and that is said…
    expect(diagnostics.map((d) => [d.code, d.nodeId])).toContainEqual([BackendDiagnosticCode.planInvalid, "lost"]);
    // …and so is what the device had already caught for the other one, on ITS node. The
    // scope took that error off the uncaptured path; a build that throws must not be the
    // place it then disappears.
    const layout = diagnostics.filter((d) => d.nodeId === "greedy");
    expect(layout.map((d) => d.code)).toEqual([BackendDiagnosticCode.frameError]);
    expect(layout[0]!.message).toContain(
      `The number of sampled textures (${granted + 1}) in the Fragment stage exceeds the maximum per-stage limit (${granted})`,
    );
  }, 60_000);
});

/**
 * T1522b — A BROKEN COMPUTE SHADER IS ITS NODE'S FAILURE, NOT A NODELESS ERROR.
 *
 * vgpu builds a dispatch's module and pipeline directly: no shared cache, and no error scope
 * of its own around either. A kernel that parses and then fails at the device — a call to a
 * function that does not exist — therefore said nothing through the pipeline path at all.
 * The compile SUCCEEDED, the broken program was installed over the last good one (§V9), and
 * the device's objections arrived on the uncaptured path naming no node.
 *
 * The kernel is the author's text inside a GENERATED module, so the position the device
 * reports is that module's (line 84 here). T1523b: the badge reads the AUTHOR'S position —
 * line 3 of the kernel parameter, column 16, where `notAFunction` is in `BROKEN_KERNEL` —
 * through the pass's source map, and the generated line is asserted to be a different one
 * so this cannot pass on a map that changes nothing.
 */
const BROKEN_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = notAFunction(p.position);
  return q;
}`;

function brokenKernelPlan() {
  return compileGraph({
    graph: {
      revision: 1,
      nodes: {
        sim: {
          id: "sim",
          type: "pointKernel",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { capacity: 8, seed: 7, kernel: BROKEN_KERNEL },
        },
        draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8, sizePixels: 6 } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    },
    settings: {
      outputResolution: { width: 64, height: 64 },
      workingFormat: "rgba8unorm",
      randomSeed: 7,
      previewLongEdge: 192,
      previewFps: 20,
      limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
    },
    registry: createNodeRegistry(allNodeDefinitions).view(),
    capabilities: {
      tier: "B",
      features: [],
      formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
      timestampQuery: false,
      limits: { maxTextureDimension2D: 8192 },
    },
  });
}

describe("a broken dispatch shader fails the compile on its own node (T1522b, §V27)", () => {
  it("names the node, the pass and the unresolved symbol, and nothing is left nodeless", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const plan = brokenKernelPlan();
    // The graph compiler does not parse WGSL: this failure can only happen at the device.
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const kernel = (plan.passes as ReadonlyArray<{ id: string; kind: string; nodeId?: string; shader?: string }>).find(
      (pass) => pass.kind === "dispatch" && pass.nodeId === "sim" && pass.shader?.includes("notAFunction") === true,
    );
    if (kernel?.shader === undefined) throw new Error("the kernel's dispatch pass is not in the plan");
    const lines = kernel.shader.split("\n");
    const generatedLine = lines.findIndex((text) => text.includes("notAFunction")) + 1;
    const authored = BROKEN_KERNEL.split("\n");
    const line = authored.findIndex((text) => text.includes("notAFunction"));
    expect([line + 1, authored[line]!.indexOf("notAFunction") + 1]).toEqual([3, 16]);
    // The precondition that makes the claim worth asserting: the module moved the line.
    expect(generatedLine).toBeGreaterThan(3);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      await backend.initialize({});
      // §V9: a program whose kernel cannot run is not installed over the one that could.
      await expect(backend.compile(plan)).rejects.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(diagnostics.filter((d) => d.severity !== "info").map((d) => [d.code, d.nodeId, d.message])).toEqual([
        [
          BackendDiagnosticCode.compileFailed,
          "sim",
          `Pass "${kernel.id}" failed to compile on the device: kernel 3:16 unresolved call target 'notAFunction'`,
        ],
      ]);
      // What the code pane marks: the kernel parameter, at the author's line and column.
      expect(diagnostics.find((d) => d.nodeId === "sim")?.source).toEqual({ file: "kernel", line: 3, column: 16 });
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
