// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newKey, newLane, parseAutomation, serializeAutomation } from "@domain/automation/model.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { TimelinePane } from "./timeline-pane.tsx";

/**
 * VN62 — the timeline pane drives the DOCUMENT through the real bus: each gesture is one
 * write to the automation node's `lanes`, and one `graph.undo` takes it back.
 *
 * Geometry: the canvas is 400 × 232 CSS px (32 of ruler, a 200 px curve area); the default
 * view puts tick 0 at x = 0 at 100 px a second and shows −0.05..1.05 bottom to top, so a
 * normalized value v sits at y = 32 + 200 − (v + 0.05) / 1.1 · 200 in client pixels.
 */
beforeAll(installDomStubs);
afterEach(cleanup);

const S = 240_000;
const yOf = (v: number): number => 32 + 200 - ((v + 0.05) / 1.1) * 200;

const LANES = serializeAutomation({
  version: 1,
  lanes: [newLane("lane1", "level", [newKey("k1", 0, 0, { interp: "linear" }), newKey("k2", 2 * S, 1)])],
});

async function runtimeWith(): Promise<{ runtime: AppRuntime; autoId: string; readerId: string }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        { op: "addNode", ref: "$auto", type: "automation", position: { x: 0, y: 0 }, label: "automation_score", parameters: { lanes: LANES } },
        {
          op: "addNode", ref: "$reader", type: "constant", position: { x: 200, y: 0 }, label: "constant_reader",
          parameters: { value: { mode: "expression", bindings: { static: { kind: "static", value: 0 }, expression: { kind: "expression", source: "op('automation_score').chan.level * 2" } } } },
        },
      ],
    } as never,
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return { runtime, autoId: result.output.createdIds["$auto"]!, readerId: result.output.createdIds["$reader"]! };
}

const frameAt = (frameIndex: number): (() => FrameInputs) => () =>
  ({ frame: { frameIndex, timeSeconds: frameIndex / 30, deltaSeconds: 1 / 30, mode: "realtime", randomSeed: 1, fps: 30 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [8, 8] }) as FrameInputs;

function Pane({ runtime, frame = 0, onSeek }: { runtime: AppRuntime; frame?: number; onSeek?: (frame: number) => void }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph) as GraphDocument;
  // A synchronous scheduler: live writes land at once, so a test reads them without waiting a frame.
  const editor = useSyncExternalStore(() => () => {}, () => editors.get(runtime)!);
  return (
    <TimelinePane graph={graph} bus={runtime.bus} invocation={runtime.invocation} selection={[]} latestFrame={frameAt(frame)}
      fps={30} range={{ start: 0, end: 299 }} onSeek={onSeek} editor={editor} />
  );
}
const editors = new Map<AppRuntime, ReturnType<typeof createParameterEditor>>();

async function mount(runtime: AppRuntime, props: { frame?: number; onSeek?: (frame: number) => void } = {}) {
  editors.set(runtime, createParameterEditor({ bus: runtime.bus, context: runtime.invocation, schedule: (callback) => (callback(), () => {}) }));
  const view = await act(async () => render(<Pane runtime={runtime} {...props} />));
  const canvas = view.container.querySelector<HTMLCanvasElement>("[data-timeline-canvas]")!;
  Object.defineProperty(canvas, "clientWidth", { value: 400 });
  Object.defineProperty(canvas, "clientHeight", { value: 232 });
  const pane = view.container.querySelector<HTMLElement>("[data-timeline-pane]")!;
  return { view, canvas, pane };
}

