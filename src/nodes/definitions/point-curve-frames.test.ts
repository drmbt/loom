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

/** The passes that re-aim an open strip's ends (§T1587b C13) are named `…:frames:ends…`; every other pass is the walk. */
const isEnds = (pass: Pass): boolean => pass.id.split(":")[2] === "ends";
const walkOf = (result: ReturnType<typeof compile>): Pass[] => (result.passes as unknown as Pass[]).filter((pass) => !isEnds(pass));
const endsOf = (result: ReturnType<typeof compile>): Pass[] => (result.passes as unknown as Pass[]).filter(isEnds);
/** The members a pass's uniform struct declares, read off its text. */
const declared = (shader: string): string[] => {
  const body = /struct \w+Params \{([^}]*)\}/.exec(shader)?.[1] ?? "";
  return [...body.matchAll(/^\s+(\w+):/gm)].map((match) => match[1] as string);
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
    expect(walkOf(result)).toHaveLength(1);
    const pass = walkOf(result)[0] as Pass;
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
      /* §T1587b C13: Extrapolate Ends is on by default, and the walk is STILL this program. What it
         adds is two passes after the walk, and only where there is an end and a frame to aim. */
      expect(walkOf(result)).toHaveLength(1);
      expect(planFingerprint({ passes: walkOf(result) })).toBe(fingerprint);
      const aimed = !topology.endsWith(":closed") && parameters["frame"] !== false;
      expect((result.passes as unknown as Pass[]).map(isEnds)).toEqual(aimed ? [false, true, true] : [false]);
      // Off, the node's whole program is the one that shipped.
      const off = compile(topology, { ...parameters, extrapolateEnds: false }, { capacity: 2048, pairs: BLOCK, ...(maps === undefined ? {} : { maps }) });
      expect(off.passes).toHaveLength(1);
      expect(planFingerprint(off)).toBe(fingerprint);
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

  it("1,024 points are one walk; 1,025 are a block pass, a fold and a write pass", () => {
    expect(walkOf(long("strips:1024x3"))).toHaveLength(1);
    const result = long("strips:1025x3");
    expect(result.diagnostics ?? []).toEqual([]);
    const passes = walkOf(result);
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
    const few = walkOf(long("strips:1071x7"));
    expect(few.map((pass) => pass.workgroups[0])).toEqual([1, 1, 1]);
    // One strip of 7,500 points: eight blocks.
    const one = walkOf(long("strips:7500x1"));
    expect(one.map((pass) => pass.uniforms["blocks"])).toEqual([8, 8, 8]);
    // 65 block walks need a second workgroup; the fold still fits one.
    const many = walkOf(compile("strips:1025x33", {}, { capacity: 33_825, pairs: fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }], 33_825) }));
    expect(many.map((pass) => pass.workgroups[0])).toEqual([2, 1, 2]);
  });

  it("the walk's scratch holds a record per block and a few words per strip", () => {
    const scratch = (long("strips:1500x5", { extrapolateEnds: false }).scratch ?? []) as Array<{ key: string; stride?: number; capacity?: number }>;
    expect(scratch.map((entry) => entry.key)).toEqual(["walk", "@points"]);
    // Five strips of two blocks: 5 × 4 words and 10 × 56.
    expect(scratch[0]).toMatchObject({ stride: 4, capacity: 5 * 4 + 10 * 56 });
    // A short strip allocates none of it.
    expect((long("strips:1024x5", { extrapolateEnds: false }).scratch ?? []).map((entry) => (entry as { key: string }).key)).toEqual(["@points"]);
    // Extrapolate Ends adds four vectors a strip, whatever the strip's length.
    const aimed = (long("strips:1500x5").scratch ?? []) as Array<{ key: string; stride?: number; capacity?: number }>;
    expect(aimed.map((entry) => entry.key)).toEqual(["walk", "ends", "@points"]);
    expect(aimed[1]).toMatchObject({ stride: 16, capacity: 5 * 4 });
    expect((long("strips:1024x5").scratch ?? []).map((entry) => (entry as { key: string }).key)).toEqual(["ends", "@points"]);
  });

  it("Fixed Up hands a second thing from point to point, and has a pass and a fold for it", () => {
    const passes = walkOf(long("strips:2500x3", { method: "fixedUp" }, { up: { attribute: "lean" }, roll: { attribute: "bank" } }));
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
      for (const pass of result.passes as unknown as Pass[]) expect(declared(pass.shader), pass.id).toEqual(Object.keys(pass.uniforms));
    }
    // Close Twist is read where the closing angle is found, and nowhere else.
    const [block, fold, write] = walkOf(cases[1]!) as [Pass, Pass, Pass];
    expect(Object.keys(fold.uniforms)).toContain("closeTwist");
    expect(Object.keys(block.uniforms)).not.toContain("closeTwist");
    expect(write.uniforms["roll"]).toBe(0);
  });
});

