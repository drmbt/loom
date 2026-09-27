import type { GraphEdge, GraphNode, ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../../examples/documents/builders.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../../furnace/post.ts";
import { OPTICS_COMPOSITE_WGSL, STREAK_WGSL } from "../fx.ts";

/**
 * T1407b — the plumbing the shots/ graphs share: a node list with a running "last" port that
 * each screen pass chains onto, the camera's parameters as references for the passes that
 * rebuild its rays, and the optics (streak columns + bloom pyramid) the shots all run.
 */
export class ShotGraph {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  last: readonly [string, string] = ["shot", "out"];

  node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): void {
    this.nodes.push(buildNode(id, type, position, {}, { ...extra, parameters }));
  }

  edge(id: string, from: readonly [string, string], to: readonly [string, string], slot?: number): void {
    this.edges.push(slot === undefined ? edge(id, from, to) : edge(id, from, to, slot));
  }

  /** A Custom WGSL pass fed `input` (and `more`), at project size or `scale` of its input; it becomes `last`. */
  pass(id: string, source: string, parameters: Record<string, StoredParameter>, input: readonly [string, string], more: readonly (readonly [string, string])[], position: readonly [number, number], scale = 1): void {
    this.node(id, more.length > 0 ? "customWgslMulti" : "customWgsl", position, { source, ...parameters }, { label: `${id.toLowerCase()}1`, resolution: scale === 1 ? { mode: "project" } : { mode: "scale", factor: scale } });
    this.edge(`${input[0]}-${id}`, input, [id, "input"]);
    more.forEach((port, index) => this.edge(`${id}-more${index}`, port, [id, "more"], index));
    this.last = [id, "out"];
  }

  /**
   * The optics over `scene`: a bright pass, the streak glass (three chained box passes reaching
   * `reach` of the frame height) and the bloom pyramid, added back by the optics composite,
   * which becomes `last`.
   */
  optics(scene: readonly [string, string], o: { readonly threshold: number; readonly knee: number; readonly reach: number; readonly streak: number; readonly bloom: number; readonly compress?: number }): void {
    this.node("bright", "customWgsl", [-1300, 300], { source: BRIGHT_PASS_WGSL, threshold: o.threshold, knee: o.knee }, { label: "bright1", resolution: { mode: "scale", factor: 0.5 } });
    this.edge("scene-bright", scene, ["bright", "input"]);
    [o.reach / 160, o.reach / 48, o.reach / 10].forEach((step, index) => {
      const id = `streak${index}`;
      // The first pass rolls each source off toward `compress`, so a glinting pendant smears a
      // soft line, not a white bar.
      this.node(id, "customWgsl", [-1100 + index * 100, 300], { source: STREAK_WGSL, step, decay: index === 2 ? 1.6 : 50, finish: index === 2 ? 1 : 0, compress: index === 0 ? o.compress ?? 0 : 0, down: 0, gain: 2.2, striation: 0.45, striationScale: 150 }, { label: `${id}1`, resolution: { mode: "scale", factor: 1 } });
      this.edge(`into-${id}`, [index === 0 ? "bright" : `streak${index - 1}`, "out"], [id, "input"]);
    });
    for (const level of [1, 2, 3, 4]) {
      this.node(`bloomDown${level}`, "customWgsl", [-900, 150 + level * 150], { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? 1 : 0 }, { label: `bloomdown${level}1`, resolution: { mode: "scale", factor: 0.5 } });
      this.edge(`bloom-down${level}`, [level === 1 ? "bright" : `bloomDown${level - 1}`, "out"], [`bloomDown${level}`, "input"]);
    }
    for (const level of [0, 1, 2, 3]) {
      this.node(`bloomUp${level}`, "customWgslMulti", [-700, 150 + level * 150], { source: BLOOM_UP_WGSL, lower: 1 }, { label: `bloomup${level}1`, resolution: { mode: "scale", factor: 2 } });
      this.edge(`bloom-up${level}-lower`, [level === 3 ? "bloomDown4" : `bloomUp${level + 1}`, "out"], [`bloomUp${level}`, "input"]);
      this.edge(`bloom-up${level}-own`, [level === 0 ? "bright" : `bloomDown${level}`, "out"], [`bloomUp${level}`, "more"], 0);
    }
    // The halo slot takes the bright pass at zero gain: no shot here has an on-axis source.
    this.pass("optics", OPTICS_COMPOSITE_WGSL, { streak: o.streak, halo: 0, bloom: o.bloom, streakTint: [0.9, 0.97, 1, 1] }, scene, [["streak2", "out"], ["bright", "out"], ["bloomUp0", "out"]], [-500, 0]);
  }

  /** The Output node on `last`, and the document. */
  document(shot: string, width: number, height: number): ProjectDocument {
    this.node("out", "output", [700, 0], { toneMap: "none" }, { label: "out1" });
    this.edge("last-out", this.last, ["out", "input"]);
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: `project-on-nothing-${shot}`,
      name: `On Nothing · ${shot}`,
      graph: graph(this.nodes, this.edges),
      settings: settings({ outputResolution: { width, height }, randomSeed: 7, limits: { ...LIMITS, memoryBudgetBytes: 3_221_225_472 } }),
      assets: [],
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    };
  }
}

/** A camera's parameters as references (`op('<label>').par.*`), for passes that rebuild its rays. */
export function cameraRefs(label: string, eye: readonly [number, number, number], aim: readonly [number, number, number], fov: number, far: number, prefix = ""): Record<string, StoredParameter> {
  const ref = (field: string, fallback: number): StoredParameter => expressionSlot(`op('${label}').par.${field}`, fallback);
  const key = (name: string): string => (prefix === "" ? name : `${prefix}${name[0]!.toUpperCase()}${name.slice(1)}`);
  return {
    [key("eye")]: [eye[0], eye[1], eye[2]],
    [key("aim")]: [aim[0], aim[1], aim[2]],
    [`${key("eye")}.x`]: ref("eye.x", eye[0]),
    [`${key("eye")}.y`]: ref("eye.y", eye[1]),
    [`${key("eye")}.z`]: ref("eye.z", eye[2]),
    [`${key("aim")}.x`]: ref("lookAt.x", aim[0]),
    [`${key("aim")}.y`]: ref("lookAt.y", aim[1]),
    [`${key("aim")}.z`]: ref("lookAt.z", aim[2]),
    [key("fov")]: ref("fov", fov),
    [key("far")]: ref("far", far),
    [key("roll")]: ref("roll", 0),
  };
}