const lanesOf = (runtime: AppRuntime, nodeId: string) => {
  const parsed = parseAutomation(storedStaticValue(runtime.bus.store.getGraph().nodes[nodeId]!.parameters["lanes"]));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.document.lanes;
};
const settle = async () => {
  await act(async () => {
    await editors.values().next().value?.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const undo = async (runtime: AppRuntime) => {
  await act(async () => {
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
  });
};

describe("VN62 — the timeline pane writes the document", () => {
  it("Alt-click inserts a key on the lane under the pointer; one undo removes it", async () => {
    const { runtime, autoId } = await runtimeWith();
    const { canvas } = await mount(runtime);
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 100, clientY: yOf(0.5), altKey: true, button: 0, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 100, clientY: yOf(0.5), pointerId: 1 });
    });
    await settle();
    const keys = lanesOf(runtime, autoId)[0]!.keys;
    expect(keys.map((key) => key.t)).toEqual([0, S, 2 * S]);
    expect(keys[1]!.v).toBeCloseTo(0.5, 12);
    await undo(runtime);
    expect(lanesOf(runtime, autoId)[0]!.keys.map((key) => key.t)).toEqual([0, 2 * S]);
  });

  it("a key drag over several moves is ONE undo step, snapped to frames", async () => {
    const { runtime, autoId } = await runtimeWith();
    const { canvas } = await mount(runtime);
    const before = runtime.bus.store.getRevision();
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 200, clientY: yOf(1), button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 180, clientY: yOf(1), pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 150, clientY: yOf(1), pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 120, clientY: yOf(1), pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 120, clientY: yOf(1), pointerId: 1 });
    });
    await settle();
    expect(runtime.bus.store.getRevision()).toBeGreaterThan(before);
    expect(lanesOf(runtime, autoId)[0]!.keys.map((key) => key.t)).toEqual([0, 288_000]);
    await undo(runtime);
    expect(lanesOf(runtime, autoId)[0]!.keys.map((key) => key.t)).toEqual([0, 2 * S]);
  });

  it("renaming a lane rewrites the parameter that reads it; one undo restores both", async () => {
    const { runtime, autoId, readerId } = await runtimeWith();
    await mount(runtime);
    const source = () => (runtime.bus.store.getGraph().nodes[readerId]!.parameters["value"] as { bindings: { expression: { source: string } } }).bindings.expression.source;
    expect(screen.getByText("1", { selector: "[data-references]" })).toBeTruthy();
    await act(async () => {
      fireEvent.doubleClick(screen.getByText("level"));
    });
    const field = screen.getByLabelText("rename level");
    await act(async () => {
      fireEvent.change(field, { target: { value: "glow" } });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await settle();
    expect(lanesOf(runtime, autoId)[0]!.name).toBe("glow");
    expect(source()).toBe("op('automation_score').chan.glow * 2");
    await undo(runtime);
    expect(lanesOf(runtime, autoId)[0]!.name).toBe("level");
    expect(source()).toBe("op('automation_score').chan.level * 2");
  });

  it("mute holds the value at the playhead", async () => {
    const { runtime, autoId } = await runtimeWith();
    // Frame 30 at 30 fps is one second: halfway up the 0 → 1 ramp over two seconds.
    await mount(runtime, { frame: 30 });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("mute level"));
    });
    await settle();
    expect(lanesOf(runtime, autoId)[0]).toMatchObject({ mute: true, mutedValue: 0.5 });
  });

  it("a click on the ruler seeks to the frame under the pointer", async () => {
    const { runtime } = await runtimeWith();
    const onSeek = vi.fn();
    const { canvas } = await mount(runtime, { onSeek });
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 50, clientY: 10, button: 0, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 50, clientY: 10, pointerId: 1 });
    });
    expect(onSeek).toHaveBeenCalledWith(15);
  });

  it("Delete removes the selected key, and the key never reaches the window's keymap", async () => {
    const { runtime, autoId } = await runtimeWith();
    const { canvas, pane } = await mount(runtime);
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);
    try {
      await act(async () => {
        fireEvent.pointerDown(canvas, { clientX: 200, clientY: yOf(1), button: 0, pointerId: 1 });
        fireEvent.pointerUp(canvas, { clientX: 200, clientY: yOf(1), pointerId: 1 });
      });
      await act(async () => {
        fireEvent.keyDown(pane, { key: "Delete" });
      });
      await settle();
      expect(lanesOf(runtime, autoId)[0]!.keys.map((key) => key.t)).toEqual([0]);
      expect(reachedWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", reachedWindow);
    }
  });
});
