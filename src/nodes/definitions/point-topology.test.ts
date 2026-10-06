import { describe, expect, it } from "vitest";

import { pointTopologyNode } from "./point-topology.ts";
import { compileContext, fixturePairs } from "./test-support.ts";

/** The topology half of the T302 split: pure edge-payload authorship. */
describe("pointTopology — the connectivity claim (T302)", () => {
  // T1076: one packed buffer, two regions — the shape a producer publishes.
  const PAIRS = fixturePairs(
    "gen",
    [
      { name: "position", type: "vec3f" },
      { name: "color", type: "vec4f", half: "read" },
    ],
    4096,
  );
  const edge = (capacity: number, topology: string) => ({
    points: { pairs: PAIRS, capacity, topology },
  });

  it("republishes the upstream pairs BY REFERENCE with the authored claim (§V197)", () => {
    const result = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(4096, "points"),
        parameters: { connectivity: "grid", cols: 64, rows: 64, wrapU: true },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.passes).toEqual([]);
    expect(result.scratch ?? []).toEqual([]);
    // Halves pass through untouched (§V231): the claim changes, the data does not.
    expect(result.pointsets).toEqual({
      out: {
        pairs: PAIRS,
        capacity: 4096,
        topology: "grid:64x64:wrapU",
      },
    });
  });

  it("erases a claim too: connectivity=points strips a grid back to a cloud", () => {
    const result = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(4096, "grid:64x64:wrapUV"),
        parameters: { connectivity: "points" },
      }),
    );
    expect(result.pointsets?.["out"]?.topology).toBe("points");
  });

  it("refuses a claim the capacity cannot honour, at the point of authorship", () => {
    const result = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(100, "points"),
        parameters: { connectivity: "grid", cols: 64, rows: 64 },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.surface.topology");
    expect(result.diagnostics?.[0]?.message).toContain("4096");
    expect(result.diagnostics?.[0]?.message).toContain("100");
  });

  /**
   * T1586b: how a kernel's output becomes CURVES. The same three parameters carry it —
   * Columns is the slots per strip, Rows the strips, Wrap U closes each strip — and
   * Wrap V must not leak into the claim: strips are not joined to each other.
   */
  it("claims strips: Columns points per strip, Rows strips, Wrap U closes each one (T1586b)", () => {
    const open = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(4096, "points"),
        parameters: { connectivity: "strips", cols: 55, rows: 10, wrapV: true },
      }),
    );
    expect(open.diagnostics ?? []).toEqual([]);
    expect(open.passes).toEqual([]);
    expect(open.pointsets).toEqual({ out: { pairs: PAIRS, capacity: 4096, topology: "strips:55x10" } });

    const closed = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(4096, "grid:64x64"),
        parameters: { connectivity: "strips", cols: 8, rows: 3, wrapU: true },
      }),
    );
    expect(closed.pointsets?.["out"]?.topology).toBe("strips:8x3:closed");
  });

  it("refuses a strips claim the capacity cannot honour, at the point of authorship", () => {
    const result = pointTopologyNode.compile(
      compileContext({
        nodeId: "topo",
        inputs: ["points"],
        pointsets: edge(500, "points"),
        parameters: { connectivity: "strips", cols: 55, rows: 10 },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.surface.topology");
    expect(result.diagnostics?.[0]?.message).toContain("strips:55x10");
    expect(result.diagnostics?.[0]?.message).toContain("550");
    expect(result.diagnostics?.[0]?.message).toContain("500");
  });

  it("refuses an input with no edge payload", () => {
    const result = pointTopologyNode.compile(compileContext({ nodeId: "topo", inputs: ["points"] }));
    expect(result.diagnostics?.[0]?.code).toBe("node.points.edge");
  });
});

/** T1587b slice 2 — the Sheets parameter: several `Columns × Rows` sheets in one grid claim. */
describe("pointTopology — sheets (T1587b)", () => {
  const PAIRS = fixturePairs("gen", [{ name: "position", type: "vec3f" }], 4096);
  const claim = (parameters: Record<string, unknown>, capacity = 4096) =>
    pointTopologyNode.compile(compileContext({ nodeId: "topo", inputs: ["points"], pointsets: { points: { pairs: PAIRS, capacity, topology: "points" } }, parameters: parameters as never }));

  it("claims Sheets sheets of Columns × Rows, with the wraps after the count", () => {
    expect(claim({ connectivity: "grid", cols: 12, rows: 54, sheets: 6 }).pointsets?.["out"]?.topology).toBe("grid:12x54x6");
    expect(claim({ connectivity: "grid", cols: 12, rows: 54, sheets: 6, wrapU: true }).pointsets?.["out"]?.topology).toBe("grid:12x54x6:wrapU");
  });

  it("one sheet is the claim a grid always made", () => {
    expect(claim({ connectivity: "grid", cols: 64, rows: 64, wrapU: true }).pointsets?.["out"]?.topology).toBe("grid:64x64:wrapU");
    expect(claim({ connectivity: "grid", cols: 64, rows: 64, sheets: 1 }).pointsets?.["out"]?.topology).toBe("grid:64x64");
  });

  it("refuses sheets the capacity cannot hold, at the point of authorship", () => {
    // 12 × 54 × 7 = 4,536 points over an edge of 4,096.
    const result = claim({ connectivity: "grid", cols: 12, rows: 54, sheets: 7 });
    expect(result.pointsets).toBeUndefined();
    expect(result.diagnostics?.[0]?.message).toBe('Node "topo": topology "grid:12x54x7" addresses 4536 points but the edge carries 4096.');
    expect(claim({ connectivity: "grid", cols: 12, rows: 54, sheets: 6 }).diagnostics ?? []).toEqual([]);
  });

  it("only a Grid is cut into sheets: strips and points do not read the number", () => {
    expect(claim({ connectivity: "strips", cols: 12, rows: 54, sheets: 6 }).pointsets?.["out"]?.topology).toBe("strips:12x54");
    expect(claim({ connectivity: "points", sheets: 6 }).pointsets?.["out"]?.topology).toBe("points");
    const inactive = (values: Record<string, unknown>): string | null =>
      (pointTopologyNode.parameters["sheets"] as { inactiveWhen?: (values: Record<string, unknown>) => string | null }).inactiveWhen?.(values) ?? null;
    expect(inactive({ connectivity: "grid" })).toBeNull();
    expect(inactive({ connectivity: "strips" })).toBe("Only a Grid is cut into sheets; Rows already says how many strips.");
    expect(inactive({ connectivity: "points" })).toBe("Only a Grid is cut into sheets; Rows already says how many strips.");
  });
});
