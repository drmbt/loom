import { beforeAll, describe, expect, it } from "vitest";

import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";

/**
 * §T1507b — A BROKEN SHADER BUILT AHEAD IS STILL REPORTED BY THE SWITCH THAT BRINGS IT IN.
 *
 * The warm-up builds a bypassed Layer's passes before anyone asked for them, inside its own
 * device error scope, and says nothing about what fails: an off layer is not a problem.
 * But building a shader module is not free of consequences — vgpu keeps the module it made
 * under those bytes, INVALID ones included, and the device states a module's error only
 * when it is created. If the warm-up swallowed that, the compile that later switches the
 * layer on would build from vgpu's cached module, its own scope would catch nothing, and
 * the node would be told "invalid due to a previous error" instead of why (T1521b,
 * T1523b(c)).
 *
 * So the contract is: what the switch reports is what a backend that never warmed reports
 * for the same compile, entry for entry — for an ordinary WGSL error, and for the one only
 * vgpu's combined module has (a name colliding with its fullscreen vertex stage), whose
 * reason the device states exactly once. And nothing is reported by the warm-up itself.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const SIZE = 4;
const COLOR_WGSL = `struct Params { color: vec4f };
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return params.color; }`;

/** An undefined identifier: the pass's own text does not compile. */
const BROKEN_WGSL = `@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return colour; }`;

/** Valid on its own; collides with the fullscreen vertex stage vgpu puts in front (T1523b(c)). */
const COLLIDING_WGSL = `struct VgpuFullscreenVertexOut {
  x: f32,
};
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }`;

function plan(passes: Readonly<Record<string, string>>): LogicalExecutionPlan {
  const ids = Object.keys(passes);
  return {
    resources: ids.map((id) => ({ kind: "target", id, size: [SIZE, SIZE], format: "rgba8unorm" })),
    passes: ids.map((id) => ({
      kind: "effect",
      id,
      nodeId: `n-${id}`,
      shader: passes[id],
      target: id,
      ...(passes[id] === COLOR_WGSL ? { uniformBinding: "params", uniforms: { color: [1, 0, 0, 1] } } : {}),
    })),
    diagnostics: [],
  } as unknown as LogicalExecutionPlan;
}

async function stage() {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const reported: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((entry) => {
    if (entry.severity !== "info") reported.push(entry);
  });
  await backend.initialize({});
  return { backend, reported };
}

const said = (entries: readonly RuntimeDiagnostic[]) =>
  entries.map((entry) => ({ severity: entry.severity, code: entry.code, nodeId: entry.nodeId, message: entry.message }));

describe("§T1507b — the warm-up never takes a shader error away from the compile that meets it", () => {
  for (const [name, shader, reason] of [
    ["an ordinary WGSL error", BROKEN_WGSL, "colour"],
    ["an error only vgpu's combined module has", COLLIDING_WGSL, "VgpuFullscreenVertexOut"],
  ] as const) {
    it(`${name}: the switch reports what a backend that never warmed reports`, async () => {
      const off = plan({ a: COLOR_WGSL });
      const on = plan({ a: COLOR_WGSL, b: shader });
      const warmed = await stage();
      const cold = await stage();
      try {
        await warmed.backend.compile(off);
        await cold.backend.compile(off);

        // The warm-up holds nothing it could not build, and says nothing about it.
        expect(await warmed.backend.warmPasses!(on)).toEqual([]);
        expect(said(warmed.reported)).toEqual([]);

        await expect(warmed.backend.compile(on)).rejects.toBeDefined();
        await expect(cold.backend.compile(on)).rejects.toBeDefined();
        expect(said(cold.reported).some((entry) => entry.nodeId === "n-b" && entry.message.includes(reason))).toBe(true);
        expect(said(warmed.reported)).toEqual(said(cold.reported));
      } finally {
        warmed.backend.dispose();
        cold.backend.dispose();
      }
    }, 60_000);
  }
});
