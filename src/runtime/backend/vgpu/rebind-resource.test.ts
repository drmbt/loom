import { describe, expect, it, vi } from "vitest";
import type { LogicalExecutionPlan, FrameInputs } from "../../../domain/types/backend.ts";
import { readExecutionPlan, type PassDescriptor, type ResourceDescriptor } from "../plan.ts";
import { fixturePlan } from "./plan-fixture.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { wgsl } from "../wgsl.ts";

/** Independent simulations expose unrelated binding scans after each substep swap. */
const reads = vi.hoisted(() => ({ bindings: 0 }));

vi.mock("./resources.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./resources.ts")>();
  return {
    ...original,
    buildResources: (...args: Parameters<typeof original.buildResources>) => {
      const resources = original.buildResources(...args);
      for (const bindings of [...resources.dynamicTextures.values(), ...resources.dynamicBuffers.values()]) {
        for (const binding of bindings) {
          const resourceId = binding.resourceId;
          Object.defineProperty(binding, "resourceId", {
            configurable: true,
            get() { reads.bindings += 1; return resourceId; },
          });
        }
      }
      return resources;
    },
  };
});

function independentLoops(count: number, substeps: number): LogicalExecutionPlan {
  const source = fixturePlan();
  const read = readExecutionPlan(source);
  if (!read.ok) throw new Error("Invalid independent loop fixture");
  const resources: ResourceDescriptor[] = [];
  const passes: PassDescriptor[] = [];
  for (let index = 0; index < count; index += 1) {
    const prefix = `sim${index}:`;
    resources.push(...read.resources.map((resource) => ({ ...resource, id: prefix + resource.id })));
    passes.push({ kind: "loop", id: `${prefix}begin`, loopId: prefix, edge: "begin", count: substeps });
    for (const pass of read.passes) {
      if (pass.kind === "effect") {
        passes.push({
          ...pass,
          id: prefix + pass.id,
          nodeId: prefix + pass.nodeId,
          target: prefix + pass.target,
          ...(pass.samplers === undefined ? {} : {
            samplers: pass.samplers.map((binding) => ({ ...binding, resourceId: prefix + binding.resourceId })),
          }),
          ...(pass.textures === undefined ? {} : {
            textures: pass.textures.map((binding) => ({ ...binding, resourceId: prefix + binding.resourceId })),
          }),
        });
      } else if (pass.kind === "swap") {
        passes.push({ ...pass, id: prefix + pass.id, resourceId: prefix + pass.resourceId });
      }
    }
    passes.push({ kind: "loop", id: `${prefix}end`, loopId: prefix, edge: "end" });
  }
  return { ...source, resources, passes };
}

function independentBufferLoops(count: number, substeps: number): LogicalExecutionPlan {
  const resources: ResourceDescriptor[] = [];
  const passes: PassDescriptor[] = [];
  for (let index = 0; index < count; index += 1) {
    const resourceId = `buffer${index}`;
    resources.push({ kind: "bufferPair", id: resourceId, stride: 4, capacity: 128 });
    passes.push(
      { kind: "loop", id: `${resourceId}:begin`, loopId: resourceId, edge: "begin", count: substeps },
      {
        kind: "dispatch", id: `${resourceId}:step`, entryPoint: "cs", workgroups: [1, 1, 1],
        shader: wgsl`@group(0) @binding(0) var<storage, read> previous: array<f32>;
@group(0) @binding(1) var<storage, read_write> next: array<f32>;
@compute @workgroup_size(1) fn cs() { next[0] = previous[0] + 1.0; }`,
        buffers: [
          { binding: "previous", resourceId, half: "read", offset: 0, bytes: 16 },
          { binding: "next", resourceId, half: "write", offset: 256, bytes: 16 },
        ],
      },
      { kind: "swap", id: `${resourceId}:swap`, resourceId },
      { kind: "loop", id: `${resourceId}:end`, loopId: resourceId, edge: "end" },
    );
  }
  return { resources, passes, diagnostics: [] };
}

const inputs: FrameInputs = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [64, 64],
};

describe("resource swap binding consumers", () => {
  it("does not inspect unrelated simulations' bindings during repeated swaps", async () => {
    const simulations = 12;
    const backend = createVgpuBackend({ host: mockGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(independentLoops(simulations, 8));
      reads.bindings = 0;
      backend.render(compiled, inputs);
      // Each dynamic texture binding is inspected twice by the once-per-frame rebind.
      // Swaps use the compiled resource index, independent of simulation/substep count.
      expect(reads.bindings).toBe(4 * simulations);
      expect(backend.status.framesSubmitted).toBe(1);
    } finally {
      backend.dispose();
    }
  });

  it("indexes both read and write buffer regions without inspecting unrelated storage", async () => {
    const simulations = 12;
    const backend = createVgpuBackend({ host: mockGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(independentBufferLoops(simulations, 8));
      reads.bindings = 0;
      backend.render(compiled, inputs);
      expect(reads.bindings).toBe(2 * simulations);
      expect(backend.status.framesSubmitted).toBe(1);
    } finally {
      backend.dispose();
    }
  });
});
