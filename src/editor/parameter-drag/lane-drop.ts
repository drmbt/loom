import { normalizeValue, parseAutomation, serializeAutomation, type AutomationDocument } from "@domain/automation/model.ts";
import { uniqueNodeName } from "@domain/graph/names.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { resolveParameter } from "@domain/parameters/resolve.ts";
import { parameterReadOptions, type ParameterReadContext } from "@domain/parameters/node-references.ts";
import { isParameterSlot, storedStaticValue } from "@domain/parameters/slots.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterSlot, ParameterValue, StoredParameter } from "@domain/types/parameters.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { AUTOMATION_NODE_TYPE } from "@nodes/definitions/automation.ts";
import { kindOfType } from "@domain/graph/node-kinds.ts";
import type { ParameterDragPayload } from "@ui/controls/parameter-drag-context.ts";
import { addLane, freshLaneName } from "../timeline/timeline-edits.ts";
import { lanesStored } from "../timeline/timeline-model.ts";

/**
 * VN63 — A PARAMETER DROPPED ON THE TIMELINE'S LANE LIST. Pure: the operations of ONE
 * patch, so the bus applies them as one revision and one undo restores everything.
 *
 * On the list (no lane under the drop): a NEW lane on the current automation node (or on a
 * new one, created in the same patch and named in it, `automation1`, so the reference can
 * name it), whose range is the parameter's min/max and whose one key sits at the playhead
 * holding the parameter's current value, normalized. On a lane: only the reference.
 *
 * Either way the parameter gets an EXPRESSION slot reading the lane,
 * `op('<automation>').chan.<lane>`, and keeps every binding it had (§V108): its static
 * value stays retained, so undo, or flipping back to Constant, gives back exactly what
 * was there.
 *
 * Number parameters only. A compound (a vector, a colour) needs a lane per channel, which
 * is a later row; it is refused with a notice that says so, and so is anything else.
 */

export type LaneDropTarget =
  | { readonly kind: "new"; readonly automationNodeId: NodeId | null; readonly atTicks: number }
  | { readonly kind: "existing"; readonly automationNodeId: NodeId; readonly laneId: string };

export type LaneDropPlan =
  | { readonly ok: true; readonly operations: GraphPatchOperation[]; readonly lane: string; readonly automationName: string }
  | { readonly ok: false; readonly notice: string };

/** A lane name from a parameter key: `scale.x` → `scale_x`, `2d` → `p2d`. */
export function laneNameFor(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `p${cleaned}`;
}

/** The parameter's slot reading `source`, every previous binding kept. */
export function referenceSlot(stored: StoredParameter | undefined, fallback: number, source: string): ParameterSlot {
  const expression = { kind: "expression" as const, source };
  if (isParameterSlot(stored)) return { ...stored, mode: "expression", bindings: { ...stored.bindings, expression } };
  return { mode: "expression", bindings: { static: { kind: "static", value: stored === undefined ? fallback : (stored as ParameterValue) }, expression } };
}

export function laneDropOperations(
  graph: GraphDocument,
  registry: NodeRegistryView,
  source: ParameterDragPayload,
  target: LaneDropTarget,
  scope: ParameterReadContext,
): LaneDropPlan {
  const node = graph.nodes[source.nodeId];
  if (node === undefined) return { ok: false, notice: "That parameter's node is gone." };
  const schema = effectiveParameterSchema(registry.get(node.type), node.parameters);
  const definition = schema[source.key];
  if (definition === undefined) return { ok: false, notice: `"${source.key}" is not a parameter of ${node.label ?? node.id}.` };
  if (definition.type === "vector" || definition.type === "color") {
    return { ok: false, notice: `${definition.label} has several channels; compound parameters can't be automated yet.` };
  }
  if (definition.type !== "number") return { ok: false, notice: `${definition.label} is not a number, so a lane cannot drive it.` };

  const stored = node.parameters[source.key];
  const resolved = resolveParameter(node, source.key, definition, { ...parameterReadOptions(scope), schema });
  const value = resolved.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, notice: "The parameter has no finite value to automate." };
  // The lane's range: the parameter's own, else one that holds its current value.
  const min = definition.min ?? Math.min(0, value);
  const max = definition.max ?? Math.max(min + 1, value);

  const operations: GraphPatchOperation[] = [];
  let automationName: string;
  let laneName: string;
  if (target.kind === "existing") {
    const automation = graph.nodes[target.automationNodeId];
    const parsed = parseAutomation(storedStaticValue(automation?.parameters["lanes"]));
    const lane = parsed.ok ? parsed.document.lanes.find((each) => each.id === target.laneId) : undefined;
    if (automation?.label === undefined || lane === undefined) return { ok: false, notice: "That lane cannot be referenced: its automation node has no name, or the lane is gone." };
    automationName = automation.label;
    laneName = lane.name;
  } else {
    const automation = target.automationNodeId === null ? undefined : graph.nodes[target.automationNodeId];
    if (target.automationNodeId !== null && automation === undefined) return { ok: false, notice: "That automation node is gone." };
    if (automation !== undefined && automation.type !== AUTOMATION_NODE_TYPE) return { ok: false, notice: "That node is not an automation node." };
    if (automation !== undefined && isParameterSlot(automation.parameters["lanes"]) && automation.parameters["lanes"].mode !== "static") return { ok: false, notice: "That node's lanes are driven and cannot be edited here." };
    const parsed = parseAutomation(storedStaticValue(automation?.parameters["lanes"]));
    if (!parsed.ok) return { ok: false, notice: `The automation node's lanes do not parse: ${parsed.reason}.` };
    const document: AutomationDocument = parsed.document;
    laneName = freshLaneName(document, laneNameFor(source.key));
    const added = addLane(document, target.atTicks, { name: laneName, v: Math.min(1, Math.max(0, normalizeValue({ min, max }, value))), min, max });
    if (automation === undefined) {
      automationName = uniqueNodeName(graph, kindOfType(AUTOMATION_NODE_TYPE));
      operations.push({
        op: "addNode",
        ref: "$automation",
        type: AUTOMATION_NODE_TYPE,
        label: automationName,
        position: { x: node.position.x - 260, y: node.position.y },
        parameters: { lanes: lanesStored(undefined, serializeAutomation(added.document)) },
      } as GraphPatchOperation);
    } else {
      if (automation.label === undefined) return { ok: false, notice: "The automation node has no name, so nothing can reference its lanes. Rename it first." };
      automationName = automation.label;
      operations.push({ op: "setParameters", nodeId: automation.id, parameters: { lanes: lanesStored(automation.parameters["lanes"], serializeAutomation(added.document)) } });
    }
  }
  const reference = `op('${automationName}').chan.${laneName}`;
  operations.push({ op: "setParameters", nodeId: node.id, parameters: { [source.key]: referenceSlot(stored, value, reference) } });
  return { ok: true, operations, lane: laneName, automationName };
}
