import { synthesizeSourceReferenceEdges } from "@compiler/source-reference-edges.ts";
import { bypassPassthroughPorts } from "@domain/graph/bypass.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { cornerPinNode } from "@nodes/definitions/corner-pin.ts";
import { gridWarpNode } from "@nodes/definitions/grid-warp.ts";
import { fitInsideRegion } from "@editor/nodes/preview-fit.ts";

/**
 * §T1536b — WHICH MAPPING NODE A PERFORM WINDOW CAN EDIT, AND WHERE ITS HANDLES LAND THERE.
 *
 * Mapping is done looking at the projector, so a Window Out's "edit mapping" mode draws the
 * handles of the Corner Pin / Grid Warp upstream of it ON the perform window. A handle's
 * value lives in the mapping node's OWN picture (normalised, y up — the T935/§T1491b picture
 * handle), and the window shows that picture after everything downstream of the node. This
 * module answers the two questions that decides, purely, so a test can call them:
 *
 *  1. `mappingTargetsOf` — the mapping nodes on the window's input chain, nearest first, each
 *     with `null` when its picture reaches the window UNMOVED, or the named reason it does not.
 *  2. `windowPicture` — for an unmoved one, the exact map between its picture and the
 *     window's CSS pixels: the Window Out's Fit (the shader's `placed`, restated), then the
 *     canvas's `object-fit: contain` of the W×H target into the window.
 *
 * ## Exact, or refused — never guessed
 *
 * Between the mapping node and the window only nodes that keep every point of the picture
 * where it was (in normalised coordinates) are crossed: a bypassed node and a declared
 * passthrough (a wire, §T250), and the colour-only nodes in `GEOMETRY_PRESERVING`. Anything
 * else — a Transform, a Crop, a Flip, another Corner Pin or Grid Warp, a composite, a node
 * this list has never heard of — REFUSES that target with the blocking node named. The list
 * fails closed on purpose: a node missing from it costs a refusal the operator can read; a
 * node wrongly on it would put a handle where the parameter is not.
 *
 * A resolution change on a crossed node does not matter: the picture is stretched to the new
 * size in normalised coordinates, and Fit reads the size the Window Out actually samples
 * (`inputSize`, off the compiled plan), not the mapping node's.
 *
 * ## Which one, when there are several
 *
 * Every Corner Pin / Grid Warp on the chain is listed (the inspector picks), nearest first;
 * the nearest is the default. Every one past the nearest sits behind a warp, so it is listed
 * with that refusal rather than hidden — the operator sees it exists and why it cannot be
 * dragged here. The chain past a non-preserving node is followed through the node's
 * resolution input (the input its picture derives from) only to list what lies beyond; a
 * node with none ends the walk. Nodes inside a component are not reached (the walk reads the
 * document root, where Window Outs live).
 */

export type MappingKind = "cornerPin" | "gridWarp";

export interface MappingTarget {
  readonly nodeId: string;
  /** The node's name (its label), or its id when it has none. */
  readonly name: string;
  readonly kind: MappingKind;
  /** "Corner Pin" / "Grid Warp". */
  readonly title: string;
  /** Null when its handles land exactly on this window; the named reason they cannot, otherwise. */
  readonly refusal: string | null;
}

/**
 * Nodes whose output shows every point of the followed input exactly where it was, keyed to
 * that input. Per-pixel colour operations only; fail closed (see above).
 */
export const GEOMETRY_PRESERVING: Readonly<Record<string, string>> = {
  filmGrade: "input",
  hsv: "input",
  level: "input",
  limit: "input",
  premultiply: "input",
  threshold: "input",
  lookup: "source",
};

const MAPPING_KINDS: Readonly<Record<string, MappingKind>> = {
  [cornerPinNode.type]: "cornerPin",
  [gridWarpNode.type]: "gridWarp",
};

const WINDOW_INPUT = "input";

