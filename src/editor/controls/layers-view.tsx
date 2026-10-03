import { useEffect, useMemo, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { isParameterSlot, staticBindingValue } from "@domain/parameters/slots.ts";
import { isPresetsNode, morphRunning, parseMorphRecords } from "@domain/presets/index.ts";
import { controlNameOf, layerPicture } from "@nodes/definitions/controls.ts";
import { SELECT_NODES_COMMAND } from "@editor/selection/select-created.ts";
import { MORPH_POLL_MS } from "./board-members.tsx";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import { layerOpacityFader, setLayerOn } from "./layer-controls.ts";
import { layerStacks } from "./layer-stacks.ts";
import styles from "./layers-view.module.css";

/**
 * T1506b — THE LAYERS TAB: every layer stack in the document, top layer first, each under
 * the name of where its picture ends up (`layerStacks`, derived from the wiring — nothing
 * here is stored). A row is one layer as a performer reaches for it:
 *
 * - its NAME — a click selects the node, so the inspector follows (`graph.selectNodes`,
 *   the one selecting door; a single node is the primary, §T1531b);
 * - its on/off SWITCH and OPACITY fader, written exactly as the board's layer item writes
 *   them (`layer-controls.ts`): a state not a flip, one undo per press; a drag is live
 *   frames and one undo group; a driven opacity shows "driven" and refuses the drag;
 * - its BLEND, and the PICTURE it shows — the name, or "wired" when a wire feeds it
 *   (`layerPicture`, §B233);
 * - "morphing" while a preset fade is moving one of its parameters, read off the frame
 *   clock as the bank strip's fade bar is (`useMorphFade`, `board-members.tsx`).
 */

export interface LayersViewProps {
  readonly graph: GraphDocument;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** The parameter editor's write — the opacity fader drags through it. */
  readonly write: ControlWrite;
}

/** A layer with no picture yet. */
const NO_PICTURE = "—";

/**
 * The NAMES of the nodes a running preset fade is moving. Records name nodes, not ids
 * (§V129). Polled off the app's frame clock like the bank strip's bar: the timer decides
 * how often to look and measures nothing, and it stops once no fade is running.
 */
function useMorphingNames(bus: LoomBus, nodes: GraphDocument["nodes"]): ReadonlySet<string> {
  // Keyed by the banks' `morphs` text, so an unrelated edit does not restart the poll.
  const source = Object.values(nodes)
    // Layers are named by root banks; a look instance's own records name only its page (T1505b).
    .filter((node) => isPresetsNode(node))
    .map((node) => (typeof node.parameters["morphs"] === "string" ? node.parameters["morphs"] : ""))
    .join("\u0000");
  const records = useMemo(() => source.split("\u0000").flatMap((morphs) => parseMorphRecords(morphs)), [source]);
  const [names, setNames] = useState("");
  useEffect(() => {
    if (records.length === 0) {
      setNames("");
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = (): void => {
      const clock = bus.frameClock();
      const running = clock === undefined ? [] : records.filter((record) => morphRunning(record, clock));
      setNames([...new Set(running.flatMap((record) => Object.keys(record.to)))].sort().join("\u0000"));
      if (clock !== undefined && running.length === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    timer = setInterval(tick, MORPH_POLL_MS);
    tick();
    return () => {
      if (timer !== null) clearInterval(timer);
    };
  }, [bus, records]);
  return useMemo(() => new Set(names === "" ? [] : names.split("\u0000")), [names]);
}

/** The blend's label as the inspector shows it: the stored option, or the definition's default. */
function blendLabel(bus: LoomBus, node: GraphNode): string | null {
  const definition = effectiveParameterSchema(bus.registry.get(node.type), node.parameters)["blend"];
  if (definition === undefined || definition.type !== "enum") return null;
  const stored = node.parameters["blend"];
  const value = isParameterSlot(stored) && stored.mode === "static" ? staticBindingValue(stored) : (stored ?? definition.default);
  return definition.options.find((option) => option.value === value)?.label ?? String(value);
}

interface LayerRowProps extends Omit<LayersViewProps, "graph"> {
  readonly node: GraphNode;
  readonly picture: string;
  readonly morphing: boolean;
}

function LayerRow({ node, bus, invocation, write, picture, morphing }: LayerRowProps) {
  const name = controlNameOf(node);
  const on = node.ui?.bypassed !== true;
  const blend = blendLabel(bus, node);
  return (
    <li className={`${styles.row} ${on ? "" : styles.off}`} data-layer-row={node.id}>
      <span className={styles.nameCell}>
        <button
          type="button"
          className={styles.name}
          title={`Select ${name}`}
          onClick={() => void bus.execute(SELECT_NODES_COMMAND, { nodeIds: [node.id] }, invocation)}
        >
          {name}
        </button>
        {morphing ? (
          <span className={styles.morphing} title="A preset fade is moving this layer" data-layer-morphing>
            morphing
          </span>
        ) : null}
      </span>
      <span className={styles.control}>
        <ControlWidget
          nodeId={node.id}
          type="toggle"
          parameters={{ caption: "On", on }}
          write={(_nodeId, entries) => setLayerOn(bus, invocation, node.id, entries["on"] === true)}
          size="board"
          showValue={false}
        />
      </span>
      <span className={styles.control} data-layer-fader>
        <ControlWidget
          nodeId={node.id}
          type="slider"
          parameters={layerOpacityFader(bus, node)}
          write={(nodeId, entries, phase) => {
            const value = entries["value"];
            if (typeof value === "number") write(nodeId, { opacity: value }, phase);
          }}
          size="board"
        />
      </span>
      <span className={styles.meta}>
        {blend === null ? null : <span data-layer-blend>{blend}</span>}
        <span className={styles.picture} title={picture === "" ? "No picture" : `${name} shows ${picture}`} data-layer-picture={picture}>
          {picture === "" ? NO_PICTURE : picture}
        </span>
      </span>
    </li>
  );
}

export function LayersView({ graph, bus, invocation, write }: LayersViewProps) {
  const stacks = useMemo(() => layerStacks(graph), [graph]);
  const morphing = useMorphingNames(bus, graph.nodes);
  return (
    <div className={styles.stacks} data-layers-view>
      {stacks.map((stack) => (
        <section key={stack.layers[0]} className={styles.stack} aria-label={`Layers into ${stack.title}`} data-layer-stack={stack.output ?? ""}>
          <h3 className={styles.title}>{stack.title}</h3>
          <ol className={styles.list}>
            {stack.layers.map((id) => {
              const node = graph.nodes[id];
              if (node === undefined) return null;
              return (
                <LayerRow
                  key={id}
                  node={node}
                  bus={bus}
                  invocation={invocation}
                  write={write}
                  picture={layerPicture(graph, id)}
                  morphing={node.label !== undefined && morphing.has(node.label)}
                />
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
