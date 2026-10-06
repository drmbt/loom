// @vitest-environment jsdom
import { useState, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDocument } from "@domain/project/test-support.ts";
import type { GraphEdge, GraphNode } from "@domain/types/graph.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { KeymapProvider } from "@editor/keymap/keymap-provider.tsx";
import { createKeymapStore } from "@editor/keymap/store.ts";
import { ContextMenuHost } from "@editor/menus/context-menu-host.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { controlPanelOf, resetAllSentence, tallyDefaults } from "./control-defaults.ts";
import { ControlWidget } from "./control-widget.tsx";
import { ControlsPane } from "./controls-pane.tsx";
import { PanelNodeBody } from "./panel-surface.tsx";

/**
 * T1619b S2 — RESET ON THE DESK, through the real app runtime and the real menu host.
 *
 * Owner: "resetting in the controls is not visible for me anywhere … want to be able reset
 * individual controls or all page or all". What is asserted is what he gets: the mark a
 * control draws at its default and whether it reads as away; the menu a right-click opens,
 * what each row dispatches (exactly ONE command) and what the control reads after it; and
 * the header's reset-all, one patch and one undo. Never which function ran.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

/** A node as a document holds it. Slider, Toggle and XY Pad are at definition version 2 (they hold a default). */
const node = (id: string, type: string, label: string, parameters: Record<string, StoredParameter>): GraphNode => ({
  id,
  type,
  label,
  definitionVersion: type === "slider" || type === "toggle" || type === "xyPad" ? 2 : 1,
  position: { x: 0, y: 0 },
  parameters,
});
const wire = (from: string, panel: string, order: number): GraphEdge => ({ id: `${from}_${panel}`, source: { nodeId: from, portId: "out" }, target: { nodeId: panel, portId: "controls" }, order });

const learned: StoredParameter = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.9" }, static: { kind: "static", value: 0.2 } } };

/**
 * Two Panels. "Robot": a slider and a toggle away from their defaults, a pad at its default,
 * a slider with no default, a slider an expression drives, and a Button. "Lights": one slider
 * away from its default, which a reset of Robot must leave alone.
 *
 * Opened as a DOCUMENT, the way a file is, not built by patches: a control made on the bus is
 * born at its default (`bornWith`), and `slider_gain` has to be one that stores none — what
 * a document source that authored no default ships.
 */
function desk(): Promise<AppRuntime> {
  const robot = ["heat", "perch", "view", "gain", "learned", "flash"];
  const nodes: GraphNode[] = [
    node("heat", "slider", "slider_heat", { channel: "heat", caption: "Heat", value: 1.7, min: 0, max: 2, defaultValue: 1 }),
    node("perch", "toggle", "toggle_perch", { channel: "perch", caption: "Perch", on: true, defaultOn: false }),
    node("view", "xyPad", "xypad_view", { channel: "view", caption: "View", x: 0.25, y: 0.75, min: 0, max: 1, defaultX: 0.25, defaultY: 0.75 }),
    node("gain", "slider", "slider_gain", { channel: "gain", caption: "Gain", value: 7, min: 0, max: 10 }),
    node("learned", "slider", "slider_learned", { channel: "learned", caption: "Learned", value: learned, defaultValue: 0.5 }),
    node("flash", "button", "button_flash", { channel: "flash", caption: "Flash" }),
    node("lamp", "slider", "slider_lamp", { channel: "lamp", caption: "Lamp", value: 0.1, defaultValue: 0.8 }),
    node("robot", "panel", "panel_robot", { title: "Robot" }),
    node("lights", "panel", "panel_lights", { title: "Lights" }),
  ];
  const edges = [...robot.map((each, order) => wire(each, "robot", order)), wire("lamp", "lights", 0)];
  const document = testDocument({
    graph: { revision: 1, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: Object.fromEntries(edges.map((each) => [each.id, each])), groups: {} },
  });
  return Promise.resolve(createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" }, document }));
}

const named = (runtime: AppRuntime, label: string): GraphNode => {
  const found = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === label);
  if (found === undefined) throw new Error(`no node "${label}"`);
  return found;
};
const stored = (runtime: AppRuntime, label: string, key: string): StoredParameter | undefined => named(runtime, label).parameters[key];

