import { describe, expect, it } from "vitest";

import { curveFramesAttributes, pointCurveFramesNode } from "./point-curve-frames.ts";
import { pointStorageId } from "./point-storage.ts";
import { compileContext, fixturePairs, planFingerprint } from "./test-support.ts";

/**
 * Curve Frames at the fixture level (T1586b): what it publishes on the edge, and every
 * sentence it refuses with. The values it computes are asserted on Dawn in
 * `point-curve-frames.gpu.test.ts`; this file is the contract around them.
 */

const PAIRS = fixturePairs(
  "kernel_source",
  [
    { name: "position", type: "vec3f" },
    { name: "orient", type: "vec4f" },
    { name: "lean", type: "vec3f" },
    { name: "bank", type: "f32" },
    { name: "tag", type: "u32" },
  ],
  60,
);

const compile = (
  topology: string | undefined,
  parameters: Record<string, unknown> = {},
  options: { capacity?: number; maps?: Record<string, { attribute: string; channel?: string }>; pairs?: typeof PAIRS; count?: { buffer: string } } = {},
) =>
  pointCurveFramesNode.compile(
    compileContext({
      nodeId: "frames_spine",
      inputs: ["points"],
      outputs: ["out"],
      pointsets: {
        points: {
          pairs: options.pairs ?? PAIRS,
          capacity: options.capacity ?? 60,
          ...(topology === undefined ? {} : { topology }),
          ...(options.count === undefined ? {} : { count: options.count }),
        },
      },
      parameters: parameters as never,
      ...(options.maps === undefined ? {} : { parameterMaps: options.maps }),
    }),
  );

type Pass = {
  id: string;
  kind: string;
  shader: string;
  workgroups: number[];
  buffers: Array<{ binding: string; resourceId: string; half?: string; offset?: number; bytes?: number }>;
  uniforms: Record<string, number | number[]>;
};

const errorOf = (result: ReturnType<typeof compile>) => ({
  code: result.diagnostics?.[0]?.code,
  message: result.diagnostics?.[0]?.message ?? "",
  suggestion: result.diagnostics?.[0]?.suggestion ?? "",
});

