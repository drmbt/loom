import type { GraphEdge, GraphNode } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { edge, expressionSlot, node as buildNode } from "../../../examples/documents/builders.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { SKIN_ATTRIBUTES, boneParam, skinKernel } from "../skin-kernel.ts";

/**
 * T1407b — the posed FIGURE for a shot graph: Mesh File In → the skin kernel → a Geometry
 * named `figgeo1`, wearing `material`. `pose` maps `bone.axis` to an expression (radians
 * about the rest axes, skin-kernel.ts); `place` components may be expressions too.
 */
export interface FigureSpec {
  readonly area: "fig" | "figbare" | "fignocap";
  readonly material: string;
  readonly yaw: number | string;
  readonly place: readonly [number | string, number | string, number | string];
  readonly pose: Readonly<Record<string, string>>;
}

export function figureNodes(facts: OnNothingFacts, spec: FigureSpec): { nodes: GraphNode[]; edges: GraphEdge[]; scene: string } {
  const mesh = facts.areas.get(spec.area);
  if (mesh === undefined) throw new Error(`figureNodes: no "${spec.area}" area in the GLB.`);
  const known = new Set(facts.bones.map(boneParam));
  const pose: Record<string, StoredParameter> = {};
  for (const [key, value] of Object.entries(spec.pose)) {
    const [bone, axis] = key.split(".");
    if (bone === undefined || !known.has(bone)) throw new Error(`figureNodes: no bone "${bone}" (${key}).`);
    if (axis !== "x" && axis !== "y" && axis !== "z") throw new Error(`figureNodes: "${key}" names no axis.`);
    if (pose[bone] === undefined) pose[bone] = [0, 0, 0];
    pose[key] = expressionSlot(value, 0);
  }
  const place: Record<string, StoredParameter> = { place: spec.place.map((entry) => (typeof entry === "number" ? entry : 0)) };
  spec.place.forEach((entry, index) => {
    if (typeof entry === "string") place[`place.${"xyz"[index]}`] = expressionSlot(entry, 0);
  });
  const nodes: GraphNode[] = [
    buildNode("fig", "meshFileIn", [-3600, 1200], {}, { label: "fig1", parameters: { file: facts.glbUrl, select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts, joints: mesh.joints } }),
    buildNode("skin", "pointKernel", [-3300, 1200], {}, { label: "skin1", parameters: { capacity: mesh.vertices, attributes: SKIN_ATTRIBUTES, kernel: skinKernel(facts), yaw: typeof spec.yaw === "number" ? spec.yaw : expressionSlot(spec.yaw, 0), ...place, ...pose } }),
    buildNode("figGeo", "geometry", [-3000, 1200], {}, { label: "figgeo1", parameters: { mode: "surface", material: spec.material } }),
  ];
  const edges = [edge("fig-skin", ["fig", "out"], ["skin", "in"]), edge("skin-geo", ["skin", "out"], ["figGeo", "points"])];
  return { nodes, edges, scene: "figgeo1" };
}
