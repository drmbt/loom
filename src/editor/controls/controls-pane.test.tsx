// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { componentNodeType } from "@domain/components/index.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { expressionSlot } from "@/examples/documents/builders.ts";
import { ANALYSIS_COMPONENT_ID, analysisComponentDefinition } from "../../tests/fixtures/analysis-component.ts";
import { isParameterSlot, withMode } from "@domain/parameters/slots.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { PhoneDoorView } from "./phone-door-copy.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { ControlsPane } from "./controls-pane.tsx";
import surface from "./panel-surface.module.css";

/**
 * T1388b — the controls pane drives the DOCUMENT, not a copy: a Panel lays its widgets out
 * under headings, and dragging a slider there writes the slider node's value through the bus.
 *
 * T1513b — and it shows what a person needs to read at a glance: a toggle's On/Off, a
 * button that is visibly held and counts its presses, what each control drives as chips
 * that can be let go of, in a grid that uses the pane's width.
 */
const phoneRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./phone-door.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./phone-door.tsx")>();
  return {
    ...original,
    PhoneDoorButton: (props: Parameters<typeof original.PhoneDoorButton>[0]) => {
      phoneRenders.count += 1;
      return original.PhoneDoorButton(props);
    },
  };
});
beforeAll(installDomStubs);
afterEach(cleanup);

async function runtimeWith(): Promise<AppRuntime> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        { op: "addNode", ref: "node:fader", type: "slider", position: { x: 0, y: 0 }, label: "fader1", parameters: { channel: "heat", value: 0.25, min: 0, max: 1 } },
        { op: "addNode", ref: "node:strobe", type: "toggle", position: { x: 0, y: 0 }, label: "toggle1", parameters: { channel: "strobe", caption: "Invert" } },
        { op: "addNode", ref: "node:cut", type: "button", position: { x: 0, y: 0 }, label: "button1", parameters: { channel: "cut", caption: "Next hue", presses: 3 } },
        { op: "addNode", ref: "node:panel", type: "panel", position: { x: 0, y: 200 }, label: "panel1", parameters: { title: "Furnace", layout: "# Melt\nfader1 toggle1 button1" } },
        {
          op: "addNode",
          ref: "node:blur",
          type: "blur",
          position: { x: 300, y: 0 },
          label: "blur1",
          parameters: {
            size: { mode: "expression", bindings: { static: { kind: "static", value: 7 }, expression: { kind: "expression", source: "op('fader1').chan.heat * 10" } } },
          },
        },
      ],
    } as never,
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return runtime;
}

function Pane({ runtime }: { runtime: AppRuntime }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} />;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const node = (runtime: AppRuntime, label: string) => Object.values(runtime.bus.store.getGraph().nodes).find((each) => each.label === label)!;

describe("T1388b — the controls pane", () => {
  it("uses one inventory pass per nodes revision, no pass for edge revisions, and keeps the empty phone surface quiet", () => {
    const runtime = createAppRuntime({ identityStorage: null });
    let scans = 0;
    const counted = (nodes: GraphDocument["nodes"]) => new Proxy(nodes, {
      ownKeys(target) {
        scans += 1;
        return Reflect.ownKeys(target);
      },
    });
    let graph: GraphDocument = {
      revision: 1,
      nodes: counted({ solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} } }),
      edges: {},
      groups: {},
    };
    let phone: PhoneDoorView = {
      state: null, pending: false, publishedPanels: 0, refusal: null,
      awaitingHelper: false, open: vi.fn(), close: vi.fn(), dismissRefusal: vi.fn(),
    };
    const draw = () => <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} phone={phone} />;
    const view = render(draw());
    expect(scans).toBe(1);
    const mounted = phoneRenders.count;
    expect(mounted).toBeGreaterThan(0);

    for (let edit = 0; edit < 60; edit++) {
      graph = { ...graph, revision: graph.revision + 1, nodes: counted({ solid: { ...graph.nodes["solid"]!, parameters: { color: [edit / 60, 0, 0, 1] } } }) };
      view.rerender(draw());
    }
    expect(scans).toBe(61);
    expect(phoneRenders.count).toBe(mounted);
    expect(screen.getByText("No controls")).toBeDefined();

    for (let edit = 0; edit < 60; edit++) {
      graph = { ...graph, revision: graph.revision + 1, edges: {} };
      view.rerender(draw());
    }
    expect(scans).toBe(61);
    expect(phoneRenders.count).toBe(mounted);

    phone = { ...phone, pending: true };
    view.rerender(draw());
    expect(phoneRenders.count).toBe(mounted + 1);
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    expect(screen.getByText("Opening…")).toBeDefined();

    graph = {
      ...graph, revision: graph.revision + 1,
      nodes: { ...graph.nodes, fader: { id: "fader", type: "slider", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { channel: "gain", value: 0.5 } } },
    };
    view.rerender(draw());
    expect(screen.queryByText("No controls")).toBeNull();
    expect(screen.getByRole("slider", { name: "gain" })).toBeDefined();
    graph = { ...graph, revision: graph.revision + 1, nodes: { solid: graph.nodes["solid"]! } };
    view.rerender(draw());
    expect(screen.getByText("No controls")).toBeDefined();
    expect(screen.queryByRole("slider", { name: "gain" })).toBeNull();
    runtime.dispose();
  });

  it("lays the Panel out and a drag writes the slider node's value", async () => {
    const runtime = await runtimeWith();
    render(<Pane runtime={runtime} />);
    expect(screen.getByText("Furnace")).not.toBeNull();
    expect(screen.getByText("Melt")).not.toBeNull();
    const track = screen.getByRole("slider", { name: "heat" });
    track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    track.setPointerCapture = () => undefined;
    track.releasePointerCapture = () => undefined;
    track.hasPointerCapture = () => true;
    await act(async () => {
      fireEvent.pointerDown(track, { clientX: 80, clientY: 5, pointerId: 1 });
      fireEvent.pointerUp(track, { clientX: 80, clientY: 5, pointerId: 1 });
      await settle();
    });
    expect(node(runtime, "fader1").parameters["value"]).toBeCloseTo(0.8, 6);
    // Caption and value read on ONE row, above the bar — not the value on a row of its own.
    const head = track.previousElementSibling;
    expect(head?.textContent).toBe("heat0.80");
  });
});

