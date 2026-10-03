import { useEffect, useMemo, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { isParameterSlot, staticBindingValue } from "@domain/parameters/slots.ts";
import {
  CUE_BACK_COMMAND,
  CUE_GO_COMMAND,
  CUE_LIST_NODE_TYPE,
  PRESETS_NODE_TYPE,
  PRESET_RECALL_COMMAND,
  PRESET_STORE_COMMAND,
  morphProgress,
  morphRunning,
  nextCueName,
  nextPresetName,
  parseCueList,
  parseMorphRecords,
  parsePresetBank,
} from "@domain/presets/index.ts";
import { LAYER_NODE_TYPE, controlNameOf, type BoardRect } from "@nodes/definitions/controls.ts";
import { refusalMessage, type CommandAnswer } from "@editor/inspector/command-refusal.ts";
import { boardFit, boardValueEm, cueListBoardLayout, layerBoardLayout, presetStripGrid, type BoardCells } from "./board-fit.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import styles from "./board-members.module.css";

/**
 * T1501b (§T1398b S6) — WHAT A BANK, A LAYER AND A CUE LIST DRAW ON A PANEL BOARD.
 *
 * These three join a board by name (`BOARD_NAMED_TYPES`, `controls.ts`) and are drawn here
 * wherever a board is: the Controls tab, the Panel node's canvas body and the edit
 * surface, from the one `panelBoard` derivation — so a strip on the canvas and the same
 * strip in the tab cannot show different presets.
 *
 * - a Presets BANK is a strip: one button per preset, the one recalled last lit, and a
 *   bar across the button being faded to while a morph runs. A press is `preset.recall`.
 *   T1527b: the strip ends in Store, which captures the bank's targets as a NEW preset
 *   under the next free name (`preset.store`) — never over one, so a stray press mid-show
 *   costs one undo and loses nothing; storing over a preset stays the inspector's. This
 *   file draws only the desk (Controls tab, Panel node body): the phone page draws its
 *   own strip with no Store, and its vet has no path to `preset.store` (§T1503b).
 * - a LAYER is a switch — on means not bypassed — and its opacity fader when the rect has
 *   room. The switch writes the STATE the press asked for (`setNodeUi { bypassed }`, the op
 *   the layer's own docblock names), never a flip, and nothing at all when the layer is
 *   already so: two presses of "off" leave it off, in one undo step. The fader writes
 *   `opacity` through the parameter editor like any slider — one undo group per drag —
 *   and a driven opacity is shown and refuses the drag.
 * - a CUE LIST is BACK and a large GO, with the current cue and the one standing by. A
 *   press is `cue.back` / `cue.go`, on THIS list.
 *
 * Everything goes through the bus, so each press is one audited patch and one undo. A
 * press the bus REFUSES (GO past the last cue, a preset with nothing left to apply) says
 * why on the item until the document moves or the next press — a button that silently
 * did nothing is the failure a performance surface cannot have.
 *
 * Sized like a board widget (`board-fit.ts`): type scales with the cell, and each part
 * says only what its share of the rect has room for.
 */

export interface BoardMemberProps {
  readonly node: GraphNode;
  readonly rect: BoardRect;
  readonly cells: BoardCells;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** The parameter editor's write — the layer's fader drags through it. */
  readonly write: ControlWrite;
}

/** The hairline between an item's parts, in px — `gap: 1px` in `board-members.module.css`. */
const PART_GAP_PX = 1;
/** GO is the button a show is run from: half again the type of everything beside it. */
const GO_SCALE = 1.4;
/** No cue: nothing fired yet, or nothing left to fire. */
const NO_CUE = "—";
/** The strip's Store button (T1527b). */
const STORE_CAPTION = "Store";

const text = (stored: unknown): string => (typeof stored === "string" ? stored.trim() : "");
const px = (value: number): string => `${String(value)}px`;

interface Refused {
  readonly message: string;
  readonly revision: number;
}

/**
 * Runs a bus command from a press and keeps what it was refused with. The message stands
 * until the document moves (it was about the document as it then was) or the next press.
 */
function usePress(bus: LoomBus): { readonly refusal: string | null; readonly press: (run: () => Promise<CommandAnswer>) => void } {
  const [refused, setRefused] = useState<Refused | null>(null);
  const press = (run: () => Promise<CommandAnswer>): void => {
    void run().then((result) => {
      const message = refusalMessage(result);
      setRefused(message === null ? null : { message, revision: bus.store.getRevision() });
    });
  };
  return { refusal: refused !== null && refused.revision === bus.store.getRevision() ? refused.message : null, press };
}

function Refusal({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <span className={styles.refusal} role="alert" title={message} data-board-refusal>
      {message}
    </span>
  );
}

/** How often a running fade is re-read off the frame clock: ten a second, like the timeline's readout. */
const MORPH_POLL_MS = 100;

/**
 * The fade a bank is running, as its strip shows it: which preset, and how far along —
 * read off the app's FRAME clock (`bus.frameClock`, the transport's absolute clock), so
 * the bar stops when the transport pauses and is absent where no frame loop runs. The
 * timer only decides how often to look; it measures nothing. It stops once the fade has.
 */
function useMorphFade(bus: LoomBus, morphs: unknown): { readonly preset: string; readonly progress: number } | null {
  const source = typeof morphs === "string" ? morphs : "";
  const newest = useMemo(() => {
    const records = parseMorphRecords(source);
    return records[records.length - 1];
  }, [source]);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    if (newest === undefined) {
      setProgress(null);
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = (): void => {
      const clock = bus.frameClock();
      const running = clock !== undefined && morphRunning(newest, clock);
      setProgress(running ? morphProgress(newest, clock.absTimeSeconds) : null);
      if (clock !== undefined && !running && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    timer = setInterval(tick, MORPH_POLL_MS);
    tick();
    return () => {
      if (timer !== null) clearInterval(timer);
    };
  }, [bus, newest]);
  return newest === undefined || progress === null ? null : { preset: newest.preset, progress };
}

function PresetStrip({ node, rect, cells, bus, invocation }: BoardMemberProps) {
  const parsed = parsePresetBank(node.parameters["presets"]);
  const presets = parsed.ok ? parsed.bank.presets : [];
  const current = text(node.parameters["current"]);
  const fade = useMorphFade(bus, node.parameters["morphs"]);
  const { refusal, press } = usePress(bus);
  if (!parsed.ok) {
    return (
      <div className={styles.member} data-board-member={PRESETS_NODE_TYPE} data-control-node={node.id}>
        <span className={styles.empty} title={parsed.reason}>
          Presets unreadable
        </span>
      </div>
    );
  }
  // T1527b: Store sits after the presets — its own cell, the strip's last.
  const storeAs = nextPresetName(presets.map((preset) => preset.name));
  const grid = presetStripGrid(presets.length + 1, rect.h);
  const buttonPx = (cells.widthOf(rect.w) - (grid.perRow - 1) * PART_GAP_PX) / grid.perRow;
  const longest = presets.reduce((widest, preset) => (preset.name.length > widest.length ? preset.name : widest), STORE_CAPTION);
  const fit = boardFit({ kind: "button", caption: longest, valueEm: 0, widthPx: buttonPx, cellPx: cells.cellPx });
  return (
    <div className={styles.member} data-board-member={PRESETS_NODE_TYPE} data-control-node={node.id}>
      <div
        className={styles.strip}
        style={{
          gridTemplateColumns: `repeat(${String(grid.perRow)}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${String(grid.rows)}, minmax(0, 1fr))`,
          fontSize: px(fit.fontPx),
        }}
        role="group"
        aria-label={`Presets of ${controlNameOf(node)}`}
      >
        {presets.map((preset) => {
          const fading = fade !== null && fade.preset === preset.name;
          return (
            <button
              key={preset.name}
              type="button"
              className={`${styles.press} ${current === preset.name ? styles.lit : ""}`}
              aria-pressed={current === preset.name}
              title={fading ? `${preset.name} — fading in` : preset.name}
              data-preset={preset.name}
              onClick={() => press(() => bus.execute(PRESET_RECALL_COMMAND, { nodeId: node.id, name: preset.name }, invocation))}
            >
              <span className={styles.name}>{preset.name}</span>
              {fading ? (
                <span className={styles.fade} style={{ width: `${(fade.progress * 100).toFixed(1)}%` }} data-morph-progress={fade.progress.toFixed(2)} aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          className={`${styles.press} ${styles.store}`}
          title={`Store the targets as a new preset, ${storeAs}`}
          data-preset-store={storeAs}
          onClick={() => press(() => bus.execute(PRESET_STORE_COMMAND, { nodeId: node.id, name: storeAs }, invocation))}
        >
          <span className={styles.name}>{STORE_CAPTION}</span>
        </button>
      </div>
      <Refusal message={refusal} />
    </div>
  );
}

/** A number off a parameter definition, or the fallback. */
const declared = (definition: unknown, key: "default" | "min" | "max", fallback: number): number => {
  const value = (definition as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

function LayerStrip({ node, rect, cells, bus, invocation, write }: BoardMemberProps) {
  const name = controlNameOf(node);
  const on = node.ui?.bypassed !== true;
  const layout = layerBoardLayout(rect);
  const width = cells.widthOf(rect.w);
  const partPx = layout === "beside" ? (width - PART_GAP_PX) / 2 : width;

  /**
   * The state the press asked for, written as that state — and not at all when the layer is
   * already so. Read from the document at the press, not from what was drawn, so a second
   * press that lands before the first has repainted cannot flip the layer back.
   */
  const setOn = (next: boolean): void => {
    if ((bus.store.getGraph().nodes[node.id]?.ui?.bypassed !== true) === next) return;
    void bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        label: `${next ? "Layer on" : "Layer off"} (${name})`,
        operations: [{ op: "setNodeUi", nodeId: node.id, ui: { bypassed: !next } }],
      },
      invocation,
    );
  };

  // Through the schema funnel (§T903): the fader's range and default are the layer's own.
  const definition = effectiveParameterSchema(bus.registry.get(node.type), node.parameters)["opacity"];
  const stored = node.parameters["opacity"];
  // A static-mode slot is a plain number in an envelope; any other slot is DRIVEN, and the
  // slider shows it and refuses the drag exactly as a driven Slider node does.
  const opacity = stored === undefined ? declared(definition, "default", 1) : isParameterSlot(stored) && stored.mode === "static" ? staticBindingValue(stored) : stored;
  const fader = { caption: "Opacity", value: opacity, min: declared(definition, "min", 0), max: declared(definition, "max", 1), step: 0 };

  const switchFit = boardFit({ kind: "toggle", caption: name, valueEm: boardValueEm("toggle", {}), widthPx: partPx, cellPx: cells.cellPx });
  const faderFit = boardFit({ kind: "slider", caption: fader.caption, valueEm: boardValueEm("slider", fader), widthPx: partPx, cellPx: cells.cellPx });
  return (
    <div className={`${styles.member} ${styles.parts} ${styles[layout] ?? ""}`} data-board-member={LAYER_NODE_TYPE} data-layout={layout}>
      <div className={styles.part} style={{ fontSize: px(switchFit.fontPx) }}>
        <ControlWidget
          nodeId={node.id}
          type="toggle"
          parameters={{ caption: name, on }}
          write={(_nodeId, entries) => setOn(entries["on"] === true)}
          size="board"
          showValue={switchFit.value}
        />
      </div>
      {layout === "switch" ? null : (
        <div className={styles.part} style={{ fontSize: px(faderFit.fontPx) }} data-layer-fader>
          <ControlWidget
            nodeId={node.id}
            type="slider"
            parameters={fader}
            write={(nodeId, entries, phase) => {
              const value = entries["value"];
              if (typeof value === "number") write(nodeId, { opacity: value }, phase);
            }}
            size="board"
            showValue={faderFit.value}
          />
        </div>
      )}
    </div>
  );
}

function CueListPad({ node, rect, cells, bus, invocation }: BoardMemberProps) {
  const parsed = parseCueList(node.parameters["cues"]);
  const current = text(node.parameters["current"]);
  const position = { current, standby: text(node.parameters["standby"]), wrap: node.parameters["wrap"] === true };
  const next = parsed.ok ? nextCueName(parsed.list, position) : null;
  const { refusal, press } = usePress(bus);
  const layout = cueListBoardLayout(rect);
  const width = cells.widthOf(rect.w);
  const buttonsPx = layout === "beside" ? (width - PART_GAP_PX) / 2 : width;
  const backPx = (buttonsPx - PART_GAP_PX) / 3;
  const backFit = boardFit({ kind: "button", caption: "BACK", valueEm: 0, widthPx: backPx, cellPx: cells.cellPx });
  const goFit = boardFit({ kind: "button", caption: "GO", valueEm: 0, widthPx: (buttonsPx - PART_GAP_PX - backPx) / GO_SCALE, cellPx: cells.cellPx });
  const names = `${current === "" ? NO_CUE : current} ▸ ${next ?? NO_CUE}`;
  const namesFit = boardFit({ kind: "cues", caption: names, valueEm: 0, widthPx: buttonsPx, cellPx: cells.cellPx });
  const step = (command: typeof CUE_GO_COMMAND | typeof CUE_BACK_COMMAND) => () => press(() => bus.execute(command, { nodeId: node.id }, invocation));
  return (
    <div className={`${styles.member} ${styles.parts} ${styles[layout] ?? ""}`} data-board-member={CUE_LIST_NODE_TYPE} data-layout={layout} data-control-node={node.id}>
      {layout === "buttons" ? null : (
        <div className={styles.cueNames} style={{ fontSize: px(namesFit.fontPx) }} title={parsed.ok ? "The current cue ▸ the cue GO fires next" : parsed.reason}>
          <span className={styles.cueNow} data-cue-current>{current === "" ? NO_CUE : current}</span>
          <span className={styles.cueArrow} aria-hidden="true">▸</span>
          <span className={styles.cueNext} data-cue-standby>{next ?? NO_CUE}</span>
        </div>
      )}
      <div className={styles.cueButtons}>
        <button type="button" className={styles.press} style={{ fontSize: px(backFit.fontPx) }} title="BACK — fires the cue before the current one" onClick={step(CUE_BACK_COMMAND)}>
          BACK
        </button>
        <button type="button" className={`${styles.press} ${styles.go}`} style={{ fontSize: px(goFit.fontPx * GO_SCALE) }} title="GO — fires the standby cue" onClick={step(CUE_GO_COMMAND)}>
          GO
        </button>
      </div>
      <Refusal message={refusal} />
    </div>
  );
}

const MEMBERS: Readonly<Record<string, (props: BoardMemberProps) => ReturnType<typeof PresetStrip>>> = {
  [PRESETS_NODE_TYPE]: PresetStrip,
  [LAYER_NODE_TYPE]: LayerStrip,
  [CUE_LIST_NODE_TYPE]: CueListPad,
};

/** The board item for a bank, a layer or a cue list; `null` for any other node type. */
export function BoardMember(props: BoardMemberProps) {
  const Member = MEMBERS[props.node.type];
  return Member === undefined ? null : <Member {...props} />;
}
