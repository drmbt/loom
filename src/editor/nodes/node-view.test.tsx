// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { NodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import {
  fixtureContext,
  installFlowStubs,
  nodeProps,
  setReducedMotion,
} from "@editor/graph-canvas/testing.tsx";
import { CanvasFixture } from "@editor/graph-canvas/canvas-fixture.tsx";
import type { NodeRunStatus, NodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import { NodeView } from "./node-view.tsx";
import { STATUS_LABEL } from "./status.ts";

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
beforeEach(() => setReducedMotion(false));
afterEach(cleanup);

const invocation = contextFor(alice);

interface Options {
  graph?: GraphDocument;
  renderPreview?: (nodeId: string) => React.ReactNode;
  renderControls?: (nodeId: string) => React.ReactNode;
  /** Current canvas selection (§V101) — defaults to none. */
  selection?: readonly string[];
  /** T457: the REAL catalogue, for nodes whose behaviour keys off their true type. */
  registry?: ReturnType<NodeRegistry["view"]>;
  /** T599: spy for the "+N more" chip's door. */
  showProblems?: () => void;
  /** T602: spy for the double-click dive. */
  diveIn?: (nodeId: string) => void;
  /** T603: catalogue view for instance marks. */
  components?: unknown;
}

/**
 * Mounts one node against a real store and a real command bus, so every edit the node
 * chrome makes is exercised through the only mutation path there is (§V29).
 */
function mountNode(type: string, options: Options = {}) {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    ...(options.graph === undefined ? {} : { initialGraph: options.graph }),
  });
  const { bus } = createDomainBus({ store, registry: options.registry ?? createTestRegistry().view() });
  const dispatched: GraphPatchOperation[][] = [];
  const toggled: { command: string; nodeIds: readonly string[] }[] = [];

  const seeded = Object.keys(bus.store.getGraph().nodes)[0];
  const nodeId = seeded ?? "pending";

  const { value, runtime, timingOverlay, timingScale } = fixtureContext({
    store: bus.store,
    registry: bus.registry,
    dispatch: (operations, label) => {
      dispatched.push(operations);
      void bus.execute(
        "graph.applyPatch",
        { baseRevision: bus.store.getRevision(), operations, label },
        invocation,
      );
    },
    selection: () => (options.selection ?? []) as never,
    // Mirrors `graph-canvas.tsx`'s real `toggleUi` (§V101/§V102/§V29): a badge press
    // runs the SAME bus command the keymap and the context menu use, never a raw patch.
    toggleUi: (command, nodeIds) => {
      toggled.push({ command, nodeIds });
      void bus.execute(command, { nodeIds }, invocation);
    },
    ...(options.renderPreview === undefined ? {} : { renderPreview: options.renderPreview }),
    ...(options.renderControls === undefined ? {} : { renderControls: options.renderControls }),
    ...(options.showProblems === undefined ? {} : { showProblems: options.showProblems }),
    ...(options.diveIn === undefined ? {} : { diveIn: options.diveIn }),
    ...(options.components === undefined ? {} : { components: options.components as never }),
  });

  const view = render(
    <CanvasFixture value={value}>
      <NodeView {...nodeProps(nodeId)} />
    </CanvasFixture>,
  );

  return { ...view, bus, runtime, nodeId, dispatched, toggled, type, timingOverlay, timingScale, kindLabels: value.kindLabels };
}

function graphWith(type: string, ui?: Record<string, boolean>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      n1: {
        id: "n1",
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
        ...(ui === undefined ? {} : { ui }),
      },
    },
    edges: {},
    groups: {},
  };
}

