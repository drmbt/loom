// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newKey, newLane, parseAutomation, serializeAutomation } from "@domain/automation/model.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { App } from "../../app/app.tsx";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * VN63 — DRAG A PARAMETER'S NAME TO REFERENCE IT, through the whole App: the real
 * inspector rows as the drag source (their node from the inspector's `data-node-id`), the
 * real lane list and parameter rows as drop targets, the real bus, `graph.undo`.
 *
 * jsdom starts no native drag, so the browser's half is played by firing `dragstart` on
 * the name and `drop` on the target with one shared DataTransfer, which is exactly the
 * object a browser hands both ends.
 */
beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  const range = Range.prototype as unknown as Record<string, unknown>;
  range["getClientRects"] ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
  range["getBoundingClientRect"] ??= () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) });
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };
const S = 240_000;

/** The DataTransfer a browser hands dragstart and drop alike. */
function transfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

async function mount(extra: GraphPatchOperation[] = []): Promise<{ runtime: AppRuntime; lfoId: string; ids: Record<string, string>; container: HTMLElement }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const seeded = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "seed",
      operations: [
        { op: "addNode", ref: "$lfo", type: "lfo", position: { x: 0, y: 0 }, label: "lfo_a", parameters: { frequency: 25, amplitude: 2, offset: 0.5 } },
        ...extra,
      ],
    },
    runtime.invocation,
  );
  const ids = seeded.output.createdIds as Record<string, string>;
  const view = await act(async () => render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />));
  const element = view.container.querySelector(`.react-flow__node[data-id="${ids["$lfo"]}"]`);
  if (element === null) throw new Error("expected the lfo on the canvas");
  await act(async () => {
    fireEvent.click(element);
  });
  await waitFor(() => expect(view.container.querySelector(`[data-node-id="${ids["$lfo"]}"]`)).not.toBeNull());
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "timeline" }));
  });
  return { runtime, lfoId: ids["$lfo"]!, ids, container: view.container };
}

/** The inspector row's NAME for a parameter, the drag source. */
const nameOf = (container: HTMLElement, key: string): HTMLElement => {
  const rows = container.querySelectorAll<HTMLElement>(`[data-node-id] [data-parameter-key="${key}"]`);
  const name = rows[rows.length - 1]?.querySelector<HTMLElement>("[draggable='true']");
  if (name === null || name === undefined) throw new Error(`no draggable name for ${key}`);
  return name;
};

async function dragOnto(source: HTMLElement, target: HTMLElement): Promise<void> {
  const dataTransfer = transfer();
  await act(async () => {
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
  });
}

const parameter = (runtime: AppRuntime, nodeId: string, key: string) => runtime.bus.store.getGraph().nodes[nodeId]!.parameters[key];
const undo = async (runtime: AppRuntime) => {
  await act(async () => {
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
  });
};

describe("VN63 — a parameter's name, dragged at once, carries a reference", () => {
  it("dropped on the lane list: a new lane holding the value, and the reference, in ONE undo step", async () => {
    const { runtime, lfoId, container } = await mount();
    const before = runtime.bus.store.getGraph();
    expect(nameOf(container, "frequency").getAttribute("draggable")).toBe("true");
    await dragOnto(nameOf(container, "frequency"), container.querySelector<HTMLElement>("[data-lane-drop='list']")!);

    await waitFor(() => expect(Object.values(runtime.bus.store.getGraph().nodes).some((node) => node.type === "automation")).toBe(true));
    const automation = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.type === "automation")!;
    expect(automation.label).toBe("automation1");
    const lanes = parseAutomation(storedStaticValue(automation.parameters["lanes"]));
    expect(lanes.ok && lanes.document.lanes.map((lane) => [lane.name, lane.min, lane.max, lane.keys.map((key) => [key.t, key.v])])).toEqual([["frequency", 0, 100, [[0, 0.25]]]]);
    // The parameter reads the lane, and still holds its value for a flip back to Constant.
    expect(parameter(runtime, lfoId, "frequency")).toEqual({
      mode: "expression",
      bindings: { static: { kind: "static", value: 25 }, expression: { kind: "expression", source: "op('automation1').chan.frequency" } },
    });

    await undo(runtime);
    const after = runtime.bus.store.getGraph();
    expect(Object.keys(after.nodes).sort()).toEqual(Object.keys(before.nodes).sort());
    expect(after.nodes[lfoId]!.parameters).toEqual(before.nodes[lfoId]!.parameters);
  }, 30_000);

  it("dropped on an existing lane: only the reference is written", async () => {
    const lanes = serializeAutomation({ version: 1, lanes: [newLane("lane1", "level", [newKey("k1", 0, 0), newKey("k2", S, 1)])] });
    const { runtime, lfoId, ids, container } = await mount([
      { op: "addNode", ref: "$auto", type: "automation", position: { x: 0, y: 300 }, label: "automation_score", parameters: { lanes } } as GraphPatchOperation,
    ]);
    const lane = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-lane='lane1']");
      if (found === null) throw new Error("lane not listed");
      return found;
    });
    await dragOnto(nameOf(container, "frequency"), lane);
    await waitFor(() => expect(parameter(runtime, lfoId, "frequency")).toMatchObject({ mode: "expression", bindings: { expression: { source: "op('automation_score').chan.level" } } }));
    expect(storedStaticValue(parameter(runtime, ids["$auto"]!, "lanes"))).toBe(lanes);
  }, 30_000);

  it("dropped on another parameter of the SAME node: the paste path's sibling reference, and one undo takes it back", async () => {
    const { runtime, lfoId, container } = await mount();
    // Dropped where a pointer lands: inside the Offset row (its name), bubbling to the row.
    await dragOnto(nameOf(container, "amplitude"), nameOf(container, "offset"));
    // `parameter.paste {as: "reference"}` lands a reference to a SIBLING as a bind (§V81's
    // in-scope read); across nodes it is the op() expression (parameter-drag-service.test.ts).
    await waitFor(() => expect(parameter(runtime, lfoId, "offset")).toMatchObject({ mode: "bind", bindings: { bind: { kind: "bind", ref: "amplitude" } } }));
    await undo(runtime);
    expect(parameter(runtime, lfoId, "offset")).toBe(0.5);
  }, 30_000);

  it("a quick click on the name writes nothing: no lane, no reference", async () => {
    const { runtime, container } = await mount();
    const revision = runtime.bus.store.getRevision();
    const name = nameOf(container, "frequency");
    await act(async () => {
      fireEvent.pointerDown(name, { pointerId: 3, clientX: 10, button: 0 });
      fireEvent.pointerUp(name, { pointerId: 3, clientX: 10 });
      fireEvent.click(name);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(runtime.bus.store.getRevision()).toBe(revision);
  }, 30_000);
});
