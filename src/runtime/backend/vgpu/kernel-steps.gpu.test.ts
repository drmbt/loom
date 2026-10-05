import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import type { CompiledGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { pointStorageId } from "../../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../../nodes/definitions/test-support.ts";
import { pointRandReference } from "../../../points/rng.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import type { VgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1583b — KERNEL STEPS on a real device (§V147): a Point Kernel run several times per
 * displayed frame, through the compiler, the plan and the encoder.
 *
 * Every fixture kernel makes the thing under test the VALUE it writes, so a readback is
 * the history: a counter is "how many runs happened", a sum of indices is "which index
 * each run read", and so on. All values are small integers or dyadic fractions in f32,
 * so every assertion is exact.
 *
 * Each case names the fault it was seen red against (the assessment's risks, by number).
 */

const SETTINGS = {
  outputResolution: { width: 32, height: 32 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

/** position is the port's promise; `acc` and `aux` are what the fixtures count in. */
const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "acc", type: "f32", default: [0] },
  { name: "aux", type: "f32", default: [0] },
]);

const CAPACITY = 16;
const FRAME_DELTA = 1 / 64; // dyadic, so a divided delta is exact in f32

interface KernelNode {
  readonly id: string;
  readonly kernel: string;
  readonly substeps?: unknown;
  readonly iterations?: unknown;
  readonly attributes?: string;
  readonly seed?: number;
  /** Wire this node's `in` from another kernel (processor mode). */
  readonly from?: string;
}

function graphOf(kernels: ReadonlyArray<KernelNode>): GraphDocument {
  const last = kernels[kernels.length - 1] as KernelNode;
  const nodes: Record<string, unknown> = {
    draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: CAPACITY, sizePixels: 2 } },
    out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
  };
  const edges: Record<string, unknown> = {
    draw: { id: "draw", source: { nodeId: last.id, portId: "out" }, target: { nodeId: "draw", portId: "points" } },
    out: { id: "out", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  };
  for (const kernel of kernels) {
    nodes[kernel.id] = {
      id: kernel.id,
      type: "pointKernel",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: {
        capacity: CAPACITY,
        seed: kernel.seed ?? 7,
        attributes: kernel.attributes ?? ATTRIBUTES,
        kernel: kernel.kernel,
        ...(kernel.substeps === undefined ? {} : { substeps: kernel.substeps }),
        ...(kernel.iterations === undefined ? {} : { iterations: kernel.iterations }),
      },
    };
    if (kernel.from !== undefined) {
      edges[`in:${kernel.id}`] = {
        id: `in:${kernel.id}`,
        source: { nodeId: kernel.from, portId: "out" },
        target: { nodeId: kernel.id, portId: "in" },
      };
    }
  }
  return { revision: 1, nodes, edges, groups: {} } as never as GraphDocument;
}

interface Rig {
  readonly plan: CompiledGraph;
  readonly backend: VgpuBackend;
  readonly reported: RuntimeDiagnostic[];
  render(frameIndex: number): void;
  /** One attribute of one kernel node, read back after the frame's own swap. */
  read(nodeId: string, attribute: string): Promise<Float32Array>;
  /** The node's whole packed buffer, for byte comparisons. */
  bytes(nodeId: string): Promise<Uint8Array>;
}

function withRig<T>(kernels: ReadonlyArray<KernelNode>, body: (rig: Rig) => Promise<T>): Promise<T> {
  return withGraph(graphOf(kernels), body);
}

