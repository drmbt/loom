import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import type { EditPhase } from "@ui/controls/types.ts";
import { controlChannel } from "@nodes/definitions/controls.ts";
import styles from "./control-widget.module.css";

/**
 * T1388b — ONE widget, drawn wherever a control node is shown: in its own body on the canvas
 * and on a Panel in the controls pane. It reads the node's parameters and writes them back
 * through the parameter editor, so a drag is live frames plus one committed undo group
 * (`createParameterEditor`) and every write is an ordinary audited patch (§V30).
 *
 * A parameter the document DRIVES (an expression, a MIDI binding) is shown, not grabbed: the
 * widget draws the driven number and refuses the gesture, rather than fighting the driver.
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
  /** Bigger touch targets on a Panel; compact in a node body. */
  readonly size?: "node" | "panel";
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
/** A stored parameter that is not a plain value (an expression or binding slot) is driven. */
const isDriven = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value);

function snap(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

function format(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude >= 100 ? value.toFixed(0) : magnitude >= 10 ? value.toFixed(1) : value.toFixed(2);
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

function Slider({ nodeId, parameters, write, caption, className }: WidgetProps) {
  const min = num(parameters["min"], 0);
  const max = num(parameters["max"], 1);
  const step = num(parameters["step"], 0);
  const driven = isDriven(parameters["value"]);
  const value = num(parameters["value"], min);
  const share = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const drag = useDrag((x, _y, phase) => {
    if (!driven) write(nodeId, { value: snap(min + x * (max - min), step) }, phase);
  });
  return (
    <div className={className} data-control="slider" data-control-node={nodeId}>
      <span className={styles.caption}>{caption}</span>
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
      </div>
      <span className={styles.readout}>{driven ? "driven" : format(value)}</span>
    </div>
  );
}

function Toggle({ nodeId, parameters, write, caption, className }: WidgetProps) {
  const on = parameters["on"] === true;
  return (
    <div className={className} data-control="toggle" data-control-node={nodeId}>
      <button type="button" className={`${styles.toggle} ${on ? styles.on : ""}`} aria-pressed={on} onClick={() => write(nodeId, { on: !on }, "commit")}>
        {caption}
      </button>
    </div>
  );
}

function Button({ nodeId, parameters, write, caption, className }: WidgetProps) {
  const held = parameters["held"] === true;
  const presses = num(parameters["presses"], 0);
  return (
    <div className={className} data-control="button" data-control-node={nodeId}>
      <button
        type="button"
        className={`${styles.button} ${held ? styles.on : ""}`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          write(nodeId, { held: true, presses: presses + 1 }, "live");
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          write(nodeId, { held: false, presses: presses + 1 }, "commit");
        }}
      >
        {caption}
      </button>
    </div>
  );
}

function XYPad({ nodeId, parameters, write, caption, className }: WidgetProps) {
  const min = num(parameters["min"], 0);
  const max = num(parameters["max"], 1);
  const x = num(parameters["x"], 0.5);
  const y = num(parameters["y"], 0.5);
  const driven = isDriven(parameters["x"]) || isDriven(parameters["y"]);
  const span = max - min || 1;
  const drag = useDrag((u, v, phase) => {
    if (!driven) write(nodeId, { x: min + u * span, y: min + v * span }, phase);
  });
  return (
    <div className={className} data-control="xy" data-control-node={nodeId}>
      <span className={styles.caption}>{caption}</span>
      <div {...drag} className={`${styles.pad} ${driven ? styles.driven : ""}`} aria-label={caption} role="group">
        <div className={styles.puck} style={{ left: `${((x - min) / span) * 100}%`, bottom: `${((y - min) / span) * 100}%` }} />
      </div>
      <span className={styles.readout}>
        {driven ? "driven" : `${format(x)}, ${format(y)}`}
      </span>
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
  const channel = controlChannel(props.parameters);
  const caption = typeof props.parameters["caption"] === "string" && props.parameters["caption"] !== "" ? props.parameters["caption"] : channel;
  const className = `${styles.widget} ${props.size === "panel" ? styles.panel : styles.node}`;
  return <Widget {...props} caption={caption} className={className} />;
}
