import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { incomingEdgesInOrder } from "../../domain/graph/edge-order.ts";
import { isParameterSlot, staticBindingValue } from "../../domain/parameters/slots.ts";
import { VALUE_PORT } from "./common-ports.ts";

const noPasses = (): CompiledNodeDescription => ({ passes: [] });

/**
 * T1388b — LIVE CONTROLS: widget nodes and the Panel that lays them out (TouchDesigner's
 * Slider / Button COMPs and their container, in this app's node idiom).
 *
 * A widget is a VALUE node whose value is set by hand: its channel carries what the control
 * shows, under a name the user picks (`heat`, `glitch`), so any parameter anywhere reads it
 * the way it reads any channel — `op('slider1').chan.heat` — and one control can drive many
 * things. The node's own body on the canvas IS the control (`control-widget.tsx`), and a
 * Panel gathers the widgets wired into it into a performance surface — drawn on its own
 * body, bigger in the Controls tab, and on a phone when published (T1512b, `panelLayout`).
 *
 * Headless like every definition (§V11): the value lives in parameters; the UI writes them
 * through the command bus, one undo group per gesture (`createParameterEditor`).
 */

const str = (value: unknown, fallback: string): string => (typeof value === "string" && value !== "" ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A channel name must be an identifier, or nothing downstream can address it. */
export function controlChannel(values: Readonly<Record<string, unknown>>): string {
  const name = str(values["channel"], "value");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "value";
}

const channelParameter = {
  type: "string" as const,
  label: "Channel",
  default: "value",
  description: "The name this control publishes under — what a parameter reads: op('<node>').chan.<channel>.",
};
const captionParameter = {
  type: "string" as const,
  label: "Caption",
  default: "",
  description: "What the control says on a panel. Empty: the channel name.",
};

export const controlSliderNode: NodeDefinition = {
  type: "slider",
  version: 1,
  title: "Slider",
  category: "value",
  description:
    "A hand-set number between Min and Max, published under its Channel name. Drag it on the canvas or on a Panel; map it to any parameter. CLOCKLESS: it changes only when someone moves it.",
  tags: ["control", "slider", "fader", "knob", "ui", "panel", "live", "perform"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    channel: channelParameter,
    caption: captionParameter,
    value: { type: "number", label: "Value", default: 0.5 },
    min: { type: "number", label: "Min", default: 0 },
    max: { type: "number", label: "Max", default: 1 },
    step: { type: "number", label: "Step", default: 0, min: 0, range: "floor", description: "0 is continuous; above 0 the slider snaps to multiples of it." },
  },
  valueEvaluate: ({ values }) => {
    const lo = num(values["min"], 0);
    const hi = num(values["max"], 1);
    const v = num(values["value"], 0.5);
    return { [controlChannel(values)]: Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), v)) };
  },
  compile: noPasses,
};

export const controlToggleNode: NodeDefinition = {
  type: "toggle",
  version: 1,
  title: "Toggle",
  category: "value",
  description: "On or off, published under its Channel name as 1 or 0. CLOCKLESS.",
  tags: ["control", "toggle", "switch", "checkbox", "ui", "panel", "live", "perform"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    channel: channelParameter,
    caption: captionParameter,
    on: { type: "boolean", label: "On", default: false },
  },
  valueEvaluate: ({ values }) => ({ [controlChannel(values)]: values["on"] === true ? 1 : 0 }),
  compile: noPasses,
};

export const controlButtonNode: NodeDefinition = {
  type: "button",
  version: 1,
  title: "Button",
  category: "value",
  description:
    "A momentary button: its Channel is 1 while held, and <channel>Count counts the presses (a Count or Expression downstream can fire on a change). CLOCKLESS.",
  tags: ["control", "button", "trigger", "momentary", "bang", "ui", "panel", "live", "perform"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    channel: channelParameter,
    caption: captionParameter,
    held: { type: "boolean", label: "Held", default: false, description: "Set while the button is pressed." },
    presses: { type: "number", label: "Presses", default: 0, min: 0, range: "floor", step: 1 },
  },
  valueEvaluate: ({ values }) => {
    const name = controlChannel(values);
    return { [name]: values["held"] === true ? 1 : 0, [`${name}Count`]: num(values["presses"], 0) };
  },
  compile: noPasses,
};

