import { describe, expect, it } from "vitest";

import { ARC_CHAIN_SECTIONS, CURVE_TABLE_LIMIT, evaluateCurve } from "../../points/curve.ts";
import { authoredCurve, curveAttributes, pointCurveNode } from "./point-curve.ts";
import { pointStorageId } from "./point-storage.ts";
import { compileContext, fixturePairs } from "./test-support.ts";

/**
 * Curve at the fixture level (T1586b slice 2): what it publishes on the edge, how its one
 * pass is bound, and every sentence it refuses with. The points it writes are asserted on
 * Dawn in `point-curve.gpu.test.ts`; this file is the contract around them.
 */

const PAIRS = fixturePairs(
  "kernel_control",
  [
    { name: "position", type: "vec3f" },
    { name: "radius", type: "f32" },
    { name: "side", type: "vec3f" },
    { name: "tag", type: "u32" },
  ],
  30,
);
const HANDLED = fixturePairs(
  "kernel_control",
  [
    { name: "position", type: "vec3f" },
    { name: "handleIn", type: "vec3f" },
    { name: "handleOut", type: "vec3f" },
    { name: "radius", type: "f32" },
  ],
  30,
);

const wired = (
  topology: string | undefined,
  parameters: Record<string, unknown> = {},
  options: { pairs?: typeof PAIRS; capacity?: number; count?: { buffer: string }; maps?: Record<string, { attribute: string; channel?: string }> } = {},
) =>
  pointCurveNode.compile(
    compileContext({
      nodeId: "curve_spine",
      inputs: ["in"],
      outputs: ["out"],
      pointsets: {
        in: {
          pairs: options.pairs ?? PAIRS,
          capacity: options.capacity ?? 30,
          ...(topology === undefined ? {} : { topology }),
          ...(options.count === undefined ? {} : { count: options.count }),
        },
      },
      parameters: parameters as never,
      ...(options.maps === undefined ? {} : { parameterMaps: options.maps }),
    }),
  );

const table = (parameters: Record<string, unknown> = {}, maps?: Record<string, { attribute: string }>) =>
  pointCurveNode.compile(
    compileContext({ nodeId: "curve_path", outputs: ["out"], parameters: parameters as never, ...(maps === undefined ? {} : { parameterMaps: maps }) }),
  );

type Pass = {
  id: string;
  shader: string;
  workgroups: number[];
  buffers: Array<{ binding: string; resourceId: string; half?: string; offset?: number }>;
  uniforms: Record<string, number | number[]>;
};

const errorOf = (result: ReturnType<typeof wired>) => ({
  code: result.diagnostics?.[0]?.code,
  message: result.diagnostics?.[0]?.message ?? "",
  suggestion: result.diagnostics?.[0]?.suggestion ?? "",
});

/** The members a shader's `CurveParams` declares, read off its text. */
const declaredMembers = (shader: string): string[] => {
  const body = shader.slice(shader.indexOf("struct CurveParams {"), shader.indexOf("};"));
  return [...body.matchAll(/^\s+(\w+):/gm)].map((match) => match[1] as string);
};

