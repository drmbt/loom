// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { WIRE_RANGE_PX } from "@editor/edges/wire-range.ts";
import { WIRE_SNAP_ATTRIBUTE, WIRE_SNAP_MS, WIRE_SNAP_REDUCED_MS } from "@editor/edges/wire-snap.ts";
import { GraphCanvas } from "./graph-canvas.tsx";
import { installFlowStubs, setReducedMotion } from "./testing.tsx";

/**
 * T1639b — A WIRE THAT SNAPS, THROUGH THE REAL CANVAS AND REACT FLOW'S OWN POINTER CODE.
 *
 * The owner, of a reference video: "This kind of magnetic snapping, visual snap effect
 * glow shimmer travel and the little electric spark indicator for the magnetic range and
 * the drop to snap range is beautiful. I want this".
 *
 * What a person reads off the canvas is one promise: THE ARC MEANS "LET GO HERE AND IT
 * CONNECTS". So the claims are held in pairs, the picture and the release together:
 *
 *  - in range of a port that takes the wire: the ring and the arc, in the colour of what
 *    the wire carries, and a release dispatches exactly one command;
 *  - out of range: neither, and a release dispatches none;
 *  - in range of a port that refuses: a quiet mark, never the arc, and no command.
 *
 * Nothing here calls the drawing code. Every test presses a real handle, moves the
 * document's pointer and lets go, so the range is React Flow's `connectionRadius` as the
 * canvas set it and the answer is the canvas's own `isValidConnection`.
 *
 * ## The geometry jsdom gives, stated once
 *
 * jsdom lays nothing out. `installFlowStubs` gives every element a 178 x 120 box and
 * `installDomStubs` puts every rect at the origin, so React Flow measures every handle of
 * a node as that node's whole box: all of a node's ports sit at the node's CENTRE, and of
 * the handles tied for closest the library takes the first one of the opposite side. So a
 * node here is one target, its first input. `the stubs put every port at…` below fails by
 * name if that ever stops being true, instead of sixteen tests failing for no visible
 * reason. What cannot be held here (where things are drawn, at what size, and that a
 * node's box never moves) is `wire-snap.spec.ts`'s, in a browser.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
beforeEach(() => setReducedMotion(false));
afterEach(cleanup);

const invocation = contextFor(alice);
const SNAP = `[${WIRE_SNAP_ATTRIBUTE}]`;
/** Where the stubs put every one of a node's ports: the middle of its 178 x 120 box. */
const PORT_AT = { x: 89, y: 60 };
/** Far enough apart that no two nodes' ports are in range of one pointer, at any zoom the fit picks. */
const APART = 2400;

async function apply(bus: LoomBus, operations: Parameters<typeof patch>[1]): Promise<void> {
  await act(async () => {
    await bus.execute("graph.applyPatch", patch(bus.store.getRevision(), operations, "seed"), invocation);
  });
}

interface Stage {
  bus: LoomBus;
  container: HTMLElement;
  /** Node ids by the name the fixture gave them. */
  ids: Record<"solid" | "blur" | "other" | "mono" | "lone", string>;
}

/**
 * solid ──(maybe wired)──▶ blur        other: a second Blur, to move a wire to
 * mono: its input takes a ONE-channel texture, so it refuses the Solid's four-channel wire
 * lone: a second Solid, which has no input at all
 * `chained`: blur ──▶ other as well, a second wire to let a wire go on
 */