describe("T1513b — the controls show their state", () => {
  it("reads changed target bindings and names from the current full graph while widgets remain unchanged", async () => {
    const runtime = await runtimeWith();
    render(<Pane runtime={runtime} />);
    const blur = node(runtime, "blur1");
    const fader = node(runtime, "fader1");
    const binding = blur.parameters["size"]!;
    if (!isParameterSlot(binding)) throw new Error("Expected the fixture's expression slot");
    const constant = withMode(binding, "static", 7);
    if (constant === null) throw new Error("Expected the retained static binding");
    const apply = async (operations: GraphPatchOperation[]) => {
      await act(async () => {
        const result = await runtime.bus.execute("graph.applyPatch", {
          baseRevision: runtime.bus.store.getRevision(), operations,
        }, runtime.invocation);
        expect(result.status).toBe("applied");
      });
      expect(runtime.bus.store.getGraph().nodes[fader.id]).toBe(fader);
    };
    expect(document.querySelector("[data-target='blur1.size']")).not.toBeNull();
    await apply([{ op: "setNodeLabel", nodeId: blur.id, label: "warm1" }]);
    expect(document.querySelector("[data-target='blur1.size']")).toBeNull();
    expect(document.querySelector("[data-target='warm1.size']")).not.toBeNull();
    await apply([{ op: "setParameters", nodeId: blur.id, parameters: { size: constant } }]);
    expect(document.querySelector("[data-target='warm1.size']")).toBeNull();
    await apply([{ op: "setParameters", nodeId: blur.id, parameters: { size: binding } }]);
    expect(document.querySelector("[data-target='warm1.size']")).not.toBeNull();
    runtime.dispose();
  });

  it("a toggle is a switch that says whether it is on, and pressing it flips the node", async () => {
    const runtime = await runtimeWith();
    render(<Pane runtime={runtime} />);
    const toggle = screen.getByRole("switch", { name: /Invert/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent).toContain("Off");
    await act(async () => {
      fireEvent.click(toggle);
      await settle();
    });
    expect(node(runtime, "toggle1").parameters["on"]).toBe(true);
    expect(screen.getByRole("switch", { name: /Invert/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: /Invert/ }).textContent).toContain("On");
  });

  it("a button is pressed while held, and counts its presses", async () => {
    const runtime = await runtimeWith();
    render(<Pane runtime={runtime} />);
    const button = screen.getByRole("button", { name: /Next hue/ });
    button.setPointerCapture = () => undefined;
    button.releasePointerCapture = () => undefined;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.querySelector("[data-press-count]")?.textContent).toBe("×3");
    await act(async () => {
      fireEvent.pointerDown(button, { pointerId: 1 });
      await settle();
    });
    expect(screen.getByRole("button", { name: /Next hue/ }).getAttribute("aria-pressed")).toBe("true");
    expect(node(runtime, "button1").parameters["held"]).toBe(true);
    await act(async () => {
      fireEvent.pointerUp(button, { pointerId: 1 });
      await settle();
    });
    expect(screen.getByRole("button", { name: /Next hue/ }).getAttribute("aria-pressed")).toBe("false");
    expect(node(runtime, "button1").parameters["presses"]).toBe(4);
    expect(screen.getByRole("button", { name: /Next hue/ }).querySelector("[data-press-count]")?.textContent).toBe("×4");
  });

  it("what a control drives is a chip naming it whole, and its × unbinds it back to its constant", async () => {
    const runtime = await runtimeWith();
    render(<Pane runtime={runtime} />);
    const chip = document.querySelector("[data-target='blur1.size']") as HTMLElement;
    expect(chip.textContent).toContain("blur1.size");
    expect(chip.getAttribute("title")).toBe("blur1.size");
    // No "map…" link and no truncating arrow line on a card any more.
    expect(screen.queryByText("map…")).toBeNull();
    const before = runtime.bus.store.getHistory(runtime.invocation.actor).undo.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unbind blur1.size" }));
      await settle();
    });
    const size = node(runtime, "blur1").parameters["size"] as { mode: string; bindings: { static: { value: number }; expression: { source: string } } };
    expect(size.mode).toBe("static");
    expect(size.bindings.static.value).toBe(7);
    // The expression is retained in its slot (§V108), not thrown away.
    expect(size.bindings.expression.source).toBe("op('fader1').chan.heat * 10");
    expect(runtime.bus.store.getHistory(runtime.invocation.actor).undo.length).toBe(before + 1);
    expect(document.querySelector("[data-target='blur1.size']")).toBeNull();
  });

  it("a Panel row is one grid that fills the width with as many columns as fit", async () => {
    const runtime = await runtimeWith();
    render(<Pane runtime={runtime} />);
    const row = document.querySelector("[data-controls-pane] [data-panel-row]") as HTMLElement;
    expect(row.className).toBe(surface.grid);
    expect(row.querySelectorAll("[data-control-node]")).toHaveLength(3);
    // The rule itself: auto-fill columns with a floor and an equal share of what is left.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "panel-surface.module.css"), "utf8");
    const grid = /\.grid\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\([^,]+,\s*1fr\)\)/);
  });
});