async function publish(
  runtime: NodeRuntimeStore,
  nodeId: string,
  patch: Parameters<NodeRuntimeStore["publish"]>[1],
) {
  await act(async () => {
    runtime.publish(nodeId, patch);
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

describe("V1 — the node renders the document, not a copy of it", () => {
  it("takes its title and ports from the registered definition", () => {
    const { container } = mountNode("test.composite", { graph: graphWith("test.composite") });

    expect(screen.getByTitle("Composite")).toBeDefined();
    const rows = [...container.querySelectorAll("li[data-kind]")];
    // T695/T227 — "Layers 1", not "Layers": a variadic input renders one NUMBERED socket
    // per edge plus a spare, and here it is unwired, so the spare is the only one. The
    // index is not decoration; it is the address the user aims a replacing drop at, and a
    // socket the document orders (§V131) while the node refuses to say which one it is
    // leaves "put this behind that" unsayable.
    expect(rows.map((row) => row.textContent)).toEqual(["Layers 1", "Mask", "Out"]);
  });

  it("puts inputs on the left and outputs on the right (doc §17.2)", () => {
    const { container } = mountNode("test.blur", { graph: graphWith("test.blur") });

    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    const outputs = [...container.querySelectorAll('[data-handlepos="right"]')];
    expect(inputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["source"]);
    expect(outputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["out"]);
  });

  it("preserves an unresolved node instead of dropping it (§V10)", () => {
    const { container } = mountNode("not.installed", { graph: graphWith("not.installed") });

    const node = container.querySelector("[data-testid^='node-']");
    expect(node?.getAttribute("data-status")).toBe("error");
    expect(screen.getByText(/Unknown node type "not.installed"/)).toBeDefined();
    // No definition means no ports we could honestly draw.
    expect(container.querySelectorAll("li[data-kind]")).toHaveLength(0);
  });
});

describe("V26 — port dots carry the family colour the edges use", () => {
  it("colours every port from its own family token", () => {
    const { container } = mountNode("test.composite", { graph: graphWith("test.composite") });
    const rows = [...container.querySelectorAll("li[data-kind]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const kind = row.getAttribute("data-kind");
      expect(row.getAttribute("style")).toContain(`--port-color: var(--port-${kind})`);
    }
  });

  it("gives a differently typed port a different family token", () => {
    const { container } = mountNode("test.scalarF32", { graph: graphWith("test.scalarF32") });
    const row = container.querySelector("li[data-kind]");
    expect(row?.getAttribute("data-kind")).toBe("scalar");
    expect(row?.getAttribute("style")).toContain("var(--port-scalar)");
  });
});

describe("node status states are distinct (doc §17.2)", () => {
  const statuses: NodeRunStatus[] = [
    "idle",
    "compiling",
    "valid",
    "warning",
    "error",
    "device-lost",
  ];

  it("renders a distinguishable state for each", async () => {
    const seen = new Set<string>();
    for (const status of statuses) {
      const { container, runtime, nodeId, unmount } = mountNode("test.blur", {
        graph: graphWith("test.blur"),
      });
      await publish(runtime, nodeId, { status });

      const node = container.querySelector("[data-testid^='node-']");
      const dot = container.querySelector("[data-testid^='node-status-']");
      expect(node?.getAttribute("data-status")).toBe(status);
      const label = dot?.getAttribute("aria-label") ?? "";
      expect(label).toBe(`Status: ${STATUS_LABEL[status]}`);
      // Colour is never the only carrier of the state (§V19).
      seen.add(label);
      unmount();
    }
    expect(seen.size).toBe(statuses.length);
  });

  it("shows bypassed and muted as document state, separate from run status", () => {
    const bypassed = mountNode("test.blur", { graph: graphWith("test.blur", { bypassed: true }) });
    expect(
      bypassed.container.querySelector("[data-testid^='node-']")?.getAttribute("data-bypassed"),
    ).toBe("true");
    bypassed.unmount();

    const muted = mountNode("test.blur", { graph: graphWith("test.blur", { muted: true }) });
    expect(
      muted.container.querySelector("[data-testid^='node-']")?.getAttribute("data-muted"),
    ).toBe("true");
  });

  /**
   * B36/§V269 — the node badge no longer claims staleness, and that is the assertion.
   *
   * This test used to publish `stale: true` and check the badge lit. Nothing in the
   * product ever published that field, so the only thing setting it was this line: the
   * test supplied the wiring it was testing, which is why the dead field survived as long
   * as it did (§V220). §V9's staleness is the whole retained PROGRAM, true for every node
   * at once, so it belongs in the popup — per-node, on demand — and not on N badges.
   */
  it("does not claim staleness on the badge; the program-level fact is the popup's", () => {
    const { container } = mountNode("test.blur", { graph: graphWith("test.blur") });
    expect(container.textContent).not.toContain("stale");
  });

  it("carries the shader diagnostic badge, and shows nothing while clean (§V27)", async () => {
    const { runtime, nodeId } = mountNode("test.customWgsl", {
      graph: graphWith("test.customWgsl"),
    });
    expect(screen.queryByRole("status")).toBeNull();

    await publish(runtime, nodeId, { errorCount: 2, warningCount: 1 });
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Shader: 2 errors, 1 warnings",
    );
  });
});

describe("T1487b — an inference node's run state is said on the node", () => {
  it("shows the note in its tone, and removes it when the model has nothing to say", async () => {
    // It used to be a row in the app-wide strip, which came and went with the camera and
    // pushed the layout around. On the node it is a fact about the node.
    const { runtime, nodeId } = mountNode("test.blur", { graph: graphWith("test.blur") });
    expect(screen.queryByTestId(`node-inference-note-${nodeId}`)).toBeNull();

    await publish(runtime, nodeId, {
      inferenceNote: { tone: "info", text: "Matte ran and found nothing — check its input." },
    });
    const note = screen.getByTestId(`node-inference-note-${nodeId}`);
    expect(note.textContent).toBe("Matte ran and found nothing — check its input.");
    expect(note.getAttribute("data-tone")).toBe("info");

    await publish(runtime, nodeId, { inferenceNote: null });
    expect(screen.queryByTestId(`node-inference-note-${nodeId}`)).toBeNull();
  });
});

describe("V42 — agent activity is visible on the node it is changing", () => {
  it("names the state and the actor", async () => {
    const { runtime, nodeId } = mountNode("test.blur", { graph: graphWith("test.blur") });
    await publish(runtime, nodeId, {
      agent: { kind: "awaiting-approval", actorLabel: "Claude", detail: "wants to rewrite WGSL" },
    });

    expect(screen.getByText("awaiting approval")).toBeDefined();
    expect(screen.getByText("Claude")).toBeDefined();
    expect(screen.getByText("wants to rewrite WGSL")).toBeDefined();
  });

  it("shows nothing when no agent is involved", () => {
    const { container } = mountNode("test.blur", { graph: graphWith("test.blur") });
    expect(container.querySelector("[data-testid^='node-']")?.getAttribute("data-agent")).toBe(
      "none",
    );
  });
});

describe("V16 — metrics reach the node without touching the document", () => {
  /**
   * T1010 — the number is no longer IN the header, so this asks the node for it the way a
   * user now does: switch the overlay on, then read the floating readout. The half that
   * matters to §V16 is unchanged and is the second assertion — a per-frame number reaches
   * the view without bumping the document revision, so a metric tick is not an undo entry.
   */
  it("shows per-pass GPU time and leaves the graph revision alone", async () => {
    const { bus, runtime, nodeId, timingOverlay } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
    });
    const before = bus.store.getRevision();

    // Off by default: the readout is not merely empty, it is not mounted at all (§V836).
    expect(screen.queryByTestId(`node-timing-value-${nodeId}`)).toBeNull();
    await act(async () => {
      timingOverlay.set(true);
    });

    expect(screen.getByTestId(`node-timing-value-${nodeId}`).textContent).toBe("—");
    await publish(runtime, nodeId, { gpuMs: 3.25 });

    expect(screen.getByTestId(`node-timing-value-${nodeId}`).textContent).toBe("3.25 ms");
    expect(bus.store.getRevision()).toBe(before);
  });
});

describe("V20 — a drag on embedded node chrome never becomes a node drag", () => {
  it("opts every embedded control out of React Flow's drag and pan filters", () => {
    const { container } = mountNode("test.blur", {
      graph: graphWith("test.blur", { preview: true }),
      renderPreview: () => <div>preview</div>,
      renderControls: () => <button type="button">radius</button>,
    });

    // React Flow refuses to start a drag or a pan when the pressed element is inside
    // `.nodrag` / `.nopan`. This is that predicate, evaluated the same way.
    for (const name of ["Bypass", "Mute", "Preview"]) {
      const control = screen.getByRole("button", { name });
      expect(control.closest(".nodrag")).not.toBeNull();
      expect(control.closest(".nopan")).not.toBeNull();
    }
    expect(screen.getByText("radius").closest(".nodrag")).not.toBeNull();

    // The title bar, by contrast, must still drag the node.
    const title = container.querySelector("header");
    expect(title?.closest(".nodrag")).toBeNull();

    // T1246 (B195): so must the preview. A picture with no gesture of its own is the
    // node's body — at max zoom it is wider than the canvas and the ONLY thing under the
    // pointer, so a wrapper that opted out left nothing to drag or pan. The tile that
    // does own a gesture opts out itself (`node-preview-slot-orbit.test.tsx`, nodrag iff
    // orbitable); the wrapper decides nothing.
    expect(screen.getByText("preview").closest(".nodrag")).toBeNull();
    expect(screen.getByText("preview").closest(".nopan")).toBeNull();
  });

  it("swallows the press so an ancestor drag handler never sees it", () => {
    const ancestor = vi.fn();
    const store = createGraphStore({ initialGraph: graphWith("test.blur") });
    const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
    const { value } = fixtureContext({ store: bus.store, registry: bus.registry });

    render(
      <CanvasFixture value={value}>
        <div onPointerDown={ancestor} onMouseDown={ancestor}>
          <NodeView {...nodeProps("n1")} />
        </div>
      </CanvasFixture>,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "Bypass" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Bypass" }));
    expect(ancestor).not.toHaveBeenCalled();

    // A press on the node body itself still reaches the ancestor — otherwise dragging
    // a node would be broken, which is the opposite failure.
    fireEvent.mouseDown(screen.getByTitle("Blur"));
    expect(ancestor).toHaveBeenCalled();
  });
});

describe("V29/V101/V102 — node badges run the same bus command as the keymap and the menu", () => {
  it("bypasses and un-bypasses through node.toggleBypass, never a raw patch", async () => {
    const { bus, dispatched, toggled } = mountNode("test.blur", { graph: graphWith("test.blur") });

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(true);
    });
    expect(toggled).toEqual([{ command: "node.toggleBypass", nodeIds: ["n1"] }]);
    // The badge never falls back to a raw `setNodeUi` patch (§V29, §V101).
    expect(dispatched).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(false);
    });
  });

  it("mutes through the bus too, and reflects the document back", async () => {
    const { bus } = mountNode("test.blur", { graph: graphWith("test.blur") });

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.muted).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Mute" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("targets this node alone when it is not part of the current selection (§V101)", async () => {
    const { bus, toggled } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      selection: ["some-other-node"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(true);
    });
    expect(toggled).toEqual([{ command: "node.toggleBypass", nodeIds: ["n1"] }]);
  });

  it("targets the whole selection when this node is part of it (§V101, §V102)", async () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        n1: { id: "n1", type: "test.blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        n2: { id: "n2", type: "test.blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ui: { bypassed: true } },
      },
      edges: {},
      groups: {},
    };
    const { bus, toggled } = mountNode("test.blur", { graph, selection: ["n1", "n2"] });

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      // A mixed selection (n2 already bypassed, n1 not) becomes uniformly ON — never
      // each node flipping independently, which would keep it mixed forever (§V102).
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(true);
      expect(bus.store.getGraph().nodes["n2"]?.ui?.bypassed).toBe(true);
    });
    expect(toggled).toEqual([{ command: "node.toggleBypass", nodeIds: ["n1", "n2"] }]);
  });
});

