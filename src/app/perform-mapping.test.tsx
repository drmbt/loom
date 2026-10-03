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
import { gridOf, gridWarpPoint } from "@nodes/definitions/grid-warp.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { LoomBackend, PresentationOptions } from "@runtime/backend/backend-types.ts";
import { TIER_B_CAPABILITIES } from "@/examples/runner.ts";
import { createDisplaySinkStore } from "./display-sinks.ts";
import type { ScreenSource } from "./perform-screens.ts";
import { usePerformWindows } from "./use-perform-windows.ts";
import { lensHorizon, pictureLensFor, windowPicture } from "./perform-mapping.ts";
import type { MappingTarget } from "./perform-mapping.ts";
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

  it("with a Grid Warp in front, the nearest is edited and the Corner Pin behind it is listed with its refusal", async () => {
    // §T1538b turned the other order (Grid Warp → Corner Pin) into a placed one; a Grid Warp
    // downstream still moves the picture in a way this layer does not invert.
    const stage = await setup({ chain: ["checker", "cornerPin", "gridWarp"] });
    const view = stage.surface().mapping(stage.windowId);
    expect(view.targets.map((target) => target.nodeId)).toEqual([stage.ids[2], stage.ids[1]]);
    expect(view.chosen).toBe(stage.ids[2]);
    expect(view.targets[1]?.refusal).toBe(
      `Grid Warp "${stage.label(2)}" warps the picture again between Corner Pin "${stage.label(1)}" and this window, so its handles cannot be placed exactly here.`,
    );
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.handle("p11")).not.toBeNull();
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    expect(stage.handle("p11")).toBeNull();
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

/*
 * §T1538b — A CORNER PIN BETWEEN THE EDITED NODE AND THE WINDOW.
 *
 * The expected pixels go through a homography solved HERE, independently of the node: the
 * unique projective map taking four points to four points, from the 8×8 linear system
 * (h₈ = 1) by Gaussian elimination. The node solves square → quad twice and composes
 * (Heckbert's closed form); a map through the same four correspondences is the same map, so
 * agreement is the check, not a restatement.
 */
type P2 = readonly [number, number];
type Quad4 = readonly [P2, P2, P2, P2];

function homographyThrough(from: Quad4, to: Quad4): (point: P2) => P2 {
  const rows: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = from[index]!;
    const [u, v] = to[index]!;
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = rows[row]![column]! / rows[column]![column]!;
      for (let k = column; k < 9; k += 1) rows[row]![k]! -= factor * rows[column]![k]!;
    }
  }
  const h = rows.map((row, index) => row[8]! / row[index]!);
  return ([x, y]) => {
    const w = h[6]! * x + h[7]! * y + 1;
    return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
  };
}

/** A non-trivial pin quad (no two sides parallel: a true perspective) and extract quad. */
const PINS: Quad4 = [
  [0.1, 0.15],
  [0.85, 0.05],
  [0.95, 0.9],
  [0.2, 0.8],
];
const EXTRACT: Quad4 = [
  [0.05, 0.1],
  [0.9, 0],
  [1, 0.95],
  [0, 0.85],
];
const cornerPinValues = (pins: Quad4, extract: Quad4): Record<string, StoredParameter> => ({
  pinbl: pins[0],
  pinbr: pins[1],
  pintr: pins[2],
  pintl: pins[3],
  extractbl: extract[0],
  extractbr: extract[1],
  extracttr: extract[2],
  extracttl: extract[3],
});
/** Its input picture → its output picture, and back. */
const pinned = homographyThrough(EXTRACT, PINS);
const unpinned = homographyThrough(PINS, EXTRACT);
/** This stage's window pixel of an output-picture point (Fit and letterbox, worked above). */
const toWindowPixel = ([u, v]: P2): P2 => [windowX(u), windowY(v)];
/** The inverse, worked by hand: undo the letterbox, then Fit's v_target = (v − 0.5)·0.5625 + 0.5. */
const fromWindowPixel = ([x, y]: P2): P2 => [(x - 300) / 1000, (1 - y / 1000 - 0.5) / 0.5625 + 0.5];

