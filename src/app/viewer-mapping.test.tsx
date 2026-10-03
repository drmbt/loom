// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compileGraph } from "@compiler/compile.ts";
import { DEFAULT_PROJECT_SETTINGS } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { KeymapProvider } from "@editor/keymap/keymap-provider.tsx";
import { createKeymapStore } from "@editor/keymap/store.ts";
import { gridOf, gridWarpPoint } from "@nodes/definitions/grid-warp.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { TIER_B_CAPABILITIES } from "@/examples/runner.ts";
import { AppRuntimeContext } from "./app-context.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { ViewerPane } from "./side-panes.tsx";
import { VIEWER_MAPPING_ABSENT_NOTE } from "./use-viewer-mapping.ts";

/**
 * §T1536b (viewer slice) — EDIT MAPPING IN THE VIEWER PANE, through the pane that ships it:
 * the real `ViewerPane`, the real bus and keymap, a plan from the real compiler. What is
 * asserted is what the operator meets in the editor — where a handle is drawn in the
 * viewer's pixels, what a drag writes into the document (and that one undo takes it back),
 * which node's handles the viewer offers, and the named refusal when they cannot be placed.
 *
 * The stage, worked by hand so the expected pixels are not the code's own arithmetic:
 *
 *   Checker (project 1280×720) → … ; the viewer's frame 1000×1000 CSS px.
 *   The viewer letterboxes the 16:9 picture into the square (T1158's `fitInsideRegion`):
 *   1000 wide, 1000·9/16 = 562.5 tall, centred: y from 218.75 to 781.25.
 *
 *   A picture point (u, v), y up → x = 1000·u, y = 218.75 + (1 − v)·562.5.
 *   Pin Bottom Left at (0.1, 0.2) → (100, 668.75).
 */

const FRAME = 1000;
const viewerPixel = ([u, v]: readonly [number, number]): [number, number] => [u * 1000, 218.75 + (1 - v) * 562.5];
/** The inverse, by hand: undo the letterbox. */
const fromViewerPixel = ([x, y]: readonly [number, number]): [number, number] => [x / 1000, 1 - (y - 218.75) / 562.5];

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

interface Stage {
  /** Node types in chain order, source first. */
  readonly chain: readonly string[];
  readonly parameters?: Readonly<Record<number, Record<string, StoredParameter>>>;
  /** Which chain index the viewer shows. */
  readonly shows: number;
}