describe("preview slot (§V28b) — visible texture-producing node previews by default", () => {
  it("shows by default for a texture-producing node, before any pin is set", () => {
    const { container } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      renderPreview: () => <div>tile</div>,
    });
    expect(container.querySelector("[data-testid^='node-preview-']")).not.toBeNull();
    expect(screen.getByText("tile")).toBeDefined();
  });

  it("gives a VALUE node a slot too, because a signal is content (T344)", () => {
    // The rule used to be "texture output or nothing", which left the half of the graph
    // that MOVES as the half nobody could see: an LFO, a Lag and a Mouse all rendered an
    // empty box and all looked inert. A value node's channel is its output in exactly the
    // sense a texture is, so it gets the same slot and the composition root decides what
    // goes in it. T438: the slot keys on the DECLARED channel (`publishesValueChannels`),
    // so the real LFO is mounted — a fixture whose only claim was its category string is
    // exactly the shape T438 retired.
    const { container } = mountNode("lfo", {
      graph: graphWith("lfo"),
      registry: createNodeRegistry(allNodeDefinitions).view(),
      renderPreview: () => <div>plot</div>,
    });
    expect(container.querySelector("[data-testid^='node-preview-']")).not.toBeNull();
  });

  it("has no slot for a node type this build does not have (§V10)", () => {
    // An unknown-type placeholder produces neither pixels nor a channel, so there is
    // nothing to show — which is what keeps the widened gate from meaning "always".
    const { container } = mountNode("test.notInThisBuild", {
      graph: graphWith("test.notInThisBuild"),
      renderPreview: () => <div>tile</div>,
    });
    expect(container.querySelector("[data-testid^='node-preview-']")).toBeNull();
  });

  /**
   * T353/§V297 — `P` is the SWITCH, and it starts pressed.
   *
   * It used to toggle the pin, so the owner pressed it and nothing they could see
   * changed: previews were on either way, and the button reported a state nobody could
   * observe. The first press must now turn the preview OFF, which means the button has to
   * read an absent flag as ON — an untouched node is previewing.
   */
  it("'P' starts on, and one press writes preview: false", async () => {
    const { bus } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      renderPreview: () => <div>tile</div>,
    });
    expect(bus.store.getGraph().nodes["n1"]?.ui?.preview).toBeUndefined();
    const button = screen.getByRole("button", { name: "Preview" });
    // Default ON, stated in the accessibility tree and not only in the pixels.
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.preview).toBe(false);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("false");
    });
    // The SLOT survives: a switched-off preview says so in its body (§V91/§V100) rather
    // than the node changing shape under the press.
    expect(screen.getByText("tile")).toBeDefined();
  });
});