/** The Controls tab as the app mounts it: the menu host around the pane, inside the keymap. */
function Desk({ runtime }: { runtime: AppRuntime }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  const [keymap] = useState(() => createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "other" }));
  return (
    <KeymapProvider bus={runtime.bus} store={keymap} invocationContext={runtime.invocation}>
      <ContextMenuHost bus={runtime.bus}>
        <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} />
      </ContextMenuHost>
    </KeymapProvider>
  );
}

/** Every command the bus ran from here on, in order, with its input. */
function watch(runtime: AppRuntime): Array<{ command: string; input: unknown }> {
  const ran: Array<{ command: string; input: unknown }> = [];
  const real = runtime.bus.execute.bind(runtime.bus);
  vi.spyOn(runtime.bus, "execute").mockImplementation((command, input, context) => {
    ran.push({ command, input });
    return real(command, input, context);
  });
  return ran;
}

const control = (label: string): HTMLElement => {
  const found = document.querySelector(`[data-control-node="${label}"][data-control]`);
  if (found === null) throw new Error(`no control for ${label}`);
  return found as HTMLElement;
};
const controlOf = (runtime: AppRuntime, label: string): HTMLElement => control(named(runtime, label).id);
const markOf = (element: HTMLElement): string | null => element.querySelector("[data-default-mark]")?.getAttribute("data-default-mark") ?? null;