describe("Curve — what it publishes (T1586b)", () => {
  it("makes Segments points per span, one more to end an open strip, and claims strips of its own size", () => {
    const open = wired("strips:6x5", { basis: "catmullRom", segments: 4 });
    expect(open.diagnostics ?? []).toEqual([]);
    // Five spans of four points and the last control point: 21 a strip, five strips.
    expect(open.pointsets?.["out"]?.topology).toBe("strips:21x5");
    expect(open.pointsets?.["out"]?.capacity).toBe(105);
    const closed = wired("strips:6x5:closed", { basis: "catmullRom", segments: 4 });
    expect(closed.pointsets?.["out"]?.topology).toBe("strips:24x5:closed");
    // An unclamped B-Spline stops short of both ends: two spans fewer.
    expect(wired("strips:6x5", { basis: "bspline", clamped: false, segments: 4 }).pointsets?.["out"]?.topology).toBe("strips:13x5");
    // A grid's rows are control strips too.
    expect(wired("grid:6x5:wrapU", { basis: "linear", segments: 2 }).pointsets?.["out"]?.topology).toBe("strips:12x5:closed");
  });

  it("owns every attribute of its output: position, then what the control points carry, by name", () => {
    const out = wired("strips:6x5").pointsets?.["out"];
    expect(Object.keys(out?.pairs ?? {}).sort()).toEqual(["position", "radius", "side", "tag"]);
    for (const ref of Object.values(out?.pairs ?? {})) expect(ref.buffer).toBe(pointStorageId("curve_spine"));
    expect(curveAttributes([{ name: "tag", type: "u32" }, { name: "position", type: "vec3f" }, { name: "radius", type: "f32" }], "linear").map((entry) => entry.name)).toEqual([
      "position",
      "radius",
      "tag",
    ]);
  });

  it("a Bezier reads the two handles and leaves them off the curve", () => {
    const result = wired("strips:6x5", { basis: "bezier" }, { pairs: HANDLED });
    expect(result.diagnostics ?? []).toEqual([]);
    expect(Object.keys(result.pointsets?.["out"]?.pairs ?? {}).sort()).toEqual(["position", "radius"]);
    // Under any other basis they are ordinary attributes and ride along.
    expect(Object.keys(wired("strips:6x5", { basis: "linear" }, { pairs: HANDLED }).pointsets?.["out"]?.pairs ?? {}).sort()).toEqual([
      "handleIn",
      "handleOut",
      "position",
      "radius",
    ]);
  });

  it("is ONE dispatch, a thread per output point, with one binding per upstream buffer and one for its own", () => {
    const result = wired("strips:6x5", { basis: "catmullRom", segments: 4 });
    expect(result.passes).toHaveLength(1);
    const pass = result.passes[0] as Pass;
    expect(pass.workgroups).toEqual([2, 1, 1]); // 105 points
    expect(pass.buffers.map((entry) => entry.binding)).toEqual(["pk_0", "out_points"]);
    expect(pass.buffers[0]?.resourceId).toBe(PAIRS["position"]?.buffer);
    expect(pass.buffers[0]?.offset).toBeUndefined();
    expect(pass.uniforms).toMatchObject({ colsIn: 6, rows: 5, closed: 0, colsOut: 21, segments: 4, spans: 5 });
  });

  /**
   * vgpu writes uniform values BY NAME into the reflected layout: a declared member with no
   * value reads zero in silence, and a value with no member is dropped (§V288). The node
   * builds the struct and the record from one list, and this holds the two together for
   * every basis and both sources.
   */
  it("sets exactly the uniforms its shader declares, for every basis and both sources", () => {
    const cases: Array<ReturnType<typeof wired>> = [
      wired("strips:6x5", { basis: "linear" }),
      wired("strips:6x5", { basis: "catmullRom" }),
      wired("strips:6x5", { basis: "cardinal", tension: 0.25 }),
      wired("strips:6x5", { basis: "bspline" }),
      wired("strips:6x5", { basis: "bezier" }, { pairs: HANDLED }),
      wired("strips:6x5", { basis: "arc" }),
      table({ basis: "arc", points: "[[0,0,0],[1,0,0],[2,1,0],[3,1,0],[4,0,0]]" }),
    ];
    for (const result of cases) {
      expect(result.diagnostics ?? []).toEqual([]);
      const pass = result.passes[0] as Pass;
      expect(declaredMembers(pass.shader), pass.id).toEqual(Object.keys(pass.uniforms));
    }
    const cardinal = cases[2]?.passes[0] as Pass;
    expect(cardinal.uniforms["tension"]).toBe(0.25);
    expect(Object.keys((cases[0]?.passes[0] as Pass).uniforms)).not.toContain("tension");
  });

  it("the Arc's knobs reach the pass as values: the turn in radians and halved, the unit as a flag", () => {
    const pass = wired("strips:6x5", { basis: "arc", arcLength: 2.5, arcLengthUnit: "chords", bow: [0, 0, 1], maxTurn: 180 }).passes[0] as Pass;
    expect(pass.uniforms["arcLength"]).toBe(2.5);
    expect(pass.uniforms["arcChords"]).toBe(1);
    expect(pass.uniforms["bow"]).toEqual([0, 0, 1]);
    expect(pass.uniforms["maxHalfTurn"]).toBeCloseTo(Math.PI / 2, 12);
    expect((wired("strips:6x5", { basis: "arc" }).passes[0] as Pass).uniforms["maxHalfTurn"]).toBeCloseTo(Math.PI, 12);
  });

  it("Arc Length and Bow in Map mode read the control set per span, and the program's text says so", () => {
    const mapped = wired("strips:6x5", { basis: "arc" }, { maps: { arcLength: { attribute: "radius" }, bow: { attribute: "side" } } });
    expect(mapped.diagnostics ?? []).toEqual([]);
    const pass = mapped.passes[0] as Pass;
    expect(pass.shader).toContain("controlArcLength(strip, index)");
    expect(pass.shader).toContain("controlBow(strip, index)");
    const plain = wired("strips:6x5", { basis: "arc" }).passes[0] as Pass;
    expect(plain.shader).toContain("params.arcLength;");
    expect(plain.shader).not.toContain("controlBow");
  });
});