describe("T457 (V387) — reference-fed inputs render NO socket", () => {
  const catalogue = createNodeRegistry(allNodeDefinitions).view();

  it("a render node's only socket is the one REAL wire — every name is invisible", () => {
    const { container } = mountNode("render", { graph: graphWith("render"), registry: catalogue });
    // scenes/camera/lights are reference-fed plumbing: a socket there invites a wire
    // that apply-patch refuses (port.sourceReference), so none is drawn. The
    // environment (T482) is a genuine texture wire — pixels are data (V372) — and its
    // socket is exactly what remains.
    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    expect(inputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["environment"]);
    // The output sockets are real and stay. `depth` (T722) is conditional — it
    // ALLOCATES nothing until the Depth Output switch is on (`outputWhen`) — but its
    // socket is always drawn: hiding it would make the port undiscoverable, and a wire
    // into it while the switch is off reports as an ordinary missing-resource
    // diagnostic that names the switch.
    const outputs = [...container.querySelectorAll('[data-handlepos="right"]')];
    // T1371b/T1380b: `normal` and `albedo` are conditional the same way (Normal Output,
    // Albedo Output), drawn for the same reason. T1417b/T1414b: so are `lightDepth` (Light
    // Depth Output) and `shadow` (Shadow Output).
    expect(outputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["out", "depth", "normal", "albedo", "lightDepth", "shadow"]);
  });

  it("a wireable input on the same node keeps its socket (renderSurface: points yes, camera no)", () => {
    const { container } = mountNode("renderSurface", {
      graph: graphWith("renderSurface"),
      registry: catalogue,
    });
    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    expect(inputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["points"]);
  });

  it("feedback's in port is plumbing too — the loop is a NAME (T350)", () => {
    const { container } = mountNode("feedback", { graph: graphWith("feedback"), registry: catalogue });
    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    expect(inputs).toEqual([]);
  });

  it("B233: a reference input that ALSO takes a wire draws its socket (Layer's picture, Window Out's input)", () => {
    // §V387's rule is "a socket exactly where a wire is accepted". These two are named
    // AND wired (ruling 11, §T1391b); with no socket there was nothing to drop on and
    // React Flow could not draw an edge the document already held.
    const socketsOf = (type: string) =>
      [...mountNode(type, { graph: graphWith(type), registry: catalogue }).container.querySelectorAll('[data-handlepos="left"]')].map(
        (handle) => handle.getAttribute("data-handleid"),
      );
    expect(socketsOf("layer")).toEqual(["below", "picture"]);
    cleanup();
    expect(socketsOf("window")).toEqual(["input"]);
  });
});

describe("T462 (§V85) — a scene payload node owns a preview slot", () => {
  /**
   * T532 replaced this case's last clause. It used to end "and geometry deliberately does
   * not", and that decision is what left the geometry node with nothing to show: the
   * compiler had no variant for it AND this slot, the candidate list and the layout model
   * had all never heard of `scene`, so writing one variant alone would have changed
   * nothing on screen — B65 verbatim.
   */
  it("every previewable payload kind renders the slot, geometry included (T532)", () => {
    const catalogue = createNodeRegistry(allNodeDefinitions).view();
    for (const type of ["camera", "light", "materialPhong", "geometry"]) {
      const { container, unmount } = mountNode(type, {
        graph: graphWith(type),
        registry: catalogue,
        renderPreview: () => <div>tile</div>,
      });
      // B65's lesson asserted on the DISPLAY side this time: no slot div means no
      // bounds, no sink, no target — the whole pipeline with its last millimetre gone.
      expect(container.querySelector("[data-testid^='node-preview-']"), type).not.toBeNull();
      unmount();
    }
    // NO NEGATIVE CONTROL, and that is a measurement rather than an omission: every
    // definition in the shipped catalogue now produces a texture, a pointset, a scene
    // payload or a channel, or is a declared sink, so no real node is one (the same
    // finding `pointset-preview-slot.test.tsx` records). Sensitivity is proven the other
    // way instead — drop `scene` from `PREVIEWABLE_PORT_KINDS` and the geometry case
    // here goes red, along with the compiler sweep and the layout model's agreement gate.
  });
});

