import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { isParameterSlot } from "../parameters/slots.ts";
import {
  deleteGridLine,
  gridOf,
  gridPointWrites,
  gridWarpNode,
  insertGridLine,
  isGridKey,
  type GridAxis,
  type GridLineEdit,
} from "../../nodes/definitions/grid-warp.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "./bus.ts";
import { applyGraphPatch } from "./apply-patch.ts";

/**
 * T1534b — `gridWarp.insertLine` and `gridWarp.deleteLine`: a row or column inserted at a
 * point on the CURRENT surface, or deleted, as one patch and one undo step.
 *
 * Why commands and not `coupledParameters` (§T1532b's seam): an insert needs the PLACE, and
 * no single key write carries one — Columns going 3 → 4 says "one more column", not where.
 * So the edit is computed here, by the node's own pure arithmetic (`insertGridLine`,
 * `deleteGridLine` in `definitions/grid-warp.ts`), and written as ONE `setParameters` naming
 * the new size, every point and every line position of the new grid. The seam still runs
 * inside that operation and does the rest: the keys the smaller grid lacks are removed, and
 * the write is validated against the schema after it. One revision, one audit entry under
 * this command's name and the invoking actor, and one undo puts the old grid back whole.
 *
 * ## Refusals, each named
 *
 * Not a Grid Warp; the 2..8 caps (`gridWarp.line.min` / `.max`); a line already at that
 * place, or a place outside the surface; a line the grid lacks; and a grid whose size,
 * points or line positions are not plain values (`gridWarp.line.driven`). That last one is
 * because an insert renumbers points: an expression on `p21` would silently start driving a
 * different point, and the "current surface" the new line is placed on would not be the one
 * on screen. The user makes them Constant first, and the refusal says which.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "gridWarp.insertLine": { input: GridWarpInsertLineInput; output: GridWarpLineOutput };
    "gridWarp.deleteLine": { input: GridWarpDeleteLineInput; output: GridWarpLineOutput };
  }
}

export const GRID_WARP_INSERT_LINE_COMMAND = "gridWarp.insertLine";
export const GRID_WARP_DELETE_LINE_COMMAND = "gridWarp.deleteLine";

export interface GridWarpInsertLineInput {
  /** The Grid Warp node. */
  nodeId: NodeId;
  axis: GridAxis;
  /** Where along the surface, 0..1 as the grid lies (0 the first line, 1 the last), exclusive. */
  at: number;
}

export interface GridWarpDeleteLineInput {
  nodeId: NodeId;
  axis: GridAxis;
  /** Which column (from the left) or row (from the bottom), from 0. */
  index: number;
}

export interface GridWarpLineOutput {
  ok: boolean;
  /** The grid's size after the command, or as it stood on a refusal (0 × 0 when there is no grid). */
  columns: number;
  rows: number;
}

function refusal(revision: Revision, code: string, message: string, nodeId?: NodeId, size = { columns: 0, rows: 0 }): CommandOutcome<GridWarpLineOutput> {
  const diagnostic: RuntimeDiagnostic = { severity: "error", code, message, ...(nodeId === undefined ? {} : { nodeId }) };
  return { status: "rejected", revision, diagnostics: [diagnostic], output: { ok: false, ...size } };
}

/** The first grid key that is not a plain value: a mode other than Constant, or a component bound on its own. */
function drivenGridKey(node: GraphNode): string | null {
  for (const [key, value] of Object.entries(node.parameters)) {
    if (!isGridKey(key) && key !== "columns" && key !== "rows") continue;
    if (key.includes(".")) return key;
    if (isParameterSlot(value) && value.mode !== "static") return key;
  }
  return null;
}

type Edit = (grid: ReturnType<typeof gridOf>, axis: GridAxis) => GridLineEdit;