async function stage(options: { wired?: boolean; chained?: boolean } = {}): Promise<Stage> {
  const { bus } = createHarness("w");
  await apply(bus, [
    { op: "addNode", ref: "$solid", type: "test.solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$blur", type: "test.blur", position: { x: APART, y: 0 } },
    { op: "addNode", ref: "$other", type: "test.blur", position: { x: APART, y: APART } },
    { op: "addNode", ref: "$mono", type: "test.mono", position: { x: 0, y: APART } },
    { op: "addNode", ref: "$lone", type: "test.solid", position: { x: APART / 2, y: APART * 2 } },
    // Not part of any test: see `ANCHOR_AT`.
    { op: "addNode", ref: "$anchor", type: "test.solid", position: { x: ANCHOR_AT, y: ANCHOR_AT } },
    ...(options.wired === true
      ? [
          {
            op: "connect" as const,
            source: { nodeId: "$solid", portId: "out" },
            target: { nodeId: "$blur", portId: "source" },
          },
        ]
      : []),
    ...(options.chained === true
      ? [
          {
            op: "connect" as const,
            source: { nodeId: "$blur", portId: "out" },
            target: { nodeId: "$other", portId: "source" },
          },
        ]
      : []),
  ]);
  const nodes = Object.values(bus.store.getGraph().nodes);
  const at = (x: number, y: number): string => {
    const found = nodes.find((node) => node.position.x === x && node.position.y === y);
    if (found === undefined) throw new Error(`no node at ${String(x)},${String(y)}`);
    return found.id;
  };
  const ids = {
    solid: at(0, 0),
    blur: at(APART, 0),
    other: at(APART, APART),
    mono: at(0, APART),
    lone: at(APART / 2, APART * 2),
  };
  const view = render(<GraphCanvas bus={bus} invocation={invocation} />);
  await waitFor(() => {
    expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(6);
  });
  const root = view.container.querySelector<HTMLElement>(".react-flow");
  if (root === null) throw new Error("no canvas root");
  // See `CANVAS_SIZE`: an own property, so only this element's answer changes.
  root.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      right: CANVAS_SIZE,
      bottom: CANVAS_SIZE,
      toJSON: () => ({}),
    }) as DOMRect;
  const wires = (options.wired === true ? 1 : 0) + (options.chained === true ? 1 : 0);
  if (wires > 0) {
    // An edge is drawn only once both its nodes are measured, and its grab zone with it.
    await waitFor(() => {
      expect(view.container.querySelectorAll(".react-flow__edgeupdater-target")).toHaveLength(wires);
    });
  }
  // The fit runs on the first measure. Until it has, the camera is not where it will be.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { bus, container: view.container, ids };
}

