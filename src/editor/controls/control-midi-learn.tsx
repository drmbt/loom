import { useCallback, useEffect, useRef, useState, type PointerEvent, type MouseEvent } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { MidiReading } from "@domain/midi/midi-mapping.ts";
import { describeMidiSource } from "@domain/midi/midi-mapping.ts";
import { midiStatusLine, type MidiAccessState, type MidiInputPort } from "@domain/midi/midi-status.ts";
import { CONTROL_WIDGET_TYPES } from "@nodes/definitions/controls.ts";
import { Button } from "@ui/primitives/button.tsx";
import { controlCaption } from "./board-fit.ts";
import { controlMidiBinding } from "./midi-controls.ts";
import styles from "./controls-pane.module.css";

/** The existing session's single learn listener; no second MIDI access is constructed. */
export interface ControlMidiSurface {
  readonly state: MidiAccessState;
  readonly ports: readonly MidiInputPort[];
  readonly request: () => void;
  readonly arm: (listener: (event: { reading: MidiReading; portId: string }) => void) => () => void;
}

interface Target { readonly nodeId: string; readonly key: string; readonly caption: string; readonly xy: boolean }

/** Panel-level capture works for wired boards, legacy rows, and the loose control grid. */
export function useControlMidiLearn(bus: LoomBus, invocation: InvocationContext,
  midi: ControlMidiSurface | undefined, scope: string, enabled: boolean) {
  const [active, setActive] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [learning, setLearning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const disarm = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
    disarm.current?.();
    disarm.current = null;
  }, []);
  const cancel = () => {
    invalidate();
    setLearning(false);
  };
  useEffect(() => {
    setActive(false); setTarget(null); setLearning(false); setMessage(null);
    return invalidate;
  }, [bus, midi?.arm, scope, invalidate]);

  const arm = (next: Target) => {
    cancel(); setTarget(next); setMessage(null);
    if (midi?.state.kind !== "granted" || midi.ports.length === 0) return;
    const ticket = generation.current;
    setLearning(true);
    disarm.current = midi.arm(({ reading, portId }) => {
      disarm.current = null;
      setLearning(false);
      void bus.execute("control.learnMidi", { nodeId: next.nodeId, parameterKey: next.key,
        source: reading.source, portId }, invocation).then(result => {
        if (generation.current !== ticket) return;
        setMessage(result.status === "applied" ? `Mapped ${next.caption}: ${describeMidiSource(reading.source)}`
          : result.diagnostics?.map(item => item.message).join(" ") ?? "MIDI mapping was rejected.");
      }).catch((cause: unknown) => {
        if (generation.current === ticket) setMessage(cause instanceof Error ? cause.message : String(cause));
      });
    });
  };
  const capture = (event: PointerEvent<HTMLElement>) => {
    if (!active || !enabled || event.button !== 0 || !(event.target instanceof Element)) return;
    const id = event.target.closest<HTMLElement>("[data-control-node]")?.dataset.controlNode;
    if (id === undefined) return;
    const node = bus.store.getGraph().nodes[id];
    if (node === undefined || !CONTROL_WIDGET_TYPES.has(node.type)) return;
    event.preventDefault(); event.stopPropagation();
    const xy = node.type === "xyPad";
    const next = { nodeId: id, key: node.type === "slider" ? "value" : node.type === "toggle" ? "on"
      : node.type === "button" ? "held" : "x", caption: controlCaption(node.parameters), xy };
    if (xy) { cancel(); setTarget(next); setMessage(null); }
    else arm(next);
  };
  // Toggle's click follows pointerdown. Learning must not change the control itself.
  const captureClick = (event: MouseEvent<HTMLElement>) => {
    if (active && enabled && event.target instanceof Element && event.target.closest("[data-control-node]") !== null) {
      event.preventDefault(); event.stopPropagation();
    }
  };
  const unlink = (key: string) => {
    if (target === null) return;
    cancel(); setMessage(null);
    const ticket = generation.current;
    void bus.execute("control.unlearnMidi", { nodeId: target.nodeId, parameterKey: key }, invocation)
      .then(result => { if (generation.current === ticket) setMessage(result.status === "applied" ? `Unlinked ${target.caption}`
        : result.diagnostics?.map(item => item.message).join(" ") ?? "MIDI unlink was rejected."); })
      .catch((cause: unknown) => { if (generation.current === ticket) setMessage(cause instanceof Error ? cause.message : String(cause)); });
  };
  const status = midi === undefined ? null : midiStatusLine(midi.state, midi.ports.length);
  const linked = (key: string) => target !== null && controlMidiBinding(bus.store.getGraph(), target.nodeId, key) !== null;
  const toolbar = midi === undefined || status === null ? null : (
    <div className={styles.midiToolbar}>
      <Button variant="outline" aria-pressed={active} disabled={!enabled || midi.state.kind === "unsupported" || midi.state.kind === "requesting"}
        title={status.headline} onClick={() => {
          cancel(); setTarget(null); setMessage(null); setActive(!active);
          if (!active && status.canRequest) midi.request();
        }}>MIDI Learn</Button>
      {active ? <>
        <span role="status">{message ?? (midi.state.kind !== "granted" || midi.ports.length === 0
          ? [status.headline, status.hint].filter(Boolean).join(". ")
          : learning && target !== null ? `Move a MIDI control for ${target.caption}${target.xy ? ` ${target.key.toUpperCase()}` : ""}`
            : target?.xy ? `Choose an axis for ${target.caption}` : "Click a control, then move a MIDI knob.")}</span>
        {target?.xy ? ["x", "y"].map(key => <span key={key}>
          <Button variant="outline" disabled={midi.state.kind !== "granted" || midi.ports.length === 0}
            onClick={() => arm({ ...target, key })}>Learn {key.toUpperCase()}</Button>
          {linked(key) ? <Button onClick={() => unlink(key)}>Unlink {key.toUpperCase()}</Button> : null}
        </span>) : target !== null && linked(target.key) ? <Button onClick={() => unlink(target.key)}>Unlink MIDI</Button> : null}
        {learning ? <Button onClick={() => { cancel(); setTarget(null); }}>Cancel learn</Button> : null}
        {status.canRequest ? <Button variant="outline" onClick={midi.request}>Enable MIDI</Button> : null}
      </> : midi.state.kind === "unsupported" ? <span role="status">{status.headline}</span> : null}
    </div>
  );
  return { active, capture, captureClick, toolbar };
}
