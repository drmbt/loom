import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import type { EditPhase } from "@ui/controls/types.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { isParameterSlot, storedStaticValue } from "@domain/parameters/slots.ts";
import { controlDefaultState, type ControlDefaultState } from "@nodes/definitions/controls.ts";
import { controlCaption, formatControlValue as format } from "./board-fit.ts";
import { ControlValuesContext, type ControlValuesReader } from "./control-values-context.ts";
import styles from "./control-widget.module.css";

/**
 * T1388b — ONE widget, drawn wherever a control node is shown: in its own body on the canvas
 * and on a Panel (the Panel node's body and the Controls tab). It reads the node's parameters
 * and writes them back through the parameter editor, so a drag is live frames plus one
 * committed undo group (`createParameterEditor`) and every write is an ordinary audited
 * patch (§V30).
 *
 * A parameter the document DRIVES (an expression, a MIDI binding) is shown, not grabbed: the
 * widget draws the driven number and refuses the gesture, rather than fighting the driver.
 *
 * T1513b — every widget SHOWS ITS STATE where the eye lands: a slider's caption and value on
 * one header row above its bar, a toggle as a switch that says On or Off, a button that
 * looks pressed while held and counts its presses, an XY pad capped in size with its value in
 * its header row.
 *
 * T1516b — on a Panel BOARD (`size="board"`) a widget FILLS the rect the owner gave it: a
 * one-row slider is a bar with its caption and value inside it, a pad fills its square with
 * its header laid over the top, a toggle or button fills its cells. The same states, drawn
 * at whatever size the board says — the Controls tab's fixed cells or the Panel node's
 * scaled-down body.
 *
 * T1518b — and says only what the rect has room for (`showValue`, decided by `board-fit.ts`):
 * with no room for both, the VALUE goes and the caption stays whole — a slider or pad shows
 * its caption alone, a toggle its caption and a small switch (no On/Off), a button no count.
 *
 * T1619b — every widget MARKS ITS DEFAULT, where Reset sends it: a slider two notches on its
 * track at the default, an XY pad a ring there, each dim while the value is at it and bright
 * while it is away; a toggle a dot while its state is not its default. From
 * `controlDefaultState`, the answer `control.reset` itself reads. A control that holds no
 * default, and a key the document drives, draw no mark: there is nothing to go back to.
 */

/** Writes a control's keys as ONE patch — an XY drag moves x and y in one undo group. */
export interface ControlWrite {
  (nodeId: NodeId, entries: Readonly<Record<string, number | boolean>>, phase: EditPhase): void;
}

export interface ControlWidgetProps {
  readonly nodeId: NodeId;
  readonly type: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly write: ControlWrite;
  /** Bigger touch targets on a Panel; compact in a node body; filling its rect on a board (T1516b). */
  readonly size?: "node" | "panel" | "board";
  /** T1518b — on a board: false when the rect has no room for the value beside the caption. Default true. */
  readonly showValue?: boolean;
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const isDriven = (value: unknown): boolean => isParameterSlot(value) && value.mode !== "static";
const VALUE_KEYS: Readonly<Record<string, readonly string[]>> = {
  slider: ["value"], toggle: ["on"], button: ["held", "presses"], xyPad: ["x", "y"],
};
const NO_VALUE_KEYS: readonly string[] = [];

interface LiveValues {
  readonly reader: ControlValuesReader;
  readonly nodeId: NodeId;
  readonly values: Readonly<Record<string, unknown>>;
}

function useControlValues({ nodeId, type, parameters }: ControlWidgetProps) {
  const reader = useContext(ControlValuesContext);
  const keys = VALUE_KEYS[type] ?? NO_VALUE_KEYS;
  const active = reader !== null && keys.some((key) => isDriven(parameters[key]));
  const [sample, setSample] = useState<LiveValues | null>(null);
  const retained = useMemo(() => Object.fromEntries(Object.entries(parameters).map(([key, value]) =>
    [key, isParameterSlot(value) ? storedStaticValue(value) : value])), [parameters]);
  useEffect(() => {
    if (!active || reader === null) {
      setSample(null);
      return;
    }
    const tick = () => {
      const resolved = reader.read(nodeId);
      // Keep primitive value samples: a reader may reuse its record between frames.
      const values = Object.fromEntries(keys.map((key) => [key, resolved[key]]));
      setSample((previous) => previous?.reader === reader && previous.nodeId === nodeId
        && keys.every((key) => Object.is(previous.values[key], values[key]))
        ? previous : { reader, nodeId, values });
    };
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [active, reader, nodeId, keys, parameters]);
  const live = active && sample?.reader === reader && sample.nodeId === nodeId ? sample.values : null;
  return { values: live === null ? retained : { ...retained, ...live }, live: live !== null };
}

function snap(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

/** Pointer drag over an element as 0..1 along x (and y, top = 1). */
function useDrag(onMove: (x: number, y: number, phase: EditPhase) => void) {
  const element = useRef<HTMLDivElement | null>(null);
  const at = (event: ReactPointerEvent<HTMLDivElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(box.width, 1))),
      Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / Math.max(box.height, 1))),
    ];
  };
  return {
    ref: element,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      // T1619b: a control-click is a right-click on a Mac. It opens the control's menu and
      // must not move the control on its way there.
      if (event.button !== 0 || event.ctrlKey) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const [x, y] = at(event);
      onMove(x, y, "live");
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const [x, y] = at(event);
      onMove(x, y, "live");
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const [x, y] = at(event);
      onMove(x, y, "commit");
    },
  };
}