function runLineEdit(
  name: string,
  input: { nodeId?: unknown; axis?: unknown },
  context: CommandContext,
  edit: Edit,
): CommandOutcome<GridWarpLineOutput> {
  const revision = context.store.getRevision();
  const nodeId = input.nodeId;
  if (typeof nodeId !== "string") return refusal(revision, "gridWarp.node.missing", "No Grid Warp node was named.");
  const node = context.graph.nodes[nodeId];
  if (node === undefined) return refusal(revision, "gridWarp.node.missing", `No node "${nodeId}".`);
  const where = node.label ?? node.id;
  if (node.type !== gridWarpNode.type) {
    return refusal(revision, "gridWarp.node.type", `"${where}" is a ${node.type} node, not a Grid Warp.`, node.id);
  }
  const grid = gridOf(node.parameters);
  const size = { columns: grid.columns, rows: grid.rows };
  const axis = input.axis;
  if (axis !== "column" && axis !== "row") {
    return refusal(revision, "gridWarp.line.axis", `Grid Warp "${where}": the axis must be "column" or "row", not ${JSON.stringify(axis)}.`, node.id, size);
  }
  const driven = drivenGridKey(node);
  if (driven !== null) {
    return refusal(
      revision,
      "gridWarp.line.driven",
      `Grid Warp "${where}": ${driven} is not a Constant value, and ${name === GRID_WARP_INSERT_LINE_COMMAND ? "inserting" : "deleting"} a ${axis} renumbers the points; set it to Constant first.`,
      node.id,
      size,
    );
  }
  const result = edit(grid, axis);
  if (!result.ok) return refusal(revision, result.code, `Grid Warp "${where}": ${result.reason}.`, node.id, size);
  const writes: Record<string, StoredParameter> = {
    ...(axis === "column" ? { columns: result.grid.columns } : { rows: result.grid.rows }),
    ...gridPointWrites(result.grid),
  };
  const verb = name === GRID_WARP_INSERT_LINE_COMMAND ? "Insert" : "Delete";
  const outcome = applyGraphPatch(
    {
      baseRevision: context.graph.revision,
      label: `${verb} ${axis} (${where})`,
      operations: [{ op: "setParameters", nodeId: node.id, parameters: writes }],
    },
    // Its own undo step even inside a caller's transaction (the preset commands' rule).
    { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) },
  );
  const ok = outcome.status === "applied" || outcome.status === "validated";
  return {
    status: outcome.status,
    revision: outcome.revision ?? revision,
    diagnostics: outcome.diagnostics ?? [],
    ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
    output: { ok, ...(ok ? { columns: result.grid.columns, rows: result.grid.rows } : size) },
  };
}

export function registerGridWarpCommands(bus: LoomBus): void {
  if (!bus.hasCommand(GRID_WARP_INSERT_LINE_COMMAND)) {
    bus.registerCommand({
      name: GRID_WARP_INSERT_LINE_COMMAND,
      description: "Insert a column or row into a Grid Warp at a place on its current surface, keeping the picture where it is (§T1534b).",
      handler: (input, context) =>
        runLineEdit(GRID_WARP_INSERT_LINE_COMMAND, input ?? {}, context, (grid, axis) => insertGridLine(grid, axis, typeof input?.at === "number" ? input.at : Number.NaN)),
      rejectionOutput: () => ({ ok: false, columns: 0, rows: 0 }),
    });
  }
  if (!bus.hasCommand(GRID_WARP_DELETE_LINE_COMMAND)) {
    bus.registerCommand({
      name: GRID_WARP_DELETE_LINE_COMMAND,
      description: "Delete one column or row of a Grid Warp; every other point keeps its place (§T1534b).",
      handler: (input, context) =>
        runLineEdit(GRID_WARP_DELETE_LINE_COMMAND, input ?? {}, context, (grid, axis) => deleteGridLine(grid, axis, typeof input?.index === "number" ? input.index : Number.NaN)),
      rejectionOutput: () => ({ ok: false, columns: 0, rows: 0 }),
    });
  }
}