/** The camera, read off the element React Flow writes it on. */
function camera(container: HTMLElement): { x: number; y: number; zoom: number } {
  const style = container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
  const match = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(style);
  if (match === null) throw new Error(`no camera in "${style}"`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

/**
 * KEEPING THE CAMERA STILL WHILE A WIRE IS HELD.
 *
 * React Flow pans the canvas while a wire is held within 40 px of the canvas's edge
 * (`autoPanOnConnect`). The stubs give the canvas a 178 x 120 box to fit the graph into,
 * so by default every port here is near an edge and the camera slides for as long as a
 * wire is held: a test that waits to see the arc redraw would pass on the camera having
 * moved. Two things stop it, and `the camera holds still…` below checks they do.
 *
 *  - The canvas's own rect, the library's one input to "near the far edge", is made far
 *    larger than anything a test reaches (`CANVAS_SIZE`).
 *  - One node far up and to the left (`ANCHOR_AT`) pulls the middle of the fitted graph
 *    away, so every node the tests use lands hundreds of pixels in from the near edges.
 */
const CANVAS_SIZE = 10000;
const ANCHOR_AT = -20000;

/** A graph point as the pointer coordinates that land on it now. */
function onScreen(container: HTMLElement, point: { x: number; y: number }): { clientX: number; clientY: number } {
  const view = camera(container);
  return { clientX: point.x * view.zoom + view.x, clientY: point.y * view.zoom + view.y };
}

function handleOf(stageOf: Stage, node: keyof Stage["ids"], port: string, side: "source" | "target"): HTMLElement {
  const found = [...stageOf.container.querySelectorAll<HTMLElement>(`.react-flow__handle.${side}`)].find(
    (element) => element.dataset["nodeid"] === stageOf.ids[node] && element.dataset["handleid"] === port,
  );
  if (found === undefined) throw new Error(`no ${side} handle ${node}:${port}`);
  return found;
}

function portOf(stageOf: Stage, node: keyof Stage["ids"]): { x: number; y: number } {
  const position = stageOf.bus.store.getGraph().nodes[stageOf.ids[node]]?.position;
  if (position === undefined) throw new Error(`no node ${node}`);
  return { x: position.x + PORT_AT.x, y: position.y + PORT_AT.y };
}

/** A point `pixels` SCREEN pixels to the left of a node's ports, in graph coordinates. */
function leftOf(stageOf: Stage, node: keyof Stage["ids"], pixels: number): { x: number; y: number } {
  const port = portOf(stageOf, node);
  return { x: port.x - pixels / camera(stageOf.container).zoom, y: port.y };
}

/** Press a handle and move a little: React Flow starts a connection on the first move. */
function pickUp(stageOf: Stage, handle: HTMLElement, from: keyof Stage["ids"]): void {
  const start = portOf(stageOf, from);
  act(() => {
    fireEvent.mouseDown(handle, { button: 0, ...onScreen(stageOf.container, start) });
    fireEvent.mouseMove(document, onScreen(stageOf.container, { x: start.x + 40, y: start.y + 40 }));
  });
}

function moveTo(stageOf: Stage, point: { x: number; y: number }): void {
  act(() => {
    fireEvent.mouseMove(document, onScreen(stageOf.container, point));
  });
}

async function letGo(stageOf: Stage, point: { x: number; y: number }): Promise<void> {
  await act(async () => {
    fireEvent.mouseUp(document, onScreen(stageOf.container, point));
    // The command answers on a later turn; the snap is played from its answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const wire = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-testid="wire-in-flight"]');
const stateOf = (container: HTMLElement): string | null => wire(container)?.getAttribute("data-wire-state") ?? null;
const arcOf = (container: HTMLElement): string =>
  container.querySelector('[data-testid="wire-arc"]')?.getAttribute("d") ?? "";
const circleAt = (container: HTMLElement, testId: string): { x: number; y: number } => {
  const circle = container.querySelector(`[data-testid="${testId}"]`);
  return { x: Number(circle?.getAttribute("cx")), y: Number(circle?.getAttribute("cy")) };
};

function edgesOf(bus: LoomBus): Array<{ from: string; to: string }> {
  return Object.values(bus.store.getGraph().edges).map((edge) => ({
    from: `${edge.source.nodeId}.${edge.source.portId}`,
    to: `${edge.target.nodeId}.${edge.target.portId}`,
  }));
}

describe("the ground the rest stands on", () => {
  it("the stubs put every port at the middle of its node, and the camera is zoomed OUT", async () => {
    const s = await stage();
    // Zoomed out is the half of the range rule a fixed radius got wrong (7 px at 35 %).
    expect(camera(s.container).zoom).toBeLessThan(1);
    expect(camera(s.container).zoom).toBeGreaterThan(0);

    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    moveTo(s, portOf(s, "blur"));
    expect(stateOf(s.container)).toBe("live");
    // The ring is drawn ON the port React Flow answered with, which is where this says it is.
    expect(circleAt(s.container, "wire-ring")).toEqual(portOf(s, "blur"));
  });

  it("the camera holds still while a wire is held, wherever these tests put the pointer", async () => {
    const s = await stage();
    const view = camera(s.container);
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    for (const node of ["blur", "other", "mono", "lone", "solid"] as const) {
      for (const pixels of [0, WIRE_RANGE_PX * 4]) {
        moveTo(s, leftOf(s, node, pixels));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
        });
      }
    }
    expect(camera(s.container)).toEqual(view);
  });

  it("nothing of the wire exists while no wire is in the hand", async () => {
    const s = await stage();
    expect(wire(s.container)).toBeNull();
    expect(s.container.querySelectorAll(SNAP)).toHaveLength(0);
  });
});

describe("in range of a port that takes the wire: the arc, and a release connects", () => {
  it("shows the ring and the arc in the colour of what the wire carries", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    moveTo(s, leftOf(s, "blur", 30));

    expect(stateOf(s.container)).toBe("live");
    // The Solid's output is a texture2d, so the connection that would be made is that hue (§V26).
    expect(wire(s.container)?.style.getPropertyValue("--wire-color")).toBe("var(--port-texture2d)");
    expect(arcOf(s.container)).not.toBe("");
  });

  it("draws the arc from the wire's tip, which stays at the pointer, to the port", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    const pointer = leftOf(s, "blur", 30);
    moveTo(s, pointer);

    const tip = circleAt(s.container, "wire-tip");
    // The tip did NOT jump to the port: React Flow snaps its own line's end there, and the
    // reference's point is that the wire stays in the hand and the arc bridges the gap.
    expect(tip.x).toBeCloseTo(pointer.x, 1);
    expect(tip.y).toBeCloseTo(pointer.y, 1);
    const port = portOf(s, "blur");
    const arc = arcOf(s.container);
    const first = /^M([-\d.]+) ([-\d.]+)/.exec(arc);
    const last = /L([-\d.]+) ([-\d.]+)$/.exec(arc);
    expect(Number(first?.[1])).toBeCloseTo(tip.x, 1);
    expect(Number(first?.[2])).toBeCloseTo(tip.y, 1);
    expect(Number(last?.[1])).toBeCloseTo(port.x, 1);
    expect(Number(last?.[2])).toBeCloseTo(port.y, 1);
    // And the wire itself ends at the tip, not at the port.
    const line = s.container.querySelector('[data-testid="wire-line"]')?.getAttribute("d") ?? "";
    const end = /([-\d.e]+),([-\d.e]+)$/.exec(line);
    expect(Number(end?.[1])).toBeCloseTo(tip.x, 1);
    expect(Number(end?.[2])).toBeCloseTo(tip.y, 1);
    // 30 screen px from the port is hundreds of graph px at this zoom: not the same point.
    expect(Math.abs(Number(end?.[1]) - port.x)).toBeGreaterThan(100);
  });

  it("a release there dispatches exactly ONE command, and the document has the edge", async () => {
    const s = await stage();
    const audit = s.bus.store.getAudit().length;
    const revision = s.bus.store.getRevision();

    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    const at = leftOf(s, "blur", 30);
    moveTo(s, at);
    expect(stateOf(s.container)).toBe("live");
    await letGo(s, at);

    expect(edgesOf(s.bus)).toEqual([{ from: `${s.ids.solid}.out`, to: `${s.ids.blur}.source` }]);
    expect(s.bus.store.getAudit()).toHaveLength(audit + 1);
    expect(s.bus.store.getRevision()).toBe(revision + 1);
    // The wire in the hand is gone with the gesture.
    expect(wire(s.container)).toBeNull();
  });

  it("crackles: the arc is a different shape a moment later, with the pointer held still", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    moveTo(s, leftOf(s, "blur", 30));
    const first = arcOf(s.container);
    const tip = circleAt(s.container, "wire-tip");
    const view = camera(s.container);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(stateOf(s.container)).toBe("live");
    // Nothing else moved: same camera, same tip. What changed is the arc's own tick.
    expect(camera(s.container)).toEqual(view);
    expect(circleAt(s.container, "wire-tip")).toEqual(tip);
    expect(arcOf(s.container)).not.toBe(first);
    // Between the same two points as before.
    expect(/^M[-\d.]+ [-\d.]+/.exec(arcOf(s.container))?.[0]).toBe(/^M[-\d.]+ [-\d.]+/.exec(first)?.[0]);
    expect(/L[-\d.]+ [-\d.]+$/.exec(arcOf(s.container))?.[0]).toBe(/L[-\d.]+ [-\d.]+$/.exec(first)?.[0]);
  });
});