/** The mapping nodes feeding `windowNodeId`, nearest first. */
export function mappingTargetsOf(graph: GraphDocument, registry: NodeRegistryView, windowNodeId: string): readonly MappingTarget[] {
  // By-name sources become the edges the compile would synthesize (B233's wire-or-name rule).
  const wired = synthesizeSourceReferenceEdges(graph, registry).graph;
  const edges = Object.values(wired.edges);
  const into = (nodeId: string, portId: string): string | undefined =>
    edges.find((edge) => edge.target.nodeId === nodeId && edge.target.portId === portId)?.source.nodeId;

  const targets: MappingTarget[] = [];
  /** The first node on the way that moves the picture, as "<Title> "<name>" <what it does>". */
  let blocker: string | null = null;
  const refusal = (title: string, name: string): string | null =>
    blocker === null ? null : `${blocker} between ${title} "${name}" and this window, so its handles cannot be placed exactly here.`;

  const seen = new Set<string>([windowNodeId]);
  let current = into(windowNodeId, WINDOW_INPUT);
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const node = wired.nodes[current];
    const definition = node === undefined ? undefined : registry.get(node.type);
    if (node === undefined || definition === undefined) break;
    const name = node.label ?? current;
    const named = `${definition.title} "${name}"`;
    /** Past a node that blocks, the walk goes on through its resolution input only to LIST what lies beyond. */
    const listOn = (): string | undefined => {
      const policy = definition.resolutionPolicy;
      return policy?.kind === "inherit" ? policy.input : undefined;
    };
    // §T250: a bypassed node is a wire, first matching input to first output.
    const bypass = node.ui?.bypassed === true ? bypassPassthroughPorts(definition) : undefined;
    let follow: string | undefined;
    if (node.ui?.muted === true || (node.ui?.bypassed === true && bypass === undefined)) {
      blocker ??= `${named} is muted`;
      follow = listOn();
    } else if (bypass !== undefined) {
      follow = bypass.input;
    } else if (definition.passthrough !== undefined) {
      follow = definition.passthrough.input;
    } else if (MAPPING_KINDS[node.type] !== undefined) {
      targets.push({ nodeId: current, name, kind: MAPPING_KINDS[node.type] as MappingKind, title: definition.title, refusal: refusal(definition.title, name) });
      blocker ??= `${named} warps the picture again`;
      follow = "input";
    } else if (GEOMETRY_PRESERVING[node.type] !== undefined) {
      follow = GEOMETRY_PRESERVING[node.type];
    } else {
      blocker ??= `${named} moves the picture`;
      follow = listOn();
    }
    current = follow === undefined ? undefined : into(current, follow);
  }
  return targets;
}

/** The note a window in edit mode shows when there is nothing to draw. */
export function mappingAbsentNote(): string {
  return "No Corner Pin or Grid Warp feeds this window.";
}

export type WindowFit = "fit" | "fill" | "stretch";
export type Size = readonly [number, number];
export type Point = readonly [number, number];

/** What decides where the mapping node's picture lands in the window. */
export interface WindowPictureFacts {
  /** The Window Out's Fit. */
  readonly fit: WindowFit;
  /** The size of the texture the Window Out samples (its input, as compiled). */
  readonly inputSize: Size;
  /** The Window Out's target, W × H — the canvas bitmap. */
  readonly targetSize: Size;
}

/** `ratio` exactly as `windowOutShader` computes it. */
function fitRatio({ inputSize, targetSize }: WindowPictureFacts): number {
  const inputAspect = inputSize[0] / Math.max(inputSize[1], 1);
  const targetAspect = targetSize[0] / targetSize[1];
  return targetAspect / Math.max(inputAspect, 1e-6);
}

/**
 * The Window Out shader's `placed`, restated: a point of its target (normalised) → the point
 * of its input sampled there. Symmetric about the centre on each axis, so it holds for y up
 * as for y down.
 */
export function fitPlaced(facts: WindowPictureFacts, [x, y]: Point): Point {
  const ratio = fitRatio(facts);
  if (facts.fit === "fit") return ratio < 1 ? [x, (y - 0.5) / ratio + 0.5] : [(x - 0.5) * ratio + 0.5, y];
  if (facts.fit === "fill") return ratio < 1 ? [(x - 0.5) * ratio + 0.5, y] : [x, (y - 0.5) / ratio + 0.5];
  return [x, y];
}

/** The inverse of `fitPlaced`: a point of the input picture → where the target shows it. */
export function fitShown(facts: WindowPictureFacts, [u, v]: Point): Point {
  const ratio = fitRatio(facts);
  if (facts.fit === "fit") return ratio < 1 ? [u, (v - 0.5) * ratio + 0.5] : [(u - 0.5) / ratio + 0.5, v];
  if (facts.fit === "fill") return ratio < 1 ? [(u - 0.5) / ratio + 0.5, v] : [u, (v - 0.5) * ratio + 0.5];
  return [u, v];
}

export interface WindowPicture {
  /** A point of the mapping node's picture (normalised, y up) → window CSS pixels. */
  toWindow(point: Point): Point;
  /** Window CSS pixels → the mapping node's picture. */
  fromWindow(point: Point): Point;
}

/**
 * The whole map for a window of `windowSize` CSS pixels: Fit into the target, then the
 * canvas's `object-fit: contain` (`perform-window.ts`), which is `fitInsideRegion`'s
 * letterbox (§V118) — the bitmap is the target's size (`sizing: "source"`).
 */
export function windowPicture(facts: WindowPictureFacts, windowSize: Size): WindowPicture {
  const rect = fitInsideRegion({ width: windowSize[0], height: windowSize[1] }, facts.targetSize);
  return {
    toWindow(point) {
      const [x, y] = fitShown(facts, point);
      return [rect.x + x * rect.width, rect.y + (1 - y) * rect.height];
    },
    fromWindow([px, py]) {
      return fitPlaced(facts, [(px - rect.x) / rect.width, 1 - (py - rect.y) / rect.height]);
    },
  };
}