describe("T599 — a node with more diagnostics than its one line owns a door to the rest", () => {
  it("shows an honest '+N more' that fronts the problems pane, and only when there IS more", async () => {
    const opened: number[] = [];
    const { runtime, nodeId, container } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      showProblems: () => opened.push(1),
    });

    // One diagnostic: the message line suffices, no chip.
    await publish(runtime, nodeId, {
      status: "error",
      errorCount: 1,
      warningCount: 0,
      message: 'Node "blur1" broke.',
    });
    expect(container.textContent).not.toContain("more");

    // Five diagnostics: one message line, four unreachable — the chip is the door.
    await publish(runtime, nodeId, {
      status: "error",
      errorCount: 2,
      warningCount: 3,
      message: 'Node "blur1" broke.',
    });
    const chip = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("+4 more"),
    );
    expect(chip).toBeDefined();
    fireEvent.click(chip as HTMLButtonElement);
    expect(opened).toHaveLength(1);
    // `nodrag`: the click is a click, never the start of a node drag (§V20).
    expect(chip?.className).toContain("nodrag");
  });
});

describe("T607 — a component boundary node wears its dangling lead", () => {
  it.each([
    ["componentIn", "in"],
    ["componentOut", "out"],
    ["componentInPoints", "in"],
    ["componentOutPoints", "out"],
  ])("%s carries data-boundary=%s for the CSS lead", (type, side) => {
    const { nodeId, container } = mountNode(type, {
      graph: graphWith(type),
      registry: createNodeRegistry(allNodeDefinitions).view(),
    });
    const element = container.querySelector(`[data-testid="node-${nodeId}"]`);
    expect(element?.getAttribute("data-boundary")).toBe(side);
  });

  it("an ordinary node carries no boundary attribute — the lead is not a default", () => {
    const { nodeId, container } = mountNode("blur", {
      graph: graphWith("blur"),
      registry: createNodeRegistry(allNodeDefinitions).view(),
    });
    expect(
      container.querySelector(`[data-testid="node-${nodeId}"]`)?.hasAttribute("data-boundary"),
    ).toBe(false);
  });
});

describe("T602 — double-click enters a component instance, and only an instance", () => {
  it("runs diveIn for an instance; a plain node's double-click stays plain; the title still renames", () => {
    const dived: string[] = [];
    const { nodeId, container } = mountNode("component:fx@1", {
      graph: graphWith("component:fx@1"),
      diveIn: (id) => dived.push(id),
    });
    const element = container.querySelector(`[data-testid="node-${nodeId}"]`);
    fireEvent.doubleClick(element as Element);
    expect(dived).toEqual([nodeId]);

    // The TITLE keeps rename: its double-click must not also dive. (An UNRESOLVED
    // instance type still renders the name span; match it by its displayed text.)
    const title = [...container.querySelectorAll("header span")].find(
      (span) => span.textContent !== null && span.textContent.length > 0 && span.getAttribute("title") !== null,
    );
    if (title !== undefined) {
      fireEvent.doubleClick(title);
      expect(dived).toHaveLength(1);
    }

    const plain = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      diveIn: (id) => dived.push(id),
    });
    fireEvent.doubleClick(
      plain.container.querySelector(`[data-testid="node-${plain.nodeId}"]`) as Element,
    );
    expect(dived).toHaveLength(1);
  });
});

