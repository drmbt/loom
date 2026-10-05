import { describe, expect, it } from "vitest";

import { curveFramesAttributes, pointCurveFramesNode } from "./point-curve-frames.ts";
import { pointStorageId } from "./point-storage.ts";
import { compileContext, fixturePairs } from "./test-support.ts";

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

  it("a strip longer than one walk, with the slice that lifts the limit", () => {
    const long = fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }], 2048);
    const refused = errorOf(compile("strips:1025x1", {}, { capacity: 2048, pairs: long }));
    expect(refused.code).toBe("node.points.strips");
    expect(refused.message).toContain("1024");
    expect(refused.message).toContain("1025");
    expect(refused.message).toContain("T1586b");
    // The limit is the block, not one below it.
    expect(compile("strips:1024x1", {}, { capacity: 2048, pairs: long }).diagnostics ?? []).toEqual([]);
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
