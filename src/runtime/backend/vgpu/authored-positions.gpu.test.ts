import { beforeAll, describe, expect, it } from "vitest";
import { init } from "vgpu/node";

import { compileGraph } from "../../../compiler/index.ts";
import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { SHARED_WGSL_MODULES } from "../../../nodes/shaders/shared-modules.ts";
import { BackendDiagnosticCode } from "../diagnostics.ts";
import type { DeviceLossInfo, GpuHost, GpuSession } from "./gpu-host.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T1523b — A SHADER ERROR IS REPORTED ON THE AUTHOR'S LINE, AND ON ITS NODE, FROM EVERY BUILD.
 *
 * (a) The device's compiler counts lines in the module it was handed, and a node rarely
 *     hands it the author's text alone: a Custom WGSL puts its `// @use` modules in front,
 *     a point kernel wraps its body in generated code and hoists its `struct Params` above
 *     that. Each case below is the literal error through compiler + backend + Dawn, and
 *     asserts the AUTHOR'S `parameter line:col` — with the generated line asserted to be a
 *     different one, so a map that does nothing cannot pass.
 * (b) A preview program's build and the device-loss rebuild used to leave their device
 *     errors nodeless. Each now reaches the problems tab on its pass's node.
 * (c) An error that exists only in vgpu's combined module is stated by the device once;
 *     its reason must survive to a later compile of the same bytes.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

/** Everything the problems tab was told that is not an info row, as (code, node, message). */
const told = (diagnostics: readonly RuntimeDiagnostic[]): ReadonlyArray<readonly [string, string | undefined, string]> =>
  diagnostics.filter((d) => d.severity !== "info").map((d) => [d.code, d.nodeId, d.message] as const);

/** The 1-based line and column of `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; column: number } {
  const lines = text.split("\n");
  const line = lines.findIndex((entry) => entry.includes(needle));
  if (line < 0) throw new Error(`"${needle}" is not in the text`);
  return { line: line + 1, column: lines[line]!.indexOf(needle) + 1 };
}

function pointsGraph(type: "pointKernel" | "pointKernelAdvanced", parameters: Record<string, unknown>): GraphDocument {
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

function customGraph(source: string, nodeId = "fx"): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      [nodeId]: { id: nodeId, type: "customWgsl", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: { source } },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId, portId: "input" } },
      e2: { id: "e2", source: { nodeId, portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

/** The node's device-side failure for `graph`, plus the pass the plan built for it. */
async function refusal(
  graph: GraphDocument,
  passId: (id: string) => boolean,
): Promise<{ diagnostics: RuntimeDiagnostic[]; pass: { id: string; shader: string } }> {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  try {
    const capabilities = await backend.initialize({});
    const plan = compileGraph({ graph, settings, registry, capabilities });
    // The graph compiler does not parse WGSL: each failure here can only happen at the device.
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const pass = (plan.passes as ReadonlyArray<{ id: string; shader?: string }>).find((entry) => passId(entry.id));
    if (pass?.shader === undefined) throw new Error("the pass under test is not in the plan");
    await expect(backend.compile(plan)).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { diagnostics, pass: { id: pass.id, shader: pass.shader } };
  } finally {
    backend.dispose();
  }
}

/** A kernel in the shipped shape: its own `struct Params` block in front of `process`. */
const PARAMS_KERNEL = `// Drift, scaled by a knob.
struct Params {
  // How fast. @default 1
  speed: f32,
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = notAFunction(p.position) * ctx.params.speed;
  return q;
}`;

