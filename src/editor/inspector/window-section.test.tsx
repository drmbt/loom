// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { registerPerformCommands } from "@/app/perform-commands.ts";
import { Inspector } from "./inspector.tsx";
import type { WindowSectionSurface } from "./window-section.tsx";

/**
 * §T1391b — the Window section through the REAL inspector: what it writes is read back
 * from the document, and Open goes through `perform.toggle` by name.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);

const surface: WindowSectionSurface = {
  screens: () => [
    { label: "Built-in", width: 1512, height: 982, devicePixelRatio: 2, isPrimary: true },
    { label: "EPSON PJ", width: 1920, height: 1080, devicePixelRatio: 1, isPrimary: false },
  ],
  permission: () => "granted",
  requestScreenAccess: () => Promise.resolve(),
  isOpen: () => false,
  describe: () => "Closed — opens on EPSON PJ (1920×1080 physical)",
  subscribe: () => () => {},
  mapping: () => ({ editing: false, targets: [], chosen: undefined }),
  setEditingMapping: () => {},
  chooseMapping: () => {},
};

async function mount(windows: WindowSectionSurface = surface) {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    { baseRevision: 0, operations: [{ op: "addNode", ref: "$w", type: "window", position: { x: 0, y: 0 } }] },
    context,
  );
  const nodeId = created.output.createdIds["$w"] as NodeId;
  const toggled: Array<readonly string[] | undefined> = [];
  const holder = registerPerformCommands(bus);
  holder.current = {
    available: () => true,
    windowNodes: () => [nodeId],
    isOpen: () => false,
    openIds: () => [],
    open: (ids) => {
      toggled.push(ids);
      return [];
    },
    close: () => {},
  };
  render(
    <StrictMode>
      <Inspector
        bus={bus}
        context={context}
        nodeId={nodeId}
        settings={{ outputResolution: { width: 64, height: 64 }, workingFormat: "rgba8unorm" }}
        performWindows={windows}
      />
    </StrictMode>,
  );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 32)));
  await settle();
  const parameters = () => bus.store.getGraph().nodes[nodeId]?.parameters ?? {};
  return { bus, nodeId, toggled, parameters, settle };
}

describe("the Window section (§T1391b)", () => {
  it("picks a screen from the displays the browser reports, into the Screen parameter", async () => {
    const { parameters, settle } = await mount();
    const picker = screen.getByRole("combobox", { name: "Screen" }) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual(["", "Built-in", "EPSON PJ"]);
    fireEvent.change(picker, { target: { value: "EPSON PJ" } });
    await settle();
    expect(parameters()["screen"]).toBe("EPSON PJ");
  });

  it("Match screen writes the chosen display's PHYSICAL pixels as one undo step", async () => {
    const { bus, parameters, settle } = await mount();
    fireEvent.change(screen.getByRole("combobox", { name: "Screen" }), { target: { value: "Built-in" } });
    await settle();
    const before = [parameters()["width"], parameters()["height"]];
    fireEvent.click(screen.getByRole("button", { name: "Match screen" }));
    await settle();
    expect([parameters()["width"], parameters()["height"]]).toEqual([3024, 1964]);
    await act(async () => {
      await bus.execute("graph.undo", {}, context);
    });
    // One step back restores BOTH, not just one of the two.
    expect([parameters()["width"], parameters()["height"]]).toEqual(before);
    expect(before).not.toEqual([3024, 1964]);
  });

  it("Open window runs perform.toggle for this node", async () => {
    const { nodeId, toggled, settle } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open window" }));
    await settle();
    expect(toggled).toEqual([[nodeId]]);
  });

  it("§T1536b: Edit mapping turns the open window's mode on; the picker chooses among the warps; a refusal is said", async () => {
    const calls: unknown[][] = [];
    let editing = false;
    let chosen = "near";
    const listeners = new Set<() => void>();
    const windows: WindowSectionSurface = {
      ...surface,
      isOpen: () => true,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      mapping: () => ({
        editing,
        chosen,
        targets: [
          { nodeId: "near", label: 'Corner Pin "cornerPin2"', refusal: null },
          { nodeId: "far", label: 'Grid Warp "gridWarp1"', refusal: "Behind a second warp." },
        ],
      }),
      setEditingMapping: (...args) => {
        calls.push(["edit", ...args]);
        editing = args[1];
        for (const listener of listeners) listener();
      },
      chooseMapping: (...args) => {
        calls.push(["choose", ...args]);
        chosen = args[1];
        for (const listener of listeners) listener();
      },
    };
    const { nodeId, settle } = await mount(windows);
    fireEvent.click(screen.getByRole("button", { name: "Edit mapping" }));
    await settle();
    expect(calls).toEqual([["edit", nodeId, true]]);
    expect(screen.getByRole("button", { name: "Stop editing" }).getAttribute("aria-pressed")).toBe("true");
    const picker = screen.getByRole("combobox", { name: "Edits" }) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual(["near", "far"]);
    expect(screen.queryByText("Behind a second warp.")).toBeNull();
    fireEvent.change(picker, { target: { value: "far" } });
    await settle();
    expect(calls.at(-1)).toEqual(["choose", nodeId, "far"]);
    expect(screen.getByText("Behind a second warp.")).toBeTruthy();
  });

  it("§T1536b: Edit mapping waits for an open window", async () => {
    await mount();
    expect((screen.getByRole("button", { name: "Edit mapping" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("presents Screen in the section, not again as a text row", async () => {
    await mount();
    expect(screen.queryByRole("textbox", { name: "Screen" })).toBeNull();
  });
});
