import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { isParameterSlot, staticBindingValue } from "../../domain/parameters/slots.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import {
  CONTROL_WIDGET_TYPES,
  controlButtonNode,
  controlChannel,
  controlSliderNode,
  controlToggleNode,
  controlXYNode,
  parsePanelLayout,
} from "../../nodes/definitions/controls.ts";
import {
  PHONE_WRITABLE_KEYS,
  type PhonePanel,
  type PhoneRow,
  type PhoneSet,
  type PhoneSnapshot,
  type PhoneWidget,
} from "./phone-protocol.ts";

/**
 * T1396b — WHAT A PHONE MAY SEE, AND WHETHER WHAT IT SENT MAY BE WRITTEN. The page's half
 * of the phone door's policy, pure and headless: a document in, a snapshot or a patch out.
 *
 * ## One rule decides both, so they cannot disagree
 *
 * `publishedWidgets` is the ONLY place that decides which widget a phone can reach. The
 * snapshot draws from it and the vet checks against it, so a widget the phone was never
 * shown is a widget it cannot write — including one that WAS shown a moment ago on a Panel
 * whose Phone switch has since been turned off, because the vet re-reads the document on
 * every write rather than trusting what it last sent. A handle is the widget node's id: a
 * phone that guesses another node's id reaches the same refusal as one that sends garbage.
 *
 * ## Names resolve exactly as the controls pane resolves them
 *
 * A Panel's layout names widgets by `node.label ?? node.id` against the DOCUMENT graph
 * (`controls-pane.tsx`), so a widget inside a component is invisible to a Panel outside it
 * — T1143's missing publish surface, and the same limitation here on purpose: the phone
 * shows what the pane shows. A name with no widget behind it is dropped (the pane prints
 * "no control named …"; a phone has nothing to do with that line).
 *
 * ## A driven widget is not published
 *
 * A key the document DRIVES (an expression, a bind) is not the user's to move — the
 * editor's own widget draws "driven" and refuses the gesture. The phone contract has no
 * read-only widget, so the simplest correct answer is to leave such a widget out of the
 * snapshot and refuse a write to it. "Driven" here means a slot whose mode is not
 * `static`; a slot in static mode holds a plain value in its static binding and a bare
 * write updates that binding (`apply-patch.ts`, §V108), so it is published like a plain
 * value. Every key the phone reads or writes counts — a slider with an expression on its
 * Max is left out too, because the range the phone would draw is not the range in force.
 * The Panel's own Phone switch follows the same rule: only a plain (or static) `true`
 * publishes it; a switch an expression flips is not a door an expression gets to open.
 */

const nameOf = (node: GraphNode): string => node.label ?? node.id;

/** The plain value behind a stored parameter, or `DRIVEN` when a non-static mode is in force. */
const DRIVEN = Symbol("driven");
function plain(stored: StoredParameter | undefined): unknown {
  if (!isParameterSlot(stored)) return stored;
  return stored.mode === "static" ? staticBindingValue(stored) : DRIVEN;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

type WidgetNode = GraphNode & { readonly type: PhoneWidget["kind"] };

const WIDGET_DEFINITIONS: Readonly<Record<PhoneWidget["kind"], NodeDefinition>> = {
  slider: controlSliderNode,
  toggle: controlToggleNode,
  button: controlButtonNode,
  xyPad: controlXYNode,
};

/**
 * A widget's declared default for a numeric key — one source for what "absent" means,
 * read through the schema funnel (§T903) like every other schema read.
 */
function declared(node: WidgetNode, key: string): number {
  const definition = effectiveParameterSchema(WIDGET_DEFINITIONS[node.type], node.parameters)[key];
  return num(definition !== undefined && "default" in definition ? definition.default : undefined, 0);
}

/** Keys the phone READS per widget type — driven on any of them leaves the widget out. */
const READ_KEYS: Readonly<Record<PhoneWidget["kind"], readonly string[]>> = {
  slider: ["value", "min", "max", "step"],
  toggle: ["on"],
  // `presses` is written by the page on a press edge, so it must not be driven either.
  button: ["held", "presses"],
  xyPad: ["x", "y", "min", "max"],
};

const isWidgetKind = (type: string): type is PhoneWidget["kind"] =>
  CONTROL_WIDGET_TYPES.has(type) && Object.hasOwn(PHONE_WRITABLE_KEYS, type);

function isDriven(node: GraphNode, kind: PhoneWidget["kind"]): boolean {
  return READ_KEYS[kind].some((key) => plain(node.parameters[key]) === DRIVEN);
}

/** A Panel's Phone switch, on only as a plain (or static-mode) `true`. */
export function isRemotePanel(node: GraphNode): boolean {
  return node.type === "panel" && plain(node.parameters["remote"]) === true;
}

/** What the controls pane captions a widget: its Caption, or its channel name. */
function captionOf(node: GraphNode): string {
  const caption = plain(node.parameters["caption"]);
  return typeof caption === "string" && caption !== ""
    ? caption
    : controlChannel(node.parameters as Record<string, unknown>);
}

/** The ordered, lower-first range a widget clamps into (`valueEvaluate`'s own rule). */
function rangeOf(node: WidgetNode): [number, number] {
  const min = num(plain(node.parameters["min"]), declared(node, "min"));
  const max = num(plain(node.parameters["max"]), declared(node, "max"));
  return [Math.min(min, max), Math.max(min, max)];
}

const clamp = (value: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, value));

