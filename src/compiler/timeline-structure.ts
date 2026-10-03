import { applyTimelineStructure, type TimelineStructureState } from "../domain/presets/timeline-cues.ts";
import type { CompileRequest } from "./types.ts";

/**
 * §T1537b — THE COMPILE REQUEST FOR ONE SEGMENT OF THE TIMELINE: the caller's own request
 * with the timeline's structural overrides at that segment applied to the graph that
 * compiles — the FLAT graph when the request carries a flattening (root node ids survive
 * flattening, so a root Layer is the same id there), the document otherwise. Everything
 * else — sinks, settings, capabilities, the flattening's morph index — is the request's, so
 * a pass the segment shares with the document has the same id and the same bytes, and the
 * backend carries it across the crossing (§V22).
 *
 * The document's own structure (`key === ""`) is the request itself, by identity: a
 * timeline that overrides nothing at this playhead compiles exactly what it always did.
 * The layer warm-up's shape (`layerWarmRequest`), with the timeline choosing the overrides.
 */
export function timelineStructureRequest(request: CompileRequest, state: TimelineStructureState): CompileRequest {
  if (state.key === "") return request;
  return request.flattened === undefined
    ? { ...request, graph: applyTimelineStructure(request.graph, state) }
    : { ...request, flattened: { ...request.flattened, graph: applyTimelineStructure(request.flattened.graph, state) } };
}