function openMenuOn(element: HTMLElement): HTMLElement {
  fireEvent.contextMenu(element, { clientX: 40, clientY: 60 });
  return screen.getByRole("menu");
}
const row = (menu: HTMLElement, label: string): HTMLElement => {
  const found = within(menu).getByText(label, { selector: "span" }).closest("[data-menu-command]");
  if (found === null) throw new Error(`no menu row "${label}"`);
  return found as HTMLElement;
};
const choose = async (menu: HTMLElement, label: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(row(menu, label));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("T1619b — a control marks its default, and whether it is away from it", () => {
  const widget = (type: string, parameters: Record<string, unknown>) =>
    render(<ControlWidget nodeId="n" type={type} parameters={parameters} write={() => undefined} size="board" />).container;

  it("a slider draws a tick at its default: dim at it, bright away from it, at the default's place on the track", () => {
    const at = widget("slider", { value: 1, min: 0, max: 2, defaultValue: 1 }).querySelector<HTMLElement>("[data-default-mark]");
    expect(at?.getAttribute("data-default-mark")).toBe("at");
    expect(at?.style.left).toBe("50%");
    cleanup();
    const away = widget("slider", { value: 1.7, min: 0, max: 2, defaultValue: 0.5 }).querySelector<HTMLElement>("[data-default-mark]");
    expect(away?.getAttribute("data-default-mark")).toBe("away");
    // Where the DEFAULT is (a quarter along 0..2), not where the value is.
    expect(away?.style.left).toBe("25%");
  });

  it("a control that holds no default, and one the document drives, draw no mark: there is nothing to go back to", () => {
    expect(widget("slider", { value: 7, min: 0, max: 10 }).querySelector("[data-default-mark]")).toBeNull();
    cleanup();
    expect(widget("slider", { value: learned, defaultValue: 0.5 }).querySelector("[data-default-mark]")).toBeNull();
    cleanup();
    expect(widget("button", { held: false }).querySelector("[data-default-mark]")).toBeNull();
  });

  it("a toggle shows its dot only while its state is not its default", () => {
    expect(widget("toggle", { on: true, defaultOn: false }).querySelector("[data-default-mark]")?.getAttribute("data-default-mark")).toBe("away");
    cleanup();
    expect(widget("toggle", { on: false, defaultOn: false }).querySelector("[data-default-mark]")).toBeNull();
    cleanup();
    expect(widget("toggle", { on: true }).querySelector("[data-default-mark]")).toBeNull();
  });

  it("an XY pad draws a ring at its default when both axes hold one, bright when either is away", () => {
    const at = widget("xyPad", { x: 0.25, y: 0.75, min: 0, max: 1, defaultX: 0.25, defaultY: 0.75 }).querySelector<HTMLElement>("[data-default-mark]");
    expect([at?.getAttribute("data-default-mark"), at?.style.left, at?.style.bottom]).toEqual(["at", "25%", "75%"]);
    cleanup();
    expect(widget("xyPad", { x: 0.25, y: 0.1, min: 0, max: 1, defaultX: 0.25, defaultY: 0.75 }).querySelector("[data-default-mark]")?.getAttribute("data-default-mark")).toBe("away");
    cleanup();
    // Half a place is no place.
    expect(widget("xyPad", { x: 0.25, y: 0.1, min: 0, max: 1, defaultX: 0.25 }).querySelector("[data-default-mark]")).toBeNull();
  });
});

describe("T1619b — the control menu: a right-click, then a row", () => {
  it("offers Reset, Set as default and the two rows for the Panel it was clicked on, and prints no chord beside a row the chord would not run", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    const menu = openMenuOn(controlOf(runtime, "slider_heat"));
    expect(menu.dataset["menuSurface"]).toBe("control");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Reset", "Set as default", "Reset all on Robot", "Set all as default on Robot"]);
  });

  it("Reset runs ONE command, on that control alone: it reads its default, and one undo gives the moved value back", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    expect(markOf(controlOf(runtime, "slider_heat"))).toBe("away");
    const revision = runtime.bus.store.getRevision();
    const ran = watch(runtime);

    await choose(openMenuOn(controlOf(runtime, "slider_heat")), "Reset");

    expect(ran).toEqual([{ command: "control.reset", input: { nodeIds: [named(runtime, "slider_heat").id] } }]);
    expect(stored(runtime, "slider_heat", "value")).toBe(1);
    expect(runtime.bus.store.getRevision()).toBe(revision + 1);
    expect(markOf(controlOf(runtime, "slider_heat"))).toBe("at");
    // The toggle beside it was not asked, and is still away.
    expect(stored(runtime, "toggle_perch", "on")).toBe(true);

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(stored(runtime, "slider_heat", "value")).toBe(1.7);
  });

  it("Set as default runs ONE command: the value stays, the default moves to it, and the mark reads as at it", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    const ran = watch(runtime);
    await choose(openMenuOn(controlOf(runtime, "slider_heat")), "Set as default");
    expect(ran).toEqual([{ command: "control.setDefault", input: { nodeIds: [named(runtime, "slider_heat").id] } }]);
    expect([stored(runtime, "slider_heat", "value"), stored(runtime, "slider_heat", "defaultValue")]).toEqual([1.7, 1.7]);
    expect(markOf(controlOf(runtime, "slider_heat"))).toBe("at");
  });

  it("Reset all on the Panel runs ONE command naming the Panel: its controls go back in one patch, the other Panel's stays moved", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    const revision = runtime.bus.store.getRevision();
    const ran = watch(runtime);
    await choose(openMenuOn(controlOf(runtime, "toggle_perch")), "Reset all on Robot");
    expect(ran).toEqual([{ command: "control.reset", input: { nodeIds: [named(runtime, "panel_robot").id] } }]);
    expect([stored(runtime, "slider_heat", "value"), stored(runtime, "toggle_perch", "on")]).toEqual([1, false]);
    expect(runtime.bus.store.getRevision()).toBe(revision + 1);
    expect(stored(runtime, "slider_lamp", "value")).toBe(0.1);
    // What it left alone stays as it was: no default to go to, and a learned value.
    expect(stored(runtime, "slider_gain", "value")).toBe(7);
    expect(stored(runtime, "slider_learned", "value")).toEqual(learned);
  });

  it("a row that could only refuse is greyed and says why, in the command's own sentence: at its default, no default, driven", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    const ran = watch(runtime);
    /** Opens the menu on a control, reads a row's state and reason, presses it anyway, and starts over. */
    const reasonOn = (label: string, item: string): [string | null, string | null] => {
      const found = row(openMenuOn(controlOf(runtime, label)), item);
      const read: [string | null, string | null] = [found.getAttribute("aria-disabled"), found.getAttribute("title")];
      fireEvent.click(found);
      cleanup();
      render(<Desk runtime={runtime} />);
      return read;
    };
    expect(reasonOn("xypad_view", "Reset")).toEqual(["true", "It is at its default already."]);
    expect(reasonOn("slider_gain", "Reset")).toEqual(["true", '"slider_gain" has no default to go back to. Set as default gives it one.']);
    expect(reasonOn("slider_learned", "Reset")).toEqual(["true", '"slider_learned.value" is driven by the document (an expression or a MIDI learn), so a reset leaves it as it is.']);
    expect(reasonOn("slider_learned", "Set as default")).toEqual(["true", '"slider_learned.value" is driven by the document (an expression or a MIDI learn), so it has no hand-set value to keep as a default.']);
    // A greyed row dispatches nothing.
    expect(ran).toEqual([]);
  });

  it("Set as default is what gives a control with no default one: then a move and a Reset come back to it", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    expect(markOf(controlOf(runtime, "slider_gain"))).toBeNull();
    await choose(openMenuOn(controlOf(runtime, "slider_gain")), "Set as default");
    expect(stored(runtime, "slider_gain", "defaultValue")).toBe(7);
    expect(markOf(controlOf(runtime, "slider_gain"))).toBe("at");
    await act(async () => {
      await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: named(runtime, "slider_gain").id, parameters: { value: 2 } }] }, runtime.invocation);
    });
    await choose(openMenuOn(controlOf(runtime, "slider_gain")), "Reset");
    expect(stored(runtime, "slider_gain", "value")).toBe(7);
  });

  it("a Button opens no control menu: it holds nothing to reset", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    fireEvent.contextMenu(controlOf(runtime, "button_flash"), { clientX: 40, clientY: 60 });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("on a Panel node's own body the Panel is the node's; a control clicked on no Panel offers the whole document instead", async () => {
    const runtime = await desk();
    const write = () => undefined;
    const view = render(
      <KeymapProvider bus={runtime.bus} store={createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "other" })} invocationContext={runtime.invocation}>
        <ContextMenuHost bus={runtime.bus}>
          <PanelNodeBody bus={runtime.bus} invocation={runtime.invocation} panelId={named(runtime, "panel_lights").id} write={write} />
          <div data-testid="own-node">
            <ControlWidget nodeId={named(runtime, "slider_lamp").id} type="slider" parameters={named(runtime, "slider_lamp").parameters} write={write} size="node" />
          </div>
        </ContextMenuHost>
      </KeymapProvider>,
    );
    const onPanel = view.container.querySelector<HTMLElement>("[data-panel-body] [data-control]");
    expect(within(openMenuOn(onPanel as HTMLElement)).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Reset", "Set as default", "Reset all on Lights", "Set all as default on Lights"]);
    // On its own node it carries no Panel with it, and is on exactly one: "this Panel" is that one.
    expect(controlPanelOf(runtime.bus.store.getGraph(), { nodeId: named(runtime, "slider_lamp").id })?.label).toBe("panel_lights");
    // On no Panel at all there is no "this Panel".
    expect(controlPanelOf(runtime.bus.store.getGraph(), { nodeId: "nobody" })).toBeNull();
  });
});

