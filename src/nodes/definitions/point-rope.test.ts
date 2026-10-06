import { describe, expect, it } from "vitest";

import { scratchResourceId } from "../../compiler/resources.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { ZERO_FRAME } from "../../domain/types/frame.ts";
import { ROPE_MAX_STRAND_POINTS } from "../../points/rope.ts";
import { MAX_KERNEL_SUBSTEPS } from "../../runtime/backend/plan.ts";
import { dispatchFrameUniforms, dispatchStepUniforms } from "../../runtime/backend/shared-uniforms.ts";
import { pointStorageId } from "./point-storage.ts";
import { ROPE_KEPT_KEY, ROPE_SOLVE_KEY, pointRopeNode, ropeAttributes } from "./point-rope.ts";
import { compileContext, fixturePairs } from "./test-support.ts";

/**
 * Rope at the fixture level (T1585b): what it publishes on the edge, how its one pass is
 * bound and stepped, and every sentence it refuses with. What a strand DOES is asserted on
 * Dawn in `point-rope.gpu.test.ts` and on the CPU reference in `points/rope.test.ts`; the
 * region the compiler puts round its step is `compiler/kernel-steps.test.ts`. This file is
 * the contract around them.
 */

const STRANDS = fixturePairs(
  "kernel_strands",
  [
    { name: "position", type: "vec3f" },
    { name: "orient", type: "vec4f" },
    { name: "live", type: "f32" },
    { name: "charge", type: "f32" },
  ],
  550,
);
type Pairs = typeof STRANDS;

const compile = (
  parameters: Record<string, unknown> = {},
  options: {
    topology?: string;
    pairs?: Pairs;
    capacity?: number;
    count?: { buffer: string };
    maps?: Record<string, { attribute: string; channel?: string }>;
    unwired?: boolean;
  } = {},
) =>
  pointRopeNode.compile(
    compileContext({
      nodeId: "rope_tentacles",
      inputs: options.unwired === true ? [] : ["in"],
      outputs: ["out"],
      pointsets: {
        in: {
          pairs: options.pairs ?? STRANDS,
          capacity: options.capacity ?? 550,
          topology: options.topology ?? "strips:55x10",
          ...(options.count === undefined ? {} : { count: options.count }),
        },
      },
      parameters: parameters as never,
      ...(options.maps === undefined ? {} : { parameterMaps: options.maps }),
    }),
  );

type Pass = {
  id: string;
  shader: string;
  workgroups: number[];
  buffers: Array<{ binding: string; resourceId: string; half?: string; offset?: number; bytes?: number }>;
  uniforms: Record<string, number>;
  uniformBinding: string;
};
const passOf = (result: ReturnType<typeof compile>): Pass => {
  expect(result.diagnostics ?? []).toEqual([]);
  expect(result.passes).toHaveLength(1);
  return result.passes[0] as unknown as Pass;
};
const errorOf = (result: ReturnType<typeof compile>) => ({
  code: result.diagnostics?.[0]?.code,
  message: result.diagnostics?.[0]?.message ?? "",
  suggestion: result.diagnostics?.[0]?.suggestion ?? "",
  passes: result.passes.length,
});
/** The members of the shader's uniform struct, in order. */
const declared = (shader: string): string[] => {
  const body = /struct RopeParams \{([^}]*)\}/.exec(shader)?.[1] ?? "";
  return [...body.matchAll(/(\w+):/g)].map((match) => match[1] as string);
};