export const controlXYNode: NodeDefinition = {
  type: "xyPad",
  version: 1,
  title: "XY Pad",
  category: "value",
  description: "Two numbers from one drag, published as <channel>X and <channel>Y, each between Min and Max. CLOCKLESS.",
  tags: ["control", "xy", "pad", "2d", "ui", "panel", "live", "perform"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    channel: channelParameter,
    caption: captionParameter,
    x: { type: "number", label: "X", default: 0.5 },
    y: { type: "number", label: "Y", default: 0.5 },
    min: { type: "number", label: "Min", default: 0 },
    max: { type: "number", label: "Max", default: 1 },
  },
  valueEvaluate: ({ values }) => {
    const name = controlChannel(values);
    const lo = num(values["min"], 0);
    const hi = num(values["max"], 1);
    const clamp = (v: number): number => Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), v));
    return { [`${name}X`]: clamp(num(values["x"], 0.5)), [`${name}Y`]: clamp(num(values["y"], 0.5)) };
  },
  compile: noPasses,
};

/** One row of a Panel's layout: a heading, a line of text, or widgets side by side. */
export type PanelRow =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "widgets"; readonly names: readonly string[] };

/**
 * A Panel's layout, one row per line: `# Heading`, `> a line of text`, or widget node names
 * separated by spaces or commas (shown side by side). Blank lines are spacing, dropped.
 */
export function parsePanelLayout(layout: string): PanelRow[] {
  return layout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line): PanelRow => {
      if (line.startsWith("#")) return { kind: "heading", text: line.replace(/^#+\s*/, "") };
      if (line.startsWith(">")) return { kind: "text", text: line.replace(/^>\s*/, "") };
      return { kind: "widgets", names: line.split(/[\s,]+/).filter((name) => name !== "") };
    });
}

/**
 * T1512b — the Panel's one input: every widget wired in joins it, in wiring order. A
 * VARIADIC value port (§V131) rather than a new "many wires into one socket" idea: the
 * edge `order` the patch layer already keeps dense is the order on the Panel, and
 * `reorderEdges` is how the Panel rearranges its members — one patch, undoable.
 */
export const PANEL_INPUT = "controls";

/** The layout text a fresh Panel carried before T1512b: a heading and no controls — never an override. */
const LEGACY_DEFAULT_LAYOUT = "# Controls";

export const controlPanelNode: NodeDefinition = {
  type: "panel",
  version: 1,
  title: "Panel",
  category: "value",
  description:
    "A performance surface: wire Slider, Toggle, Button and XY Pad nodes into Controls (or drop one on the Panel) and they show on the Panel's body, in the Controls tab and, with Phone on, on a phone — in wiring order.",
  tags: ["control", "panel", "ui", "surface", "perform", "live", "dashboard"],
  inputs: [{ id: PANEL_INPUT, label: "Controls", type: VALUE_PORT, optional: true, variadic: true }],
  outputs: [],
  parameters: {
    title: { type: "string", label: "Title", default: "Controls" },
    // T1512b: an ADVANCED override, collapsed in the inspector. Empty = the wiring decides.
    layout: {
      type: "string",
      label: "Layout",
      group: "Advanced",
      default: "",
      multiline: true,
      description:
        "Optional: replaces the wiring order. One row per line: `# Heading`, `> a note`, or widget node names side by side.",
    },
    // T1396b: the phone door publishes a Panel only when this is on. Absent in a document
    // saved before it existed = off, which is what the default says, so no migration.
    remote: {
      type: "boolean",
      label: "Phone",
      default: false,
      description:
        "Publishes this panel to the phone door: a phone paired from the Panel's phone icon sees these controls and can move them, and nothing else in the project.",
    },
  },
  compile: noPasses,
};

export const controlNodeDefinitions: readonly NodeDefinition[] = [
  controlSliderNode,
  controlToggleNode,
  controlButtonNode,
  controlXYNode,
  controlPanelNode,
];

/** Widget types a Panel lays out. */
export const CONTROL_WIDGET_TYPES: ReadonlySet<string> = new Set(["slider", "toggle", "button", "xyPad"]);

/* ------------------------------------------------------------ membership */