/**
 * §T1559b — A DRIVEN WIDGET SHOWS WHAT IT PUBLISHES, also when what drives it is a component
 * instance's channel.
 *
 * The pane reads a driven widget through the one read path, over the authored document (the
 * widget is an authored node). It built that read with `NO_FLATTENING`, which carries no
 * instances, so `op('analysis1').chan.level` failed there and the Slider sat on its retained
 * value, although the inspector's row for the same slot reads the flattening's instances
 * (T1485b). Everything here is real: the app runtime's flattening, the value graph over it,
 * and the pane handed that evaluation's channels and frame as `app.tsx` hands them.
 */
describe("§T1559b — a widget driven by a component instance's channel", () => {
  it("shows the value the Slider publishes, and follows it", async () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
    // `level = frame / 10` on the instance's `levels` output.
    runtime.components.register(analysisComponentDefinition("frame / 10"));
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "setup",
        operations: [
          { op: "addNode", ref: "$inst", type: componentNodeType(ANALYSIS_COMPONENT_ID, 1), position: { x: 0, y: 0 }, label: "analysis1" },
          {
            op: "addNode",
            ref: "$fader",
            type: "slider",
            position: { x: 240, y: 0 },
            label: "fader1",
            parameters: { caption: "Heat", min: 0, max: 1, value: expressionSlot("op('analysis1').chan.level", 0.25) },
          },
        ],
      } as never,
      runtime.invocation,
    );
    expect(result.output.status, JSON.stringify(result.output.diagnostics)).toBe("applied");
    // As the composition root does (`use-graph-compile.ts`): the bus reads the runtime's flattening.
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());

    const at = (frameIndex: number) => {
      const frame = { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 } as const;
      const flattened = runtime.flattened.current();
      const evaluated = createValueGraphSession(runtime.registry).evaluate(flattened.graph, frame, { flattening: flattened });
      const inputs: FrameInputs = { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [16, 16] };
      return {
        published: evaluated.byId.get(node(runtime, "fader1").id),
        pane: (
          <ControlsPane
            graph={runtime.bus.store.getGraph()}
            registry={runtime.registry}
            bus={runtime.bus}
            invocation={runtime.invocation}
            channels={evaluated.resolver}
            latestFrame={() => inputs}
          />
        ),
      };
    };

    const five = at(5);
    expect(five.published).toEqual({ value: 0.5 });
    const view = render(five.pane);
    const slider = () => screen.getByRole("slider", { name: "Heat" });
    // Read without the instances the pane shows the retained 0.25 while the Slider publishes 0.5.
    expect(slider().getAttribute("aria-valuenow")).toBe("0.5");

    // The cut-the-wire question: the instance moves, the Slider's bag moves, the display follows.
    const eight = at(8);
    expect(eight.published).toEqual({ value: 0.8 });
    view.rerender(eight.pane);
    expect(slider().getAttribute("aria-valuenow")).toBe("0.8");
    runtime.dispose();
  });
});