describe("Rope — what it publishes (T1585b)", () => {
  it("hands the same strips on, with position and velocity its own and everything else by reference", () => {
    const result = compile();
    expect(result.diagnostics ?? []).toEqual([]);
    const out = result.pointsets?.["out"];
    // Simulating moves no slot: the claim and the capacity are the incoming edge's.
    expect(out?.topology).toBe("strips:55x10");
    expect(out?.capacity).toBe(550);
    const own = pointStorageId("rope_tentacles");
    // `position` is REPLACED (a consumer reads the rope, not the pose it was seeded from)…
    expect(out?.pairs["position"]).toMatchObject({ buffer: own, half: "write", type: "vec3f" });
    expect(out?.pairs["velocity"]).toMatchObject({ buffer: own, half: "write", type: "vec3f" });
    // …and what Curve Frames and a material need rides through untouched (§V197).
    for (const name of ["orient", "live", "charge"]) expect(out?.pairs[name], name).toBe(STRANDS[name]);
    expect(Object.keys(out?.pairs ?? {}).sort()).toEqual(["charge", "live", "orient", "position", "velocity"]);
  });

  it("publishes tension only when asked, and the switch is the layout", () => {
    expect(ropeAttributes({ tension: false }).map((attribute) => attribute.name)).toEqual(["position", "velocity"]);
    expect(ropeAttributes({ tension: true }).map((attribute) => attribute.name)).toEqual(["position", "velocity", "tension"]);
    const off = compile();
    const on = compile({ tensionOutput: true });
    expect(off.pointsets?.["out"]?.pairs["tension"]).toBeUndefined();
    expect(on.pointsets?.["out"]?.pairs["tension"]).toMatchObject({ buffer: pointStorageId("rope_tentacles"), type: "f32" });
    // A different program, so a different pass: the id carries what changes the text (§V62b).
    expect(passOf(on).id).not.toBe(passOf(off).id);
    expect(passOf(on).shader).toContain("fn storeTension");
    expect(passOf(off).shader).not.toContain("Tension");
  });

  it("a grid's rows are its strands", () => {
    const result = compile({}, { topology: "grid:55x10" });
    expect(result.diagnostics ?? []).toEqual([]);
    expect(passOf(result).uniforms).toMatchObject({ cols: 55, rows: 10 });
    expect(result.pointsets?.["out"]?.topology).toBe("grid:55x10");
  });
});

