import type { CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import { STRIP_WALK_BLOCK } from "../../points/curve.ts";
import { parseTopology, stripsOf, stripsPointCount, type StripSet } from "../../points/topology.ts";

/**
 * T1586b — the curve nodes' ONE reading of "what strips does this edge carry", and the
 * refusals that go with it, so Curve Frames and Resample (and the nodes after them) cannot
 * come to say it in different words (§V109's reason for one resolver).
 *
 * A curve node follows each strip of its input in slot order. An edge that claims
 * `points` or a mesh has no order to follow, and guessing one ("the whole pointset is one
 * strip") would draw a line through a cloud — a picture, and a plausible one. So it is
 * refused BY NAME, with the node that authors the claim as the fix (§V288, the design's
 * D10). A grid is accepted: its rows are strips (`stripsOf`).
 */

export const STRIPS_REFUSAL_CODE = "node.points.strips";

export function stripsOnEdge(
  nodeId: string,
  title: string,
  pointset: { readonly capacity: number; readonly topology?: string },
): { readonly strips: StripSet } | { readonly refusal: CompiledNodeDescription } {
  const refuse = (message: string, suggestion: string): { refusal: CompiledNodeDescription } => ({
    refusal: {
      passes: [],
      diagnostics: [{ severity: "error", code: STRIPS_REFUSAL_CODE, message: `Node "${nodeId}": ${message}`, nodeId, suggestion }],
    },
  });
  const strips = stripsOf(parseTopology(pointset.topology));
  if (strips === undefined) {
    return refuse(
      `${title} follows each strip of a pointset in slot order, and this edge claims "${pointset.topology ?? "points"}" — points with no order to follow.`,
      "Put a Topology node before it with Connectivity: Strips, and say how many points each strip has. A Line, a Circle and a Grid already publish strips.",
    );
  }
  if (stripsPointCount(strips) > pointset.capacity) {
    return refuse(
      `the edge claims ${strips.rows} strips of ${strips.cols} points (${stripsPointCount(strips)}) but carries ${pointset.capacity}.`,
      "Match the claim to the producer's point count.",
    );
  }
  return { strips };
}

/**
 * The walk's limit, refused by name until the blocked form lands. A strip of at most
 * `STRIP_WALK_BLOCK` points is walked whole by one invocation; a longer one is cut into
 * blocks, which changes its rounding — so it must not be accepted now and re-rounded later.
 */
export function longStripRefusal(nodeId: string, title: string, strips: StripSet): CompiledNodeDescription | undefined {
  if (strips.cols <= STRIP_WALK_BLOCK) return undefined;
  return {
    passes: [],
    diagnostics: [
      {
        severity: "error",
        code: STRIPS_REFUSAL_CODE,
        message: `Node "${nodeId}": ${title} walks each strip in one pass up to ${STRIP_WALK_BLOCK} points, and these strips have ${strips.cols}. Longer strips are §T1586b's slice 6.`,
        nodeId,
        suggestion: `Resample to ${STRIP_WALK_BLOCK} points or fewer per strip first (Resample, Count, Even Parameter has no such limit), or split the curve across strips.`,
      },
    ],
  };
}
