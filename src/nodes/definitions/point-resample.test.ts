import { describe, expect, it } from "vitest";

import { scratchResourceId } from "../../compiler/resources.ts";
import { pointResampleNode, resampleAttributes } from "./point-resample.ts";
import { pointStorageId } from "./point-storage.ts";
import { compileContext, fixturePairs } from "./test-support.ts";

/**
 * Resample at the fixture level (T1586b): what it publishes on the edge, how its passes
 * are bound, and every sentence it refuses with. The points it places are asserted on Dawn
 * in `point-resample.gpu.test.ts`; this file is the contract around them.
 */

const PAIRS = fixturePairs(
  "kernel_source",
  [
    { name: "position", type: "vec3f" },
    { name: "weight", type: "f32" },
    { name: "tag", type: "u32" },
  ],
  60,
);

const compile = (
  topology: string | undefined,
  parameters: Record<string, unknown> = {},
  options: { capacity?: number; pairs?: typeof PAIRS; count?: { buffer: string }; maps?: Record<string, { attribute: string }> } = {},
) =>
  pointResampleNode.compile(
    compileContext({
      nodeId: "resample_rings",
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
  shader: string;
  workgroups: number[];
  buffers: Array<{ binding: string; resourceId: string; half?: string; offset?: number }>;
  uniforms: Record<string, number>;
};

const errorOf = (result: ReturnType<typeof compile>) => ({
  code: result.diagnostics?.[0]?.code,
  message: result.diagnostics?.[0]?.message ?? "",
  suggestion: result.diagnostics?.[0]?.suggestion ?? "",
});

describe("Resample — what it publishes (T1586b)", () => {
  it("owns EVERY attribute of its output and claims strips of its own size", () => {
    const result = compile("strips:6x10", { method: "count", count: 20 });
    expect(result.diagnostics ?? []).toEqual([]);
    const out = result.pointsets?.["out"];
    expect(out?.capacity).toBe(200);
    expect(out?.topology).toBe("strips:20x10");
    // Slots move, so nothing passes by reference: every pair is this node's own buffer.
    expect(Object.keys(out?.pairs ?? {}).sort()).toEqual(["position", "tag", "weight"]);
    for (const ref of Object.values(out?.pairs ?? {})) expect(ref.buffer).toBe(pointStorageId("resample_rings"));
    expect(out?.pairs["tag"]?.type).toBe("u32");
    expect(out?.count).toBeUndefined();
  });

  it("by Distance allocates Max Points per strip and publishes live; by Count it does not", () => {
    const byDistance = compile("strips:6x10:closed", { method: "distance", maxPoints: 32 }).pointsets?.["out"];
    expect(byDistance?.capacity).toBe(320);
    expect(byDistance?.topology).toBe("strips:32x10:closed");
    expect(byDistance?.pairs["live"]?.type).toBe("f32");
    expect(compile("strips:6x10", { method: "count" }).pointsets?.["out"]?.pairs["live"]).toBeUndefined();
  });

  it("lays its buffer out as position, the rest by name, then live — and never carries the input's live", () => {
    const carried = [
      { name: "weight", type: "f32" as const },
      { name: "live", type: "f32" as const },
      { name: "position", type: "vec3f" as const },
      { name: "tag", type: "u32" as const },
    ];
    expect(resampleAttributes(carried, true).map((entry) => entry.name)).toEqual(["position", "tag", "weight", "live"]);
    expect(resampleAttributes(carried, false).map((entry) => entry.name)).toEqual(["position", "tag", "weight"]);
    // An input that arrives padded: Count leaves no slot spare, so no live goes out at all.
    const padded = fixturePairs("resample_upstream", [{ name: "position", type: "vec3f" }, { name: "live", type: "f32" }], 60);
    expect(compile("strips:6x10", { method: "count" }, { pairs: padded }).pointsets?.["out"]?.pairs["live"]).toBeUndefined();
  });

  it("a grid's rows resample as strips: the sheet between them is no longer promised", () => {
    expect(compile("grid:6x10:wrapU", { method: "count", count: 12 }).pointsets?.["out"]?.topology).toBe("strips:12x10:closed");
  });

  it("walks lengths per strip, then places one thread per output slot", () => {
    const result = compile("strips:6x10", { method: "distance", maxPoints: 32, distance: 0.25, offset: 0.5, rangeStart: 0.25, rangeEnd: 0.75 });
    expect(result.passes).toHaveLength(2);
    const [lengths, emit] = result.passes as [Pass, Pass];
    expect(lengths.workgroups).toEqual([1, 1, 1]); // 10 strips, one invocation each
    expect(lengths.buffers.map((entry) => entry.binding)).toEqual(["in_position", "cumulative", "totals"]);
    expect(emit.workgroups).toEqual([5, 1, 1]); // 320 output slots
    // One binding for the upstream buffer whatever it carries, and one for the output (T1076).
    expect(emit.buffers.map((entry) => entry.binding)).toEqual(["pk_0", "cumulative", "totals", "out_points"]);
    expect(emit.buffers[0]?.resourceId).toBe(PAIRS["position"]?.buffer);
    expect(emit.buffers[0]?.offset).toBeUndefined();
    expect(emit.buffers[1]?.resourceId).toBe(scratchResourceId("resample_rings", "cumulative"));
    expect(emit.uniforms).toMatchObject({ colsIn: 6, rows: 10, closed: 0, colsOut: 32, distance: 0.25, offset: 0.5, rangeStart: 0.25, rangeEnd: 0.75 });
    expect((result.scratch ?? []).map((entry) => (entry as { key: string }).key)).toEqual(["cumulative", "totals", "@points"]);
  });

  it("Even Parameter needs no lengths: one pass, no scratch but its own buffer", () => {
    const result = compile("strips:6x10", { method: "count", spacing: "parameter" });
    expect(result.passes).toHaveLength(1);
    const emit = result.passes[0] as Pass;
    expect(emit.buffers.map((entry) => entry.binding)).toEqual(["pk_0", "out_points"]);
    expect(emit.shader).not.toContain("cumulative");
    expect((result.scratch ?? []).map((entry) => (entry as { key: string }).key)).toEqual(["@points"]);
  });

  it("attributes that came from two producers by reference bind two buffers", () => {
    const mixed = {
      ...fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }], 60),
      ...fixturePairs("frames_spine", [{ name: "orient", type: "vec4f" }, { name: "distance", type: "f32" }], 60),
    };
    const emit = compile("strips:6x10", { method: "count", spacing: "parameter" }, { pairs: mixed }).passes[0] as Pass;
    expect(emit.buffers.map((entry) => entry.binding)).toEqual(["pk_0", "pk_1", "out_points"]);
    // In the order the output's own layout first needs them: position, then the rest by name.
    expect(emit.buffers.map((entry) => entry.resourceId)).toEqual([
      pointStorageId("kernel_source"),
      pointStorageId("frames_spine"),
      pointStorageId("resample_rings"),
    ]);
  });

  it("floats are blended and an integer is copied from the earlier point", () => {
    const emit = compile("strips:6x10", { method: "count" }).passes.at(-1) as Pass;
    const lines = emit.shader.split("\n").filter((line) => line.includes("out_points[") && line.includes("="));
    // position: three components; weight: one; all blended. tag: one, copied.
    expect(lines.filter((line) => line.includes("blend("))).toHaveLength(4);
    expect(lines.filter((line) => !line.includes("blend("))).toHaveLength(1);
  });
});