describe("the range the arc shows is the range a release connects from", () => {
  it("just inside the range it sparks and connects; just outside it does neither", async () => {
    const inside = await stage();
    pickUp(inside, handleOf(inside, "solid", "out", "source"), "solid");
    const near = leftOf(inside, "blur", WIRE_RANGE_PX - 3);
    moveTo(inside, near);
    expect(stateOf(inside.container)).toBe("live");
    await letGo(inside, near);
    expect(edgesOf(inside.bus)).toHaveLength(1);
    cleanup();

    const outside = await stage();
    const audit = outside.bus.store.getAudit().length;
    pickUp(outside, handleOf(outside, "solid", "out", "source"), "solid");
    const far = leftOf(outside, "blur", WIRE_RANGE_PX + 3);
    moveTo(outside, far);
    expect(stateOf(outside.container)).toBe("free");
    expect(wire(outside.container)?.style.getPropertyValue("--wire-color")).toBe("");
    await letGo(outside, far);
    expect(edgesOf(outside.bus)).toEqual([]);
    // No command at all: not a refused one, not an empty patch.
    expect(outside.bus.store.getAudit()).toHaveLength(audit);
    expect(outside.container.querySelectorAll(SNAP)).toHaveLength(0);
  });

  it("leaving the range puts the arc out, and coming back lights it again", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    moveTo(s, leftOf(s, "blur", 20));
    expect(stateOf(s.container)).toBe("live");
    moveTo(s, leftOf(s, "blur", WIRE_RANGE_PX * 3));
    expect(stateOf(s.container)).toBe("free");
    moveTo(s, leftOf(s, "blur", 20));
    expect(stateOf(s.container)).toBe("live");
  });
});

