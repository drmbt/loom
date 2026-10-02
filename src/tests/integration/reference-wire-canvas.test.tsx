// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor, patch } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { GraphCanvas } from "@editor/graph-canvas/graph-canvas.tsx";
import { createNodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { Inspector } from "@editor/inspector/inspector.tsx";
import type { InspectorProjectSettings } from "@editor/inspector/inspector.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";

/**
 * B233 — the wire into a Layer's picture and a Window Out's input, ON THE CANVAS.
 *
 * The bug had three faces and a unit test of any one would have supplied the other two:
 * no socket was drawn, so there was nothing to drop on; `connect` refused the wire; and a
 * document that already held such an edge made React Flow log
 *
 *   Couldn't create edge for target handle id: "picture"
 *
 * and draw nothing. So this is the gesture, through the real registry, the real bus and
 * React Flow's own connection machinery: press the look's output, release on the socket,
 * and read the edge back out of the DOCUMENT and out of the DOM.
 *
 * ## The one thing jsdom cannot do, and what stands in for it
 *
 * jsdom has no layout, so `document.elementFromPoint` — which is how React Flow decides
 * what the pointer is over when it is released — cannot answer. The test answers it with
 * the socket's own element, and nothing else is supplied: the handle has to EXIST to be
 * returned, has to be connectable for React Flow to accept it, and the canvas's own
 * `isValidConnection` and `onConnect` decide the rest.
 *
 * ## The console is part of the claim
 *
 * React Flow reports an edge it cannot draw only through its dev-mode warning, so the
 * suite runs it as the dev server does (`NODE_ENV=development`) and fails on any warning
 * it prints. Without that the "no error" half would pass against the bug. The one warning
 * let through is #013, "you haven't loaded the styles": vitest loads no CSS, so it is a
 * fact about the harness and it is excluded by its own code, not by a looser match.
 */

/** React Flow's "stylesheet not loaded" notice — true of every jsdom mount, said once. */
const STYLES_NOT_LOADED = "error#013";

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});

const flowWarnings: string[] = [];
beforeEach(() => {
  flowWarnings.length = 0;
  vi.stubEnv("NODE_ENV", "development");
  const record = (...args: unknown[]): void => {
    const text = args.map(String).join(" ");
    if (text.includes("[React Flow]") && !text.includes(STYLES_NOT_LOADED)) flowWarnings.push(text);
  };
  vi.spyOn(console, "warn").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const invocation = contextFor(alice);

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
  limits: { maxResolution: 4096 },
};

function newBus(): LoomBus {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  return createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() }).bus;
}

async function apply(bus: LoomBus, operations: GraphPatchOperation[]) {
  let result: Awaited<ReturnType<LoomBus["execute"]>> | undefined;
  await act(async () => {
    result = await bus.execute("graph.applyPatch", patch(bus.store.getRevision(), operations), invocation);
  });
  if (result === undefined || result.status !== "applied") {
    throw new Error(`patch was ${result?.status}: ${(result?.diagnostics ?? []).map((each) => each.message).join("; ")}`);
  }
  return result as { output: { createdIds: Record<string, string> } };
}

function mount(bus: LoomBus, inspect: NodeId) {
  const runtime = createNodeRuntimeStore({ intervalMs: 0 });
  return render(
    <>
      <GraphCanvas bus={bus} invocation={invocation} runtime={runtime} />
      <Inspector bus={bus} context={invocation} nodeId={inspect} settings={settings} />
    </>,
  );
}

function handleOf(container: HTMLElement, nodeId: string, portId: string, type: "source" | "target"): Element {
  const node = container.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (node === null) throw new Error(`node ${nodeId} is not rendered`);
  const handle = node.querySelector(`.react-flow__handle.${type}[data-handleid="${portId}"]`);
  if (handle === null) throw new Error(`node ${nodeId} draws no ${type} socket "${portId}"`);
  return handle;
}

function mouse(target: Element | Document, type: string, init: MouseEventInit): void {
  const doc = target instanceof Document ? target : target.ownerDocument;
  const win = doc.defaultView;
  if (win === null) throw new Error("no window");
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "view", { value: win });
  target.dispatchEvent(event);
}

/** One connection drag: press `from`, move, release with the pointer over `onto`. */
async function dragConnection(from: Element, onto: Element): Promise<void> {
  const doc = from.ownerDocument as Document & { elementFromPoint: (x: number, y: number) => Element | null };
  const before = doc.elementFromPoint;
  doc.elementFromPoint = () => onto;
  try {
    await act(async () => {
      mouse(from, "mousedown", { button: 0, buttons: 1, clientX: 100, clientY: 100 });
      for (let step = 1; step <= 4; step += 1) {
        mouse(doc, "mousemove", { button: 0, buttons: 1, clientX: 100 + step * 40, clientY: 100 + step * 10 });
      }
      mouse(doc, "mouseup", { button: 0, buttons: 0, clientX: 260, clientY: 140 });
    });
  } finally {
    doc.elementFromPoint = before;
  }
}

const edgeInto = (bus: LoomBus, nodeId: string, portId: string) =>
  Object.values(bus.store.getGraph().edges).find(
    (edge) => edge.target.nodeId === nodeId && edge.target.portId === portId,
  );

