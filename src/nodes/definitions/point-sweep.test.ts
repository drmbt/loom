import { describe, expect, it } from "vitest";

import { pointStorageId } from "./point-storage.ts";
import { pointSweepNode, sweepAttributes } from "./point-sweep.ts";
import { compileContext, fixturePairs } from "./test-support.ts";

/**
 * Sweep at the fixture level (T1587b): what it publishes on the edge, how its pass is
 * bound, and every sentence it refuses with. The vertices it writes are asserted on Dawn in
 * `point-sweep.gpu.test.ts`, the pictures in `point-sweep-render.gpu.test.ts`; this file is
 * the contract around them.
 */

/** A path as a chain hands it over: the points from one producer, the frame and the metrics from Curve Frames. */
const PATH = {
  ...fixturePairs(
    "resample_path",
    [
      { name: "position", type: "vec3f" },
      { name: "width", type: "f32" },
      { name: "color", type: "vec4f" },
      { name: "serial", type: "u32" },
      { name: "live", type: "f32" },
    ],
    20,
  ),
  ...fixturePairs(
    "frames_path",
    [
      { name: "orient", type: "vec4f" },
      { name: "tangent", type: "vec3f" },
      { name: "normal", type: "vec3f" },
      { name: "binormal", type: "vec3f" },
      { name: "distance", type: "f32" },
      { name: "curveU", type: "f32" },
      { name: "curveLength", type: "f32" },
      { name: "curvature", type: "f32" },
    ],
    20,
  ),
};
const OUTLINE = fixturePairs("curve_outline", [{ name: "position", type: "vec3f" }], 6);

type Pairs = typeof PATH;
const without = (pairs: Pairs, ...names: string[]): Pairs => Object.fromEntries(Object.entries(pairs).filter(([name]) => !names.includes(name)));

