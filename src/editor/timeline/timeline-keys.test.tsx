// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newKey, newLane, parseAutomation, serializeAutomation } from "@domain/automation/model.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * VN62 — A KEY THE TIMELINE HANDLES NEVER ALSO REACHES THE GRAPH.
 *
 * Delete is the graph's `graph.removeNodes` while the graph holds focus. With a node
 * selected on the canvas and the timeline focused, Delete must remove the selected KEY and
 * leave the node alone: the destructive key fires where the user is, not where they were
 * (B67's shape). Through the whole App: the real keymap on the window, the real canvas
 * selection, the timeline tab opened from the dock.
 */
beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  const range = Range.prototype as unknown as Record<string, unknown>;
  range["getClientRects"] ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
  range["getBoundingClientRect"] ??= () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) });
});
afterEach(cleanup);

const S = 240_000;
const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };
const yOf = (v: number): number => 32 + 200 - ((v + 0.05) / 1.1) * 200;

describe("VN62 — Delete over the timeline", () => {
  it("removes the selected key, and the node selected in the graph survives", async () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
    const seeded = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "seed",
        operations: [
          { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
          {
            op: "addNode", ref: "$auto", type: "automation", position: { x: 0, y: 300 }, label: "automation_score",
            parameters: { lanes: serializeAutomation({ version: 1, lanes: [newLane("lane1", "level", [newKey("k1", 0, 0), newKey("k2", 2 * S, 1)])] }) },
          },
        ],
      },
      runtime.invocation,
    );
    const solidId = seeded.output.createdIds["$solid"]!;
    const autoId = seeded.output.createdIds["$auto"]!;
    const view = await act(async () => render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />));

    // Select the solid on the canvas, as a user would.
    const nodeElement = view.container.querySelector(`.react-flow__node[data-id="${solidId}"]`);
    if (nodeElement === null) throw new Error("expected the solid on the canvas");
    await act(async () => {
      fireEvent.click(nodeElement);
    });
    await waitFor(() => expect(screen.queryByText("No node selected")).toBeNull());

    // Open the timeline tab, size its canvas, and click the key at two seconds.
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "timeline" }));
    });
    const canvas = await waitFor(() => {
      const found = view.container.querySelector<HTMLCanvasElement>("[data-timeline-canvas]");
      if (found === null) throw new Error("timeline not mounted");
      return found;
    });
    Object.defineProperty(canvas, "clientWidth", { value: 400 });
    Object.defineProperty(canvas, "clientHeight", { value: 232 });
    canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 232, width: 400, height: 232, toJSON: () => ({}) });
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 200, clientY: yOf(1), button: 0, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 200, clientY: yOf(1), pointerId: 1 });
    });
    // The key goes where a real key goes: to whatever holds focus after that click.
    const focused = document.activeElement ?? document.body;
    await act(async () => {
      fireEvent.keyDown(focused, { key: "Delete" });
    });
    await waitFor(() => {
      const lanes = parseAutomation(storedStaticValue(runtime.bus.store.getGraph().nodes[autoId]!.parameters["lanes"]));
      expect(lanes.ok && lanes.document.lanes[0]!.keys.map((key) => key.t)).toEqual([0]);
    });
    expect(runtime.bus.store.getGraph().nodes[solidId]).toBeDefined();
  }, 30_000);
});
