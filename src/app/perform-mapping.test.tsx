import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { compileGraph } from "@compiler/compile.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { DEFAULT_PROJECT_SETTINGS } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { gridOf } from "@nodes/definitions/grid-warp.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { LoomBackend, PresentationOptions } from "@runtime/backend/backend-types.ts";
import { TIER_B_CAPABILITIES } from "@/examples/runner.ts";
import { createDisplaySinkStore } from "./display-sinks.ts";
import type { ScreenSource } from "./perform-screens.ts";
import { usePerformWindows } from "./use-perform-windows.ts";
import type { PerformPlan } from "./use-perform-windows.ts";

/**
 * §T1536b — EDIT MAPPING ON THE PERFORM WINDOW, through the real Window Out wiring: the
 * real bus, the real `perform.toggle`, a plan from the real compiler with the window's
 * display sink, and the window's own document. What is asserted is what the operator meets
 * on the projector — where a handle is drawn in the window's pixels, what a drag writes into
 * the document (and that one undo takes it back), and the named refusal when the handles
 * could not land where the parameter puts them.
 *
 * The stage, chosen so BOTH letterboxes are live and the expected pixels are worked by hand:
 *
 *   Checker (project 1280×720) → Corner Pin → Window Out 1000×1000, Fit "fit"
 *   perform window 1600×1000 CSS px
 *
 *   Fit: ratio = (1000/1000) / (1280/720) = 0.5625 < 1, so the 16:9 picture is scaled into
 *        the middle 56.25 % of the square's height: v_target = (v − 0.5)·0.5625 + 0.5.
 *   Canvas `object-fit: contain`: the 1000×1000 bitmap in 1600×1000 → x 300..1300, y 0..1000.
 *
 *   Pin Bottom Left at (0.1, 0.2) → x = 300 + 0.1·1000 = 400,
 *                                   y = (1 − ((0.2 − 0.5)·0.5625 + 0.5))·1000 = 668.75.
 */

const context = contextFor(alice);
const registry = createNodeRegistry(allNodeDefinitions).view();

const screens: ScreenSource = {
  screens: () => [],
  editor: () => undefined,
  permission: () => "unsupported",
  request: () => Promise.resolve(),
  subscribe: () => () => {},
};

const WINDOW: readonly [number, number] = [1600, 1000];

interface Stage {
  /** Node types in chain order, source first; the last one feeds the Window Out. */
  readonly chain: readonly string[];
  readonly parameters?: Readonly<Record<number, Record<string, StoredParameter>>>;
}

