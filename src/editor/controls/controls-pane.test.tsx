// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { ControlsPane } from "./controls-pane.tsx";

/**
 * T1388b — the controls pane drives the DOCUMENT, not a copy: a Panel lays its widgets out
 * under headings, dragging a slider there writes the slider node's value through the bus, and
 * "map" makes another node's parameter READ the slider — an expression slot naming the
 * widget and its channel, which is what makes the control drive anything at all.
 */
afterEach(cleanup);

async function runtimeWith(): Promise<AppRuntime> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        { op: "addNode", ref: "node:fader", type: "slider", position: { x: 0, y: 0 }, label: "fader1", parameters: { channel: "heat", value: 0.25, min: 0, max: 1 } },
        { op: "addNode", ref: "node:panel", type: "panel", position: { x: 0, y: 200 }, label: "panel1", parameters: { title: "Furnace", layout: "# Melt\nfader1" } },
        { op: "addNode", ref: "node:blur", type: "blur", position: { x: 300, y: 0 }, label: "blur1" },
      ],
    } as never,
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return runtime;
}

function Pane({ runtime }: { runtime: AppRuntime }) {
  return <ControlsPane graph={runtime.bus.store.getGraph()} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} />;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("T1388b — the controls pane", () => {
  it("lays the Panel out and a drag writes the slider node's value", async () => {
    const runtime = await runtimeWith();
    render(<Pane runtime={runtime} />);
    expect(screen.getByText("Furnace")).not.toBeNull();
    expect(screen.getByText("Melt")).not.toBeNull();
    const track = screen.getByRole("slider", { name: "heat" });
    track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    track.setPointerCapture = () => undefined;
    track.releasePointerCapture = () => undefined;
    track.hasPointerCapture = () => true;
    await act(async () => {
      fireEvent.pointerDown(track, { clientX: 80, clientY: 5, pointerId: 1 });
      fireEvent.pointerUp(track, { clientX: 80, clientY: 5, pointerId: 1 });
      await settle();
    });
    const fader = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === "fader1")!;
    expect(fader.parameters["value"]).toBeCloseTo(0.8, 6);
  });

  it("map makes another parameter read the control's channel", async () => {
    const runtime = await runtimeWith();
    render(<Pane runtime={runtime} />);
    fireEvent.click(screen.getByText("map…"));
    const blur = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === "blur1")!;
    fireEvent.change(screen.getByLabelText("Node to drive"), { target: { value: blur.id } });
    fireEvent.change(screen.getByLabelText("Parameter to drive"), { target: { value: "size" } });
    await act(async () => {
      fireEvent.click(screen.getByText("map"));
      await settle();
    });
    const size = runtime.bus.store.getGraph().nodes[blur.id]!.parameters["size"] as { mode: string; bindings: { expression: { source: string } } };
    expect(size.mode).toBe("expression");
    expect(size.bindings.expression.source).toBe("op('fader1').chan.heat");
  });
});