interface Layout {
  readonly panel: GraphNode;
  /** Rows with each widget name resolved to its node; a name with nothing publishable behind it is gone. */
  readonly rows: ReadonlyArray<
    | { readonly kind: "heading" | "text"; readonly text: string }
    | { readonly kind: "widgets"; readonly nodes: readonly WidgetNode[] }
  >;
}

/** Every remote Panel, its layout resolved against the document the way the pane does it. */
function remoteLayouts(graph: GraphDocument): Layout[] {
  const nodes = Object.values(graph.nodes);
  const byName = new Map(nodes.filter((node) => CONTROL_WIDGET_TYPES.has(node.type)).map((node) => [nameOf(node), node]));
  return nodes.filter(isRemotePanel).map((panel) => {
    const layout = plain(panel.parameters["layout"]);
    return {
      panel,
      rows: parsePanelLayout(typeof layout === "string" ? layout : "").map((row) =>
        row.kind === "widgets"
          ? {
              kind: "widgets" as const,
              nodes: row.names
                .map((name) => byName.get(name))
                .filter((node): node is WidgetNode => node !== undefined && isWidgetKind(node.type) && !isDriven(node, node.type)),
            }
          : row,
      ),
    };
  });
}

/** The one decision: widget node id → node, for every widget a phone may see and move. */
export function publishedWidgets(graph: GraphDocument): Map<NodeId, WidgetNode> {
  const out = new Map<NodeId, WidgetNode>();
  for (const layout of remoteLayouts(graph)) {
    for (const row of layout.rows) if (row.kind === "widgets") for (const node of row.nodes) out.set(node.id, node);
  }
  return out;
}

function phoneWidget(node: WidgetNode): PhoneWidget {
  const handle = node.id;
  const caption = captionOf(node);
  const p = (key: string): unknown => plain(node.parameters[key]);
  switch (node.type) {
    case "slider": {
      const range = rangeOf(node);
      return {
        kind: "slider",
        handle,
        caption,
        // What the channel carries, not a raw value outside the range the phone draws.
        value: clamp(num(p("value"), declared(node, "value")), range),
        min: num(p("min"), declared(node, "min")),
        max: num(p("max"), declared(node, "max")),
        step: Math.max(0, num(p("step"), 0)),
      };
    }
    case "toggle":
      return { kind: "toggle", handle, caption, on: p("on") === true };
    case "button":
      return { kind: "button", handle, caption, held: p("held") === true };
    case "xyPad": {
      const range = rangeOf(node);
      return {
        kind: "xyPad",
        handle,
        caption,
        x: clamp(num(p("x"), declared(node, "x")), range),
        y: clamp(num(p("y"), declared(node, "y")), range),
        min: num(p("min"), declared(node, "min")),
        max: num(p("max"), declared(node, "max")),
      };
    }
  }
}

/** Everything a phone can see, from every Panel whose Phone switch is on. */
export function buildPhoneSnapshot(graph: GraphDocument, seq: number): PhoneSnapshot {
  const panels: PhonePanel[] = remoteLayouts(graph).map(({ panel, rows }) => {
    const title = plain(panel.parameters["title"]);
    return {
      title: typeof title === "string" && title !== "" ? title : nameOf(panel),
      rows: rows.flatMap((row): PhoneRow[] => {
        if (row.kind !== "widgets") return [row];
        const widgets = row.nodes.map(phoneWidget);
        return widgets.length === 0 ? [] : [{ kind: "widgets", widgets }];
      }),
    };
  });
  return { seq, panels };
}