describe("Rope — its one pass (T1585b)", () => {
  it("is one invocation per strand over five storage buffers, of the baseline's eight (§V588)", () => {
    const pass = passOf(compile());
    // Ten strands fit one workgroup of 64; 65 would need two.
    expect(pass.workgroups).toEqual([1, 1, 1]);
    expect(passOf(compile({}, { topology: "strips:2x65", capacity: 130, pairs: fixturePairs("kernel_strands", [{ name: "position", type: "vec3f" }], 130) as Pairs })).workgroups).toEqual([2, 1, 1]);
    const own = pointStorageId("rope_tentacles");
    expect(pass.buffers.map((buffer) => [buffer.binding, buffer.resourceId, buffer.half])).toEqual([
      // The incoming points, as the producer wrote them this frame (§V168).
      ["in_position", "scratch:kernel_strands:@points", "write"],
      // The stepped pair, both halves and whole: what the loop region swaps between runs.
      ["state_in", own, "read"],
      ["state_out", own, "write"],
      // Not in the pair: written when a strand is seeded and once a frame, never copied.
      ["kept", scratchResourceId("rope_tentacles", ROPE_KEPT_KEY), undefined],
      ["scratch", scratchResourceId("rope_tentacles", ROPE_SOLVE_KEY), undefined],
    ]);
    // The region binds whole buffers except the incoming position, which is one attribute's.
    expect(pass.buffers[0]).toMatchObject({ offset: STRANDS["position"]?.offset, bytes: STRANDS["position"]?.bytes });
    expect(pass.buffers.slice(1).every((buffer) => buffer.offset === undefined)).toBe(true);
  });

  it("allocates two vec4f a point to keep and eight floats a point to solve in, beside the pair", () => {
    const scratch = compile().scratch as ReadonlyArray<{ key: string; kind: string; stride: number; capacity: number }>;
    expect(scratch.map((entry) => [entry.key, entry.kind, entry.stride * entry.capacity])).toEqual([
      [ROPE_KEPT_KEY, "buffer", 550 * 32],
      [ROPE_SOLVE_KEY, "buffer", 550 * 32],
      // position and velocity, 16 B a point each, on 256-byte region bases (T1076).
      ["@points", "bufferPair", 8960 + 8960],
    ]);
  });

  it("declares in its uniform block exactly what it sets, and of the backend's names only the four it wants", () => {
    const pass = passOf(compile({ tensionOutput: true }));
    expect(pass.uniformBinding).toBe("params");
    // Declared and set, both or neither: vgpu matches uniforms by name, and a member with no
    // value reads zero in silence (§V288's mirror hazard).
    expect(Object.keys(pass.uniforms)).toEqual(declared(pass.shader));
    /* THE COLLISION THIS GUARDS. The backend writes the frame's and the run's numbers into
       every member of a stepped dispatch that carries one of their names. The block first
       called its Newton cap `iterations`, which is one of them: it read 1 whatever the
       Iterations parameter said, and the strand stood at two tolerances. So: of everything
       the backend writes by name, the block declares the four it means to receive. */
    const written = new Set([
      ...Object.keys(dispatchFrameUniforms(ZERO_FRAME, { pointer: [0, 0, 0, 0], absTime: 0, absFrame: 0 } as never)),
      ...Object.keys(dispatchStepUniforms({ run: 0, substeps: 1, iterations: 1 }, { deltaSeconds: 0, firstRun: false, seed: 7 })),
    ]);
    expect(Object.keys(pass.uniforms).filter((name) => written.has(name)).sort()).toEqual(["deltaSeconds", "firstRun", "substep", "substeps"]);
  });

  it("carries its parameters as values, with the ones a shader cannot survive kept in range", () => {
    expect(passOf(compile()).uniforms).toMatchObject({
      cols: 55,
      rows: 10,
      solves: 4,
      reset: 0,
      teleportMode: 0,
      speed: 1,
      gravity: 9.81,
      damping: 0.5,
      inverseMass: 1,
      restLengthScale: 1,
      stretch: 0,
      maxStretch: 0.02,
      anchorFirst: 1,
      teleportDistance: 0,
    });
    const set = passOf(compile({ iterations: 99, mass: 0, damping: -3, speed: -1, reset: true, teleportMode: "reset", teleportDistance: 100, maxStretch: -1 })).uniforms;
    // A mass of nothing would be an inverse of infinity: the floor is a gram.
    expect(set).toMatchObject({ solves: 8, inverseMass: 1000, damping: 0, speed: 0, reset: 1, teleportMode: 1, teleportDistance: 100, maxStretch: 0 });
    // None of them is structure: the same pass, the same text.
    expect(passOf(compile({ gravity: 2, damping: 1.5, teleportMode: "reset", reset: true })).id).toBe(passOf(compile()).id);
    expect(passOf(compile({ gravity: 2, damping: 1.5, teleportMode: "reset", reset: true })).shader).toBe(passOf(compile()).shader);
  });
});

describe("Rope — how it is stepped (T1585b, §T1583b's region)", () => {
  it("declares its steps as a RATE with clamps, each a number that can be driven", () => {
    expect(pointRopeNode.steps).toEqual({ substeps: { rate: "updateRate", min: "minSteps", max: "maxSteps" } });
    expect(pointRopeNode.stateful).toEqual({ reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false });
    const schema = effectiveParameterSchema(pointRopeNode, {});
    expect(schema["updateRate"]).toMatchObject({ type: "number", default: 240 });
    expect(schema["minSteps"]).toMatchObject({ default: 1, max: MAX_KERNEL_SUBSTEPS });
    expect(schema["maxSteps"]).toMatchObject({ default: 16, max: MAX_KERNEL_SUBSTEPS });
  });

  it("Teleport is inactive while Teleport Distance is 0, and says why", () => {
    const schema = effectiveParameterSchema(pointRopeNode, {});
    const inactive = schema["teleportMode"]?.inactiveWhen;
    expect(inactive?.({ teleportDistance: 0 })).toBe("Teleport Distance is 0, so nothing teleports.");
    expect(inactive?.({ teleportDistance: 100 })).toBeNull();
  });
});