describe("Curve Frames — what it publishes (T1586b R3)", () => {
  it("adds its attributes to the source BY REFERENCE and keeps the claim (§V197, §V883)", () => {
    const result = compile("strips:6x10");
    expect(result.diagnostics ?? []).toEqual([]);
    const out = result.pointsets?.["out"];
    expect(out?.capacity).toBe(60);
    expect(out?.topology).toBe("strips:6x10");
    // The upstream's own regions, untouched: the measurements travel WITH what they measured.
    expect(out?.pairs["position"]).toBe(PAIRS["position"]);
    expect(out?.pairs["lean"]).toBe(PAIRS["lean"]);
    expect(out?.pairs["tag"]).toBe(PAIRS["tag"]);
    // By default: the frame and the metrics, no vectors. `orient` was on the edge already,
    // as a vec4f, so it is REPLACED by this node's own region.
    expect(Object.keys(out?.pairs ?? {}).sort()).toEqual(
      ["bank", "curvature", "curveLength", "curveU", "distance", "lean", "orient", "position", "tag"].sort(),
    );
    expect(out?.pairs["orient"]?.buffer).toBe(pointStorageId("frames_spine"));
    expect(out?.pairs["orient"]?.type).toBe("vec4f");
    expect(out?.pairs["distance"]?.type).toBe("f32");
    expect(out?.pairs["tangent"]).toBeUndefined();
  });

  it("the three switches decide which attributes exist, in one declared order", () => {
    expect(curveFramesAttributes({ frame: true, vectors: true, metrics: true }).map((entry) => entry.name)).toEqual([
      "orient", "tangent", "normal", "binormal", "distance", "curveU", "curveLength", "curvature",
    ]);
    const vectorsOnly = compile("strips:6x10", { frame: false, vectors: true, metrics: false });
    const own = Object.entries(vectorsOnly.pointsets?.["out"]?.pairs ?? {})
      .filter(([, ref]) => ref.buffer === pointStorageId("frames_spine"))
      .map(([name]) => name);
    expect(own.sort()).toEqual(["binormal", "normal", "tangent"]);
    // The incoming `orient` is left alone when Frame is off.
    expect(vectorsOnly.pointsets?.["out"]?.pairs["orient"]).toBe(PAIRS["orient"]);
  });

  it("is one dispatch, one invocation per STRIP, writing its whole packed buffer through one binding", () => {
    const result = compile("strips:6x10", { vectors: true });
    expect(result.passes).toHaveLength(1);
    const pass = result.passes[0] as Pass;
    expect(pass.kind).toBe("dispatch");
    // 10 strips fit one workgroup of 64: the walk is per strip, not per point.
    expect(pass.workgroups).toEqual([1, 1, 1]);
    expect(pass.buffers.map((entry) => entry.binding)).toEqual(["in_position", "out_points"]);
    // The output binding is the WHOLE buffer — no region offset — so eight attributes are
    // one storage binding rather than eight (§V588).
    const out = pass.buffers[1]!;
    expect(out.resourceId).toBe(pointStorageId("frames_spine"));
    expect(out.offset).toBeUndefined();
    expect(pass.uniforms["cols"]).toBe(6);
    expect(pass.uniforms["rows"]).toBe(10);
    expect(pass.uniforms["closed"]).toBe(0);
  });

  it("65 strips need a second workgroup; roll and twist reach the pass in radians", () => {
    const wide = compile("strips:1x65", { roll: 90, twist: 180 }, { capacity: 65, pairs: fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }], 65) })
      .passes[0] as Pass;
    expect(wide.workgroups).toEqual([2, 1, 1]);
    expect(wide.uniforms["roll"]).toBeCloseTo(Math.PI / 2, 12);
    expect(wide.uniforms["twist"]).toBeCloseTo(Math.PI, 12);
  });

  it("a grid's rows are strips, closed when it wraps U", () => {
    const tube = compile("grid:6x10:wrapU").passes[0] as Pass;
    expect(tube.uniforms["cols"]).toBe(6);
    expect(tube.uniforms["rows"]).toBe(10);
    expect(tube.uniforms["closed"]).toBe(1);
    const sheet = compile("grid:6x10:wrapV").passes[0] as Pass;
    expect(sheet.uniforms["closed"]).toBe(0);
  });

  it("measuring moves no slot, so a live count rides through", () => {
    const counted = compile("strips:6x10", {}, { count: { buffer: "scratch:kernel_source:counts" } });
    expect(counted.pointsets?.["out"]?.count).toEqual({ buffer: "scratch:kernel_source:counts" });
  });

  it("the maps bind one buffer each, and the program's id says which", () => {
    const mapped = compile("strips:6x10", {}, { maps: { up: { attribute: "lean" }, roll: { attribute: "bank" } } });
    const pass = mapped.passes[0] as Pass;
    expect(pass.buffers.map((entry) => entry.binding)).toEqual(["in_position", "in_up", "in_roll", "out_points"]);
    expect(pass.shader).toContain("in_roll[slot] * 0.017453292519943295");
    const plain = compile("strips:6x10").passes[0] as Pass;
    expect(pass.id).not.toBe(plain.id);
    // §V309: with nothing mapped the text names neither buffer.
    expect(plain.shader).not.toContain("in_up");
    expect(plain.shader).not.toContain("in_roll");

    const seeded = compile("strips:6x10", { seed: "orient" }).passes[0] as Pass;
    expect(seeded.buffers.map((entry) => entry.binding)).toEqual(["in_position", "in_seed", "out_points"]);
    // The seed is read from the UPSTREAM's orient while this node writes its own.
    expect(seeded.buffers[1]?.resourceId).toBe(PAIRS["orient"]?.buffer);
  });
});

