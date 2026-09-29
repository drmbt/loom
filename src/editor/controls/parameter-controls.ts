import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ParameterDefinition, ParameterSlot, ParameterValue, StoredParameter } from "@domain/types/parameters.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import {
  componentAddressedDefinition,
  componentKey,
  componentNamesFor,
  isParameterSlot,
  staticBindingValue,
  storedStaticValue,
  withMode,
} from "@domain/parameters/slots.ts";
import { nodeNames, renumberedName, uniqueNodeName } from "@domain/graph/names.ts";
import { boxesOverlap, nodeBox, NODE_WIDTH } from "@domain/graph/node-box.ts";
import { CONTROL_WIDGET_TYPES, controlChannel, controlNameOf, panelTitle } from "@nodes/definitions/controls.ts";
import { joinPanelOperations } from "./panel-join.ts";

/**
 * T1514b — MAPPING STARTS FROM THE PARAMETER, as patch operations.
 *
 * The owner ruled that a person maps a control by right-clicking the parameter they want
 * to move, not by starting at a control and hunting for a raw parameter id. Everything that
 * gesture needs is here, pure, so the Inspector's menu, its "← Heat" chip, the Controls
 * cards' chips and the bus commands (`control-commands.ts`) are one implementation:
 *
 * - `controlFromParameterPlan`: the fitting control (slider / toggle / XY pad) built from
 *   the parameter's own range and value, bound, and wired onto a Panel — ONE patch.
 * - `bindParameterPlan`: an existing control's channel bound to the parameter.
 * - `unbindOperations`: back to Constant, holding the value it retained (§V108).
 *
 * A binding is the idiom the controls always used (T1388b): an expression slot reading the
 * control's channel, `op('<name>').chan.<channel>`, with the static value kept beside it. A
 * 2-vector binds per component (§V113), `pintr.x` / `pintr.y`, as E81 does.
 */

type Graph = Pick<GraphDocument, "nodes" | "edges">;

/** What a widget says on a surface: its Caption, or its channel name. */
export function controlCaptionOf(node: GraphNode): string {
  const caption = storedStaticValue(node.parameters["caption"]);
  return typeof caption === "string" && caption !== "" ? caption : controlChannel(plainValues(node));
}

function plainValues(node: GraphNode): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node.parameters).map(([key, stored]) => [key, storedStaticValue(stored)]));
}

/** The expression that reads one channel of a control. */
export const controlReadSource = (controlName: string, channel: string): string => `op('${controlName}').chan.${channel}`;

/** The control widget an ACTIVE expression slot reads, or null. */
export function controlReadBy(graph: Graph, stored: StoredParameter | undefined): GraphNode | null {
  if (!isParameterSlot(stored) || stored.mode !== "expression") return null;
  const expression = stored.bindings.expression;
  if (expression?.kind !== "expression") return null;
  for (const node of Object.values(graph.nodes)) {
    if (CONTROL_WIDGET_TYPES.has(node.type) && expression.source.includes(`op('${controlNameOf(node)}')`)) return node;
  }
  return null;
}

function definitionFor(graph: Graph, registry: NodeRegistryView, nodeId: NodeId, key: string): ParameterDefinition | undefined {
  const node = graph.nodes[nodeId];
  if (node === undefined) return undefined;
  const schema = effectiveParameterSchema(registry.get(node.type), node.parameters);
  return schema[key] ?? componentAddressedDefinition(schema, key);
}

/** The keys one Inspector row stands for: the parameter, and its components when compound (§V113). */
function rowKeys(definition: ParameterDefinition | undefined, key: string): string[] {
  const names = definition === undefined ? null : componentNamesFor(definition);
  return names === null ? [key] : [key, ...names.map((name) => componentKey(key, name))];
}

/** One key of a row that a control drives, and the control. */
export interface BoundControl {
  readonly key: string;
  readonly control: GraphNode;
}