describe("Rope — what it refuses, by name (T1585b, §V288)", () => {
  it("an edge with no strips to follow, with the Topology node as the fix", () => {
    const refused = errorOf(compile({}, { topology: "points" }));
    expect(refused).toMatchObject({ code: "node.points.strips", passes: 0 });
    expect(refused.message).toBe('Node "rope_tentacles": Rope follows each strip of a pointset in slot order, and this edge claims "points" — points with no order to follow.');
    expect(refused.suggestion).toContain("Topology node");
  });

  it("closed strips: a rope has two ends", () => {
    const refused = errorOf(compile({}, { topology: "strips:55x10:closed" }));
    expect(refused).toMatchObject({ code: "node.points.rope", passes: 0 });
    expect(refused.message).toBe('Node "rope_tentacles": the incoming strips are closed, and a rope has two ends: a loop\'s segments do not form a chain this solver can walk.');
    expect(refused.suggestion).toBe("Open the claim with a Topology node (Connectivity: Strips, Closed off) before the Rope.");
    // A wrapped grid's rows are closed strips too.
    expect(errorOf(compile({}, { topology: "grid:55x10:wrapU" })).code).toBe("node.points.rope");
  });

  it(`a strand of more than ${ROPE_MAX_STRAND_POINTS} points, with the count named`, () => {
    const long = fixturePairs("kernel_strands", [{ name: "position", type: "vec3f" }], 2050) as Pairs;
    const refused = errorOf(compile({}, { topology: "strips:1025x2", capacity: 2050, pairs: long }));
    expect(refused).toMatchObject({ code: "node.points.rope", passes: 0 });
    expect(refused.message).toBe('Node "rope_tentacles": each strand has 1025 points, and one walk solves at most 1024.');
    expect(refused.suggestion).toBe("Resample to 1024 points a strand or fewer, or split the strand into several.");
    // The guard's legitimate case: exactly the limit compiles.
    const limit = fixturePairs("kernel_strands", [{ name: "position", type: "vec3f" }], 2048) as Pairs;
    expect(passOf(compile({}, { topology: "strips:1024x2", capacity: 2048, pairs: limit })).uniforms).toMatchObject({ cols: 1024, rows: 2 });
  });

  it("a counted input: the slots past a count belong to no strand", () => {
    const refused = errorOf(compile({}, { count: { buffer: "scratch:kernel_strands:live" } }));
    expect(refused).toMatchObject({ code: "node.points.input", passes: 0 });
    expect(refused.message).toContain("carries a GPU live count");
  });

  it("a parameter in map mode, which no Rope parameter reads yet", () => {
    const refused = errorOf(compile({}, { maps: { anchorFirst: { attribute: "charge" } } }));
    expect(refused).toMatchObject({ code: "node.parameter.map", passes: 0 });
    expect(refused.message).toBe('Node "rope_tentacles": anchorFirst is in map mode, and no Rope parameter reads an attribute yet.');
  });

  it("an attribute of its own name in another type, rather than changing it under whoever mapped it", () => {
    const clash = { ...STRANDS, ...fixturePairs("kernel_other", [{ name: "velocity", type: "f32" }], 550) } as Pairs;
    const refused = errorOf(compile({}, { pairs: clash }));
    expect(refused).toMatchObject({ code: "node.points.rope", passes: 0 });
    expect(refused.message).toBe('Node "rope_tentacles": publishing "velocity" as vec3f would change the type of the "velocity" (f32) these points already carry.');
    // The legitimate case: a vec3f velocity upstream is simply replaced.
    const same = { ...STRANDS, ...fixturePairs("kernel_other", [{ name: "velocity", type: "vec3f" }], 550) } as Pairs;
    const replaced = compile({}, { pairs: same });
    expect(replaced.diagnostics ?? []).toEqual([]);
    expect(replaced.pointsets?.["out"]?.pairs["velocity"]).toMatchObject({ buffer: pointStorageId("rope_tentacles") });
  });

  it("nothing wired, and an edge with no position", () => {
    expect(errorOf(compile({}, { unwired: true })).passes).toBe(0);
    expect(errorOf(compile({}, { unwired: true })).message).toContain('input port "in"');
    const bare = fixturePairs("kernel_strands", [{ name: "live", type: "f32" }], 550) as Pairs;
    expect(errorOf(compile({}, { pairs: bare }))).toMatchObject({ code: "node.points.edge", passes: 0 });
  });
});
