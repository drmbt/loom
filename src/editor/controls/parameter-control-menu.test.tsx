// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { KeymapProvider } from "@editor/keymap/keymap-provider.tsx";
import { createKeymapStore } from "@editor/keymap/store.ts";
import { ContextMenuHost } from "@editor/menus/context-menu-host.tsx";
import { Inspector } from "@editor/inspector/inspector.tsx";
import { panelMembers } from "@nodes/definitions/controls.ts";

/**
 * T1514b — the parameter-first mapping on the REAL Inspector row, in the real menu host,
 * over the real app bus: right-click Brightness → "Control from Panel" makes the slider,
 * the row then says "← Brightness", and its × lets go, landing on the value it had. Mounted
 * rather than unit-tested because the dead-seam shape (§V844) is the risk: a command that
 * works on the bus and a row nobody can reach.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

async function runtimeWith(operations: GraphPatchOperation[]): Promise<AppRuntime> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label: "setup", operations }, runtime.invocation);
  expect(result.output.status).toBe("applied");
  return runtime;
}

const named = (runtime: AppRuntime, label: string): GraphNode => {
  const found = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === label);
  if (found === undefined) throw new Error(`no node "${label}"`);
  return found;
};

function mount(runtime: AppRuntime, label: string) {
  const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "other" });
  return render(
    <KeymapProvider bus={runtime.bus} store={store} invocationContext={runtime.invocation}>
      <ContextMenuHost bus={runtime.bus}>
        <Inspector
          bus={runtime.bus}
          context={runtime.invocation}
          nodeId={named(runtime, label).id}
          settings={{ outputResolution: { width: 64, height: 64 }, workingFormat: "rgba8unorm" }}
        />
      </ContextMenuHost>
    </KeymapProvider>,
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 32)));

function row(key: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-parameter-key="${key}"]`);
  if (found === null) throw new Error(`no row for "${key}"`);
  return found;
}

function menuItem(label: string): HTMLElement {
  const found = within(screen.getByRole("menu", { name: "parameter menu" }))
    .getByText(label, { selector: "span" })
    .closest("[data-menu-command],[data-menu-submenu]");
  if (found === null) throw new Error(`no menu item "${label}"`);
  return found as HTMLElement;
}

/** A leaf inside an open submenu (Radix portals each submenu as its own menu). */
function submenuItem(label: string): HTMLElement {
  const found = screen
    .getAllByRole("menu")
    .flatMap((menu) => within(menu).queryAllByText(label, { selector: "span" }))
    .map((span) => span.closest("[data-menu-command]"))
    .find((item): item is HTMLElement => item !== null);
  if (found === undefined) throw new Error(`no submenu item "${label}"`);
  return found;
}

const level: GraphPatchOperation = { op: "addNode", ref: "$level", type: "level", position: { x: 400, y: 0 }, label: "level1", parameters: { brightness: 3 } };

describe("T1514b — right-click a parameter in the Inspector", () => {
  it("Control from Panel makes the slider, the row shows ← Brightness, and × lets go back to 3", async () => {
    const runtime = await runtimeWith([level]);
    mount(runtime, "level1");
    await settle();

    fireEvent.contextMenu(row("brightness"), { clientX: 10, clientY: 10 });
    const item = menuItem("Control from Panel");
    expect(item.getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(item);
    });
    await settle();

    const slider = named(runtime, "slider_brightness");
    expect(slider.parameters).toMatchObject({ value: 3, min: 0, max: 8 });
    const [panel] = Object.values(runtime.bus.store.getGraph().nodes).filter((node) => node.type === "panel");
    expect(panelMembers(runtime.bus.store.getGraph(), panel as GraphNode).map((node) => node.id)).toEqual([slider.id]);

    // The chip, AT the row it describes.
    const chip = within(row("brightness")).getByText("← Brightness");
    expect(chip).toBeDefined();
    await act(async () => {
      fireEvent.click(within(row("brightness")).getByRole("button", { name: "Unlink Brightness" }));
    });
    await settle();
    expect(named(runtime, "level1").parameters["brightness"]).toMatchObject({ mode: "static", bindings: { static: { value: 3 } } });
    expect(within(row("brightness")).queryByText("← Brightness")).toBeNull();
  });

  it("greys Control from Panel on a parameter no control fits, and says why", async () => {
    const runtime = await runtimeWith([{ op: "addNode", ref: "$remap", type: "remap", position: { x: 0, y: 0 }, label: "remap1" }]);
    mount(runtime, "remap1");
    await settle();
    fireEvent.contextMenu(row("sourcex"), { clientX: 10, clientY: 10 });
    const item = menuItem("Control from Panel");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toContain("enum parameter");
    // And "Unlink control" is offered, greyed, with its reason — nothing drives this row.
    expect(menuItem("Unlink control").getAttribute("title")).toBe("No control drives this parameter.");
  });

  it("with several Panels, Control from Panel is a submenu and the chosen Panel gets it", async () => {
    const runtime = await runtimeWith([
      level,
      { op: "addNode", ref: "$a", type: "panel", position: { x: -900, y: 0 }, label: "deskA", parameters: { title: "Desk A" } },
      { op: "addNode", ref: "$b", type: "panel", position: { x: -900, y: 700 }, label: "deskB", parameters: { title: "Desk B" } },
    ]);
    mount(runtime, "level1");
    await settle();
    fireEvent.contextMenu(row("contrast"), { clientX: 10, clientY: 10 });
    fireEvent.keyDown(menuItem("Control from Panel"), { key: "Enter" });
    await waitFor(() => expect(submenuItem("Desk B")).toBeDefined());
    await act(async () => {
      fireEvent.click(submenuItem("Desk B"));
    });
    await settle();
    const graph = runtime.bus.store.getGraph();
    expect(panelMembers(graph, named(runtime, "deskB")).map((node) => node.label)).toEqual(["slider_contrast"]);
    expect(panelMembers(graph, named(runtime, "deskA"))).toEqual([]);
  });

  it("Drive from lists the controls by caption and binds the one picked", async () => {
    const runtime = await runtimeWith([
      level,
      { op: "addNode", ref: "$heat", type: "slider", position: { x: -400, y: 0 }, label: "heat", parameters: { channel: "heat", caption: "Heat", value: 1.5, min: 0, max: 2 } },
      { op: "addNode", ref: "$flash", type: "button", position: { x: -400, y: 300 }, label: "flash", parameters: { channel: "flash", caption: "Next hue" } },
    ]);
    mount(runtime, "level1");
    await settle();
    fireEvent.contextMenu(row("brightness"), { clientX: 10, clientY: 10 });
    fireEvent.keyDown(menuItem("Drive from"), { key: "Enter" });
    await waitFor(() => expect(submenuItem("Heat")).toBeDefined());
    // A Button is a submenu of its two channels, not one ambiguous row.
    expect(screen.getAllByRole("menu").some((menu) => within(menu).queryByText("Next hue", { selector: "span" }) !== null)).toBe(true);
    await act(async () => {
      fireEvent.click(submenuItem("Heat"));
    });
    await settle();
    expect(named(runtime, "level1").parameters["brightness"]).toMatchObject({ mode: "expression", bindings: { static: { value: 3 }, expression: { source: "op('heat').chan.heat" } } });
    expect(within(row("brightness")).getByText("← Heat")).toBeDefined();
  });
});