async function withGraph<T>(graph: GraphDocument, body: (rig: Rig) => Promise<T>): Promise<T> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const reported: RuntimeDiagnostic[] = [];
  try {
    await backend.initialize({});
    backend.onDiagnostic((diagnostic) => {
      reported.push(diagnostic);
    });
    const compiled = await backend.compile(plan);
    const parametersOf = (nodeId: string): Readonly<Record<string, unknown>> =>
      (graph.nodes as Record<string, { parameters: Record<string, unknown> }>)[nodeId]?.parameters ?? {};
    return await body({
      plan,
      backend,
      reported,
      render: (frameIndex) =>
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex * FRAME_DELTA, deltaSeconds: FRAME_DELTA, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [32, 32],
        }),
      read: async (nodeId, attribute) =>
        kernelRegionSlice(
          { type: "pointKernel", parameters: parametersOf(nodeId) },
          await backend.readBuffer(pointStorageId(nodeId)),
          attribute,
        ).floats,
      bytes: async (nodeId) => new Uint8Array(await backend.readBuffer(pointStorageId(nodeId))),
    });
  } finally {
    backend.dispose();
  }
}

/** The x of every point's position: a vec3f strides at four floats. */
function xs(position: Float32Array): number[] {
  return Array.from({ length: CAPACITY }, (_unused, point) => position[point * 4] as number);
}

const every = (value: number): number[] => Array<number>(CAPACITY).fill(value);

const COUNTER = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.x = p.position.x + 1.0;
  return q;
}`;

/** A processor whose WHOLE schema comes from upstream: it copies what it is handed. */
const POSITION_ONLY = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
]);
const COPY = `fn process(p: Point, ctx: PointCtx) -> Point {
  return p;
}`;

describe("kernel steps: the count (T1583b)", () => {
  it("runs frames × substeps times: (4 frames, 3 substeps) = 12 = (12 frames, 1)", async () => {
    const stepped = await withRig([{ id: "k", kernel: COUNTER, substeps: 3 }], async (rig) => {
      for (let frame = 0; frame < 4; frame += 1) rig.render(frame);
      return xs(await rig.read("k", "position"));
    });
    const single = await withRig([{ id: "k", kernel: COUNTER }], async (rig) => {
      for (let frame = 0; frame < 12; frame += 1) rig.render(frame);
      return xs(await rig.read("k", "position"));
    });
    // Red against: the region emitted with no inner swap (every run re-read the frame's
    // first half and wrote 1 over 1), and against a count that never reached the encoder.
    expect(stepped).toEqual(every(12));
    expect(single).toEqual(every(12));
  }, 60_000);

  /*
   * The consumer binds the kernel's WRITE half, and the encoder swaps the pair between
   * runs — so the consumer's binding has to follow every swap. BOTH parities, because an
   * odd count swaps an even number of times and lands the write half back on the buffer
   * the consumer started the frame bound to: at 3 a consumer that never moved reads the
   * right answer by accident. At 4 it reads 11, the run before the last (seen red).
   */
  it.each([
    { substeps: 4, frames: 3 },
    { substeps: 3, frames: 4 },
  ])("a downstream consumer reads the LAST of $substeps runs (risk 1)", async ({ substeps, frames }) => {
    const copied = await withRig(
      [
        { id: "k", kernel: COUNTER, substeps },
        { id: "copy", kernel: COPY, attributes: POSITION_ONLY, from: "k" },
      ],
      async (rig) => {
        for (let frame = 0; frame < frames; frame += 1) rig.render(frame);
        return xs(await rig.read("copy", "position"));
      },
    );
    expect(copied).toEqual(every(12));
  }, 60_000);

  it("substeps 2 × iterations 3 is six dispatches, and names each of them", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.x = p.position.x + 1.0;
  // 100 per substep index, 1 per iteration index, 1000 when both counts read right.
  q.acc = p.acc + f32(ctx.substep) * 100.0 + f32(ctx.iteration);
  if (ctx.substeps == 2u && ctx.iterations == 3u) { q.acc = q.acc + 1000.0; }
  // The step each run was handed, kept from the last one.
  q.aux = ctx.delta;
  return q;
}`;
    await withRig([{ id: "k", kernel, substeps: 2, iterations: 3 }], async (rig) => {
      rig.render(0);
      expect(xs(await rig.read("k", "position"))).toEqual(every(6));
      // Substep indices 0,0,0,1,1,1 (300) and iteration indices 0,1,2,0,1,2 (6), six
      // right counts (6000). Red against every run reading the last block: 6612.
      expect([...(await rig.read("k", "acc"))]).toEqual(every(6000 + 300 + 6));
      // HALVED, not sixthed: iterations repeat inside a substep at the same step.
      expect([...(await rig.read("k", "aux"))]).toEqual(every(FRAME_DELTA / 2));
    });
  }, 60_000);
});

