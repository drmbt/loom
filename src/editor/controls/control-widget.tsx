import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import type { EditPhase } from "@ui/controls/types.ts";
import { controlCaption, formatControlValue as format, isDrivenParameter as isDriven } from "./board-fit.ts";
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

function Slider({ nodeId, parameters, write, caption, className, size, showValue }: WidgetProps) {
  const min = num(parameters["min"], 0);
  const max = num(parameters["max"], 1);
  const step = num(parameters["step"], 0);
  const driven = isDriven(parameters["value"]);
  const value = num(parameters["value"], min);
  const share = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const drag = useDrag((x, _y, phase) => {
    if (!driven) write(nodeId, { value: snap(min + x * (max - min), step) }, phase);
  });
  const head = <Head caption={caption} value={showValue === false ? null : driven ? "driven" : format(value)} />;
  // On a board the caption and value sit INSIDE the bar, so a one-row slider is one row.
  const board = size === "board";
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
        title={driven ? `${caption} is driven — its value comes from an expression` : caption}
      >
        <div className={styles.fill} style={{ width: `${share * 100}%` }} />
        {board ? <div className={styles.overlay}>{head}</div> : null}
      </div>
    </div>
  );
}

function Toggle({ nodeId, parameters, write, caption, className, showValue }: WidgetProps) {
  const on = parameters["on"] === true;
  return (
    <div className={className} data-control="toggle" data-control-node={nodeId}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`${styles.toggle} ${on ? styles.on : ""} ${showValue === false ? styles.mini : ""}`}
        onClick={() => write(nodeId, { on: !on }, "commit")}
      >
        <span className={styles.caption} title={caption}>{caption}</span>
        <span className={styles.switch} aria-hidden="true">
          <span className={styles.knob} />
        </span>
        {showValue === false ? null : <span className={styles.state}>{on ? "On" : "Off"}</span>}
      </button>
    </div>
  );
}

function Button({ nodeId, parameters, write, caption, className, showValue }: WidgetProps) {
  const held = parameters["held"] === true;
  const presses = num(parameters["presses"], 0);
  // Pressed from the pointer's own edge, not only from the document's echo of it.
  const [pressing, setPressing] = useState(false);
  const pressed = held || pressing;
  // The count this press wrote on its way down. The release writes the SAME number: the
  // press's live write re-renders this widget with the count already raised, and adding
  // one again on release counted every press twice (T1513b, found by its test).
  const count = useRef(presses);
  return (
    <div className={className} data-control="button" data-control-node={nodeId}>
      <button
        type="button"
        aria-pressed={pressed}
        className={`${styles.button} ${pressed ? styles.pressed : ""}`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setPressing(true);
          count.current = presses + 1;
          write(nodeId, { held: true, presses: count.current }, "live");
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setPressing(false);
          write(nodeId, { held: false, presses: count.current }, "commit");
        }}
      >
        <span className={styles.caption} title={caption}>{caption}</span>
        {showValue === false ? null : <span className={styles.count} title="Presses" data-press-count={presses}>×{presses}</span>}
      </button>
    </div>
  );
}

function XYPad({ nodeId, parameters, write, caption, className, size, showValue }: WidgetProps) {
  const min = num(parameters["min"], 0);
  const max = num(parameters["max"], 1);
  const x = num(parameters["x"], 0.5);
  const y = num(parameters["y"], 0.5);
  const driven = isDriven(parameters["x"]) || isDriven(parameters["y"]);
  const span = max - min || 1;
  const drag = useDrag((u, v, phase) => {
    if (!driven) write(nodeId, { x: min + u * span, y: min + v * span }, phase);
  });
  const head = <Head caption={caption} value={showValue === false ? null : driven ? "driven" : `${format(x)}, ${format(y)}`} />;
  // On a board the pad fills its rect and the header is laid over its top edge.
  const board = size === "board";
  return (
    <div className={className} data-control="xy" data-control-node={nodeId}>
      {board ? null : head}
      <div {...drag} className={`${styles.pad} ${driven ? styles.driven : ""}`} aria-label={caption} role="group">
        {board ? <div className={styles.overlay}>{head}</div> : null}
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
  const Widget = WIDGETS[props.type];
  if (Widget === undefined) return null;
  const caption = controlCaption(props.parameters);
  const className = `${styles.widget} ${props.size === "panel" ? styles.panel : props.size === "board" ? styles.board : styles.node}`;
  return <Widget {...props} caption={caption} className={className} />;
}
