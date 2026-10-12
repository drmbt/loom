import { describe, expect, it, vi } from "vitest";
import { target } from "vgpu";
import { readExecutionPlan } from "../plan.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { mockGpuHost } from "./mock-gpu-host.ts";
import { countDeviceCalls, during } from "./device-calls.test-support.ts";

import { preparationFixture, PREPARATION_INPUT as input } from "./environment-preparation.fixture.ts";

async function setup(plan = preparationFixture()) {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  await backend.initialize({});
  const calls = countDeviceCalls(host);
  const compiled = await backend.compile(plan);
  const render = async () => {
    const counted = during(calls, () => backend.render(compiled, input));
    await backend.readOutput("a:out");
    return counted.renderPasses;
  };
  return { backend, host, compiled, calls, render };
}

describe("environment preparation reuse", () => {
  it("shares the initial recipe and reuses it while an unrelated scene uniform changes", async () => {
    const { backend, render } = await setup();
    try {
      expect(await render()).toBe(10); // source + six preparation draws + one copy + two outputs
      backend.updateUniforms({ passId: "a:out", values: { phase: 1 } });
      expect(await render()).toBe(3);
      backend.updateUniforms({ passId: "source", values: { color: [0,1,0,1] } });
      expect(await render()).toBe(10);
      expect(await render()).toBe(3);
    } finally { backend.dispose(); }
  });

  it("keeps unmarked plans unchanged", async () => {
    const { backend, render } = await setup(preparationFixture({ metadata: false }));
    try { expect(await render()).toBe(15); expect(await render()).toBe(15); }
    finally { backend.dispose(); }
  });

  it("does not reuse a skipped source draw, and refreshes when that source resumes", async () => {
    const original = readExecutionPlan(preparationFixture());
    const source = original.passes.find(pass => pass.id === "source");
    if (source?.kind !== "effect") throw new Error("Missing source fixture");
    const plan = { ...original, passes: original.passes.map(pass => pass.id !== source.id ? pass : {
      ...source, kind: "draw" as const, nodeId: "source", topology: "triangle-list" as const, instances: 1, vertexCount: 3,
      shader: `${source.shader}\nstruct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
      @vertex fn vs(@builtin(vertex_index) i: u32) -> VertexOut {
        let p = array(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); var out: VertexOut;
        out.position = vec4f(p[i],0,1); out.uv = p[i] * 0.5 + vec2f(0.5); return out;
      }`,
    }) };
    const { backend, render } = await setup(plan);
    try {
      expect(await render()).toBe(10);
      expect(await render()).toBe(3);
      backend.updateUniforms({ passId: "source", values: {}, skip: true });
      expect(await render()).toBe(15);
      backend.updateUniforms({ passId: "source", values: {}, skip: false });
      expect(await render()).toBe(10);
      expect(await render()).toBe(3);
    } finally { backend.dispose(); }
  });

  it("keeps preparation intermediates current when another pass reads them", async () => {
    const original = readExecutionPlan(preparationFixture());
    const first = original.passes.find(pass => pass.id === "b:0");
    if (first?.kind !== "draw") throw new Error("Missing preparation fixture");
    const plan = { ...original,
      resources: [...original.resources, { kind: "target" as const, id: "peek", size: [8, 8] as const, format: "rgba8unorm" as const }],
      passes: [...original.passes, { ...first, preparation: undefined, id: "peek", nodeId: "reader", target: "peek",
        textures: [{ binding: "image", resourceId: "b:0", sampled: "unfiltered" as const }] }],
    };
    const { backend, render } = await setup(plan);
    try {
      expect(await render()).toBe(16);
      // A can reuse its private atlas; B must produce all six targets for the external reader.
      expect(await render()).toBe(10);
    } finally { backend.dispose(); }
  });

  it("releases a malformed preparation build and preserves the installed program", async () => {
    const probe = await mockGpuHost().create({});
    const prototype = Object.getPrototypeOf(target(probe.gpu, { size: [1, 1], format: "rgba8unorm" })) as {
      destroy(): void; options: { label?: string };
    };
    probe.dispose();
    const { backend, render } = await setup();
    try {
      await render(); expect(await render()).toBe(3);
      const released: Array<string | undefined> = [];
      const destroy = prototype.destroy;
      vi.spyOn(prototype, "destroy").mockImplementation(function(this: typeof prototype) {
        released.push(this.options.label); destroy.call(this);
      });
      const original = readExecutionPlan(preparationFixture());
      const malformed = { ...original,
        resources: original.resources.map(resource => ({ ...resource, id: `bad:${resource.id}` })),
        passes: original.passes.map(pass => ({ ...pass, id: `bad:${pass.id}`,
          ...("target" in pass ? { target: `bad:${pass.target}` } : {}),
          ...("textures" in pass ? { textures: pass.textures?.map(binding => ({ ...binding, resourceId: `bad:${binding.resourceId}` })) } : {}),
          ...(pass.kind === "draw" && pass.preparation !== undefined ? { preparation: { ...pass.preparation,
            source: pass.id === "b:3" ? "bad:a:out" : `bad:${pass.preparation.source}` } } : {}),
        })),
      };
      await expect(backend.compile(malformed)).rejects.toThrow(/privately owned draw targets/);
      expect(released).toEqual(expect.arrayContaining(malformed.resources.map(resource => resource.id)));
      expect(await render()).toBe(3);
    } finally { backend.dispose(); }
  });

  it("invalidates retained pixels at a reset boundary and after resize", async () => {
    const { backend, render } = await setup();
    try {
      await render(); expect(await render()).toBe(3);
      backend.resetTemporalHistory();
      expect(await render()).toBe(10);
      backend.resize("a:5", [16,8]);
      expect(await render()).toBeGreaterThan(3);
    } finally { backend.dispose(); }
  });
  it("rebuilds preparation effects after device recovery", async () => {
    const { backend, host, render } = await setup();
    try {
      await render(); expect(await render()).toBe(3);
      const generation = backend.status.deviceGeneration;
      host.loseDevice();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1_000;
        const check = () => {
          if (backend.status.deviceGeneration > generation && !backend.status.halted) resolve();
          else if (Date.now() > deadline) reject(new Error("Device recovery did not finish"));
          else setTimeout(check, 1);
        };
        check();
      });
      const calls = countDeviceCalls(host);
      // Compile returns the retained structure on the new device.
      const compiled = await backend.compile(preparationFixture());
      const encoded = during(calls, () => backend.render(compiled, input));
      await backend.readOutput("a:out");
      expect(encoded.renderPasses).toBe(10);
    } finally { backend.dispose(); }
  });

});
