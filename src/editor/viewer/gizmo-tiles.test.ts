import { describe, expect, it } from "vitest";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { defaultParameters } from "@domain/parameters/index.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/index.ts";
import type { OrbitCameraBasis } from "@runtime/previews/index.ts";
import { gizmoTilesFor } from "./gizmo-tiles.ts";

/**
 * The join between the compile and the gizmo overlay (T935, §T1491b), against the shipped
 * catalogue. `graph-pane.tsx` calls exactly this, so what these assert is what the pane
 * offers: a Corner Pin's texture tile gets its four pins, a light's 3D tile keeps its world
 * handle, and a texture node with no declared handle gets nothing.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

function nodeOf(id: string, type: string): GraphNode {
  const definition = registry.get(type);
  if (definition === undefined) throw new Error(`no definition for ${type}`);
  return {
    id: id as NodeId,
    type,
    definitionVersion: definition.version,
    position: { x: 0, y: 0 },
    parameters: defaultParameters(effectiveParameterSchema(definition, {})),
  };
}

const BASIS: OrbitCameraBasis = { eye: [0, 0, 2.6], lookAt: [0, 0, 0], fovY: Math.PI / 4, near: 0.1, far: 10, aspect: 1 };

const nodes = {
  pin: nodeOf("pin", "cornerPin"),
  tile: nodeOf("tile", "tile"),
  lamp: nodeOf("lamp", "light"),
};

describe("gizmoTilesFor — which tiles the pane offers handles on", () => {
  it("offers a Corner Pin's TEXTURE tile its four picture pins, with no camera (§T1491b)", () => {
    const tiles = gizmoTilesFor([{ nodeId: "pin", portId: "out", size: [640, 360] }], nodes, registry);
    const tile = tiles.get("pin" as NodeId);
    expect(tile?.basis).toBeUndefined();
    expect(tile?.source).toEqual([640, 360]);
    expect(tile?.handles.map((handle) => [handle.space, handle.key])).toEqual([
      ["picture", "pinbl"],
      ["picture", "pinbr"],
      ["picture", "pintr"],
      ["picture", "pintl"],
    ]);
  });

  it("offers nothing on a texture tile whose manifest declares no picture handle", () => {
    // Tile's seam is a vector/2 in 0..1 — in the INPUT's coordinates, so no handle (§V437).
    expect(gizmoTilesFor([{ nodeId: "tile", portId: "out", size: [64, 64] }], nodes, registry).size).toBe(0);
  });

  it("offers nothing for a port the pins are not measured in", () => {
    expect(gizmoTilesFor([{ nodeId: "pin", portId: "other", size: [64, 64] }], nodes, registry).size).toBe(0);
  });

  it("keeps T935's world handles on a 3D tile with an orbit basis", () => {
    const tiles = gizmoTilesFor(
      [{ nodeId: "lamp", portId: "out", size: [96, 96], synthesis: { orbit: BASIS } }],
      nodes,
      registry,
    );
    const tile = tiles.get("lamp" as NodeId);
    expect(tile?.basis).toBe(BASIS);
    expect(tile?.handles.map((handle) => [handle.space ?? "world", handle.key])).toEqual([["world", "direction"]]);
  });
});
