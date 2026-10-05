import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { formatTopology, gridPointCount, stripsPointCount, type PointTopology } from "../../points/topology.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readFlag, readNumber } from "./parameter-readers.ts";

/**
 * PointTopology (T302): the topology HALF of TD's kernel/topology split. TD deprecated
 * the combined Create POP because generation and connectivity are different authorship
 * — this node is where connectivity is authored SEPARATELY: it emits no pass, owns no
 * buffer, and republishes the upstream pairs with a different topology claim on the
 * T296 edge. Declaring a deformed point cloud to be a 128×64 grid, opening a torus's
 * seam, gridding a kernel's output so renderSurface will take it — all edge-payload
 * edits, all free at render time.
 *
 * T1586b adds the STRIPS claim: `rows` curves of `cols` slots each, connected along a
 * strip and not between strips. It is how a kernel's output becomes curves (ten tentacles
 * of 55 stations are `strips:55x10`), and it is TouchDesigner's "Every N Points" on the
 * Line Break POP. The same three parameters carry it — Columns is the slots per strip,
 * Rows the strips, Wrap U closes each strip — because a strip set is a grid with the
 * V edges taken away, at the same index.
 *
 * Every parameter is compileTime BY DEFINITION: they exist only in the published edge
 * payload, and the classifier cannot see through an edge — a value-only cols edit
 * would leave every consumer's vertex count stale.
 *
 * The capacity check is the honesty line: a topology addressing more points than the
 * edge carries is refused HERE, where the claim is authored, with the same diagnostic
 * code consumers use — not downstream where the user would have to trace it back.
 */
export const pointTopologyNode: NodeDefinition = {
  type: "pointTopology",
  version: 1,
  title: "Topology",
  category: "points",
  description:
    "Authors the connectivity claim on a pointset edge — declare a grid, declare strips (curves: Columns points each, Rows of them), close or open seams — without touching the points.",
  tags: ["points", "topology", "connectivity", "grid", "surface", "strips", "curve", "line"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
  ],
  parameters: {
    connectivity: {
      type: "enum",
      label: "Connectivity",
      default: "grid",
      // §V831: APPEND only — a stored value whose row moved resolves to the default.
      options: [
        { value: "points", label: "Points" },
        { value: "grid", label: "Grid" },
        { value: "strips", label: "Strips" },
      ],
      compileTime: true,
      description:
        "Points: no connectivity. Grid: a Columns × Rows sheet a Surface can skin. Strips (T1586b): Rows separate curves of Columns points each, in slot order — what the curve nodes (Curve Frames, Resample) and a kernel's ctx.dim read; a Surface refuses it, because neighbouring curves are not joined.",
    },
    cols: {
      type: "number",
      label: "Columns",
      default: 64,
      min: 1,
      max: 4096,
      range: "bounded",
      step: 1,
      compileTime: true,
      inactiveWhen: (values) => (values["connectivity"] === "points" ? "Points connectivity has no grid." : null),
      description: "Grid: points across. Strips: points per strip — slot j × Columns + i is station i of strip j.",
    },
    rows: {
      type: "number",
      label: "Rows",
      default: 64,
      min: 1,
      max: 4096,
      range: "bounded",
      step: 1,
      compileTime: true,
      inactiveWhen: (values) => (values["connectivity"] === "points" ? "Points connectivity has no grid." : null),
      description: "Grid: points down. Strips: how many strips.",
    },
    wrapU: {
      type: "boolean",
      label: "Wrap U",
      default: false,
      compileTime: true,
      inactiveWhen: (values) => (values["connectivity"] === "points" ? "Points connectivity has no seams." : null),
      description: "Grid: the last column joins the first (a tube). Strips: each strip is closed — its last point joins its first.",
    },
    wrapV: {
      type: "boolean",
      label: "Wrap V",
      default: false,
      compileTime: true,
      inactiveWhen: (values) =>
        values["connectivity"] === "points"
          ? "Points connectivity has no seams."
          : values["connectivity"] === "strips"
            ? "Strips are not joined to each other, so there is no V seam to close."
            : null,
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
    const points = inputs["points"];
    if (points === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "points"')] };
    }
    const pointset = points.pointset;
    if (pointset === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points input carries no edge payload; there is nothing to re-claim.`,
            nodeId,
          },
        ],
      };
    }

    const cols = Math.max(1, Math.round(readNumber(parameters, "cols", 64)));
    const rows = Math.max(1, Math.round(readNumber(parameters, "rows", 64)));
    const wrapU = readFlag(parameters, "wrapU", false) === 1;
    const topology: PointTopology =
      parameters["connectivity"] === "points"
        ? { kind: "points" }
        : parameters["connectivity"] === "strips"
          ? { kind: "strips", cols, rows, closed: wrapU }
          : { kind: "grid", cols, rows, wrapU, wrapV: readFlag(parameters, "wrapV", false) === 1 };

    const addressed =
      topology.kind === "grid" ? gridPointCount(topology) : topology.kind === "strips" ? stripsPointCount(topology) : 0;
    if (addressed > pointset.capacity) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.surface.topology",
            message: `Node "${nodeId}": topology "${formatTopology(topology)}" addresses ${addressed} points but the edge carries ${pointset.capacity}.`,
            nodeId,
            suggestion: "Match cols x rows to the producer's point count.",
          },
        ],
      };
    }

    return {
      passes: [],
      // §V197: this node WRITES nothing, so it OWNS nothing — every pair passes
      // through by reference. Only the claim changes.
      pointsets: {
        out: {
          pairs: pointset.pairs,
          capacity: pointset.capacity,
          topology: formatTopology(topology),
        },
      },
    };
  },
};
