import { expect, it, vi } from "vitest";
import { createUniformAnimator } from "../../../app/animate-parameters.ts";
import { compileGraph } from "../../../compiler/compile.ts";
import { scratchResourceId } from "../../../compiler/resources.ts";
import type { CompiledGraph } from "../../../compiler/types.ts";
import type { BackendCapabilities, FrameInputs } from "../../../domain/types/backend.ts";
import type { FrameEvaluationInput } from "../../../domain/types/frame.ts";
import { DEFAULT_PROJECT_SETTINGS, type GraphDocument, type GraphNode } from "../../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { createInferenceSources } from "../../execution/inference-sources.ts";
import { decodeHalf } from "../../export/pixel-format.ts";
import { nodeGpuHost } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

const SIDE = 8;
const settings = { ...DEFAULT_PROJECT_SETTINGS, workingFormat: "rgba16float" as const,
  outputResolution: { width: SIDE, height: SIDE } };
const capabilities: BackendCapabilities = {
  tier: "B", features: [], formats: ["rgba16float", "rgba8unorm", "r32float"],
  timestampQuery: false, limits: { maxTextureDimension2D: 8192 },
};
const registry = createNodeRegistry(allNodeDefinitions).view();

function graphFor(phase: number): GraphDocument {
  const node = (id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode => ({
    id, type, parameters, definitionVersion: 1, position: { x: 0, y: 0 }, label: `${id}1`,
  });
  const edge = (id: string, from: string, to: string, portId = "input") => ({
    id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId },
  });
  return { revision: 1, groups: {}, nodes: {
    seed: node("seed", "solid", { color: [1, 1, 1, 1] }),
    source: node("source", "customWgsl", {
      source: `struct Params { phase: f32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0) * vec4f(params.phase, 0.25, 0.5, 1.0);
}`, phase,
    }),
    matte: node("matte", "matte", { smoothing: 1 }),
    cache: node("cache", "cache", {
      frames: 8, scale: 1, strictHistory: true,
      index: { mode: "expression", bindings: {
        static: { kind: "static", value: 0 },
        expression: { kind: "expression", source: "op('matte1').chan.cacheFrames" },
      } },
    }),
    masked: node("masked", "mask", { channel: "red", apply: "alpha" }),
  }, edges: {
    a: edge("a", "seed", "source"), b: edge("b", "source", "matte"),
    c: edge("c", "source", "cache"), d: edge("d", "cache", "masked"),
    e: edge("e", "matte", "masked", "mask"),
  } };
}

// Keep the production preprocessing WGSL and its actual compiler ID, but bound the
// tensor to the same8x8 shape as the deterministic runner. No real model is loaded.
function tinyPreprocess(plan: CompiledGraph): CompiledGraph {
  const inputId = scratchResourceId("matte", "modelInput");
  return { ...plan,
    resources: plan.resources.map(resource => resource.kind === "buffer" && resource.id === inputId
      ? { ...resource, capacity: SIDE * SIDE } : resource),
    passes: plan.passes.map(pass => pass.kind === "dispatch" && pass.nodeId === "matte"
      ? { ...pass, workgroups: [1, 1, 1], uniforms: { ...pass.uniforms, side: SIDE } } : pass),
  };
}

