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

/**
 * T1501b — a Layer (and a Presets bank, a Cue List) has nothing to wire into a Panel's value
 * input, so the same drop puts it on the Panel's BOARD by name: one board write riding in
 * the move's patch, no wire, one undo — and the Panel's body shows the layer's switch.
 */
describe("T1501b — a Layer dropped on a Panel joins its board by name", () => {
  it("writes the board item in the same patch as the move, with no wire, one undo step", async () => {
    const { runtime, view, ids } = await mount([{ op: "addNode", ref: "$fx", type: "layer", position: { x: 0, y: 200 }, label: "fx" }]);
    const fx = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === "fx")!.id;
    await waitFor(() => {
      expect(view.container.querySelector(`.react-flow__node[data-id="${fx}"]`)).not.toBeNull();
    });
    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;
    const board = () => String(runtime.bus.store.getGraph().nodes[ids.panel]?.parameters["board"] ?? "");

    await dragNodeCentreTo(view.container, fx, { x: 520 + 178 / 2, y: 60 }, runtime);

    await waitFor(() => {
      expect(board()).toContain('{"member":"fx","rect":{"x":0,"y":0,"w":2,"h":1}}');
    });
    expect(edges(runtime)).toHaveLength(0);
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);
    await waitFor(() => {
      const body = view.container.querySelector(`[data-panel-body="${ids.panel}"]`);
      expect(body?.querySelector('[data-board-member="layer"] [role="switch"]')).not.toBeNull();
    });

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(board()).not.toContain('"fx"');
    expect(runtime.bus.store.getGraph().nodes[fx]?.position).toEqual({ x: 0, y: 200 });
  }, 20_000);
});

/**
 * T1531b — A NODE DROPPED ON A PRESETS BANK BECOMES ONE OF ITS TARGETS, the Panel drop's
 * gesture: the node's name appended to the bank's `targets` in the move's own patch, one
 * undo step. What is asserted is the document the bank's Store reads (`targets`), never
 * which handler ran.
 */
describe("T1531b — a node dropped on a Presets bank becomes a target", () => {
  const nodeNamed = (runtime: AppRuntime, label: string) => Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === label)!.id;
  const targets = (runtime: AppRuntime, bank: string) => runtime.bus.store.getGraph().nodes[bank]?.parameters["targets"];
  async function rendered(view: { container: HTMLElement }, nodeId: string) {
    await waitFor(() => {
      expect(view.container.querySelector(`.react-flow__node[data-id="${nodeId}"]`)).not.toBeNull();
    });
  }

  it("appends the node's name to targets in the same patch as the move, one undo step", async () => {
    const { runtime, view, ids } = await mount([{ op: "addNode", ref: "$bank", type: "presets", position: { x: 260, y: 0 }, label: "looks" }]);
    const bank = nodeNamed(runtime, "looks");
    await rendered(view, bank);
    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;

    await dragNodeCentreTo(view.container, ids.fader, { x: 260 + 178 / 2, y: 60 }, runtime);

    await waitFor(() => {
      expect(targets(runtime, bank)).toBe("fader1");
    });
    expect(edges(runtime)).toHaveLength(0);
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(targets(runtime, bank)).toBe("");
    expect(runtime.bus.store.getGraph().nodes[ids.fader]?.position).toEqual({ x: 0, y: 400 });
  }, 20_000);

  it("writes nothing more for a node that is already a target — the drop is only a move", async () => {
    const { runtime, view, ids } = await mount([
      { op: "addNode", ref: "$bank", type: "presets", position: { x: 260, y: 0 }, label: "looks", parameters: { targets: "fader1" } },
    ]);
    const bank = nodeNamed(runtime, "looks");
    await rendered(view, bank);
    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;

    await dragNodeCentreTo(view.container, ids.fader, { x: 260 + 178 / 2, y: 60 }, runtime);

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[ids.fader]?.position.y).toBeLessThan(200);
    });
    expect(targets(runtime, bank)).toBe("fader1");
    const history = runtime.bus.store.getHistory(actor).undo;
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)?.label).toBe("Move node");
  }, 20_000);

  it("takes no bank, Panel or cue list as a target", async () => {
    const { runtime, view, ids } = await mount([
      { op: "addNode", ref: "$bank", type: "presets", position: { x: 260, y: 0 }, label: "looks" },
      { op: "addNode", ref: "$other", type: "presets", position: { x: 0, y: 200 }, label: "moods" },
      { op: "addNode", ref: "$cues", type: "cueList", position: { x: 260, y: 400 }, label: "show" },
    ]);
    const bank = nodeNamed(runtime, "looks");
    for (const id of [bank, nodeNamed(runtime, "moods"), nodeNamed(runtime, "show")]) await rendered(view, id);

    for (const [dragged, at] of [
      [nodeNamed(runtime, "moods"), { x: 0, y: 200 }],
      [ids.panel, { x: 520, y: 0 }],
      [nodeNamed(runtime, "show"), { x: 260, y: 400 }],
    ] as const) {
      await dragNodeCentreTo(view.container, dragged, { x: 260 + 178 / 2, y: 60 }, runtime);
      await waitFor(() => {
        expect(runtime.bus.store.getGraph().nodes[dragged]?.position).not.toEqual(at);
      });
    }
    expect(targets(runtime, bank)).toBe("");
  }, 30_000);

  it("where a Panel and a bank overlap, the one drawn on top (later in the document) takes the drop", async () => {
    // The bank sits on panel1 and was added after it, so it is drawn on top.
    const onBank = await mount([{ op: "addNode", ref: "$bank", type: "presets", position: { x: 520, y: 0 }, label: "looks" }]);
    const bank = nodeNamed(onBank.runtime, "looks");
    await rendered(onBank.view, bank);
    await dragNodeCentreTo(onBank.view.container, onBank.ids.fader, { x: 520 + 178 / 2, y: 60 }, onBank.runtime);
    await waitFor(() => {
      expect(targets(onBank.runtime, bank)).toBe("fader1");
    });
    expect(edges(onBank.runtime)).toHaveLength(0);
    cleanup();

    // Here a second Panel sits on the bank and was added after it: the Panel takes it.
    const onPanel = await mount([
      { op: "addNode", ref: "$bank", type: "presets", position: { x: 260, y: 0 }, label: "looks" },
      { op: "addNode", ref: "$top", type: "panel", position: { x: 260, y: 0 }, label: "panel2" },
    ]);
    const lowerBank = nodeNamed(onPanel.runtime, "looks");
    const top = nodeNamed(onPanel.runtime, "panel2");
    await rendered(onPanel.view, top);
    await dragNodeCentreTo(onPanel.view.container, onPanel.ids.fader, { x: 260 + 178 / 2, y: 60 }, onPanel.runtime);
    await waitFor(() => {
      expect(edges(onPanel.runtime)).toHaveLength(1);
    });
    expect(edges(onPanel.runtime)[0]?.target.nodeId).toBe(top);
    expect(targets(onPanel.runtime, lowerBank)).toBe("");
  }, 30_000);
});
