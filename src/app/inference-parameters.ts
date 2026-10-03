import { createParameterReadOptions, resolveParameters } from "@domain/parameters/index.ts";
import type { ChannelResolver, ParameterMorphs } from "@domain/parameters/resolve.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * T1525b — what a model node's OWN parameters are read with: the catalogue, the compile's
 * channel resolver and the preset morphs in flight over the graph the seam tracks
 * (`FlattenedGraph.morphs`). Getters, read at each use, like the media transport's (§T1524b).
 */
export interface InferenceParameterReads {
  readonly registry: NodeRegistryView;
  readonly channels: () => ChannelResolver | undefined;
  readonly morphs: () => ParameterMorphs | undefined;
}

/**
 * A model node's parameters as the one read path resolves them at `frame` (§V61) — the bag
 * the node definition's own settings reader (`matteSettings`, `depthSettingsFor`) is handed.
 *
 * The seam used to hand those readers `node.parameters`, the STORED slots, so an expression
 * on Smoothing or Detail Ratio did nothing and a bank fading Smoothing reached the worker
 * at its destination on the frame of the recall. These are `ResolvedParameters.values`,
 * which is exactly what the compile hands the same functions (`readCompileInputs`), so
 * the Input Size the seam runs at and the one the plan sized the preprocess for are one
 * read. No `frame`: the zero frame and no fade, as a structural compile reads them.
 *
 * Absent `reads` (a test of the seam alone), the stored bag, as before.
 */
export function inferenceParametersAt(
  node: GraphNode,
  graph: GraphDocument,
  reads: InferenceParameterReads | undefined,
  frame: FrameEvaluationInput | undefined,
): Readonly<Record<string, unknown>> {
  if (reads === undefined) return node.parameters;
  const { registry } = reads;
  const options = createParameterReadOptions({ graph, registry, frame, channels: reads.channels(), morphs: reads.morphs() });
  return resolveParameters(node, registry.get(node.type), options).values;
}
