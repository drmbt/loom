import { describe, expect, it } from "vitest";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost } from "./node-gpu-host.ts";
import { preparationFixture, PREPARATION_INPUT } from "./environment-preparation.fixture.ts";
import { compileParityGraph } from "../../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../../tests/headless/pixel-compare.ts";
import { readExecutionPlan } from "../plan.ts";
import { environmentBenchmarkGraph, environmentBenchmarkSettings } from "../../../../tools/environment-benchmark-fixture.ts";

async function pair(external = false) {
  const reference = createVgpuBackend({ host: nodeGpuHost() });
  const candidate = createVgpuBackend({ host: nodeGpuHost() });
  await reference.initialize({}); await candidate.initialize({});
  const original = await reference.compile(preparationFixture({ metadata: false, external }));
  const optimized = await candidate.compile(preparationFixture({ external }));
  return { reference, candidate, original, optimized };
}

const colorBytes = (r: number, g: number) => Uint8Array.from({ length: 8*8*4 }, (_,i) => i%4===0?r:i%4===1?g:i%4===3?255:0);

describe("environment preparation on Dawn", () => {
  it("matches both real HDRI-prefiltered scene renders through surface motion, changing sky, reset and recompile", async () => {
    const reference = createVgpuBackend({ host: nodeGpuHost() });
    const candidate = createVgpuBackend({ host: nodeGpuHost() });
    try {
      const capabilities = await candidate.initialize({}); await reference.initialize({});
      const plan = compileParityGraph(environmentBenchmarkGraph(), capabilities, environmentBenchmarkSettings);
      expect(plan.ok).toBe(true);
      const read = readExecutionPlan(plan);
      expect(read.ok).toBe(true);
      expect(read.passes.filter(pass => pass.kind === "draw" && pass.preparation !== undefined)).toHaveLength(12);
      const source = read.passes.find(pass => pass.kind === "effect" && pass.nodeId === "seed");
      if (source?.kind !== "effect") throw new Error("Missing HDRI gain pass");
      const surfaces = read.passes.filter(pass => pass.kind === "draw" && pass.preparation === undefined && pass.uniforms?.["material"] !== undefined);
      expect(surfaces).toHaveLength(2);
      const outputIds = ["shot_a", "shot_b"].map(nodeId => {
        const output = plan.outputs.find(entry => entry.nodeId === nodeId && entry.portId === "out");
        if (output === undefined) throw new Error(`Missing scene output ${nodeId}`);
        return output.resourceId;
      });
      const uncached = { ...plan, passes: read.passes.map(pass => {
        if (pass.kind !== "draw" || pass.preparation === undefined) return pass;
        const { preparation: _preparation, ...original } = pass; return original;
      }) };
      let original = await reference.compile(uncached), optimized = await candidate.compile(plan);
      for (let step = 0; step < 8; step++) {
        if (step === 6) {
          original = await reference.compile(uncached); optimized = await candidate.compile(plan);
        }
        for (const backend of [reference, candidate]) {
          for (const surface of surfaces) backend.updateUniforms({ passId: surface.id,
            values: { material: [1, 0.7 + step * 0.03, 0, 0] } });
          if (step >= 3) {
            const gain = step % 2 === 0 ? 1 : 0.5;
            backend.updateUniforms({ passId: source.id, values: { color: [gain, gain, gain, 1] } });
          }
          if (step === 5) backend.resetTemporalHistory(undefined, { buffers: true });
        }
        const input = { ...PREPARATION_INPUT, resolution: [512, 256] as const,
          frame: { ...PREPARATION_INPUT.frame, frameIndex: step, timeSeconds: step / 60 } };
        reference.render(original, input); candidate.render(optimized, input);
        for (const id of outputIds) {
          const baseline = await reference.readOutput(id);
          expect(Buffer.from((await candidate.readOutput(id)).bytes).equals(Buffer.from(baseline.bytes)), `frame ${step}, ${id}`).toBe(true);
          if (step === 0) expect(decodeComponents(baseline.bytes, baseline.format).some((value, index) => index % 4 !== 3 && value > 0.01)).toBe(true);
        }
      }
    } finally { reference.dispose(); candidate.dispose(); }
  });
  it("matches uncached pixels through unrelated motion, source changes, reset and recompile", async () => {
    const { reference, candidate, original, optimized } = await pair();
    try {
      for (let step=0;step<8;step++) {
        for (const backend of [reference,candidate]) {
          backend.updateUniforms({ passId:"a:out", values:{phase:step} });
          if (step===3) backend.updateUniforms({passId:"source",values:{color:[0,1,0,1]}});
          if (step===5) backend.resetTemporalHistory();
        }
        reference.render(original,PREPARATION_INPUT);candidate.render(optimized,PREPARATION_INPUT);
        for (const id of ["a:out","b:out"]) expect((await candidate.readOutput(id)).bytes).toEqual((await reference.readOutput(id)).bytes);
      }
      await candidate.compile(preparationFixture());
      candidate.render(optimized,PREPARATION_INPUT);
      expect((await candidate.readOutput("a:out")).bytes[0]).toBe(255);
    } finally { reference.dispose();candidate.dispose(); }
  });

  it("observes external frame and registration identities even when frame IDs repeat", async () => {
    const {reference,candidate,original,optimized}=await pair(true);
    let frameId=1,bytes=colorBytes(255,0);
    try {
      for (const backend of [reference,candidate]) backend.registerMediaSource("photo",{currentFrame:()=>({frameId,bytes})});
      for(let step=0;step<5;step++) {
        if(step===2){frameId++;bytes=colorBytes(0,255);}
        if(step===3)for(const backend of [reference,candidate])backend.registerMediaSource("photo",{currentFrame:()=>({frameId,bytes:colorBytes(128,0)})});
        reference.render(original,PREPARATION_INPUT);candidate.render(optimized,PREPARATION_INPUT);
        for(const id of ["a:out","b:out"])expect((await candidate.readOutput(id)).bytes).toEqual((await reference.readOutput(id)).bytes);
      }
    }finally{reference.dispose();candidate.dispose();}
  });
});
