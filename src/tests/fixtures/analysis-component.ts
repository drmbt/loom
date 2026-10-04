import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { GraphNode } from "../../domain/types/graph.ts";

/**
 * §T1551b — a component with TWO exposed value outputs, for the `op('<instance>').chan.<c>`
 * readers and the example gates that must accept that read.
 *
 * `levels` carries `bands1`'s bag (`level`, `shared`) and `hits` carries `onsets1`'s (`kick`,
 * `shared`), so one instance answers `level` and `kick`, and refuses `shared` (two outputs
 * publish it): the legitimate read and the one a gate must still reject, in one fixture.
 * `level` is an expression so a test can make it move with the frame.
 */
export const ANALYSIS_COMPONENT_ID = "analysis";

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string, y = 0): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y }, parameters, label }) as never;

export function analysisComponentDefinition(level = "0.75"): GraphComponentDefinition {
  return {
    componentId: ANALYSIS_COMPONENT_ID,
    version: 1,
    name: "Analysis",
    graph: {
      revision: 1,
      groups: {},
      nodes: {
        bands: node("bands", "valueExpression", { expressions: `level = ${level}; shared = 1` }, "bands1"),
        onsets: node("onsets", "valueExpression", { expressions: "kick = 0.6; shared = 2" }, "onsets1"),
        levels: node("levels", "componentOutValue", {}, "levels", 0),
        hits: node("hits", "componentOutValue", {}, "hits", 100),
      },
      edges: {
        a: { id: "a", source: { nodeId: "bands", portId: "out" }, target: { nodeId: "levels", portId: "in" } },
        b: { id: "b", source: { nodeId: "onsets", portId: "out" }, target: { nodeId: "hits", portId: "in" } },
      },
    },
    inputs: [],
    outputs: [],
    parameters: [],
  };
}
