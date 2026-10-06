import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { FlatGraph, GraphNode, ProjectSettings } from "../domain/types/graph.ts";
import { projectFps } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import { parameterReadOptions } from "../domain/parameters/node-references.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { flatteningReadsOf, resolveNodeParameters } from "./validate.ts";
import type { ParameterResolution } from "./validate.ts";

/**
 * T1421b — a node's parameters a moment EARLIER or LATER on its own path.
 *
 * A camera driven by expressions is a path through time, and a motion blur wants that path's
 * DERIVATIVE, not the difference between two frames: a whip turning 40° a frame differenced a
 * frame apart reprojects half the picture from behind the lens. So the compiler hands a node
 * that asks (the Camera) a probe that re-resolves its parameters with every CLOCK moved by
 * `offsetSeconds` — `time`, `walltime`, `abstime` — through the same resolver and the same
 * `op()` reader the frame itself used (§V61). Frame COUNTS (`frame`, `absframe`), the rates
 * and channel values stay the frame's: a camera driven by a channel (the music) has no
 * derivative here, only one driven by the clock.
 *
 * `frameSeconds` is one step of the transport — a film frame, or a sub-frame when an offline
 * render accumulates them (`fps × subframes`, T1426b/T1435b) — which is what a shutter spans.
 *
 * Built for the full compile (compile.ts) and for the per-frame values-only compile
 * (frame-compile.ts) from the same inputs, so the two splice the same payload. Absent when
 * there is no frame: a static compile has no time to move.
 */
export interface TimeProbe {
  readonly frameSeconds: number;
  parametersAt(offsetSeconds: number): Readonly<Record<string, ParameterValue>>;
}

function shiftFrame(frame: FrameEvaluationInput, offsetSeconds: number): FrameEvaluationInput {
  return {
    ...frame,
    timeSeconds: frame.timeSeconds + offsetSeconds,
    ...(frame.wallSeconds === undefined ? {} : { wallSeconds: frame.wallSeconds + offsetSeconds }),
    ...(frame.absTimeSeconds === undefined ? {} : { absTimeSeconds: frame.absTimeSeconds + offsetSeconds }),
  };
}

export function timeProbeFor(
  node: GraphNode,
  definition: NodeDefinition,
  /** §T1552b: the retained compile's flat graph — what `op()` reads against. */
  graph: FlatGraph,
  registry: NodeRegistryView,
  options: ParameterResolution,
  settings: ProjectSettings,
): TimeProbe | undefined {
  const frame = options.frame;
  if (frame === undefined) return undefined;
  const fps = frame.fps !== undefined && frame.fps > 0 ? frame.fps : projectFps(settings);
  const subframes = frame.subframes !== undefined && frame.subframes >= 1 ? frame.subframes : 1;
  return {
    frameSeconds: 1 / (fps * subframes),
    parametersAt(offsetSeconds: number) {
      const shifted = shiftFrame(frame, offsetSeconds);
      // The frame's own reading, moved: the same construction validateGraph makes.
      const reading = parameterReadOptions({ graph, registry, frame: shifted, channels: options.channels, flattening: flatteningReadsOf(options) });
      return resolveNodeParameters(node, effectiveParameterSchema(definition, node.parameters), definition.type, [], reading).values;
    },
  };
}