describe("T603 — a component instance reads as one at a glance", () => {
  it("carries the structural mark, and the chip states linked + pinned version + upgrade", async () => {
    const { createComponentSystem } = await import("@domain/components/index.ts");
    const definitionOf = (version: number) =>
      ({
        componentId: "fx",
        version,
        name: "FX",
        graph: {
          revision: 1,
          nodes: { inner: { id: "inner", type: "test.solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} } },
          edges: {},
          groups: {},
        },
        inputs: [],
        outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
        parameters: [],
      }) as never;
    const system = createComponentSystem(createTestRegistry().view(), [definitionOf(1)]);

    const pinned = mountNode("component:fx@1", {
      graph: graphWith("component:fx@1"),
      registry: system.nodes,
      components: system.components.view(),
    });
    const element = pinned.container.querySelector(`[data-testid="node-${pinned.nodeId}"]`);
    expect(element?.hasAttribute("data-component")).toBe(true);
    const chip = pinned.container.querySelector(`[data-testid="node-component-${pinned.nodeId}"]`);
    expect(chip?.textContent).toBe("v1");
    expect(chip?.getAttribute("data-upgrade")).toBe("false");

    // A newer version registers: the SAME node now states the available upgrade.
    system.components.register(definitionOf(2));
    const behind = mountNode("component:fx@1", {
      graph: graphWith("component:fx@1"),
      registry: system.nodes,
      components: system.components.view(),
    });
    const upgraded = behind.container.querySelector(`[data-testid="node-component-${behind.nodeId}"]`);
    expect(upgraded?.textContent).toBe("v1\u21922");
    expect(upgraded?.getAttribute("data-upgrade")).toBe("true");

    // A plain node wears none of it — the treatment is identity, not decoration.
    const plain = mountNode("test.blur", { graph: graphWith("test.blur") });
    expect(
      plain.container.querySelector(`[data-testid="node-${plain.nodeId}"]`)?.hasAttribute("data-component"),
    ).toBe(false);
    expect(plain.container.querySelector(`[data-testid="node-component-${plain.nodeId}"]`)).toBeNull();
  });
});

/**
 * T1593b (ruled 2026-10-05) — A LONG NAME AT REST GIVES UP ITS KIND FIRST.
 *
 * `camerablur_the_quick_brown_fox` cut at the end reads `camerablur_the…`: the kind whole
 * and the role, the word a person chose, gone. The header draws the two parts separately so
 * the kind can be the one that elides (`cam…_the_quick_brown`).
 *
 * jsdom lays nothing out, so WHICH part elides is not asserted here; it was read from a real
 * browser (docs/node-naming-2026-10-05.md). What is held here is what makes that possible
 * and what must not change: the name is in parts only when it has both, the join is its own
 * part, and the element still says the whole name to a test, a screen reader and a hover.
 */
describe("T1593b — a name at rest is drawn as its kind and its role", () => {
  const nameOf = (container: HTMLElement, nodeId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="node-name-${nodeId}"]`);
  const withLabel = (type: string, label?: string): GraphDocument => {
    const graph = graphWith(type);
    if (label !== undefined) (graph.nodes["n1"] as { label?: string }).label = label;
    return graph;
  };
  const partsOf = (element: HTMLElement | null) => [...(element?.children ?? [])].map((part) => part.textContent);

  it("splits a name that carries its kind and a role into kind, join and role", () => {
    const { container, nodeId } = mountNode("test.composite", { graph: withLabel("test.composite", "composite_lower_third") });
    const name = nameOf(container, nodeId);
    expect(partsOf(name)).toEqual(["composite", "_", "lower_third"]);
  });

  it("still says the whole name: as its text, and on hover", () => {
    const { container, nodeId } = mountNode("test.composite", { graph: withLabel("test.composite", "composite_lower_third") });
    const name = nameOf(container, nodeId);
    expect(name?.textContent).toBe("composite_lower_third");
    expect(name?.getAttribute("title")).toBe("composite_lower_third");
  });

  it("leaves an auto-name whole: it has no role to protect", () => {
    const { container, nodeId } = mountNode("test.composite", { graph: withLabel("test.composite", "composite1") });
    expect(partsOf(nameOf(container, nodeId))).toEqual([]);
    expect(nameOf(container, nodeId)?.textContent).toBe("composite1");
  });

  it("leaves a name without its kind whole: there is no kind to elide", () => {
    const { container, nodeId } = mountNode("test.composite", { graph: withLabel("test.composite", "lower_third") });
    expect(partsOf(nameOf(container, nodeId))).toEqual([]);
    expect(nameOf(container, nodeId)?.textContent).toBe("lower_third");
  });

  it("leaves an unnamed node's title whole", () => {
    const { container, nodeId } = mountNode("test.composite", { graph: withLabel("test.composite") });
    expect(partsOf(nameOf(container, nodeId))).toEqual([]);
  });

  /*
   * A kind of four letters or fewer is already as short as an elided one (`cam…`), so it
   * is marked not to give way.
   *
   * The mark used to be all that kept the elision floor from holding a short kind's box
   * open and drawing a gap inside `lfo_pathx`. It guessed a width from a letter count, and
   * `slider_master` (six letters, narrower than the floor) got the gap anyway (B258). The
   * floor itself can no longer exceed the word; that is a measurement, and it is taken in
   * a real browser (`kind-label.spec.ts`).
   */
  it("marks a short kind so it never elides, and a long one so it can", () => {
    const short = mountNode("test.blur", { graph: withLabel("test.blur", "blur_diffuse") });
    expect(nameOf(short.container, short.nodeId)?.firstElementChild?.getAttribute("data-short")).toBe("true");
    cleanup();
    const long = mountNode("test.composite", { graph: withLabel("test.composite", "composite_lower_third") });
    expect(nameOf(long.container, long.nodeId)?.firstElementChild?.getAttribute("data-short")).toBe("false");
  });
});

/**
 * T1597b — THE NODE'S HALF OF THE LOW-ZOOM KIND LABEL.
 *
 * `kind-label.test.tsx` holds what the label says at each zoom and what a zoom costs. What
 * is held here is that a real node RENDERS the label from its type and its name, and that
 * its label is the element its canvas's registry writes to: the two halves were built
 * separately, and a label nothing tells the zoom would sit at `scale(1)` under a canvas at
 * 15 %, which is the bug with a feature's name on it (§V220).
 */
describe("T1597b — a node carries its kind for low zoom", () => {
  const labelOf = (container: HTMLElement, nodeId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="node-kind-label-${nodeId}"]`);
  const named = (type: string, label?: string): GraphDocument => {
    const graph = graphWith(type);
    if (label !== undefined) (graph.nodes["n1"] as { label?: string }).label = label;
    return graph;
  };

  it("says its kind and then its role, split where the kind ends", () => {
    const { container, nodeId } = mountNode("test.blur", { graph: named("test.blur", "blur_diffuse") });
    const label = labelOf(container, nodeId);
    expect([...(label?.children ?? [])].map((part) => part.textContent)).toEqual(["blur", "_diffuse"]);
    expect(label?.children[1]?.getAttribute("data-joined")).toBe("true");
  });

  it("says the kind FIRST for a name that does not carry it, and leaves the name whole", () => {
    const { container, nodeId } = mountNode("test.blur", { graph: named("test.blur", "dye1") });
    const label = labelOf(container, nodeId);
    expect([...(label?.children ?? [])].map((part) => part.textContent)).toEqual(["blur", "dye1"]);
    expect(label?.children[1]?.getAttribute("data-joined")).toBe("false");
  });

  it("is the kind alone on an unnamed node", () => {
    const { container, nodeId } = mountNode("test.blur", { graph: named("test.blur") });
    expect([...(labelOf(container, nodeId)?.children ?? [])].map((part) => part.textContent)).toEqual(["blur"]);
  });

  it("is hidden from a screen reader: it repeats the name beside it", () => {
    const { container, nodeId } = mountNode("test.blur", { graph: named("test.blur", "blur_diffuse") });
    expect(labelOf(container, nodeId)?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  /*
   * The label is the one element its canvas writes the zoom on, and it sits in a clip box
   * that is NOT written to: the clip is what keeps it to its node's width and above the
   * line under the header (B258), and it must not depend on the zoom or every zoom step
   * lays it out again (measured, `kind-label.ts`).
   */
  it("sits inside a clip box of its own, which the canvas never writes to", () => {
    const { container, nodeId, kindLabels } = mountNode("test.blur", { graph: named("test.blur", "blur_diffuse") });
    const label = labelOf(container, nodeId) as HTMLElement;
    const clip = label.parentElement as HTMLElement;
    expect(clip.parentElement?.getAttribute("data-testid")).toBe(`node-${nodeId}`);

    kindLabels.attach(container);
    kindLabels.apply(0.2);

    expect(label.style.getPropertyValue("--kind-label-zoom")).toBe("0.2");
    expect(clip.getAttribute("style")).toBeNull();
  });

  it("is the element its canvas tells the zoom, and is forgotten when the node unmounts", () => {
    const { container, nodeId, kindLabels, unmount } = mountNode("test.blur", { graph: named("test.blur", "blur_diffuse") });
    const label = labelOf(container, nodeId) as HTMLElement;
    kindLabels.attach(container);

    kindLabels.apply(0.35);
    expect(label.style.getPropertyValue("--kind-label-zoom")).toBe("0.35");
    expect(container.getAttribute("data-kind-labels")).toBe("kind");

    unmount();
    kindLabels.apply(0.2);
    expect(label.style.getPropertyValue("--kind-label-zoom")).toBe("0.35");
  });

  it("is not drawn for a node whose type is not installed: it has no kind", () => {
    const { container, nodeId } = mountNode("vendor.missing", { graph: named("vendor.missing", "ghost1") });
    expect(labelOf(container, nodeId)).toBeNull();
  });
});

/**
 * T639(d)/T640, AS T1593b LEAVES IT.
 *
 * The bug T640 fixed: an instance showed its component's name AS its name, and the type
 * chip beside it said that name again ("animated  animated"). The fix was to make the chip
 * the literal word "component".
 *
 * T1593b (ruled 2026-10-05) makes the component's own name the instance's KIND, so the
 * same bug is now prevented at the other end, and the chip is free to say what it exists
 * to say:
 *
 *  - the name is never repeated: no chip when the name carries the kind, and none on an
 *    unnamed instance, whose shown name IS the component's name;
 *  - when a rename has taken the kind out of the name (`holo1` on Depth Points), the chip
 *    gives it back, as it does for a Blur renamed `Bloom pass`: it reads `Depth Points`,
 *    which is the kind. The word "component" would not say what kind of thing it is.
 *
 * That the node is a component at all is carried by the version chip (and the stacked
 * card), which every case below asserts is still there.
 */
describe("T639(d)/T640 — an instance never repeats its component's name, and the type chip names its kind", () => {
  async function mountInstance(componentName: string, label?: string) {
    const { createComponentSystem } = await import("@domain/components/index.ts");
    const system = createComponentSystem(createTestRegistry().view(), [
      {
        componentId: "cmp_7",
        version: 1,
        name: componentName,
        graph: {
          revision: 1,
          nodes: { inner: { id: "inner", type: "test.solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} } },
          edges: {},
          groups: {},
        },
        inputs: [],
        outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
        parameters: [],
      } as never,
    ]);
    const graph = graphWith("component:cmp_7@1");
    if (label !== undefined) (graph.nodes["n1"] as { label?: string }).label = label;
    const mounted = mountNode("component:cmp_7@1", { graph, registry: system.nodes, components: system.components.view() });
    const { container, nodeId } = mounted;
    return {
      name: container.querySelector(`[data-testid="node-name-${nodeId}"]`)?.textContent,
      type: container.querySelector(`[data-testid="node-type-${nodeId}"]`)?.textContent ?? null,
      isComponent: container.querySelector(`[data-testid="node-component-${nodeId}"]`) !== null,
    };
  }

  it("shows an unnamed instance's component name once: as its name, with no chip repeating it", async () => {
    // The owner's own case ("animated"), and the usual one, where the name has a capital.
    expect(await mountInstance("animated")).toEqual({ name: "animated", type: null, isComponent: true });
    cleanup();
    expect(await mountInstance("Bloom")).toEqual({ name: "Bloom", type: null, isComponent: true });
  });

  it("shows no chip while the name carries the component's name as its kind", async () => {
    expect(await mountInstance("Depth Points", "depthpoints1")).toEqual({ name: "depthpoints1", type: null, isComponent: true });
    cleanup();
    expect(await mountInstance("Depth Points", "depthpoints_holo")).toEqual({ name: "depthpoints_holo", type: null, isComponent: true });
  });

  it("names the component in the chip once a rename has taken the kind out of the name", async () => {
    expect(await mountInstance("Depth Points", "holo1")).toEqual({ name: "holo1", type: "Depth Points", isComponent: true });
  });
});


/**
 * T924(2) / T919 — A RE-RENDER THAT MOVED NOTHING MUST NOT ASK THE BROWSER WHERE ANYTHING IS.
 *
 * `useHandleBoundsInSync` used to be a `useLayoutEffect` with no dependency array, running
 * after EVERY render of this component and reading `getBoundingClientRect()` on the node and
 * on every one of its handles — inside React Flow's transformed subtree, immediately after
 * React had mutated the DOM. T919 measured the bill on E34-Lidar (44 nodes, 102 handles):
 * 1,900 forced-layout reads a second, against 150 on the cheap example, and essentially all
 * of them were paid for the 10 Hz preview repaint that T924(1) removed.
 *
 * This asserts the property that measurement named — layout reads per re-render — rather
 * than the shape of the fix, because the shape may change again and the number is the point.
 * `gpuMs` is the cleanest case there is: it is a per-frame READOUT on a fixed-height header
 * row (§V16), so it re-renders the node and cannot move a socket by construction.
 *
 * It mounts the node inside a `.react-flow__node` wrapper, which `mountNode` above does not:
 * the hook looks its node element up with `closest()`, so without the wrapper it returns
 * before measuring anything and this gate would pass on a corpse.
 *
 * The other half is the e2e gate that already exists (`src/tests/e2e/handle-alignment.spec.ts`),
 * which measures real drift in a real browser and is what keeps this from being satisfiable
 * by simply never measuring.
 */
describe("T924 — a metric-only re-render costs no forced layout", () => {
  function mountInFlowNode(type: string) {
    const store = createGraphStore({
      ids: createSequentialIdFactory("n"),
      initialGraph: graphWith(type),
    });
    const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
    const { value, runtime, timingOverlay } = fixtureContext({
      store: bus.store,
      registry: bus.registry,
    });
    // T1010: the overlay ON, because the readout it draws is what makes the `gpuMs` half
    // of this gate visible at all now that the header no longer carries the number.
    timingOverlay.set(true);
    const view = render(
      <CanvasFixture value={value}>
        <div className="react-flow__node" data-id="n1">
          <NodeView {...nodeProps("n1")} />
        </div>
      </CanvasFixture>,
    );
    return { ...view, runtime, nodeId: "n1" };
  }

  function countLayoutReads() {
    const original = Element.prototype.getBoundingClientRect;
    let reads = 0;
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (
          this.classList.contains("react-flow__handle") ||
          this.classList.contains("react-flow__node")
        ) {
          reads += 1;
        }
        return original.call(this);
      });
    return {
      get count() {
        return reads;
      },
      reset() {
        reads = 0;
      },
      restore() {
        spy.mockRestore();
      },
    };
  }

  it("re-measures on mount and not again when only a runtime number moved", async () => {
    const reads = countLayoutReads();
    try {
      const { runtime, nodeId, container } = mountInFlowNode("test.composite");
      // Let the observers deliver their first callback (the jsdom stub fires on a macrotask).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      // It DID measure — otherwise this gate would pass by the hook being dead.
      expect(container.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0);
      expect(reads.count).toBeGreaterThan(0);

      reads.reset();
      await publish(runtime, nodeId, { gpuMs: 1.25 });
      // The render really happened: the overlay is showing the new number. T1010 SMOOTHS
      // it, so the first sample of a run is the one that lands whole — later ones are an
      // average and asserting the raw figure would be asserting the absence of the
      // smoothing the owner asked for.
      expect(container.textContent).toContain("1.25 ms");
      expect(reads.count).toBe(0);

      // And it stays zero across a run of them, which is what "per second" means.
      for (const gpuMs of [1.5, 1.75, 2, 2.25, 2.5]) {
        await publish(runtime, nodeId, { gpuMs });
      }
      const readout = container.querySelector("[data-testid^='node-timing-value-']")?.textContent ?? "";
      expect(Number.parseFloat(readout)).toBeGreaterThan(1.25);
      expect(Number.parseFloat(readout)).toBeLessThan(2.5);
      expect(reads.count).toBe(0);

      /*
       * T1010 — AND THE SAME HOLDS FOR A RE-RENDER OF THE NODE ITSELF, which is what this
       * gate is really about. Since the timing readout left the header, a `gpuMs` tick no
       * longer re-renders `NodeView` at all (`useNodeStructuralState`), so the run above
       * would pass even if `useHandleBoundsInSync` were back to measuring on every render.
       * A STATUS change is structural, so it does re-render the node — and the layout reads
       * must still be zero.
       */
      await publish(runtime, nodeId, { status: "warning", warningCount: 1 });
      expect(container.querySelector("[data-testid^='node-status-']")?.getAttribute("data-status")).toBe(
        "warning",
      );
      expect(reads.count).toBe(0);
    } finally {
      reads.restore();
    }
  });
});

/**
 * T954 — the order this header established, pinned so the panels can match it.
 *
 * The inspector used to invert it (the type's display name bold, the type again in
 * machine form, the node's own name dim and far right), which is what the owner saw:
 * "kinda the opposite of what the node title shows". The fix made the inspector follow
 * THIS surface, so this asserts the thing being followed — name first, type second —
 * rather than leaving the claim resting on one panel's own test.
 */
describe("T954 — the graph header names the node BEFORE its type", () => {
  it("puts the name first and the type after it", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        n1: {
          id: "n1",
          type: "test.blur",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {},
          // A renamed node: T416 shows the type chip exactly when the name has stopped
          // carrying it, so a rename is what puts BOTH slots on screen at once.
          label: "Bloom pass",
        },
      },
      edges: {},
      groups: {},
    };
    const { container, nodeId } = mountNode("test.blur", { graph });
    const name = container.querySelector(`[data-testid="node-name-${nodeId}"]`);
    const type = container.querySelector(`[data-testid="node-type-${nodeId}"]`);
    expect(name?.textContent).toBe("Bloom pass");
    expect(type?.textContent).toBe("Blur");
    expect((name as Node).compareDocumentPosition(type as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });
});

/**
 * §V1026 (B228) — a value output is ONE socket, however many channels the node publishes.
 * §T1350b drew a socket per published channel; E32 carried 1124 of them and the editor's
 * main thread sat at 100%. A channel is picked with a Select (§T1390b), not dragged from a
 * socket of its own.
 */
describe("§V1026 — a value output is one socket", () => {
  it("draws only the declared output for a value node and for an audio source", () => {
    for (const type of ["mouse", "audioPattern"]) {
      const view = mountNode(type, { graph: graphWith(type), registry: createNodeRegistry(allNodeDefinitions).view() });
      expect([...view.container.querySelectorAll('[data-handlepos="right"]')].map((handle) => handle.getAttribute("data-handleid"))).toEqual(["out"]);
      expect(view.container.querySelectorAll("[data-channel]")).toHaveLength(0);
      cleanup();
    }
  });
});
