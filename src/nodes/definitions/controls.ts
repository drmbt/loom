import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { VALUE_PORT } from "./common-ports.ts";

const noPasses = (): CompiledNodeDescription => ({ passes: [] });

/**
 * T1388b — LIVE CONTROLS: widget nodes and the Panel that lays them out (TouchDesigner's
 * Slider / Button COMPs and their container, in this app's node idiom).
 *
 * A widget is a VALUE node whose value is set by hand: its channel carries what the control
 * shows, under a name the user picks (`heat`, `glitch`), so any parameter anywhere reads it
 * the way it reads any channel — `op('slider1').chan.heat` — and one control can drive many
 * things. The node's own body on the canvas IS the control (`control-widgets.tsx`), and a
 * Panel names widgets in rows to build a performance surface shown in the controls pane.
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

export const controlPanelNode: NodeDefinition = {
  type: "panel",
  version: 1,
  title: "Panel",
  category: "value",
  description:
    "A performance surface: widget nodes (Slider, Toggle, Button, XY Pad) laid out in rows under headings and notes, shown in the controls pane. Layout, one row per line: `# Heading`, `> a note`, or widget names side by side (`heat glitch cut`).",
  tags: ["control", "panel", "ui", "surface", "perform", "live", "dashboard"],
  inputs: [],
  outputs: [],
  parameters: {
    title: { type: "string", label: "Title", default: "Controls" },
    layout: {
      type: "string",
      label: "Layout",
      default: "# Controls\n",
      multiline: true,
      description: "One row per line: `# Heading`, `> a note`, or widget node names side by side.",
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
