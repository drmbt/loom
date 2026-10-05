import { describe, expect, it } from "vitest";

import type { PointAttributeSchema } from "../../points/attributes.ts";
import { authoredPoints, compileCurveGraph, curveEdge, curveGraph, curveNode, drawnTo, onDawn } from "./curve-test-support.ts";

/**
 * T1586b slice 1 — STRIPS reach a real kernel, and a Surface refuses them.
 *
 * A strips claim is the same index a grid uses (slot = strip × cols + station), so a
 * kernel over curves reads `ctx.dim` exactly as a kernel over a sheet does. What this file
 * proves is that the claim TRAVELS: nothing below hands a kernel a dimension. A Topology
 * node (or a Line generator) publishes `strips:` on its edge, the compiler resolves the
 * edge, the kernel reads the claim off it, and the numbers that come back out of the GPU
 * are the only evidence the path is joined (§V220's reason for building a graph).
 *
 * Exactness is free (§V147): stations and strip numbers are small whole numbers, so every
 * f32 that comes back is compared for equality.
 */

const PROBE_SCHEMA: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "probe", type: "vec4f", default: [0, 0, 0, 0] },
];

/** The whole of `ctx.dim` into an attribute. No dimension is written in this string. */
const DIM_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.probe = vec4f(f32(ctx.dim.cols), f32(ctx.dim.rows), f32(ctx.dim.i), f32(ctx.dim.j));
  return q;
}`;

const TWELVE = Array.from({ length: 12 }, (_, i) => [i, 0, 0] as const);

/** authored points → Topology (the claim under test) → a kernel that reads ctx.dim. */
function claimedGraph(claim: Record<string, unknown>) {
  const source = authoredPoints("kernel_source", TWELVE);
  const sink = drawnTo("kernel_probe", 12);
  return curveGraph(
    [
      source.node,
      curveNode("topology_claim", "pointTopology", claim),
      curveNode("kernel_probe", "pointKernel", { capacity: 12, seed: 7, attributes: JSON.stringify(PROBE_SCHEMA), kernel: DIM_KERNEL }),
      ...sink.nodes,
    ],
    [curveEdge(["kernel_source", "out"], ["topology_claim", "points"]), curveEdge(["topology_claim", "out"], ["kernel_probe", "in"]), ...sink.edges],
  );
}

async function probeOf(graph: ReturnType<typeof curveGraph>, capacity: number): Promise<number[][]> {
  return onDawn(graph, async (session) => {
    const { floats } = await session.read("kernel_probe", PROBE_SCHEMA, capacity, "probe");
    return Array.from({ length: capacity }, (_, slot) => Array.from(floats.subarray(slot * 4, slot * 4 + 4)));
  });
}

describe("strips on Dawn — a kernel reads its station and its strip off the edge (T1586b)", () => {
  it("hands every point the claim's cols and rows, its station i and its strip j", async () => {
    const slots = await probeOf(claimedGraph({ connectivity: "strips", cols: 4, rows: 3 }), 12);
    // Every slot, not just the first: i and j are exactly where a transposed index would live.
    for (let slot = 0; slot < 12; slot += 1) {
      expect(slots[slot], `slot ${slot}`).toEqual([4, 3, slot % 4, Math.floor(slot / 4)]);
    }
  }, 60_000);

  /**
   * §V361: the kernel TEXT is the same across the two runs; only the Topology node's knobs
   * changed. A kernel with the dimension typed into it returns the first run's numbers.
   */
  it("FOLLOWS the claim — the same kernel over 6 × 2 strips returns different numbers", async () => {
    const narrow = await probeOf(claimedGraph({ connectivity: "strips", cols: 4, rows: 3 }), 12);
    const wide = await probeOf(claimedGraph({ connectivity: "strips", cols: 6, rows: 2 }), 12);
    // Slot 4 is the first station of strip 1 under 4 × 3 and the fifth of strip 0 under 6 × 2.
    expect(narrow[4]).toEqual([4, 3, 0, 1]);
    expect(wide[4]).toEqual([6, 2, 4, 0]);
    expect(wide).not.toEqual(narrow);
  }, 60_000);

  /** A Line is one strip of `count` points with no Topology node in between. */
  it("a Line generator publishes its own strip: cols is its count, rows is 1", async () => {
    const sink = drawnTo("kernel_probe", 7);
    const graph = curveGraph(
      [
        curveNode("line_source", "pointLine", { count: 7, sizeX: 6 }),
        curveNode("kernel_probe", "pointKernel", { capacity: 7, seed: 7, attributes: JSON.stringify(PROBE_SCHEMA), kernel: DIM_KERNEL }),
        ...sink.nodes,
      ],
      [curveEdge(["line_source", "out"], ["kernel_probe", "in"]), ...sink.edges],
    );
    const slots = await probeOf(graph, 7);
    for (let slot = 0; slot < 7; slot += 1) expect(slots[slot], `slot ${slot}`).toEqual([7, 1, slot, 0]);
  }, 60_000);
});

describe("a strips claim is not a sheet (T1586b R2)", () => {
  /**
   * The claim is connectivity ALONG a strip only. A Surface that skinned it would draw a
   * membrane between neighbouring curves, so both surface consumers refuse it — by name,
   * naming what the edge published (§V288). The control is the same graph claimed as a
   * grid, which compiles: the refusal is about the claim and nothing else.
   */
  const surfaceGraph = (claim: Record<string, unknown>) => {
    const source = authoredPoints("kernel_source", TWELVE);
    return curveGraph(
      [
        source.node,
        curveNode("topology_claim", "pointTopology", claim),
        curveNode("rendersurface_skin", "renderSurface"),
        curveNode("output_probe", "output"),
      ],
      [
        curveEdge(["kernel_source", "out"], ["topology_claim", "points"]),
        curveEdge(["topology_claim", "out"], ["rendersurface_skin", "points"]),
        curveEdge(["rendersurface_skin", "out"], ["output_probe", "input"]),
      ],
    );
  };

  it("Render Surface refuses strips by name, and takes the same points claimed as a grid", () => {
    const refused = compileCurveGraph(surfaceGraph({ connectivity: "strips", cols: 4, rows: 3 }));
    const errors = refused.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message);
    expect(errors.join(" ")).toContain("a surface needs analytic grid topology");
    expect(errors.join(" ")).toContain("strips:4x3");

    const accepted = compileCurveGraph(surfaceGraph({ connectivity: "grid", cols: 4, rows: 3 }));
    expect(accepted.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("a Geometry in Surface mode refuses strips by name inside a Render", () => {
    const source = authoredPoints("kernel_source", TWELVE);
    const graph = curveGraph(
      [
        source.node,
        curveNode("topology_claim", "pointTopology", { connectivity: "strips", cols: 4, rows: 3 }),
        curveNode("geometry_skin", "geometry", { mode: "surface" }),
        curveNode("camera_main", "camera"),
        curveNode("light_key", "light"),
        curveNode("render_shot", "render", { scenes: "geometry_skin", camera: "camera_main", lights: "light_key" }),
        curveNode("output_probe", "output"),
      ],
      [
        curveEdge(["kernel_source", "out"], ["topology_claim", "points"]),
        curveEdge(["topology_claim", "out"], ["geometry_skin", "points"]),
        curveEdge(["render_shot", "out"], ["output_probe", "input"]),
      ],
    );
    const errors = compileCurveGraph(graph)
      .diagnostics.filter((entry) => entry.severity === "error")
      .map((entry) => entry.message);
    expect(errors.join(" ")).toContain("carries neither an analytic grid nor a mesh topology");
  });
});