const PLAIN_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  return p;
}`;

describe("a device error is reported on the author's line (T1523b(a), §V27)", () => {
  it("a point kernel whose `struct Params` was hoisted out of it: the line after the struct", async () => {
    const { diagnostics, pass } = await refusal(pointsGraph("pointKernel", { kernel: PARAMS_KERNEL }), (id) =>
      id.endsWith(":kernel"),
    );
    const authored = positionOf(PARAMS_KERNEL, "notAFunction");
    expect(authored).toEqual({ line: 9, column: 16 });
    expect(positionOf(pass.shader, "notAFunction").line).not.toBe(authored.line);
    expect(told(diagnostics)).toEqual([
      [
        BackendDiagnosticCode.compileFailed,
        "sim",
        `Pass "${pass.id}" failed to compile on the device: kernel 9:16 unresolved call target 'notAFunction'`,
      ],
    ]);
    expect(diagnostics.find((d) => d.nodeId === "sim")?.source).toEqual({ file: "kernel", line: 9, column: 16 });
  }, 60_000);

  it("a group predicate: its own parameter, its own line, the column inside the predicate", async () => {
    const group = "\n  notAFunction(p.position.x) > 0.0";
    const { diagnostics, pass } = await refusal(pointsGraph("pointKernel", { kernel: PLAIN_KERNEL, group }), (id) =>
      id.endsWith(":kernel"),
    );
    expect(positionOf(pass.shader, "notAFunction").line).not.toBe(2);
    expect(told(diagnostics)).toEqual([
      [
        BackendDiagnosticCode.compileFailed,
        "sim",
        `Pass "${pass.id}" failed to compile on the device: group 2:3 unresolved call target 'notAFunction'`,
      ],
    ]);
    expect(diagnostics.find((d) => d.nodeId === "sim")?.source).toEqual({ file: "group", line: 2, column: 3 });
  }, 60_000);

  it("a spawn hook: the hook's line, with the kernel's struct hoisted above it", async () => {
    const spawn = `
fn spawn(child: Point, ctx: PointCtx) -> Point {
  var c = child;
  c.position = notAFunction(c.position) * ctx.params.speed;
  return c;
}`;
    const kernel = PARAMS_KERNEL.replace("notAFunction(p.position)", "p.position");
    const { diagnostics, pass } = await refusal(pointsGraph("pointKernelAdvanced", { kernel, spawn }), (id) =>
      id.endsWith(":spawnHook"),
    );
    expect(positionOf(pass.shader, "notAFunction").line).not.toBe(4);
    expect(told(diagnostics)).toEqual([
      [
        BackendDiagnosticCode.compileFailed,
        "sim",
        `Pass "${pass.id}" failed to compile on the device: spawn 4:16 unresolved call target 'notAFunction'`,
      ],
    ]);
  }, 60_000);

  it("a Custom WGSL that pulls in a `// @use` module: the author's line, not the expansion's", async () => {
    const source = `// @use grid
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cell = gridCellAt(uv, vec2f(4.0, 4.0));
  return notAFunction(textureSample(inputTexture, inputSampler, cell.origin));
}`;
    expect(SHARED_WGSL_MODULES["grid"]).toBeDefined();
    const { diagnostics, pass } = await refusal(customGraph(source), (id) => id.endsWith(":custom"));
    expect(positionOf(source, "notAFunction")).toEqual({ line: 8, column: 10 });
    expect(positionOf(pass.shader, "notAFunction").line).toBeGreaterThan(8);
    expect(told(diagnostics)).toEqual([
      [
        BackendDiagnosticCode.compileFailed,
        "fx",
        `Pass "${pass.id}" failed to compile on the device: source 8:10 unresolved call target 'notAFunction'`,
      ],
    ]);
    expect(diagnostics.find((d) => d.nodeId === "fx")?.source).toEqual({ file: "source", line: 8, column: 10 });
  }, 60_000);

  it("a position in generated code says so, and is not pinned to an author line", async () => {
    // The kernel declares the generator's own `groupMatch`; the generated one, emitted AFTER
    // the kernel, is the redeclaration the device points at.
    const kernel = `${PLAIN_KERNEL}

fn groupMatch(p: Point, ctx: PointCtx) -> bool {
  return true;
}`;
    const { diagnostics, pass } = await refusal(
      pointsGraph("pointKernel", { kernel, group: "p.position.x > 0.0" }),
      (id) => id.endsWith(":kernel"),
    );
    const failures = diagnostics.filter((d) => d.code === BackendDiagnosticCode.compileFailed);
    expect(failures.map((d) => d.nodeId)).toEqual(["sim"]);
    expect(failures[0]!.message).toMatch(
      new RegExp(
        `^Pass "${pass.id}" failed to compile on the device: \\d+:\\d+ of the generated module \\(not your code\\) redeclaration of 'groupMatch'`,
      ),
    );
    expect(failures[0]!.source).toBeUndefined();
  }, 60_000);
});

