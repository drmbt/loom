import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../domain/types/graph.ts";
import { renderPassRuns } from "../../runtime/backend/plan.ts";
import { curveEdge, curveGraph, curveNode, compileCurveGraph, mappedTo, type ReadPort } from "./curve-test-support.ts";
import { planFingerprint } from "./test-support.ts";

/**
 * T1587b slice 2 — A GRID OF SEVERAL SHEETS, at the plan level: what every reader of a grid
 * claim draws for it, and that a grid of ONE sheet draws what it always did.
 *
 * ⚑ THE ONE-SHEET PROGRAMS ARE PINNED BY THEIR TEXT. A sheet is read off the vertex index
 * in a variant of the grid chunks that only a claim of more than one sheet emits. Two shader
 * programs can round one expression differently, so the way to keep every shipped grid's
 * picture is to keep its program, to the byte — and the fingerprints below were recorded
 * from main BEFORE the variant existed (692f5024). A change to one of them is a change to
 * what every grid Surface computes: make it on purpose, never to get this green.
 *
 * What the sheets draw is asserted on Dawn in `point-sweep-sheets.gpu.test.ts`.
 */

type Pass = { id: string; kind: string; nodeId?: string; shader?: string; vertexCount?: number; instances?: unknown; buffers?: Array<{ binding: string }>; uniforms?: Record<string, unknown> };

const COLOR_GRID = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(f32(ctx.index % 4u), f32(ctx.index / 4u), 0.0);
  q.color = vec4f(1.0, 0.5, 0.25, 1.0);
  return q;
}`;
const COLOR_SCHEMA = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "color", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
]);
const PLAIN_SURFACE = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  return surfaceDefaults(s);
}`;

interface Scene {
  /** The nodes that end in the pointset the Geometry draws, and that pointset's node. */
  readonly points: ReadonlyArray<GraphNode>;
  readonly edges?: ReadonlyArray<ReturnType<typeof curveEdge>>;
  readonly last: string;
  readonly material?: GraphNode;
  readonly geometry?: Record<string, unknown>;
  readonly light?: Record<string, unknown>;
  readonly render?: Record<string, unknown>;
  readonly ports?: ReadonlyArray<string>;
}