/**
 * T1586b slice 6 — A STRIP OF ONE BLOCK KEEPS ITS PROGRAM, TO THE BYTE.
 *
 * Long strips are cut into blocks of 1,024 points, and a block's result is added to its
 * block's start, so a long strip rounds differently from one walked whole. A strip that
 * FITS one block must not notice: it is walked by the single program it was walked by
 * before long strips existed, and every document that shipped a curve of up to 1,024 points
 * reads back the bytes it read then.
 *
 * So the program is pinned here by its text — ids, shader, bindings, dispatch and uniform
 * values — recorded from main before the blocked form was written (7437b9f4). A change to
 * a fingerprint below is a change to what short strips compute: make it on purpose, never
 * to get this green.
 */
describe("Curve Frames — a strip of one block keeps its program, to the byte (T1586b slice 6)", () => {
  const BLOCK = fixturePairs(
    "kernel_source",
    [
      { name: "position", type: "vec3f" },
      { name: "orient", type: "vec4f" },
      { name: "lean", type: "vec3f" },
      { name: "bank", type: "f32" },
    ],
    2048,
  );
  const frozen: ReadonlyArray<readonly [string, string, Record<string, unknown>, Record<string, { attribute: string }>?]> = [
    ["6a7f974a86143545", "strips:1024x2", {}],
    ["99a691adef0baf87", "strips:1024x2", { vectors: true }],
    ["a3254d4e917beee7", "strips:1024x2:closed", { vectors: true, closeTwist: false, roll: 30, twist: 90 }],
    ["d2976ed0493d5b6e", "strips:1024x2", { seed: "orient" }],
    ["ecdb744e215454fc", "strips:1024x2", {}, { up: { attribute: "lean" }, roll: { attribute: "bank" } }],
    ["9c186cdd1cd45f30", "strips:1024x2", { method: "fixedUp", vectors: true }],
    ["52041badbec145b3", "strips:1024x2:closed", { method: "fixedUp" }, { up: { attribute: "lean" }, roll: { attribute: "bank" } }],
    ["c5b4ec88cf3e10b3", "strips:1024x2", { frame: false, metrics: true }],
    ["98e71652e888178c", "strips:54x30", { vectors: true }],
  ];

  for (const [fingerprint, topology, parameters, maps] of frozen) {
    it(`${topology} ${JSON.stringify(parameters)}${maps === undefined ? "" : ` mapped ${Object.keys(maps).join(", ")}`}`, () => {
      const result = compile(topology, parameters, { capacity: 2048, pairs: BLOCK, ...(maps === undefined ? {} : { maps }) });
      expect(result.diagnostics ?? []).toEqual([]);
      expect(result.passes).toHaveLength(1);
      expect(planFingerprint(result)).toBe(fingerprint);
    });
  }
});

/**
 * T1586b slice 6 — a strip LONGER than one block is cut into blocks and walked by many
 * invocations at once. What the passes compute is asserted on Dawn; this is their shape.
 */
