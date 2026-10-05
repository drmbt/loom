import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import type { KitFacts, Vec3 } from "./kit.ts";
import { PATH, pathExpression } from "./path.ts";
import { BODY_ATTRIBUTES, BODY_KERNEL, JOINT_ATTRIBUTES, RIB_BLOCKS, RIB_COUNT, RIB_KERNEL, jointCount, jointKernel } from "./rig.ts";
import { HULL_SURFACE_WGSL } from "./surface.ts";

/**
 * T1561b — THE SENTINEL DOCUMENT, motion study: one robot walking the tunnel.
 *
 * What is here is the RIG and the data it flows through, in the shape the finished piece
 * keeps: the distance travelled is one number on the value graph; the body and every joint
 * are placed from it on the GPU; the camera reads the same path on the CPU. What is NOT here
 * yet is the look — the joints are drawn as boxes and the tunnel as rings of blocks until a
 * mesh can be instanced (§T1581b).
 */

export interface SentinelDocumentOptions {
  readonly width?: number;
  readonly height?: number;
  /** Where the camera rides, relative to the robot along the tunnel: metres ahead, right and up. Default: behind, chasing. */
  readonly camera?: readonly [number, number, number];
  /** Each robot's place off the pack's own: right, up, ahead (metres). Default: one robot, on the axis. */
  readonly robots?: readonly Vec3[];
}

/** Parameters may be slots (expressions, maps); the shared builder's signature takes values only. */
function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

const map = (attribute: string, fallback: number | number[], channel?: string): StoredParameter => ({
  mode: "map",
  bindings: { static: { kind: "static", value: fallback }, map: { kind: "map", attribute, ...(channel === undefined ? {} : { channel }) } },
}) as StoredParameter;

const TRAVEL = "op('travel1').chan.value";

