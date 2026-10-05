// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { isParameterSlot, slotFromValue, storedStaticValue } from "@domain/parameters/slots.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { useMidiInput } from "../../app/use-midi-input.ts";
import { parseMidiMapping } from "@domain/midi/midi-mapping.ts";
import type { ControlMidiSurface } from "./control-midi-learn.tsx";
import { ControlsPane } from "./controls-pane.tsx";
import { ControlValuesContext } from "./control-values-context.ts";
import { ControlWidget } from "./control-widget.tsx";

beforeAll(installDomStubs);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function runtimeWith(operations: GraphPatchOperation[]) {
  const runtime = createAppRuntime({ identityStorage: null });
  const added = await runtime.bus.execute("graph.applyPatch", { baseRevision: 0, operations }, runtime.invocation);
  expect(added.status).toBe("applied");
  return runtime;
}
const slider: GraphPatchOperation = { op: "addNode", ref: "$fader", type: "slider", label: "heat", position: { x: 0, y: 0 },
  parameters: { value: 4, min: 2, max: 8, caption: "Heat" } };
const xy: GraphPatchOperation = { op: "addNode", ref: "$xy", type: "xyPad", label: "position", position: { x: 300, y: 0 },
  parameters: { x: 0.25, y: 0.75, caption: "Position" } };
const named = (runtime: AppRuntime, name: string) => Object.values(runtime.bus.store.getGraph().nodes).find(node => node.label === name)!;
function Pane({ runtime, midi }: { runtime: AppRuntime; midi: ControlMidiSurface }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} midi={midi} />;
}
function fakeSession() {
  let listener: Parameters<ControlMidiSurface["arm"]>[0] | null = null;
  const surface: ControlMidiSurface = { state: { kind: "granted" }, ports: [{ id: "keyboard", name: "Keyboard" }], request: vi.fn(),
    arm: vi.fn(next => { listener = next; return () => { if (listener === next) listener = null; }; }) };
  return { surface, send: () => { const next = listener; listener = null;
    next?.({ portId: "keyboard", reading: { source: { kind: "cc", channel: 1, number: 74 }, raw: 127 } }); } };
}
function buttonPointer(button: HTMLElement) {
  const captured = new Set<number>();
  button.setPointerCapture = vi.fn(id => { captured.add(id); });
  button.releasePointerCapture = vi.fn(id => { captured.delete(id); });
  button.hasPointerCapture = vi.fn(id => captured.has(id));
  return (phase: "down" | "up" | "lostcapture", pointerId: number) => {
    if (phase === "lostcapture") captured.delete(pointerId);
    const event = new MouseEvent(phase === "lostcapture" ? "lostpointercapture" : `pointer${phase}`, { button: 0, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    fireEvent(button, event);
  };
}

describe("MIDI Learn from the control panel", () => {
  it("captures real session CC input, commits once, and unlinks back to the manual value", async () => {
    const runtime = await runtimeWith([slider]);
    const port = { id: "keyboard", name: "Keyboard", onmidimessage: null as ((event: { data: Uint8Array }) => void) | null };
    const access = { inputs: { forEach(callback: (input: typeof port) => void) { callback(port); } }, onstatechange: null };
    const requestAccess = vi.fn(async () => access as unknown as MIDIAccess);
    function RealSessionPane() {
      const midi = useMidiInput({ requestAccess });
      return <Pane runtime={runtime} midi={midi} />;
    }
    try {
      render(<RealSessionPane />);
      expect(requestAccess).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "MIDI Learn" })));
      expect(requestAccess).toHaveBeenCalledOnce();
      const track = screen.getByRole("slider", { name: "Heat" });
      const revision = runtime.bus.store.getRevision();
      fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 100 });
      expect(runtime.bus.store.getRevision()).toBe(revision);
      expect(screen.getByRole("status").textContent).toContain("Move a MIDI control for Heat");
      await act(async () => port.onmidimessage?.({ data: new Uint8Array([0xb0, 74, 127]) }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Mapped Heat"));
      expect(runtime.bus.store.getRevision()).toBe(revision + 1);
      const value = named(runtime, "heat").parameters.value;
      expect(isParameterSlot(value) && value.mode).toBe("expression");
      const midiNode = Object.values(runtime.bus.store.getGraph().nodes).find(node => node.type === "midiIn")!;
      expect(parseMidiMapping(midiNode.parameters.mapping).bindings[0]).toMatchObject({ range: [2, 8], rest: 4,
        source: { kind: "cc", channel: 1, number: 74 } });
      await act(async () => port.onmidimessage?.({ data: new Uint8Array([0xb0, 74, 20]) }));
      expect(runtime.bus.store.getRevision()).toBe(revision + 1);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlink MIDI" })));
      const restored = named(runtime, "heat").parameters.value;
      expect(isParameterSlot(restored) && restored.mode).toBe("static");
    } finally { runtime.dispose(); }
  });

  it("targets one XY axis and cancels an armed callback when the panel unmounts", async () => {
    const runtime = await runtimeWith([xy]);
    const midi = fakeSession();
    try {
      const view = render(<Pane runtime={runtime} midi={midi.surface} />);
      fireEvent.click(screen.getByRole("button", { name: "MIDI Learn" }));
      fireEvent.pointerDown(screen.getByRole("group", { name: "Position" }), { button: 0, pointerId: 1 });
      expect(midi.surface.arm).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Learn Y" }));
      await act(async () => midi.send());
      expect(named(runtime, "position").parameters.x).toBe(0.25);
      expect(isParameterSlot(named(runtime, "position").parameters.y)).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Learn X" }));
      const revision = runtime.bus.store.getRevision();
      view.unmount();
      await act(async () => midi.send());
      expect(runtime.bus.store.getRevision()).toBe(revision);
    } finally { runtime.dispose(); }
  });

  it("never toggles a control while selecting it for learning, and cancel writes nothing", async () => {
    const runtime = await runtimeWith([{ op: "addNode", ref: "$switch", type: "toggle", label: "invert", position: { x: 0, y: 0 },
      parameters: { caption: "Invert", on: false } }]);
    const midi = fakeSession();
    try {
      render(<Pane runtime={runtime} midi={midi.surface} />);
      fireEvent.click(screen.getByRole("button", { name: "MIDI Learn" }));
      const revision = runtime.bus.store.getRevision();
      const control = screen.getByRole("switch");
      fireEvent.pointerDown(control, { button: 0, pointerId: 1 });
      fireEvent.click(control);
      fireEvent.click(screen.getByRole("button", { name: "Cancel learn" }));
      await act(async () => midi.send());
      expect(runtime.bus.store.getRevision()).toBe(revision);
      expect(named(runtime, "invert").parameters.on).toBe(false);
    } finally { runtime.dispose(); }
  });

  it("selecting a button for learning never writes its hold or retained count on release", async () => {
    const runtime = await runtimeWith([{ op: "addNode", ref: "$button", type: "button", label: "cut", position: { x: 0, y: 0 },
      parameters: { caption: "Cut", held: slotFromValue(true), presses: slotFromValue(3) } }]);
    const midi = fakeSession();
    try {
      render(<Pane runtime={runtime} midi={midi.surface} />);
      fireEvent.click(screen.getByRole("button", { name: "MIDI Learn" }));
      const control = screen.getByRole("button", { name: /Cut/ });
      const pointer = buttonPointer(control);
      const parameters = named(runtime, "cut").parameters;
      const revision = runtime.bus.store.getRevision();
      await act(async () => { pointer("down", 1); pointer("up", 1); });
      expect(midi.surface.arm).toHaveBeenCalledOnce();
      expect(runtime.bus.store.getRevision()).toBe(revision);
      expect(named(runtime, "cut").parameters).toEqual(parameters);
      expect(control.setPointerCapture).not.toHaveBeenCalled();
      expect(control.releasePointerCapture).not.toHaveBeenCalled();
      expect(control.getAttribute("aria-pressed")).toBe("true");
    } finally { runtime.dispose(); }
  });
});