describe("Curve — the node's own table (T1586b D7)", () => {
  it("unwired, it reads its table: one strip, with scale and roll published", () => {
    const result = table({ basis: "linear", segments: 4, points: "[[0, 0, 0], [1, 0, 0, 2], [2, 0, 0, 1, 45]]" });
    expect(result.diagnostics ?? []).toEqual([]);
    const out = result.pointsets?.["out"];
    expect(out?.topology).toBe("strips:9x1");
    expect(Object.keys(out?.pairs ?? {}).sort()).toEqual(["position", "roll", "scale"]);
    const pass = result.passes[0] as Pass;
    // No upstream buffer at all: the control points are uniform members.
    expect(pass.buffers.map((entry) => entry.binding)).toEqual(["out_points"]);
    expect(pass.uniforms["c1"]).toEqual([1, 0, 0, 2]);
    expect(pass.uniforms["c2"]).toEqual([2, 0, 0, 1]);
    expect(pass.uniforms["r0"]).toEqual([0, 0, 45, 0]);
    expect(table({ basis: "linear", segments: 4, points: "[[0, 0, 0], [1, 0, 0], [2, 0, 0]]", closed: true }).pointsets?.["out"]?.topology).toBe("strips:12x1:closed");
  });

  /**
   * Moving a control point must not build a new program: a curve is dragged into shape, and
   * a pipeline per drag step is a stall. The points are uniform VALUES, so two tables of
   * one size share their pass id, their shader text and their buffers, and differ in the
   * values alone. A table of another size is another program, and says so in its id.
   */
  it("moving a control point changes uniform values and nothing else; adding one is another program", () => {
    const at = (points: string) => table({ basis: "catmullRom", segments: 4, points }).passes[0] as Pass;
    const before = at("[[0, 0, 0], [1, 2, 0], [3, 1, 0]]");
    const moved = at("[[0, 0, 0], [1, 2.5, 0.25], [3, 1, 0]]");
    expect(moved.shader).toBe(before.shader);
    expect(moved.id).toBe(before.id);
    expect(moved.buffers).toEqual(before.buffers);
    expect(moved.uniforms["c1"]).toEqual([1, 2.5, 0.25, 1]);
    expect(before.uniforms["c1"]).toEqual([1, 2, 0, 1]);
    const longer = at("[[0, 0, 0], [1, 2, 0], [3, 1, 0], [4, 0, 0]]");
    expect(longer.shader).not.toBe(before.shader);
    expect(longer.id).not.toBe(before.id);
  });

  it("with nothing stored it draws its default, a gentle S of four points", () => {
    const result = table();
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.pointsets?.["out"]?.topology).toBe("strips:49x1");
  });

  /**
   * What a CPU reader gets is what the node compiles from: the same points, the same
   * options, read by the same function. The Dawn test holds the GPU to `evaluateCurve` of
   * exactly this.
   */
  it("authoredCurve hands a CPU reader the points and options the node compiles from", () => {
    const parameters = { basis: "arc", segments: 4, arcLength: 3, bow: [0, 1, 0], maxTurn: 180, points: "[[0, 0, 0], [2, 0, 0]]" };
    const authored = authoredCurve(parameters);
    if ("error" in authored) throw new Error(authored.error);
    expect(authored.points.map((point) => point.position)).toEqual([[0, 0, 0], [2, 0, 0]]);
    expect(authored.options).toMatchObject({ closed: false, basis: "arc", segments: 4, arcLength: 3, arcLengthUnit: "metres", bow: [0, 1, 0] });
    expect(authored.options.maxTurn).toBeCloseTo(Math.PI, 12);
    const curve = evaluateCurve(authored.points.map((point) => point.position), authored.options);
    const pass = table(parameters).passes[0] as Pass;
    expect(curve).toHaveLength(Number(pass.uniforms["colsOut"]));
    const bad = authoredCurve({ points: "[[0, 0]]" });
    expect("error" in bad && bad.error).toContain("control point 0");
  });

  it("the full table of 64 compiles; one more is refused with the limit and the way round it", () => {
    const row = (count: number): string => JSON.stringify(Array.from({ length: count }, (_, i) => [i, Math.sin(i), 0]));
    const full = table({ basis: "catmullRom", segments: 2, points: row(CURVE_TABLE_LIMIT) });
    expect(full.diagnostics ?? []).toEqual([]);
    expect(Object.keys((full.passes[0] as Pass).uniforms)).toContain(`c${CURVE_TABLE_LIMIT - 1}`);
    const over = errorOf(table({ points: row(CURVE_TABLE_LIMIT + 1) }));
    expect(over.code).toBe("node.points.curve");
    expect(over.message).toContain(`${CURVE_TABLE_LIMIT + 1} control points`);
    expect(over.message).toContain("wire a longer control set");
  });
});