/** Every key of the row `key` whose active expression reads a control widget. */
export function boundControls(graph: Graph, registry: NodeRegistryView, nodeId: NodeId, key: string): BoundControl[] {
  const node = graph.nodes[nodeId];
  if (node === undefined) return [];
  const found: BoundControl[] = [];
  for (const each of rowKeys(definitionFor(graph, registry, nodeId, key), key)) {
    const control = controlReadBy(graph, node.parameters[each]);
    if (control !== null) found.push({ key: each, control });
  }
  return found;
}

/**
 * T1513b/T1514b — THE ONE UNBIND, shared by the Controls cards' chips, the Inspector's
 * "← Heat" chip and `control.unbindParameter`: each key goes back to Constant holding the
 * value it retained (§V108 — the expression stays retained in its slot, as any mode switch
 * leaves it). A slot with no retained constant falls back to the declared default, which
 * is what the parameter showed before anything drove it. One operation, so one undo.
 */
export function unbindOperations(graph: Graph, registry: NodeRegistryView, nodeId: NodeId, keys: readonly string[]): GraphPatchOperation[] {
  const node = graph.nodes[nodeId];
  if (node === undefined) return [];
  const parameters: Record<string, StoredParameter> = {};
  for (const key of keys) {
    const stored = node.parameters[key];
    if (!isParameterSlot(stored) || stored.mode === "static") continue;
    const declared = definitionFor(graph, registry, nodeId, key);
    const fallback = staticBindingValue(stored) ?? (declared !== undefined && "default" in declared ? (declared.default as ParameterValue) : 0);
    const slot = withMode(stored, "static", fallback);
    if (slot !== null) parameters[key] = slot;
  }
  return Object.keys(parameters).length === 0 ? [] : [{ op: "setParameters", nodeId, parameters }];
}

/**
 * The slot that makes a parameter read a control — the shape the old "map…" form wrote:
 * expression mode, every other binding kept, and the value it holds now RETAINED as its
 * static binding, so letting go of the control lands on the number it had.
 */
export function controlSlot(stored: StoredParameter | undefined, source: string, current: ParameterValue): ParameterSlot {
  return {
    mode: "expression",
    bindings: {
      ...(isParameterSlot(stored) ? stored.bindings : {}),
      static: { kind: "static", value: isParameterSlot(stored) ? (staticBindingValue(stored) ?? current) : (stored ?? current) },
      expression: { kind: "expression", source },
    },
  };
}

/** "Hue Offset" → `hueOffset`: a channel name is an identifier, or nothing can read it. */
export function channelFromLabel(label: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  if (words.length === 0) return "value";
  const joined = words
    .map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
  return /^[A-Za-z_]/.test(joined) ? joined : `p${joined}`;
}

/** The value a row shows now: its static view, or the declared default. */
function currentScalar(stored: StoredParameter | undefined, fallback: ParameterValue): ParameterValue {
  return storedStaticValue(stored) ?? fallback;
}

function currentVector(node: GraphNode, key: string, definition: ParameterDefinition & { type: "vector" }): number[] {
  const base = storedStaticValue(node.parameters[key]);
  const names = componentNamesFor(definition) ?? [];
  return names.map((name, index) => {
    const component = storedStaticValue(node.parameters[componentKey(key, name)]);
    if (typeof component === "number") return component;
    const fromBase = Array.isArray(base) ? base[index] : undefined;
    return typeof fromBase === "number" ? fromBase : (definition.default[index] ?? 0);
  });
}

/**
 * The control's travel: the parameter's own min/max (§B111 — min/max are the SLIDER's
 * travel whichever ends clamp), 0..1 where nothing is declared, and never narrower than
 * the value it holds now — a control that could not reach the current value would move it
 * the moment it was bound.
 */
export function controlRange(definition: { readonly min?: number | undefined; readonly max?: number | undefined }, values: readonly number[]): { min: number; max: number } {
  const min = definition.min ?? (definition.max === undefined ? 0 : Math.min(0, definition.max - 1));
  const max = definition.max ?? Math.max(min + 1, 1);
  return { min: Math.min(min, ...values), max: Math.max(max, ...values) };
}