describe("T1619b — a right-click, or a control-click, never moves the control it opens the menu on", () => {
  it("a right press and a control-click on a slider write nothing; a plain press still does", async () => {
    const writes: unknown[] = [];
    const view = render(<ControlWidget nodeId="n" type="slider" parameters={{ value: 0.2, min: 0, max: 1, defaultValue: 0.2 }} write={(_id, entries) => writes.push(entries)} size="board" />);
    const track = view.container.querySelector<HTMLElement>('[role="slider"]') as HTMLElement;
    track.setPointerCapture = () => undefined;
    track.hasPointerCapture = () => false;
    fireEvent.pointerDown(track, { button: 2, clientX: 50, pointerId: 1 });
    fireEvent.pointerDown(track, { button: 0, ctrlKey: true, clientX: 50, pointerId: 1 });
    expect(writes).toEqual([]);
    fireEvent.pointerDown(track, { button: 0, clientX: 50, pointerId: 1 });
    expect(writes).toHaveLength(1);
  });
});

describe("T1619b — reset all, in the Controls tab's header", () => {
  const trigger = (): HTMLElement => document.querySelector("[data-reset-all]") as HTMLElement;

  it("counts what is away on the shown Panel, says so, and its ONE button resets the Panel in one patch that one undo takes back", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    // Robot: the slider and the toggle are away; the pad is at its default.
    expect(trigger().getAttribute("data-reset-all")).toBe("2");
    await act(async () => {
      fireEvent.click(trigger());
    });
    expect(document.querySelector("[data-reset-sentence]")?.textContent).toBe("Robot: 2 of 5 controls are away from their defaults. 1 control has no default yet.");

    const revision = runtime.bus.store.getRevision();
    const ran = watch(runtime);
    await act(async () => {
      fireEvent.click(document.querySelector("[data-reset-confirm]") as HTMLElement);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ran).toEqual([{ command: "control.reset", input: { nodeIds: [named(runtime, "panel_robot").id] } }]);
    expect([stored(runtime, "slider_heat", "value"), stored(runtime, "toggle_perch", "on")]).toEqual([1, false]);
    expect(runtime.bus.store.getRevision()).toBe(revision + 1);
    expect(stored(runtime, "slider_lamp", "value")).toBe(0.1);
    expect(trigger().getAttribute("data-reset-all")).toBe("0");

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect([stored(runtime, "slider_heat", "value"), stored(runtime, "toggle_perch", "on")]).toEqual([1.7, true]);
    expect(trigger().getAttribute("data-reset-all")).toBe("2");
  });

  it("with nothing away the button in the popover is off, and says there is nothing to reset", async () => {
    const runtime = await desk();
    await runtime.bus.execute("control.resetAll", {}, runtime.invocation);
    render(<Desk runtime={runtime} />);
    await act(async () => {
      fireEvent.click(trigger());
    });
    const confirm = document.querySelector("[data-reset-confirm]") as HTMLButtonElement;
    expect([confirm.disabled, confirm.textContent]).toEqual([true, "Nothing to reset"]);
  });
});

