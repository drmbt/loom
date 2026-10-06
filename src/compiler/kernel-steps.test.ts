import { describe, expect, it } from "vitest";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import {
  MAX_KERNEL_STEPS,
  MAX_KERNEL_SUBSTEPS,
  expandLoops,
  passStructureKey,
  rateStepBounds,
  rateSubsteps,
  readExecutionPlan,
} from "../runtime/backend/plan.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";
import { compileGraph } from "./compile.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { prepareFrameCompiler } from "./frame-compile.ts";
import { applyKernelSteps, kernelStepCounts, kernelStepsFor } from "./substeps.ts";
import type { ResolvedNode } from "./validate.ts";

/**
 * KERNEL STEPS at the plan level (T1583b).
 *
 * The pixels' half — that N runs really happen, each on the half the last one wrote, each
 * with its own index — is `kernel-steps.gpu.test.ts`, on a real device. This file defends
 * what the device cannot tell you: that the region is THERE at count 1 (§V358), that a
 * count is a value and the pair is structure, that the per-frame path derives the same
 * counts the full compile does, and that every refusal names its node and its reason.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

function kernelGraph(parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      k: { id: "k", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 8, ...parameters } },
      draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8 } },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "k", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  } as never as GraphDocument;
}

const compile = (parameters: Record<string, unknown> = {}) =>
  compileGraph({ graph: kernelGraph(parameters), settings, registry, capabilities: TIER_B_CAPABILITIES });

const begins = (passes: ReadonlyArray<PassDescriptor>) =>
  passes.flatMap((pass) => (pass.kind === "loop" && pass.edge === "begin" ? [pass] : []));

const expression = (source: string) => ({
  mode: "expression",
  bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: 1 } },
});

describe("kernel steps: the declaration (T1583b, §V358)", () => {
  it("every node that declares steps names two number parameters, and neither is compileTime", () => {
    const declarers = allNodeDefinitions.filter((definition) => definition.steps !== undefined);
    // The row built steps for the plain Point Kernel and deliberately left the advanced one out.
    // T1585b: the Rope declares them too, as a rate (the next test).
    expect(declarers.map((definition) => definition.type)).toEqual(["pointKernel", "pointRope"]);
    for (const definition of declarers.filter((entry) => typeof entry.steps?.substeps === "string")) {
      const schema = effectiveParameterSchema(definition, {});
      for (const key of [definition.steps?.substeps as string, definition.steps?.iterations ?? ""]) {
        // A compileTime count would make driving it a rebuild, and would take the whole
        // document off the values-only frame path (`structuralParameterKeys`).
        expect(schema[key], `${definition.type}.${key}`).toMatchObject({ type: "number", default: 1, min: 1 });
        expect(schema[key]?.compileTime, `${definition.type}.${key}`).toBeUndefined();
      }
    }
  });

  it("a RATE declaration names three number parameters, none compileTime, and its clamps stay inside what a region may run (T1585b)", () => {
    const rated = allNodeDefinitions.filter((definition) => typeof definition.steps?.substeps === "object");
    expect(rated.map((definition) => definition.type)).toEqual(["pointRope"]);
    for (const definition of rated) {
      const declared = definition.steps?.substeps;
      if (declared === undefined || typeof declared === "string") throw new Error("not a rate");
      const schema = effectiveParameterSchema(definition, {});
      for (const key of [declared.rate, declared.min, declared.max]) {
        expect(schema[key], `${definition.type}.${key}`).toMatchObject({ type: "number" });
        // The count follows the frame, so each of the three is a value (§V358).
        expect(schema[key]?.compileTime, `${definition.type}.${key}`).toBeUndefined();
      }
      // A Min or Max the region could not run would be clamped in silence at the backend.
      for (const key of [declared.min, declared.max]) {
        expect(schema[key], `${definition.type}.${key}`).toMatchObject({ min: 1, max: MAX_KERNEL_SUBSTEPS, range: "bounded" });
      }
    }
  });
});

describe("kernel steps: the two counts (T1583b)", () => {
  it("multiplies substeps by iterations, and rounds and floors each at 1", () => {
    expect(kernelStepCounts(2, 3)).toEqual({ substeps: 2, iterations: 3, count: 6 });
    expect(kernelStepCounts(undefined, undefined)).toEqual({ substeps: 1, iterations: 1, count: 1 });
    expect(kernelStepCounts(0, -4)).toEqual({ substeps: 1, iterations: 1, count: 1 });
    expect(kernelStepCounts(3.6, 2.4)).toEqual({ substeps: 4, iterations: 2, count: 8 });
    expect(kernelStepCounts(Number.NaN, "8")).toEqual({ substeps: 1, iterations: 1, count: 1 });
  });

  it("gives way on ITERATIONS at the ceiling, never on the time step", () => {
    // 64 × 8 = 512 asked. The substeps stand, because they set the step size.
    expect(kernelStepCounts(64, 8)).toEqual({ substeps: 64, iterations: 4, count: 256, askedIterations: 8 });
    expect(kernelStepCounts(3, 100)).toEqual({ substeps: 3, iterations: 85, count: 255, askedIterations: 100 });
    // Exactly at the ceiling is not over it.
    expect(kernelStepCounts(16, 16)).toEqual({ substeps: 16, iterations: 16, count: MAX_KERNEL_STEPS });
    expect(kernelStepCounts(1000, 1).substeps).toBe(MAX_KERNEL_SUBSTEPS);
  });
});

describe("kernel steps: the region (T1583b, §V358)", () => {
  it("wraps the kernel's one dispatch at count 1, and leaves the pair's swap after its consumer", () => {
    const plan = compile();
    expect(plan.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const pair = pointStorageId("k");
    const order = plan.passes.map((pass) => `${pass.kind}:${pass.kind === "loop" ? pass.edge : pass.id}`);
    const at = order.indexOf("loop:begin");
    // begin, the dispatch, end — and nothing else inside.
    expect(order.slice(at, at + 3)).toEqual(["loop:begin", `dispatch:${String(plan.passes[at + 1]?.id)}`, "loop:end"]);
    expect(plan.passes[at]).toEqual({
      kind: "loop",
      id: `${pair}#loop:begin`,
      edge: "begin",
      loopId: pair,
      count: 1,
      nodeId: "k",
      steps: { pair, iterations: 1, prepare: 1 },
    });
    // ONE swap of the pair in the whole plan, after the draw that reads it (§V22) — a
    // swap inside the region would hand consumers the half before the last run.
    const swaps = plan.passes.flatMap((pass, index) => (pass.kind === "swap" && pass.resourceId === pair ? [index] : []));
    const draw = plan.passes.findIndex((pass) => pass.kind === "draw");
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toBeGreaterThan(draw);
    expect(draw).toBeGreaterThan(at + 2);
  });

  it("a count is a VALUE: 1, 8 and 2×3 are one plan signature, and the dispatch pass is one key", () => {
    const one = compile();
    const eight = compile({ substeps: 8 });
    const six = compile({ substeps: 2, iterations: 3 });
    expect(eight.signature).toBe(one.signature);
    expect(six.signature).toBe(one.signature);
    expect(begins(eight.passes)[0]).toMatchObject({ count: 8, steps: { iterations: 1, prepare: 8 } });
    expect(begins(six.passes)[0]).toMatchObject({ count: 6, steps: { iterations: 3, prepare: 6 } });
    // The encoder walks the dispatch `count` times: the same pass object, repeated.
    const dispatches = expandLoops(six.passes).filter((pass) => pass.kind === "dispatch");
    expect(dispatches).toHaveLength(6);
    expect(new Set(dispatches).size).toBe(1);
  });

  it("which PAIR a region steps is structure", () => {
    const [begin] = begins(compile().passes);
    if (begin?.steps === undefined) throw new Error("no kernel region");
    const other = { ...begin, steps: { ...begin.steps, pair: "scratch:other:@points" } };
    expect(passStructureKey(other)).not.toBe(passStructureKey(begin));
    // …and neither value on it is.
    const moved = { ...begin, count: 12, steps: { ...begin.steps, iterations: 3, prepare: 64 } };
    expect(passStructureKey(moved)).toBe(passStructureKey(begin));
  });

  it("prepares for the parameter's CEILING when a count can move per frame, and for the count when it cannot", () => {
    const prepared = (parameters: Record<string, unknown>) => begins(compile(parameters).passes)[0]?.steps?.prepare;
    expect(prepared({ substeps: 5, iterations: 2 })).toBe(10);
    // Notch's rate form: the count arrives inside the frame, so every value Substeps can
    // take has to be ready before the frame opens (§V8).
    expect(prepared({ substeps: expression("clamp(ceil(delta * 240), 1, 16)") })).toBe(MAX_KERNEL_SUBSTEPS);
    expect(prepared({ substeps: expression("2"), iterations: 3 })).toBe(MAX_KERNEL_SUBSTEPS * 3);
    expect(prepared({ substeps: 2, iterations: expression("4") })).toBe(MAX_KERNEL_STEPS);
  });

  it("says by name when the product is over the ceiling, and runs the iterations that fit", () => {
    const plan = compile({ substeps: 64, iterations: 8 });
    const [begin] = begins(plan.passes);
    expect(begin).toMatchObject({ count: 256, steps: { iterations: 4 } });
    const warnings = plan.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.substepsRefused);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.nodeId).toBe("k");
    expect(warnings[0]?.message).toBe(
      'Node "k" asked for "substeps" 64 × "iterations" 8 = 512 steps per frame, above the ceiling of 256; it runs 4 iterations per substep.',
    );
  });
});

describe("kernel steps: the per-frame path agrees with the full compile (T1583b, T1182)", () => {
  it("re-derives count and iterations from a driven Substeps without leaving the values-only path", () => {
    const request = {
      graph: kernelGraph({ substeps: expression("clamp(frame + 1, 1, 64)"), iterations: 3 }),
      settings,
      registry,
      capabilities: TIER_B_CAPABILITIES,
    };
    const frames = prepareFrameCompiler(request);
    expect(frames.reason).toBeNull();
    expect(frames.uniformOnly).toBe(true);
    for (const frameIndex of [0, 4, 63, 200]) {
      const frame = { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline" as const, randomSeed: 7 };
      const fast = frames.compileFrame({ frame });
      const full = compileGraph({ ...request, resolution: { frame } });
      if (fast === null) throw new Error(`the values-only path refused frame ${frameIndex}: ${String(frames.reason)}`);
      // Frame 4 is 5 substeps × 3; frame 200 is the ceiling, where iterations give way.
      expect(begins(fast.passes), `frame ${frameIndex}`).toEqual(begins(full.passes));
      expect(fast.signature).toBe(full.signature);
    }
    const at4 = frames.compileFrame({ frame: { timeSeconds: 4 / 60, deltaSeconds: 1 / 60, frameIndex: 4, mode: "offline", randomSeed: 7 } });
    expect(begins(at4?.passes ?? [])[0]).toMatchObject({ count: 15, steps: { iterations: 3 } });
  });
});

/**
 * `applyKernelSteps` on hand-built pass lists, for the shapes no document can produce
 * today. The real ones go through `compileGraph` above and on the device.
 */
