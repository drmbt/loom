import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { LoomBackend, PresentationOptions } from "@runtime/backend/backend-types.ts";
import { createDisplaySinkStore } from "./display-sinks.ts";
import type { ScreenInfo, ScreenSource } from "./perform-screens.ts";
import { usePerformWindows } from "./use-perform-windows.ts";
import type { PerformPlan } from "./use-perform-windows.ts";

/**
 * §T1391b — the perform windows through the REAL bus command, the way the key, the palette
 * and the inspector's button all reach them. What is asserted is what decides the picture:
 * which Window Outs the compile is told to render (the display sinks), which target each
 * window presents, and where the window was asked to open.
 */

const context = contextFor(alice);

const projector: ScreenInfo = {
  label: "EPSON PJ", left: 1512, top: 0, width: 1920, height: 1080,
  availLeft: 1512, availTop: 0, availWidth: 1920, availHeight: 1080,
  devicePixelRatio: 1, isPrimary: false, isInternal: false,
};
const laptop: ScreenInfo = { ...projector, label: "Built-in", left: 0, availLeft: 0, isPrimary: true, isInternal: true };
const screens: ScreenSource = {
  screens: () => [laptop, projector],
  editor: () => laptop,
  permission: () => "granted",
  request: () => Promise.resolve(),
  subscribe: () => () => {},
};

async function setup(types: readonly string[]) {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: types.map((type, index) => ({ op: "addNode" as const, ref: `$${String(index)}` as const, type, position: { x: index * 300, y: 0 } })),
    },
    context,
  );
  const ids = types.map((_, index) => created.output.createdIds[`$${String(index)}`] as NodeId);
  const displaySinks = createDisplaySinkStore();
  const presented: Array<{ options: PresentationOptions; outputs: string[]; disposed: boolean }> = [];
  const sources: Array<unknown> = [];
  const backend = {
    setFrameSource: (source: unknown) => sources.push(source),
    present: (_canvas: unknown, options: PresentationOptions) => {
      const entry = { options, outputs: [options.outputId], disposed: false };
      presented.push(entry);
      return { id: "p", outputId: options.outputId, setOutput: (next: string) => entry.outputs.push(next), dispose: () => { entry.disposed = true; } };
    },
  } as unknown as LoomBackend;
  const opened: Array<{ name: string; features: string }> = [];
  const openWindow = (name: string, features: string) => {
    opened.push({ name, features });
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    return frame.contentWindow;
  };
  const hook = renderHook(
    ({ plan }: { plan: PerformPlan | null }) =>
      usePerformWindows({ bus, backend, plan, displaySinks, openWindow, screenSource: screens }),
    { initialProps: { plan: null as PerformPlan | null } },
  );
  const toggle = async (nodeIds?: string[]) =>
    act(async () => bus.execute("perform.toggle", nodeIds === undefined ? {} : { nodeIds }, context));
  return { bus, ids, displaySinks, presented, opened, hook, toggle, sources };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("perform windows, through perform.toggle", () => {
  it("opens every Window Out when none is named, on Auto's screen, and asks the compile to render it", async () => {
    const { ids, displaySinks, opened, toggle } = await setup(["window", "window", "checker"]);
    const result = await toggle();
    expect(result.status).toBe("applied");
    expect(result.output.open).toEqual([...ids.slice(0, 2)].sort());
    expect(displaySinks.get().map((sink) => sink.nodeId)).toEqual([...ids.slice(0, 2)].sort());
    // Auto = the screen that is not the editor's; fullscreen asked for (permission granted).
    expect(opened[0]?.features).toBe("popup=yes,left=1512,top=0,width=1920,height=1080,fullscreen");
  });

  it("presents the target a recompile brings, and follows it", async () => {
    const { ids, presented, hook, toggle } = await setup(["window"]);
    await toggle([ids[0]!]);
    expect(presented).toHaveLength(0);
    const target = `target:${ids[0]!}:$target`;
    act(() => hook.rerender({ plan: { outputs: [{ nodeId: ids[0]!, portId: "$target", resourceId: target }] } }));
    expect(presented.map((entry) => [entry.options.outputId, entry.options.sizing])).toEqual([[target, "source"]]);
  });

  it("closes them when every target is already open, and the compile stops rendering them", async () => {
    const { ids, displaySinks, hook, presented, toggle } = await setup(["window"]);
    act(() => hook.rerender({ plan: { outputs: [{ nodeId: ids[0]!, portId: "$target", resourceId: "t" }] } }));
    await toggle();
    expect(presented).toHaveLength(1);
    const closed = await toggle();
    expect(closed.output.open).toEqual([]);
    expect(displaySinks.get()).toEqual([]);
    expect(presented[0]!.disposed).toBe(true);
  });

  it("closes a window whose Window Out is deleted", async () => {
    const { bus, ids, displaySinks, toggle } = await setup(["window"]);
    await toggle();
    await act(async () => {
      await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [{ op: "removeNodes", nodeIds: [ids[0]!] }] }, context);
    });
    expect(displaySinks.get()).toEqual([]);
  });

  it("hands the loop to the visible perform window, and back to the editor when it closes (§V202)", async () => {
    const { toggle, sources } = await setup(["window"]);
    await toggle();
    const child = sources.at(-1) as Window | null;
    expect(child).not.toBeNull();
    expect(child?.document.visibilityState).toBe("visible");
    await toggle();
    expect(sources.at(-1)).toBeNull();
  });

  it("refuses by name when there is no Window Out", async () => {
    const { toggle } = await setup(["checker"]);
    const result = await toggle();
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("perform.noWindowNode");
  });
});