async function setup({ chain, parameters = {}, shows }: Stage) {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const { bus, invocation } = runtime;
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getRevision(),
      operations: [
        ...chain.map((type, index) => ({
          op: "addNode" as const,
          ref: `$${String(index)}` as const,
          type,
          position: { x: index * 300, y: 0 },
          ...(parameters[index] === undefined ? {} : { parameters: parameters[index] }),
        })),
        ...chain.slice(1).map((_, index) => ({
          op: "connect" as const,
          source: { nodeId: `$${String(index)}` as const, portId: "out" },
          target: { nodeId: `$${String(index + 1)}` as const, portId: "input" },
        })),
      ],
    },
    invocation,
  );
  expect(created.status, JSON.stringify(created.diagnostics)).toBe("applied");
  const ids = chain.map((_, index) => created.output.createdIds[`$${String(index)}`] as NodeId);
  // Every node a preview sink, as the editor's visible tiles make them (§V28b).
  const compiled = compileGraph({
    graph: bus.store.getGraph(),
    registry: runtime.registry,
    settings: DEFAULT_PROJECT_SETTINGS,
    capabilities: TIER_B_CAPABILITIES,
    sinks: ids.map((nodeId) => ({ nodeId, kind: "preview" as const })),
  });
  const keymap = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "other" });
  /** The document as the app hands it to the pane: `useGraphCompile`'s live subscription. */
  function Viewer() {
    const graph = useSyncExternalStore(bus.store.subscribe, bus.store.getGraph, bus.store.getGraph);
    return <ViewerPane compiled={compiled} graph={graph} backend={null} />;
  }
  render(
    <TooltipProvider>
      <KeymapProvider bus={bus} store={keymap} invocationContext={invocation}>
        <AppRuntimeContext.Provider value={runtime}>
          <Viewer />
        </AppRuntimeContext.Provider>
      </KeymapProvider>
    </TooltipProvider>,
  );
  // The viewer shows the chosen node, the way a user points it there.
  await act(async () => {
    fireEvent.change(screen.getByTestId("viewer-output-select"), { target: { value: `${ids[shows]!}:out` } });
  });
  expect(compiled.outputs.find((output) => output.nodeId === ids[shows])?.size).toEqual([1280, 720]);
  const host = screen.getByTestId("viewer-mapping-host");
  Object.defineProperty(host, "clientWidth", { value: FRAME, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: FRAME, configurable: true });
  const toggle = () => fireEvent.click(screen.getByTestId("viewer-mapping-toggle"));
  const layer = () => document.querySelector("[data-perform-mapping]");
  const handle = (key: string) => document.querySelector<HTMLButtonElement>(`[data-testid="perform-mapping-handle-${key}"]`);
  const handles = () => document.querySelectorAll('[data-testid^="perform-mapping-handle-"]');
  const note = () => document.querySelector('[data-testid="perform-mapping-note"]')?.textContent ?? "";
  const at = (element: Element | null): [number, number] => {
    const style = (element as HTMLElement).style;
    return [Number.parseFloat(style.left), Number.parseFloat(style.top)];
  };
  const label = (index: number) => bus.store.getGraph().nodes[ids[index]!]?.label ?? "";
  const parameter = (index: number, key: string) => bus.store.getGraph().nodes[ids[index]!]?.parameters[key];
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
  return { runtime, bus, invocation, ids, host, toggle, layer, handle, handles, note, at, label, parameter, settle };
}

