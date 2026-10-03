import type { NodeDefinition } from "../types/node-definition.ts";

/** Common processing applies to float image outputs, never CPU values, points, or depth. */
export function supportsChannelMask(definition: NodeDefinition): boolean {
  return definition.outputs.some(port => port.type.kind === "texture2d" && port.type.sample !== "depth") ||
    (definition.outputs.length === 0 && definition.sink === true && definition.measuredChannel !== true && definition.sideEffect !== "emits");
}