async function setup({ chain, parameters = {} }: Stage) {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  const { bus } = createDomainBus({ store, registry });
  const types = [...chain, "window"];
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        ...types.map((type, index) => ({
          op: "addNode" as const,
          ref: `$${String(index)}` as const,
          type,
          position: { x: index * 300, y: 0 },
          ...(parameters[index] === undefined ? {} : { parameters: parameters[index] }),
        })),
        ...types.slice(1).map((type, index) => ({
          op: "connect" as const,
          source: { nodeId: `$${String(index)}` as const, portId: "out" },
          target: { nodeId: `$${String(index + 1)}` as const, portId: type === "lookup" ? "source" : type === "null" ? "in" : "input" },
        })),
        { op: "setParameters" as const, nodeId: `$${String(types.length - 1)}` as const, parameters: { width: 1000, height: 1000, fit: "fit" } },
      ],
    },
    context,
  );
  expect(created.status, JSON.stringify(created.diagnostics)).toBe("applied");
  const ids = types.map((_, index) => created.output.createdIds[`$${String(index)}`] as NodeId);
  const windowId = ids[ids.length - 1]!;
  const displaySinks = createDisplaySinkStore();
  const presented: Array<{ options: PresentationOptions; outputs: string[]; disposed: boolean }> = [];
  const backend = {
    setFrameSource: () => {},
    present: (_canvas: unknown, options: PresentationOptions) => {
      const entry = { options, outputs: [options.outputId], disposed: false };
      presented.push(entry);
      return { id: "p", outputId: options.outputId, setOutput: (next: string) => entry.outputs.push(next), dispose: () => { entry.disposed = true; } };
    },
  } as unknown as LoomBackend;
  const openWindow = () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const child = frame.contentWindow;
    if (child !== null) {
      Object.defineProperty(child, "innerWidth", { value: WINDOW[0], configurable: true });
      Object.defineProperty(child, "innerHeight", { value: WINDOW[1], configurable: true });
    }
    return child;
  };
  const hook = renderHook(
    ({ plan }: { plan: PerformPlan | null }) =>
      usePerformWindows({
        bus,
        backend,
        plan,
        displaySinks,
        openWindow,
        screenSource: screens,
        registry,
        channels: () => undefined,
        morphs: () => undefined,
        frame: () => undefined,
        invocation: context,
      }),
    { initialProps: { plan: null as PerformPlan | null } },
  );
  // Open the window the way the key does, then hand the hook the plan the compile gives
  // once the window's display sink is in it.
  await act(async () => {
    const opened = await bus.execute("perform.toggle", { nodeIds: [windowId] }, context);
    expect(opened.status).toBe("applied");
  });
  const compiled = compileGraph({
    graph: bus.store.getGraph(),
    registry,
    settings: DEFAULT_PROJECT_SETTINGS,
    capabilities: TIER_B_CAPABILITIES,
    sinks: displaySinks.get(),
  });
  act(() => hook.rerender({ plan: compiled }));
  // The perform window's own realm: its events are built from its own constructors.
  const child = hook.result.current.windows[0] as (Window & typeof globalThis) | undefined;
  if (child === undefined) throw new Error("no perform window opened");
  const surface = () => hook.result.current.surface;
  const layer = () => child.document.querySelector("[data-perform-mapping]");
  const handle = (key: string) => child.document.querySelector<HTMLButtonElement>(`[data-testid="perform-mapping-handle-${key}"]`);
  const note = () => child.document.querySelector('[data-testid="perform-mapping-note"]')?.textContent ?? "";
  const at = (element: Element | null): [number, number] => {
    const style = (element as HTMLElement).style;
    return [Number.parseFloat(style.left), Number.parseFloat(style.top)];
  };
  const label = (index: number) => bus.store.getGraph().nodes[ids[index]!]?.label ?? "";
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
  const observe = (frame: Parameters<ReturnType<typeof usePerformWindows>["observe"]>[0]) => hook.result.current.observe(frame);
  return { bus, ids, windowId, child, surface, observe, layer, handle, note, at, label, settle, presented, displaySinks, compiled };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** Fit's vertical map for this stage, worked by hand above: v_target = (v − 0.5)·0.5625 + 0.5. */
const windowY = (v: number) => (1 - ((v - 0.5) * 0.5625 + 0.5)) * 1000;
const windowX = (u: number) => 300 + u * 1000;

