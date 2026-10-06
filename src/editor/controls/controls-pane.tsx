import { useEffect, useMemo, useState, type ReactNode } from "react";
import { authoredGraph, type GraphDocument, type GraphNode } from "@domain/types/graph.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import { resolveParameters, type ChannelResolver } from "@domain/parameters/resolve.ts";
import { parameterReadOptions } from "@domain/parameters/node-references.ts";
import { NO_MORPHS } from "@domain/presets/morph-index.ts";
import { CONTROL_WIDGET_TYPES, LAYER_NODE_TYPE, panelBoard, panelMembers, panelTitle } from "@nodes/definitions/controls.ts";
import { isRemotePanel } from "@devices/phone/phone-snapshot.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import { ControlTargets } from "./control-targets.tsx";
import { controlTargets } from "./parameter-controls.ts";
import { PanelBoardEditor, PanelBoardGrid, Pencil } from "./panel-board.tsx";
import { LayersView } from "./layers-view.tsx";
import { PanelRows } from "./panel-surface.tsx";
import { PhoneDoorButton } from "./phone-door.tsx";
import { ResetAllButton } from "./reset-all.tsx";
import { PANEL_EMPTY_HINT, type PhoneDoorView } from "./phone-door-copy.ts";
import { ControlValuesContext } from "./control-values-context.ts";
import { useControlMidiLearn, type ControlMidiSurface } from "./control-midi-learn.tsx";
import styles from "./controls-pane.module.css";
import surface from "./panel-surface.module.css";

/**
 * T1388b — THE CONTROLS PANE: a Panel node's layout as a performance surface.
 *
 * With no Panel in the document the pane still works: it lays out every widget there is, so
 * dropping a Slider on the canvas is already a control you can perform with. Under every
 * widget there: what it drives — the parameters whose expression reads its channel — as
 * chips, each with a × that unbinds it.
 *
 * T1512b — with a Panel, this is a BIGGER VIEW OF THE PANEL NODE, with the same phone icon
 * (`PhoneDoorButton`) in the header.
 *
 * T1513b — the "map…" form is gone from the cards: mapping starts FROM THE PARAMETER
 * (§T1514b, owner ruling), and a card says only what its control drives, and lets go of it.
 *
 * T1516b — a wired Panel is a FREE BOARD (`panelBoard`), and this pane splits PLAYING it from
 * ARRANGING it. Play (the default) draws the board at fixed compact cells and only operates
 * the controls — no chips, no arrows. The pencil in the header is edit mode: controls go
 * inert, drag to move and resize on the grid, labels, the column count, and per control what
 * it drives (× unlink) and Remove from panel (`PanelBoardEditor`). The auto-fill grid and the
 * ‹ › reorder of T1513b are gone for wired Panels; a Panel laid out by the legacy override
 * text keeps its rows, with their chips.
 *
 * T1518b — while arranging, the pane itself stops scrolling (`data-editing`) and the board
 * area scrolls instead, so in a short bottom dock the header and the toolbar stay put and
 * the spare rows are a scroll of the board away. The same editor opens from the pencil on
 * the Panel node's header (`panel-edit.tsx`).
 *
 * T1506b — a BOTTOM TAB STRIP, as the phone page has (§T1517b): one tab per Panel (it
 * replaces the Panel picker that sat in the header), and a LAYERS tab listing every layer
 * stack in the document (`layers-view.tsx`). The Layers tab is there only while the
 * document holds a Layer — a list with nothing in it is a dead end, and the way to add a
 * layer is the node library's, not this pane's — and the strip only while there are two
 * tabs to choose between, so a document with one Panel and no layer draws as before.
 */

export interface ControlsPaneProps {
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** T1396b — the phone door; absent where no device attachment exists (tests, headless). */
  readonly phone?: PhoneDoorView;
  readonly midi?: ControlMidiSurface;
  readonly channels?: ChannelResolver;
  readonly latestFrame?: () => FrameInputs | null;
}

