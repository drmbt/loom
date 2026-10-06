import type { GraphEdge, GraphNode, ProjectDocument } from "../../../domain/types/graph.ts";
import { kindOfType, withKind } from "../../../domain/graph/node-kinds.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../../examples/documents/builders.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../../furnace/post.ts";

/**
 * T1407b — the plumbing the title and the ring shots share (`shots/title.ts`, `shots/ring.ts`):
 * a graph under construction with a running "last picture" the passes chain onto, the bloom
 * pyramid, and the camera parameters a screen-space pass reads off the Camera node.
 * `document.ts` keeps its own copy for the shots it builds; these files are kept apart from it
 * so parallel sessions on other shots never touch the same lines.
 */

export type Port = readonly [string, string];

export class Chain {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  last: Port;

  constructor(first: Port) {
    this.last = first;
  }

  /** A node, named for its kind and its id (`wgsl_haze` for a Custom WGSL `haze`) unless `extra.label` says otherwise. */
  add(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): string {
    this.nodes.push(buildNode(id, type, position, {}, { ...extra, parameters, label: extra.label ?? withKind(kindOfType(type), id.toLowerCase()) }));
    return id;
  }

  link(from: Port, to: Port, slot?: number): void {
    this.edges.push(edge(`${from[0]}.${from[1]}-${to[0]}.${to[1]}${slot === undefined ? "" : `#${slot}`}`, from, to, slot));
  }

  /** A Custom WGSL pass fed by the running picture (Input) and `more` (the Multi's More, in order). */
  pass(id: string, source: string, parameters: Record<string, StoredParameter>, more: readonly Port[], position: readonly [number, number], scale = 1): void {
    this.add(id, more.length > 0 ? "customWgslMulti" : "customWgsl", position, { source, ...parameters }, { resolution: scale === 1 ? { mode: "project" } : { mode: "scale", factor: scale } });
    this.link(this.last, [id, "input"]);
    more.forEach((port, index) => this.link(port, [id, "more"], index));
    this.last = [id, "out"];
  }

  /**
   * A stock node that takes the running picture on `input` and continues the chain. It is the
   * one of its kind in the shot, and is named so: `streak1`, `lens1`, `filmgrade1`.
   */
  stock(id: string, type: string, parameters: Record<string, StoredParameter>, position: readonly [number, number]): void {
    this.add(id, type, position, parameters, { label: `${kindOfType(type)}1` });
    this.link(this.last, [id, "input"]);
    this.last = [id, "out"];
  }

  /**
   * The bloom pyramid (the furnace's): a bright pass at half size, four levels down, back up.
   * A "scale" resolution is relative to the node's own INPUT, so each level halves the one before.
   * Returns the finished glow.
   */
  bloom(from: Port, threshold: number, x: number): Port {
    this.add("bright", "customWgsl", [x, 300], { source: BRIGHT_PASS_WGSL, threshold, knee: 0.8 }, { resolution: { mode: "scale", factor: 0.5 } });
    this.link(from, ["bright", "input"]);
    for (const level of [1, 2, 3, 4]) {
      this.add(`bloomDown${level}`, "customWgsl", [x + 200, 150 + level * 150], { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? 1 : 0 }, { resolution: { mode: "scale", factor: 0.5 } });
      this.link([level === 1 ? "bright" : `bloomDown${level - 1}`, "out"], [`bloomDown${level}`, "input"]);
    }
    for (const level of [0, 1, 2, 3]) {
      this.add(`bloomUp${level}`, "customWgslMulti", [x + 400, 150 + level * 150], { source: BLOOM_UP_WGSL, lower: 1 }, { resolution: { mode: "scale", factor: 2 } });
      this.link([level === 3 ? "bloomDown4" : `bloomUp${level + 1}`, "out"], [`bloomUp${level}`, "input"]);
      this.link([level === 0 ? "bright" : `bloomDown${level}`, "out"], [`bloomUp${level}`, "more"], 0);
    }
    return ["bloomUp0", "out"];
  }

  document(shot: string, width: number, height: number): ProjectDocument {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: `project-on-nothing-${shot}`,
      name: `On Nothing · ${shot}`,
      graph: graph(this.nodes, this.edges),
      settings: settings({
        outputResolution: { width, height },
        randomSeed: 7,
        limits: { ...LIMITS, memoryBudgetBytes: 3_221_225_472 },
      }),
      assets: [],
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    };
  }
}

export const vec3 = (v: readonly [number, number, number]): number[] => [v[0], v[1], v[2]];

/** The screen-space passes' camera parameters, read off the Camera node `camera1` every frame. */
export function cameraParams(eye: readonly [number, number, number], aim: readonly [number, number, number], fov: number): Record<string, StoredParameter> {
  const ref = (field: string, fallback: number): StoredParameter => expressionSlot(`op('camera1').par.${field}`, fallback);
  return {
    eye: vec3(eye),
    aim: vec3(aim),
    "eye.x": ref("eye.x", eye[0]),
    "eye.y": ref("eye.y", eye[1]),
    "eye.z": ref("eye.z", eye[2]),
    "aim.x": ref("lookAt.x", aim[0]),
    "aim.y": ref("lookAt.y", aim[1]),
    "aim.z": ref("lookAt.z", aim[2]),
    fov: ref("fov", fov),
    far: ref("far", 200),
    roll: ref("roll", 0),
  };
}

/** Expression helpers (the expression grammar has clamp, sin, cos, ^, and no smoothstep). */
export const clamp01 = (x: string): string => `clamp(${x}, 0, 1)`;
/** Smoothstep of x over [0, 1]. */
export const smooth = (x: string): string => `(${clamp01(x)} ^ 2 * (3 - 2 * ${clamp01(x)}))`;
/** Cubic ease-out of x over [0, 1]: fast start, long settle. */
export const easeOut = (x: string): string => `(1 - (1 - ${clamp01(x)}) ^ 3)`;
/** A number as an expression literal (no exponent notation, sign in parentheses). */
export const num = (value: number): string => (value < 0 ? `(${value.toFixed(6)})` : value.toFixed(6));