describe("kernel steps: what is refused, by name (T1583b, §V288)", () => {
  const stepping = { steps: { substeps: "substeps", iterations: "iterations" } } as unknown as NodeDefinition;
  const node = (parameters: Record<string, unknown>): ResolvedNode =>
    ({ node: { parameters: {} }, definition: stepping, parameters, parameterMaps: {} }) as unknown as ResolvedNode;
  const PAIR = "scratch:k:@points";
  const dispatch = (id = "k:kernel") => ({
    kind: "dispatch",
    id,
    nodeId: "k",
    buffers: [
      { binding: "pk_0", resourceId: PAIR, half: "read" },
      { binding: "pk_1", resourceId: PAIR, half: "write" },
    ],
  });
  const apply = (passes: ReadonlyArray<Record<string, unknown>>, parameters: Record<string, unknown>) => {
    const diagnostics: RuntimeDiagnostic[] = [];
    const out = applyKernelSteps(
      passes,
      { nodes: new Map([["k", node(parameters)]]), pairs: new Set([PAIR, "scratch:up:@points"]), moves: () => false },
      diagnostics,
    );
    return { out, diagnostics };
  };

  it("a kernel inside a region a feedback loop iterates gets none of its own, and is told which loop", () => {
    const inLoop = [
      { kind: "loop", id: "fb#loop:begin", edge: "begin", loopId: "fb", count: 4, nodeId: "trail" },
      dispatch(),
      { kind: "effect", id: "trail", nodeId: "trail" },
      { kind: "swap", id: "swap:fb", resourceId: "fb" },
      { kind: "loop", id: "fb#loop:end", edge: "end", loopId: "fb", nodeId: "trail" },
    ];
    const { out, diagnostics } = apply(inLoop, { substeps: 3 });
    // Untouched: a second region here would be one loop inside another, which the plan
    // reader refuses as a whole — a black frame rather than a kernel at one step.
    expect(out).toEqual(inLoop);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Node "k" asked for 3 steps per frame ("substeps" 3 × "iterations" 1), but it sits inside the feedback loop that "trail" iterates, and one loop region cannot run inside another. It runs one step per frame.',
    ]);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", code: CompilerDiagnosticCode.substepsRefused, nodeId: "k" });
    // At one step it asked for nothing: no region, and nothing to say.
    expect(apply(inLoop, {}).diagnostics).toEqual([]);
  });

  it("the same kernel AFTER that loop's region closes is wrapped — the guard's legitimate case", () => {
    const after = [
      { kind: "loop", id: "fb#loop:begin", edge: "begin", loopId: "fb", count: 4, nodeId: "trail" },
      { kind: "effect", id: "trail", nodeId: "trail" },
      { kind: "loop", id: "fb#loop:end", edge: "end", loopId: "fb", nodeId: "trail" },
      dispatch(),
    ];
    const { out, diagnostics } = apply(after, { substeps: 3 });
    expect(diagnostics).toEqual([]);
    expect(out.map((pass) => `${String(pass["kind"])}:${String(pass["edge"] ?? pass["id"])}`)).toEqual([
      "loop:begin", "effect:trail", "loop:end", "loop:begin", "dispatch:k:kernel", "loop:end",
    ]);
    expect(out[3]).toMatchObject({ loopId: PAIR, count: 3, steps: { pair: PAIR, iterations: 1, prepare: 3 } });
  });

  it("a dispatch that writes its pair without reading it has nothing to carry, and is told so", () => {
    const upstreamOnly = [
      {
        ...dispatch(),
        buffers: [
          { binding: "pk_0", resourceId: "scratch:up:@points", half: "write" },
          { binding: "pk_1", resourceId: PAIR, half: "write" },
        ],
      },
    ];
    const { out, diagnostics } = apply(upstreamOnly, { substeps: 2, iterations: 2 });
    expect(out).toEqual(upstreamOnly);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Node "k" asked for 4 steps per frame ("substeps" 2 × "iterations" 2), but every attribute in its schema is read from the incoming point set, so each pass would start from the same values and write the same result. It runs one step per frame.',
    ]);
  });

  it("a declarer that emits two dispatches is not half-wrapped", () => {
    const two = [dispatch("k:a"), dispatch("k:b")];
    const { out, diagnostics } = apply(two, { substeps: 2 });
    expect(out).toEqual(two);
    expect(diagnostics[0]?.message).toContain("it emitted 2 dispatch passes, and kernel steps repeat exactly one.");
  });
});