describe("a port that refuses never sparks", () => {
  it("shows the quiet mark and says what the port takes; no arc colour, no command", async () => {
    const s = await stage();
    const audit = s.bus.store.getAudit().length;
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    const at = leftOf(s, "mono", 20);
    moveTo(s, at);

    expect(stateOf(s.container)).toBe("refused");
    expect(wire(s.container)?.style.getPropertyValue("--wire-color")).toBe("");
    expect(circleAt(s.container, "wire-refused")).toEqual(portOf(s, "mono"));
    // The Connections panel's words for the same refusal: what THIS port takes.
    expect(s.container.querySelector('[data-testid="wire-refused-why"]')?.textContent).toBe(
      "takes texture2d<float,1,linear>",
    );

    await letGo(s, at);
    expect(edgesOf(s.bus)).toEqual([]);
    expect(s.bus.store.getAudit()).toHaveLength(audit);
    expect(s.container.querySelectorAll(SNAP)).toHaveLength(0);
  });

  it("an output in range of a wire held by its output is not marked at all", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    // The lone Solid has no input: the only handle in range is another output.
    moveTo(s, leftOf(s, "lone", 10));
    expect(stateOf(s.container)).toBe("free");
  });

  it("going from a port that takes it to one that refuses puts the colour out", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    moveTo(s, leftOf(s, "blur", 20));
    expect(wire(s.container)?.style.getPropertyValue("--wire-color")).toBe("var(--port-texture2d)");
    moveTo(s, leftOf(s, "mono", 20));
    expect(stateOf(s.container)).toBe("refused");
    expect(wire(s.container)?.style.getPropertyValue("--wire-color")).toBe("");
  });
});

describe("the snap plays for the connection that was made, and then it is gone", () => {
  it("is on the node the wire landed in, outside that node's own element, with the wire's colour fill", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    const at = leftOf(s, "blur", 30);
    moveTo(s, at);
    await letGo(s, at);

    const wrapper = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find(
      (node) => node.getAttribute("data-id") === s.ids.blur,
    );
    const box = wrapper?.querySelector<HTMLElement>(`:scope > ${SNAP}`);
    expect(box).not.toBeNull();
    expect(box?.style.getPropertyValue("--snap-color")).toBe("var(--port-texture2d)");
    // §V389, against the cause: nothing was added to the element the layout model measures.
    expect(s.container.querySelector(`[data-testid="node-${s.ids.blur}"] ${SNAP}`)).toBeNull();
    // The colour fill, in React Flow's viewport layer.
    expect(s.container.querySelectorAll(`.react-flow__viewport-portal ${SNAP}`)).toHaveLength(1);
    // Nowhere else: not on the node the wire left, not twice.
    expect(s.container.querySelectorAll(SNAP)).toHaveLength(2);
  });

  it("leaves nothing in the DOM once it has played", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    const at = leftOf(s, "blur", 30);
    moveTo(s, at);
    await letGo(s, at);
    expect(s.container.querySelectorAll(SNAP).length).toBeGreaterThan(0);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WIRE_SNAP_MS + 60));
    });
    expect(s.container.querySelectorAll(SNAP)).toHaveLength(0);
    expect(wire(s.container)).toBeNull();
  });

  it("a wire dragged BACKWARDS, from an input to an output, snaps on the output's node", async () => {
    const s = await stage();
    pickUp(s, handleOf(s, "blur", "source", "target"), "blur");
    const at = leftOf(s, "solid", 20);
    moveTo(s, at);
    expect(stateOf(s.container)).toBe("live");
    // The colour is still what the wire carries: the OUTPUT's type, whichever end is held.
    expect(wire(s.container)?.style.getPropertyValue("--wire-color")).toBe("var(--port-texture2d)");
    await letGo(s, at);

    expect(edgesOf(s.bus)).toEqual([{ from: `${s.ids.solid}.out`, to: `${s.ids.blur}.source` }]);
    const on = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find(
      (node) => node.querySelector(`:scope > ${SNAP}`) !== null,
    );
    expect(on?.getAttribute("data-id")).toBe(s.ids.solid);
  });
});

