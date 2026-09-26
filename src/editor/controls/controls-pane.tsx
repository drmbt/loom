import { useEffect, useMemo, useState } from "react";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { isParameterSlot, storedStaticValue } from "@domain/parameters/slots.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { CONTROL_WIDGET_TYPES, controlChannel, parsePanelLayout, type PanelRow } from "@nodes/definitions/controls.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import styles from "./controls-pane.module.css";

/**
 * T1388b — THE CONTROLS PANE: a Panel node's layout as a performance surface.
 *
 * Headings, notes and rows of widgets, each one the live control of its node (drag it here
 * or on the canvas; both are the same parameters). Under every widget: what it drives — the
 * parameters that read its channel — and a "map" form that makes one more parameter read
 * it, as an ordinary expression slot (`op('fader1').chan.heat`), one patch, undoable.
 *
 * With no Panel in the document the pane still works: it lays out every widget there is, so
 * dropping a Slider on the canvas is already a control you can perform with.
 */

export interface ControlsPaneProps {
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
}

const nameOf = (node: GraphNode): string => node.label ?? node.id;

/** The channels a widget publishes — the X/Y pair for a pad. */
function channelsOf(node: GraphNode): string[] {
  const channel = controlChannel(node.parameters as Record<string, unknown>);
  return node.type === "xyPad" ? [`${channel}X`, `${channel}Y`] : node.type === "button" ? [channel, `${channel}Count`] : [channel];
}

/** Every parameter in the document whose expression reads this widget: `node.parameter`. */
function targetsOf(graph: GraphDocument, widget: GraphNode): string[] {
  const needle = `op('${nameOf(widget)}')`;
  const found: string[] = [];
  for (const node of Object.values(graph.nodes)) {
    for (const [key, stored] of Object.entries(node.parameters)) {
      if (!isParameterSlot(stored)) continue;
      const expression = stored.bindings.expression;
      if (stored.mode === "expression" && expression?.kind === "expression" && expression.source.includes(needle)) found.push(`${nameOf(node)}.${key}`);
    }
  }
  return found;
}

function MapForm({ graph, registry, widget, onMap }: { graph: GraphDocument; registry: NodeRegistryView; widget: GraphNode; onMap: (target: NodeId, key: string, channel: string) => void }) {
  const candidates = useMemo(
    () => Object.values(graph.nodes).filter((node) => node.id !== widget.id && node.type !== "panel").sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    [graph, widget.id],
  );
  const [target, setTarget] = useState<string>("");
  const [key, setKey] = useState<string>("");
  const channels = channelsOf(widget);
  const [channel, setChannel] = useState<string>(channels[0]!);
  const node = graph.nodes[target];
  const definition = node === undefined ? undefined : registry.get(node.type);
  const numeric =
    node === undefined || definition === undefined
      ? []
      : Object.entries(effectiveParameterSchema(definition, node.parameters)).filter(([, parameter]) => parameter.type === "number").map(([k]) => k);
  return (
    <div className={styles.mapForm}>
      <select aria-label="Node to drive" value={target} onChange={(event) => { setTarget(event.target.value); setKey(""); }}>
        <option value="">node…</option>
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>{nameOf(candidate)}</option>
        ))}
      </select>
      <select aria-label="Parameter to drive" value={key} onChange={(event) => setKey(event.target.value)} disabled={node === undefined}>
        <option value="">parameter…</option>
        {numeric.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {channels.length > 1 ? (
        <select aria-label="Channel" value={channel} onChange={(event) => setChannel(event.target.value)}>
          {channels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : null}
      <button type="button" disabled={node === undefined || key === ""} onClick={() => onMap(target as NodeId, key, channel)}>
        map
      </button>
    </div>
  );
}

export function ControlsPane({ graph, registry, bus, invocation }: ControlsPaneProps) {
  const editor = useMemo(() => createParameterEditor({ bus, context: invocation }), [bus, invocation]);
  useEffect(() => () => editor.dispose(), [editor]);
  const write = useMemo<ControlWrite>(() => (nodeId, entries, phase) => editor.setStored(nodeId, entries, phase), [editor]);

  const panels = useMemo(() => Object.values(graph.nodes).filter((node) => node.type === "panel"), [graph]);
  const widgets = useMemo(() => Object.values(graph.nodes).filter((node) => CONTROL_WIDGET_TYPES.has(node.type)), [graph]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);
  const panel = panels.find((candidate) => candidate.id === chosen) ?? panels[0];

  const byName = useMemo(() => new Map(widgets.map((node) => [nameOf(node), node])), [widgets]);
  const rows: PanelRow[] = panel === undefined
    ? [{ kind: "widgets", names: widgets.map(nameOf) }]
    : parsePanelLayout(typeof panel.parameters["layout"] === "string" ? (panel.parameters["layout"] as string) : "");

  const map = (widget: GraphNode, target: NodeId, key: string, channel: string): void => {
    const node = graph.nodes[target];
    if (node === undefined) return;
    const current = node.parameters[key];
    const retained = storedStaticValue(current as StoredParameter | undefined);
    const slot: StoredParameter = {
      mode: "expression",
      bindings: {
        ...(isParameterSlot(current) ? current.bindings : {}),
        ...(retained === undefined ? {} : { static: { kind: "static", value: retained } }),
        expression: { kind: "expression", source: `op('${nameOf(widget)}').chan.${channel}` },
      },
    };
    void bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), label: `Map ${nameOf(widget)} → ${nameOf(node)}.${key}`, operations: [{ op: "setParameters", nodeId: target, parameters: { [key]: slot as never } }] },
      invocation,
    );
    setMapping(null);
  };

  if (widgets.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No controls</p>
      </div>
    );
  }

  return (
    <div className={styles.pane} data-controls-pane>
      <header className={styles.header}>
        <h2 className={styles.title}>{panel === undefined ? "All controls" : String(panel.parameters["title"] ?? nameOf(panel))}</h2>
        {panels.length > 1 ? (
          <select aria-label="Panel" value={panel?.id ?? ""} onChange={(event) => setChosen(event.target.value)}>
            {panels.map((candidate) => <option key={candidate.id} value={candidate.id}>{String(candidate.parameters["title"] ?? nameOf(candidate))}</option>)}
          </select>
        ) : null}
      </header>
      {rows.map((row, index) =>
        row.kind === "heading" ? (
          <h3 key={index} className={styles.heading}>{row.text}</h3>
        ) : row.kind === "text" ? (
          <p key={index} className={styles.note}>{row.text}</p>
        ) : (
          <div key={index} className={styles.row}>
            {row.names.map((name) => {
              const widget = byName.get(name);
              if (widget === undefined) return <div key={name} className={styles.missing}>no control named “{name}”</div>;
              const targets = targetsOf(graph, widget);
              return (
                <div key={widget.id} className={styles.cell}>
                  <ControlWidget nodeId={widget.id} type={widget.type} parameters={widget.parameters as Record<string, unknown>} write={write} size="panel" />
                  <div className={styles.meta}>
                    <span className={styles.targets} title={targets.join("\n")}>
                      {targets.length === 0 ? "drives nothing" : `→ ${targets.join(", ")}`}
                    </span>
                    <button type="button" className={styles.mapButton} onClick={() => setMapping(mapping === widget.id ? null : widget.id)}>
                      map…
                    </button>
                  </div>
                  {mapping === widget.id ? (
                    <MapForm graph={graph} registry={registry} widget={widget} onMap={(target, key, channel) => map(widget, target, key, channel)} />
                  ) : null}
                </div>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}
