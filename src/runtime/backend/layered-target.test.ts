import { describe, expect, it, vi } from "vitest";

import type { FrameInputs, LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { LAYERS, layeredPlan } from "./layered-target.fixture.ts";
import { estimateResourceBytes, passStructureKey, readExecutionPlan, renderPassRuns, resourceStructureKey } from "./plan.ts";
import type { DrawPassDescriptor } from "./plan.ts";
import { mockGpuHost } from "./vgpu/mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu/vgpu-backend.ts";

/**
 * T1623b slice 4 — THE LAYERED TARGET, at the plan contract and on the mock device.
 *
 * A layered target is one texture of N layers: a draw renders into the layer it names, and
 * a shader reads all of them through one `texture_2d_array` binding. It exists so that a
 * text can INDEX what N targets would make it name (a Render's shadow maps, a layer a
 * casting light). What a shader reads from it is `vgpu/layered-target.gpu.test.ts`'s, on
 * Dawn. Here: the rules the backend relies on before it allocates, each of which is a
 * plausible wrong picture when broken (§V147), and what the device is asked for.
 */

const paints = [
  { id: "a", layer: 0, value: 1 },
  { id: "b", layer: 1, value: 2 },
  { id: "c", layer: 2, value: 3 },
];
const errorsOf = (plan: LogicalExecutionPlan): string[] => readExecutionPlan(plan).diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message);
const withResource = (plan: LogicalExecutionPlan, change: Record<string, unknown>): LogicalExecutionPlan =>
  ({ ...plan, resources: (plan.resources as unknown as Array<Record<string, unknown>>).map((resource) => (resource["id"] === "maps" ? { ...resource, ...change } : resource)) }) as unknown as LogicalExecutionPlan;
const withPass = (plan: LogicalExecutionPlan, id: string, change: Record<string, unknown>): LogicalExecutionPlan =>
  ({ ...plan, passes: (plan.passes as unknown as Array<Record<string, unknown>>).map((pass) => (pass["id"] === id ? { ...pass, ...change } : pass)) }) as unknown as LogicalExecutionPlan;