describe("§T1536b — Edit mapping draws a Corner Pin's pins on the perform window", () => {
  it("toggled on, each pin sits where Fit's letterbox and the canvas's letterbox put it", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"], parameters: { 1: { pinbl: [0.1, 0.2] } } });
    // The plan the compile gave: the 16:9 picture the Window Out samples, its square target.
    const window = stage.compiled.outputs.find((output) => output.nodeId === stage.windowId);
    expect(window?.size).toEqual([1000, 1000]);
    expect(stage.layer()).toBeNull();
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.layer()).not.toBeNull();
    expect(stage.at(stage.handle("pinbl"))).toEqual([400, 668.75]);
    expect(stage.at(stage.handle("pinbr"))).toEqual([windowX(1), windowY(0)]);
    expect(stage.at(stage.handle("pintr"))).toEqual([1300, 218.75]);
    expect(stage.at(stage.handle("pintl"))).toEqual([windowX(0), windowY(1)]);
    // Mirrors the tile: Extract has no handle there, so none here.
    expect(stage.handle("extractbl")).toBeNull();
    // The outline is the pin quad, through the same map.
    const outline = stage.child.document.querySelector('[data-testid="perform-mapping-outline"] polygon');
    expect(outline?.getAttribute("points")).toBe(`400,668.75 1300,${String(windowY(0))} 1300,218.75 300,${String(windowY(1))}`);
    expect(stage.note()).toContain(`Corner Pin "${stage.label(1)}"`);
  });

  it("a drag writes the pin through the bus as the local human, and one undo takes it back", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"], parameters: { 1: { pinbl: [0.1, 0.2] } } });
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    const pin = stage.handle("pinbl")!;
    const before = (await stage.bus.query("graph.audit", {}, context)).length;
    fireEvent.pointerDown(pin, { pointerId: 1, button: 0, clientX: 400, clientY: 668.75 });
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 450, clientY: 640 });
    await stage.settle();
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 500, clientY: 600 });
    fireEvent.pointerUp(pin, { pointerId: 1, clientX: 500, clientY: 600 });
    await stage.settle();
    // (500, 600): target (0.2, 0.4); undo Fit: v = (0.4 − 0.5) / 0.5625 + 0.5 = 0.3222…
    const pinbl = () => stage.bus.store.getGraph().nodes[stage.ids[1]!]?.parameters["pinbl"];
    expect(pinbl()).toEqual([0.2, 0.322222]);
    // And the window follows the document: the pin is drawn where it now is.
    expect(stage.at(stage.handle("pinbl"))).toEqual([500, windowY(0.322222)]);
    const audit = (await stage.bus.query("graph.audit", {}, context)).slice(before);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((entry) => entry.actor.id === context.actor.id && entry.status === "applied")).toBe(true);
    expect(new Set(audit.map((entry) => entry.undoGroupId)).size).toBe(1);
    await act(async () => {
      await stage.bus.execute("graph.undo", {}, context);
    });
    expect(pinbl()).toEqual([0.1, 0.2]);
  });

  it("toggling the mode never touches the presented picture; off leaves no layer in the window", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"] });
    const canvas = stage.child.document.querySelector("canvas");
    const sinks = stage.displaySinks.get();
    const presentation = JSON.stringify(stage.presented);
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.layer()).not.toBeNull();
    // The layer is DOM over the canvas, never a pass: same canvas, same presentation, same sinks.
    expect(stage.child.document.querySelector("canvas")).toBe(canvas);
    act(() => stage.surface().setEditingMapping(stage.windowId, false));
    expect(stage.layer()).toBeNull();
    expect(stage.child.document.querySelector("canvas")).toBe(canvas);
    expect(JSON.stringify(stage.presented)).toBe(presentation);
    expect(stage.displaySinks.get()).toEqual(sinks);
  });

  it("Hide cursor yields to the mode: the operator sees the pointer on the projector while mapping", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"] });
    const cursor = () => stage.child.document.body.style.cursor;
    const frame = { timeSeconds: 1, deltaSeconds: 1 / 60, frameIndex: 60, mode: "realtime" as const, randomSeed: 1 };
    expect(cursor()).toBe("none");
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(cursor()).toBe("default");
    stage.observe(frame);
    expect(cursor()).toBe("default");
    act(() => stage.surface().setEditingMapping(stage.windowId, false));
    stage.observe(frame);
    expect(cursor()).toBe("none");
  });

  it("M in the window toggles the mode and Escape leaves it; Escape with the mode off is the keymap's", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"] });
    /** True when the window consumed the key (so the keymap on that window skips it). */
    const key = (name: string): boolean => {
      const event = new stage.child.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      act(() => {
        stage.child.document.body.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    expect(key("m")).toBe(true);
    expect(stage.layer()).not.toBeNull();
    expect(stage.surface().mapping(stage.windowId).editing).toBe(true);
    expect(key("Escape")).toBe(true);
    expect(stage.layer()).toBeNull();
    expect(key("Escape")).toBe(false);
    expect(key("M")).toBe(true);
    expect(stage.layer()).not.toBeNull();
  });

  it("refuses by name, with no handles, when a Transform sits between the Corner Pin and the window", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin", "transform"] });
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.note()).toBe(
      `Transform "${stage.label(2)}" moves the picture between Corner Pin "${stage.label(1)}" and this window, so its handles cannot be placed exactly here.`,
    );
    expect(stage.child.document.querySelectorAll('[data-testid^="perform-mapping-handle-"]')).toHaveLength(0);
    expect(stage.surface().mapping(stage.windowId).targets.map((target) => target.refusal === null)).toEqual([false]);
  });

  it("a colour node between them moves nothing, so the pins are placed as before", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin", "level"], parameters: { 1: { pinbl: [0.1, 0.2] } } });
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.at(stage.handle("pinbl"))).toEqual([400, 668.75]);
  });

  it("with two warps on the chain, the nearest is edited and the far one is listed with its refusal", async () => {
    const stage = await setup({ chain: ["checker", "gridWarp", "cornerPin"] });
    const view = stage.surface().mapping(stage.windowId);
    expect(view.targets.map((target) => target.nodeId)).toEqual([stage.ids[2], stage.ids[1]]);
    expect(view.chosen).toBe(stage.ids[2]);
    expect(view.targets[1]?.refusal).toBe(
      `Corner Pin "${stage.label(2)}" warps the picture again between Grid Warp "${stage.label(1)}" and this window, so its handles cannot be placed exactly here.`,
    );
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.handle("pinbl")).not.toBeNull();
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    expect(stage.handle("pinbl")).toBeNull();
    expect(stage.note()).toBe(view.targets[1]?.refusal);
  });
});