/** A canvas the way vgpu's `surface()` uses one: real device, real texture, no compositor. */
function stubCanvas(device: GPUDevice): unknown {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: 8,
    height: 8,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(config: { format: string }) {
          texture?.destroy();
          texture = device.createTexture({ size: [8, 8], format: config.format as GPUTextureFormat, usage: 0x10 | 0x04 | 0x01 });
        },
        unconfigure() {},
        getCurrentTexture() {
          return texture;
        },
      };
    },
  };
  return canvas;
}

/** The Dawn host, with each session kept and the first one's loss in the test's hands. */
function controllableHost(second?: () => Promise<GpuSession>): {
  host: GpuHost;
  session: () => GpuSession | undefined;
  lose: (info: DeviceLossInfo) => void;
} {
  const base = nodeGpuHost();
  let current: GpuSession | undefined;
  let lose: (info: DeviceLossInfo) => void = () => {};
  let created = 0;
  return {
    host: {
      label: base.label,
      async create(options) {
        created += 1;
        if (created > 1 && second !== undefined) {
          current = await second();
          return current;
        }
        const real = await base.create(options);
        const lost = new Promise<DeviceLossInfo>((resolve) => {
          lose = resolve;
        });
        current = { ...real, deviceLost: lost, dispose: () => real.dispose() };
        return current;
      },
    },
    session: () => current,
    lose: (info) => lose(info),
  };
}

const BROKEN_LENS = `@group(0) @binding(0) var lensSampler: sampler;
@group(0) @binding(1) var lensTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return notAFunction(textureSample(lensTexture, lensSampler, uv));
}`;

