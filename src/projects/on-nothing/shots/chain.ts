import type { GraphEdge, GraphNode, ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../../examples/documents/builders.ts";
import { BRIGHT_PASS_WGSL } from "../../../nodes/shaders/bloom-pyramid.wgsl.ts";
import { bloomPyramidGraph } from "../../../examples/bloom-pyramid.ts";
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
    this.node(id, more.length > 0 ? "customWgslMulti" : "customWgsl", position, { source, ...parameters }, { label: `wgsl_${id.toLowerCase()}`, resolution: scale === 1 ? { mode: "project" } : { mode: "scale", factor: scale } });
    this.edge(`${input[0]}-${id}`, input, [id, "input"]);
    more.forEach((port, index) => this.edge(`${id}-more${index}`, port, [id, "more"], index));
    this.last = [id, "out"];
  }

  /**
   * The optics over `scene`: a bright pass, the streak glass (three chained box passes reaching
   * `reach` of the frame height) and the bloom pyramid, added back by the optics composite,
   * which becomes `last`.
   */
  optics(scene: readonly [string, string], o: { readonly threshold: number; readonly knee: number; readonly reach: number; readonly streak: number; readonly bloom: number; readonly compress?: number; readonly streakThreshold?: number }): void {
    const bloom = bloomPyramidGraph({
      ids: { bright: "bright", down: ["bloomDown1", "bloomDown2", "bloomDown3", "bloomDown4"], up: ["bloomUp0", "bloomUp1", "bloomUp2", "bloomUp3"] },
      edgePrefix: "bloom", layout: { bright: [-1300, 300], down: [-900, 300], up: [-700, 150], step: [0, 150] },
      threshold: o.threshold, knee: o.knee, firstClampLuma: 1, lower: 1,
    });
    this.nodes.push(...bloom.nodes);
    this.edges.push(...bloom.edges);
    this.edge("scene-bright", scene, ["bright", "input"]);
    // The streaks' OWN source, far above the bloom's (as document.ts): only clipped sources
    // streak — never a lit shoulder or a chain link.
    this.node("streakSrc", "customWgsl", [-1300, 200], { source: BRIGHT_PASS_WGSL, threshold: o.streakThreshold ?? 4.5, knee: 1.2 }, { label: "wgsl_streaksrc", resolution: { mode: "scale", factor: 0.5 } });
    this.edge("scene-streaksrc", scene, ["streakSrc", "input"]);
    // 16 taps a pass: each pass's span covers the next pass's step twice over.
    [o.reach / 400, o.reach / 60, o.reach / 20].forEach((step, index) => {
      const id = `streak${index}`;
      // The first pass rolls each source off toward `compress`, so a glinting pendant smears a
      // soft line, not a white bar.
      this.node(id, "customWgsl", [-1100 + index * 100, 300], { source: STREAK_WGSL, step, decay: index === 2 ? 1.6 : 50, finish: index === 2 ? 1 : 0, compress: index === 0 ? o.compress ?? 3 : 0, down: 0, gain: 1.8, striation: 0.22, striationScale: 110 }, { label: `wgsl_${id}`, resolution: { mode: "scale", factor: 1 } });
      this.edge(`into-${id}`, [index === 0 ? "streakSrc" : `streak${index - 1}`, "out"], [id, "input"]);
    });
    // The halo slot takes the bright pass at zero gain: no shot here has an on-axis source.
    this.pass("optics", OPTICS_COMPOSITE_WGSL, { streak: o.streak, halo: 0, bloom: o.bloom, streakTint: [0.9, 0.97, 1, 1] }, scene, [["streak2", "out"], ["bright", "out"], ["bloomUp0", "out"]], [-500, 0]);
  }

  /** The Output node on `last`, and the document. */
  document(shot: string, width: number, height: number): ProjectDocument {
    this.node("out", "output", [700, 0], { toneMap: "none" }, { label: "output1" });
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
