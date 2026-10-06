import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../domain/types/graph.ts";
import { authoredPoints, curveEdge, curveGraph, curveNode, compileCurveGraph, type AuthoredAttribute, type ReadPort } from "./curve-test-support.ts";

/**
 * §T1618b at the plan level — WHICH DRAWS BIND A GRID'S `uv`, and that the rest are the
 * programs they were.
 *
 * A grid pointset that carries a vec2f `uv` hands it to the material as its texture
 * coordinate. The attribute is bound and read only where a coordinate IS read: a map is
 * wired, or the Material · WGSL's source names the member. So a Sweep, which always
 * publishes a `uv`, costs a Geometry nothing until its material wants one, and every grid
 * program that shipped is the text it was.
 *
 * What the coordinate reads back as is asserted on Dawn in `grid-uv.gpu.test.ts`.
 */

type Pass = { id: string; kind: string; shader?: string; buffers?: Array<{ binding: string }>; textures?: Array<{ binding: string }>; uniforms?: Record<string, unknown> };
type Draw = { id: string; shader: string; buffers: string[] };

/** Four points, one cell: with the named extra attributes, claimed as a grid. */
const points = (extras: ReadonlyArray<AuthoredAttribute>, claim: Record<string, unknown> = {}): { nodes: GraphNode[]; edges: Array<ReturnType<typeof curveEdge>> } => ({
  nodes: [
    authoredPoints("kernel_sheet", [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]], extras).node,
    curveNode("topology_sheet", "pointTopology", { connectivity: "grid", cols: 2, rows: 2, ...claim }),
  ],
  edges: [curveEdge(["kernel_sheet", "out"], ["topology_sheet", "points"])],
});
const UV: AuthoredAttribute = { name: "uv", type: "vec2f", values: [[0, 0], [1, 0], [0, 1], [1, 1]] };

interface Material {
  readonly node: GraphNode;
  /** Material inputs to wire a texture into. */
  readonly maps?: ReadonlyArray<"albedo" | "roughness">;
}
const stock = (type: string, maps: ReadonlyArray<"albedo" | "roughness"> = []): Material => ({ node: curveNode("material_skin", type, {}), maps });
const wgsl = (body: string): Material => ({
  node: curveNode("material_skin", "materialWgsl", { model: "pbr", source: `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {\n  var o = surfaceDefaults(s);\n${body}\n  return o;\n}` }),
});

