import type { FrameEvaluationInput } from "../types/frame.ts";
import { authoredGraph, type GraphDocument } from "../types/graph.ts";
import { NO_MORPHS } from "../presets/morph-index.ts";
import { NO_INSTANCES, parameterReadOptions, type InstanceChannelSources, type ParameterReadContext } from "./node-references.ts";
import type { ChannelResolver, ParameterMorphs, ParameterReadOptions } from "./resolve.ts";

const EMPTY_GRAPH: GraphDocument = { revision: 0, nodes: {}, edges: {}, groups: {} };
const NO_TYPES: ParameterReadContext["registry"] = { get: () => undefined };

export interface TestReadContext {
  /** The graph `op()` names resolve in. Default: an empty one — every `op('x')` names nothing. */
  readonly graph?: GraphDocument;
  readonly registry?: ParameterReadContext["registry"];
  readonly frame?: FrameEvaluationInput | undefined;
  readonly channels?: ChannelResolver | undefined;
  readonly morphs?: ParameterMorphs;
  readonly instances?: InstanceChannelSources;
}

/**
 * §T1557b — a TEST's evaluation read, built by THE factory (`parameterReadOptions`) rather
 * than spelled as an options literal, which no longer typechecks. Only the inputs a test
 * cares about are named; the rest are the explicit "none" of each (an empty graph, no
 * moment, no channels, nothing fading, no instance). Product code has no such defaults:
 * it passes a complete `ParameterReadContext` (a command: `context.readScope()`).
 */
export function testRead(context: TestReadContext = {}): ParameterReadOptions {
  return parameterReadOptions({
    // §T1552b: a test read with no flattening reads its document as authored.
    graph: authoredGraph((context.graph ?? EMPTY_GRAPH) as GraphDocument),
    registry: context.registry ?? NO_TYPES,
    frame: context.frame,
    channels: context.channels,
    flattening: { morphs: context.morphs ?? NO_MORPHS, instanceChannels: context.instances ?? NO_INSTANCES },
  });
}