describe("Curve Frames — a strip longer than one block (T1586b slice 6)", () => {
  const LONG = fixturePairs(
    "kernel_source",
    [
      { name: "position", type: "vec3f" },
      { name: "orient", type: "vec4f" },
      { name: "lean", type: "vec3f" },
      { name: "bank", type: "f32" },
    ],
    7500,
  );
  const long = (topology: string, parameters: Record<string, unknown> = {}, maps?: Record<string, { attribute: string }>) =>
    compile(topology, parameters, { capacity: 7500, pairs: LONG, ...(maps === undefined ? {} : { maps }) });
  /** The members a pass's uniform struct declares, read off its text. */
  const declared = (shader: string): string[] => {
    const body = shader.slice(shader.indexOf("struct CurveFramesParams {"), shader.indexOf("};"));
    return [...body.matchAll(/^\s+(\w+):/gm)].map((match) => match[1] as string);
  };

  it("1,024 points are one walk; 1,025 are a block pass, a fold and a write pass", () => {
    expect(long("strips:1024x3").passes).toHaveLength(1);
    const result = long("strips:1025x3");
    expect(result.diagnostics ?? []).toEqual([]);
    const passes = result.passes as Pass[];
    expect(passes.map((pass) => pass.id.split(":").slice(1, 3).join(":"))).toEqual(["frames:block", "frames:fold", "frames:write"]);
    // Two blocks a strip, three strips: six block invocations, three strip invocations.
    expect(passes.map((pass) => pass.workgroups)).toEqual([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
    expect(passes.map((pass) => pass.uniforms["blocks"])).toEqual([2, 2, 2]);
    expect(passes[0]!.buffers.map((entry) => entry.binding)).toEqual(["in_position", "walk"]);
    // The fold reads summaries, never points.
    expect(passes[1]!.buffers.map((entry) => entry.binding)).toEqual(["walk"]);
    expect(passes[2]!.buffers.map((entry) => entry.binding)).toEqual(["in_position", "walk", "out_points"]);
    // The edge is what a short strip's is: the same pairs by reference, the claim passed through.
    const short = long("strips:1024x3").pointsets?.["out"];
    expect(result.pointsets?.["out"]?.pairs).toEqual(short?.pairs);
    expect(result.pointsets?.["out"]?.topology).toBe("strips:1025x3");
  });

  it("the invocations are per BLOCK and per STRIP, never per long strip", () => {
    // 7 strips of 1,071 points: two blocks each, fourteen block walks.
    const few = long("strips:1071x7").passes as Pass[];
    expect(few.map((pass) => pass.workgroups[0])).toEqual([1, 1, 1]);
    // One strip of 7,500 points: eight blocks.
    const one = long("strips:7500x1").passes as Pass[];
    expect(one.map((pass) => pass.uniforms["blocks"])).toEqual([8, 8, 8]);
    // 65 block walks need a second workgroup; the fold still fits one.
    const many = compile("strips:1025x33", {}, { capacity: 33_825, pairs: fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }], 33_825) }).passes as Pass[];
    expect(many.map((pass) => pass.workgroups[0])).toEqual([2, 1, 2]);
  });

  it("the walk's scratch holds a record per block and a few words per strip", () => {
    const scratch = (long("strips:1500x5").scratch ?? []) as Array<{ key: string; stride?: number; capacity?: number }>;
    expect(scratch.map((entry) => entry.key)).toEqual(["walk", "@points"]);
    // Five strips of two blocks: 5 × 4 words and 10 × 56.
    expect(scratch[0]).toMatchObject({ stride: 4, capacity: 5 * 4 + 10 * 56 });
    // A short strip allocates none of it.
    expect((long("strips:1024x5").scratch ?? []).map((entry) => (entry as { key: string }).key)).toEqual(["@points"]);
  });

  it("Fixed Up hands a second thing from point to point, and has a pass and a fold for it", () => {
    const passes = long("strips:2500x3", { method: "fixedUp" }, { up: { attribute: "lean" }, roll: { attribute: "bank" } }).passes as Pass[];
    expect(passes.map((pass) => pass.id.split(":")[2])).toEqual(["block", "fold", "chain", "chainFold", "write"]);
    expect(passes[2]!.buffers.map((entry) => entry.binding)).toEqual(["in_position", "in_up", "walk"]);
    expect(passes[3]!.buffers.map((entry) => entry.binding)).toEqual(["walk"]);
    // Only the write pass turns a normal about its tangent, so only it reads the roll.
    expect(passes[4]!.buffers.map((entry) => entry.binding)).toEqual(["in_position", "in_up", "in_roll", "walk", "out_points"]);
    expect(passes[0]!.shader).not.toContain("in_roll");
  });

  /**
   * vgpu writes uniform values BY NAME into the reflected layout: a declared member with no
   * value reads zero in silence, and a value with no member is dropped (§V288). Each pass's
   * struct and its record are written from one list; this holds them together.
   */
  it("every pass sets exactly the uniforms its shader declares", () => {
    const cases = [
      long("strips:2500x3"),
      long("strips:2500x3:closed", { vectors: true }, { up: { attribute: "lean" }, roll: { attribute: "bank" } }),
      long("strips:2500x3", { seed: "orient" }),
      long("strips:2500x3", { method: "fixedUp" }),
      long("strips:2500x3:closed", { method: "fixedUp", vectors: true }, { up: { attribute: "lean" } }),
    ];
    for (const result of cases) {
      expect(result.diagnostics ?? []).toEqual([]);
      for (const pass of result.passes as Pass[]) expect(declared(pass.shader), pass.id).toEqual(Object.keys(pass.uniforms));
    }
    // Close Twist is read where the closing angle is found, and nowhere else.
    const [block, fold, write] = cases[1]!.passes as [Pass, Pass, Pass];
    expect(Object.keys(fold.uniforms)).toContain("closeTwist");
    expect(Object.keys(block.uniforms)).not.toContain("closeTwist");
    expect(write.uniforms["roll"]).toBe(0);
  });
});