describe("previews and the device-loss rebuild tell a build error on its node (T1523b(b), §V27, §V288)", () => {
  it("a preview program's broken pass is a compile failure on the previewed node, nothing nodeless", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const { host, session } = controllableHost();
    const backend = createVgpuBackend({ host });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      await backend.initialize({});
      const device = session()!.gpu.gpu as unknown as GPUDevice;
      const previews = backend.previewHost(stubCanvas(device) as never);
      previews.setPreviewProgram({
        resources: [
          { kind: "sampler", id: "lens:sampler", filter: "linear" },
          { kind: "target", id: "lens:source", size: [8, 8], format: "rgba8unorm" },
          { kind: "target", id: "lens:tile", size: [8, 8], format: "rgba8unorm" },
        ],
        passes: [
          {
            kind: "effect",
            id: "preview:lens",
            shader: BROKEN_LENS,
            target: "lens:tile",
            textures: [{ binding: "lensTexture", resourceId: "lens:source" }],
            samplers: [{ binding: "lensSampler", resourceId: "lens:sampler" }],
            nodeId: "lens",
          },
        ],
        signature: "broken-lens",
      } as never);
      await backend.whenSettled();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(told(diagnostics)).toEqual([
        [
          BackendDiagnosticCode.compileFailed,
          "lens",
          `Pass "preview:lens" failed to compile on the device: 6:10 unresolved call target 'notAFunction'`,
        ],
      ]);
      previews.dispose();
    } finally {
      backend.dispose();
    }
  }, 60_000);

  it("a pass the RESTORED device refuses is a compile failure on its node, nothing nodeless", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    // The replacement device is a plain one: WebGPU's default storage-buffer limit, where
    // the first was raised (T338). A dispatch over the default but within the raise
    // compiles on the first device and is refused by the second — the shape a restore onto
    // a lesser adapter takes.
    const plain = await init({ label: "loom-restored" });
    const fallback = plain.gpu.limits.maxStorageBuffersPerShaderStage;
    const { host, lose } = controllableHost(async () => ({
      gpu: plain,
      deviceLost: new Promise<DeviceLossInfo>(() => {}),
      dispose: () => plain.dispose(),
    }));
    const backend = createVgpuBackend({ host });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const granted = capabilities.limits["maxStorageBuffersPerShaderStage"] ?? 0;
      // §V854: the fixture can only fail if the first device really grants more.
      expect(granted).toBeGreaterThan(fallback);
      await backend.compile(overboundPlan(fallback + 1));
      expect(told(diagnostics)).toEqual([]);

      lose({ reason: "destroyed", message: "simulated" });
      const until = Date.now() + 10_000;
      while (!diagnostics.some((d) => d.code === BackendDiagnosticCode.deviceRestored) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const rows = told(diagnostics).filter(([code]) => code !== BackendDiagnosticCode.deviceLost);
      expect(rows.map(([code, nodeId]) => [code, nodeId])).toEqual([[BackendDiagnosticCode.compileFailed, "kernel"]]);
      expect(rows[0]![2]).toContain(
        `Pass "overbound" failed to compile on the device: The number of storage buffers (${fallback + 1}) in the Compute stage exceeds the maximum per-stage limit (${fallback})`,
      );
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

/** A dispatch binding `bufferCount` storage buffers — error-net.gpu.test.ts's B33 shape. */
function overboundPlan(bufferCount: number): LogicalExecutionPlan {
  const declarations = Array.from(
    { length: bufferCount },
    (_, index) => `@group(0) @binding(${index + 1}) var<storage, read_write> b${index}: array<u32>;`,
  ).join("\n");
  const sum = Array.from({ length: bufferCount - 1 }, (_, index) => `b${index + 1}[gid.x]`).join(" + ");
  return {
    id: "overbound",
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
        shader: `
${declarations}
struct P { count: u32, };
@group(0) @binding(0) var<uniform> params: P;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) { return; }
  b0[gid.x] = ${sum};
}`,
        entryPoint: "main",
        workgroups: [1, 1, 1],
        buffers: Array.from({ length: bufferCount }, (_, index) => ({ binding: `b${index}`, resourceId: `buffer:${index}` })),
        uniforms: { count: 64 },
        uniformBinding: "params",
      },
    ],
  } as unknown as LogicalExecutionPlan;
}

describe("an error only vgpu's combined module has keeps its reason (T1523b(c))", () => {
  it("a later compile of the same bytes is told what the device said the first time", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    // Valid WGSL on its own; it collides with the fullscreen vertex stage vgpu puts in front.
    const source = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

struct VgpuFullscreenVertexOut {
  x: f32,
};

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      await expect(backend.compile(compileGraph({ graph: customGraph(source, "first"), settings, registry, capabilities }))).rejects.toBeDefined();
      const first = diagnostics.filter((d) => d.code === BackendDiagnosticCode.compileFailed);
      expect(first.map((d) => d.nodeId)).toEqual(["first"]);
      expect(first[0]!.message).toContain("VgpuFullscreenVertexOut");

      // The same bytes on another node: vgpu hands back its cached invalid module and the
      // device says only "invalid due to a previous error".
      await expect(backend.compile(compileGraph({ graph: customGraph(source, "again"), settings, registry, capabilities }))).rejects.toBeDefined();
      const later = diagnostics.slice(diagnostics.indexOf(first[0]!) + 1).filter((d) => d.code === BackendDiagnosticCode.compileFailed);
      expect(later.map((d) => d.nodeId)).toEqual(["again"]);
      expect(later[0]!.message).toContain("VgpuFullscreenVertexOut");
      expect(later[0]!.message.slice(later[0]!.message.indexOf(": ") + 2)).toBe(
        first[0]!.message.slice(first[0]!.message.indexOf(": ") + 2),
      );
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