export function sentinelDocument(facts: KitFacts, options: SentinelDocumentOptions = {}): ProjectDocument {
  const travel = expressionSlot(TRAVEL, 0);
  const robots = options.robots ?? [[0, 0, 0]];
  /** A point of the tunnel's centreline `ahead` metres from the robot, lifted by (dx, dy), as three expressions. */
  const onPath = (ahead: number, dx: number, dy: number): { x: StoredParameter; y: StoredParameter; z: StoredParameter } => {
    const z = `(${TRAVEL} + ${ahead})`;
    const at = pathExpression(z);
    return { x: expressionSlot(`${at.x} + ${dx}`, dx), y: expressionSlot(`${at.y} + ${dy}`, dy), z: expressionSlot(z, ahead) };
  };
  const [ahead, right, up] = options.camera ?? [-7.5, 1.1, 0.6];
  const eye = onPath(ahead, right, up);
  const aim = onPath(0.6, 0, 0);
  const glow = onPath(0.9, 0, 0);
  const lamp = onPath(7, 0, 1.6);
  const boxes = (id: string, kind: number, scale: number, position: readonly [number, number]): GraphNode =>
    node(id, "geometry", position, {
      mode: "instances",
      shape: "box",
      material: "steel1",
      scale: map("tint", scale, "w"),
      orient: map("orient", [0, 0, 0, 1]),
      tint: map("tint", [1, 1, 1, 1]),
      group: `p.kind > ${(kind - 0.5).toFixed(1)} && p.kind < ${(kind + 0.5).toFixed(1)}`,
    }, { label: `${id.toLowerCase()}1` });

  const nodes: GraphNode[] = [
    // ── How far it has come: a rate, integrated, wrapping where the path does ──
    node("speed", "constant", [-2400, 600], { value: 3.2 }, { label: "speed1" }),
    node("travel", "valueSpeed", [-2100, 600], { minimum: 0, maximum: PATH.period, limit: "loop" }, { label: "travel1" }),
    // ── The body ──
    node("robot", "meshFileIn", [-2400, 0], { file: facts.glbUrl, select: facts.robot.select, vertices: facts.robot.vertices, triangles: facts.robot.triangles, parts: facts.robot.parts }, { label: "robot1" }),
    // One kernel and one draw per robot until the body can be instanced on a point (T1581b).
    ...robots.flatMap((offset, index) => [
      node(`body${index}`, "pointKernel", [-2100, -index * 150], { capacity: facts.robot.vertices, attributes: BODY_ATTRIBUTES, kernel: BODY_KERNEL, travel, offset: [offset[0], offset[1], offset[2]] }, { label: `body${index}_1` }),
      node(`bodyGeo${index}`, "geometry", [-1800, -index * 150], { mode: "surface", material: "hull1" }, { label: `bodygeo${index}_1` }),
    ]),
    node("hull", "materialWgsl", [-1800, 150], { model: "pbr", source: HULL_SURFACE_WGSL }, { label: "hull1" }),
    // ── The joints: one point each, drawn as boxes until a mesh can be instanced (T1581b) ──
    node("joints", "pointKernel", [-2100, 300], { capacity: jointCount(facts) * robots.length, attributes: JOINT_ATTRIBUTES, kernel: jointKernel(facts, robots), travel }, { label: "joints1" }),
    node("steel", "materialPbr", [-1800, 900], { color: [0.5, 0.52, 0.56, 1], metallic: 0.9, roughness: 0.3 }, { label: "steel1" }),
    boxes("rings", 0, 0.085, [-1800, 300]),
    boxes("hubs", 1, 0.085, [-1800, 450]),
    boxes("claws", 2, 0.085, [-1800, 600]),
    // ── The tunnel, standing in: blocks on the ribs the claws plant on ──
    node("ribs", "pointKernel", [-2100, 1200], { capacity: RIB_COUNT * RIB_BLOCKS, attributes: JOINT_ATTRIBUTES, kernel: RIB_KERNEL, travel }, { label: "ribs1" }),
    node("ribGeo", "geometry", [-1800, 1200], { mode: "instances", shape: "box", material: "steel1", scale: 0.42, orient: map("orient", [0, 0, 0, 1]), tint: map("tint", [1, 1, 1, 1]) }, { label: "ribgeo1" }),
    // ── Camera and light ──
    node("cam", "camera", [-1500, -600], { eye: [right, up, ahead], lookAt: [0, 0, 0.6], "eye.x": eye.x, "eye.y": eye.y, "eye.z": eye.z, "lookAt.x": aim.x, "lookAt.y": aim.y, "lookAt.z": aim.z, fov: 55, near: 0.05, far: 240 }, { label: "cam1" }),
    node("key", "light", [-1500, -450], { kind: "directional", direction: [-0.3, -0.8, 0.5], color: [0.6, 0.78, 1, 1], intensity: 1.4 }, { label: "key1" }),
    node("eyes", "light", [-1500, -300], { kind: "point", color: [1, 0.12, 0.06, 1], intensity: 1.6, position: [0, 0, 0.9], "position.x": glow.x, "position.y": glow.y, "position.z": glow.z, falloff: "inverseSquare", range: 14 }, { label: "eyes1" }),
    node("lamp", "light", [-1500, -150], { kind: "point", color: [0.55, 0.8, 1, 1], intensity: 26, position: [0, 1.6, 7], "position.x": lamp.x, "position.y": lamp.y, "position.z": lamp.z, falloff: "inverseSquare", range: 40 }, { label: "lamp1" }),
    node("shot", "render", [-1200, 0], {
      scenes: [...robots.map((_, index) => `bodygeo${index}_1`), "rings1", "hubs1", "claws1", "ribgeo1"].join(" "),
      camera: "cam1",
      lights: "key1 eyes1 lamp1",
      ambientColor: [0.5, 0.62, 0.8, 1],
      ambientIntensity: 0.12,
      background: [0.004, 0.006, 0.01, 1],
      antialias: "msaa",
    }, { label: "shot1" }),
    node("out", "output", [-900, 0], { toneMap: "filmic" }, { label: "out1" }),
  ];

  const edges: GraphEdge[] = [
    edge("speed-travel", ["speed", "out"], ["travel", "in"]),
    ...robots.flatMap((_, index) => [
      edge(`robot-body${index}`, ["robot", "out"], [`body${index}`, "in"]),
      edge(`body-geo${index}`, [`body${index}`, "out"], [`bodyGeo${index}`, "points"]),
    ]),
    edge("joints-rings", ["joints", "out"], ["rings", "points"]),
    edge("joints-hubs", ["joints", "out"], ["hubs", "points"]),
    edge("joints-claws", ["joints", "out"], ["claws", "points"]),
    edge("ribs-geo", ["ribs", "out"], ["ribGeo", "points"]),
    edge("shot-out", ["shot", "out"], ["out", "input"]),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "project-sentinel-bot",
    name: "Sentinel Bot",
    graph: graph(nodes, edges),
    settings: settings({ outputResolution: { width: options.width ?? 1280, height: options.height ?? 720 }, randomSeed: 23 }),
    assets: [],
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
}