describe("Resample — refusals, each by name (§V288)", () => {
  it("an edge with no strips (D10)", () => {
    const refused = errorOf(compile("points"));
    expect(refused.code).toBe("node.points.strips");
    expect(refused.message).toContain("Resample follows each strip");
    expect(refused.suggestion).toContain("Topology");
  });

  it("a counted edge: the slots past a live count are not padding", () => {
    const refused = errorOf(compile("strips:6x10", {}, { count: { buffer: "scratch:kernel_source:counts" } }));
    expect(refused.code).toBe("node.points.resample");
    expect(refused.message).toContain("GPU live count");
  });

  it("a strip too long to walk by length — while Even Parameter, which walks nothing, takes it", () => {
    const long = fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }], 2048);
    const refused = errorOf(compile("strips:1025x1", { method: "count", spacing: "length" }, { capacity: 2048, pairs: long }));
    expect(refused.code).toBe("node.points.strips");
    expect(refused.message).toContain("1025");
    expect(compile("strips:1025x1", { method: "count", spacing: "parameter" }, { capacity: 2048, pairs: long }).diagnostics ?? []).toEqual([]);
  });

  it("Even Parameter over a padded input, whose padding it would count as points", () => {
    const padded = fixturePairs("resample_upstream", [{ name: "position", type: "vec3f" }, { name: "live", type: "f32" }], 60);
    const refused = errorOf(compile("strips:6x10", { method: "count", spacing: "parameter" }, { pairs: padded }));
    expect(refused.message).toContain("this input carries live");
    expect(refused.suggestion).toContain("Even Length");
    // Even Length passes over padding, so the same input is fine there.
    expect(compile("strips:6x10", { method: "count", spacing: "length" }, { pairs: padded }).diagnostics ?? []).toEqual([]);
  });

  it("more points than a pointset holds, with the count that fits", () => {
    const refused = errorOf(compile("strips:6x10", { method: "count", count: 200_000 }));
    expect(refused.code).toBe("node.points.capacity");
    expect(refused.message).toContain("2000000");
    expect(refused.suggestion).toContain("100000");
  });

  it("a parameter in map mode, and an attribute with no type to interpolate by", () => {
    expect(errorOf(compile("strips:6x10", {}, { maps: { distance: { attribute: "weight" } } })).code).toBe("node.parameter.map");
    const untyped = { ...PAIRS, mystery: { buffer: "scratch:kernel_source:@points", half: "write" as const, offset: 4096, bytes: 240 } };
    expect(errorOf(compile("strips:6x10", {}, { pairs: untyped })).message).toContain('"mystery" is untyped');
  });
});
