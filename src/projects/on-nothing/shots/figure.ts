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
  readonly area: "fig" | "figbare" | "fignocap" | "figcap";
  readonly material: string;
  readonly yaw: number | string;
  readonly place: readonly [number | string, number | string, number | string];
  readonly pose: Readonly<Record<string, string>>;
  /** T1407b (hands): the right hand holds the pistol (the GLB's `figgun` area, hands.py), posed with the body. */
  readonly gun?: boolean;
}

export function figureNodes(facts: OnNothingFacts, spec: FigureSpec): { nodes: GraphNode[]; edges: GraphEdge[]; scene: string } {
  const mesh = facts.areas.get(spec.area);
  if (mesh === undefined) throw new Error(`figureNodes: no "${spec.area}" area in the GLB.`);
  const known = new Set(facts.bones.map(boneParam));
  const pose: Record<string, StoredParameter> = {};
  for (const [key, value] of Object.entries(spec.pose)) {
    const [bone, axis] = key.split(".");
    // T1419b: the hand knobs (curlL: vec4, spreadL: f32, thumbL: vec2; skin-kernel.ts handPose)
    const hand = bone === undefined ? undefined : /^(curl|spread|thumb)[LR]$/.exec(bone)?.[1];
    if (hand === "spread" && axis === undefined) {
      pose[bone!] = expressionSlot(value, 0);
      continue;
    }
    if (bone === undefined || (hand === undefined && !known.has(bone))) throw new Error(`figureNodes: no bone "${bone}" (${key}).`);
    if (axis !== "x" && axis !== "y" && axis !== "z" && !(hand === "curl" && axis === "w")) throw new Error(`figureNodes: "${key}" names no axis.`);
    if (pose[bone] === undefined) pose[bone] = hand === "curl" ? [0, 0, 0, 0] : hand === "thumb" ? [0, 0] : [0, 0, 0];
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
  const gun = spec.gun === true ? facts.areas.get("figgun") : undefined;
  if (spec.gun === true && gun === undefined) throw new Error("figureNodes: no pistol (`figgun`) in the GLB; rebuild it with tools/blender/on-nothing/hands.py.");
  if (gun !== undefined) {
    // the pistol: its own copy of the rig, the same kernel and knobs, so it stays in the hand
    const skin = nodes[1]!.parameters;
    nodes.push(
      buildNode("gunIn", "meshFileIn", [-3600, 1450], {}, { label: "gunin1", parameters: { file: facts.glbUrl, select: gun.select, vertices: gun.vertices, triangles: gun.triangles, parts: gun.parts, joints: gun.joints } }),
      buildNode("gunSkin", "pointKernel", [-3300, 1450], {}, { label: "gunskin1", parameters: { ...skin, capacity: gun.vertices } }),
      buildNode("gunGeo", "geometry", [-3000, 1450], {}, { label: "figgungeo1", parameters: { mode: "surface", material: spec.material } }),
    );
    edges.push(edge("gun-skin", ["gunIn", "out"], ["gunSkin", "in"]), edge("gunskin-geo", ["gunSkin", "out"], ["gunGeo", "points"]));
  }
  return { nodes, edges, scene: gun === undefined ? "figgeo1" : "figgeo1 figgungeo1" };
}