describe("T1623b: a layered target, at the plan contract", () => {
  it("reads a plan that paints three layers and binds them whole", () => {
    const read = readExecutionPlan(layeredPlan(paints));
    expect(read.diagnostics).toEqual([]);
    expect(read.resources[0]).toEqual({ kind: "layers", id: "maps", size: [4, 4], format: "r32float", layers: 3, depth: true });
    expect((read.passes as DrawPassDescriptor[]).map((pass) => pass.layer)).toEqual([0, 1, 2, undefined]);
  });

  it("needs at least one layer, and a whole number of them", () => {
    for (const layers of [0, -1, 1.5, "3"]) expect([layers, readExecutionPlan(withResource(layeredPlan(paints), { layers })).ok]).toEqual([layers, false]);
    // One layer is a layered target like any other: it is still bound as an array.
    expect(readExecutionPlan(layeredPlan([paints[0]!], { layers: 1 })).ok).toBe(true);
  });

  it("refuses a draw that names no layer, a layer past the end, and a layer of a target that has none", () => {
    expect(errorsOf(withPass(layeredPlan(paints), "b", { layer: undefined }))).toEqual([
      'Draw pass "b" renders into the layered target "maps" and names no layer; it has layers 0 to 2.',
    ]);
    expect(errorsOf(withPass(layeredPlan(paints), "c", { layer: 3 }))).toEqual([
      'Draw pass "c" renders into the layered target "maps" and names layer 3; it has layers 0 to 2.',
    ]);
    expect(errorsOf(withPass(layeredPlan(paints), "reader", { layer: 0 }))).toEqual([
      'Draw pass "reader" names layer 0 of "out", which is not a layered target.',
    ]);
    // Not a whole number, or below zero: not a pass at all.
    for (const layer of [-1, 0.5, "0"]) expect([layer, readExecutionPlan(withPass(layeredPlan(paints), "a", { layer })).ok]).toEqual([layer, false]);
  });

  it("refuses a layered target bound with neither `array` nor `layer`: nothing says which texture its shader is handed", () => {
    const bound = withPass(layeredPlan(paints), "reader", { textures: [{ binding: "maps", resourceId: "maps", sampled: "unfiltered" }] });
    expect(errorsOf(bound)).toEqual(['Pass "reader" binds the layered target "maps" as "maps" with neither `array` nor `layer`: it is bound whole, as texture_2d_array, or a layer of it as texture_2d.']);
  });

  it("binds ONE layer as a plain texture: inside the layers, on a layered target, and as nothing else at once", () => {
    const binding = (more: Record<string, unknown>, resourceId = "maps") => withPass(layeredPlan(paints), "reader", { textures: [{ binding: "maps", resourceId, sampled: "unfiltered", ...more }] });
    // Each layer the target has.
    for (const layer of [0, 1, 2]) expect([layer, errorsOf(binding({ layer }))]).toEqual([layer, []]);
    const read = readExecutionPlan(binding({ layer: 2 })).passes.find((pass) => pass.id === "reader") as DrawPassDescriptor;
    expect(read.textures).toEqual([{ binding: "maps", resourceId: "maps", sampled: "unfiltered", layer: 2 }]);
    // A layer it has not.
    expect(errorsOf(binding({ layer: 3 }))).toEqual(['Pass "reader" binds layer 3 of the layered target "maps" as "maps"; it has layers 0 to 2.']);
    // A layer of a target that has none.
    expect(errorsOf(binding({ layer: 0 }, "out"))).toEqual(['Pass "reader" binds layer 0 of "out" as "maps", which is not a layered target.']);
    // One binding is one WGSL type: a layer is not also the whole array, a ring's tap or its write target; and it is a whole number from 0.
    for (const more of [{ layer: 0, array: true }, { layer: 0, tap: 1 }, { layer: 0, live: true }, { layer: -1 }, { layer: 0.5 }, { layer: "0" }]) {
      expect([more, readExecutionPlan(binding(more)).ok]).toEqual([more, false]);
    }
  });

  it("keys a pass on the layer it binds, and leaves the key of a pass that binds none what it was", () => {
    const reader = (more: Record<string, unknown>): string =>
      passStructureKey(readExecutionPlan(withPass(layeredPlan(paints), "reader", { textures: [{ binding: "maps", resourceId: "maps", sampled: "unfiltered", ...more }] })).passes.find((pass) => pass.id === "reader") as DrawPassDescriptor);
    expect(reader({ layer: 0 })).not.toBe(reader({ layer: 1 }));
    expect(reader({ layer: 1 })).toBe(reader({ layer: 1 }));
    expect(reader({ layer: 0 })).not.toBe(reader({ array: true }));
    // The textures of a key that names no layer are four values a binding, as before the slice.
    expect(reader({ array: true })).toContain('["maps","maps","unfiltered",true]');
    expect(reader({ layer: 1 })).toContain('["maps","maps","unfiltered",false,1]');
  });

  it("refuses a layer whose first draw does not clear when the layers share a depth buffer, and allows it when they share none", () => {
    // Layer 1's first draw loads: it would depth-test against what layer 0's passes left.
    const loads = withPass(layeredPlan(paints), "b", { clear: false });
    expect(errorsOf(loads)).toEqual([
      'Draw pass "b" is the first into layer 1 of "maps" and does not clear: the layers share one depth buffer, so it would test against another layer\'s depth.',
    ]);
    // The legitimate case beside it: later draws of a layer that HAS been cleared load freely.
    const more = layeredPlan([...paints.slice(0, 2), { id: "b2", layer: 1, value: 5, clear: false }, paints[2]!]);
    expect(errorsOf(more)).toEqual([]);
    // And with no depth buffer there is nothing shared: an accumulating first draw is the trails pattern.
    expect(errorsOf(withPass(layeredPlan(paints, { depth: false }), "b", { clear: false }))).toEqual([]);
  });

  it("refuses an effect into a layered target: only a draw names a layer", () => {
    const plan = layeredPlan(paints);
    const effect = { kind: "effect", id: "fx", shader: "@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0); }", target: "maps" };
    const errors = errorsOf({ ...plan, passes: [...(plan.passes as unknown[]), effect] } as unknown as LogicalExecutionPlan);
    expect(errors).toContain('Pass "fx" is an effect into the layered target "maps"; only a draw names a layer to render into.');
  });

  it("keys the allocation on its layer count and its depth, and a draw on its layer", () => {
    const read = (layers: number, depth = true) => readExecutionPlan(layeredPlan(paints.slice(0, 1), { layers, depth })).resources[0]!;
    expect(resourceStructureKey(read(4))).not.toBe(resourceStructureKey(read(8)));
    expect(resourceStructureKey(read(4))).not.toBe(resourceStructureKey(read(4, false)));
    expect(resourceStructureKey(read(4))).toBe(resourceStructureKey(read(4)));
    const [a, b] = readExecutionPlan(layeredPlan(paints)).passes as DrawPassDescriptor[];
    // Two draws that differ in nothing but their id and their layer: with the id made the same, the layer alone tells them apart.
    expect(passStructureKey({ ...(b as DrawPassDescriptor), id: "a" })).not.toBe(passStructureKey(a as DrawPassDescriptor));
    expect(passStructureKey({ ...(b as DrawPassDescriptor), id: "a", layer: 0 })).toBe(passStructureKey(a as DrawPassDescriptor));
  });

  it("counts every layer and ONE depth buffer in the memory estimate", () => {
    const bytes = (layers: number, depth: boolean): number => estimateResourceBytes(readExecutionPlan(layeredPlan(paints.slice(0, 1), { layers, depth })).resources.filter((resource) => resource.id === "maps"));
    // 4 × 4 texels of r32float a layer; depth24plus is counted at four bytes a texel, once.
    expect([bytes(1, false), bytes(8, false), bytes(8, true)]).toEqual([64, 512, 576]);
  });

  it("ends a run of draws where the layer changes: a layer is what a render pass attaches", () => {
    // Two draws into each of two layers, none after the first of a layer clearing.
    const four = layeredPlan([
      { id: "a0", layer: 0, value: 1 },
      { id: "a1", layer: 0, value: 2, clear: false },
      { id: "b0", layer: 1, value: 3, clear: false },
      { id: "b1", layer: 1, value: 4, clear: false },
    ], { depth: false });
    const runs = renderPassRuns(readExecutionPlan(four).passes);
    expect(runs.map((run) => [run.passIds, run.target, run.layer])).toEqual([
      [["a0", "a1"], "maps", 0],
      // Same node, same target, not clearing: only the layer ends the run before it.
      [["b0", "b1"], "maps", 1],
      [["reader"], "out", undefined],
    ]);
  });
});