interface WidgetProps extends ControlWidgetProps {
  readonly caption: string;
  readonly className: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly live: boolean;
  /** T1619b: where the control stands against its default; null for a Button. */
  readonly defaults: ControlDefaultState | null;
}

/**
 * T1619b — the default a value key is marked at, and whether the value is away from it.
 * Null — no mark — when the key holds no default or the document drives it.
 */
function defaultMark(state: ControlDefaultState | null, key: string): { readonly at: number | boolean; readonly away: boolean } | null {
  if (state === null || state.driven.includes(key)) return null;
  const at = state.defaults[key];
  return at === undefined ? null : { at, away: state.away.includes(key) };
}

/** A default's place along min..max as 0..1, or null when it has none to draw. */
function markShare(mark: ReturnType<typeof defaultMark>, min: number, max: number): number | null {
  if (mark === null || typeof mark.at !== "number" || max === min) return null;
  return Math.min(1, Math.max(0, (mark.at - min) / (max - min)));
}

/** Caption left, value right, on one row — the value never takes a row of its own. `null`: no room for it (T1518b). */
function Head({ caption, value }: { caption: string; value: string | null }) {
  return (
    <div className={styles.head}>
      <span className={styles.caption} title={caption}>{caption}</span>
      {value === null ? null : <span className={styles.readout}>{value}</span>}
    </div>
  );
}

function Slider({ nodeId, parameters, values, live, write, caption, className, size, showValue, defaults }: WidgetProps) {
  const min = num(values["min"], 0);
  const max = num(values["max"], 1);
  const step = num(values["step"], 0);
  const driven = isDriven(parameters["value"]);
  const value = num(values["value"], min);
  const share = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const drag = useDrag((x, _y, phase) => {
    if (!driven) write(nodeId, { value: snap(min + x * (max - min), step) }, phase);
  });
  const head = <Head caption={caption} value={showValue === false ? null : driven && !live ? "driven" : format(value)} />;
  // On a board the caption and value sit INSIDE the bar, so a one-row slider is one row.
  const board = size === "board";
  const mark = defaultMark(defaults, "value");
  const tick = markShare(mark, min, max);
  return (
    <div className={className} data-control="slider" data-control-node={nodeId}>
      {board ? null : head}
      <div
        {...drag}
        className={`${styles.track} ${driven ? styles.driven : ""}`}
        role="slider"
        aria-label={caption}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        title={driven ? `${caption} is driven — its value comes from an expression` : mark === null ? caption : `${caption} · default ${format(mark.at as number)}`}
      >
        <div className={styles.fill} style={{ width: `${share * 100}%` }} />
        {tick === null ? null : (
          <div className={`${styles.tick} ${mark?.away === true ? styles.away : ""}`} style={{ left: `${tick * 100}%` }} data-default-mark={mark?.away === true ? "away" : "at"} aria-hidden="true" />
        )}
        {board ? <div className={styles.overlay}>{head}</div> : null}
      </div>
    </div>
  );
}

function Toggle({ nodeId, parameters, values, write, caption, className, showValue, defaults }: WidgetProps) {
  const on = values["on"] === true;
  const driven = isDriven(parameters["on"]);
  const mark = defaultMark(defaults, "on");
  return (
    <div className={className} data-control="toggle" data-control-node={nodeId}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-readonly={driven}
        className={`${styles.toggle} ${on ? styles.on : ""} ${showValue === false ? styles.mini : ""}`}
        onClick={() => { if (!driven) write(nodeId, { on: !on }, "commit"); }}
      >
        <span className={styles.caption} title={mark === null ? caption : `${caption} · default ${mark.at === true ? "On" : "Off"}`}>{caption}</span>
        {mark?.away === true ? <span className={styles.offDefault} data-default-mark="away" aria-hidden="true" /> : null}
        <span className={styles.switch} aria-hidden="true">
          <span className={styles.knob} />
        </span>
        {showValue === false ? null : <span className={styles.state}>{on ? "On" : "Off"}</span>}
      </button>
    </div>
  );
}

