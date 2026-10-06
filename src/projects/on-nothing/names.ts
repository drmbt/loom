/**
 * T1593b — the node names several shots spell alike: the kind first, then the builder's own
 * word (`geometry_car0`, `light_rim`). A shot reads a node back by its name (a Render's
 * scenes and lights, an `op('…')`), and one shot is often cut from another's graph, so a name
 * two files must agree on is built here once.
 */

/** The warehouse is `wh` in the GLB and is spelled out on the canvas. */
const areaWord = (area: string): string => (area === "wh" ? "warehouse" : area);

/** An area's Mesh File In. */
export const meshName = (area: string): string => `mesh_${areaWord(area)}`;

/** The Geometry that draws an area: what a Render's `scenes` lists. */
export const geometryName = (area: string): string => `geometry_${areaWord(area)}`;

/**
 * A light, from its id: `light_rim` for `rim`. The key and the fill are `light_key1` and
 * `light_fill1` in every shot of the project, built or saved by hand.
 */
export const lightName = (id: string): string => (id === "key" || id === "fill" ? `light_${id}1` : `light_${id}`);