describe("§T1536b (viewer) — the viewer shows a Corner Pin: its own pins, no Fit step", () => {
  it("pins sit at the viewer pixels the letterbox puts them at, drawn over the canvas, never in it", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"], parameters: { 1: { pinbl: [0.1, 0.2] } }, shows: 1 });
    expect(stage.layer()).toBeNull();
    stage.toggle();
    expect(screen.getByTestId("viewer-mapping-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(stage.at(stage.handle("pinbl"))).toEqual([100, 668.75]);
    expect(stage.at(stage.handle("pinbr"))).toEqual([1000, 781.25]);
    expect(stage.at(stage.handle("pintr"))).toEqual([1000, 218.75]);
    expect(stage.at(stage.handle("pintl"))).toEqual([0, 218.75]);
    // As on the tile: Extract has no handle there.
    expect(stage.handle("extractbl")).toBeNull();
    const outline = document.querySelector('[data-testid="perform-mapping-outline"] polygon');
    expect(outline?.getAttribute("points")).toBe("100,668.75 1000,781.25 1000,218.75 0,218.75");
    expect(stage.note()).toBe(`Editing Corner Pin "${stage.label(1)}": drag a pin. M or Esc to stop.`);
    // DOM in the frame's host, beside the picture — not a child of the presented canvas.
    expect(stage.host.contains(stage.layer())).toBe(true);
    expect(screen.getByTestId("viewer-canvas").contains(stage.layer())).toBe(false);
  });

  it("a drag writes the analytically inverted value as the local human, and one undo takes it back", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"], parameters: { 1: { pinbl: [0.1, 0.2] } }, shows: 1 });
    stage.toggle();
    const pin = stage.handle("pinbl")!;
    const before = (await stage.bus.query("graph.audit", {}, stage.invocation)).length;
    fireEvent.pointerDown(pin, { pointerId: 1, button: 0, clientX: 100, clientY: 668.75 });
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 200, clientY: 600 });
    await stage.settle();
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 300, clientY: 500 });
    fireEvent.pointerUp(pin, { pointerId: 1, clientX: 300, clientY: 500 });
    await stage.settle();
    // (300, 500): u = 0.3; v = 1 − (500 − 218.75)/562.5 = 0.5.
    expect(stage.parameter(1, "pinbl")).toEqual([0.3, 0.5]);
    expect(stage.at(stage.handle("pinbl"))).toEqual([300, 500]);
    const audit = (await stage.bus.query("graph.audit", {}, stage.invocation)).slice(before);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((entry) => entry.actor.id === stage.invocation.actor.id && entry.status === "applied")).toBe(true);
    expect(new Set(audit.map((entry) => entry.undoGroupId)).size).toBe(1);
    await act(async () => {
      await stage.bus.execute("graph.undo", {}, stage.invocation);
    });
    expect(stage.parameter(1, "pinbl")).toEqual([0.1, 0.2]);
  });

  it("toggled off, no layer is left; a double click on a handle is not a fullscreen toggle", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"], shows: 1 });
    const canvas = screen.getByTestId("viewer-canvas");
    stage.toggle();
    expect(stage.layer()).not.toBeNull();
    const execute = vi.spyOn(stage.bus, "execute");
    const fullscreens = () => execute.mock.calls.filter(([name]) => name === "view.toggleFullscreen").length;
    fireEvent.doubleClick(stage.handle("pinbl")!);
    expect(fullscreens()).toBe(0);
    // The guard is the layer's alone: a double click on the picture still asks for fullscreen.
    fireEvent.doubleClick(canvas);
    expect(fullscreens()).toBe(1);
    execute.mockRestore();
    stage.toggle();
    expect(stage.layer()).toBeNull();
    expect(stage.host.childElementCount).toBe(0);
    expect(screen.getByTestId("viewer-canvas")).toBe(canvas);
    expect(screen.getByTestId("viewer-mapping-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("M on the viewer toggles the mode through the keymap; Escape leaves it", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"], shows: 1 });
    const pane = screen.getByTestId("viewer-surface");
    await act(async () => {
      fireEvent.keyDown(pane, { key: "m", code: "KeyM" });
    });
    await stage.settle();
    expect(stage.layer()).not.toBeNull();
    fireEvent.keyDown(pane, { key: "Escape", code: "Escape" });
    expect(stage.layer()).toBeNull();
    await act(async () => {
      const result = await stage.bus.execute("viewer.editMapping", {}, stage.invocation);
      expect(result.output.editing).toBe(true);
    });
    expect(stage.layer()).not.toBeNull();
  });
});

describe("§T1536b (viewer) — which node's handles", () => {
  it("upstream of a mapping node: nothing, and a one-line note says so", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin"], shows: 0 });
    stage.toggle();
    expect(stage.note()).toBe(VIEWER_MAPPING_ABSENT_NOTE);
    expect(stage.handles()).toHaveLength(0);
  });

  it("a colour node on screen downstream of the Corner Pin: the pins, placed as on the Corner Pin itself", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin", "level"], parameters: { 1: { pinbl: [0.1, 0.2] } }, shows: 2 });
    stage.toggle();
    expect(stage.at(stage.handle("pinbl"))).toEqual([100, 668.75]);
  });

  it("a Transform between the Corner Pin and what the viewer shows refuses by name, with no handles", async () => {
    const stage = await setup({ chain: ["checker", "cornerPin", "transform"], shows: 2 });
    stage.toggle();
    expect(stage.note()).toBe(
      `Transform "${stage.label(2)}" moves the picture between Corner Pin "${stage.label(1)}" and the viewer, so its handles cannot be placed exactly here.`,
    );
    expect(stage.handles()).toHaveLength(0);
  });
});

