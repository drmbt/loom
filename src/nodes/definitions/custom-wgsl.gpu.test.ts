import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { BackendDiagnosticCode } from "../../runtime/backend/diagnostics.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { customWgslNode } from "./custom-wgsl.ts";
import { outputNode } from "./output.ts";
import { solidNode } from "./solid.ts";
import { SHARED_WGSL_MODULES } from "../shaders/shared-modules.ts";

/**
 * B7 / T166 on a real device.
 *
 * Every other test for this node checks the PLAN — that the pass carries `uniformBinding`
 * and `sharedBinding`. That is necessary and not sufficient: the runtime resolves both by
 * NAME against the shader's own reflection and refuses a value whose name the source never
 * declared. So a default source and a compile() that agree with each other but disagree
 * with the runtime would pass every plan-level assertion and then fail at the one moment
 * that matters — the first time anyone drops a Custom WGSL node into a graph.
 *
 * Building the plan on Dawn is what closes that gap: `backend.compile` reflects the source,
 * builds the bind group and compiles the pipeline, so a wrong name, a malformed struct or a
 * binding declared in the shader but never bound all surface here as a diagnostic.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

/** Solid -> CustomWGSL (default source) -> Output. */
function graph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      source: { id: "source", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      fx: { id: "fx", type: "customWgsl", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "source", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("the default custom kernel builds on a real device (B7/T166)", () => {
  it("binds inputTexture, inputSampler, params and the shared frame block", async () => {
    // Dawn is required, not optional: skipping here would turn the one test that can see
    // this failure mode into a green tick on every machine that lacks a GPU.
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const plan = compileGraph({
        graph: graph(),
        settings,
        registry: createNodeRegistry([solidNode, customWgslNode, outputNode]).view(),
        capabilities,
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

      // The claim under test. A name the shader does not declare, or a declared block the
      // pass forgets to bind, fails inside here.
      await backend.compile(plan);
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

/**
 * T1286 ON A REAL DEVICE: AN IMPORT IS A PASTE, IN PIXELS.
 *
 * The string half of this claim is in `custom-wgsl.test.ts` — the expansion is byte-exactly
 * the module followed by the author's own text. That is necessary and not sufficient for
 * the row's actual promise, which is about what comes out of the GPU: a source that pulls a
 * module in has to render what the same source with the code pasted into it renders, or
 * "shared" means "similar" and every future module is a place a picture can drift.
 *
 * Byte-identical rather than close: both arms compile through Dawn, run the same pass on
 * the same input at the same seed, and the readback is compared with `Buffer.compare`. A
 * tolerance here would be a way of not noticing that the mechanism moved something.
 */
const GRID_BODY = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cell = gridCellAt(uv, vec2f(7.0, 5.0));
  let tint = textureSample(inputTexture, inputSampler, cell.origin + cell.size * 0.5);
  return vec4f(cell.local.x, cell.local.y, cell.index / cell.count, 1.0) * tint;
}`;

async function shadeWith(source: string): Promise<Uint8Array> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    const capabilities = await backend.initialize({});
    const document = graph();
    (document.nodes["fx"]!.parameters as Record<string, unknown>)["source"] = source;
    const plan = compileGraph({
      graph: document,
      settings,
      registry: createNodeRegistry([solidNode, customWgslNode, outputNode]).view(),
      capabilities,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
      pointer: { x: 0.5, y: 0.5, buttons: 0 },
      resolution: [settings.outputResolution.width, settings.outputResolution.height],
    });
    const output = plan.outputs[0];
    if (output === undefined) throw new Error("no output resource");
    const readback = await backend.readOutput(output.resourceId);
    return new Uint8Array(readback.bytes);
  } finally {
    backend.dispose();
  }
}

describe("shared WGSL modules render what a paste renders (T1286)", () => {
  it("`// @use grid` is byte-identical to the module pasted in by hand", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const imported = await shadeWith(`// @use grid\n${GRID_BODY}`);
    const pasted = await shadeWith(`${SHARED_WGSL_MODULES["grid"]!.source}\n\n${GRID_BODY}`);
    expect(imported.length).toBeGreaterThan(0);
    // Not "the same mean", not "within a tolerance": the same bytes (§V147).
    expect(Buffer.compare(imported, pasted)).toBe(0);
  }, 120_000);
});

/**
 * B229 ON A REAL DEVICE: A BROKEN SHADER IS BLAMED ON THE NODE THAT HOLDS IT.
 *
 * Every Custom WGSL pass carries the same human label, and Dawn reports a failed pipeline
 * under the label it was built with — so a failure attributed through that label named the
 * FIRST Custom WGSL in the plan, a node that compiled fine (§V27). The broken shader here
 * is the SECOND of two, and it has to parse: vgpu reflects WGSL before Dawn sees it, and a
 * reflection failure is caught synchronously with the right node already. A call to a
 * function that does not exist parses and fails only at the device, the path the bug was on.
 */
const BROKEN_BODY = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return notAFunction(uv) * textureSample(inputTexture, inputSampler, uv);
}`;

/** Solid -> fine (default source) -> broken -> Output. */
function twoCustomGraph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      source: { id: "source", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      fine: { id: "fine", type: "customWgsl", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
      broken: {
        id: "broken",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: 400, y: 0 },
        parameters: { source: BROKEN_BODY },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 600, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "source", portId: "out" }, target: { nodeId: "fine", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fine", portId: "out" }, target: { nodeId: "broken", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "broken", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

describe("a device compile failure names the node whose shader failed (B229, §V27)", () => {
  it("the second of two Custom WGSL nodes breaks, and the problem names it — not the first", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const plan = compileGraph({
        graph: twoCustomGraph(),
        settings,
        registry: createNodeRegistry([solidNode, customWgslNode, outputNode]).view(),
        capabilities,
      });
      // The graph compiler does not parse WGSL: this failure can only happen at the device.
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      // Both passes are in the plan, the fine one FIRST — the order a label lookup got wrong.
      const custom = (plan.passes as ReadonlyArray<{ readonly id: string; readonly nodeId?: string }>).filter(
        (pass) => pass.nodeId === "fine" || pass.nodeId === "broken",
      );
      expect(custom.map((pass) => pass.nodeId)).toEqual(["fine", "broken"]);
      const brokenPassId = custom[1]!.id;

      await expect(backend.compile(plan)).rejects.toBeDefined();

      const failures = diagnostics.filter((d) => d.code === BackendDiagnosticCode.compileFailed);
      expect(failures.length, "the device failure reached the problems tab").toBeGreaterThan(0);
      // What the problems tab and the node badge read: the node that holds the broken shader.
      expect(failures.map((d) => d.nodeId)).toEqual(failures.map(() => "broken"));
      expect(failures.map((d) => d.message.startsWith(`Pass "${brokenPassId}" failed to compile`))).toEqual(
        failures.map(() => true),
      );
      // And nothing is pinned on the node that compiled fine.
      expect(diagnostics.filter((d) => d.nodeId === "fine")).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

/**
 * T1490b — TWO NODES, THE SAME BROKEN BYTES, AND BOTH ARE TOLD.
 *
 * The residual of B229. A copy-pasted Custom WGSL node carries its original's source to the
 * byte, and vgpu keys its pipeline cache on the source text: the second pass is handed the
 * first one's entry, so the device compiles once and reports once — under the pass that got
 * there first. The other node rendered nothing and said nothing (§V27): no badge, no row in
 * the problems tab, and fixing the one that WAS named left a second failure to be found.
 */

/** Solid -> first (broken) -> second (the same broken bytes) -> Output. */
function twinBrokenGraph(): GraphDocument {
  const twin = (id: string, x: number): GraphDocument["nodes"][string] => ({
    id,
    type: "customWgsl",
    definitionVersion: 1,
    position: { x, y: 0 },
    parameters: { source: BROKEN_BODY },
  });
  return {
    revision: 1,
    nodes: {
      source: { id: "source", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      first: twin("first", 200),
      second: twin("second", 400),
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 600, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "source", portId: "out" }, target: { nodeId: "first", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "first", portId: "out" }, target: { nodeId: "second", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "second", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

describe("every node sharing a broken shader carries the failure (T1490b, §V27)", () => {
  it("two Custom WGSL nodes with byte-identical broken source are each named by their own diagnostic", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const plan = compileGraph({
        graph: twinBrokenGraph(),
        settings,
        registry: createNodeRegistry([solidNode, customWgslNode, outputNode]).view(),
        capabilities,
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const custom = (plan.passes as ReadonlyArray<{ readonly id: string; readonly nodeId?: string }>).filter(
        (pass) => pass.nodeId === "first" || pass.nodeId === "second",
      );
      expect(custom.map((pass) => pass.nodeId)).toEqual(["first", "second"]);

      await expect(backend.compile(plan)).rejects.toBeDefined();

      const failures = diagnostics.filter((d) => d.code === BackendDiagnosticCode.compileFailed);
      // What the badges read: ONE failure per node that holds the broken shader, each under
      // its own pass id — neither node is left to render nothing in silence, and neither
      // is told twice.
      expect(failures.map((d) => d.nodeId).sort()).toEqual(["first", "second"]);
      for (const pass of custom) {
        const own = failures.filter((d) => d.nodeId === pass.nodeId);
        expect(own.map((d) => d.message.startsWith(`Pass "${pass.id}" failed to compile`))).toEqual([true]);
      }
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

/**
 * T1521b — THE BADGE SAYS WHAT IS WRONG WITH THE SHADER.
 *
 * A failed pipeline's own device message is `[Invalid ShaderModule "…"] is invalid due to a
 * previous error` — true, and no use to whoever has to fix the shader. The previous error,
 * the one with the symbol and the position, was raised when the MODULE was created, outside
 * the pipeline's error scope, and so arrived as a second diagnostic naming no node at all:
 * the node said "something earlier went wrong" and a nodeless row said what, with nothing
 * tying the two together (§V27).
 *
 * `BROKEN_BODY` calls `notAFunction` on its line 6, column 10. That is the position asserted,
 * and it is the AUTHOR'S: the module the device actually compiled has vgpu's vertex stage in
 * front of this text and reports the same call on its line 19. T1523b names the code
 * parameter the position is in (`source`), read off the pass's source map.
 */
const BROKEN_REASON = "source 6:10 unresolved call target 'notAFunction'";

/** Everything the problems tab was told, as (code, node, message) — nothing filtered out. */
const told = (diagnostics: readonly RuntimeDiagnostic[]): ReadonlyArray<readonly [string, string | undefined, string]> =>
  diagnostics.map((d) => [d.code, d.nodeId, d.message] as const);

const customPassId = (plan: { readonly passes: ReadonlyArray<unknown> }, nodeId: string): string => {
  const pass = (plan.passes as ReadonlyArray<{ readonly id: string; readonly nodeId?: string }>).find(
    (candidate) => candidate.nodeId === nodeId,
  );
  if (pass === undefined) throw new Error(`no pass for node "${nodeId}"`);
  return pass.id;
};

describe("a compile-failed diagnostic carries the compiler's own message (T1521b, §V27)", () => {
  it("names the unresolved symbol and its line on the broken node, and says it once", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const registry = createNodeRegistry([solidNode, customWgslNode, outputNode]).view();
      const plan = compileGraph({ graph: twoCustomGraph(), settings, registry, capabilities });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

      await expect(backend.compile(plan)).rejects.toBeDefined();

      // What the badge reads — the symbol and where it is — and the WHOLE of what was said:
      // one row, on the node. No second row repeating the reason without saying whose it is,
      // and none repeating it on the node either.
      expect(told(diagnostics)).toEqual([
        [
          BackendDiagnosticCode.compileFailed,
          "broken",
          `Pass "${customPassId(plan, "broken")}" failed to compile on the device: ${BROKEN_REASON}`,
        ],
      ]);

      // The same broken bytes on another node, compiled LATER: vgpu still holds the invalid
      // module for that source, so the device raises no parse error this time — and the node
      // is owed the reason all the same.
      const later = twoCustomGraph();
      later.nodes["again"] = { ...later.nodes["broken"]!, id: "again" };
      delete later.nodes["broken"];
      later.edges["e2"] = { id: "e2", source: { nodeId: "fine", portId: "out" }, target: { nodeId: "again", portId: "input" } };
      later.edges["e3"] = { id: "e3", source: { nodeId: "again", portId: "out" }, target: { nodeId: "out", portId: "input" } };
      const laterPlan = compileGraph({ graph: later, settings, registry, capabilities });
      await expect(backend.compile(laterPlan)).rejects.toBeDefined();
      expect(told(diagnostics.slice(1))).toEqual([
        [
          BackendDiagnosticCode.compileFailed,
          "again",
          `Pass "${customPassId(laterPlan, "again")}" failed to compile on the device: ${BROKEN_REASON}`,
        ],
      ]);
    } finally {
      backend.dispose();
    }
  }, 60_000);

  it("tells both of two byte-identical broken nodes the same reason", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const plan = compileGraph({
        graph: twinBrokenGraph(),
        settings,
        registry: createNodeRegistry([solidNode, customWgslNode, outputNode]).view(),
        capabilities,
      });
      await expect(backend.compile(plan)).rejects.toBeDefined();

      // Only the first of the twins ever had its module created, so only its scope caught
      // anything; the reason is asked of the SOURCE, which both of them hold.
      expect(told(diagnostics)).toEqual(
        ["first", "second"].map((nodeId) => [
          BackendDiagnosticCode.compileFailed,
          nodeId,
          `Pass "${customPassId(plan, nodeId)}" failed to compile on the device: ${BROKEN_REASON}`,
        ]),
      );
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
