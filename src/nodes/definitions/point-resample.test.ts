import { describe, expect, it } from "vitest";

import { scratchResourceId } from "../../compiler/resources.ts";
import { pointResampleNode, resampleAttributes } from "./point-resample.ts";
import { pointStorageId } from "./point-storage.ts";
import { compileContext, fixturePairs, planFingerprint } from "./test-support.ts";

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

/**
 * T1586b slice 6 — A STRIP OF ONE BLOCK KEEPS ITS PROGRAM, TO THE BYTE. The reason and the
 * rule are in `point-curve-frames.test.ts`; these are Resample's programs for input strips
 * of at most 1,024 points, recorded from main before the blocked form was written
 * (7437b9f4).
 */
describe("Resample — a strip of one block keeps its program, to the byte (T1586b slice 6)", () => {
  const BLOCK = fixturePairs(
    "kernel_source",
    [
      { name: "position", type: "vec3f" },
      { name: "weight", type: "f32" },
      { name: "tag", type: "u32" },
    ],
    2048,
  );
  const frozen: ReadonlyArray<readonly [string, number, string, Record<string, unknown>]> = [
    ["d6d7402cbf9d0dcf", 2, "strips:1024x2", { method: "count", count: 300 }],
    ["dfa720d578ff46ed", 2, "strips:1024x2:closed", { method: "count", count: 300, offset: 0.25 }],
    ["5a0412abf02c3b36", 2, "strips:1024x2", { method: "distance", distance: 0.05, maxPoints: 512 }],
    ["da899a69c0907acd", 2, "strips:1024x2", { method: "distance", distance: 0.05, maxPoints: 512, anchor: "end", rangeStart: 0.1, rangeEnd: 0.9 }],
    ["da46dd28fb92c05b", 1, "strips:1024x2", { method: "count", spacing: "parameter", count: 300 }],
    ["16bd5d57c8644f0c", 2, "strips:54x30", { method: "distance", distance: 0.06, maxPoints: 54 }],
  ];

  for (const [fingerprint, passes, topology, parameters] of frozen) {
    it(`${topology} ${JSON.stringify(parameters)}`, () => {
      const result = compile(topology, parameters, { capacity: 2048, pairs: BLOCK });
      expect(result.diagnostics ?? []).toEqual([]);
      expect(result.passes).toHaveLength(passes);
      expect(planFingerprint(result)).toBe(fingerprint);
    });
  }
});

/**
 * T1586b slice 6 — an input strip LONGER than one block has its lengths taken by many
 * walks at once. What they compute is asserted on Dawn; this is their shape.
 */
describe("Resample — an input strip longer than one block (T1586b slice 6)", () => {
  const LONG = fixturePairs("kernel_source", [{ name: "position", type: "vec3f" }, { name: "weight", type: "f32" }], 7500);
  const long = (topology: string, parameters: Record<string, unknown>) => compile(topology, parameters, { capacity: 7500, pairs: LONG });
  /** The members a pass's uniform struct declares, read off its text. */
  const declared = (shader: string): string[] => {
    const body = shader.slice(shader.indexOf("struct "), shader.indexOf("};"));
    return [...body.matchAll(/^\s+(\w+):/gm)].map((match) => match[1] as string);
  };

  it("1,024 points are one length walk; 1,025 are a block pass, a fold and an add, then the same emit", () => {
    const short = long("strips:1024x3", { method: "count", count: 100 });
    expect((short.passes as Pass[]).map((pass) => pass.id.split(":").slice(2).join(":"))).toEqual(["lengths", "emit:count:length:start:100x3"]);
    const result = long("strips:1025x3", { method: "count", count: 100 });
    expect(result.diagnostics ?? []).toEqual([]);
    const passes = result.passes as Pass[];
    expect(passes.map((pass) => pass.id.split(":").slice(2).join(":"))).toEqual([
      "lengths:block",
      "lengths:fold",
      "lengths:add",
      "emit:count:length:start:100x3",
    ]);
    // Six blocks, three strips, 3,075 input points, 300 output slots.
    expect(passes.map((pass) => pass.workgroups[0])).toEqual([1, 1, 49, 5]);
    expect(passes[0]!.buffers.map((entry) => entry.binding)).toEqual(["in_position", "cumulative", "blockStarts"]);
    expect(passes[1]!.buffers.map((entry) => entry.binding)).toEqual(["blockStarts", "totals"]);
    expect(passes[2]!.buffers.map((entry) => entry.binding)).toEqual(["blockStarts", "cumulative"]);
    // The emit pass does not know its input was long: the text it runs is a short strip's.
    expect(passes[3]!.shader).toBe((short.passes as Pass[])[1]!.shader);
    expect(passes[3]!.buffers.map((entry) => entry.binding)).toEqual(["pk_0", "cumulative", "totals", "out_points"]);
    expect((result.scratch ?? []).map((entry) => (entry as { key: string }).key)).toEqual(["cumulative", "totals", "blockStarts", "@points"]);
    expect(((result.scratch ?? [])[2] as { capacity: number }).capacity).toBe(6);
  });

  it("every length pass sets exactly the uniforms its shader declares", () => {
    for (const pass of long("strips:2500x3:closed", { method: "distance", maxPoints: 64 }).passes as Pass[]) {
      expect(declared(pass.shader), pass.id).toEqual(Object.keys(pass.uniforms));
    }
  });

  it("Even Parameter walks nothing, so a long strip is still its one pass", () => {
    const result = long("strips:7500x1", { method: "count", spacing: "parameter" });
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.passes).toHaveLength(1);
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