describe("reduced motion keeps the ring and the colour, and drops the crackle and the travel (§V19)", () => {
  it("the arc is one still shape, and the snap is a still ring that goes sooner", async () => {
    setReducedMotion(true);
    const s = await stage();
    pickUp(s, handleOf(s, "solid", "out", "source"), "solid");
    const at = leftOf(s, "blur", 30);
    moveTo(s, at);

    expect(stateOf(s.container)).toBe("live");
    expect(wire(s.container)?.style.getPropertyValue("--wire-color")).toBe("var(--port-texture2d)");
    const first = arcOf(s.container);
    expect(first).not.toBe("");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    // The same wait that shows a new shape with motion on (the test above).
    expect(arcOf(s.container)).toBe(first);

    await letGo(s, at);
    expect(edgesOf(s.bus)).toHaveLength(1);
    const boxes = [...s.container.querySelectorAll<HTMLElement>(SNAP)];
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box.hasAttribute("data-reduced")).toBe(true);
    // Nothing that travels the border was made.
    expect(s.container.querySelectorAll(`${SNAP} rect`)).toHaveLength(0);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WIRE_SNAP_REDUCED_MS + 60));
    });
    expect(s.container.querySelectorAll(SNAP)).toHaveLength(0);
  });
});

describe("a connected wire's end is pulled off at the port", () => {
  it("a press on the connected input's dot picks up THAT wire, held by its output", async () => {
    const s = await stage({ wired: true });
    pickUp(s, handleOf(s, "blur", "source", "target"), "blur");

    // The wire in the hand starts at the Solid's output: it is the existing wire, not a
    // second one growing out of the input.
    const line = s.container.querySelector('[data-testid="wire-line"]')?.getAttribute("d") ?? "";
    const start = portOf(s, "solid");
    expect(line.startsWith(`M${String(start.x)},${String(start.y)}`)).toBe(true);
    // And the edge it was is not drawn while it is held.
    expect(s.container.querySelector(".react-flow__edge-path")).toBeNull();
    // The document is untouched until the release (§V15).
    expect(edgesOf(s.bus)).toHaveLength(1);
  });

  it("let go in the open, the wire comes off: one command, and no edge", async () => {
    const s = await stage({ wired: true });
    const audit = s.bus.store.getAudit().length;
    pickUp(s, handleOf(s, "blur", "source", "target"), "blur");
    const open = leftOf(s, "blur", WIRE_RANGE_PX * 4);
    moveTo(s, open);
    expect(stateOf(s.container)).toBe("free");
    await letGo(s, open);

    expect(edgesOf(s.bus)).toEqual([]);
    expect(s.bus.store.getAudit()).toHaveLength(audit + 1);
    expect(s.container.querySelectorAll(SNAP)).toHaveLength(0);
  });

  it("let go back on its own port, nothing is said to the document and the snap plays", async () => {
    const s = await stage({ wired: true });
    const audit = s.bus.store.getAudit().length;
    const revision = s.bus.store.getRevision();
    pickUp(s, handleOf(s, "blur", "source", "target"), "blur");
    const back = leftOf(s, "blur", 20);
    moveTo(s, back);
    expect(stateOf(s.container)).toBe("live");
    await letGo(s, back);

    expect(edgesOf(s.bus)).toEqual([{ from: `${s.ids.solid}.out`, to: `${s.ids.blur}.source` }]);
    expect(s.bus.store.getAudit()).toHaveLength(audit);
    expect(s.bus.store.getRevision()).toBe(revision);
    expect(s.container.querySelectorAll(SNAP).length).toBeGreaterThan(0);
    // The edge is drawn again.
    await waitFor(() => {
      expect(s.container.querySelector(".react-flow__edge-path")).not.toBeNull();
    });
  });

  it("let go on another port that takes it, the wire MOVES there: one command, one edge", async () => {
    const s = await stage({ wired: true });
    const audit = s.bus.store.getAudit().length;
    const revision = s.bus.store.getRevision();
    pickUp(s, handleOf(s, "blur", "source", "target"), "blur");
    const at = leftOf(s, "other", 20);
    moveTo(s, at);
    expect(stateOf(s.container)).toBe("live");
    await letGo(s, at);

    // Moved, not copied: the old input is free and the new one is fed, in ONE undo entry.
    expect(edgesOf(s.bus)).toEqual([{ from: `${s.ids.solid}.out`, to: `${s.ids.other}.source` }]);
    expect(s.bus.store.getAudit()).toHaveLength(audit + 1);
    expect(s.bus.store.getRevision()).toBe(revision + 1);
  });

  it("let go on a port that refuses it, the wire goes back where it was", async () => {
    const s = await stage({ wired: true });
    const audit = s.bus.store.getAudit().length;
    pickUp(s, handleOf(s, "blur", "source", "target"), "blur");
    const at = leftOf(s, "mono", 20);
    moveTo(s, at);
    expect(stateOf(s.container)).toBe("refused");
    await letGo(s, at);

    expect(edgesOf(s.bus)).toEqual([{ from: `${s.ids.solid}.out`, to: `${s.ids.blur}.source` }]);
    expect(s.bus.store.getAudit()).toHaveLength(audit);
  });

  it("a press on an input with NO wire still starts an ordinary wire out of that input", async () => {
    // The legitimate case the re-aimed press could swallow: the dot of an unconnected input.
    const s = await stage({ wired: true });
    pickUp(s, handleOf(s, "other", "source", "target"), "other");
    const line = s.container.querySelector('[data-testid="wire-line"]')?.getAttribute("d") ?? "";
    const start = portOf(s, "other");
    expect(line.startsWith(`M${String(start.x)},${String(start.y)}`)).toBe(true);
    // The existing edge is not involved: still drawn, still in the document.
    expect(s.container.querySelector(".react-flow__edge-path")).not.toBeNull();
    expect(edgesOf(s.bus)).toHaveLength(1);
  });
});

