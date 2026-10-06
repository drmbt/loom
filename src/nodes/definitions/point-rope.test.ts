import { describe, expect, it } from "vitest";

import { scratchResourceId } from "../../compiler/resources.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { ZERO_FRAME } from "../../domain/types/frame.ts";
import { ROPE_DEFAULTS, ROPE_MAX_ITERATIONS, ROPE_MAX_STRAND_POINTS } from "../../points/rope.ts";
import { MAX_KERNEL_SUBSTEPS } from "../../runtime/backend/plan.ts";
import { dispatchFrameUniforms, dispatchStepUniforms } from "../../runtime/backend/shared-uniforms.ts";
import { pointStorageId } from "./point-storage.ts";
import { ROPE_KEPT_KEY, ROPE_SOLVE_KEY, pointRopeNode, ropeAttributes } from "./point-rope.ts";
import { compileContext, fixturePairs, planFingerprint } from "./test-support.ts";

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

  /*
   * T1587b: a grid may be several SHEETS, one after another in the buffer, and `stripsOf`
   * gives it rows × sheets strips. The Rope takes it as that many strands — sheet s, row y
   * is strand s × rows + y, which is the slot order it already walks — and hands the same
   * claim on, so a Surface after it still draws ten separate sheets.
   */
  it("a grid of several sheets is rows × sheets strands, and the claim passes through", () => {
    const result = compile({}, { topology: "grid:55x5x2" });
    expect(result.diagnostics ?? []).toEqual([]);
    expect(passOf(result).uniforms).toMatchObject({ cols: 55, rows: 10 });
    expect(passOf(result).workgroups).toEqual([1, 1, 1]);
    expect(result.pointsets?.["out"]?.topology).toBe("grid:55x5x2");
    // A claim for more points than the edge carries is refused, sheets counted.
    expect(errorOf(compile({}, { topology: "grid:55x5x3" }))).toMatchObject({ code: "node.points.strips", passes: 0 });
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
      // The producer's buffer, whole, as it wrote it this frame (§V168): the incoming points
      // are read out of it by their offset.
      ["pk_0", "scratch:kernel_strands:@points", "write"],
      // The stepped pair, both halves and whole: what the loop region swaps between runs.
      ["state_in", own, "read"],
      ["state_out", own, "write"],
      // Not in the pair: written when a strand is seeded and once a frame, never copied.
      ["kept", scratchResourceId("rope_tentacles", ROPE_KEPT_KEY), undefined],
      ["scratch", scratchResourceId("rope_tentacles", ROPE_SOLVE_KEY), undefined],
    ]);
    // Every buffer is bound whole: regions are addressed by word offset in the text (T1076).
    expect(pass.buffers.every((buffer) => buffer.offset === undefined)).toBe(true);
    expect(pass.shader).toContain(`let o = ${String((STRANDS["position"]?.offset ?? 0) / 4)}u + slot * 4u;`);
  });

  it("allocates two vec4f a point to keep and eight floats a point to solve in, beside the pair (twenty with Bend Limit on, below)", () => {
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
      segmentLength: 0,
      restLengthScale: 1,
      stretch: 0,
      maxStretch: 0.02,
      anchorFirst: 1,
      anchorSecond: 0,
      anchorLast: 0,
      anchorMode: 0,
      anchorStrength: 2,
      anchorDamping: 1,
      teleportDistance: 0,
    });
    const set = passOf(compile({ iterations: 99, mass: 0, damping: -3, speed: -1, reset: true, teleportMode: "reset", teleportDistance: 100, maxStretch: -1 })).uniforms;
    // A mass of nothing would be an inverse of infinity: the floor is a gram.
    expect(set).toMatchObject({ solves: 8, inverseMass: 1000, damping: 0, speed: 0, reset: 1, teleportMode: 1, teleportDistance: 100, maxStretch: 0 });
    // None of them is structure: the same pass, the same text.
    expect(passOf(compile({ gravity: 2, damping: 1.5, teleportMode: "reset", reset: true })).id).toBe(passOf(compile()).id);
    expect(passOf(compile({ gravity: 2, damping: 1.5, teleportMode: "reset", reset: true })).shader).toBe(passOf(compile()).shader);
    // Nor are the anchors' numbers, or Hard against Soft (§V453): one program reads a flag.
    const anchored = passOf(compile({ anchorSecond: 1, anchorLast: 0.4, anchorMode: "soft", anchorStrength: 4, anchorDamping: 0.5 }));
    expect(anchored.uniforms).toMatchObject({ anchorSecond: 1, anchorLast: 0.4, anchorMode: 1, anchorStrength: 4, anchorDamping: 0.5 });
    expect(anchored.shader).toBe(passOf(compile()).shader);
    expect(anchored.id).toBe(passOf(compile()).id);
  });
});