/** A stored parameter's plain value: a static-mode slot is its static binding, a driven one is nothing. */
function plainValue(stored: StoredParameter | undefined): unknown {
  if (!isParameterSlot(stored)) return stored;
  return stored.mode === "static" ? staticBindingValue(stored) : undefined;
}

/** What a widget or Panel is called on a surface: the node's label, or its id. */
export const controlNameOf = (node: GraphNode): string => node.label ?? node.id;

/** A Panel's title as every surface shows it: its Title, or the node's name. */
export function panelTitle(panel: GraphNode): string {
  const title = plainValue(panel.parameters["title"]);
  return typeof title === "string" && title !== "" ? title : controlNameOf(panel);
}

/**
 * The layout text when it OVERRIDES the wiring, else null. Empty and the pre-T1512b default
 * (a lone `# Controls` heading) are not overrides — a fresh Panel follows its wires — and a
 * driven layout is not one either: an expression does not lay a Panel out.
 */
export function panelLayoutOverride(panel: GraphNode): string | null {
  const layout = plainValue(panel.parameters["layout"]);
  if (typeof layout !== "string") return null;
  const trimmed = layout.trim();
  return trimmed === "" || trimmed === LEGACY_DEFAULT_LAYOUT ? null : layout;
}

/** One place on a Panel row: a widget node, or an override name with no widget behind it. */
export type PanelCell =
  | { readonly kind: "widget"; readonly node: GraphNode }
  | { readonly kind: "missing"; readonly name: string };

/** A Panel row, resolved against the document. */
export type PanelSection =
  | { readonly kind: "heading" | "text"; readonly text: string }
  | { readonly kind: "widgets"; readonly cells: readonly PanelCell[] };

export interface PanelLayout {
  /** `wiring`: the widgets wired into Controls; `layout`: the override text decides. */
  readonly source: "wiring" | "layout";
  readonly rows: readonly PanelSection[];
}

/**
 * T1512b — WHAT A PANEL SHOWS, AND IN WHAT ORDER: the ONE derivation behind the Panel's
 * canvas body, the Controls tab and the phone snapshot (`phone-snapshot.ts`), so the three
 * cannot disagree about a Panel's members or their order.
 *
 * With no override the members are the widget nodes wired into `controls`, in edge order
 * (`incomingEdgesInOrder`, §V68/§V131), as one row the surface flows; a non-widget source
 * and a second wire from the same widget add nothing. With an override the text wins,
 * exactly as it read before T1512b — names resolve by `label ?? id` against this graph —
 * so a document laid out by text shows what it showed, with no migration.
 */
export function panelLayout(graph: Pick<GraphDocument, "nodes" | "edges">, panel: GraphNode): PanelLayout {
  const override = panelLayoutOverride(panel);
  if (override === null) {
    const seen = new Set<string>();
    const cells: PanelCell[] = [];
    for (const edge of incomingEdgesInOrder(graph, panel.id, PANEL_INPUT)) {
      const node = graph.nodes[edge.source.nodeId];
      if (node === undefined || !CONTROL_WIDGET_TYPES.has(node.type) || seen.has(node.id)) continue;
      seen.add(node.id);
      cells.push({ kind: "widget", node });
    }
    return { source: "wiring", rows: cells.length === 0 ? [] : [{ kind: "widgets", cells }] };
  }
  const byName = new Map(
    Object.values(graph.nodes)
      .filter((node) => CONTROL_WIDGET_TYPES.has(node.type))
      .map((node) => [controlNameOf(node), node]),
  );
  return {
    source: "layout",
    rows: parsePanelLayout(override).map((row): PanelSection => {
      if (row.kind !== "widgets") return row;
      return {
        kind: "widgets",
        cells: row.names.map((name): PanelCell => {
          const node = byName.get(name);
          return node === undefined ? { kind: "missing", name } : { kind: "widget", node };
        }),
      };
    }),
  };
}

/** The widget nodes on a Panel, in the order it shows them. */
export function panelMembers(graph: Pick<GraphDocument, "nodes" | "edges">, panel: GraphNode): GraphNode[] {
  return panelLayout(graph, panel).rows.flatMap((row) =>
    row.kind === "widgets" ? row.cells.flatMap((cell) => (cell.kind === "widget" ? [cell.node] : [])) : [],
  );
}
