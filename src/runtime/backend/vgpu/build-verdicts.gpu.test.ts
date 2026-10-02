import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
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