describe("kernel steps: what each run reads (T1583b)", () => {
  it("every run reads its OWN index: 0+1+…+7 = 28 at eight substeps (risk 2)", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.acc = p.acc + f32(ctx.substep);
  return q;
}`;
    await withRig([{ id: "k", kernel, substeps: 8 }], async (rig) => {
      rig.render(0);
      // Seen red at 56 = 7 × 8 with ONE block that every run's values are written into
      // before the first dispatch (what one encoder per frame would do to a block that is
      // rewritten between dispatches), and at 49 with runs 1..7 bound to the last block.
      expect([...(await rig.read("k", "acc"))]).toEqual(every(28));
    });
  }, 60_000);

  it("ctx.delta is the frame's step over the substep count, bit for bit", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.acc = ctx.delta * 8.0;
  q.aux = p.aux + ctx.delta;
  return q;
}`;
    await withRig([{ id: "k", kernel, substeps: 8 }], async (rig) => {
      rig.render(0);
      // Red against an undivided delta: 8 × the frame's step.
      expect([...(await rig.read("k", "acc"))]).toEqual(every(Math.fround(FRAME_DELTA)));
      // And the eight runs together cover exactly the frame.
      expect([...(await rig.read("k", "aux"))]).toEqual(every(Math.fround(FRAME_DELTA)));
    });
  }, 60_000);

  it("pointAt reads the previous RUN: one lit slot reaches exactly `substeps` further per frame", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.firstRun == 1u) {
    q.acc = select(0.0, 1.0, ctx.index == 0u);
    return q;
  }
  if (ctx.index > 0u) { q.acc = max(p.acc, pointAt(ctx.index - 1u).acc); }
  return q;
}`;
    const lit = (acc: Float32Array): number => [...acc].filter((value) => value === 1).length;
    await withRig([{ id: "k", kernel, substeps: 5 }], async (rig) => {
      // Frame 0: run 0 seeds slot 0, runs 1..4 carry it four slots along.
      rig.render(0);
      const first = await rig.read("k", "acc");
      expect([...first]).toEqual([...Array<number>(5).fill(1), ...Array<number>(CAPACITY - 5).fill(0)]);
      // Frame 1: five more runs, five more slots — exactly, because each run reads the
      // half the run before it wrote. Red against a run re-reading the pre-frame half: 6.
      rig.render(1);
      expect(lit(await rig.read("k", "acc"))).toBe(10);
    });
    await withRig([{ id: "k", kernel }], async (rig) => {
      rig.render(0);
      rig.render(1);
      // The control: at one run per frame it is one link per frame.
      expect(lit(await rig.read("k", "acc"))).toBe(2);
    });
  }, 60_000);

  it("firstRun is 1 on run 0 of the seeding frame only: 100, then +1 three times (risk 3)", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.firstRun == 1u) { q.acc = 100.0; } else { q.acc = p.acc + 1.0; }
  return q;
}`;
    await withRig([{ id: "k", kernel, substeps: 4 }], async (rig) => {
      rig.render(0);
      // Red against firstRun held for the whole frame: 100.
      expect([...(await rig.read("k", "acc"))]).toEqual(every(103));
      rig.render(1);
      expect([...(await rig.read("k", "acc"))]).toEqual(every(107));
      // A seek clears the buffers, and the frame after it seeds once again.
      rig.backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      rig.render(0);
      expect([...(await rig.read("k", "acc"))]).toEqual(every(103));
    });
  }, 60_000);

  it("each run draws its own random numbers, and run 0 keeps the unstepped stream (risk 4)", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let draw = pointRand(ctx.index, 5u);
  if (ctx.substep == 0u) { q.position.x = draw; }
  if (ctx.substep == 1u) { q.acc = draw; }
  if (ctx.substep == 2u) { q.aux = draw; }
  return q;
}`;
    const seed = 41;
    const reference = (run: number): number[] =>
      Array.from({ length: CAPACITY }, (_unused, id) => Math.fround(pointRandReference(seed, id, 3, 5, run)));
    await withRig([{ id: "k", kernel, substeps: 3, seed }], async (rig) => {
      rig.render(3);
      const run0 = xs(await rig.read("k", "position"));
      const run1 = [...(await rig.read("k", "acc"))];
      const run2 = [...(await rig.read("k", "aux"))];
      // Run 0 is the stream a kernel run once per frame has always drawn (no `run`).
      expect(run0).toEqual(
        Array.from({ length: CAPACITY }, (_unused, id) => Math.fround(pointRandReference(seed, id, 3, 5))),
      );
      // Red against a seed that is not folded per run: all three equal run 0.
      expect(run1).toEqual(reference(1));
      expect(run2).toEqual(reference(2));
      expect(run1).not.toEqual(run0);
      expect(run2).not.toEqual(run1);
    });
  }, 60_000);
});

describe("kernel steps: state across frames (T1583b, §V170)", () => {
  const WALK = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.firstRun == 1u) { q.position = vec3f(0.0); q.acc = 0.0; return q; }
  q.acc = p.acc + (pointRand(ctx.index, 9u) - 0.5);
  q.position.x = p.position.x + q.acc * ctx.delta;
  return q;
}`;

  it("two runs to frame 5 at seven substeps are byte-identical, and so is a seek back", async () => {
    const play = (frames: number): Promise<Uint8Array> =>
      withRig([{ id: "k", kernel: WALK, substeps: 7 }], async (rig) => {
        for (let frame = 0; frame <= frames; frame += 1) rig.render(frame);
        return rig.bytes("k");
      });
    const first = await play(5);
    const second = await play(5);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    // Not a constant that would compare equal whatever ran: the walk moved.
    expect(first.some((byte) => byte !== 0)).toBe(true);

    // §V170: a backward seek resets the state and replays from frame 0. The state at
    // frame 3 reached that way is the state a run that only ever went to 3 has.
    const direct = await play(3);
    const sought = await withRig([{ id: "k", kernel: WALK, substeps: 7 }], async (rig) => {
      for (let frame = 0; frame <= 5; frame += 1) rig.render(frame);
      rig.backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      for (let frame = 0; frame <= 3; frame += 1) rig.render(frame);
      return rig.bytes("k");
    });
    expect(Buffer.from(sought).equals(Buffer.from(direct))).toBe(true);
    expect(Buffer.from(direct).equals(Buffer.from(first))).toBe(false);
  }, 120_000);

  it("a count driven from 1 to 3 mid-run carries on from the state it had", async () => {
    await withRig([{ id: "k", kernel: COUNTER }], async (rig) => {
      const begin = rig.plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin");
      if (begin === undefined) throw new Error("the kernel's plan carries no region at count 1 (§V358)");
      const builds = rig.backend.status.resourceBuilds;
      rig.render(0);
      rig.render(1);
      expect(xs(await rig.read("k", "position"))).toEqual(every(2));
      // The animator's own call: a loop-begin's values, pushed like any uniform (§V5).
      rig.backend.updateUniforms({ passId: begin.id, values: { count: 3, iterations: 1 } });
      rig.render(2);
      rig.render(3);
      // 2 + 3 + 3. Red against a count that rebuilt the pair (6) or never arrived (4).
      expect(xs(await rig.read("k", "position"))).toEqual(every(8));
      expect(rig.backend.status.resourceBuilds).toBe(builds);
      expect(rig.reported.filter((diagnostic) => diagnostic.severity !== "info")).toEqual([]);
    });
  }, 60_000);
});