/** The path React Flow drew for an edge; throws while it has drawn none. */
function drawnEdge(container: HTMLElement, edgeId: string): string {
  const path = container.querySelector(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`);
  if (path === null) throw new Error(`React Flow drew no wire for edge ${edgeId}`);
  return path.getAttribute("d") ?? "";
}

const referenceLine = (container: HTMLElement, from: string, to: string) =>
  container.querySelector(`[data-testid="reference-line-${from}-${to}"] line`);

const pictureControl = (container: HTMLElement) => {
  const control = container.querySelector<HTMLElement>("[data-reference-noun]");
  if (control === null) throw new Error("the inspector rendered no reference control");
  return control;
};

describe("B233 — a Layer's picture is wired on the canvas", () => {
  async function layerScene() {
    const bus = newBus();
    const built = await apply(bus, [
      { op: "addNode", ref: "$base", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$look", type: "solid", position: { x: 0, y: 260 }, label: "city" },
      { op: "addNode", ref: "$named", type: "solid", position: { x: 0, y: 520 }, label: "smoke" },
      { op: "addNode", ref: "$layer", type: "layer", position: { x: 500, y: 0 }, parameters: { picture: "smoke" } },
      { op: "connect", source: { nodeId: "$base", portId: "out" }, target: { nodeId: "$layer", portId: "below" } },
    ]);
    const id = (ref: string) => built.output.createdIds[ref] as NodeId;
    return { bus, look: id("$look"), named: id("$named"), layer: id("$layer") };
  }

  it("draws the socket, takes a real drag onto it, and React Flow draws the wire with a clean console", async () => {
    const scene = await layerScene();
    const view = mount(scene.bus, scene.layer);
    await act(async () => {});

    // Premise: by name, the dashed line runs from the named look and nothing is overridden.
    await waitFor(() => expect(referenceLine(view.container, scene.named, scene.layer)).not.toBeNull());
    expect(pictureControl(view.container).hasAttribute("data-reference-overridden")).toBe(false);

    const socket = handleOf(view.container, scene.layer, "picture", "target");
    await dragConnection(handleOf(view.container, scene.look, "out", "source"), socket);

    // The DOCUMENT has the wire (the gesture went through the bus)…
    await waitFor(() => expect(edgeInto(scene.bus, scene.layer, "picture")?.source.nodeId).toBe(scene.look));
    const edgeId = edgeInto(scene.bus, scene.layer, "picture")!.id;
    // …React Flow DREW it, to a real curve…
    await waitFor(() => expect(drawnEdge(view.container, edgeId)).toMatch(/^M/));
    // …and said nothing about an edge it could not create.
    expect(flowWarnings).toEqual([]);

    // The wire wins, and both surfaces say so: the dashed line to the named look is gone,
    // and the Picture field names the wire that overrides it without losing the name.
    await waitFor(() => expect(referenceLine(view.container, scene.named, scene.layer)).toBeNull());
    const control = pictureControl(view.container);
    expect(control.getAttribute("data-reference-overridden")).toBe("city");
    expect(control.textContent).toContain("city");
    expect(scene.bus.store.getGraph().nodes[scene.layer]?.parameters["picture"]).toBe("smoke");

    // Disconnect: the name is live again on both surfaces.
    await apply(scene.bus, [{ op: "disconnect", edgeIds: [edgeId] }]);
    await waitFor(() => expect(referenceLine(view.container, scene.named, scene.layer)).not.toBeNull());
    expect(pictureControl(view.container).hasAttribute("data-reference-overridden")).toBe(false);
    expect(flowWarnings).toEqual([]);
  });

  it("draws a wire the document ALREADY holds — the shape the app could not show", async () => {
    const scene = await layerScene();
    const wired = await apply(scene.bus, [
      { op: "connect", ref: "$wire", source: { nodeId: scene.look, portId: "out" }, target: { nodeId: scene.layer, portId: "picture" } },
    ]);
    const view = mount(scene.bus, scene.layer);
    await act(async () => {});
    // The console first: when React Flow cannot create the edge, its own sentence is the
    // failure worth reading, not "no path was found".
    await waitFor(() => {
      expect(flowWarnings).toEqual([]);
      expect(drawnEdge(view.container, wired.output.createdIds["$wire"] as string)).toMatch(/^M/);
    });
  });
});

describe("B233 — a Window Out's input is wired on the canvas", () => {
  it("draws the socket, takes a real drag onto it, and React Flow draws the wire with a clean console", async () => {
    const bus = newBus();
    const built = await apply(bus, [
      { op: "addNode", ref: "$look", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$win", type: "window", position: { x: 500, y: 0 } },
    ]);
    const look = built.output.createdIds["$look"] as NodeId;
    const win = built.output.createdIds["$win"] as NodeId;
    const view = mount(bus, win);
    await act(async () => {});

    const socket = handleOf(view.container, win, "input", "target");
    await dragConnection(handleOf(view.container, look, "out", "source"), socket);

    await waitFor(() => expect(edgeInto(bus, win, "input")?.source.nodeId).toBe(look));
    const edgeId = edgeInto(bus, win, "input")!.id;
    await waitFor(() => expect(drawnEdge(view.container, edgeId)).toMatch(/^M/));
    expect(flowWarnings).toEqual([]);
  });
});

describe("B233 — a name-only input still draws no socket (§V387)", () => {
  it("a Feedback's loop cannot be dropped on, because there is nothing to drop on", async () => {
    // The guard's legitimate case, from the other side: the socket appears ONLY where a
    // wire is accepted. A socket on `feedback.in` would invite the wire `connect` refuses.
    const bus = newBus();
    const built = await apply(bus, [
      { op: "addNode", ref: "$fb", type: "feedback", position: { x: 0, y: 0 } },
    ]);
    const fb = built.output.createdIds["$fb"] as NodeId;
    const view = mount(bus, fb);
    await act(async () => {});
    await waitFor(() => expect(handleOf(view.container, fb, "out", "source")).toBeDefined());
    expect(() => handleOf(view.container, fb, "in", "target")).toThrow(/draws no target socket/);
  });
});