describe("MIDI-driven widgets display live values", () => {
  it("samples the control's live value and refuses writes without changing the retained slot", async () => {
    const write = vi.fn();
    let live = 6;
    const reader = { read: vi.fn(() => ({ value: live })) };
    const slot = { mode: "expression" as const, bindings: { ...slotFromValue(4).bindings,
      expression: { kind: "expression" as const, source: "op('midi').chan.heat" } } };
    render(<ControlValuesContext.Provider value={reader}><ControlWidget nodeId="fader" type="slider"
      parameters={{ value: slot, min: 2, max: 8, caption: "Heat" }} write={write} /></ControlValuesContext.Provider>);
    await waitFor(() => expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("6"));
    live = 8;
    await waitFor(() => expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("8"));
    fireEvent.pointerDown(screen.getByRole("slider"), { button: 0, pointerId: 1 });
    expect(write).not.toHaveBeenCalled();
    expect(storedStaticValue(slot)).toBe(4);
  });

  it("keeps static envelopes editable without starting a display poll", async () => {
    const read = vi.fn(() => ({ on: true }));
    const write = vi.fn();
    render(<ControlValuesContext.Provider value={{ read }}><ControlWidget nodeId="switch" type="toggle"
      parameters={{ on: slotFromValue(false), caption: "Invert" }} write={write} /></ControlValuesContext.Provider>);
    fireEvent.click(screen.getByRole("switch"));
    expect(write).toHaveBeenCalledWith("switch", { on: true }, "commit");
    expect(read).not.toHaveBeenCalled();
  });

  it("commits a manual button release only for the pointer that started its press", () => {
    const write = vi.fn();
    render(<ControlWidget nodeId="button" type="button"
      parameters={{ held: slotFromValue(false), presses: slotFromValue(3), caption: "Cut" }} write={write} />);
    const control = screen.getByRole("button", { name: /Cut/ });
    const pointer = buttonPointer(control);
    pointer("up", 1);
    expect(write).not.toHaveBeenCalled();
    pointer("down", 1);
    expect(control.hasPointerCapture(1)).toBe(true);
    expect(control.getAttribute("aria-pressed")).toBe("true");
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("button", { held: true, presses: 4 }, "live");
    pointer("up", 2);
    expect(control.hasPointerCapture(1)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    pointer("up", 1);
    expect(control.hasPointerCapture(1)).toBe(false);
    expect(control.getAttribute("aria-pressed")).toBe("false");
    expect(write).toHaveBeenLastCalledWith("button", { held: false, presses: 4 }, "commit");
    expect(write).toHaveBeenCalledTimes(2);
    pointer("lostcapture", 1);
    pointer("up", 1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("releases a button after lost capture and accepts the next press without counting twice", async () => {
    const runtime = await runtimeWith([{ op: "addNode", ref: "$button", type: "button", label: "cut", position: { x: 0, y: 0 },
      parameters: { caption: "Cut", held: false, presses: 3 } }]);
    const midi = fakeSession();
    try {
      render(<Pane runtime={runtime} midi={midi.surface} />);
      const control = screen.getByRole("button", { name: /Cut/ });
      const pointer = buttonPointer(control);
      await act(async () => pointer("down", 1));
      await waitFor(() => expect(named(runtime, "cut").parameters).toMatchObject({ held: true, presses: 4 }));
      expect(control.getAttribute("aria-pressed")).toBe("true");
      await act(async () => pointer("lostcapture", 1));
      await waitFor(() => expect(named(runtime, "cut").parameters).toMatchObject({ held: false, presses: 4 }));
      expect(control.getAttribute("aria-pressed")).toBe("false");
      await act(async () => pointer("down", 2));
      expect(control.hasPointerCapture(2)).toBe(true);
      await waitFor(() => expect(named(runtime, "cut").parameters).toMatchObject({ held: true, presses: 5 }));
      await act(async () => { pointer("up", 2); pointer("lostcapture", 2); });
      await waitFor(() => expect(named(runtime, "cut").parameters).toMatchObject({ held: false, presses: 5 }));
      expect(control.getAttribute("aria-pressed")).toBe("false");
    } finally { runtime.dispose(); }
  });

  it("shows live switch state and button hold/count while protecting their bindings", async () => {
    const driven = (value: number | boolean) => ({ mode: "expression" as const, bindings: {
      ...slotFromValue(value).bindings, expression: { kind: "expression" as const, source: "op('midi').chan.pad" },
    } });
    const write = vi.fn();
    const reader = { read: (id: string) => id === "switch" ? { on: true } : { held: true, presses: 7 } };
    render(<ControlValuesContext.Provider value={reader}>
      <ControlWidget nodeId="switch" type="toggle" parameters={{ on: driven(false), caption: "Invert" }} write={write} />
      <ControlWidget nodeId="button" type="button" parameters={{ held: driven(false), presses: driven(3), caption: "Cut" }} write={write} />
    </ControlValuesContext.Provider>);
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("button", { name: /Cut/ }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-press-count]")?.getAttribute("data-press-count")).toBe("7");
    fireEvent.click(screen.getByRole("switch"));
    const control = screen.getByRole("button", { name: /Cut/ });
    const pointer = buttonPointer(control);
    pointer("down", 1);
    pointer("up", 1);
    expect(control.setPointerCapture).not.toHaveBeenCalled();
    expect(control.releasePointerCapture).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("shows a driven XY axis and lets the unbound axis remain interactive", async () => {
    const write = vi.fn();
    const x = { mode: "expression" as const, bindings: { ...slotFromValue(0.25).bindings,
      expression: { kind: "expression" as const, source: "op('midi').chan.x" } } };
    render(<ControlValuesContext.Provider value={{ read: () => ({ x: 0.8, y: 0.75 }) }}>
      <ControlWidget nodeId="pad" type="xyPad" parameters={{ x, y: 0.75, caption: "Position" }} write={write} />
    </ControlValuesContext.Provider>);
    await waitFor(() => expect(screen.getByText("0.80, 0.75")).toBeDefined());
    fireEvent.pointerDown(screen.getByRole("group", { name: "Position" }), { button: 0, pointerId: 1, clientY: 0 });
    expect(write).toHaveBeenCalledWith("pad", { y: 1 }, "live");
  });
});