export function ControlsPane({ graph, registry, bus, invocation, phone, midi, channels, latestFrame }: ControlsPaneProps) {
  const editor = useMemo(() => createParameterEditor({ bus, context: invocation }), [bus, invocation]);
  useEffect(() => () => editor.dispose(), [editor]);
  const write = useMemo<ControlWrite>(() => (nodeId, entries, phase) => editor.setStored(nodeId, entries, phase), [editor]);

  const { panels, widgets, layers } = useMemo(() => {
    const panels: GraphNode[] = [];
    const widgets: GraphNode[] = [];
    let layers = false;
    for (const node of Object.values(graph.nodes)) {
      const type = node.type;
      if (type === "panel") panels.push(node);
      else if (CONTROL_WIDGET_TYPES.has(type)) widgets.push(node);
      else if (type === LAYER_NODE_TYPE) layers = true;
    }
    return { panels, widgets, layers };
  }, [graph.nodes]);
  // The empty surface reads only the phone door, not graph parameters or edges.
  // Keep that element so an unrelated edit does not rebuild the phone popover.
  const empty = useMemo(() => (
    <div className={styles.empty}>
      <p>No controls</p>
      {phone === undefined ? null : <PhoneDoorButton door={phone} />}
    </div>
  ), [phone]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [layersChosen, setLayersChosen] = useState(false);
  // The last Layer gone: back to the controls, without forgetting the choice.
  const showLayers = layersChosen && layers;
  const panel = panels.find((candidate) => candidate.id === chosen) ?? panels[0];
  const board = panel === undefined ? null : panelBoard(graph, panel);
  // T1619b: the controls this tab shows, for the header's reset-all count: the Panel's
  // members, or with no Panel the inventory above. Per revision, like the inventory.
  const shown = useMemo(() => (panel === undefined ? widgets : panelMembers(graph, panel)), [graph, panel, widgets]);
  const midiLearn = useControlMidiLearn(bus, invocation, midi, showLayers ? "layers" : panel?.id ?? "all", !editing);
  const controlValues = useMemo(() => channels === undefined ? null : ({ read: (nodeId: string) => {
    const current = bus.store.getGraph();
    const node = current.nodes[nodeId];
    // A removed widget can have one outstanding display sample before React unmounts it.
    if (node === undefined) return {};
    const definition = registry.get(node.type);
    if (definition === undefined) throw new Error(`No definition for control "${node.type}".`);
    const frame = latestFrame?.()?.frame;
    // Authored and no fade, on purpose: the pane lists authored widgets (none inside a component, §T1143), and mid-morph a control shows its document value (§T1525b).
    // §T1559b: the instances `op('<instance>').chan.<c>` can name are the flattening's, off the bus's read scope — the value graph reads them, so the display must.
    return resolveParameters(node, definition, parameterReadOptions({ graph: authoredGraph(current), registry, channels,
      frame, flattening: { morphs: NO_MORPHS, instanceChannels: bus.readScope().flattening.instanceChannels } })).values;
  } }), [bus, registry, channels, latestFrame]);

  const apply = (operations: GraphPatchOperation[], label: string): void => {
    if (operations.length === 0) return;
    void bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label, operations }, invocation);
  };

  const tabs = (body: ReactNode): ReactNode => {
    const panelTabs = panels.length === 0 ? [{ id: "", title: "All controls" }] : panels.map((each) => ({ id: each.id, title: panelTitle(each) }));
    if (panelTabs.length + (layers ? 1 : 0) < 2) return body;
    return (
      <div className={styles.tabbed}>
        <div className={styles.tabBody}>{body}</div>
        <div className={styles.tabs} role="tablist" aria-label="Controls">
          {panelTabs.map((tab) => {
            const selected = !showLayers && (panel?.id ?? "") === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`${styles.tab} ${selected ? styles.selectedTab : ""}`}
                onClick={() => {
                  setLayersChosen(false);
                  if (tab.id !== "") setChosen(tab.id);
                }}
              >
                {tab.title}
              </button>
            );
          })}
          {layers ? (
            <button
              type="button"
              role="tab"
              aria-selected={showLayers}
              className={`${styles.tab} ${showLayers ? styles.selectedTab : ""}`}
              onClick={() => setLayersChosen(true)}
            >
              Layers
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  if (showLayers) {
    return tabs(
      <div className={styles.pane} data-layers-pane>
        <header className={styles.header}>
          <h2 className={styles.title}>Layers</h2>
        </header>
        <LayersView graph={graph} bus={bus} invocation={invocation} write={write} />
      </div>,
    );
  }

  if (widgets.length === 0 && panel === undefined) {
    return tabs(empty);
  }

  /** What a widget drives, as chips with × (`ControlTargets`) — under a card. */
  const renderMeta = (widget: GraphNode) =>
    controlTargets(graph, widget).length === 0 ? null : (
      <div className={styles.meta}>
        <ControlTargets graph={graph} registry={registry} widget={widget} apply={apply} />
      </div>
    );

  return tabs(
    <ControlValuesContext.Provider value={controlValues}>
    <div className={styles.pane} data-controls-pane data-midi-learning={midiLearn.active || undefined}
      onPointerDownCapture={midiLearn.capture} onClickCapture={midiLearn.captureClick}
      data-editing={editing && board !== null ? true : undefined}
      // T1619b: which Panel a right-clicked control's "all on this Panel" means (`menus/target.ts`).
      data-control-panel={panel?.id}>
      <header className={styles.header}>
        <h2 className={styles.title}>{panel === undefined ? "All controls" : panelTitle(panel)}</h2>
        {board === null ? null : (
          <button
            type="button"
            className={`${styles.iconButton} ${editing ? styles.active : ""}`}
            aria-label="Edit board"
            aria-pressed={editing}
            disabled={midiLearn.active}
            title={editing ? "Done arranging" : "Arrange the board"}
            onClick={() => setEditing(!editing)}
          >
            <Pencil />
          </button>
        )}
        {/* T1619b: reset all — the shown Panel's controls, or with no Panel every control. Off while arranging or learning. */}
        <ResetAllButton controls={shown} panel={panel} bus={bus} invocation={invocation} disabled={(editing && board !== null) || midiLearn.active} />
        {phone === undefined ? null : (
          <PhoneDoorButton
            door={phone}
            panel={
              panel === undefined
                ? undefined
                : {
                    published: isRemotePanel(panel),
                    publish: (on) =>
                      apply([{ op: "setParameters", nodeId: panel.id, parameters: { remote: on } }], on ? "Publish panel to phones" : "Stop publishing panel"),
                  }
            }
          />
        )}
      </header>
      {midiLearn.toolbar}
      {panel === undefined ? (
        <div className={surface.grid} data-panel-row>
          {widgets.map((widget) => (
            <div key={widget.id} className={surface.cell}>
              <ControlWidget nodeId={widget.id} type={widget.type} parameters={widget.parameters as Record<string, unknown>} write={write} size="panel" />
              {renderMeta(widget)}
            </div>
          ))}
        </div>
      ) : board === null ? (
        <PanelRows graph={graph} panel={panel} write={write} size="panel" renderMeta={renderMeta} />
      ) : editing ? (
        <PanelBoardEditor graph={graph} panelId={panel.id} board={board} write={write} bus={bus} invocation={invocation} apply={apply} registry={registry} />
      ) : board.items.length === 0 ? (
        <p className={surface.hint} data-panel-empty>{PANEL_EMPTY_HINT}</p>
      ) : (
        <PanelBoardGrid board={board} write={write} bus={bus} invocation={invocation} variant="tab" />
      )}
    </div>
    </ControlValuesContext.Provider>
  );
}
