import type { GraphEdge, GraphNode, NodeFormatOverride } from "../domain/types/graph.ts";
import type { NodeId } from "../domain/types/ids.ts";
import type { StoredParameter } from "../domain/types/parameters.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../nodes/shaders/bloom-pyramid.wgsl.ts";
import { edge, named } from "./documents/builders.ts";

type Position = readonly [number, number];
type FourIds = readonly [NodeId, NodeId, NodeId, NodeId];

export interface BloomPyramidOptions {
  /** Stable caller-owned identities; levels describe stages, not positions in user data. */
  readonly ids: { readonly bright: NodeId; readonly down: FourIds; readonly up: FourIds };
  readonly edgePrefix: string;
  readonly layout: { readonly bright: Position; readonly down: Position; readonly up: Position; readonly step: Position };
  readonly threshold: StoredParameter;
  readonly knee: StoredParameter;
  readonly firstClampLuma: StoredParameter;
  readonly lower: StoredParameter;
  /** Omit to retain the shader's radius default, as the existing project graphs do. */
  readonly radius?: StoredParameter;
  /** Library authors pin HDR; existing project graphs retain their inherited format. */
  readonly format?: NodeFormatOverride;
}

export interface BloomPyramidGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly bright: readonly [NodeId, "out"];
  readonly glow: readonly [NodeId, "out"];
}

/**
 * One ordinary nine-node graph: HDR bright extraction, four levels down and four back up.
 * The picture input and the final mix are caller wiring. Keeping those outside lets a
 * streak reuse Bright and lets different looks set gain on their existing Add/optics node.
 * Every scale is relative to its input, including the existing per-level rounding.
 */
export function bloomPyramidGraph(options: BloomPyramidOptions): BloomPyramidGraph {
  const { ids, layout } = options;
  const extras = options.format === undefined ? {} : { format: options.format };
  const position = (start: Position, index: number): Position => [start[0] + layout.step[0] * index, start[1] + layout.step[1] * index];
  const nodes: GraphNode[] = [named("bright", "customWgsl", layout.bright, {}, {
    id: ids.bright, ...extras,
    parameters: { source: BRIGHT_PASS_WGSL, threshold: options.threshold, knee: options.knee },
    resolution: { mode: "scale", factor: 0.5 },
  })];
  const edges: GraphEdge[] = [];

  for (const level of [1, 2, 3, 4] as const) {
    const id = ids.down[level - 1]!;
    nodes.push(named(`bloomdown${level}`, "customWgsl", position(layout.down, level - 1), {}, {
      id, ...extras,
      parameters: { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? options.firstClampLuma : 0 },
      resolution: { mode: "scale", factor: 0.5 },
    }));
    edges.push(edge(`${options.edgePrefix}-down${level}`, [level === 1 ? ids.bright : ids.down[level - 2]!, "out"], [id, "input"]));
  }
  for (const level of [0, 1, 2, 3] as const) {
    const id = ids.up[level];
    nodes.push(named(`bloomup${level}`, "customWgslMulti", position(layout.up, level), {}, {
      id, ...extras,
      parameters: { source: BLOOM_UP_WGSL, lower: options.lower, ...(options.radius === undefined ? {} : { radius: options.radius }) },
      resolution: { mode: "scale", factor: 2 },
    }));
    edges.push(
      edge(`${options.edgePrefix}-up${level}-lower`, [level === 3 ? ids.down[3] : ids.up[level + 1]!, "out"], [id, "input"]),
      edge(`${options.edgePrefix}-up${level}-own`, [level === 0 ? ids.bright : ids.down[level - 1]!, "out"], [id, "more"], 0),
    );
  }
  return { nodes, edges, bright: [ids.bright, "out"], glow: [ids.up[0], "out"] };
}