describe("§T1536b — a Grid Warp on the perform window", () => {
  it("draws its points through the same map; Option-click inserts a column there, right-click deletes it", async () => {
    const stage = await setup({ chain: ["checker", "gridWarp"] });
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    // The 3×3 identity grid: point (c, r) at (c/2, r/2).
    expect(stage.at(stage.handle("p00"))).toEqual([windowX(0), windowY(0)]);
    expect(stage.at(stage.handle("p11"))).toEqual([windowX(0.5), windowY(0.5)]);
    expect(stage.at(stage.handle("p21"))).toEqual([windowX(1), windowY(0.5)]);
    expect(stage.child.document.querySelectorAll('[data-testid="perform-mapping-outline"] polyline')).toHaveLength(6);
    // Alt held: the picture takes the press. A quarter of the way across inserts at 0.25.
    act(() => {
      stage.child.dispatchEvent(new stage.child.KeyboardEvent("keydown", { key: "Alt", altKey: true }));
    });
    const surface = stage.child.document.querySelector<HTMLElement>('[data-testid="perform-mapping-surface"]')!;
    expect(surface.style.pointerEvents).toBe("auto");
    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, altKey: true, clientX: windowX(0.25), clientY: windowY(0.5) });
    await stage.settle();
    const grid = gridOf(stage.bus.store.getGraph().nodes[stage.ids[1]!]?.parameters ?? {});
    expect(grid.columns).toBe(4);
    expect(grid.us).toEqual([0, 0.25, 0.5, 1]);
    expect(stage.at(stage.handle("p10"))).toEqual([windowX(0.25), windowY(0)]);
    // Right-click that new column's point: its menu deletes the column, through the bus.
    fireEvent.contextMenu(stage.handle("p10")!, { clientX: windowX(0.25), clientY: windowY(0) });
    const remove = stage.child.document.querySelector<HTMLButtonElement>('[data-testid="perform-mapping-delete-column"]')!;
    expect(remove.textContent).toBe("Delete column 2");
    fireEvent.click(remove);
    await stage.settle();
    const after = gridOf(stage.bus.store.getGraph().nodes[stage.ids[1]!]?.parameters ?? {});
    expect([after.columns, after.us]).toEqual([3, [0, 0.5, 1]]);
  });
});