describe("Rope — weights from attributes (T1585b slice 2)", () => {
  /** A weight the strands' own kernel wrote beside its positions: the same buffer. */
  const HELD = fixturePairs(
    "kernel_strands",
    [
      { name: "position", type: "vec3f" },
      { name: "hold", type: "f32" },
      { name: "aim", type: "vec3f" },
    ],
    550,
  ) as Pairs;
  /** One a second kernel gathered on afterwards: another producer's buffer. */
  const ELSEWHERE = { ...HELD, ...fixturePairs("kernel_gait", [{ name: "grip", type: "f32" }], 550) } as Pairs;
  const wordOf = (pairs: Pairs, name: string): number => (pairs[name]?.offset ?? 0) / 4;

  it("a station in Map mode reads its attribute at that strand's own station, and the same producer costs no binding", () => {
    const plain = passOf(compile({}, { pairs: HELD }));
    const mapped = passOf(compile({}, { pairs: HELD, maps: { anchorLast: { attribute: "hold" } } }));
    // Read at base + segments: the strand's LAST point, one float a point.
    expect(mapped.shader).toContain(`lastWeight = held(bitcast<f32>(pk_0[${wordOf(HELD, "hold")}u + (base + segments) * 1u + 0u]));`);
    expect(plain.shader).toContain("lastWeight = held(params.anchorLast);");
    expect(mapped.buffers.map((buffer) => buffer.binding)).toEqual(["pk_0", "state_in", "state_out", "kept", "scratch"]);
    // A different program, and an id that says which station reads a buffer.
    expect(mapped.id).toBe("rope_tentacles:rope:step:l:550");
    expect(plain.id).toBe("rope_tentacles:rope:step::550");
    // First and second read theirs at their own points.
    const all = passOf(compile({}, { pairs: HELD, maps: { anchorFirst: { attribute: "hold" }, anchorSecond: { attribute: "aim", channel: "y" }, anchorLast: { attribute: "hold" } } }));
    expect(all.shader).toContain(`let firstWeight = held(bitcast<f32>(pk_0[${wordOf(HELD, "hold")}u + base * 1u + 0u]));`);
    // One channel of a float vector: four words a point, the second of them.
    expect(all.shader).toContain(`secondWeight = held(bitcast<f32>(pk_0[${wordOf(HELD, "aim")}u + (base + 1u) * 4u + 1u]));`);
    expect(all.id).toBe("rope_tentacles:rope:step:fsl:550");
  });

  it("a weight from another producer binds that producer's buffer, once", () => {
    const pass = passOf(compile({ pinAttribute: "grip" }, { pairs: ELSEWHERE, maps: { anchorLast: { attribute: "grip" } } }));
    expect(pass.buffers.map((buffer) => [buffer.binding, buffer.resourceId])).toEqual([
      ["pk_0", "scratch:kernel_strands:@points"],
      ["pk_1", "scratch:kernel_gait:@points"],
      ["state_in", pointStorageId("rope_tentacles")],
      ["state_out", pointStorageId("rope_tentacles")],
      ["kept", scratchResourceId("rope_tentacles", ROPE_KEPT_KEY)],
      ["scratch", scratchResourceId("rope_tentacles", ROPE_SOLVE_KEY)],
    ]);
    expect(pass.shader).toContain("const PINNED: bool = true;");
    expect(pass.shader).toContain(`let pin = held(bitcast<f32>(pk_1[${wordOf(ELSEWHERE, "grip")}u + slot * 1u + 0u]));`);
    expect(pass.id).toBe("rope_tentacles:rope:step:lp:550");
    // Without a pin attribute the text says so, and reads none.
    expect(passOf(compile({}, { pairs: ELSEWHERE })).shader).toContain("const PINNED: bool = false;");
    expect(passOf(compile({ pinAttribute: "  " }, { pairs: ELSEWHERE })).shader).toContain("let pin = 0.0;");
  });

  it("refuses, by name: a map on any other parameter, an attribute the edge does not carry, a vector with no channel, a pin that is not an f32", () => {
    const other = errorOf(compile({}, { pairs: HELD, maps: { gravity: { attribute: "hold" }, damping: { attribute: "hold" } } }));
    expect(other).toMatchObject({ code: "node.parameter.map", passes: 0 });
    expect(other.message).toBe('Node "rope_tentacles": damping, gravity are in map mode, and a Rope maps only Anchor First, Anchor Second and Anchor Last.');
    const missing = errorOf(compile({}, { pairs: HELD, maps: { anchorLast: { attribute: "grip" } } }));
    expect(missing).toMatchObject({ code: "node.parameter.map", passes: 0 });
    expect(missing.message).toBe('Node "rope_tentacles": anchorLast maps attribute "grip", which the incoming pointset does not carry.');
    expect(missing.suggestion).toBe("It provides: aim, hold, position.");
    expect(errorOf(compile({}, { pairs: HELD, maps: { anchorFirst: { attribute: "aim" } } })).message).toBe(
      'Node "rope_tentacles": anchorFirst maps vec3f attribute "aim" and needs a channel (x/y/z).',
    );
    const noPin = errorOf(compile({ pinAttribute: "grip" }, { pairs: HELD }));
    expect(noPin).toMatchObject({ code: "node.parameter.map", passes: 0 });
    expect(noPin.message).toBe('Node "rope_tentacles": Pin Attribute names "grip", which the incoming pointset does not carry.');
    expect(errorOf(compile({ pinAttribute: "aim" }, { pairs: HELD })).message).toBe('Node "rope_tentacles": Pin Attribute names "aim", which is vec3f; a pin weight is an f32.');
  });

  it("refuses a fifth producer: four of a pass's eight buffers are the step's own (§V588)", () => {
    const from = (producer: string, name: string): Pairs => fixturePairs(producer, [{ name, type: "f32" }], 550) as Pairs;
    const four = { ...HELD, ...from("kernel_a", "first"), ...from("kernel_b", "second"), ...from("kernel_c", "last") } as Pairs;
    const maps = { anchorFirst: { attribute: "first" }, anchorSecond: { attribute: "second" }, anchorLast: { attribute: "last" } };
    // The guard's legitimate case: the points and three weights from four producers is exactly eight.
    expect(passOf(compile({}, { pairs: four, maps })).buffers).toHaveLength(8);
    const five = { ...four, ...from("kernel_d", "pin") } as Pairs;
    const refused = errorOf(compile({ pinAttribute: "pin" }, { pairs: five, maps }));
    expect(refused).toMatchObject({ code: "node.points.rope", passes: 0 });
    expect(refused.message).toBe(
      'Node "rope_tentacles": the incoming points and the attributes its weights read come from 5 producers, and a pass binds 8 buffers with this node\'s own 4 (§V588).',
    );
    expect(refused.suggestion).toBe("Gather the weights onto the strands in one kernel before the Rope, so they come from one producer.");
  });
});