/* ------------------------------------------------------------------ the vet */

/** What a vetted phone write becomes: one `setParameters` on one widget node. */
export type PhoneVet =
  | {
      readonly ok: true;
      readonly nodeId: NodeId;
      readonly kind: PhoneWidget["kind"];
      readonly entries: Readonly<Record<string, number | boolean>>;
      readonly phase: PhoneSet["phase"];
    }
  | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): PhoneVet => ({ ok: false, reason });

/**
 * One phone write, checked against the document as it is NOW.
 *
 * The helper has checked the token; this checks everything else, because the page is the
 * party that owns the document and the only one that can know whether a Panel is still
 * published. Refusal sentences never quote what the phone sent — a key or a handle off
 * the LAN is data, not copy (§V37) — and do name the widget when there is one to name.
 */
export function vetPhoneSet(graph: GraphDocument, set: PhoneSet): PhoneVet {
  if (set.phase !== "live" && set.phase !== "commit") return refuse("A phone sent a write with no gesture phase.");
  const handle = typeof set.handle === "string" ? (set.handle as NodeId) : null;
  const node = handle === null ? undefined : publishedWidgets(graph).get(handle);
  if (node === undefined) {
    // Also where a widget lands whose Panel was just switched off, and a driven widget
    // on a published Panel — told apart here only when the widget really is on one.
    const named = handle === null ? undefined : graph.nodes[handle];
    if (named !== undefined && isWidgetKind(named.type) && isDriven(named, named.type) && namedOnRemotePanel(graph, named)) {
      return refuse(`“${captionOf(named)}” is driven by the document, so a phone cannot move it.`);
    }
    return refuse("A phone tried to move a control that is not published to the phone door.");
  }
  const kind = node.type;
  const caption = captionOf(node);
  const values = typeof set.values === "object" && set.values !== null ? set.values : {};
  const keys = Object.keys(values);
  if (keys.length === 0) return refuse(`A phone's write to “${caption}” carried no values.`);
  const writable: readonly string[] = PHONE_WRITABLE_KEYS[kind];
  if (!keys.every((key) => writable.includes(key))) {
    return refuse(`A phone tried to write a key a ${kind} does not let a phone write, on “${caption}”.`);
  }

  const p = (key: string): unknown => plain(node.parameters[key]);
  const number = (key: string): number | null => {
    const value = values[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const flag = (key: string): boolean | null => {
    const value = values[key];
    return typeof value === "boolean" ? value : null;
  };
  const ok = (entries: Record<string, number | boolean>): PhoneVet => ({ ok: true, nodeId: node.id, kind, entries, phase: set.phase });
  const notNumber = refuse(`A phone sent “${caption}” something that is not a finite number.`);
  const notFlag = refuse(`A phone sent “${caption}” something that is not true or false.`);

  switch (kind) {
    case "slider": {
      const value = number("value");
      if (value === null) return notNumber;
      const step = Math.max(0, num(p("step"), 0));
      const snapped = step > 0 ? Math.round(value / step) * step : value;
      return ok({ value: clamp(snapped, rangeOf(node)) });
    }
    case "xyPad": {
      const range = rangeOf(node);
      const entries: Record<string, number> = {};
      for (const key of keys) {
        const value = number(key);
        if (value === null) return notNumber;
        entries[key] = clamp(value, range);
      }
      return ok(entries);
    }
    case "toggle": {
      const on = flag("on");
      return on === null ? notFlag : ok({ on });
    }
    case "button": {
      const held = flag("held");
      if (held === null) return notFlag;
      const presses = num(p("presses"), declared(node, "presses"));
      // A press is counted on the false→true EDGE only: a repeated `held: true` from a
      // phone (or a phone pressing a button the person at the desk is already holding)
      // is not a second press. Both keys every time, so press and release are one
      // gesture identity in the parameter editor — ONE undo group per press (§V15).
      return ok({ held, presses: held && p("held") !== true ? presses + 1 : presses });
    }
  }
}

function namedOnRemotePanel(graph: GraphDocument, widget: GraphNode): boolean {
  const name = nameOf(widget);
  return Object.values(graph.nodes).some((node) => {
    if (!isRemotePanel(node)) return false;
    const layout = plain(node.parameters["layout"]);
    return parsePanelLayout(typeof layout === "string" ? layout : "").some((row) => row.kind === "widgets" && row.names.includes(name));
  });
}