/**
 * The LOOP path — a frame already open when `render()` is called, which is how the app
 * runs. Two things differ from the direct path and both are about §V8: a run's uniform
 * block is a buffer, so it cannot be created once the frame is open, and the animator
 * pushes a driven count from INSIDE the frame callback.
 */
describe("kernel steps: inside an open frame (T1583b, §V8)", () => {
  /** The rate form, as an expression on the parameter — what makes the count per-frame. */
  const RATE = {
    mode: "expression",
    bindings: {
      expression: { kind: "expression", source: "clamp(ceil(delta * 240), 1, 16)" },
      static: { kind: "static", value: 1 },
    },
  };

  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /** One loop tick: push a count the way the animator does, then render, in the callback. */
  async function tick(rig: Rig, frameIndex: number, count: number): Promise<void> {
    const begin = rig.plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin");
    if (begin === undefined) throw new Error("no kernel region in the plan");
    let rendered = false;
    const control = rig.backend.loop(() => {
      if (rendered) return;
      rendered = true;
      rig.backend.updateUniforms({ passId: begin.id, values: { count, iterations: 1 } });
      rig.render(frameIndex);
    });
    await until(() => rendered, `loop tick ${frameIndex}`);
    control.stop();
  }

  const shortfalls = (rig: Rig): string[] =>
    rig.reported.filter((d) => d.code === "backend/resource-limit").map((d) => d.message);
  const frameErrors = (rig: Rig): string[] =>
    rig.reported.filter((d) => d.code === "backend/frame-error").map((d) => d.message);

  it("a count an expression drives is ready for every value it can take, the frame it arrives", async () => {
    await withRig([{ id: "k", kernel: COUNTER, substeps: RATE }], async (rig) => {
      const begin = rig.plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin");
      // The compiler said how far a moving count can go: Substeps' ceiling × the one
      // iteration, which is what the backend makes blocks for before any frame opens.
      expect(begin?.kind === "loop" ? begin.steps?.prepare : undefined).toBe(64);
      await tick(rig, 0, 5);
      // All five runs in the very frame the count arrived in. Red against blocks made
      // only for the count the plan was compiled at: one run, and a shortfall reported.
      expect(xs(await rig.read("k", "position"))).toEqual(every(5));
      await tick(rig, 1, 16);
      expect(xs(await rig.read("k", "position"))).toEqual(every(21));
      expect(shortfalls(rig)).toEqual([]);
      expect(frameErrors(rig)).toEqual([]);
    });
  }, 60_000);

  it("a count pushed past what was prepared runs what it has blocks for, says so, and is whole next frame", async () => {
    // A STATIC count: the plan prepares for exactly it, because nothing in the document
    // can move it inside a frame. Pushing it anyway is what the fallback is for.
    await withRig([{ id: "k", kernel: COUNTER }], async (rig) => {
      await tick(rig, 0, 5);
      // No block was allocated inside the frame (that would be a frame error, §V8) and
      // the frame did not run five runs against one block: it ran the one it had.
      expect(frameErrors(rig)).toEqual([]);
      expect(xs(await rig.read("k", "position"))).toEqual(every(1));
      expect(shortfalls(rig)).toEqual([
        'Node "k" was asked for 5 kernel steps inside a frame, with uniform blocks ready for 1; this frame ran 1.',
      ]);
      // Frame entry made the rest, so the next frame runs all five.
      await tick(rig, 1, 5);
      expect(xs(await rig.read("k", "position"))).toEqual(every(6));
      expect(shortfalls(rig)).toHaveLength(1);
    });
  }, 60_000);
});