describe("Curve Frames — refusals, each by name (§V288)", () => {
  it("an edge with no strips names what it claims and the node that fixes it (D10)", () => {
    for (const topology of ["points", undefined, "mesh:12@scratch:m:indices"]) {
      const refused = errorOf(compile(topology));
      expect(refused.code).toBe("node.points.strips");
      expect(refused.message).toContain("Curve Frames follows each strip");
      expect(refused.message).toContain(topology ?? "points");
      expect(refused.suggestion).toContain("Topology");
    }
  });

  it("a claim that addresses more points than the edge carries", () => {
    const refused = errorOf(compile("strips:6x11"));
    expect(refused.code).toBe("node.points.strips");
    expect(refused.message).toContain("66");
    expect(refused.message).toContain("60");
  });

  it("a map it cannot honour, rather than reading the retained value", () => {
    const refused = errorOf(compile("strips:6x10", {}, { maps: { twist: { attribute: "bank" } } }));
    expect(refused.code).toBe("node.parameter.map");
    expect(refused.message).toContain("twist");
    expect(refused.message).toContain('"up" and "roll"');
  });

  it("an Up map that is not a whole vec3f", () => {
    expect(errorOf(compile("strips:6x10", {}, { maps: { up: { attribute: "bank" } } })).message).toContain("up needs a vec3f attribute");
    expect(errorOf(compile("strips:6x10", {}, { maps: { up: { attribute: "missing" } } })).suggestion).toContain("It provides: bank, lean, orient, position, tag.");
    expect(errorOf(compile("strips:6x10", {}, { maps: { up: { attribute: "lean", channel: "x" } } })).message).toContain("a channel belongs on a component");
  });

  it("a seed attribute the points do not carry, or that is not a quaternion", () => {
    const missing = errorOf(compile("strips:6x10", { seed: "orient", seedOrient: "socket" }));
    expect(missing.message).toContain('the seed reads attribute "socket"');
    expect(missing.suggestion).toContain("orient");
    expect(errorOf(compile("strips:6x10", { seed: "orient", seedOrient: "lean" })).message).toContain("a start frame is a vec4f quaternion");
    // Fixed Up has no start frame, so the seed is not read and a bad name cannot refuse it.
    expect(compile("strips:6x10", { method: "fixedUp", seed: "orient", seedOrient: "socket" }).diagnostics ?? []).toEqual([]);
  });

  it("nothing to publish, and a name whose type it would change", () => {
    expect(errorOf(compile("strips:6x10", { frame: false, vectors: false, metrics: false })).message).toContain("nothing to publish");
    const clashing = fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }, { name: "distance", type: "vec3f" }], 60);
    const refused = errorOf(compile("strips:6x10", {}, { pairs: clashing }));
    expect(refused.message).toContain('publishing "distance" as f32 would change the type');
    // With Metrics off the clash is gone: the node no longer publishes that name.
    expect(compile("strips:6x10", { metrics: false }, { pairs: clashing }).diagnostics ?? []).toEqual([]);
  });
});
