// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T1512b — DROPPING A WIDGET NODE ON A PANEL WIRES IT IN, through the real app: the widget
 * is dragged with real pointer events through the real canvas (T213's harness), and what
 * is asserted is the DOCUMENT — the widget's `out` wired into the Panel's Controls, in one
 * patch with the move, undone in one step — and what the Panel's body then shows.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  installLayoutStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}

function installLayoutStubs(): void {
  const base = Element.prototype.getBoundingClientRect;
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function stub(this: Element): DOMRect {
      if (this.classList.contains("react-flow")) return domRect(0, 0, 1000, 700);
      if (this.classList.contains("react-flow__pane")) return domRect(0, 0, 1000, 700);
      return base.call(this);
    },
  });
}

function mouse(target: Element | Document, type: string, init: MouseEventInit): void {
  const doc = target instanceof Document ? target : target.ownerDocument;
  const win = doc.defaultView;
  if (win === null) throw new Error("no window");
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "view", { value: win });
  target.dispatchEvent(event);
}

function viewportTransform(container: HTMLElement): { x: number; y: number; zoom: number } {
  const style = container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(style);
  if (match === null) throw new Error(`could not read the viewport transform from "${style}"`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

/** Drags a node (178x120 under `installFlowStubs`) so its centre lands on a graph point. */
async function dragNodeCentreTo(container: HTMLElement, nodeId: string, graphPoint: { x: number; y: number }, runtime: AppRuntime): Promise<void> {
  const element = container.querySelector(`.react-flow__node[data-id="${nodeId}"] header`);
  if (element === null) throw new Error(`node ${nodeId} is not rendered`);
  const node = runtime.bus.store.getGraph().nodes[nodeId]!;
  const transform = viewportTransform(container);
  const delta = {
    x: (graphPoint.x - 178 / 2 - node.position.x) * transform.zoom,
    y: (graphPoint.y - 120 / 2 - node.position.y) * transform.zoom,
  };
  const from = { x: 300, y: 400 };
  await act(async () => {
    mouse(element, "mousedown", { button: 0, buttons: 1, clientX: from.x, clientY: from.y });
    mouse(element.ownerDocument, "mousemove", { button: 0, buttons: 1, clientX: from.x + 2, clientY: from.y + 2 });
    for (let step = 1; step <= 6; step += 1) {
      mouse(element.ownerDocument, "mousemove", { button: 0, buttons: 1, clientX: from.x + (delta.x * step) / 6, clientY: from.y + (delta.y * step) / 6 });
    }
    mouse(element.ownerDocument, "mouseup", { button: 0, buttons: 0, clientX: from.x + delta.x, clientY: from.y + delta.y });
  });
}

async function mount(extra: GraphPatchOperation[] = []) {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const seeded = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "seed",
      operations: [
        { op: "addNode", ref: "$fader", type: "slider", position: { x: 0, y: 400 }, label: "fader1", parameters: { channel: "heat" } },
        { op: "addNode", ref: "$panel", type: "panel", position: { x: 520, y: 0 }, label: "panel1" },
        ...extra,
      ],
    },
    runtime.invocation,
  );
  const ids = { fader: seeded.output.createdIds["$fader"] as string, panel: seeded.output.createdIds["$panel"] as string };
  const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />);
  await act(async () => {});
  await waitFor(() => {
    expect(view.container.querySelector(`.react-flow__node[data-id="${ids.panel}"]`)).not.toBeNull();
  });
  return { runtime, view, ids };
}

const edges = (runtime: AppRuntime) => Object.values(runtime.bus.store.getGraph().edges);

describe("T1512b — a widget dropped on a Panel joins it", () => {
  it("wires the widget into the Panel's Controls in the same patch as the move, one undo step", async () => {
    const { runtime, view, ids } = await mount();
    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;

    await dragNodeCentreTo(view.container, ids.fader, { x: 520 + 178 / 2, y: 60 }, runtime);

    await waitFor(() => {
      expect(edges(runtime)).toHaveLength(1);
    });
    expect(edges(runtime).map((edge) => [edge.source, edge.target])).toEqual([
      [{ nodeId: ids.fader, portId: "out" }, { nodeId: ids.panel, portId: "controls" }],
    ]);
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);
    // The Panel's body now shows the slider it was handed.
    await waitFor(() => {
      const body = view.container.querySelector(`[data-panel-body="${ids.panel}"]`);
      expect(body?.querySelector(`[data-control-node="${ids.fader}"]`)).not.toBeNull();
    });

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(edges(runtime)).toHaveLength(0);
    expect(runtime.bus.store.getGraph().nodes[ids.fader]?.position).toEqual({ x: 0, y: 400 });
  }, 20_000);

  it("is an ordinary move when the widget lands beside the Panel", async () => {
    const { runtime, view, ids } = await mount();
    await dragNodeCentreTo(view.container, ids.fader, { x: 300, y: 60 }, runtime);
    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[ids.fader]?.position.y).toBeLessThan(200);
    });
    expect(edges(runtime)).toHaveLength(0);
  }, 20_000);
});