describe("§T1536b (viewer) — the Grid Warp's line gestures, in a frame that is not at the page's corner", () => {
  it("Option-click inserts a column where the pointer is in the frame; right-click deletes it", async () => {
    const stage = await setup({ chain: ["checker", "gridWarp"], shows: 1 });
    // The frame sits at (40, 30) on the page: a pointer's client position is not the layer's.
    stage.host.getBoundingClientRect = () => ({ left: 40, top: 30, right: 1040, bottom: 1030, width: FRAME, height: FRAME, x: 40, y: 30, toJSON: () => ({}) });
    const client = (point: readonly [number, number]) => {
      const [x, y] = viewerPixel(point);
      return { clientX: x + 40, clientY: y + 30 };
    };
    stage.toggle();
    expect(stage.at(stage.handle("p11"))).toEqual(viewerPixel([0.5, 0.5]));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
    });
    const surface = document.querySelector<HTMLElement>('[data-testid="perform-mapping-surface"]')!;
    expect(surface.style.pointerEvents).toBe("auto");
    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, altKey: true, ...client([0.25, 0.5]) });
    await stage.settle();
    const grid = () => gridOf(stage.bus.store.getGraph().nodes[stage.ids[1]!]?.parameters ?? {});
    expect([grid().columns, grid().us]).toEqual([4, [0, 0.25, 0.5, 1]]);
    expect(stage.at(stage.handle("p10"))).toEqual(viewerPixel([0.25, 0]));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", altKey: false }));
    });
    fireEvent.contextMenu(stage.handle("p10")!, client([0.25, 0]));
    const menu = document.querySelector<HTMLElement>('[data-testid="perform-mapping-menu"]')!;
    // Opened at the pointer, in the frame's own pixels.
    expect([menu.style.left, menu.style.top]).toEqual([`${String(250)}px`, `${String(viewerPixel([0.25, 0])[1])}px`]);
    const remove = document.querySelector<HTMLButtonElement>('[data-testid="perform-mapping-delete-column"]')!;
    expect(remove.textContent).toBe("Delete column 2");
    fireEvent.click(remove);
    await stage.settle();
    expect([grid().columns, grid().us]).toEqual([3, [0, 0.5, 1]]);
  });
});

/*
 * A Grid Warp edited THROUGH the Corner Pin downstream of it (§T1538b's lens), on a chain with
 * no Window Out at all. The expected pixels go through a homography solved here,
 * independently of the node: the unique projective map taking four points to four points,
 * from the 8×8 linear system (h₈ = 1) by Gaussian elimination.
 */
type P2 = readonly [number, number];
type Quad4 = readonly [P2, P2, P2, P2];

function homographyThrough(from: Quad4, to: Quad4): (point: P2) => [number, number] {
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
const cornerPinValues: Record<string, StoredParameter> = {
  pinbl: PINS[0],
  pinbr: PINS[1],
  pintr: PINS[2],
  pintl: PINS[3],
  extractbl: EXTRACT[0],
  extractbr: EXTRACT[1],
  extracttr: EXTRACT[2],
  extracttl: EXTRACT[3],
};
const pinned = homographyThrough(EXTRACT, PINS);
const unpinned = homographyThrough(PINS, EXTRACT);
const expectNear = (actual: readonly number[], expected: readonly number[], digits = 9): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value, `component ${String(index)}`).toBeCloseTo(expected[index]!, digits));
};

