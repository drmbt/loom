import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { compileParityGraph } from "../src/tests/headless/render-harness.ts";
import { createVgpuBackend } from "../src/runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost } from "../src/runtime/backend/vgpu/node-gpu-host.ts";
import { frameFromClock } from "../src/domain/types/frame.ts";
import type { FrameInputs } from "../src/domain/types/backend.ts";
import { readExecutionPlan } from "../src/runtime/backend/plan.ts";
import { environmentBenchmarkGraph, environmentBenchmarkSettings } from "./environment-benchmark-fixture.ts";

const WARM = 30, FRAMES = 120, TRIALS = 7;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const stats = (numbers: readonly number[]) => {
  if (numbers.length === 0) throw new Error("No timing samples recorded");
  const values = [...numbers].sort((a, b) => a - b);
  return { samples: values.length, median: values[Math.floor(values.length / 2)]!, p90: values[Math.floor((values.length - 1) * 0.9)]!, min: values[0]!, max: values.at(-1)! };
};

const backends = {
  reference: createVgpuBackend({ host: nodeGpuHost() }),
  candidate: createVgpuBackend({ host: nodeGpuHost() }),
};
try {
  const capabilities = await backends.candidate.initialize({});
  await backends.reference.initialize({});
  if (!capabilities.timestampQuery) throw new Error("This benchmark requires real GPU timestamp-query support");
  const graph = environmentBenchmarkGraph();
  const plan = compileParityGraph(graph, capabilities, environmentBenchmarkSettings);
  if (!plan.ok) throw new Error(JSON.stringify(plan.diagnostics));
  const read = readExecutionPlan(plan);
  if (!read.ok) throw new Error(JSON.stringify(read.diagnostics));
  const preparations = read.passes.filter(pass => pass.kind === "draw" && pass.preparation !== undefined);
  if (preparations.length !== 12) throw new Error(`Expected twelve real prefilter passes, got ${preparations.length}`);
  const prepIds = new Set(preparations.map(pass => pass.id));
  const seed = read.passes.find(pass => pass.kind === "effect" && pass.nodeId === "seed");
  if (seed === undefined || seed.kind !== "effect" || seed.uniforms?.["color"] === undefined) throw new Error("Missing HDRI gain source uniform");
  const surfaces = read.passes.filter(pass => pass.kind === "draw" && pass.preparation === undefined && pass.uniforms?.["material"] !== undefined);
  const outputs = ["shot_a", "shot_b"].map(nodeId => {
    const output = plan.outputs.find(entry => entry.nodeId === nodeId && entry.portId === "out");
    if (output === undefined) throw new Error(`Missing ${nodeId} output`);
    return output.resourceId;
  });
  const original = { ...plan, passes: read.passes.map(pass => {
    if (pass.kind !== "draw" || pass.preparation === undefined) return pass;
    const { preparation: _preparation, ...unchanged } = pass; return unchanged;
  }) };
  const compiled = { reference: await backends.reference.compile(original), candidate: await backends.candidate.compile(plan) };
  const telemetry = new Map<string, Map<number, { gpuMs: number; preparationSpans: number }>>();
  const drops = new Map<string, unknown[]>();
  for (const [name, backend] of Object.entries(backends)) {
    telemetry.set(name, new Map()); drops.set(name, []); backend.setCookPolicy("always");
    backend.onGpuTimings((spans, frame) => {
      if (frame?.submit === null || frame?.submit === undefined) return;
      const samples = telemetry.get(name)!;
      const previous = samples.get(frame.submit) ?? { gpuMs: 0, preparationSpans: 0 };
      samples.set(frame.submit, { gpuMs: previous.gpuMs + frame.gpuMs, preparationSpans: previous.preparationSpans + Object.keys(spans).filter(id => prepIds.has(id)).length });
    });
    backend.onGpuTimingsDropped(drop => drops.get(name)!.push(drop));
  }
  const run = async (name: keyof typeof backends, changing: boolean) => {
    const backend = backends[name]; const cpu: number[] = [], submits: number[] = [];
    backend.resetTemporalHistory(undefined, { buffers: true });
    for (let index = 0; index < WARM + FRAMES; index++) {
      const gain = changing ? (index % 2 === 0 ? 1 : 0.5) : 1;
      backend.updateUniforms({ passId: seed.id, values: { color: [gain, gain, gain, 1] } });
      for (const pass of surfaces) backend.updateUniforms({ passId: pass.id,
        values: { material: [1, 0.75 + 0.2 * Math.sin(index * 0.1), 0, 0] } });
      const input: FrameInputs = { frame: frameFromClock({ timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: "offline", randomSeed: 7, fps: 60 }),
        pointer: { x: 0, y: 0, buttons: 0 }, resolution: [512, 256] };
      const start = performance.now(); backend.render(compiled[name], input); const elapsed = performance.now() - start;
      if (index >= WARM) { cpu.push(elapsed); submits.push(backend.status.framesSubmitted); }
      // Serialise GPU completion outside measured CPU encode and GPU render spans; also lets cache publication settle.
      await backend.readOutput(outputs[0]!, { x: 0, y: 0, width: 1, height: 1 });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const bytes = await Promise.all(outputs.map(output => backend.readOutput(output)));
    const samples = submits.map(submit => {
      const sample = telemetry.get(name)!.get(submit);
      if (sample === undefined) throw new Error(`Missing GPU timing for ${name} submit ${submit}`);
      return sample;
    });
    return { cpuEncodeMs: stats(cpu), gpuRenderExtentMs: stats(samples.map(sample => sample.gpuMs)),
      preparationSpansPerFrame: stats(samples.map(sample => sample.preparationSpans)),
      hashes: bytes.map(image => digest(image.bytes)), bytes: bytes.map(image => image.bytes) };
  };
  const report: Record<string, unknown> = { timestamp: new Date().toISOString(), runtime: process.version,
    platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, capabilities,
    settings: environmentBenchmarkSettings, warmupFrames: WARM, measuredFrames: FRAMES, trials: TRIALS,
    method: "Two devices; alternating run order; one-pixel completion readback outside CPU encode; per-logical-render GPU extent sums actual segment extents, excluding inter-segment gaps and readback. Final full output bytes compared exactly.",
    sourceHashes: Object.fromEntries(["src/runtime/backend/vgpu/environment-preparation.ts", "src/nodes/shaders/scene-render.wgsl.ts", "patches/vgpu.patch", "tools/environment-benchmark-fixture.ts", "tools/bench-environment-preparation.ts"].map(path => [path, digest(readFileSync(path))])),
    graphHash: digest(JSON.stringify(graph)), scenarios: {} };
  const scenarios: Record<string, unknown> = {};
  for (const changing of [false, true]) {
    const results = [];
    for (let trial = 0; trial < TRIALS; trial++) {
      const order: (keyof typeof backends)[] = trial % 2 === 0 ? ["reference", "candidate"] : ["candidate", "reference"];
      const trialResults: Partial<Record<keyof typeof backends, Awaited<ReturnType<typeof run>>>> = {};
      for (const name of order) trialResults[name] = await run(name, changing);
      for (let index = 0; index < outputs.length; index++) if (!Buffer.from(trialResults.reference!.bytes[index]!).equals(trialResults.candidate!.bytes[index]!)) {
        throw new Error(`Pixel mismatch in ${changing ? "changing" : "stable"} trial ${trial}, output ${outputs[index]}`);
      }
      const clean = (value: Awaited<ReturnType<typeof run>>) => { const { bytes: _bytes, ...metrics } = value; return metrics; };
      results.push({ trial, order, bytesEqual: true, reference: clean(trialResults.reference!), candidate: clean(trialResults.candidate!) });
      process.stderr.write(`environment benchmark ${changing ? "changing" : "stable"} trial ${trial + 1}/${TRIALS} complete\n`);
    }
    const baselineRepeat = await run("reference", changing); const { bytes: _bytes, ...repeat } = baselineRepeat;
    scenarios[changing ? "sourceChangingEveryFrame" : "sourceStableWithMaterialMotion"] = { results, baselineRepeat: repeat };
  }
  report["scenarios"] = scenarios; report["timingDrops"] = Object.fromEntries(drops);
  const json = JSON.stringify(report, null, 2);
  writeFileSync("/tmp/loom-environment-performance.json", json + "\n"); process.stdout.write(json + "\n");
} finally { backends.reference.dispose(); backends.candidate.dispose(); }
