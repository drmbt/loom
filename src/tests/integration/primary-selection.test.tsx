// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T1531b — THE INSPECTOR SHOWS THE LAST-CLICKED NODE OF A MULTI-SELECTION, through the real
 * app: real clicks on the real canvas, and what is asserted is which node the inspector is
 * showing and what the bank's "Add N selected" writes to the document.
 *
 * The nodes are seeded so that the bank comes LAST in document order and `fader1` FIRST:
 * the old rule (`selection[0]`, React Flow's order) shows `fader1` for every one of these
 * selections, so each assertion below fails against it.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

async function mount() {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const seeded = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "seed",
      operations: [
        { op: "addNode", ref: "$a", type: "slider", position: { x: 0, y: 0 }, label: "fader1" },
        { op: "addNode", ref: "$b", type: "slider", position: { x: 0, y: 300 }, label: "fader2" },
        { op: "addNode", ref: "$panel", type: "panel", position: { x: 300, y: 300 }, label: "panel1" },
        { op: "addNode", ref: "$bank", type: "presets", position: { x: 300, y: 0 }, label: "looks" },
      ],
    },
    runtime.invocation,
  );
  const created = seeded.output.createdIds;
  const ids = { a: created["$a"] as string, b: created["$b"] as string, panel: created["$panel"] as string, bank: created["$bank"] as string };
  const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />);
  await act(async () => {});
  await waitFor(() => {
    for (const id of Object.values(ids)) expect(view.container.querySelector(`[data-testid="node-${id}"]`)).not.toBeNull();
  });
  return { runtime, view, ids };
}

/**
 * A click the way a person makes one; `add` holds the multi-selection key. React Flow reads
 * that key off window keydown/keyup — Meta on a Mac, Control elsewhere, by user agent — and
 * matches the held set EXACTLY, so only the one it is listening for is pressed.
 */
async function click(view: ReturnType<typeof render>, nodeId: string, add = false): Promise<void> {
  const element = view.container.querySelector(`[data-testid="node-${nodeId}"]`);
  if (element === null) throw new Error(`the node ${nodeId} did not render`);
  const win = element.ownerDocument.defaultView;
  if (win === null) throw new Error("no window");
  const keys = add ? [win.navigator.userAgent.includes("Mac") ? "Meta" : "Control"] : [];
  await act(async () => {
    for (const key of keys) win.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 20, metaKey: add, ctrlKey: add });
      Object.defineProperty(event, "view", { value: win });
      element.dispatchEvent(event);
    }
  });
  await act(async () => {
    for (const key of keys) win.dispatchEvent(new win.KeyboardEvent("keyup", { key, bubbles: true }));
  });
}

const inspected = (view: ReturnType<typeof render>) =>
  view.container.querySelector('[data-testid="inspector-scroll"] [data-node-id]')?.getAttribute("data-node-id") ?? null;
const addButton = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll<HTMLButtonElement>('[data-testid="inspector-scroll"] button')].find((button) => /selected as targets/.test(button.textContent ?? "")) ?? null;
const targets = (runtime: AppRuntime, bank: string) => runtime.bus.store.getGraph().nodes[bank]?.parameters["targets"];
const selectedOnCanvas = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll(".react-flow__node.selected")].map((node) => node.getAttribute("data-id")).sort();

describe("T1531b — the inspector shows the last-clicked node of a multi-selection", () => {
  it("follows the click order, falls back to the most recent still selected, and a click promotes a member", async () => {
    const { view, ids } = await mount();

    await click(view, ids.b);
    await click(view, ids.a, true);
    await waitFor(() => expect(selectedOnCanvas(view)).toEqual([ids.a, ids.b].sort()));
    expect(inspected(view)).toBe(ids.a);

    await click(view, ids.bank, true);
    await waitFor(() => expect(inspected(view)).toBe(ids.bank));

    // Deselecting the primary falls back to the most recently added node still selected —
    // fader1, clicked after fader2 — not to the first in any canvas order.
    await click(view, ids.bank, true);
    await waitFor(() => expect(selectedOnCanvas(view)).toEqual([ids.a, ids.b].sort()));
    expect(inspected(view)).toBe(ids.a);
    await click(view, ids.a, true);
    await waitFor(() => expect(inspected(view)).toBe(ids.b));

    // A plain click on a node already in the selection keeps the selection and promotes it.
    await click(view, ids.bank, true);
    await click(view, ids.a, true);
    await waitFor(() => expect(inspected(view)).toBe(ids.a));
    await click(view, ids.bank);
    await waitFor(() => expect(inspected(view)).toBe(ids.bank));
    expect(selectedOnCanvas(view)).toEqual([ids.a, ids.b, ids.bank].sort());
  }, 30_000);

  it("select-all keeps the primary it found", async () => {
    const { runtime, view, ids } = await mount();
    await click(view, ids.bank);
    await waitFor(() => expect(inspected(view)).toBe(ids.bank));
    await act(async () => {
      await runtime.bus.execute("graph.selectAll", {}, runtime.invocation);
    });
    await waitFor(() => expect(selectedOnCanvas(view)).toHaveLength(4));
    expect(inspected(view)).toBe(ids.bank);
  }, 20_000);
});

describe("T1531b — the bank section adds the other selected nodes as targets", () => {
  it("offers \"Add 2 selected\" (not the Panel), writes both names in one step, one undo removes them", async () => {
    const { runtime, view, ids } = await mount();
    await click(view, ids.a);
    await click(view, ids.b, true);
    await click(view, ids.panel, true);
    await click(view, ids.bank, true);
    await waitFor(() => expect(inspected(view)).toBe(ids.bank));
    const button = await waitFor(() => {
      const found = addButton(view);
      expect(found).not.toBeNull();
      return found!;
    });
    expect(button.textContent).toBe("Add 2 selected as targets");

    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;
    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(targets(runtime, ids.bank)).toBe("fader1 fader2"));
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);
    // Both are targets now, so there is nothing left to offer.
    await waitFor(() => expect(addButton(view)).toBeNull());

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(targets(runtime, ids.bank)).toBe("");
  }, 30_000);

  it("counts only the nodes not yet targeted", async () => {
    const { runtime, view, ids } = await mount();
    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: ids.bank, parameters: { targets: "fader1" } }] },
        runtime.invocation,
      );
    });
    await click(view, ids.a);
    await click(view, ids.b, true);
    await click(view, ids.bank, true);
    await waitFor(() => expect(addButton(view)?.textContent).toBe("Add 1 selected as targets"));
    await act(async () => {
      addButton(view)!.click();
    });
    await waitFor(() => expect(targets(runtime, ids.bank)).toBe("fader1 fader2"));
  }, 30_000);
});