const input: FrameInputs = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [6, 2],
};

describe("T1623b: a layered target, on the mock device", () => {
  it("is ONE array texture and one depth buffer, and each run of draws attaches its own layer's view", async () => {
    const host = mockGpuHost({});
    const backend = createVgpuBackend({ host });
    try {
      await backend.initialize({});
      const device = host.device;
      if (device === undefined) throw new Error("the mock host has no device");
      const created: Array<{ label: string; layers: number; format: string }> = [];
      const createTexture = device.createTexture.bind(device);
      vi.spyOn(device, "createTexture").mockImplementation((descriptor) => {
        const size = descriptor.size as { depthOrArrayLayers?: number };
        created.push({ label: String(descriptor.label), layers: size.depthOrArrayLayers ?? 1, format: descriptor.format });
        const texture = createTexture(descriptor);
        // The mock's views carry no label: each is given the one it was asked for with.
        const createView = texture.createView.bind(texture);
        vi.spyOn(texture, "createView").mockImplementation((view) => Object.assign(createView(view), { label: view?.label }));
        return texture;
      });
      const attached: Array<{ color: string; depth: string | undefined; load: string }> = [];
      const createEncoder = device.createCommandEncoder.bind(device);
      vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor) => {
        const encoder = createEncoder(descriptor);
        const begin = encoder.beginRenderPass.bind(encoder);
        vi.spyOn(encoder, "beginRenderPass").mockImplementation((pass) => {
          const [first] = [...pass.colorAttachments];
          attached.push({
            color: String((first?.view as { label?: string } | undefined)?.label),
            depth: pass.depthStencilAttachment === undefined ? undefined : String((pass.depthStencilAttachment.view as { label?: string }).label),
            load: String(first?.loadOp),
          });
          return begin(pass);
        });
        return encoder;
      });
      const plan = layeredPlan([
        { id: "a0", layer: 0, value: 1 },
        { id: "a1", layer: 0, value: 2, clear: false },
        { id: "b0", layer: 1, value: 3 },
        { id: "c0", layer: 2, value: 4 },
      ]);
      const program = await backend.compile(plan);
      expect(created.filter((entry) => entry.label.startsWith("maps"))).toEqual([
        { label: "maps [layers]", layers: 3, format: "r32float" },
        { label: "maps [depth]", layers: 1, format: "depth24plus" },
      ]);
      attached.length = 0;
      backend.render(program, input);
      // Three passes into the array, one a layer (a0 and a1 are one run), and the reader's.
      const intoMaps = attached.filter((entry) => entry.color.startsWith("maps"));
      expect(intoMaps).toEqual([
        { color: "maps [layer 0]", depth: "maps [depth]", load: "clear" },
        { color: "maps [layer 1]", depth: "maps [depth]", load: "clear" },
        { color: "maps [layer 2]", depth: "maps [depth]", load: "clear" },
      ]);
      expect(attached).toHaveLength(4);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("keeps its two textures across a recompile that leaves its structure alone, and destroys both when another allocation replaces them", async () => {
    const host = mockGpuHost({});
    const backend = createVgpuBackend({ host });
    try {
      await backend.initialize({});
      const device = host.device;
      if (device === undefined) throw new Error("the mock host has no device");
      const created: string[] = [];
      const destroyed: string[] = [];
      const createTexture = device.createTexture.bind(device);
      vi.spyOn(device, "createTexture").mockImplementation((descriptor) => {
        const name = `${String(descriptor.label)} x${(descriptor.size as { depthOrArrayLayers?: number }).depthOrArrayLayers ?? 1}`;
        created.push(name);
        const texture = createTexture(descriptor);
        const destroy = texture.destroy.bind(texture);
        vi.spyOn(texture, "destroy").mockImplementation(() => {
          destroyed.push(name);
          destroy();
        });
        return texture;
      });
      const ofMaps = (names: string[]): string[] => names.filter((name) => name.startsWith("maps"));
      const paints = [{ id: "a", layer: 0, value: 1 }];
      await backend.compile(layeredPlan(paints));
      expect(ofMaps(created)).toEqual(["maps [layers] x3", "maps [depth] x1"]);
      // Another target joins the plan: a structural compile, and the layers are the textures they were.
      const same = layeredPlan(paints);
      await backend.compile({ ...same, resources: [...same.resources, { kind: "target", id: "spare", size: [2, 2], format: "rgba16float" }] } as unknown as LogicalExecutionPlan);
      expect(ofMaps(created)).toEqual(["maps [layers] x3", "maps [depth] x1"]);
      expect(ofMaps(destroyed)).toEqual([]);
      // One more layer is another allocation: the old array and its depth buffer go.
      await backend.compile(layeredPlan(paints, { layers: LAYERS + 1 }));
      expect(ofMaps(created)).toEqual(["maps [layers] x3", "maps [depth] x1", "maps [layers] x4", "maps [depth] x1"]);
      expect(ofMaps(destroyed)).toEqual(["maps [layers] x3", "maps [depth] x1"]);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });
});
