import type { GraphDocument } from "../domain/types/graph.ts";
import { layerNode } from "../nodes/definitions/layer.ts";
import { compileGraph } from "./compile.ts";
import type { CompiledGraph, CompileRequest } from "./types.ts";

/**
 * §T1507b — THE PLAN A DOCUMENT WOULD HAVE WITH ITS BYPASSED LAYERS SWITCHED ON.
 *
 * A Layer that is off is bypassed (§T1498b): its picture's chain is pruned, so switching
 * it on is a structural recompile that builds every pass the chain brings back. This is
 * the plan the backend builds those passes AHEAD from (`warmPasses`), so the switch itself
 * builds nothing. It is never installed, rendered or announced.
 *
 * The compile it asks for is the caller's own request with one difference: every bypassed
 * Layer of the FLAT graph is on — so a layer inside a component instance counts too, and
 * the flattening the request carries is reused rather than redone. Same sinks, settings
 * and capabilities, so the passes it brings back have the ids and bytes the real switch
 * will compile them to.
 *
 * Bounded: at most {@link MAX_WARM_LAYERS} layers (by node id), and the backend holds at
 * most `MAX_WARM_EFFECTS` passes of what comes back.
 */
export const MAX_WARM_LAYERS = 8;

/** `request` with up to {@link MAX_WARM_LAYERS} bypassed Layers on; null when there are none. */
export function layerWarmRequest(request: CompileRequest): CompileRequest | null {
  const flat = request.flattened?.graph ?? request.graph;
  const bypassed = Object.keys(flat.nodes)
    .filter((nodeId) => {
      const node = flat.nodes[nodeId]!;
      return node.type === layerNode.type && node.ui?.bypassed === true;
    })
    .sort()
    .slice(0, MAX_WARM_LAYERS);
  if (bypassed.length === 0) return null;
  const nodes: GraphDocument["nodes"] = { ...flat.nodes };
  for (const nodeId of bypassed) {
    const node = nodes[nodeId]!;
    nodes[nodeId] = { ...node, ui: { ...node.ui, bypassed: false } };
  }
  const warm: GraphDocument = { ...flat, nodes };
  return request.flattened === undefined
    ? { ...request, graph: warm }
    : { ...request, flattened: { ...request.flattened, graph: warm } };
}

/** The plan of {@link layerWarmRequest}, or null when there is nothing to build ahead. */
export function compileLayerWarmPlan(request: CompileRequest): CompiledGraph | null {
  const warm = layerWarmRequest(request);
  if (warm === null) return null;
  const plan = compileGraph(warm);
  return plan.ok ? plan : null;
}
