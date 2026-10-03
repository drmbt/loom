// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { FrameClock } from "@domain/types/frame.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { PRESET_RECALL_COMMAND, serializePresetBank } from "@domain/presets/index.ts";
import { registerSelectNodesCommand } from "@editor/selection/select-created.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { ControlsPane } from "./controls-pane.tsx";

/**
 * T1506b — THE LAYERS TAB, as a performer uses it mid-show: read which layer is on top of
 * which, switch one off, pull one down, see what each shows and which one a preset is
 * fading, and click a name to get that node in the inspector. Every gesture goes through
 * the real app runtime and bus, and is asserted on what the DOCUMENT holds and on what one
 * undo puts back.
 */
beforeAll(installDomStubs);
afterEach(cleanup);

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
const connect = (from: string, to: string, port: string): GraphPatchOperation =>
  ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: `$${to}`, portId: port } }) as GraphPatchOperation;

/**
 * street (a solid) → city → smoke → main (a Window Out): `smoke` on top of `city`. `city`
 * shows the look named "neon". Made top first, so document order cannot fake the stack.
 */
async function show(extra: { city?: Record<string, unknown>; more?: GraphPatchOperation[] } = {}): Promise<{ runtime: AppRuntime; ids: Record<string, NodeId> }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        add("main", "window", "main"),
        add("smoke", "layer", "smoke"),
        add("city", "layer", "city", { picture: "neon", ...extra.city }),
        add("street", "solid", "street"),
        add("neon", "solid", "neon"),
        connect("street", "city", "below"),
        connect("city", "smoke", "below"),
        connect("smoke", "main", "input"),
        ...(extra.more ?? []),
      ],
    },
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return { runtime, ids: result.output.createdIds as Record<string, NodeId> };
}

function Pane({ runtime }: { runtime: AppRuntime }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} />;
}

const undoDepth = (runtime: AppRuntime) => runtime.bus.store.getHistory(runtime.invocation.actor).undo.length;
const nodeOf = (runtime: AppRuntime, id: NodeId) => runtime.bus.store.getGraph().nodes[id]!;
const row = (id: NodeId) => document.querySelector(`[data-layer-row="${id}"]`) as HTMLElement;
const rowNames = () => [...document.querySelectorAll("[data-layer-row] button[title^='Select']")].map((each) => each.textContent);
async function run(work: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await work();
    await settle();
  });
}
const undo = (runtime: AppRuntime) => run(() => runtime.bus.execute("graph.undo", {}, runtime.invocation));
const click = (element: Element) => run(async () => fireEvent.click(element));
async function openLayers(runtime: AppRuntime): Promise<void> {
  render(<Pane runtime={runtime} />);
  await click(screen.getByRole("tab", { name: "Layers" }));
}

async function drag(track: HTMLElement, toX: number): Promise<void> {
  track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
  track.setPointerCapture = () => undefined;
  track.releasePointerCapture = () => undefined;
  track.hasPointerCapture = () => true;
  await act(async () => {
    fireEvent.pointerDown(track, { clientX: 30, clientY: 5, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: (30 + toX) / 2, clientY: 5, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: toX, clientY: 5, pointerId: 1 });
    await settle();
  });
}