/** The Render's draws of the grid Geometry: the lit draw, and a G-buffer layer for each output asked for. */
function drawsOf(source: ReturnType<typeof points>, material: Material, outputs: ReadonlyArray<string> = []): Draw[] {
  const ports: ReadPort[] = outputs.map((portId) => ({ nodeId: "render_shot", portId }));
  const plan = compileCurveGraph(
    curveGraph(
      [
        ...source.nodes,
        curveNode("solid_plate", "solid", {}),
        material.node,
        curveNode("geometry_skin", "geometry", { mode: "surface", material: "material_skin" }),
        curveNode("camera_main", "camera", { eye: [0, 0, 5], lookAt: [0, 0, 0] }),
        curveNode("light_key", "light", { kind: "directional", direction: [0, -1, -1] }),
        curveNode("render_shot", "render", { scenes: "geometry_skin", camera: "camera_main", lights: "light_key", ...Object.fromEntries(outputs.map((output) => [`${output}Output`, true])) }),
        curveNode("output_probe", "output"),
      ],
      [
        ...source.edges,
        ...(material.maps ?? []).map((port) => curveEdge(["solid_plate", "out"], ["material_skin", port])),
        curveEdge(["topology_sheet", "out"], ["geometry_skin", "points"]),
        curveEdge(["render_shot", "out"], ["output_probe", "input"]),
      ],
    ),
    16,
    ports,
  );
  expect(plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  return (plan.passes as unknown as Pass[])
    .filter((pass) => pass.kind === "draw" && pass.uniforms !== undefined && "grid" in pass.uniforms && String(pass.shader).includes("out.uv"))
    .map((pass) => ({ id: pass.id, shader: String(pass.shader), buffers: (pass.buffers ?? []).map((entry) => entry.binding) }));
}

const binds = (draw: Draw): boolean => draw.buffers.includes("gridUvs");
const reads = (draw: Draw): boolean => draw.shader.includes("out.uv = gridUvOf(gx, gy);") && draw.shader.includes("var<storage, read> gridUvs: array<vec2f>;");

describe("§T1618b: a grid's `uv` is bound where a texture coordinate is read, and nowhere else", () => {
  it("a stock material with a map wired binds it and reads it, in the lit draw and in every layer", () => {
    for (const maps of [["albedo"], ["roughness"], ["albedo", "roughness"]] as const) {
      const draws = drawsOf(points([UV]), stock("materialPbr", maps), ["normal", "albedo"]);
      expect(draws.map((draw) => draw.id.replace(/^.*render_shot:/, ""))).toEqual(["scene:0", "gbuffer:0", "gbuffer:albedo:0"]);
      for (const draw of draws) expect([maps.join("+"), draw.id, binds(draw), reads(draw)]).toEqual([maps.join("+"), draw.id, true, true]);
    }
  });

  it("the same material with NO map wired does not: its program is the one the pointset gets without a `uv`, to the byte", () => {
    for (const type of ["materialUnlit", "materialPhong", "materialPbr"]) {
      const carrying = drawsOf(points([UV]), stock(type), ["normal"]);
      const bare = drawsOf(points([]), stock(type), ["normal"]);
      expect(carrying).toHaveLength(2);
      expect(carrying.map(binds)).toEqual([false, false]);
      expect(carrying.map((draw) => draw.shader)).toEqual(bare.map((draw) => draw.shader));
      expect(carrying.map((draw) => draw.buffers)).toEqual(bare.map((draw) => draw.buffers));
    }
  });

  it("a Material · WGSL binds it exactly when its source names the member", () => {
    const naming = drawsOf(points([UV]), wgsl("  o.albedo = vec4f(s.uv, 0.0, 1.0);"), ["normal"]);
    expect(naming.map((draw) => [binds(draw), reads(draw)])).toEqual([[true, true], [true, true]]);
    // Through a copy handed to a helper it is still spelled.
    const copied = drawsOf(points([UV]), wgsl("  let q = s;\n  o.roughness = q . uv.x;"));
    expect(copied.map(binds)).toEqual([true]);

    const silent = drawsOf(points([UV]), wgsl("  o.albedo = vec4f(fract(s.world), 1.0);"), ["normal"]);
    const bare = drawsOf(points([]), wgsl("  o.albedo = vec4f(fract(s.world), 1.0);"), ["normal"]);
    expect(silent.map(binds)).toEqual([false, false]);
    expect(silent.map((draw) => draw.shader)).toEqual(bare.map((draw) => draw.shader));
  });

  it("a pointset with no `uv`, or one that is not a vec2f, keeps the grid's own coordinate", () => {
    const none = drawsOf(points([]), stock("materialPbr", ["albedo"]));
    const wrong = drawsOf(points([{ name: "uv", type: "vec3f", values: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]] }]), stock("materialPbr", ["albedo"]));
    for (const draws of [none, wrong]) {
      expect(draws.map(binds)).toEqual([false]);
      expect(draws[0]!.shader).toContain("f32(gx) / max(select(params.grid.x - 1.0, params.grid.x, wrapU), 1.0)");
      expect(draws[0]!.shader).not.toContain("gridUv");
    }
    expect(wrong[0]!.shader).toBe(none[0]!.shader);
  });

  it("on a grid of several sheets a vertex reads its own sheet's row", () => {
    const eight: AuthoredAttribute = { name: "uv", type: "vec2f", values: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 0], [2, 0], [0, 2], [2, 2]] };
    const source = {
      nodes: [
        authoredPoints("kernel_sheet", [[-2, -1, 0], [-1, -1, 0], [-2, 1, 0], [-1, 1, 0], [1, -1, 0], [2, -1, 0], [1, 1, 0], [2, 1, 0]], [eight]).node,
        curveNode("topology_sheet", "pointTopology", { connectivity: "grid", cols: 2, rows: 2, sheets: 2 }),
      ],
      edges: [curveEdge(["kernel_sheet", "out"], ["topology_sheet", "points"])],
    };
    const [draw] = drawsOf(source, stock("materialUnlit", ["albedo"]));
    expect(binds(draw!)).toBe(true);
    expect(draw!.shader).toContain("return gridUvs[(gridSheet * rows + row) * cols + column];");
    // One sheet reads the row as it is.
    expect(drawsOf(points([UV]), stock("materialUnlit", ["albedo"]))[0]!.shader).toContain("return gridUvs[row * cols + column];");
  });
});