const COLUMN_GAP = 80;
const ROW_GAP = 40;

/**
 * A spot for a new node of `type` beside `anchor` (left of it, top-aligned), stepping down
 * past every box it would cover — `placeFree`'s collision rule at `placeRelative`'s anchor,
 * so a control lands next to the thing it drives and never on top of anything (§V389).
 */
function spotBeside(graph: Graph, registry: NodeRegistryView, type: string, anchor: { x: number; y: number }, extra: readonly GraphNode[]): { x: number; y: number } {
  const others = [...Object.values(graph.nodes), ...extra];
  const boxes = others.map((node) => nodeBox(node, registry.get(node.type), undefined, graph));
  const probe = { id: "placement-probe", type, definitionVersion: 1, position: { x: anchor.x - NODE_WIDTH - COLUMN_GAP, y: anchor.y }, parameters: {} } as GraphNode;
  let candidate = nodeBox(probe, registry.get(type));
  for (let step = 0; step < boxes.length + 1; step += 1) {
    const hit = boxes.find((box) => boxesOverlap(candidate, box));
    if (hit === undefined) break;
    candidate = { ...candidate, y: hit.y + hit.height + ROW_GAP };
  }
  return { x: candidate.x, y: candidate.y };
}

export type ControlPlan =
  | { readonly ok: true; readonly label: string; readonly operations: GraphPatchOperation[] }
  | { readonly ok: false; readonly code: string; readonly reason: string };

const refuse = (code: string, reason: string): ControlPlan => ({ ok: false, code, reason });

const WIDGET_REF = "$control";
const PANEL_REF = "$panel";

/** Which control fits a parameter, or why none does. */
export function controlTypeFor(definition: ParameterDefinition): "slider" | "toggle" | "xyPad" | null {
  if (definition.type === "number") return "slider";
  if (definition.type === "boolean") return "toggle";
  if (definition.type === "vector" && definition.size === 2) return "xyPad";
  return null;
}

const NO_CONTROL_REASON =
  "A Panel control drives a number (slider), an on/off (toggle) or a 2-vector (XY pad).";

/**
 * T1514b — "Control from Panel": the fitting control, bound, on a Panel, in ONE patch.
 *
 * - number → Slider with the parameter's own min/max/step and its current value;
 *   boolean → Toggle in its current state; 2-vector → XY Pad, both components bound.
 * - caption = the parameter's label, channel = an identifier from it, node name = the
 *   channel (renumbered when taken, §V129), so the binding reads `op('brightness').chan.brightness`.
 * - the Panel: `panelId` when given; else the document's only Panel; else a new one
 *   titled "Controls". Several Panels and none named is refused — there is no one answer.
 */