describe("Curve — refusals, each by name (§V288)", () => {
  it("a control edge with no strips (D10), a counted one, and a padded one", () => {
    const none = errorOf(wired("points"));
    expect(none.code).toBe("node.points.strips");
    expect(none.message).toContain("Curve follows each strip");
    expect(errorOf(wired("strips:6x5", {}, { count: { buffer: "scratch:kernel_control:counts" } })).message).toContain("GPU live count");
    const padded = fixturePairs("resample_upstream", [{ name: "position", type: "vec3f" }, { name: "live", type: "f32" }], 30);
    const refused = errorOf(wired("strips:6x5", {}, { pairs: padded }));
    expect(refused.message).toContain("carries live");
    expect(refused.suggestion).toContain("Resample it by Count");
  });

  it("a Bezier without both handles, naming them and what the control set does carry", () => {
    const refused = errorOf(wired("strips:6x5", { basis: "bezier" }));
    expect(refused.message).toContain('"handleIn" and "handleOut"');
    expect(refused.suggestion).toContain("position, radius, side, tag");
    // A table has no handles to give.
    expect(errorOf(table({ basis: "bezier" })).message).toContain("the table holds no Bezier handles");
  });

  it("an unclamped B-Spline with fewer than four control points, and more points than a pointset holds", () => {
    const three = fixturePairs("kernel_control", [{ name: "position", type: "vec3f" }], 30);
    const short = errorOf(wired("strips:3x10", { basis: "bspline", clamped: false }, { pairs: three }));
    expect(short.message).toContain("needs four control points");
    expect(short.suggestion).toContain("Clamped");
    // 100 strips of 99 spans at 1024 points a span are over ten million points.
    const many = fixturePairs("kernel_control", [{ name: "position", type: "vec3f" }], 10_000);
    const big = errorOf(wired("strips:100x100", { segments: 1024 }, { pairs: many, capacity: 10_000 }));
    expect(big.code).toBe("node.points.capacity");
    expect(big.suggestion).toContain("Segments");
  });

  it("a map it cannot honour: on another basis, on a table, or on a parameter that maps nothing", () => {
    expect(errorOf(wired("strips:6x5", { basis: "linear" }, { maps: { arcLength: { attribute: "radius" } } })).message).toContain('only the Arc ("arcLength" and "bow") and the Arc Chain ("arcLength" and "bend") map anything');
    expect(errorOf(wired("strips:6x5", { basis: "arc" }, { maps: { maxTurn: { attribute: "radius" } } })).message).toContain('an Arc maps only "arcLength" and "bow"');
    expect(errorOf(table({ basis: "arc" }, { bow: { attribute: "side" } })).message).toContain("no control pointset wired to map from");
    expect(errorOf(wired("strips:6x5", { basis: "arc" }, { maps: { bow: { attribute: "radius" } } })).message).toContain("bow needs a vec3f attribute");
    expect(errorOf(wired("strips:6x5", { basis: "arc" }, { maps: { bow: { attribute: "missing" } } })).suggestion).toContain("It provides:");
  });
});