const expectNear = (actual: readonly number[], expected: readonly number[], digits = 9): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value, `component ${String(index)}`).toBeCloseTo(expected[index]!, digits));
};

describe("§T1538b — Grid Warp → Corner Pin → Window Out: the Grid Warp is edited through the Corner Pin", () => {
  const stageOf = () => setup({ chain: ["checker", "gridWarp", "cornerPin"], parameters: { 2: cornerPinValues(PINS, EXTRACT) } });

  it("is placed, not refused: the Grid Warp is the default and its points land where the homography puts them", async () => {
    const stage = await stageOf();
    const view = stage.surface().mapping(stage.windowId);
    expect(view.targets.map((target) => [target.nodeId, target.refusal])).toEqual([
      [stage.ids[2], null],
      [stage.ids[1], null],
    ]);
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.note()).toBe(
      `Editing Grid Warp "${stage.label(1)}" through Corner Pin "${stage.label(2)}": drag a point, Option-click to add a column (with Shift a row), right-click a point to delete one. M or Esc to stop.`,
    );
    // The 3×3 identity grid: point (c, r) at (c/2, r/2) of the Grid Warp's picture. Every one
    // is drawn — p00 lies OUTSIDE the Extract quad (its corner is at (0.05, 0.1)): the Corner
    // Pin does not show that point, and the handle sits where the pinned plane, continued,
    // puts it (§T1538b's decision: clamp-free, so it can be dragged back in).
    for (let column = 0; column < 3; column += 1) {
      for (let row = 0; row < 3; row += 1) {
        const key = `p${String(column)}${String(row)}`;
        expectNear(stage.at(stage.handle(key)), toWindowPixel(pinned([column / 2, row / 2])));
      }
    }
    // Without the Corner Pin the centre point would be at the window's centre (800, 500): the
    // map moved it, so this is not the identity passing for one.
    const centre = stage.at(stage.handle("p11"));
    expect(Math.hypot(centre[0] - 800, centre[1] - 500)).toBeGreaterThan(20);
  });

  it("draws the grid lines sampled on the Grid Warp, then each sample mapped through the Corner Pin", async () => {
    const stage = await stageOf();
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    const lines = stage.child.document.querySelectorAll('[data-testid="perform-mapping-outline"] polyline');
    expect(lines).toHaveLength(6);
    const grid = gridOf(stage.bus.store.getGraph().nodes[stage.ids[1]!]?.parameters ?? {});
    // Column 1, the middle one: 2 cells × 16 samples + 1.
    const drawn = (lines[1]?.getAttribute("points") ?? "").split(" ").map((pair) => pair.split(",").map(Number));
    expect(drawn).toHaveLength(33);
    drawn.forEach((point, step) => expectNear(point, toWindowPixel(pinned(gridWarpPoint(grid, 1, step / 16)))));
  });

  it("a drag on the window writes the inverse through the Corner Pin and the Fit, and one undo takes it back", async () => {
    const stage = await stageOf();
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    const point = stage.handle("p11")!;
    const parameters = () => stage.bus.store.getGraph().nodes[stage.ids[1]!]?.parameters ?? {};
    const before = parameters()["p11"];
    const [x, y] = stage.at(point);
    const groups = (await stage.bus.query("graph.audit", {}, context)).length;
    fireEvent.pointerDown(point, { pointerId: 1, button: 0, clientX: x, clientY: y });
    fireEvent.pointerMove(point, { pointerId: 1, clientX: 760, clientY: 520 });
    await stage.settle();
    fireEvent.pointerMove(point, { pointerId: 1, clientX: 800, clientY: 450 });
    fireEvent.pointerUp(point, { pointerId: 1, clientX: 800, clientY: 450 });
    await stage.settle();
    // (800, 450) → the Corner Pin's output (0.5, 0.58889) → back through the pin and extract
    // quads to the Grid Warp's own picture; the store keeps six decimals.
    const expected = unpinned(fromWindowPixel([800, 450]));
    expectNear(parameters()["p11"] as number[], expected, 6);
    // Not the value a drag that ignored the Corner Pin would write.
    expect(Math.hypot(expected[0] - 0.5, expected[1] - (0.05 / 0.5625 + 0.5))).toBeGreaterThan(0.01);
    // And the point is drawn under the pointer.
    expectNear(stage.at(stage.handle("p11")), [800, 450], 3);
    const audit = (await stage.bus.query("graph.audit", {}, context)).slice(groups);
    expect(audit.length).toBeGreaterThan(0);
    expect(new Set(audit.map((entry) => entry.undoGroupId)).size).toBe(1);
    await act(async () => {
      await stage.bus.execute("graph.undo", {}, context);
    });
    expect(parameters()["p11"]).toEqual(before);
  });

  it("a degenerate Corner Pin refuses by name, with no handles: it renders nothing, so nothing behind it has a place", async () => {
    // Bottom Right and Top Right swapped: a bow-tie, the node's own `cornerPin.pin.degenerate`.
    const bowTie: Quad4 = [PINS[0], PINS[2], PINS[1], PINS[3]];
    const stage = await setup({ chain: ["checker", "gridWarp", "cornerPin"], parameters: { 2: cornerPinValues(bowTie, EXTRACT) } });
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.note()).toBe(
      `Corner Pin "${stage.label(2)}"'s Pin quad cannot be pinned: it is self-intersecting or concave (corners out of order). It shows nothing, so Grid Warp "${stage.label(1)}"'s handles have no place on this window.`,
    );
    expect(stage.child.document.querySelectorAll('[data-testid^="perform-mapping-handle-"]')).toHaveLength(0);
    expect(stage.child.document.querySelectorAll('[data-testid="perform-mapping-outline"] *')).toHaveLength(0);
  });
});