/** points → geometry_skin (Surface) → render_shot → output, compiled; the Render's own passes. */
function renderPasses(scene: Scene): Pass[] {
  const ports: ReadPort[] = (scene.ports ?? []).map((portId) => ({ nodeId: "render_shot", portId }));
  const plan = compileCurveGraph(
    curveGraph(
      [
        ...scene.points,
        ...(scene.material === undefined ? [] : [scene.material]),
        curveNode("geometry_skin", "geometry", { mode: "surface", ...(scene.material === undefined ? {} : { material: scene.material.id }), ...scene.geometry }),
        curveNode("camera_main", "camera", { eye: [0, 0, 5], lookAt: [0, 0, 0] }),
        curveNode("light_key", "light", { kind: "directional", direction: [0, -1, -1], ...scene.light }),
        curveNode("render_shot", "render", { scenes: "geometry_skin", camera: "camera_main", lights: "light_key", ...scene.render }),
        curveNode("output_probe", "output"),
      ],
      [...(scene.edges ?? []), curveEdge([scene.last, "out"], ["geometry_skin", "points"]), curveEdge(["render_shot", "out"], ["output_probe", "input"])],
    ),
    16,
    ports,
  );
  expect(plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  return (plan.passes as unknown as Pass[]).filter((pass) => pass.nodeId === "render_shot");
}

/** The synthesized draws of a Geometry's own preview tile: they ride its output row, not the plan (T563). */
function tilePasses(scene: Pick<Scene, "points" | "edges" | "last">): Pass[] {
  const plan = compileCurveGraph(
    curveGraph(
      [
        ...scene.points,
        curveNode("geometry_skin", "geometry", { mode: "surface" }),
        curveNode("camera_main", "camera", {}),
        curveNode("light_key", "light", {}),
        curveNode("render_shot", "render", { scenes: "geometry_skin", camera: "camera_main", lights: "light_key" }),
        curveNode("output_probe", "output"),
      ],
      [...(scene.edges ?? []), curveEdge([scene.last, "out"], ["geometry_skin", "points"]), curveEdge(["render_shot", "out"], ["output_probe", "input"])],
    ),
    16,
    [{ nodeId: "geometry_skin", portId: "out" }],
  );
  expect(plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  return plan.outputs.flatMap((row) => ((row as { synthesis?: { passes: ReadonlyArray<unknown> } }).synthesis?.passes ?? []) as Pass[]);
}

/** points → Render Surface → output: the older single-surface renderer's one draw. */
function surfacePasses(scene: Pick<Scene, "points" | "edges" | "last">): Array<{ id: string; shader: string; vertexCount: number }> {
  const plan = compileCurveGraph(
    curveGraph(
      [...scene.points, curveNode("surface_skin", "renderSurface"), curveNode("output_probe", "output")],
      [...(scene.edges ?? []), curveEdge([scene.last, "out"], ["surface_skin", "points"]), curveEdge(["surface_skin", "out"], ["output_probe", "input"])],
    ),
  );
  expect(plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  return (plan.passes as unknown as Pass[])
    .filter((pass) => pass.nodeId === "surface_skin" && pass.kind === "draw")
    .map((pass) => ({ id: pass.id, shader: String(pass.shader), vertexCount: pass.vertexCount as number }));
}

/** Every draw of the grid geometry: what a program is, and how much of it is drawn. */
const drawsOf = (passes: ReadonlyArray<Pass>): Array<{ id: string; shader: string; vertexCount: number; buffers: string[] }> =>
  passes
    .filter((pass) => pass.kind === "draw" && pass.uniforms !== undefined && "grid" in pass.uniforms)
    .map((pass) => ({ id: pass.id, shader: String(pass.shader), vertexCount: pass.vertexCount as number, buffers: (pass.buffers ?? []).map((entry) => entry.binding) }));

const grid = (parameters: Record<string, unknown>): Pick<Scene, "points" | "last"> => ({ points: [curveNode("grid_sheet", "pointGrid", parameters)], last: "grid_sheet" });
const tube = (parameters: Record<string, unknown>): Pick<Scene, "points" | "last"> => ({ points: [curveNode("tube_pipe", "pointTube", parameters)], last: "tube_pipe" });
const coloured: Pick<Scene, "points" | "edges" | "last"> = {
  points: [
    curveNode("kernel_colour", "pointKernel", { capacity: 12, seed: 7, attributes: COLOR_SCHEMA, kernel: COLOR_GRID }),
    curveNode("topology_colour", "pointTopology", { connectivity: "grid", cols: 4, rows: 3 }),
  ],
  edges: [curveEdge(["kernel_colour", "out"], ["topology_colour", "points"])],
  last: "topology_colour",
};

/** The one-sheet scenes whose programs are pinned: between them, every variant of the two grid chunks. */
const ONE_SHEET: ReadonlyArray<readonly [name: string, fingerprint: string, scene: Scene]> = [
  ["a lit grid, the default material", "17aa8172c9cd86ab", { ...grid({ cols: 8, rows: 6, count: 48 }) }],
  [
    "a Phong tube under a casting sun, with every output and occlusion on",
    "084b26c7e1c920d6",
    {
      ...tube({ cols: 12, rows: 5, count: 60 }),
      material: curveNode("material_skin", "materialPhong", {}),
      light: { shadows: true, shadowExtent: 4 },
      render: { depthOutput: true, normalOutput: true, albedoOutput: true, shadowOutput: true, lightDepthOutput: true, ambientOcclusion: true },
      ports: ["depth", "normal", "albedo", "shadow", "lightDepth"],
    },
  ],
  [
    "a PBR grid under a casting point light: the cube faces",
    "3c4d939cf8e327d2",
    { ...grid({ cols: 8, rows: 6, count: 48 }), material: curveNode("material_skin", "materialPbr", {}), light: { kind: "point", position: [0, 2, 2], shadows: true, shadowExtent: 8 } },
  ],
  ["a tinted grid: its colour attribute mapped to Tint", "baf033f83810f42d", { ...coloured, geometry: { tint: mappedTo("color", [1, 1, 1, 1]) } }],
  ["an unlit grid", "27985030733ae1ad", { ...grid({ cols: 8, rows: 6, count: 48 }), material: curveNode("material_skin", "materialUnlit", {}) }],
  ["a glass grid", "efbe423f4bad37c6", { ...grid({ cols: 8, rows: 6, count: 48 }), material: curveNode("material_skin", "materialGlass", {}) }],
  [
    "a Material · WGSL on a wrapped tube, with the Normal output",
    "23412397756ed469",
    {
      ...tube({ cols: 12, rows: 5, count: 60 }),
      material: curveNode("material_skin", "materialWgsl", { model: "pbr", source: PLAIN_SURFACE }),
      render: { normalOutput: true },
      ports: ["normal"],
    },
  ],
];

describe("a grid of one sheet keeps its programs, to the byte (T1587b slice 2)", () => {
  for (const [name, fingerprint, scene] of ONE_SHEET) {
    it(name, () => {
      const draws = drawsOf(renderPasses(scene));
      expect(draws.length).toBeGreaterThan(0);
      expect(planFingerprint({ passes: draws })).toBe(fingerprint);
    });
  }

  it("the preview tile of a grid Geometry", () => {
    const draws = drawsOf(tilePasses(grid({ cols: 8, rows: 6, count: 48 })));
    expect(draws).toHaveLength(1);
    expect(planFingerprint({ passes: draws })).toBe("1889b8f93f6f1f82");
  });

  it("Render Surface", () => {
    const draws = surfacePasses(grid({ cols: 8, rows: 6, count: 48 }));
    expect(draws).toHaveLength(1);
    expect(planFingerprint({ passes: draws })).toBe("d63733260d66381a");
  });
});

/**
 * A claim of several sheets: the same passes, each ONE draw of every sheet's cells, by the
 * variant of its program that reads the sheet off the vertex index.
 */
describe("a grid of several sheets is one draw in every pass that draws it (T1587b slice 2)", () => {
  /* Twelve points a sheet (4 × 3), five sheets: sixty points. One sheet has 3 × 2 cells, 36 vertices. */
  const sheeted = (sheets: number, wraps: Record<string, unknown> = {}): Pick<Scene, "points" | "edges" | "last"> => ({
    points: [
      curveNode("kernel_colour", "pointKernel", { capacity: 12 * sheets, seed: 7, attributes: COLOR_SCHEMA, kernel: COLOR_GRID }),
      curveNode("topology_colour", "pointTopology", { connectivity: "grid", cols: 4, rows: 3, sheets, ...wraps }),
    ],
    edges: [curveEdge(["kernel_colour", "out"], ["topology_colour", "points"])],
    last: "topology_colour",
  });
  const everything: Pick<Scene, "material" | "light" | "render" | "ports"> = {
    material: curveNode("material_skin", "materialPhong", {}),
    light: { shadows: true, shadowExtent: 4 },
    render: { depthOutput: true, normalOutput: true, albedoOutput: true, shadowOutput: true, lightDepthOutput: true, ambientOcclusion: true },
    ports: ["depth", "normal", "albedo", "shadow", "lightDepth"],
  };

  it("every draw of it is sheets × cells × 6 vertices: lit, each G-buffer layer, the depth sweeps and the shadow", () => {
    const one = drawsOf(renderPasses({ ...sheeted(1), ...everything }));
    const five = drawsOf(renderPasses({ ...sheeted(5), ...everything }));
    // The same passes, in the same order: a sheet adds none.
    expect(five.map((draw) => draw.id)).toEqual(one.map((draw) => draw.id));
    expect(one.length).toBeGreaterThanOrEqual(7);
    for (const draw of one) expect(draw.vertexCount, draw.id).toBe(3 * 2 * 6);
    for (const draw of five) expect(draw.vertexCount, draw.id).toBe(5 * 3 * 2 * 6);
    // Each is the variant that knows its sheet, and one sheet's program never mentions one.
    for (const draw of five) expect(draw.shader, draw.id).toContain("gridSheet = quad / sheetCells;");
    for (const draw of one) expect(draw.shader, draw.id).not.toContain("gridSheet");
    // The bindings are the one-sheet draw's: a sheet is arithmetic, not a buffer.
    expect(five.map((draw) => draw.buffers)).toEqual(one.map((draw) => draw.buffers));
  });

  it("a wrapped sheet has its seam cells, in every sheet", () => {
    const tubeCells = drawsOf(renderPasses({ ...sheeted(5, { wrapU: true }) }));
    for (const draw of tubeCells) expect(draw.vertexCount, draw.id).toBe(5 * 4 * 2 * 6);
    const torusCells = drawsOf(renderPasses({ ...sheeted(5, { wrapU: true, wrapV: true }) }));
    for (const draw of torusCells) expect(draw.vertexCount, draw.id).toBe(5 * 4 * 3 * 6);
  });

  it("a point light's six faces, a tinted surface, glass and a Material · WGSL each draw every sheet", () => {
    const cases: ReadonlyArray<readonly [string, Scene]> = [
      ["a casting point light", { ...sheeted(5), light: { kind: "point", position: [0, 2, 2], shadows: true, shadowExtent: 8 } }],
      ["a tint", { ...sheeted(5), geometry: { tint: mappedTo("color", [1, 1, 1, 1]) } }],
      ["glass", { ...sheeted(5), material: curveNode("material_skin", "materialGlass", {}) }],
      ["a Material · WGSL", { ...sheeted(5), material: curveNode("material_skin", "materialWgsl", { model: "pbr", source: PLAIN_SURFACE }), render: { normalOutput: true }, ports: ["normal"] }],
    ];
    for (const [name, scene] of cases) {
      const draws = drawsOf(renderPasses(scene));
      expect(draws.length, name).toBeGreaterThan(0);
      for (const draw of draws) {
        expect(draw.vertexCount, `${name}: ${draw.id}`).toBe(5 * 3 * 2 * 6);
        expect(draw.shader, `${name}: ${draw.id}`).toContain("gridSheet");
      }
    }
    // A tint is read at the vertex's own slot, in its own sheet.
    const tinted = drawsOf(renderPasses({ ...sheeted(5), geometry: { tint: mappedTo("color", [1, 1, 1, 1]) } })).find((draw) => draw.buffers.includes("pointColors"));
    expect(tinted?.shader).toContain("pointColors[(gridSheet * rows + select(gy, gy % rows, wrapV)) * cols + select(gx, gx % cols, wrapU)]");
  });

  it("the preview tile and Render Surface draw every sheet too", () => {
    const tile = drawsOf(tilePasses(sheeted(5)));
    expect(tile).toHaveLength(1);
    expect(tile[0]!.vertexCount).toBe(5 * 3 * 2 * 6);
    expect(tile[0]!.shader).toContain("gridSheet");
    const surface = surfacePasses(sheeted(5));
    expect(surface).toHaveLength(1);
    expect(surface[0]!.vertexCount).toBe(5 * 3 * 2 * 6);
    expect(surface[0]!.shader).toContain("gridSheet = quad / sheetCells;");
    expect(surfacePasses(sheeted(1))[0]!.shader).not.toContain("gridSheet");
  });

  it("a claim that addresses more points than the edge carries is refused, counting every sheet", () => {
    const plan = compileCurveGraph(
      curveGraph(
        [
          curveNode("kernel_colour", "pointKernel", { capacity: 48, seed: 7, attributes: COLOR_SCHEMA, kernel: COLOR_GRID }),
          curveNode("topology_colour", "pointTopology", { connectivity: "grid", cols: 4, rows: 3, sheets: 5 }),
          curveNode("geometry_skin", "geometry", { mode: "surface" }),
          curveNode("camera_main", "camera", {}),
          curveNode("render_shot", "render", { scenes: "geometry_skin", camera: "camera_main" }),
          curveNode("output_probe", "output"),
        ],
        [curveEdge(["kernel_colour", "out"], ["topology_colour", "points"]), curveEdge(["topology_colour", "out"], ["geometry_skin", "points"]), curveEdge(["render_shot", "out"], ["output_probe", "input"])],
      ),
    );
    const errors = plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message);
    expect(errors.join(" | ")).toContain('topology "grid:4x3x5" addresses 60 points but the edge carries 48');
  });
});

/**
 * T1604b: a node's consecutive draws into one target are ONE device render pass. A sheeted
 * Geometry is one draw wherever a one-sheet Geometry is, so it forms the runs that one
 * does; ten Geometries are ten draws in each of those runs, and a device pass each where
 * the target is multisampled.
 */
describe("sheets and device render passes (T1587b slice 2, T1604b)", () => {
  /** A scene of `geometries` Geometries, each drawing a grid of `sheets` sheets. */
  const sceneOf = (geometries: number, sheets: number, render: Record<string, unknown> = {}) => {
    const names = Array.from({ length: geometries }, (_, k) => `geometry_skin_${k}`);
    return compileCurveGraph(
      curveGraph(
        [
          ...names.flatMap((name, k) => [
            curveNode(`kernel_colour_${k}`, "pointKernel", { capacity: 12 * sheets, seed: 7, attributes: COLOR_SCHEMA, kernel: COLOR_GRID }),
            curveNode(`topology_colour_${k}`, "pointTopology", { connectivity: "grid", cols: 4, rows: 3, sheets }),
            curveNode(name, "geometry", { mode: "surface" }),
          ]),
          curveNode("camera_main", "camera", {}),
          curveNode("light_key", "light", { kind: "point", position: [0, 2, 2], shadows: true, shadowExtent: 8 }),
          curveNode("render_shot", "render", { scenes: names.join(" "), camera: "camera_main", lights: "light_key", depthOutput: true, normalOutput: true, ...render }),
          curveNode("output_probe", "output"),
        ],
        [
          ...names.flatMap((name, k) => [curveEdge([`kernel_colour_${k}`, "out"], [`topology_colour_${k}`, "points"]), curveEdge([`topology_colour_${k}`, "out"], [name, "points"])]),
          curveEdge(["render_shot", "out"], ["output_probe", "input"]),
        ],
      ),
      16,
      [
        { nodeId: "render_shot", portId: "depth" },
        { nodeId: "render_shot", portId: "normal" },
      ],
    );
  };
  const renderDraws = (plan: ReturnType<typeof sceneOf>): number => (plan.passes as unknown as Pass[]).filter((pass) => pass.nodeId === "render_shot" && pass.kind === "draw").length;
  const renderRuns = (plan: ReturnType<typeof sceneOf>): number =>
    renderPassRuns(plan.passes, plan.resources).filter((run) => run.nodeId === "render_shot").length;

  it("ten sheets in one Geometry are the draws and the runs of one sheet", () => {
    const one = sceneOf(1, 1);
    const ten = sceneOf(1, 10);
    expect(one.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(ten.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(renderDraws(ten)).toBe(renderDraws(one));
    expect(renderRuns(ten)).toBe(renderRuns(one));
  });

  it("ten Geometries are ten draws wherever one sheeted Geometry is one, and never fewer device passes", () => {
    const sheeted = sceneOf(1, 10);
    const separate = sceneOf(10, 1);
    /* Per Geometry: the lit draw, the Normal layer, the Depth output and six cube faces. */
    expect(renderDraws(separate) - renderDraws(sheeted)).toBe(9 * 9);
    /* How many device passes those draws are is T1604b's rule and not this row's to pin: a
       node's consecutive draws into one single-sampled target are one. Measured 2026-10-06
       it is 13 against 4, because each producer's buffer swap is placed after its last
       reader, which here splits the last layer's ten draws. The sheeted Geometry has one
       producer and one draw a pass, so there is nothing to split. */
    expect(renderRuns(separate)).toBeGreaterThanOrEqual(renderRuns(sheeted));
  });

  it("on a multisampled colour target each Geometry is a device pass of its own; the sheeted one is still one", () => {
    const sheeted = sceneOf(1, 10, { antialias: "msaa" });
    const separate = sceneOf(10, 1, { antialias: "msaa" });
    expect(renderRuns(sceneOf(1, 1, { antialias: "msaa" }))).toBe(renderRuns(sheeted));
    // At least the nine more lit draws, each its own pass (T1604b keeps a multisampled target at one pass a draw).
    expect(renderRuns(separate) - renderRuns(sheeted)).toBeGreaterThanOrEqual(9);
  });
});