describe("Rope — Bend Limit is a structural switch (T1585b slice 4)", () => {
  /** Words only the limit's program has: its constants, its helpers, its second solve. */
  const ITS_OWN = ["BEND_", "giveOf", "hinge", "storePlaced", "attempt", "minBendRadius", "20u"];

  it("off, the program has none of the limit's text, its block none of its numbers, and a point eight floats to solve in; stored off, it is the same pass", () => {
    const off = passOf(compile());
    for (const word of ITS_OWN) expect(off.shader, word).not.toContain(word);
    expect(declared(off.shader)).not.toContain("minBendRadius");
    expect(off.uniforms["minBendRadius"]).toBeUndefined();
    // Stored off, with a radius left in the document from when it was on: the same text, the same id, the same block.
    const stored = passOf(compile({ bendLimit: false, minBendRadius: 0.5 }));
    expect(stored.shader).toBe(off.shader);
    expect(stored.id).toBe(off.id);
    expect(stored.uniforms).toEqual(off.uniforms);
    const scratch = compile({ bendLimit: false }).scratch as ReadonlyArray<{ key: string; stride: number; capacity: number }>;
    expect(scratch.find((entry) => entry.key === ROPE_SOLVE_KEY)).toMatchObject({ stride: 4, capacity: 550 * 8 });
  });

  it("on, it is another program: the id says so, the radius is in the block, and a point has twenty floats to solve in", () => {
    const on = passOf(compile({ bendLimit: true }));
    expect(on.id).toBe("rope_tentacles:rope:step:b:550");
    for (const word of ["fn giveOf", "fn hinge", "fn storePlaced", "const BEND_SOFTENING: f32 = 0.0009765625;", "for (var attempt = 0u; attempt < 3u;"]) expect(on.shader, word).toContain(word);
    // Declared and set, both or neither, and last in the block: nothing before it has moved.
    expect(Object.keys(on.uniforms)).toEqual(declared(on.shader));
    expect(declared(on.shader).at(-1)).toBe("minBendRadius");
    expect(declared(on.shader).slice(0, -1)).toEqual(declared(passOf(compile()).shader));
    expect(on.uniforms["minBendRadius"]).toBe(ROPE_DEFAULTS.minBendRadius);
    // A radius of nothing is a turn of nothing at every joint: the floor is a millimetre.
    expect(passOf(compile({ bendLimit: true, minBendRadius: 0 })).uniforms["minBendRadius"]).toBe(0.001);
    // The radius is a number and not structure: one program for every radius.
    expect(passOf(compile({ bendLimit: true, minBendRadius: 0.4 })).shader).toBe(on.shader);
    const scratch = compile({ bendLimit: true }).scratch as ReadonlyArray<{ key: string; stride: number; capacity: number }>;
    expect(scratch.find((entry) => entry.key === ROPE_SOLVE_KEY)).toMatchObject({ stride: 4, capacity: 550 * 20 });
    // Still the step's own four buffers and the producer's: the limit binds nothing more (§V588).
    expect(on.buffers.map((buffer) => buffer.binding)).toEqual(["pk_0", "state_in", "state_out", "kept", "scratch"]);
    // With every other switch too, it is one more letter on the id.
    expect(passOf(compile({ bendLimit: true, tensionOutput: true })).id).not.toBe(on.id);
  });

  /*
   * Holding a turn to its limit while the strand moves takes more Newton steps than holding
   * a length. So the DEFAULT of Iterations follows the switch — and only the default: a
   * number an author stored is theirs with the limit on or off. Both ways in agree: the
   * schema the compiler resolves defaults from, and the node read with no value at all.
   */
  it("Iterations defaults to 8 while it is on and to 4 while it is off, and a stored Iterations is the author's either way", () => {
    expect(effectiveParameterSchema(pointRopeNode, {})["iterations"]).toMatchObject({ default: ROPE_DEFAULTS.iterations });
    expect(effectiveParameterSchema(pointRopeNode, { bendLimit: true })["iterations"]).toMatchObject({ default: ROPE_MAX_ITERATIONS });
    expect(passOf(compile()).uniforms["solves"]).toBe(4);
    expect(passOf(compile({ bendLimit: true })).uniforms["solves"]).toBe(8);
    expect(passOf(compile({ bendLimit: true, iterations: 3 })).uniforms["solves"]).toBe(3);
    expect(passOf(compile({ iterations: 6 })).uniforms["solves"]).toBe(6);
    // Nothing else in the schema moves with the switch.
    const [off, on] = [effectiveParameterSchema(pointRopeNode, {}), effectiveParameterSchema(pointRopeNode, { bendLimit: true })];
    expect(Object.keys(on)).toEqual(Object.keys(off));
    for (const key of Object.keys(off)) if (key !== "iterations") expect(on[key], key).toBe(off[key]);
  });

  it("Min Bend Radius is inactive while Bend Limit is off, and says why", () => {
    const inactive = effectiveParameterSchema(pointRopeNode, {})["minBendRadius"]?.inactiveWhen;
    expect(inactive?.({ bendLimit: false })).toBe("Bend Limit is off.");
    expect(inactive?.({ bendLimit: true })).toBeNull();
    expect(effectiveParameterSchema(pointRopeNode, {})["bendLimit"]).toMatchObject({ type: "boolean", default: false, compileTime: true });
  });

  /*
   * THE PROGRAM WITHOUT THE LIMIT, FROZEN. A fingerprint of the whole plan for each shape the
   * step's text takes with Bend Limit off: its switches, its maps, its pin, its claims. The
   * limit is a second program beside this one and must not move a word of it. These moved
   * three times in slice 4, each for a change every Rope was meant to get — the guard between
   * two pins (D24), a weight within a millionth of 1 read as 1, and a held point that
   * follows a held point left where it is told (D31) — and the limit's own text never moved
   * them (the design's 17.9 has each value and what moved it).
   */
  it.each([
    ["the default", {}, "strips:55x10", undefined, "3c0dde6bb79537aa"],
    ["Tension", { tensionOutput: true }, "strips:55x10", undefined, "2ea65f9e5ac95d03"],
    ["three stations, Soft, a Segment Length, a Teleport Distance", { anchorSecond: 1, anchorLast: 1, anchorMode: "soft", segmentLength: 0.06, teleportDistance: 100 }, "strips:55x10", undefined, "e4a053ef65156952"],
    ["three stations mapped", {}, "strips:55x10", { anchorFirst: { attribute: "live" }, anchorSecond: { attribute: "live" }, anchorLast: { attribute: "live" } }, "4fe60f089a1f03be"],
    ["a pin, Tension and a mapped last station", { pinAttribute: "charge", tensionOutput: true }, "strips:55x10", { anchorLast: { attribute: "live" } }, "e461f63999f7672a"],
    ["a grid of two sheets", {}, "grid:55x5x2", undefined, "3c0dde6bb79537aa"],
    ["one strand to a row of 550", {}, "strips:550x1", undefined, "b10beddbf8f34796"],
  ] as const)("with Bend Limit off the plan is the plan it was: %s", (_label, parameters, topology, maps, fingerprint) => {
    const plan = compile(parameters, { topology, ...(maps === undefined ? {} : { maps }) });
    expect(plan.diagnostics ?? []).toEqual([]);
    expect(planFingerprint(plan)).toBe(fingerprint);
    // Stored off is not stored at all.
    expect(planFingerprint(compile({ ...parameters, bendLimit: false }, { topology, ...(maps === undefined ? {} : { maps }) }))).toBe(fingerprint);
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