it.each([false, true])("matches captured model input through skipped and wrapped indices, open=%s", async open => {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic(diagnostic => { if (diagnostic.severity === "error") errors.push(diagnostic.message); });
  let release = (): void => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = (): void => {};
  const runnerStarted = new Promise<void>(resolve => { started = resolve; });
  let captured: number | undefined;
  const sources = createInferenceSources({
    readBuffer: id => backend.readBuffer(id),
    nextRenderIndex: () => backend.status.framesSubmitted + 1,
    run: async (_nodeId, input) => {
      captured = new Float32Array(input)[0];
      started();
      await held;
      return new Uint8Array(new Float32Array(SIDE * SIDE).fill(0.5).buffer);
    },
  });
  let control: { stop(): void } | undefined;
  try {
    await backend.initialize({});
    sources.track([{ nodeId: "matte", inputResourceId: scratchResourceId("matte", "modelInput"),
      sourceId: "infer:matte", channel: "matte1", fallback: new Uint8Array(SIDE * SIDE * 4), hold: true }]);
    const compileAt = (phase: number, frame: FrameEvaluationInput): CompiledGraph => tinyPreprocess(compileGraph({
      graph: graphFor(phase), settings, registry, capabilities,
      sinks: [{ nodeId: "masked", kind: "readback" }], resolution: { frame, channels: sources.resolver },
    }));
    const indices = [0, 3, 7, 0, 5];
    const inputFor = (ordinal: number): FrameInputs => ({
      frame: { frameIndex: indices[ordinal - 1]!, timeSeconds: indices[ordinal - 1]! / 60,
        absTimeSeconds: (ordinal - 1) / 60, deltaSeconds: 1 / 60, mode: "realtime", randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 }, resolution: [SIDE, SIDE],
    });
    const base = compileAt(1 / 8, inputFor(1).frame);
    expect(base.ok, JSON.stringify(base.diagnostics)).toBe(true);
    const preprocess = base.passes.find(pass => pass.kind === "dispatch" && pass.nodeId === "matte");
    if (preprocess === undefined) throw new Error("Compiled matte has no preprocess dispatch");
    const compiled = await backend.compile(base);
    backend.registerMediaSource("infer:matte", { currentFrame: () => sources.currentFrame("matte") });
    backend.registerDispatchGate(preprocess.id, (frame, timing) => {
      // Reserve one input on render2, then keep its result while RGB continues moving.
      return timing.renderIndex === 2 && timing.source !== undefined &&
        sources.prepare("matte", frame, false, timing.source);
    });
    const animator = createUniformAnimator();
    let ordinal = 0;
    const render = () => {
      ordinal += 1;
      const input = inputFor(ordinal);
      const next = compileAt(ordinal / 8, input.frame);
      expect(next.ok, JSON.stringify(next.diagnostics)).toBe(true);
      expect(animator.push(backend, base, next)).not.toBeNull();
      backend.render(compiled, input);
      queueMicrotask(() => sources.samplePrepared(input.frame));
    };
    if (open) {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      control = backend.loop(render, { scheduler: "timer", fps: 60 });
    }
    const step = async () => {
      if (open) vi.advanceTimersByTime(1000 / 60 + 0.001);
      else render();
      await backend.whenSettled();
    };
    await step();
    await step();
    await runnerStarted;
    // Open-frame compute captures the previous source; direct segmented compute
    // captures the current one. The expected pixels come from the ACTUAL readback.
    expect(captured).toBe(open ? 1 / 8 : 2 / 8);
    await step();
    release();
    await sources.drain();
    for (let i = 0; i < 2; i++) {
      await step();
      const image = await backend.readOutput("target:masked:out");
      expect(image.format).toBe("rgba16float");
      const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
      const pixel = Array.from({ length: 4 }, (_, channel) => decodeHalf(view.getUint16(channel * 2, true)));
      expect(pixel).toEqual([captured!, 0.25, 0.5, 0.5]);
      expect(pixel[0]).not.toBe(ordinal / 8); // A live RGB branch fails this control.
    }
    expect(backend.status.framesSubmitted).toBe(5);
    expect(errors).toEqual([]);
  } finally {
    release();
    control?.stop();
    backend.dispose();
    vi.useRealTimers();
  }
}, 30_000);

it("reads the current input at tap0 and makes unavailable strict history transparent", async () => {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const frame: FrameEvaluationInput = { frameIndex: 0, timeSeconds: 0, deltaSeconds: 1 / 60,
    mode: "offline", randomSeed: 1 };
  const planAt = (phase: number, index: number, strictHistory: boolean) => {
    const full = graphFor(phase);
    const source = full.nodes["source"];
    const seed = full.nodes["seed"];
    const cache = full.nodes["cache"];
    if (source === undefined || seed === undefined || cache === undefined) throw new Error("Cache fixture is incomplete");
    const graph: GraphDocument = { ...full,
      nodes: { seed, source, cache: { ...cache, parameters: { frames: 2, scale: 1, index, strictHistory } } },
      edges: { a: full.edges["a"]!, c: full.edges["c"]! },
    };
    return compileGraph({ graph, settings, registry, capabilities, sinks: [{ nodeId: "cache", kind: "readback" }] });
  };
  try {
    await backend.initialize({});
    const base = planAt(1 / 8, 1, false);
    expect(base.ok).toBe(true);
    const compiled = await backend.compile(base);
    const animator = createUniformAnimator();
    const step = async (phase: number, index: number, strictHistory: boolean) => {
      const next = planAt(phase, index, strictHistory);
      expect(next.ok).toBe(true);
      expect(animator.push(backend, base, next)).not.toBeNull();
      backend.render(compiled, { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [SIDE, SIDE] });
      const output = await backend.readOutput("target:cache:out");
      const view = new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength);
      return Array.from({ length: 4 }, (_, channel) => decodeHalf(view.getUint16(channel * 2, true)));
    };
    // The existing empty-cache passthrough is preserved for default mode.
    expect(await step(1 / 8, 1, false)).toEqual([1 / 8, 0.25, 0.5, 1]);
    // A request deeper than the two-slot allocation must survive compile clamping.
    expect(await step(2 / 8, 3, true)).toEqual([0, 0, 0, 0]);
    // Zero delay remains available even in strict mode once history exists.
    expect(await step(4 / 8, 0, true)).toEqual([4 / 8, 0.25, 0.5, 1]);
  } finally { backend.dispose(); }
}, 30_000);