describe("kernel steps: the plan reader holds the region's shape (T1583b, §V147)", () => {
  const read = (mutate: (passes: Array<Record<string, unknown>>) => void) => {
    const plan = compile({ substeps: 4 });
    const passes = plan.passes.map((pass) => ({ ...pass }) as Record<string, unknown>);
    mutate(passes);
    return readExecutionPlan({ passes, resources: plan.resources, diagnostics: [] });
  };
  const beginIndex = (passes: ReadonlyArray<Record<string, unknown>>) =>
    passes.findIndex((pass) => pass["kind"] === "loop" && pass["edge"] === "begin");
  const stepsOf = (pass: Record<string, unknown> | undefined) => pass?.["steps"] as Record<string, unknown>;

  it("accepts the region the compiler emits", () => {
    const result = read(() => {});
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["iterations that do not divide the count", (steps: Record<string, unknown>) => ({ ...steps, iterations: 3 })],
    ["slots prepared for fewer runs than the count", (steps: Record<string, unknown>) => ({ ...steps, prepare: 2 })],
    ["slots prepared past the ceiling", (steps: Record<string, unknown>) => ({ ...steps, prepare: MAX_KERNEL_STEPS + 1 })],
    ["no pair", (steps: Record<string, unknown>) => ({ ...steps, pair: "" })],
  ])("refuses %s", (_label, change) => {
    const result = read((passes) => {
      const at = beginIndex(passes);
      passes[at] = { ...passes[at], steps: change(stepsOf(passes[at])) };
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a pair that is not a buffer pair, or that the dispatch does not both read and write", () => {
    const notAPair = read((passes) => {
      const at = beginIndex(passes);
      passes[at] = { ...passes[at], steps: { ...stepsOf(passes[at]), pair: "sampler:linear" } };
    });
    expect(notAPair.ok).toBe(false);
    const writeOnly = read((passes) => {
      const at = beginIndex(passes);
      const body = passes[at + 1] as Record<string, unknown>;
      const buffers = body["buffers"] as ReadonlyArray<Record<string, unknown>>;
      passes[at + 1] = { ...body, buffers: buffers.filter((binding) => binding["half"] === "write") };
    });
    expect(writeOnly.ok).toBe(false);
    expect(writeOnly.diagnostics.map((d) => d.message).join("\n")).toContain("must enclose exactly one dispatch that binds both halves");
  });

  it("refuses a region that holds a second pass", () => {
    const result = read((passes) => {
      const at = beginIndex(passes);
      const swap = passes.findIndex((pass) => pass["kind"] === "swap");
      const [moved] = passes.splice(swap, 1);
      passes.splice(at + 2, 0, moved as Record<string, unknown>);
    });
    expect(result.ok).toBe(false);
  });

  it("step facts on an `end` marker are a second place to state them, and are refused", () => {
    const result = read((passes) => {
      const end = passes.findIndex((pass) => pass["kind"] === "loop" && pass["edge"] === "end");
      passes[end] = { ...passes[end], steps: { pair: "x", iterations: 1, prepare: 1 } };
    });
    expect(result.ok).toBe(false);
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * T1585b — the two things the Rope asked of kernel steps. Everything above is as T1583b left
 * it, to the byte, but for the list of declarers in the first test.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

describe("kernel steps: a count that follows the frame (T1585b)", () => {
  const rate = { perSecond: 240, min: 1, max: 16 };

  it("is Notch's rule, clamp(round(delta × rate), min, max): every row of the design's table", () => {
    // Live and on time; one tick late (twice the steps at the SAME step size); offline at
    // four sub-frames; offline at eight (the minimum); a quarter-second stall (the maximum);
    // a 50 fps project.
    expect(rateSubsteps(1 / 60, rate)).toBe(4);
    expect(rateSubsteps(2 / 60, rate)).toBe(8);
    expect(rateSubsteps(1 / 240, rate)).toBe(1);
    expect(rateSubsteps(1 / 480, rate)).toBe(1);
    expect(rateSubsteps(15 / 60, rate)).toBe(16);
    expect(rateSubsteps(1 / 50, rate)).toBe(5);
  });

  it("rounds: a delta a last place over a whole count is that count, not one more", () => {
    // A live delta is k ÷ fps in floating point, and its product with the rate can land
    // either side of the whole number. A ceiling would make 4.000000000000001 five steps,
    // each of a different size from the frame before.
    expect(rateSubsteps(4.000000000000001 / 240, rate)).toBe(4);
    expect(rateSubsteps(3.9999999999999996 / 240, rate)).toBe(4);
    expect(rateSubsteps(4.4 / 240, rate)).toBe(4);
    expect(rateSubsteps(4.6 / 240, rate)).toBe(5);
  });

  it("Min wins over a Max below it, both are whole and inside what a region may run, and a frame of no length runs the minimum", () => {
    expect(rateStepBounds({ perSecond: 240, min: 8, max: 2 })).toEqual({ min: 8, max: 8 });
    expect(rateSubsteps(1 / 60, { perSecond: 240, min: 8, max: 2 })).toBe(8);
    expect(rateStepBounds({ perSecond: 240, min: 0, max: 1000 })).toEqual({ min: 1, max: MAX_KERNEL_SUBSTEPS });
    expect(rateStepBounds({ perSecond: 240, min: 2.4, max: 6.5 })).toEqual({ min: 2, max: 7 });
    expect(rateStepBounds({ perSecond: 240, min: Number.NaN, max: Number.NaN })).toEqual({ min: 1, max: 1 });
    // The seeding frame, a paused transport's step, a clock that has not started.
    expect(rateSubsteps(0, { perSecond: 240, min: 3, max: 16 })).toBe(3);
    expect(rateSubsteps(-1 / 60, { perSecond: 240, min: 3, max: 16 })).toBe(3);
    expect(rateSubsteps(Number.NaN, { perSecond: 240, min: 3, max: 16 })).toBe(3);
    // An unbounded frame asks for the most, not for the least.
    expect(rateSubsteps(1e9, { perSecond: 240, min: 3, max: 16 })).toBe(16);
  });

  it("a declaration is read ONE way for both compile paths, whichever of its two shapes it has", () => {
    // The count form ignores the frame and is `kernelStepCounts`, to the field.
    const counted = { substeps: "substeps", iterations: "iterations" };
    expect(kernelStepsFor(counted, { substeps: 2, iterations: 3 }, 1 / 60)).toEqual(kernelStepCounts(2, 3));
    expect(kernelStepsFor(counted, { substeps: 2, iterations: 3 }, 0)).toEqual(kernelStepCounts(2, 3));
    // Iterations is optional (the Rope has none of the region's kind): then it is 1.
    expect(kernelStepsFor({ substeps: "substeps" }, { substeps: 5, iterations: 9 }, 0)).toEqual({ substeps: 5, iterations: 1, count: 5 });
    // The rate form follows the frame, and hands back the three numbers it used.
    const rated = { substeps: { rate: "updateRate", min: "minSteps", max: "maxSteps" } };
    const stored = { updateRate: 240, minSteps: 1, maxSteps: 16 };
    expect(kernelStepsFor(rated, stored, 1 / 60)).toEqual({ substeps: 4, iterations: 1, count: 4, rate });
    expect(kernelStepsFor(rated, stored, 2 / 60)).toEqual({ substeps: 8, iterations: 1, count: 8, rate });
    // A parameter that is not a number is no rate at all and one step: never NaN on a region.
    expect(kernelStepsFor(rated, { updateRate: "fast" }, 1 / 60)).toEqual({ substeps: 1, iterations: 1, count: 1, rate: { perSecond: 0, min: 1, max: 1 } });
    expect(kernelStepsFor(rated, { ...stored, updateRate: -240 }, 1 / 60).rate?.perSecond).toBe(0);
  });
});

describe("kernel steps: the Rope's region carries its rate (T1585b)", () => {
  /** A Rope over one strip of eight points: the rate form's one declarer, through the real compiler. */
  function ropeGraph(parameters: Record<string, unknown>): GraphDocument {
    return {
      revision: 1,
      groups: {},
      nodes: {
        kernel_strip: { id: "kernel_strip", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 8 } },
        topology_strip: { id: "topology_strip", type: "pointTopology", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { connectivity: "strips", cols: 8, rows: 1 } },
        rope_strip: { id: "rope_strip", type: "pointRope", definitionVersion: 1, position: { x: 0, y: 0 }, parameters },
        points_draw: { id: "points_draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8 } },
        output_out: { id: "output_out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "kernel_strip", portId: "out" }, target: { nodeId: "topology_strip", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "topology_strip", portId: "out" }, target: { nodeId: "rope_strip", portId: "in" } },
        e3: { id: "e3", source: { nodeId: "rope_strip", portId: "out" }, target: { nodeId: "points_draw", portId: "points" } },
        e4: { id: "e4", source: { nodeId: "points_draw", portId: "out" }, target: { nodeId: "output_out", portId: "input" } },
      },
    } as never as GraphDocument;
  }
  const request = (parameters: Record<string, unknown> = {}) => ({ graph: ropeGraph(parameters), settings, registry, capabilities: TIER_B_CAPABILITIES });
  const frameOf = (deltaSeconds: number, frameIndex = 1) => ({ timeSeconds: frameIndex / 60, deltaSeconds, frameIndex, mode: "offline" as const, randomSeed: 7 });
  const regionOf = (passes: ReadonlyArray<PassDescriptor>) => begins(passes).find((pass) => pass.nodeId === "rope_strip");
  const PAIR = pointStorageId("rope_strip");

  it("one region round the Rope's step, with the rate on it, the count of the frame it was compiled at, and slots for Max", () => {
    const plan = compileGraph(request({ updateRate: 480, minSteps: 2, maxSteps: 12 }));
    expect(plan.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const at = plan.passes.findIndex((pass) => pass.kind === "loop" && pass.edge === "begin" && pass.nodeId === "rope_strip");
    expect(plan.passes[at]).toEqual({
      kind: "loop",
      id: `${PAIR}#loop:begin`,
      edge: "begin",
      loopId: PAIR,
      // The structural compile has no frame, and a frame of no length runs the minimum.
      count: 2,
      nodeId: "rope_strip",
      steps: { pair: PAIR, iterations: 1, prepare: 12, rate: { perSecond: 480, min: 2, max: 12 } },
    });
    expect(plan.passes[at + 1]).toMatchObject({ kind: "dispatch", nodeId: "rope_strip" });
    expect(plan.passes[at + 2]).toMatchObject({ kind: "loop", edge: "end", loopId: PAIR });
    // Asked at a frame, the count is that frame's: 1/60 s at 480 a second is 8 steps.
    const atFrame = compileGraph({ ...request({ updateRate: 480, minSteps: 2, maxSteps: 12 }), resolution: { frame: frameOf(1 / 60) } });
    expect(regionOf(atFrame.passes)).toMatchObject({ count: 8, steps: { prepare: 12 } });
    // The kernel upstream keeps the region it always had: a count, and no rate.
    expect(begins(plan.passes).find((pass) => pass.nodeId === "kernel_strip")?.steps).toEqual({ pair: pointStorageId("kernel_strip"), iterations: 1, prepare: 1 });
  });

  it("the rate and its clamps are VALUES: one plan signature and one structure key, whatever they are", () => {
    const base = compileGraph(request());
    const other = compileGraph(request({ updateRate: 960, minSteps: 4, maxSteps: 32 }));
    expect(other.signature).toBe(base.signature);
    const [a, b] = [regionOf(base.passes), regionOf(other.passes)];
    if (a === undefined || b === undefined) throw new Error("no rope region");
    expect(passStructureKey(b)).toBe(passStructureKey(a));
    // …and they did arrive: this is not two plans that ignored the parameters.
    expect(a.steps?.rate).toEqual({ perSecond: 240, min: 1, max: 16 });
    expect(b.steps?.rate).toEqual({ perSecond: 960, min: 4, max: 32 });
  });

  it("prepares slots for Max, and for the ceiling when Min or Max can itself move between frames", () => {
    const prepared = (parameters: Record<string, unknown>) => regionOf(compileGraph(request(parameters)).passes)?.steps?.prepare;
    expect(prepared({})).toBe(16);
    expect(prepared({ maxSteps: 40 })).toBe(40);
    // Min wins over a lower Max, so Min 24 is 24 slots.
    expect(prepared({ minSteps: 24, maxSteps: 8 })).toBe(24);
    // A driven Update Rate cannot take the count past Max: still Max.
    expect(prepared({ updateRate: expression("240 + frame") })).toBe(16);
    expect(prepared({ maxSteps: expression("8 + frame") })).toBe(MAX_KERNEL_SUBSTEPS);
    expect(prepared({ minSteps: expression("1 + frame") })).toBe(MAX_KERNEL_SUBSTEPS);
  });

  it("the per-frame path states each frame's own count with NOTHING on the node animated, as the full compile at that frame does", () => {
    const frames = prepareFrameCompiler(request());
    expect(frames.reason).toBeNull();
    expect(frames.uniformOnly).toBe(true);
    for (const [deltaSeconds, steps] of [[1 / 60, 4], [2 / 60, 8], [1 / 240, 1], [0.25, 16], [0, 1]] as const) {
      const frame = frameOf(deltaSeconds);
      const fast = frames.compileFrame({ frame });
      const full = compileGraph({ ...request(), resolution: { frame } });
      if (fast === null) throw new Error(`the values-only path refused a frame of ${deltaSeconds} s: ${String(frames.reason)}`);
      expect(regionOf(fast.passes), `delta ${deltaSeconds}`).toEqual(regionOf(full.passes));
      expect(regionOf(fast.passes)?.count, `delta ${deltaSeconds}`).toBe(steps);
      expect(fast.signature).toBe(full.signature);
    }
  });

  it("…and with the rate driven: the rate on the region is the frame's", () => {
    const driven = request({ updateRate: expression("240 * (1 + frame)") });
    const frames = prepareFrameCompiler(driven);
    expect(frames.uniformOnly).toBe(true);
    const frame = frameOf(1 / 60, 2);
    const fast = frames.compileFrame({ frame });
    const full = compileGraph({ ...driven, resolution: { frame } });
    expect(regionOf(fast?.passes ?? [])).toEqual(regionOf(full.passes));
    expect(regionOf(full.passes)).toMatchObject({ count: 12, steps: { rate: { perSecond: 720, min: 1, max: 16 } } });
  });

  it("the plan reader keeps a rate it can read and refuses one it cannot, rather than dropping it", () => {
    const plan = compileGraph(request());
    const read = (rate: unknown) => {
      const passes = plan.passes.map((pass) => ({ ...pass }) as Record<string, unknown>);
      const at = passes.findIndex((pass) => pass["kind"] === "loop" && pass["edge"] === "begin" && pass["nodeId"] === "rope_strip");
      passes[at] = { ...passes[at], steps: { ...(passes[at]?.["steps"] as Record<string, unknown>), rate } };
      return readExecutionPlan({ passes, resources: plan.resources, diagnostics: [] });
    };
    const kept = read({ perSecond: 120, min: 2, max: 9 });
    expect(kept.diagnostics).toEqual([]);
    expect(kept.ok).toBe(true);
    expect(regionOf(kept.passes)?.steps?.rate).toEqual({ perSecond: 120, min: 2, max: 9 });
    // A region whose rate was dropped would run its stated count on every frame, whatever
    // the frame's length: a plausible rope at the wrong step. So each of these is a refusal.
    for (const broken of [240, { perSecond: Number.NaN, min: 1, max: 16 }, { perSecond: -1, min: 1, max: 16 }, { perSecond: 240, min: 1 }, { perSecond: 240, min: "1", max: 16 }]) {
      expect(read(broken).ok, JSON.stringify(broken)).toBe(false);
    }
  });
});

describe("kernel steps: one dispatch steps, and a node's other dispatches run once (T1585b)", () => {
  const PAIR = "scratch:k:@points";
  const UP = "scratch:up:@points";
  const node = (steps: unknown, parameters: Record<string, unknown>): ResolvedNode =>
    ({ node: { parameters: {} }, definition: { steps } as unknown as NodeDefinition, parameters, parameterMaps: {} }) as unknown as ResolvedNode;
  /** The step: reads and writes the node's own pair. */
  const step = (id = "k:step") => ({
    kind: "dispatch",
    id,
    nodeId: "k",
    buffers: [
      { binding: "state_in", resourceId: PAIR, half: "read" },
      { binding: "state_out", resourceId: PAIR, half: "write" },
    ],
  });
  /** A search done once a frame: it reads the points upstream and writes a plain buffer. */
  const search = (id = "k:contacts") => ({
    kind: "dispatch",
    id,
    nodeId: "k",
    buffers: [
      { binding: "in_position", resourceId: UP, half: "write" },
      { binding: "contacts", resourceId: "scratch:k:contacts" },
    ],
  });
  const apply = (passes: ReadonlyArray<Record<string, unknown>>, steps: unknown, parameters: Record<string, unknown>) => {
    const diagnostics: RuntimeDiagnostic[] = [];
    const out = applyKernelSteps(passes, { nodes: new Map([["k", node(steps, parameters)]]), pairs: new Set([PAIR, UP]), moves: () => false }, diagnostics);
    return { out, diagnostics };
  };
  const COUNTED = { substeps: "substeps", iterations: "iterations" };
  const RATED = { substeps: { rate: "updateRate", min: "minSteps", max: "maxSteps" } };
  const shape = (out: ReadonlyArray<Record<string, unknown>>) => out.map((pass) => `${String(pass["kind"])}:${String(pass["edge"] ?? pass["id"])}`);

  it("wraps the one that steps and leaves the other where the node put it, outside the region", () => {
    const { out, diagnostics } = apply([search(), step()], COUNTED, { substeps: 4 });
    expect(diagnostics).toEqual([]);
    // The search runs ONCE, before the region, in plan order (§V168); the step runs four times.
    expect(shape(out)).toEqual(["dispatch:k:contacts", "loop:begin", "dispatch:k:step", "loop:end"]);
    expect(out[1]).toMatchObject({ loopId: PAIR, count: 4, steps: { pair: PAIR, iterations: 1, prepare: 4 } });
    expect(expandLoops(out as never).filter((pass) => (pass as { id?: string }).id === "k:contacts")).toHaveLength(1);
    expect(expandLoops(out as never).filter((pass) => (pass as { id?: string }).id === "k:step")).toHaveLength(4);
    // Whichever order the node emitted them in.
    expect(shape(apply([step(), search()], COUNTED, { substeps: 4 }).out)).toEqual(["loop:begin", "dispatch:k:step", "loop:end", "dispatch:k:contacts"]);
  });

  it("the region is there at one step too, so the plan's shape does not follow the count (§V358)", () => {
    const { out, diagnostics } = apply([search(), step()], COUNTED, {});
    expect(diagnostics).toEqual([]);
    expect(shape(out)).toEqual(["dispatch:k:contacts", "loop:begin", "dispatch:k:step", "loop:end"]);
  });

  it("TWO dispatches over the node's own pair cannot both be the step: neither is wrapped, and each says so", () => {
    const three = [search(), step("k:a"), step("k:b")];
    const { out, diagnostics } = apply(three, COUNTED, { substeps: 2 });
    expect(out).toEqual(three);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Node "k" asked for 2 steps per frame ("substeps" 2 × "iterations" 1), but it emitted 2 dispatch passes, and kernel steps repeat exactly one. It runs one step per frame.',
      'Node "k" asked for 2 steps per frame ("substeps" 2 × "iterations" 1), but it emitted 2 dispatch passes, and kernel steps repeat exactly one. It runs one step per frame.',
    ]);
  });

  it("several dispatches and NONE that steps is told once, not once a pass", () => {
    const none = [search("k:a"), search("k:b")];
    const { out, diagnostics } = apply(none, COUNTED, { substeps: 3 });
    expect(out).toEqual(none);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Node "k" asked for 3 steps per frame ("substeps" 3 × "iterations" 1), but none of its 2 dispatch passes reads and writes a buffer pair of its own, so there is no state to carry from step to step. It runs one step per frame.',
    ]);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", code: CompilerDiagnosticCode.substepsRefused, nodeId: "k" });
  });

  it("a RATE declarer that cannot be stepped is refused in the rate's own words, by what it could ask for and not by this frame's count", () => {
    const inLoop = [
      { kind: "loop", id: "fb#loop:begin", edge: "begin", loopId: "fb", count: 4, nodeId: "trail" },
      step(),
      { kind: "loop", id: "fb#loop:end", edge: "end", loopId: "fb", nodeId: "trail" },
    ];
    // Compiled at no frame the count is the minimum, 1 — and the node still asks for up to 16.
    const { out, diagnostics } = apply(inLoop, RATED, { updateRate: 240, minSteps: 1, maxSteps: 16 });
    expect(out).toEqual(inLoop);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Node "k" asked for up to 16 steps per frame ("updateRate" 240 a second, at most "maxSteps" 16), but it sits inside the feedback loop that "trail" iterates, and one loop region cannot run inside another. It runs one step per frame.',
    ]);
    expect(diagnostics[0]?.suggestion).toBe('Iterate one of the two: this kernel\'s steps, or that loop\'s Substeps. Or set "maxSteps" to 1.');
    // With Max at 1 it asked for nothing, and nothing is said.
    expect(apply(inLoop, RATED, { updateRate: 240, minSteps: 1, maxSteps: 1 }).diagnostics).toEqual([]);
  });

  it("a rate declarer's region carries the rate, and is prepared for its Max", () => {
    const { out, diagnostics } = apply([step()], RATED, { updateRate: 240, minSteps: 2, maxSteps: 16 });
    expect(diagnostics).toEqual([]);
    expect(out[0]).toMatchObject({ count: 2, steps: { pair: PAIR, iterations: 1, prepare: 16, rate: { perSecond: 240, min: 2, max: 16 } } });
  });
});