const compile = (
  parameters: Record<string, unknown> = {},
  options: {
    topology?: string;
    pairs?: Pairs;
    capacity?: number;
    count?: { buffer: string };
    maps?: Record<string, { attribute: string; channel?: string; port?: string }>;
    outline?: { topology?: string; pairs?: Pairs; capacity?: number; count?: { buffer: string } } | false;
  } = {},
) =>
  pointSweepNode.compile(
    compileContext({
      nodeId: "sweep_skin",
      inputs: options.outline === undefined || options.outline === false ? ["points"] : ["points", "profile"],
      outputs: ["out"],
      pointsets: {
        points: {
          pairs: options.pairs ?? PATH,
          capacity: options.capacity ?? 20,
          topology: options.topology ?? "strips:20x1",
          ...(options.count === undefined ? {} : { count: options.count }),
        },
        ...(options.outline === undefined || options.outline === false
          ? {}
          : {
              profile: {
                pairs: options.outline.pairs ?? OUTLINE,
                capacity: options.outline.capacity ?? 6,
                topology: options.outline.topology ?? "strips:6x1",
                ...(options.outline.count === undefined ? {} : { count: options.outline.count }),
              },
            }),
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
const passOf = (result: ReturnType<typeof compile>): Pass => {
  expect(result.diagnostics ?? []).toEqual([]);
  expect(result.passes).toHaveLength(1);
  return result.passes[0] as unknown as Pass;
};
const claimOf = (parameters: Record<string, unknown>, options: Parameters<typeof compile>[1] = {}): string | undefined => {
  const result = compile(parameters, options);
  expect(result.diagnostics ?? []).toEqual([]);
  return result.pointsets?.["out"]?.topology;
};
const errorOf = (result: ReturnType<typeof compile>) => ({
  code: result.diagnostics?.[0]?.code,
  message: result.diagnostics?.[0]?.message ?? "",
  suggestion: result.diagnostics?.[0]?.suggestion ?? "",
  passes: result.passes.length,
});
/** The members of the shader's uniform struct, in order. */
const declared = (shader: string): string[] => {
  const body = /struct SweepParams \{([^}]*)\}/.exec(shader)?.[1] ?? "";
  return [...body.matchAll(/(\w+):/g)].map((match) => match[1] as string);
};

describe("Sweep — what it publishes (T1587b)", () => {
  it("claims a grid: columns round the profile, rows along the path", () => {
    // A Ring closes round, so its columns wrap; an open path's rows do not.
    expect(claimOf({ profile: "ring", sides: 12 })).toBe("grid:12x20:wrapU");
    // Flat sides are two columns each.
    expect(claimOf({ profile: "ring", sides: 12, smooth: false })).toBe("grid:24x20:wrapU");
    // A Square is four flat sides whatever Sides and Smooth say.
    expect(claimOf({ profile: "square", sides: 12, smooth: true })).toBe("grid:8x20:wrapU");
    // A Strip is open: Sides segments, one more point, no wrap.
    expect(claimOf({ profile: "strip", sides: 3 })).toBe("grid:4x20");
    expect(claimOf({ profile: "strip", sides: 3, smooth: false })).toBe("grid:4x20");
  });

  it("a Ring has at least three sides, a Strip at least one segment", () => {
    expect(claimOf({ profile: "ring", sides: 1 })).toBe("grid:3x20:wrapU");
    expect(claimOf({ profile: "strip", sides: 0 })).toBe("grid:2x20");
  });

  it("a closed path wraps the rows, and has no ends to cap", () => {
    expect(claimOf({ profile: "ring", sides: 12 }, { topology: "strips:20x1:closed" })).toBe("grid:12x20:wrapUV");
    expect(claimOf({ profile: "strip", sides: 3 }, { topology: "strips:20x1:closed" })).toBe("grid:4x20:wrapV");
    expect(claimOf({ profile: "ring", sides: 12, caps: "both" }, { topology: "strips:20x1:closed" })).toBe("grid:12x20:wrapUV");
  });

  it("a cap is two more rows at its end", () => {
    expect(claimOf({ profile: "ring", sides: 12, caps: "start" })).toBe("grid:12x22:wrapU");
    expect(claimOf({ profile: "ring", sides: 12, caps: "end" })).toBe("grid:12x22:wrapU");
    expect(claimOf({ profile: "ring", sides: 12, caps: "both" })).toBe("grid:12x24:wrapU");
    expect(passOf(compile({ caps: "start" })).uniforms).toMatchObject({ rows: 22, pathPoints: 20, startRows: 2 });
    expect(passOf(compile({ caps: "end" })).uniforms).toMatchObject({ rows: 22, pathPoints: 20, startRows: 0 });
  });

  it("a custom outline brings its own points, and closes when its strip does", () => {
    expect(claimOf({ profile: "custom" }, { outline: {} })).toBe("grid:6x20");
    expect(claimOf({ profile: "custom" }, { outline: { topology: "strips:6x1:closed" } })).toBe("grid:6x20:wrapU");
    // Flat: two columns a side, five sides open and six closed.
    expect(claimOf({ profile: "custom", smooth: false }, { outline: {} })).toBe("grid:10x20");
    expect(claimOf({ profile: "custom", smooth: false }, { outline: { topology: "strips:6x1:closed" } })).toBe("grid:12x20:wrapU");
    // Only its FIRST strip is the outline.
    expect(claimOf({ profile: "custom" }, { outline: { topology: "strips:3x2" } })).toBe("grid:3x20");
  });

  it("a grid's one row is a path too", () => {
    expect(claimOf({ profile: "ring", sides: 12 }, { topology: "grid:20x1" })).toBe("grid:12x20:wrapU");
  });

  it("owns every attribute of its output: position, normal and uv, then the path's own by name", () => {
    const out = compile({ profile: "ring", sides: 12 }).pointsets?.["out"];
    expect(out?.capacity).toBe(240);
    // The frame it was placed by is not the surface's: orient, tangent and binormal stay behind,
    // and `normal` is the sweep's own, not the curve's.
    expect(Object.keys(out?.pairs ?? {})).toEqual(["position", "normal", "uv", "color", "curvature", "curveLength", "curveU", "distance", "live", "serial", "width"]);
    for (const ref of Object.values(out?.pairs ?? {})) expect(ref.buffer).toBe(pointStorageId("sweep_skin"));
    expect(out?.pairs["normal"]?.type).toBe("vec3f");
    expect(out?.pairs["uv"]?.type).toBe("vec2f");
    expect(out?.pairs["serial"]?.type).toBe("u32");
    expect(out?.count).toBeUndefined();
    expect(
      sweepAttributes([
        { name: "width", type: "f32" },
        { name: "uv", type: "vec3f" },
        { name: "orient", type: "vec4f" },
        { name: "position", type: "vec3f" },
        { name: "color", type: "vec4f" },
      ]).map((entry) => `${entry.name}:${entry.type}`),
    ).toEqual(["position:vec3f", "normal:vec3f", "uv:vec2f", "color:vec4f", "width:f32"]);
  });
});

describe("Sweep — its pass (T1587b)", () => {
  it("is one dispatch over every vertex, binding each producer of the path once", () => {
    const pass = passOf(compile({ profile: "ring", sides: 12, radius: 0.5 }));
    expect(pass.workgroups).toEqual([Math.ceil(240 / 64), 1, 1]);
    // Two producers behind the path (its points, its frame), whole and read by offset (T1076).
    expect(pass.buffers.map((entry) => entry.binding)).toEqual(["pk_0", "pk_1", "out_points"]);
    expect(pass.buffers.map((entry) => entry.resourceId)).toEqual([pointStorageId("resample_path"), pointStorageId("frames_path"), pointStorageId("sweep_skin")]);
    for (const entry of pass.buffers) expect(entry.offset).toBeUndefined();
    expect(pass.buffers[2]?.half).toBe("write");
    expect(pass.uniforms).toEqual({ cols: 12, rows: 20, pathPoints: 20, profilePoints: 12, startRows: 0, radius: 0.5 });
  });

  it("a custom outline is one more producer", () => {
    const pass = passOf(compile({ profile: "custom" }, { outline: {} }));
    expect(pass.buffers.map((entry) => entry.resourceId)).toEqual([
      pointStorageId("resample_path"),
      pointStorageId("frames_path"),
      pointStorageId("curve_outline"),
      pointStorageId("sweep_skin"),
    ]);
    expect(pass.uniforms).toMatchObject({ cols: 6, profilePoints: 6 });
  });

  it("sets exactly the uniforms its shader declares, in every shape of the program", () => {
    const shapes: Array<[Record<string, unknown>, Parameters<typeof compile>[1]]> = [
      [{ profile: "ring" }, {}],
      [{ profile: "ring", smooth: false, facing: "inward", uvAlong: "metres", uvLength: 2 }, {}],
      [{ profile: "square", caps: "both", uvAlong: "stretch" }, {}],
      [{ profile: "strip", uvAlong: "points", caps: "end" }, {}],
      [{ profile: "custom", uvAlong: "metres" }, { outline: {}, topology: "strips:20x1:closed" }],
      [{ profile: "custom", smooth: false, facing: "inward" }, { outline: { topology: "strips:6x1:closed" }, maps: { radius: { attribute: "width" } } }],
    ];
    for (const [parameters, options] of shapes) {
      const pass = passOf(compile(parameters, options));
      expect(Object.keys(pass.uniforms), JSON.stringify(parameters)).toEqual(declared(pass.shader));
    }
    // Only Metres has a tile length to set.
    expect(declared(passOf(compile({ uvAlong: "metres", uvLength: 2 })).shader)).toContain("uvLength");
    expect(passOf(compile({ uvAlong: "metres", uvLength: 2 })).uniforms["uvLength"]).toBe(2);
    expect(declared(passOf(compile({ uvAlong: "stretch", uvLength: 2 })).shader)).not.toContain("uvLength");
  });

  it("reads from the path only what the coordinate along needs", () => {
    const reads = (parameters: Record<string, unknown>, options: Parameters<typeof compile>[1] = {}): string[] =>
      ["pathDistance", "pathCurveU", "pathCurveLength"].filter((name) => passOf(compile(parameters, options)).shader.includes(`fn ${name}(`));
    expect(reads({ uvAlong: "points", caps: "both" })).toEqual([]);
    expect(reads({ uvAlong: "stretch" })).toEqual(["pathCurveU"]);
    // A cap's centre is a radius further along, as a share of the length.
    expect(reads({ uvAlong: "stretch", caps: "end" })).toEqual(["pathCurveU", "pathCurveLength"]);
    expect(reads({ uvAlong: "metres", caps: "both" })).toEqual(["pathDistance"]);
    // A loop rounds its tiles to a whole number of its length.
    expect(reads({ uvAlong: "metres" }, { topology: "strips:20x1:closed" })).toEqual(["pathDistance", "pathCurveLength"]);
  });

  it("a mapped radius multiplies: the pass keeps the authored one and reads the attribute beside it", () => {
    const mapped = passOf(compile({ radius: 0.25 }, { maps: { radius: { attribute: "width" } } }));
    expect(mapped.uniforms["radius"]).toBe(0.25);
    expect(mapped.shader).toContain("params.radius * pathScale(point)");
    expect(passOf(compile({ radius: 0.25 })).shader).not.toContain("pathScale");
    // One channel of a float vector serves as well.
    expect(passOf(compile({}, { maps: { radius: { attribute: "color", channel: "y" } } })).shader).toContain("fn pathScale(");
  });

  it("a negative radius is no radius", () => {
    expect(passOf(compile({ radius: -1 })).uniforms["radius"]).toBe(0);
  });

  it("names its pass by what a person would look for in a plan", () => {
    expect(passOf(compile({ profile: "ring", sides: 12 })).id).toBe("sweep_skin:sweep:ring:stretch:12x20");
    expect(
      passOf(compile({ profile: "ring", sides: 12, smooth: false, facing: "inward", uvAlong: "metres", caps: "end" }, { maps: { radius: { attribute: "width" } } })).id,
    ).toBe("sweep_skin:sweep:ring:flat:inward:metres:caps02:radius:24x22");
  });
});

describe("Sweep — what it refuses, by name (T1587b)", () => {
  it("a path that is not strips", () => {
    const refused = errorOf(compile({}, { topology: "points" }));
    expect(refused.code).toBe("node.points.strips");
    expect(refused.message).toContain("Sweep follows each strip of a pointset in slot order");
    expect(refused.passes).toBe(0);
  });

  it("several strips, until the grid claim has sheets", () => {
    const refused = errorOf(compile({}, { topology: "strips:5x4" }));
    expect(refused.code).toBe("node.points.sweep");
    expect(refused.message).toBe(
      'Node "sweep_skin": the path edge carries 4 strips, and a Sweep makes one sheet: in one grid the end of each tube would be joined to the start of the next.',
    );
    expect(refused.suggestion).toContain("§T1587b, slice 2");
    expect(refused.passes).toBe(0);
    // The same for a grid's rows: they are strips.
    expect(errorOf(compile({}, { topology: "grid:5x4" })).message).toContain("carries 4 strips");
  });

  it("a path of one point", () => {
    expect(errorOf(compile({}, { topology: "strips:1x1" })).message).toBe('Node "sweep_skin": the path has one point, and a sweep needs two to have a length.');
  });

  it("a path with a GPU live count", () => {
    const refused = errorOf(compile({}, { count: { buffer: "count:kernel_source" } }));
    expect(refused.message).toContain("the path carries a GPU live count");
    expect(refused.passes).toBe(0);
  });

  it("a path with no frame, or one that is not a quaternion", () => {
    const missing = errorOf(compile({}, { pairs: without(PATH, "orient") }));
    expect(missing.message).toBe('Node "sweep_skin": the path carries no "orient", the frame the profile is placed in at each point.');
    expect(missing.suggestion).toContain("Put a Curve Frames before the Sweep with Frame on.");
    const wrong = errorOf(compile({}, { pairs: { ...PATH, orient: PATH["tangent"]! } }));
    expect(wrong.message).toBe('Node "sweep_skin": the path\'s "orient" is vec3f; a frame is a vec4f quaternion.');
  });

  it("a coordinate along whose measurement the path does not carry", () => {
    const stretch = errorOf(compile({ uvAlong: "stretch" }, { pairs: without(PATH, "curveU") }));
    expect(stretch.message).toBe('Node "sweep_skin": UV Along is Stretch, which reads the path\'s "curveU", and the path does not carry it.');
    expect(stretch.suggestion).toContain("Turn Metrics on on the Curve Frames before the Sweep, or set UV Along to Points.");
    expect(errorOf(compile({ uvAlong: "metres" }, { pairs: without(PATH, "distance") })).message).toContain('reads the path\'s "distance"');
    // Each is needed only where it is read: a capped Stretch and a closed Metres read the length.
    const noLength = without(PATH, "curveLength");
    expect(compile({ uvAlong: "stretch" }, { pairs: noLength }).diagnostics ?? []).toEqual([]);
    expect(errorOf(compile({ uvAlong: "stretch", caps: "end" }, { pairs: noLength })).message).toContain('reads the path\'s "curveLength"');
    expect(compile({ uvAlong: "metres", caps: "end" }, { pairs: noLength }).diagnostics ?? []).toEqual([]);
    expect(errorOf(compile({ uvAlong: "metres" }, { pairs: noLength, topology: "strips:20x1:closed" })).message).toContain('reads the path\'s "curveLength"');
    // Points reads none of them.
    expect(compile({ uvAlong: "points", caps: "both" }, { pairs: without(PATH, "distance", "curveU", "curveLength") }).diagnostics ?? []).toEqual([]);
    // And a measurement of the wrong type is not read as one.
    expect(errorOf(compile({ uvAlong: "metres" }, { pairs: { ...PATH, distance: PATH["tangent"]! } })).message).toContain("as an f32; it is vec3f");
  });

  it("a Custom profile with nothing usable wired", () => {
    expect(errorOf(compile({ profile: "custom" })).message).toBe('Node "sweep_skin": Profile is Custom and nothing is wired to the Profile input.');
    const cloud = errorOf(compile({ profile: "custom" }, { outline: { topology: "points" } }));
    expect(cloud.code).toBe("node.points.strips");
    expect(cloud.message).toContain("A Sweep's Profile follows each strip");
    expect(errorOf(compile({ profile: "custom" }, { outline: { topology: "strips:1x6" } })).message).toContain("the Profile's strip has one point");
    expect(errorOf(compile({ profile: "custom" }, { outline: { count: { buffer: "count:kernel_outline" } } })).message).toContain("the Profile carries a GPU live count");
    // A wired Profile is not read, and not judged, while the profile is one of the node's own.
    expect(compile({ profile: "ring" }, { outline: { topology: "points" } }).diagnostics ?? []).toEqual([]);
  });

  it("more vertices than a pointset holds", () => {
    const long = fixturePairs("resample_path", [{ name: "position", type: "vec3f" }, { name: "orient", type: "vec4f" }], 2000);
    const refused = errorOf(compile({ profile: "ring", sides: 1024, uvAlong: "points" }, { pairs: long, capacity: 2000, topology: "strips:2000x1" }));
    expect(refused.code).toBe("node.points.capacity");
    expect(refused.message).toBe(
      'Node "sweep_skin": 1024 columns round the profile by 2000 rows along the path are 2048000 vertices, over the 1000000 a pointset holds.',
    );
    expect(refused.suggestion).toContain("Lower Sides");
  });

  it("a map it cannot honour", () => {
    const refused = errorOf(compile({}, { maps: { uvLength: { attribute: "width" }, sides: { attribute: "width" } } }));
    expect(refused.code).toBe("node.parameter.map");
    expect(refused.message).toBe('Node "sweep_skin": sides, uvLength are in map mode, but a Sweep maps only "radius".');
    // And a radius mapped from something that is not a number per point.
    expect(errorOf(compile({}, { maps: { radius: { attribute: "serial" } } })).code).toBe("node.parameter.map");
    expect(errorOf(compile({}, { maps: { radius: { attribute: "nowhere" } } })).message).toContain('radius maps attribute "nowhere"');
    // A Map reads the path. One that names the profile is not quietly read from the path instead.
    const onProfile = errorOf(compile({ profile: "custom" }, { outline: {}, maps: { radius: { attribute: "position", channel: "x", port: "profile" } } }));
    expect(onProfile.code).toBe("node.parameter.map");
    expect(onProfile.message).toBe(
      'Node "sweep_skin": radius maps port "profile", but a Map reads a value per ring and those are on the Path input; Profile is the outline every ring is made from.',
    );
    expect(compile({}, { maps: { radius: { attribute: "width", port: "points" } } }).diagnostics ?? []).toEqual([]);
  });

  it("more producers behind the path than a pass can bind", () => {
    /* Eight attributes from eight producers, and the node's own buffer makes nine. */
    const scattered: Pairs = {
      ...fixturePairs("kernel_a", [{ name: "position", type: "vec3f" }], 20),
      ...fixturePairs("frames_path", [{ name: "orient", type: "vec4f" }], 20),
      ...Object.fromEntries(["c", "d", "e", "f", "g", "h"].flatMap((letter) => Object.entries(fixturePairs(`kernel_${letter}`, [{ name: `tag_${letter}`, type: "f32" }], 20)))),
    };
    const refused = errorOf(compile({ uvAlong: "points" }, { pairs: scattered }));
    expect(refused.message).toBe(
      'Node "sweep_skin": the path\'s attributes and the profile come from 8 producers, and a pass binds 8 buffers with this node\'s own (§V588).',
    );
    // One fewer fits.
    expect(compile({ uvAlong: "points" }, { pairs: without(scattered, "tag_h") }).diagnostics ?? []).toEqual([]);
  });
});

describe("Sweep — which parameters apply (T1587b)", () => {
  const inactive = (key: string, values: Record<string, unknown>): string | null =>
    (pointSweepNode.parameters[key] as { inactiveWhen?: (values: Record<string, unknown>) => string | null }).inactiveWhen?.(values) ?? null;

  it("Sides is the Ring's and the Strip's; Smooth the Ring's and a Custom outline's", () => {
    expect(inactive("sides", { profile: "ring" })).toBeNull();
    expect(inactive("sides", { profile: "strip" })).toBeNull();
    expect(inactive("sides", { profile: "square" })).toBe("A Square has four sides.");
    expect(inactive("sides", { profile: "custom" })).toBe("A Custom profile has the sides its points make.");
    expect(inactive("smooth", { profile: "ring" })).toBeNull();
    expect(inactive("smooth", { profile: "custom" })).toBeNull();
    expect(inactive("smooth", { profile: "square" })).toBe("A Square's sides are always flat.");
    expect(inactive("smooth", { profile: "strip" })).toBe("A Strip is one flat side.");
  });

  it("Tile Length is read by Metres alone", () => {
    expect(inactive("uvLength", { uvAlong: "metres" })).toBeNull();
    expect(inactive("uvLength", { uvAlong: "stretch" })).toBe("Only Metres reads a tile length.");
    expect(inactive("uvLength", { uvAlong: "points" })).toBe("Only Metres reads a tile length.");
  });
});