describe("a wire let go on a WIRE, with no port answering, takes that wire's input (§V14b)", () => {
  /**
   * The middle of the wire from the first Blur to the second, where the stubs draw it:
   * out of the right edge of one box and into the left edge of the other. A cubic between
   * two points with level tangents passes through the point half way between them. It is
   * 1200 graph px from either node's ports, which is 60 px on screen: out of range.
   */
  const onTheWire = { x: APART + 89, y: APART / 2 + 60 };

  it("a NEW wire replaces it in one command, and the snap plays on the input it now feeds", async () => {
    const s = await stage({ chained: true });
    const audit = s.bus.store.getAudit().length;
    pickUp(s, handleOf(s, "lone", "out", "source"), "lone");
    moveTo(s, onTheWire);
    // Nothing sparks: this is the wire's hit area, not a port's range.
    expect(stateOf(s.container)).toBe("free");
    await letGo(s, onTheWire);

    expect(edgesOf(s.bus)).toEqual([{ from: `${s.ids.lone}.out`, to: `${s.ids.other}.source` }]);
    expect(s.bus.store.getAudit()).toHaveLength(audit + 1);
    const on = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find(
      (node) => node.querySelector(`:scope > ${SNAP}`) !== null,
    );
    expect(on?.getAttribute("data-id")).toBe(s.ids.other);
  });

  it("a PULLED wire moves there in one command: not a copy, and not two undo entries", async () => {
    const s = await stage({ wired: true, chained: true });
    const audit = s.bus.store.getAudit().length;
    const revision = s.bus.store.getRevision();
    pickUp(s, handleOf(s, "blur", "source", "target"), "blur");
    moveTo(s, onTheWire);
    expect(stateOf(s.container)).toBe("free");
    await letGo(s, onTheWire);

    // The Solid's wire left the first Blur and took the second Blur's input from the
    // wire that was in it. Both handlers React Flow calls for this release ran, and one
    // of them stood aside.
    expect(edgesOf(s.bus)).toEqual([{ from: `${s.ids.solid}.out`, to: `${s.ids.other}.source` }]);
    expect(s.bus.store.getAudit()).toHaveLength(audit + 1);
    expect(s.bus.store.getRevision()).toBe(revision + 1);
  });
});
