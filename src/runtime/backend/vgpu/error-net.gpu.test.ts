import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { BackendDiagnosticCode } from "../diagnostics.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T327, pinned on the B33 shape that motivated it: a dispatch binding MORE storage
 * buffers than the device granted. Before the persistent error net, such a plan
 * compiled, "rendered", and reported NOTHING — the pipeline failed lazily at first
 * dispatch, after B9's compile-window listener had unsubscribed, and the device's
 * verdict went to an unheard gpu.onError.
 *
 * T338 note: the overflow is built against the NEGOTIATED limit read off the live
 * device, not a hardcoded 9-vs-8 — the raised-limits work made the old fixed repro
 * legal, which is the feature working, not the test rotting.
 *
 * T1522b moved that shape out from under the net: a dispatch is now built inside a device
 * error scope, so the refused layout fails the COMPILE, under the pass's id, and the
 * broken program is never installed (§V9). That is the first test below. The net is still
 * what catches a verdict the build cannot draw out — one the device only reaches when the
 * pass RUNS — and the second test pins it on exactly such a shape.
 */

function overboundPlan(bufferCount: number): LogicalExecutionPlan {
  const declarations = Array.from(
    { length: bufferCount },
    (_, index) => `@group(0) @binding(${index + 1}) var<storage, read_write> b${index}: array<u32>;`,
  ).join("\n");
  const sum = Array.from({ length: bufferCount - 1 }, (_, index) => `b${index + 1}[gid.x]`).join(" + ");
  const shader = `
${declarations}
struct P { count: u32, };
@group(0) @binding(0) var<uniform> params: P;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) { return; }
  b0[gid.x] = ${sum};
}`;
  return {
    id: "b33",
    resources: Array.from({ length: bufferCount }, (_, index) => ({
      kind: "buffer",
      id: `buffer:${index}`,
      stride: 4,
      capacity: 64,
      usage: "storage",
    })),
    passes: [
      {
        kind: "dispatch",
        id: "overbound",
        nodeId: "kernel",
        shader,
        entryPoint: "main",
        workgroups: [1, 1, 1],
        buffers: Array.from({ length: bufferCount }, (_, index) => ({
          binding: `b${index}`,
          resourceId: `buffer:${index}`,
        })),
        uniforms: { count: 64 },
        uniformBinding: "params",
      },
    ],
  } as unknown as LogicalExecutionPlan;
}

/**
 * A pass the device accepts when it is BUILT and refuses when it RUNS: the shader reads an
 * unsigned-integer texture and the target bound to it holds floats. Module, layout and
 * pipeline are all valid; the bind group, which vgpu creates at the first encode, is not.
 *
 * T1705b: through vgpu 0.5.0 this was a storage buffer smaller than the block the shader
 * declared. vgpu 0.6.0 checks a buffer binding's size when it is set and refuses that plan
 * at the build, so the shape that still waits for the frame is a texture of the wrong type.
 */
function mistypedPlan(): LogicalExecutionPlan {
  return {
    id: "mistyped",
    resources: [
      { kind: "target", id: "source", size: [8, 8], format: "rgba8unorm" },
      { kind: "target", id: "output", size: [8, 8], format: "rgba8unorm" },
    ],
    passes: [
      {
        kind: "effect",
        id: "mistyped",
        shader: `@group(0) @binding(0) var counts: texture_2d<u32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(vec4u(textureLoad(counts, vec2i(0), 0)));
}`,
        target: "output",
        textures: [{ binding: "counts", resourceId: "source" }],
      },
    ],
  } as unknown as LogicalExecutionPlan;
}

describe("the persistent GPU error net (T327/B33)", () => {
  it("the B33 shape no longer reaches a frame: the compile is refused under the pass that overbound (T1522b)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const granted = capabilities.limits["maxStorageBuffersPerShaderStage"] ?? 8;
      await expect(backend.compile(overboundPlan(granted + 1))).rejects.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // One row, on the node, and it is the limit — said before anything was installed.
      expect(diagnostics.map((d) => [d.code, d.nodeId])).toEqual([[BackendDiagnosticCode.compileFailed, "kernel"]]);
      expect(diagnostics[0]!.message).toContain(
        `Pass "overbound" failed to compile on the device: The number of storage buffers (${granted + 1}) in the Compute stage exceeds the maximum per-stage limit (${granted})`,
      );
    } finally {
      backend.dispose();
    }
  });

  it("a lazily-failing pass reports through the hub instead of rendering nothing silently", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      // The build has nothing to object to: this is the case the net exists for.
      const compiled = await backend.compile(mistypedPlan());
      expect(errors).toEqual([]);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });

      // The verdict is asynchronous: poll bounded (the honest V144 shape) rather than
      // sleeping a magic amount or asserting on a race.
      const deadline = Date.now() + 2000;
      while (errors.length === 0 && Date.now() < deadline) {
        // A readback is a full GPU round-trip; it drains the error delivery too.
        await backend.readOutput("output").catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(errors.length, "the device's validation verdict must reach the hub").toBeGreaterThan(0);
      expect(errors.join("\n")).toContain("match the expected sample types (Uint)");
    } finally {
      backend.dispose();
    }
  });
});
