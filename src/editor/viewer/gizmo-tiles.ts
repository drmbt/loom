import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { effectiveParameterSchema, resolveStored } from "@domain/parameters/resolve.ts";
import { gridOf, gridWarpNode } from "@nodes/definitions/grid-warp.ts";
import type { OrbitCameraBasis } from "@runtime/previews/index.ts";
import type { PreviewGizmoTile } from "./preview-gizmo-overlay.tsx";
import { gizmoHandlesFor, offersPictureHandles, pictureHandlesFor } from "./vec3-gizmo-store.ts";

/** The slice of a compiled output this derivation reads — structural, so tests stay small. */
export interface GizmoTileOutput {
  readonly nodeId: string;
  readonly portId: string;
  readonly size: readonly [number, number];
  readonly synthesis?: { readonly orbit?: OrbitCameraBasis | undefined } | undefined;
}

/**
 * T935 — WHICH TILES OFFER DRAGGABLE HANDLES, and what each one draws. Moved here out of
 * `app/graph-pane.tsx` (§T1491b) so the join between the compile and the overlay is a
 * function a test can call, not a `useMemo` only a mounted pane can reach.
 *
 * The 3D gate is the compiler's ORBIT BASIS, never a node-type list: a published basis means
 * the tile draws a SCENE IN WORLD SPACE through a camera we can reproduce exactly, which is
 * the only condition under which a world point has a place on the picture. That one fact
 * also separates the catalogue — `light.direction` is a world vector on a 3D tile, while
 * `convolve.row0` and `noise.t` are `vector`/3 parameters on TEXTURE tiles and reach
 * `gizmoHandlesFor` never.
 *
 * §T1491b — a TEXTURE tile (no synthesis at all) offers the PICTURE handles its manifest
 * declares (Corner Pin's pins), on the output port the pins are measured in: the node's
 * first. `offersPictureHandles` is asked of the schema first, so a compile resolves the
 * parameters of only the nodes that have any.
 *
 * Resolved ONCE PER COMPILE, not per frame: the handle set changes with the document, and
 * the overlay's frame loop only needs the ORBIT to be fresh. `resolveParameters` gives the
 * effective value — a driven handle is drawn where its DRIVER put it — together with the
 * active mode and the §V113 per-component modes the refusal is built from.
 */
export function gizmoTilesFor(
  outputs: ReadonlyArray<GizmoTileOutput>,
  nodes: Readonly<Record<string, GraphNode>>,
  registry: { get(type: string): NodeDefinition | undefined },
): Map<NodeId, Omit<PreviewGizmoTile, "orbit">> {
  const tiles = new Map<NodeId, Omit<PreviewGizmoTile, "orbit">>();
  for (const output of outputs) {
    const basis = output.synthesis?.orbit;
    const nodeId = output.nodeId as NodeId;
    const node = nodes[nodeId];
    if (node === undefined) continue;
    const definition = registry.get(node.type);
    if (definition === undefined) continue;
    const schema = effectiveParameterSchema(definition, node.parameters);
    const picture =
      output.synthesis === undefined &&
      output.portId === definition.outputs[0]?.id &&
      offersPictureHandles(schema);
    if (basis === undefined && !picture) continue;
    // §T1557b: the document (`resolveStored`) — a handle edits the stored value and sits where
    // that value puts it; a driven key's handle is held, not moved (`gizmoHandlesFor`).
    const resolved = resolveStored(node, definition);
    const facts = {
      schema,
      resolved: resolved.entries,
      values: resolved.values,
    };
    const handles = basis === undefined ? pictureHandlesFor(facts) : gizmoHandlesFor(facts);
    if (handles.length === 0) continue;
    if (basis !== undefined) {
      tiles.set(nodeId, { basis, source: output.size, handles });
      continue;
    }
    // §T1534b — a Grid Warp's tile also carries its surface (the effective grid), so the
    // overlay can find the line under a click and preview it before it is inserted.
    const grid = node.type === gridWarpNode.type ? gridOf(resolved.values) : undefined;
    tiles.set(nodeId, grid === undefined ? { source: output.size, handles } : { source: output.size, handles, grid });
  }
  return tiles;
}