describe("§T1538b — a Grid Warp point past the Corner Pin's horizon", () => {
  it("refuses by name: the point has no place on this window, in any Outside mode", async () => {
    // A trapezoid narrowing upward: w = 4t + 1 (see the pure case below), so a picture point
    // below t = −¼ is past the horizon. Point 2,1 (p10) dragged to (0.5, −1) on its tile.
    const receding: Quad4 = [
      [0, 0],
      [1, 0],
      [0.6, 1],
      [0.4, 1],
    ];
    const stage = await setup({
      chain: ["checker", "gridWarp", "cornerPin"],
      parameters: { 1: { p10: [0.5, -1] }, 2: { pinbl: receding[0], pinbr: receding[1], pintr: receding[2], pintl: receding[3], extend: "repeat" } },
    });
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    expect(stage.note()).toBe(
      `Grid Warp "${stage.label(1)}"'s Point 2,1 lies past Corner Pin "${stage.label(2)}"'s horizon, so it has no place on this window.`,
    );
    expect(stage.child.document.querySelectorAll('[data-testid^="perform-mapping-handle-"]')).toHaveLength(0);
  });
});

describe("§T1538b — Corner Pin → Corner Pin: the first is edited through the second", () => {
  const FIRST: Quad4 = [
    [0.2, 0.25],
    [0.7, 0.2],
    [0.75, 0.7],
    [0.3, 0.8],
  ];
  const stageOf = () =>
    setup({
      chain: ["checker", "cornerPin", "cornerPin"],
      parameters: { 1: { pinbl: FIRST[0], pinbr: FIRST[1], pintr: FIRST[2], pintl: FIRST[3] }, 2: cornerPinValues(PINS, EXTRACT) },
    });

  it("draws the first one's pins and pin quad where the second one shows them", async () => {
    const stage = await stageOf();
    const view = stage.surface().mapping(stage.windowId);
    expect(view.targets.map((target) => [target.nodeId, target.refusal])).toEqual([
      [stage.ids[2], null],
      [stage.ids[1], null],
    ]);
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    const keys = ["pinbl", "pinbr", "pintr", "pintl"];
    keys.forEach((key, index) => expectNear(stage.at(stage.handle(key)), toWindowPixel(pinned(FIRST[index]!))));
    // A homography keeps lines straight: the mapped corners ARE the outline.
    const outline = stage.child.document.querySelector('[data-testid="perform-mapping-outline"] polygon');
    const corners = (outline?.getAttribute("points") ?? "").split(" ").map((pair) => pair.split(",").map(Number));
    corners.forEach((corner, index) => expectNear(corner, toWindowPixel(pinned(FIRST[index]!))));
  });

  it("a drag on one of the first one's pins writes it back through the second", async () => {
    const stage = await stageOf();
    act(() => stage.surface().chooseMapping(stage.windowId, stage.ids[1]!));
    act(() => stage.surface().setEditingMapping(stage.windowId, true));
    const pin = stage.handle("pintr")!;
    const [x, y] = stage.at(pin);
    fireEvent.pointerDown(pin, { pointerId: 1, button: 0, clientX: x, clientY: y });
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 1000, clientY: 300 });
    fireEvent.pointerUp(pin, { pointerId: 1, clientX: 1000, clientY: 300 });
    await stage.settle();
    const written = stage.bus.store.getGraph().nodes[stage.ids[1]!]?.parameters["pintr"] as number[];
    expectNear(written, unpinned(fromWindowPixel([1000, 300])), 6);
  });
});