/**
 * T1587b C13 — Extrapolate Ends: an open strip's two ends are aimed by their two nearest
 * segments. It is two passes AFTER the walk and never a change to it (the fingerprints
 * above), so what it can touch is what its own text touches. What it computes is asserted
 * on Dawn.
 */
describe("Curve Frames — Extrapolate Ends is two passes after the walk (T1587b C13)", () => {
  const LONG = fixturePairs(
    "kernel_source",
    [
      { name: "position", type: "vec3f" },
      { name: "lean", type: "vec3f" },
      { name: "bank", type: "f32" },
    ],
    7500,
  );
  const long = (topology: string, parameters: Record<string, unknown> = {}, maps?: Record<string, { attribute: string }>) =>
    compile(topology, parameters, { capacity: 7500, pairs: LONG, ...(maps === undefined ? {} : { maps }) });
  const stores = (shader: string): string[] => [...shader.matchAll(/^fn (store_\w+)\(/gm)].map((match) => match[1] as string);
  const stage = (pass: Pass): string => pass.id.split(":").slice(2, 4).join(":");
  const bound = (pass: Pass): string[] => pass.buffers.map((entry) => entry.binding);

  it("a short strip: FIND per strip reads the points and leaves four vectors; WRITE per 64 slots reads those and the walk's frame", () => {
    const result = compile("strips:6x10", { vectors: true });
    expect(result.diagnostics ?? []).toEqual([]);
    expect((result.passes as unknown as Pass[]).map(isEnds)).toEqual([false, true, true]);
    const [find, write] = endsOf(result) as [Pass, Pass];
    expect([stage(find), stage(write)]).toEqual(["ends:find", "ends:write"]);
    // Ten strips: one workgroup of 64. Sixty slots: one chunk of 64, one workgroup.
    expect([find.workgroups, write.workgroups]).toEqual([[1, 1, 1], [1, 1, 1]]);
    // FIND never touches a point's frame; WRITE never reads a position.
    expect(bound(find)).toEqual(["in_position", "ends"]);
    expect(find.shader).not.toContain("out_points");
    expect(bound(write)).toEqual(["ends", "out_points"]);
    expect(write.shader).not.toContain("in_position");
    expect(write.buffers[1]).toMatchObject({ resourceId: pointStorageId("frames_spine"), half: "write" });
    expect(write.buffers[1]!.offset).toBeUndefined();
    expect(find.uniforms).toEqual({ cols: 6, rows: 10 });
    expect(write.uniforms).toEqual({ cols: 6, rows: 10 });
    for (const pass of [find, write]) expect(declared(pass.shader), pass.id).toEqual(Object.keys(pass.uniforms));
  });

  it("WRITE is an invocation per 64 slots, so a run of any length is rewritten by many at once", () => {
    const groups = (topology: string, capacity: number): number =>
      endsOf(compile(topology, {}, { capacity, pairs: fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }], capacity) }))[1]!.workgroups[0]!;
    // 4,096 slots are 64 chunks: one workgroup. One more slot is one more chunk, and a second workgroup.
    expect(groups("strips:1024x4", 4096)).toBe(1);
    expect(groups("strips:4097x1", 4097)).toBe(2);
    expect(groups("strips:1024x976", 999_424)).toBe(244);
    expect(endsOf(compile("strips:6x10"))[1]!.shader).toContain("const CHUNK: u32 = 64u;");
  });

  it("writes the frame and nothing else: never a distance, a length or a curvature", () => {
    const write = (parameters: Record<string, unknown>): Pass => endsOf(compile("strips:6x10", parameters))[1]!;
    expect(stores(write({ vectors: true }).shader)).toEqual(["store_orient", "store_tangent", "store_normal", "store_binormal"]);
    expect(stores(write({}).shader)).toEqual(["store_orient"]);
    expect(stores(write({ frame: false, vectors: true, metrics: false }).shader)).toEqual(["store_tangent", "store_normal", "store_binormal"]);
    // The walk's own text stores the metrics; these passes do not name them.
    for (const pass of endsOf(compile("strips:6x10", { vectors: true }))) {
      for (const metric of ["distance", "curveU", "curveLength", "curvature"]) expect(pass.shader, pass.id).not.toContain(`store_${metric}`);
    }
  });

  it("reads the walk's normal back: the normal itself, or the +Y of the quaternion where that is all there is", () => {
    expect(endsOf(compile("strips:6x10", { vectors: true }))[1]!.shader).toContain("return load_normal(slot);");
    expect(endsOf(compile("strips:6x10"))[1]!.shader).toContain("return qrot(load_orient(slot), vec3f(0.0, 1.0, 0.0));");
  });

  it("exists only where there is an end and a frame to aim", () => {
    expect(endsOf(compile("strips:6x10"))).toHaveLength(2);
    // A closed strip has no ends.
    expect(endsOf(compile("strips:6x10:closed"))).toHaveLength(0);
    expect(endsOf(compile("grid:6x10:wrapU"))).toHaveLength(0);
    // Two points are one segment: they keep its direction.
    expect(endsOf(compile("strips:2x30"))).toHaveLength(0);
    expect(endsOf(compile("strips:3x20"))).toHaveLength(2);
    // Metrics alone publish no frame.
    expect(endsOf(compile("strips:6x10", { frame: false, vectors: false }))).toHaveLength(0);
    // And off is off.
    expect(endsOf(compile("strips:6x10", { extrapolateEnds: false }))).toHaveLength(0);
    expect(endsOf(long("strips:2500x3", { extrapolateEnds: false }))).toHaveLength(0);
    expect(endsOf(long("strips:2500x3:closed"))).toHaveLength(0);
    // With none of it there is no scratch for it either.
    expect((compile("strips:6x10:closed").scratch ?? []).map((entry) => (entry as { key: string }).key)).toEqual(["@points"]);
  });

  it("Fixed Up reads Up again, from where the walk read it; Minimise Twist reads neither Up nor the seed", () => {
    const carried = endsOf(compile("strips:6x10", { seed: "orient" }, { maps: { up: { attribute: "lean" }, roll: { attribute: "bank" } } }));
    expect(carried.map(bound)).toEqual([["in_position", "ends"], ["ends", "out_points"]]);
    expect(carried.map((pass) => Object.keys(pass.uniforms))).toEqual([["cols", "rows"], ["cols", "rows"]]);
    const fixed = endsOf(compile("strips:6x10", { method: "fixedUp", up: [0, 0, 1] }));
    expect(fixed.map(bound)).toEqual([["in_position", "ends"], ["ends", "out_points"]]);
    // Only the pass that leans a normal reads Up.
    expect(fixed.map((pass) => pass.uniforms)).toEqual([{ cols: 6, rows: 10 }, { up: [0, 0, 1], cols: 6, rows: 10 }]);
    const mapped = endsOf(compile("strips:6x10", { method: "fixedUp" }, { maps: { up: { attribute: "lean" }, roll: { attribute: "bank" } } }));
    // The roll is not read again: the walk's normal carries it.
    expect(mapped.map(bound)).toEqual([["in_position", "ends"], ["in_up", "ends", "out_points"]]);
    expect(mapped.map((pass) => Object.keys(pass.uniforms))).toEqual([["cols", "rows"], ["cols", "rows"]]);
    for (const pass of [...carried, ...fixed, ...mapped]) expect(declared(pass.shader), pass.id).toEqual(Object.keys(pass.uniforms));
  });

  it("a long strip: FIND reads the walk's block summaries, so it opens two blocks whatever the padding", () => {
    const result = long("strips:2500x3", { vectors: true });
    expect(result.diagnostics ?? []).toEqual([]);
    expect((result.passes as unknown as Pass[]).map(stage)).toEqual(["block:minimiseTwist", "fold:minimiseTwist", "write:minimiseTwist", "ends:find", "ends:write"]);
    const [find, write] = endsOf(result) as [Pass, Pass];
    expect(bound(find)).toEqual(["in_position", "walk", "ends"]);
    expect(find.shader).toContain("params.blocks");
    expect(find.shader).not.toContain("out_points");
    // WRITE is the short strip's: it knows nothing of blocks.
    expect(bound(write)).toEqual(["ends", "out_points"]);
    expect(find.uniforms).toEqual({ cols: 2500, rows: 3, blocks: 3 });
    expect(write.uniforms).toEqual({ cols: 2500, rows: 3 });
    // Three strips: one workgroup. 7,500 slots are 118 chunks: two workgroups.
    expect([find.workgroups, write.workgroups]).toEqual([[1, 1, 1], [2, 1, 1]]);
    for (const pass of [find, write]) expect(declared(pass.shader), pass.id).toEqual(Object.keys(pass.uniforms));
    // A short strip's FIND has no summaries to read and scans its points.
    expect(endsOf(compile("strips:6x10"))[0]!.shader).not.toContain("walk");
    // Fixed Up with a mapped Up: WRITE reads it, FIND does not.
    expect(endsOf(long("strips:2500x3", { method: "fixedUp" }, { up: { attribute: "lean" } })).map(bound)).toEqual([["in_position", "walk", "ends"], ["in_up", "ends", "out_points"]]);
  });

  it("is inactive where nothing is published for it to aim", () => {
    const inactive = (values: Record<string, unknown>): string | null =>
      (pointCurveFramesNode.parameters["extrapolateEnds"] as { inactiveWhen?: (values: Record<string, unknown>) => string | null }).inactiveWhen?.(values) ?? null;
    expect(inactive({ frame: true, vectors: false })).toBeNull();
    expect(inactive({ frame: false, vectors: true })).toBeNull();
    expect(inactive({ frame: false, vectors: false })).toBe("Only a frame has ends to aim: turn Frame or Vectors on.");
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