export function controlFromParameterPlan(
  graph: Graph,
  registry: NodeRegistryView,
  nodeId: NodeId,
  key: string,
  panelId?: NodeId,
): ControlPlan {
  const node = graph.nodes[nodeId];
  if (node === undefined) return refuse("control.node", `No node "${nodeId}".`);
  const definition = definitionFor(graph, registry, nodeId, key);
  if (definition === undefined) return refuse("control.parameter", `"${controlNameOf(node)}" has no parameter "${key}".`);
  const type = controlTypeFor(definition);
  if (type === null) return refuse("control.unsupported", `"${definition.label}" is a ${definition.type} parameter. ${NO_CONTROL_REASON}`);

  const panels = Object.values(graph.nodes).filter((each) => each.type === "panel");
  let panel: GraphNode | null = null;
  if (panelId !== undefined) {
    panel = graph.nodes[panelId] ?? null;
    if (panel === null || panel.type !== "panel") return refuse("control.panel", `"${panelId}" is not a Panel.`);
  } else if (panels.length === 1) {
    panel = panels[0] as GraphNode;
  } else if (panels.length > 1) {
    return refuse("control.panelAmbiguous", `There are ${panels.length} Panels — name the one the control joins.`);
  }

  const taken = new Set(nodeNames(graph as GraphDocument).keys());
  const panelName = panel === null ? uniqueNodeName(graph as GraphDocument, "panel") : null;
  if (panelName !== null) taken.add(panelName);
  const channel = channelFromLabel(definition.label || key);
  const name = taken.has(channel) ? renumberedName(channel, (candidate) => taken.has(candidate)) : channel;
  const read = (published: string) => controlReadSource(name, published);
  const stored = node.parameters[key];

  let widget: Record<string, StoredParameter>;
  let bindings: Record<string, StoredParameter>;
  if (type === "slider") {
    const def = definition as ParameterDefinition & { type: "number" };
    const raw = currentScalar(stored, def.default);
    const value = typeof raw === "number" ? raw : def.default;
    widget = { channel, caption: definition.label, value, ...controlRange(def, [value]), step: def.step ?? 0 };
    bindings = { [key]: controlSlot(stored, read(channel), value) };
  } else if (type === "toggle") {
    const def = definition as ParameterDefinition & { type: "boolean" };
    const on = currentScalar(stored, def.default) === true;
    widget = { channel, caption: definition.label, on };
    bindings = { [key]: controlSlot(stored, read(channel), on) };
  } else {
    const def = definition as ParameterDefinition & { type: "vector" };
    const [x = 0, y = 0] = currentVector(node, key, def);
    widget = { channel, caption: definition.label, x, y, ...controlRange(def, [x, y]) };
    const xKey = componentKey(key, "x");
    const yKey = componentKey(key, "y");
    bindings = {
      [xKey]: controlSlot(node.parameters[xKey], read(`${channel}X`), x),
      [yKey]: controlSlot(node.parameters[yKey], read(`${channel}Y`), y),
    };
  }

  const widgetAt = spotBeside(graph, registry, type, node.position, []);
  const provisional = { id: WIDGET_REF, type, definitionVersion: 1, position: widgetAt, parameters: widget, label: name } as GraphNode;
  const operations: GraphPatchOperation[] = [{ op: "addNode", ref: WIDGET_REF, type, position: widgetAt, parameters: widget, label: name }];
  let panelRef: NodeId;
  let withNew: Graph = { nodes: { ...graph.nodes, [WIDGET_REF]: provisional }, edges: graph.edges };
  if (panel === null) {
    const panelAt = spotBeside(graph, registry, "panel", widgetAt, [provisional]);
    operations.push({ op: "addNode", ref: PANEL_REF, type: "panel", position: panelAt, parameters: { title: "Controls" }, label: panelName as string });
    const provisionalPanel = { id: PANEL_REF, type: "panel", definitionVersion: 1, position: panelAt, parameters: { title: "Controls" } } as GraphNode;
    withNew = { nodes: { ...withNew.nodes, [PANEL_REF]: provisionalPanel }, edges: graph.edges };
    panelRef = PANEL_REF;
  } else {
    panelRef = panel.id;
  }
  // Membership is wiring (T1512b): the SAME join the canvas drop and "+ panel" use, asked
  // about the graph as it will be once the new nodes exist.
  operations.push(...joinPanelOperations(withNew, WIDGET_REF, panelRef));
  operations.push({ op: "setParameters", nodeId, parameters: bindings });
  return { ok: true, label: `Control ${definition.label} from Panel`, operations };
}

/** One channel a control publishes, as "Drive from" offers it. */
export interface ControlChannelChoice {
  /** The published channel name, `warpX`. */
  readonly channel: string;
  /** What the menu calls it beside the caption: "X", "held", "count" — or the caption alone. */
  readonly label: string;
}