describe("T1506b — the Layers tab", () => {
  it("lists the stack top first, as the wires stack it, under the output it ends in — and follows a rewire", async () => {
    const { runtime, ids } = await show();
    await openLayers(runtime);
    const stack = screen.getByRole("region", { name: "Layers into main" });
    expect(within(stack).getByRole("heading").textContent).toBe("main");
    expect(rowNames()).toEqual(["smoke", "city"]);

    // Put city on top: street → smoke → city → main. The list has no order of its own to keep.
    await run(() =>
      runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "disconnect", edgeIds: Object.keys(runtime.bus.store.getGraph().edges) } as GraphPatchOperation].concat([
              { op: "connect", source: { nodeId: ids["$street"]!, portId: "out" }, target: { nodeId: ids["$smoke"]!, portId: "below" } },
              { op: "connect", source: { nodeId: ids["$smoke"]!, portId: "out" }, target: { nodeId: ids["$city"]!, portId: "below" } },
              { op: "connect", source: { nodeId: ids["$city"]!, portId: "out" }, target: { nodeId: ids["$main"]!, portId: "input" } },
            ] as GraphPatchOperation[]),
        },
        runtime.invocation,
      ),
    );
    expect(rowNames()).toEqual(["city", "smoke"]);
  });

  it("is there only while the document holds a Layer; deleting the last one returns the pane to its controls", async () => {
    const { runtime, ids } = await show();
    await openLayers(runtime);
    await run(() => runtime.bus.execute("graph.removeNodes", { nodeIds: [ids["$city"]!, ids["$smoke"]!] }, runtime.invocation));
    expect(screen.queryByRole("tab", { name: "Layers" })).toBeNull();
    expect(document.querySelector("[data-layers-view]")).toBeNull();
    expect(screen.getByText("No controls")).toBeDefined();
  });

  it("the switch switches the layer off — bypassed, so it costs nothing — and one undo puts it back on", async () => {
    const { runtime, ids } = await show();
    await openLayers(runtime);
    const before = undoDepth(runtime);
    const toggle = () => within(row(ids["$city"]!)).getByRole("switch");
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    await click(toggle());

    expect(nodeOf(runtime, ids["$city"]!).ui?.bypassed).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(undoDepth(runtime)).toBe(before + 1);
    // The other layer is untouched.
    expect(nodeOf(runtime, ids["$smoke"]!).ui?.bypassed).not.toBe(true);
    await undo(runtime);
    expect(nodeOf(runtime, ids["$city"]!).ui?.bypassed).not.toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("a drag on the fader writes Opacity live and commits ONE undo step", async () => {
    const { runtime, ids } = await show();
    await openLayers(runtime);
    const before = undoDepth(runtime);

    await drag(within(row(ids["$city"]!)).getByRole("slider", { name: "Opacity" }), 60);

    expect(nodeOf(runtime, ids["$city"]!).parameters["opacity"]).toBeCloseTo(0.6, 6);
    expect(within(row(ids["$city"]!)).getByRole("slider", { name: "Opacity" }).getAttribute("aria-valuenow")).toBe("0.6");
    expect(undoDepth(runtime)).toBe(before + 1);
    await undo(runtime);
    expect(nodeOf(runtime, ids["$city"]!).parameters["opacity"]).toBe(1);
  });

  it("a driven Opacity is shown as driven and refuses the drag", async () => {
    const driven = { mode: "expression", bindings: { static: { kind: "static", value: 0.5 }, expression: { kind: "expression", source: "0.25 + 0.5" } } };
    const { runtime, ids } = await show({ city: { opacity: driven } });
    await openLayers(runtime);
    const fader = within(row(ids["$city"]!)).getByRole("slider", { name: "Opacity" });
    expect(fader.getAttribute("title")).toContain("driven");
    const revision = runtime.bus.store.getRevision();

    await drag(fader, 60);

    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(nodeOf(runtime, ids["$city"]!).parameters["opacity"]).toEqual(driven);
  });

  it("names the picture and the blend — and says “wired” while a wire feeds the picture, since the wire wins (B233)", async () => {
    const { runtime, ids } = await show({ city: { blend: "screen" } });
    await openLayers(runtime);
    const picture = () => row(ids["$city"]!).querySelector("[data-layer-picture]")!.textContent;
    expect(picture()).toBe("neon");
    expect(row(ids["$city"]!).querySelector("[data-layer-blend]")?.textContent).toBe("Screen");
    expect(row(ids["$smoke"]!).querySelector("[data-layer-blend]")?.textContent).toBe("Over");

    await run(() =>
      runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "connect", source: { nodeId: ids["$street"]!, portId: "out" }, target: { nodeId: ids["$city"]!, portId: "picture" } }],
        },
        runtime.invocation,
      ),
    );
    expect(picture()).toBe("wired");
    // A wire into the picture does not stack: the layer list is unchanged.
    expect(rowNames()).toEqual(["smoke", "city"]);

    await undo(runtime);
    expect(picture()).toBe("neon");
  });

  it("clicking a layer's name selects that node on the canvas, alone — the inspector shows the primary (§T1531b)", async () => {
    const { runtime, ids } = await show();
    const selected: string[][] = [];
    const holder = registerSelectNodesCommand(runtime.bus);
    holder.current = { select: (nodeIds) => selected.push([...nodeIds]), nodeIds: () => Object.keys(runtime.bus.store.getGraph().nodes) as NodeId[] };
    await openLayers(runtime);
    const revision = runtime.bus.store.getRevision();

    await click(within(row(ids["$city"]!)).getByRole("button", { name: "city" }));

    expect(selected).toEqual([[ids["$city"]!]]);
    // Selecting is view state: the document did not move.
    expect(runtime.bus.store.getRevision()).toBe(revision);
    holder.current = null;
  });

  it("marks the layer a preset fade is moving, while it moves, and no other", async () => {
    const looks = serializePresetBank({ version: 1, presets: [{ name: "fade", values: { smoke: { opacity: 0.2 } } }] });
    const { runtime, ids } = await show({ more: [add("looks", "presets", "looks", { targets: "smoke", presets: looks, morph: 2, curve: "linear" })] });
    let clock: FrameClock | undefined = { epoch: "e1", absTimeSeconds: 10 };
    runtime.bus.attachFrameClock(() => clock);
    await openLayers(runtime);
    const marked = () => [...document.querySelectorAll("[data-layer-morphing]")].map((mark) => mark.closest("[data-layer-row]")?.getAttribute("data-layer-row"));
    expect(marked()).toEqual([]);

    await run(() => runtime.bus.execute(PRESET_RECALL_COMMAND, { nodeId: ids["$looks"]!, name: "fade" }, runtime.invocation));
    expect(marked()).toEqual([ids["$smoke"]]);

    // Past the fade's end the mark is gone; the layer keeps the preset's value.
    clock = { epoch: "e1", absTimeSeconds: 12.5 };
    await act(async () => {
      await settle(250);
    });
    expect(marked()).toEqual([]);
    expect(nodeOf(runtime, ids["$smoke"]!).parameters["opacity"]).toBe(0.2);
  });

  it("sits beside one tab per Panel, which replaced the Panel picker", async () => {
    const { runtime } = await show({
      more: [add("p1", "panel", "panel1", { title: "Desk" }), add("p2", "panel", "panel2", { title: "Stage" })],
    });
    render(<Pane runtime={runtime} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Desk", "Stage", "Layers"]);
    expect(screen.queryByRole("combobox", { name: "Panel" })).toBeNull();
    await click(screen.getByRole("tab", { name: "Stage" }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Stage");
    await click(screen.getByRole("tab", { name: "Layers" }));
    expect(screen.getByRole("tab", { name: "Layers" }).getAttribute("aria-selected")).toBe("true");
    expect(rowNames()).toEqual(["smoke", "city"]);
  });
});