function Button({ nodeId, parameters, values, write, caption, className, showValue }: WidgetProps) {
  const held = values["held"] === true;
  const presses = num(values["presses"], 0);
  const driven = isDriven(parameters["held"]) || isDriven(parameters["presses"]);
  // Pressed from the pointer's own edge, not only from the document's echo of it.
  const [pressing, setPressing] = useState(false);
  const pressed = held || (!driven && pressing);
  // The count this press wrote on its way down. The release writes the SAME number: the
  // press's live write re-renders this widget with the count already raised, and adding
  // one again on release counted every press twice (T1513b, found by its test).
  const count = useRef(presses);
  const pointer = useRef<number | null>(null);
  return (
    <div className={className} data-control="button" data-control-node={nodeId}>
      <button
        type="button"
        aria-pressed={pressed}
        className={`${styles.button} ${pressed ? styles.pressed : ""}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (driven) return;
          if (pointer.current !== null) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = event.pointerId;
          setPressing(true);
          count.current = presses + 1;
          write(nodeId, { held: true, presses: count.current }, "live");
        }}
        onPointerUp={(event) => {
          if (event.button !== 0) return;
          // Learn consumes pointerdown before this widget: that release owns no write.
          if (pointer.current !== event.pointerId) return;
          pointer.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          setPressing(false);
          if (driven) return;
          write(nodeId, { held: false, presses: count.current }, "commit");
        }}
        onLostPointerCapture={(event) => {
          if (pointer.current !== event.pointerId) return;
          pointer.current = null;
          setPressing(false);
          if (driven) return;
          write(nodeId, { held: false, presses: count.current }, "commit");
        }}
      >
        <span className={styles.caption} title={caption}>{caption}</span>
        {showValue === false ? null : <span className={styles.count} title="Presses" data-press-count={presses}>×{presses}</span>}
      </button>
    </div>
  );
}

function XYPad({ nodeId, parameters, values, live, write, caption, className, size, showValue, defaults }: WidgetProps) {
  const min = num(values["min"], 0);
  const max = num(values["max"], 1);
  const x = num(values["x"], 0.5);
  const y = num(values["y"], 0.5);
  const drivenX = isDriven(parameters["x"]);
  const drivenY = isDriven(parameters["y"]);
  const driven = drivenX || drivenY;
  const span = max - min || 1;
  const drag = useDrag((u, v, phase) => {
    if (drivenX && drivenY) return;
    write(nodeId, { ...(drivenX ? {} : { x: min + u * span }), ...(drivenY ? {} : { y: min + v * span }) }, phase);
  });
  const head = <Head caption={caption} value={showValue === false ? null : driven && !live ? "driven" : `${format(x)}, ${format(y)}`} />;
  // On a board the pad fills its rect and the header is laid over its top edge.
  const board = size === "board";
  // T1619b: the ring is drawn only when BOTH axes hold a default: half a place is no place.
  const markX = defaultMark(defaults, "x");
  const markY = defaultMark(defaults, "y");
  const homeX = markShare(markX, min, min + span);
  const homeY = markShare(markY, min, min + span);
  const away = markX?.away === true || markY?.away === true;
  return (
    <div className={className} data-control="xy" data-control-node={nodeId}>
      {board ? null : head}
      <div {...drag} className={`${styles.pad} ${driven ? styles.driven : ""}`} aria-label={caption} role="group">
        {board ? <div className={styles.overlay}>{head}</div> : null}
        {homeX === null || homeY === null ? null : (
          <div className={`${styles.home} ${away ? styles.away : ""}`} style={{ left: `${homeX * 100}%`, bottom: `${homeY * 100}%` }} data-default-mark={away ? "away" : "at"} aria-hidden="true" />
        )}
        <div className={styles.puck} style={{ left: `${((x - min) / span) * 100}%`, bottom: `${((y - min) / span) * 100}%` }} />
      </div>
    </div>
  );
}

const WIDGETS: Readonly<Record<string, (props: WidgetProps) => ReturnType<typeof Slider>>> = {
  slider: Slider,
  toggle: Toggle,
  button: Button,
  xyPad: XYPad,
};

export function ControlWidget(props: ControlWidgetProps) {
  const display = useControlValues(props);
  const Widget = WIDGETS[props.type];
  if (Widget === undefined) return null;
  const caption = controlCaption(display.values);
  const className = `${styles.widget} ${props.size === "panel" ? styles.panel : props.size === "board" ? styles.board : styles.node}`;
  const defaults = controlDefaultState({ type: props.type, parameters: props.parameters as Record<string, StoredParameter> });
  return <Widget {...props} values={display.values} live={display.live} caption={caption} className={className} defaults={defaults} />;
}