describe("kernel steps: what is refused, by name (T1583b, §V288)", () => {
  it("a processor whose whole schema is upstream's runs one step, undivided, and says why (risk 5)", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.x = p.position.x + ctx.delta;
  return q;
}`;
    await withRig(
      [
        { id: "source", kernel: COPY, attributes: POSITION_ONLY },
        { id: "k", kernel, attributes: POSITION_ONLY, from: "source", substeps: 4 },
      ],
      async (rig) => {
        rig.render(0);
        rig.render(1);
        // ONE run per frame, at the frame's WHOLE step: upstream is 0 every frame, so the
        // result is one delta. Seen red at a quarter of it with the kernel stepped anyway —
        // four runs, each writing upstream plus a divided delta: silent slow motion.
        expect(xs(await rig.read("k", "position"))).toEqual(every(FRAME_DELTA));
        const refusals = rig.plan.diagnostics.filter((d) => d.code === "compiler/substeps-refused");
        expect(refusals.map((d) => d.nodeId)).toEqual(["k"]);
        expect(refusals[0]?.message).toContain('Node "k" asked for 4 steps per frame');
        expect(refusals[0]?.message).toContain("read from the incoming point set");
        expect(refusals[0]?.message).toContain("It runs one step per frame.");
      },
    );
  }, 60_000);

  it("a processor that keeps ONE attribute of its own does step — the guard's legitimate case", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.acc = p.acc + 1.0;
  return q;
}`;
    await withRig(
      [
        { id: "source", kernel: COPY, attributes: POSITION_ONLY },
        { id: "k", kernel, from: "source", substeps: 4 },
      ],
      async (rig) => {
        expect(rig.plan.diagnostics.filter((d) => d.code === "compiler/substeps-refused")).toEqual([]);
        rig.render(0);
        rig.render(1);
        // `position` is re-read from upstream each run; `acc` is the kernel's own state.
        expect([...(await rig.read("k", "acc"))]).toEqual(every(8));
      },
    );
  }, 60_000);

  /*
   * Risk 8. A kernel on a feedback loop's cycle: the loop reads the picture the kernel's
   * points were drawn into, and the kernel samples the loop. If BOTH regions were emitted
   * the kernel's would sit inside the loop's, which the plan reader refuses outright — a
   * black frame. That cannot happen today, and this pins why: the kernel's pair swaps
   * inside the loop's span, so the loop is the one refused, by name, and the kernel keeps
   * its steps. The guard for the day a loop CAN hold a kernel is in `applyKernelSteps`
   * (substeps.test.ts drives it with an emitted region).
   */
  it("a kernel on a feedback loop's cycle keeps its steps; the loop is the one refused, and the plan is whole", async () => {
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.x = p.position.x + 1.0 + fieldAt(p.position).r * 0.0;
  return q;
}`;
    const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string): unknown => ({
      id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(label === undefined ? {} : { label }),
    });
    const graph = {
      revision: 1,
      nodes: {
        loop: node("loop", "feedback", { source: "draw1", substeps: 4 }),
        k: node("k", "pointKernel", { capacity: CAPACITY, attributes: ATTRIBUTES, kernel, substeps: 3 }),
        draw: node("draw", "renderPoints", { count: CAPACITY, sizePixels: 2 }, "draw1"),
        out: node("out", "output", {}),
      },
      edges: {
        field: { id: "field", source: { nodeId: "loop", portId: "out" }, target: { nodeId: "k", portId: "field" } },
        points: { id: "points", source: { nodeId: "k", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        out: { id: "out", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never as GraphDocument;
    await withGraph(graph, async (rig) => {
      // `withGraph` already refused any error: no "opens inside loop" plan-invalid.
      const regions = rig.plan.passes.filter((pass) => pass.kind === "loop" && pass.edge === "begin");
      expect(regions.map((pass) => (pass.kind === "loop" ? pass.nodeId : undefined))).toEqual(["k"]);
      const refused = rig.plan.diagnostics.filter((d) => d.code === "compiler/substeps-refused");
      expect(refused.map((d) => d.nodeId)).toEqual(["loop"]);
      rig.render(0);
      rig.render(1);
      expect(xs(await rig.read("k", "position"))).toEqual(every(6));
    });
  }, 60_000);
});
