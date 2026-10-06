import { describe, expect, it } from "vitest";

import type { FrameInputs, LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { LAYERS, OUT_SIZE, layeredPlan } from "../layered-target.fixture.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T1623b slice 4 on a REAL device: what a shader reads from a layered target.
 *
 * The plans are `layered-target.fixture.ts`'s: draws paint numbers into the layers of
 * `maps`, and a reader copies each layer's first texel into two pixels of `out` through ONE
 * `texture_2d_array` binding, with the texture's own layer count beside it. Every number is
 * exact in a half float, so the claims are equalities.
 *
 * What would fail it: a draw that lands in another layer than the one it names, an array
 * view that does not hold the layers the draws wrote, a depth buffer that is not there (a
 * farther draw would paint over a nearer one) or that is not cleared between layers (a
 * layer's far draw would be rejected by the layer before it), and a boundary reset that
 * leaves a layer's pixels in place.
 */

const input = (frameIndex: number): FrameInputs => ({
  frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [OUT_SIZE[0], OUT_SIZE[1]],
});

/** A half float's value. */
function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

async function withBackend<T>(run: (backend: ReturnType<typeof createVgpuBackend>, problems: RuntimeDiagnostic[]) => Promise<T>): Promise<T> {
  // Required, never skipped: without a GPU nothing here reads a texel.
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const problems: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => problems.push(diagnostic));
  try {
    await backend.initialize({});
    return await run(backend, problems);
  } finally {
    backend.dispose();
  }
}

/** What the reader wrote: for each layer, (the layer's first texel, the texture's layer count). */
async function readLayers(backend: ReturnType<typeof createVgpuBackend>): Promise<number[][]> {
  const image = await backend.readOutput("out");
  expect([image.width, image.height, image.format]).toEqual([OUT_SIZE[0], OUT_SIZE[1], "rgba16float"]);
  const halves = new Uint16Array(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength / 2);
  const at = (x: number, y: number): number[] => [half(halves[(y * image.width + x) * 4] as number), half(halves[(y * image.width + x) * 4 + 1] as number)];
  const layers = Array.from({ length: LAYERS }, (_, layer) => at(layer * 2, 0));
  // Both pixels of a layer's column pair, on both rows, read the same thing.
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (const [x, y] of [[layer * 2 + 1, 0], [layer * 2, 1], [layer * 2 + 1, 1]] as const) expect(at(x, y)).toEqual(layers[layer]);
  }
  return layers;
}

const errors = (problems: RuntimeDiagnostic[]): RuntimeDiagnostic[] => problems.filter((entry) => entry.severity === "error");