describe("T1619b — Set all as default, where the board is arranged", () => {
  it("the edit toolbar's button runs ONE command naming the Panel: every value stays, and becomes what a reset returns to", async () => {
    const runtime = await desk();
    render(<Desk runtime={runtime} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit board" }));
    });
    const revision = runtime.bus.store.getRevision();
    const ran = watch(runtime);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set all as default" }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ran).toEqual([{ command: "control.setDefault", input: { nodeIds: [named(runtime, "panel_robot").id] } }]);
    expect(runtime.bus.store.getRevision()).toBe(revision + 1);
    // Nothing moved; the slider's and the toggle's defaults did, and the default-less slider has one.
    expect([stored(runtime, "slider_heat", "value"), stored(runtime, "slider_heat", "defaultValue")]).toEqual([1.7, 1.7]);
    expect([stored(runtime, "toggle_perch", "on"), stored(runtime, "toggle_perch", "defaultOn")]).toEqual([true, true]);
    expect(stored(runtime, "slider_gain", "defaultValue")).toBe(7);
    // The other Panel's control was not asked.
    expect(stored(runtime, "slider_lamp", "defaultValue")).toBe(0.8);
    // Nothing left to set: the button greys.
    expect((screen.getByRole("button", { name: "Set all as default" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("T1619b — the tally and its sentence", () => {
  it("counts Sliders, Toggles and XY Pads; a Button counts for nothing, a control with no default is neither at nor away", () => {
    expect(
      tallyDefaults([
        node("a", "slider", "slider_a", { value: 0.9, defaultValue: 0.2 }),
        node("b", "slider", "slider_b", { value: 0.2, defaultValue: 0.2 }),
        node("c", "toggle", "toggle_c", { on: true }),
        node("d", "button", "button_d", {}),
      ]),
    ).toEqual({ total: 3, away: 1, missing: 1 });
  });

  it("says what a reset would move, in the singular and the plural, and when there is nothing to move", () => {
    expect(resetAllSentence("Robot", { total: 14, away: 7, missing: 0 })).toBe("Robot: 7 of 14 controls are away from their defaults.");
    expect(resetAllSentence("Robot", { total: 1, away: 1, missing: 0 })).toBe("Robot: 1 of 1 control is away from its default.");
    expect(resetAllSentence("Robot", { total: 3, away: 0, missing: 2 })).toBe("Robot: every control is at its default. 2 controls have no default yet.");
    expect(resetAllSentence("Robot", { total: 0, away: 0, missing: 0 })).toBe("Robot has no control that holds a default.");
  });
});