describe("§T1536b (viewer) — Grid Warp → Corner Pin → Level on screen: the Grid Warp through the Corner Pin", () => {
  const stageOf = () => setup({ chain: ["checker", "gridWarp", "cornerPin", "level"], parameters: { 2: cornerPinValues }, shows: 3 });

  it("lists both, nearest first; picked, the Grid Warp's points land where the homography and the letterbox put them", async () => {
    const stage = await stageOf();
    stage.toggle();
    const picker = screen.getByTestId("viewer-mapping-target") as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual([stage.ids[2], stage.ids[1]]);
    expect(picker.value).toBe(stage.ids[2]);
    await act(async () => {
      fireEvent.change(picker, { target: { value: stage.ids[1] } });
    });
    expect(stage.note()).toBe(
      `Editing Grid Warp "${stage.label(1)}" through Corner Pin "${stage.label(2)}": drag a point, Option-click to add a column (with Shift a row), right-click a point to delete one. M or Esc to stop.`,
    );
    for (let column = 0; column < 3; column += 1) {
      for (let row = 0; row < 3; row += 1) {
        expectNear(stage.at(stage.handle(`p${String(column)}${String(row)}`)), viewerPixel(pinned([column / 2, row / 2])));
      }
    }
    // Not the identity passing for one: unmapped, the centre would be the frame's centre.
    const centre = stage.at(stage.handle("p11"));
    expect(Math.hypot(centre[0] - 500, centre[1] - 500)).toBeGreaterThan(20);
    // The lines are sampled on the Grid Warp, then mapped: the middle column, 33 samples.
    const grid = gridOf(stage.runtime.bus.store.getGraph().nodes[stage.ids[1]!]?.parameters ?? {});
    const lines = document.querySelectorAll('[data-testid="perform-mapping-outline"] polyline');
    const drawn = (lines[1]?.getAttribute("points") ?? "").split(" ").map((pair) => pair.split(",").map(Number));
    expect(drawn).toHaveLength(33);
    drawn.forEach((point, step) => expectNear(point, viewerPixel(pinned(gridWarpPoint(grid, 1, step / 16)))));
  });

  it("a drag writes the inverse through the Corner Pin and the letterbox, in one undo group", async () => {
    const stage = await stageOf();
    stage.toggle();
    await act(async () => {
      fireEvent.change(screen.getByTestId("viewer-mapping-target"), { target: { value: stage.ids[1] } });
    });
    const point = stage.handle("p11")!;
    const before = stage.parameter(1, "p11");
    const [x, y] = stage.at(point);
    const groups = (await stage.bus.query("graph.audit", {}, stage.invocation)).length;
    fireEvent.pointerDown(point, { pointerId: 1, button: 0, clientX: x, clientY: y });
    fireEvent.pointerMove(point, { pointerId: 1, clientX: 480, clientY: 520 });
    await stage.settle();
    fireEvent.pointerMove(point, { pointerId: 1, clientX: 520, clientY: 450 });
    fireEvent.pointerUp(point, { pointerId: 1, clientX: 520, clientY: 450 });
    await stage.settle();
    const expected = unpinned(fromViewerPixel([520, 450]));
    expectNear(stage.parameter(1, "p11") as number[], expected, 6);
    // Not what a drag that ignored the Corner Pin would write.
    const naive = fromViewerPixel([520, 450]);
    expect(Math.hypot(expected[0] - naive[0], expected[1] - naive[1])).toBeGreaterThan(0.01);
    expectNear(stage.at(stage.handle("p11")), [520, 450], 3);
    const audit = (await stage.bus.query("graph.audit", {}, stage.invocation)).slice(groups);
    expect(audit.length).toBeGreaterThan(0);
    expect(new Set(audit.map((entry) => entry.undoGroupId)).size).toBe(1);
    await act(async () => {
      await stage.bus.execute("graph.undo", {}, stage.invocation);
    });
    expect(stage.parameter(1, "p11")).toEqual(before);
  });

  it("a Corner Pin in between whose corner is driven refuses by name: the viewer reads the document's values only", async () => {
    const stage = await setup({
      chain: ["checker", "gridWarp", "cornerPin", "level"],
      parameters: { 2: { ...cornerPinValues, pintr: { mode: "bind", bindings: { bind: { kind: "bind", ref: "pinbr" }, static: { kind: "static", value: [0.95, 0.9] } } } } },
      shows: 3,
    });
    stage.toggle();
    // The Corner Pin itself is still editable (its driven pin is locked, as on its tile) …
    expect(stage.handle("pinbl")).not.toBeNull();
    // … but nothing behind it can be placed through a quad that moves.
    await act(async () => {
      fireEvent.change(screen.getByTestId("viewer-mapping-target"), { target: { value: stage.ids[1] } });
    });
    expect(stage.note()).toBe(
      `Corner Pin "${stage.label(2)}"'s corners are driven, and the viewer places handles from the document's values only, so Grid Warp "${stage.label(1)}"'s handles cannot be placed exactly here.`,
    );
    expect(stage.handles()).toHaveLength(0);
  });
});