describe("§T1538b — the lens at its edges (pure)", () => {
  const target = (through: MappingTarget["through"]): MappingTarget => ({ nodeId: "gw", name: "warp", kind: "gridWarp", title: "Grid Warp", refusal: null, through });
  const values = (pins: Quad4, extract: Quad4 = [[0, 0], [1, 0], [1, 1], [0, 1]]) => cornerPinValues(pins, extract) as Record<string, never>;
  /** A trapezoid narrowing upward: the pinned plane recedes, its vanishing point at (0.5, 1.25). */
  const RECEDING: Quad4 = [
    [0, 0],
    [1, 0],
    [0.6, 1],
    [0.4, 1],
  ];
  const facts = { fit: "stretch" as const, inputSize: [1000, 1000] as const, targetSize: [1000, 1000] as const };

  it("a point outside the Extract quad maps clamp-free to the continued plane, and back", () => {
    const lens = pictureLensFor(target([{ nodeId: "cp", name: "pin" }]), () => values(PINS, EXTRACT));
    if (typeof lens === "string") throw new Error(lens);
    const outside: P2 = [1.2, -0.1];
    const picture = windowPicture(facts, [1000, 1000], lens);
    const shown = picture.toWindow(outside)!;
    const [u, v] = pinned(outside);
    expectNear(shown, [u * 1000, (1 - v) * 1000]);
    expectNear(picture.fromWindow(shown)!, outside);
  });

  it("past a Corner Pin's horizon there is no place: named going forward, nothing coming back", () => {
    const lens = pictureLensFor(target([{ nodeId: "cp", name: "pin" }]), () => values(RECEDING));
    if (typeof lens === "string") throw new Error(lens);
    // w = 4t + 1 for this quad (worked from Heckbert's form by hand): negative below t = −¼.
    expect(lensHorizon(lens, [0.5, -1])).toBe('Corner Pin "pin"');
    expect(lensHorizon(lens, [0.5, -0.2])).toBeNull();
    const picture = windowPicture(facts, [1000, 1000], lens);
    expect(picture.toWindow([0.5, -1])).toBeNull();
    // Above the vanishing point the output shows no surface: a drag there writes nothing.
    expect(picture.fromWindow([500, 1000 - 2 * 1000])).toBeNull();
    expect(picture.fromWindow([500, 1000 - 1.2 * 1000])).not.toBeNull();
  });

  it("a degenerate Extract quad is refused by name too", () => {
    const flat: Quad4 = [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [0, 1],
    ];
    expect(pictureLensFor(target([{ nodeId: "cp", name: "pin" }]), () => values(PINS, flat))).toBe(
      `Corner Pin "pin"'s Extract quad cannot be pinned: three corners are in a line (zero area). It shows nothing, so Grid Warp "warp"'s handles have no place on this window.`,
    );
  });
});