/** The channels a control publishes, in the order "Drive from" lists them. */
export function controlChannelChoices(control: GraphNode): ControlChannelChoice[] {
  const channel = controlChannel(plainValues(control));
  switch (control.type) {
    case "xyPad":
      return [
        { channel: `${channel}X`, label: "X" },
        { channel: `${channel}Y`, label: "Y" },
      ];
    case "button":
      return [
        { channel, label: "held" },
        { channel: `${channel}Count`, label: "count" },
      ];
    default:
      return [{ channel, label: controlCaptionOf(control) }];
  }
}

/** The controls a parameter of `nodeId` may be driven from: every widget but the node itself. */
export function driveCandidates(graph: Graph, nodeId: NodeId | undefined): GraphNode[] {
  return Object.values(graph.nodes)
    .filter((node) => CONTROL_WIDGET_TYPES.has(node.type) && node.id !== nodeId)
    .sort((a, b) => controlCaptionOf(a).localeCompare(controlCaptionOf(b)));
}

/**
 * T1514b — "Drive from ▸ <control>": bind an EXISTING control's channel to the parameter.
 * A number or on/off reads one channel; a 2-vector reads an XY pad whole, X and Y per
 * component, with `channel` omitted.
 */
export function bindParameterPlan(
  graph: Graph,
  registry: NodeRegistryView,
  nodeId: NodeId,
  key: string,
  controlId: NodeId,
  channel?: string,
): ControlPlan {
  const node = graph.nodes[nodeId];
  if (node === undefined) return refuse("control.node", `No node "${nodeId}".`);
  const definition = definitionFor(graph, registry, nodeId, key);
  if (definition === undefined) return refuse("control.parameter", `"${controlNameOf(node)}" has no parameter "${key}".`);
  const control = graph.nodes[controlId];
  if (control === undefined || !CONTROL_WIDGET_TYPES.has(control.type)) return refuse("control.control", `"${controlId}" is not a control.`);
  if (control.id === nodeId) return refuse("control.self", "A control cannot drive its own parameters.");
  const type = controlTypeFor(definition);
  if (type === null) return refuse("control.unsupported", `"${definition.label}" is a ${definition.type} parameter. ${NO_CONTROL_REASON}`);
  const name = controlNameOf(control);
  const label = `Drive ${definition.label} from ${controlCaptionOf(control)}`;

  if (type === "xyPad") {
    if (control.type !== "xyPad") return refuse("control.shape", `"${definition.label}" is a 2-vector — an XY pad drives it.`);
    const def = definition as ParameterDefinition & { type: "vector" };
    const [x = 0, y = 0] = currentVector(node, key, def);
    const published = controlChannel(plainValues(control));
    const xKey = componentKey(key, "x");
    const yKey = componentKey(key, "y");
    return {
      ok: true,
      label,
      operations: [
        {
          op: "setParameters",
          nodeId,
          parameters: {
            [xKey]: controlSlot(node.parameters[xKey], controlReadSource(name, `${published}X`), x),
            [yKey]: controlSlot(node.parameters[yKey], controlReadSource(name, `${published}Y`), y),
          },
        },
      ],
    };
  }
  const choices = controlChannelChoices(control);
  const choice = channel === undefined && choices.length === 1 ? choices[0] : choices.find((each) => each.channel === channel);
  if (choice === undefined) {
    return refuse("control.channel", `"${name}" publishes ${choices.map((each) => each.channel).join(", ")} — name one.`);
  }
  const stored = node.parameters[key];
  const current = currentScalar(stored, "default" in definition ? (definition.default as ParameterValue) : 0);
  return {
    ok: true,
    label,
    operations: [{ op: "setParameters", nodeId, parameters: { [key]: controlSlot(stored, controlReadSource(name, choice.channel), current) } }],
  };
}

/** A Panel as the "Control from Panel" submenu lists it. */
export function panelChoices(graph: Graph): { readonly id: NodeId; readonly title: string }[] {
  return Object.values(graph.nodes)
    .filter((node) => node.type === "panel")
    .map((node) => ({ id: node.id, title: panelTitle(node) }));
}