/**
 * T1586b slice 8 — the Arc Chain at the fixture level: what it publishes, how its sections
 * reach the pass, and every sentence it refuses with. The points it writes are asserted on
 * Dawn in `point-curve.gpu.test.ts`.
 */
describe("Curve — the Arc Chain: a control point is a section (T1586b slice 8)", () => {
  const SECTIONS = fixturePairs(
    "kernel_control",
    [
      { name: "position", type: "vec3f" },
      { name: "reach", type: "f32" },
      { name: "curl", type: "vec2f" },
      { name: "orient", type: "vec4f" },
      { name: "side", type: "vec3f" },
      { name: "tag", type: "u32" },
    ],
    30,
  );
  const chain = (
    topology: string,
    parameters: Record<string, unknown> = {},
    maps?: Record<string, { attribute: string; channel?: string }>,
  ) => wired(topology, { basis: "arcChain", ...parameters }, { pairs: SECTIONS, ...(maps === undefined ? {} : { maps }) });

  it("makes Segments points per SECTION and one more to end on, and its strips are open", () => {
    const result = chain("strips:5x6", { segments: 4 });
    expect(result.diagnostics ?? []).toEqual([]);
    // Five sections of four points and the chain's end: 21 a strip. Not four spans, as five
    // control points to pass through would make.
    expect(result.pointsets?.["out"]?.topology).toBe("strips:21x6");
    expect(result.pointsets?.["out"]?.capacity).toBe(126);
    expect((result.passes[0] as Pass).uniforms).toMatchObject({ colsIn: 5, rows: 6, closed: 0, colsOut: 21, segments: 4, spans: 5 });
    // One section is a chain.
    const one = fixturePairs("kernel_control", [{ name: "position", type: "vec3f" }], 30);
    expect(wired("strips:1x30", { basis: "arcChain", segments: 8 }, { pairs: one }).pointsets?.["out"]?.topology).toBe("strips:9x30");
  });

  it("carries every attribute of its sections, the ones its lengths and bends are mapped from included", () => {
    const out = chain("strips:5x6", {}, { arcLength: { attribute: "reach" }, bend: { attribute: "curl" } }).pointsets?.["out"];
    expect(Object.keys(out?.pairs ?? {}).sort()).toEqual(["curl", "orient", "position", "reach", "side", "tag"]);
    for (const ref of Object.values(out?.pairs ?? {})) expect(ref.buffer).toBe(pointStorageId("curve_spine"));
  });

  it("Arc Length and Bend reach the pass as values, or per section from the control set when mapped", () => {
    const plain = chain("strips:5x6", { arcLength: 0.75, bend: [0.5, -2] }).passes[0] as Pass;
    expect(plain.uniforms["arcLength"]).toBe(0.75);
    expect(plain.uniforms["bend"]).toEqual([0.5, -2]);
    expect(plain.shader).toContain("params.bend");
    expect(plain.shader).not.toContain("controlBend");
    // No frame named: the chain leaves along +Z with +Y up.
    expect(plain.shader).toContain("var frame = vec4f(0.0, 0.0, 0.0, 1.0);");
    const mapped = chain("strips:5x6", { startOrient: "orient" }, { arcLength: { attribute: "reach" }, bend: { attribute: "curl" } }).passes[0] as Pass;
    expect(mapped.shader).toContain("controlArcLength(strip, section)");
    expect(mapped.shader).toContain("controlBend(strip, section)");
    expect(mapped.shader).toContain("var frame = controlStart(strip);");
    // The Arc's own knobs are not this basis's: no bow, no chord to measure against, no cap.
    for (const pass of [plain, mapped]) expect(Object.keys(pass.uniforms)).toEqual(["colsIn", "rows", "closed", "colsOut", "segments", "spans", "arcLength", "bend"]);
  });

  it("sets exactly the uniforms its shader declares, mapped or not", () => {
    for (const result of [chain("strips:5x6"), chain("strips:5x6", { startOrient: "orient" }, { arcLength: { attribute: "reach" }, bend: { attribute: "curl" } })]) {
      expect(result.diagnostics ?? []).toEqual([]);
      const pass = result.passes[0] as Pass;
      expect(declaredMembers(pass.shader)).toEqual(Object.keys(pass.uniforms));
    }
  });

  it("refuses what a chain cannot be: typed into the node, closed, or longer than its sections allow", () => {
    const typed = errorOf(table({ basis: "arcChain" }));
    expect(typed.code).toBe("node.points.curve");
    expect(typed.message).toContain("an Arc Chain is made of sections");
    expect(typed.message).toContain("map Arc Length and Bend");
    const closed = errorOf(chain("strips:5x6:closed"));
    expect(closed.message).toContain("nothing brings its end back to its start");
    expect(closed.suggestion).toContain("Wrap U");
    const long = errorOf(chain(`strips:${ARC_CHAIN_SECTIONS + 1}x1`));
    expect(long.message).toContain(`${ARC_CHAIN_SECTIONS + 1} points`);
    expect(long.message).toContain(`at most ${ARC_CHAIN_SECTIONS}`);
    expect(long.suggestion).toContain("Segments");
    // The limit is the number itself, not one below it.
    expect(chain(`strips:${ARC_CHAIN_SECTIONS}x1`).diagnostics ?? []).toEqual([]);
  });

  it("refuses a Start Frame it cannot read, by name, rather than leaving along +Z", () => {
    const missing = errorOf(chain("strips:5x6", { startOrient: "socket" }));
    expect(missing.message).toContain('the Start Frame reads attribute "socket"');
    expect(missing.suggestion).toContain("orient");
    expect(missing.suggestion).toContain("Clear Start Frame");
    expect(errorOf(chain("strips:5x6", { startOrient: "side" })).message).toContain("a frame is a vec4f quaternion");
    // Another basis never reads it, so a stale name cannot refuse a spline.
    expect(wired("strips:5x6", { basis: "linear", startOrient: "socket" }, { pairs: SECTIONS }).diagnostics ?? []).toEqual([]);
  });

  it("refuses a map it cannot honour: a bend that is not a vec2f, and each arc basis's knob on the other", () => {
    expect(errorOf(chain("strips:5x6", {}, { bend: { attribute: "reach" } })).message).toContain("bend needs a vec2f attribute");
    expect(errorOf(chain("strips:5x6", {}, { bend: { attribute: "missing" } })).suggestion).toContain("It provides:");
    expect(errorOf(chain("strips:5x6", {}, { bend: { attribute: "curl", channel: "x" } })).message).toContain("a channel belongs on a component");
    expect(errorOf(chain("strips:5x6", {}, { bow: { attribute: "side" } })).message).toContain('an Arc Chain maps only "arcLength" and "bend"');
    expect(errorOf(wired("strips:5x6", { basis: "arc" }, { pairs: SECTIONS, maps: { bend: { attribute: "curl" } } })).message).toContain('an Arc maps only "arcLength" and "bow"');
  });
});
