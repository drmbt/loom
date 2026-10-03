// @vitest-environment jsdom
import { Buffer } from "node:buffer";

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { useFrameLoop } from "../../app/use-frame-loop.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";
import { compileGraph, compileLayerWarmPlan } from "../../compiler/index.ts";
import type { CompiledGraph, CompileRequest } from "../../compiler/index.ts";
import type { BackendCapabilities, FrameInputs } from "../../domain/types/backend.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { setListDocument } from "../../examples/documents/set-list.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import type { LoomBackend } from "../../runtime/backend/index.ts";
import { probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { capturingHost } from "../../runtime/backend/vgpu/preview-synthesis-fixture.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import type { VgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";

/**
 * §T1507b — SWITCHING A BYPASSED LAYER ON BUILDS NOTHING ONCE ITS PASSES ARE WARM.
 *
 * A Layer that is off is bypassed, and the compiler prunes what only it reads (§T1498b), so
 * switching it on is a structural recompile that builds every pass it brings back. Measured
 * on Dawn for E82's FX layer (four passes): the switch's `backend.compile` was 11.4 ms the
 * first time and 9.2 ms every time after, against a ~2.3 ms frame — a module and pipeline
 * per new shader the first time, and vgpu's JS reflection of every new Effect's WGSL every
 * time. The warm-up builds those Effects ahead (`warm-effects.ts`) from the plan the graph
 * would have with its bypassed layers on (`compileLayerWarmPlan`), and the switch adopts
 * them.
 *
 * What a correct warm-up leaves behind, each read where its consumer reads it:
 *   - the switch's compile creates no shader module, no render pipeline and no bind group
 *     layout (each a new Effect's construction) — counted on the raw device, the one
 *     place every creation goes through, with a backend that never warmed as the case
 *     that DOES create them;
 *   - the pictures are byte-identical to a backend that never warmed, before and after the
 *     switch (§V147), and the warm-up submits, allocates and reads back nothing;
 *   - a layer that is deleted takes its warm entries with it.
 */

afterEach(cleanup);

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();
const SETTINGS = { ...setListDocument.settings, outputResolution: { width: 160, height: 90 } };

/** What a new Effect's construction and pipeline cost on the device. */
const CREATIONS = [
  "createShaderModule",
  "createRenderPipeline",
  "createRenderPipelineAsync",
  "createBindGroupLayout",
] as const;
type Creation = (typeof CREATIONS)[number];

interface Stage {
  readonly backend: VgpuBackend;
  /** Device creations since the last `count()` reset, by method. */
  counted(): Record<Creation, number>;
  resetCounts(): void;
  /** Lets every async pipeline vgpu is tracking land. */
  settled(): Promise<void>;
  reported: string[];
  dispose(): void;
}

async function stage(): Promise<Stage> {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const { host, session } = capturingHost();
  const backend = createVgpuBackend({ host });
  const reported: string[] = [];
  backend.onDiagnostic((entry) => {
    if (entry.severity !== "info") reported.push(`${entry.severity} ${entry.code}: ${entry.message}`);
  });
  await backend.initialize({});
  const active = session();
  if (active === undefined) throw new Error("the host produced no session");
  const device = (active.gpu.device as { gpu: GPUDevice }).gpu;
  const counts = Object.fromEntries(CREATIONS.map((name) => [name, 0])) as Record<Creation, number>;
  for (const name of CREATIONS) {
    const original = (device[name] as (...args: unknown[]) => unknown).bind(device);
    (device as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      counts[name] += 1;
      return original(...args);
    };
  }
  const gpu = active.gpu as unknown as { settled(): Promise<void> };
  return {
    backend,
    counted: () => ({ ...counts }),
    resetCounts: () => {
      for (const name of CREATIONS) counts[name] = 0;
    },
    settled: async () => {
      await gpu.settled();
      await gpu.settled();
    },
    reported,
    dispose: () => backend.dispose(),
  };
}

const NOTHING_CREATED: Record<Creation, number> = {
  createShaderModule: 0,
  createRenderPipeline: 0,
  createRenderPipelineAsync: 0,
  createBindGroupLayout: 0,
};

/** E82 with these layers off; the output node is the only sink, so a bypassed look is pruned. */
function setList(bypassed: readonly string[], edit?: (graph: GraphDocument) => void): GraphDocument {
  const graph = structuredClone(setListDocument.graph) as GraphDocument;
  for (const nodeId of bypassed) {
    const node = graph.nodes[nodeId]!;
    node.ui = { ...node.ui, bypassed: true };
  }
  edit?.(graph);
  return graph;
}

/** layerFx deleted, the stack rewired past it to `dim`. */
function deleteFx(graph: GraphDocument): void {
  delete graph.nodes["layerFx"];
  delete graph.edges["e3"];
  graph.edges["e4"] = { ...graph.edges["e4"]!, source: { nodeId: "layerGrid", portId: "out" } };
}

function request(graph: GraphDocument): CompileRequest {
  return { graph, settings: SETTINGS, registry, capabilities: CAPABILITIES, sinks: [] };
}

function compile(graph: GraphDocument): CompiledGraph {
  const plan = compileGraph(request(graph));
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return plan;
}

const passIds = (plan: CompiledGraph): string[] => plan.passes.map((pass) => pass.id);
const effectIds = (plan: CompiledGraph): Set<string> =>
  new Set(plan.passes.filter((pass) => pass.kind === "effect").map((pass) => pass.id));

function inputsAt(frameIndex: number): FrameInputs {
  return {
    frame: {
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      frameIndex,
      mode: "realtime",
      randomSeed: SETTINGS.randomSeed,
      absTimeSeconds: frameIndex / 60,
    },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [SETTINGS.outputResolution.width, SETTINGS.outputResolution.height],
  };
}

const resourceOf = (plan: CompiledGraph, nodeId: string): string => {
  const row = plan.outputs.find((output) => output.nodeId === nodeId);
  if (row === undefined) throw new Error(`no output row for ${nodeId}`);
  return row.resourceId;
};

async function picture(backend: LoomBackend, plan: CompiledGraph, nodeId = "out"): Promise<Buffer> {
  return Buffer.from((await backend.readOutput(resourceOf(plan, nodeId))).bytes);
}

describe("§T1507b — a bypassed layer's passes are built ahead of its switch-on", () => {
  it("E82: switching the FX layer on creates no module, pipeline or layout, and renders the same bytes", async () => {
    const off = compile(setList(["layerGrid", "layerFx"]));
    const fxOn = compile(setList(["layerGrid"]));
    // The switch is not trivially free: it brings back the glitch chain and the layer itself.
    const brought = passIds(fxOn).filter((id) => !passIds(off).includes(id));
    expect(brought.length).toBeGreaterThanOrEqual(4);

    const warmed = await stage();
    const cold = await stage();
    try {
      for (const live of [warmed, cold]) {
        const installed = await live.backend.compile(off);
        live.backend.render(installed, inputsAt(0));
      }

      // The warm-up, as the frame loop runs it after an install.
      const before = warmed.backend.status;
      const held = await warmed.backend.warmPasses!(compileLayerWarmPlan(request(setList(["layerGrid", "layerFx"]))));
      await warmed.settled();
      // It holds every pass the two layers would bring back, derived here from the shipped
      // document (both layers on) rather than from the warm plan — and nothing that plan
      // does not have. (It may hold more than the new passes: a consumer below a layer
      // keeps its id and bytes but binds another texture once the layer is on, so the
      // switch rebuilds it too.)
      const allOn = effectIds(compile(setList([])));
      const offEffects = effectIds(off);
      const newEffects = [...allOn].filter((id) => !offEffects.has(id));
      expect(newEffects.length).toBe(7);
      expect(held).toEqual(expect.arrayContaining(newEffects));
      expect(held.every((id) => allOn.has(id))).toBe(true);
      // Invisible: nothing submitted, allocated, rebuilt or read back.
      const after = warmed.backend.status;
      expect({
        framesSubmitted: after.framesSubmitted,
        resourceBuilds: after.resourceBuilds,
        readbacks: after.readbacks,
        estimatedResourceBytes: after.estimatedResourceBytes,
      }).toEqual({
        framesSubmitted: before.framesSubmitted,
        resourceBuilds: before.resourceBuilds,
        readbacks: before.readbacks,
        estimatedResourceBytes: before.estimatedResourceBytes,
      });

      // The frame before the switch: the warm-up changed nothing on screen.
      for (const live of [warmed, cold]) live.backend.render(await live.backend.compile(off), inputsAt(1));
      const offWarm = await picture(warmed.backend, off);
      expect(offWarm.some((byte) => byte !== 0)).toBe(true);
      expect(offWarm.equals(await picture(cold.backend, off))).toBe(true);

      // THE SWITCH.
      warmed.resetCounts();
      cold.resetCounts();
      const warmInstalled = await warmed.backend.compile(fxOn);
      const coldInstalled = await cold.backend.compile(fxOn);
      // Every Effect the switch brings was built ahead and adopted — none constructed (and
      // so none of their WGSL reflected) on the switch — and the device was asked for no
      // module or pipeline: the async ones the warm-up requested are the ones it keys on.
      // What the switch builds is read off the backend that never warmed.
      const broughtEffects = [...effectIds(fxOn)].filter((id) => !effectIds(off).has(id)).length;
      const coldBuilt = cold.backend.status.lastBuild?.effectsBuilt ?? 0;
      expect(coldBuilt).toBeGreaterThanOrEqual(broughtEffects);
      expect(warmed.backend.status.lastBuild).toMatchObject({ effectsBuilt: 0, effectsWarmed: coldBuilt });
      expect(warmed.counted()).toEqual(NOTHING_CREATED);
      // The case the counts must not swallow: without the warm-up the same switch builds.
      expect(cold.backend.status.lastBuild?.effectsWarmed).toBeUndefined();
      expect(cold.counted().createShaderModule).toBeGreaterThan(0);
      expect(cold.counted().createRenderPipeline).toBeGreaterThan(0);

      // And the switched-on picture is the one a backend that never warmed renders.
      warmed.backend.render(warmInstalled, inputsAt(2));
      cold.backend.render(coldInstalled, inputsAt(2));
      for (const nodeId of ["layerFx", "out"]) {
        const warmBytes = await picture(warmed.backend, fxOn, nodeId);
        expect(warmBytes.some((byte) => byte !== 0)).toBe(true);
        expect(warmBytes.equals(await picture(cold.backend, fxOn, nodeId)), nodeId).toBe(true);
      }
      expect(warmed.reported).toEqual([]);
      expect(cold.reported).toEqual([]);
    } finally {
      warmed.dispose();
      cold.dispose();
    }
  }, 120_000);

  it("E82: deleting a bypassed layer drops its warm entries; no bypassed layer holds nothing", async () => {
    const live = await stage();
    try {
      const off = compile(setList(["layerGrid", "layerFx"]));
      await live.backend.compile(off);
      const held = await live.backend.warmPasses!(compileLayerWarmPlan(request(setList(["layerGrid", "layerFx"]))));
      const fxPasses = held.filter((id) => /^(layerFx|glitch|shear|tear)#/.test(id));
      expect(fxPasses.length).toBe(4);

      // layerFx deleted, the stack rewired past it: its picture's chain is read by nothing.
      const withoutFx = setList(["layerGrid"], deleteFx);
      const plan = compile(withoutFx);
      await live.backend.compile(plan);
      const after = await live.backend.warmPasses!(compileLayerWarmPlan(request(withoutFx)));
      expect(after.filter((id) => fxPasses.includes(id))).toEqual([]);
      // The grid layer is still off, so what it brings back is still held.
      const gridChain = [...effectIds(compile(setList([], deleteFx)))].filter((id) => !effectIds(plan).has(id));
      expect(gridChain.length).toBe(3);
      expect(after).toEqual(expect.arrayContaining(gridChain));

      // No bypassed layer left: nothing to build ahead, and what was held goes.
      const allOn = setList([], deleteFx);
      await live.backend.compile(compile(allOn));
      expect(compileLayerWarmPlan(request(allOn))).toBeNull();
      expect(await live.backend.warmPasses!(null)).toEqual([]);
      expect(live.reported).toEqual([]);
    } finally {
      live.dispose();
    }
  }, 120_000);

  it("the app's wiring: after a cue switches a layer off, switching it back on constructs no Effect", async () => {
    const live = await stage();
    const warmCalls: Array<Promise<readonly string[]>> = [];
    const backend = new Proxy(live.backend, {
      get(target, property, receiver) {
        if (property === "loop") {
          return () => ({ stop() {} });
        }
        if (property === "warmPasses") {
          return (plan: Parameters<NonNullable<LoomBackend["warmPasses"]>>[0]) => {
            const call = target.warmPasses!(plan);
            warmCalls.push(call);
            return call;
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as LoomBackend;
    const runtime: AppRuntime = createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
      document: { ...structuredClone(setListDocument), settings: SETTINGS },
    });
    try {
      const view = renderHook(() => {
        const compiled = useGraphCompile(runtime, CAPABILITIES);
        const loop = useFrameLoop({
          bus: runtime.bus,
          backend,
          compiled: compiled.compiled,
          settings: runtime.settings,
          animate: compiled.animate,
          valuesOnly: compiled.valuesOnly,
          resetFeedback: compiled.resetFeedback,
          documentBoundary: compiled.documentBoundary,
          warmPlan: compiled.warmPlan,
        });
        return { loop, compiled: compiled.compiled };
      });
      await waitFor(() => expect(view.result.current.loop.installedPlan).not.toBeNull(), { timeout: 20_000 });

      await act(async () => {
        const result = await runtime.bus.execute("node.toggleBypass", { nodeIds: ["layerFx"] }, runtime.invocation);
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
      });
      const offPlan = view.result.current.compiled;
      await waitFor(() => expect(view.result.current.loop.installedPlan).toBe(offPlan), { timeout: 20_000 });
      // The warm-up the install scheduled, in its own task.
      await waitFor(() => expect(warmCalls.length).toBeGreaterThan(0), { timeout: 20_000 });
      const held = await warmCalls.at(-1)!;
      expect(held.some((id) => id.startsWith("layerFx#"))).toBe(true);
      await live.settled();

      live.resetCounts();
      await act(async () => {
        const result = await runtime.bus.execute("node.toggleBypass", { nodeIds: ["layerFx"] }, runtime.invocation);
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
      });
      const onPlan = view.result.current.compiled;
      expect(onPlan?.passes.some((pass) => pass.id.startsWith("layerFx#"))).toBe(true);
      await waitFor(() => expect(view.result.current.loop.installedPlan).toBe(onPlan), { timeout: 20_000 });
      // E82 shipped this layer ON, so vgpu's caches already hold its module and pipeline;
      // what the warm-up still saves is the Effect itself, and the build says it adopted it.
      if (offPlan === null || onPlan === null) throw new Error("no plan");
      const brought = [...effectIds(onPlan)].filter((id) => !effectIds(offPlan).has(id)).length;
      expect(brought).toBeGreaterThan(0);
      expect(live.backend.status.lastBuild?.effectsBuilt).toBe(0);
      expect(live.backend.status.lastBuild?.effectsWarmed).toBeGreaterThanOrEqual(brought);
      expect(live.counted()).toEqual(NOTHING_CREATED);
      expect(view.result.current.loop.diagnostics).toEqual([]);
      expect(live.reported).toEqual([]);
      view.unmount();
    } finally {
      runtime.dispose();
      live.dispose();
    }
  }, 120_000);
});