describe("T1623b: a shader reads the layers the draws wrote", () => {
  it("lands each draw in the layer it names, and binds them all as one array of that many layers", async () => {
    await withBackend(async (backend, problems) => {
      // Painted out of order, so "the n-th draw is layer n" would read wrong.
      const program = await backend.compile(layeredPlan([
        { id: "c", layer: 2, value: 0.75 },
        { id: "a", layer: 0, value: 0.25 },
        { id: "b", layer: 1, value: 0.5 },
      ]));
      backend.render(program, input(0));
      expect(await readLayers(backend)).toEqual([[0.25, LAYERS], [0.5, LAYERS], [0.75, LAYERS]]);
      expect(errors(problems)).toEqual([]);
    });
  });

  it("binds ONE layer as a plain 2D texture, the layer its binding names and not the one its place suggests", async () => {
    await withBackend(async (backend, problems) => {
      const paints = [
        { id: "a", layer: 0, value: 0.25 },
        { id: "b", layer: 1, value: 0.5 },
        { id: "c", layer: 2, value: 0.75 },
      ];
      // map0 is layer 2, map1 layer 0, map2 layer 1. Green is the bound texture's width: a 4 x 4 layer, not an array.
      const program = await backend.compile(layeredPlan(paints, { views: [2, 0, 1] }));
      backend.render(program, input(0));
      expect(await readLayers(backend)).toEqual([[0.75, 4], [0.25, 4], [0.5, 4]]);
      // Another layer a binding is another plan: the same three layers in their own order.
      const straight = await backend.compile(layeredPlan(paints, { views: [0, 1, 2] }));
      backend.render(straight, input(1));
      expect(await readLayers(backend)).toEqual([[0.25, 4], [0.5, 4], [0.75, 4]]);
      // The same layer bound twice is the same texture twice.
      const twice = await backend.compile(layeredPlan(paints, { views: [1, 1, 2] }));
      backend.render(twice, input(2));
      expect(await readLayers(backend)).toEqual([[0.5, 4], [0.5, 4], [0.75, 4]]);
      expect(errors(problems)).toEqual([]);
    });
  });

  it("depth-tests a layer's draws against one another, and starts every layer from a cleared depth", async () => {
    await withBackend(async (backend, problems) => {
      const program = await backend.compile(layeredPlan([
        // Layer 0: a near draw, then a farther one that must not paint over it.
        { id: "near", layer: 0, value: 0.25, depth: 0.2 },
        { id: "far", layer: 0, value: 4, depth: 0.8, clear: false },
        // Layer 1: one far draw. Against layer 0's depth (0.2) it would be rejected; its own pass clears first.
        { id: "next", layer: 1, value: 0.5, depth: 0.8 },
        // Layer 2: a far draw, then a nearer one that must paint over it.
        { id: "back", layer: 2, value: 4, depth: 0.9 },
        { id: "front", layer: 2, value: 0.75, depth: 0.1, clear: false },
      ]));
      backend.render(program, input(0));
      expect((await readLayers(backend)).map(([value]) => value)).toEqual([0.25, 0.5, 0.75]);
      // The same on a second frame: nothing of the first frame's depth is left to test against.
      backend.render(program, input(1));
      expect((await readLayers(backend)).map(([value]) => value)).toEqual([0.25, 0.5, 0.75]);
      expect(errors(problems)).toEqual([]);
    });
  });

  it("with a device pass a draw, a draw that does not clear finds its layer's pixels and its layer's depth as the draw before left them", async () => {
    await withBackend(async (backend, problems) => {
      /* The same plan as above, but each draw is a render pass of its own (what timing a
         frame pass by pass does), so the second draw of a layer OPENS a pass that must load
         both attachments: clearing the colour would lose the near draw (layer 0), clearing
         the depth would let the far draw paint over it. */
      backend.setExactPassTiming(true);
      const program = await backend.compile(layeredPlan([
        { id: "near", layer: 0, value: 0.25, depth: 0.2 },
        { id: "far", layer: 0, value: 4, depth: 0.8, clear: false },
        { id: "next", layer: 1, value: 0.5, depth: 0.8 },
        { id: "back", layer: 2, value: 4, depth: 0.9 },
        { id: "front", layer: 2, value: 0.75, depth: 0.1, clear: false },
      ]));
      backend.render(program, input(0));
      expect((await readLayers(backend)).map(([value]) => value)).toEqual([0.25, 0.5, 0.75]);
      expect(errors(problems)).toEqual([]);
    });
  });

  it("refuses by name a layered target of more layers than the device has, before asking the device for it", async () => {
    await withBackend(async (backend, problems) => {
      const limit = backend.capabilities?.limits["maxTextureArrayLayers"] ?? 0;
      // WebGPU's floor; this device may have more.
      expect(limit).toBeGreaterThanOrEqual(256);
      const paints = [{ id: "a", layer: 0, value: 0.25 }];
      await backend.compile(layeredPlan(paints, { layers: limit }));
      expect(errors(problems)).toEqual([]);
      await expect(backend.compile(layeredPlan(paints, { layers: limit + 1 }))).rejects.toThrow();
      expect(errors(problems).map((entry) => [entry.code, entry.message])).toEqual([
        ["backend/resource-limit", `Resource "maps" has ${limit + 1} layers, and this device's maxTextureArrayLayers is ${limit}.`],
      ]);
    });
  });

  it("keeps a layer's pixels from frame to frame under an accumulating draw, and clears every layer at a document boundary", async () => {
    await withBackend(async (backend, problems) => {
      // No depth buffer: a first draw that does not clear is the trails pattern.
      const plan: LogicalExecutionPlan = layeredPlan([
        { id: "a", layer: 0, value: 0.25, clear: false },
        { id: "b", layer: 1, value: 0.5, clear: false },
        { id: "c", layer: 2, value: 0.75, clear: false },
      ], { depth: false });
      const program = await backend.compile(plan);
      backend.render(program, input(0));
      expect((await readLayers(backend)).map(([value]) => value)).toEqual([0.25, 0.5, 0.75]);
      // Nothing is drawn into the layers from here on: what they hold is what they held.
      for (const id of ["a", "b", "c"]) backend.updateUniforms({ passId: id, values: {}, skip: true });
      backend.render(program, input(1));
      expect((await readLayers(backend)).map(([value]) => value)).toEqual([0.25, 0.5, 0.75]);
      // The boundary rite (a document load): every layer is cleared, as a plain target is.
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      backend.render(program, input(2));
      expect((await readLayers(backend)).map(([value]) => value)).toEqual([0, 0, 0]);
      expect(errors(problems)).toEqual([]);
    });
  });

  it("carries the layers across a recompile that does not change them, and allocates anew when the layer count does", async () => {
    await withBackend(async (backend, problems) => {
      const accumulate = (layers: number): LogicalExecutionPlan => layeredPlan([{ id: "a", layer: 0, value: 0.25, clear: false }], { depth: false, layers });
      const first = await backend.compile(accumulate(LAYERS));
      backend.render(first, input(0));
      expect((await readLayers(backend))[0]).toEqual([0.25, LAYERS]);
      // A STRUCTURAL recompile (another target joins the plan) that leaves the layers' own structure alone,
      // with the draw skipped from the start: the carried layer still holds what was drawn.
      const skipped = accumulate(LAYERS);
      const again = await backend.compile({
        ...skipped,
        resources: [...skipped.resources, { kind: "target", id: "spare", size: [2, 2], format: "rgba16float" }],
        passes: (skipped.passes as unknown as Array<Record<string, unknown>>).map((pass) => (pass["id"] === "a" ? { ...pass, skip: true } : pass)),
      } as unknown as LogicalExecutionPlan);
      backend.render(again, input(1));
      expect((await readLayers(backend))[0]).toEqual([0.25, LAYERS]);
      // One more layer is another texture: zeroed, and the shader sees four layers.
      const more = accumulate(LAYERS + 1);
      const grown = await backend.compile({ ...more, passes: (more.passes as unknown as Array<Record<string, unknown>>).map((pass) => (pass["id"] === "a" ? { ...pass, skip: true } : pass)) } as unknown as LogicalExecutionPlan);
      backend.render(grown, input(2));
      expect((await readLayers(backend))[0]).toEqual([0, LAYERS + 1]);
      expect(errors(problems)).toEqual([]);
    });
  });
});
