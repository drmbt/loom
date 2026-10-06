// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReducedMotion } from "@editor/graph-canvas/testing.tsx";
import {
  WIRE_SNAP_ATTRIBUTE,
  WIRE_SNAP_MS,
  WIRE_SNAP_REDUCED_MS,
  borderPosition,
  playWireLanding,
  playWireSnap,
} from "./wire-snap.ts";

/**
 * T1639b — the snap: what is added to the page when a wire lands, and that it goes.
 *
 * Two claims carry the weight. It cannot touch the node's own box (§V389: 79 of 79 node
 * boxes were identical with the kind labels on and off, and this must be as true), and
 * nothing of it outlives it. Both are held against their CAUSE here, where the structure
 * can be seen: the box is a child of React Flow's wrapper and never of the node's own
 * element, and one timer removes everything. `wire-snap.spec.ts` measures the boxes and
 * the running animations in a browser that lays out and animates.
 */

const SELECTOR = `[${WIRE_SNAP_ATTRIBUTE}]`;

/** React Flow's structure for one node: wrapper, the node's own element, a port row, a handle. */
function nodeFixture(nodeId: string): { wrapper: HTMLElement; body: HTMLElement; input: HTMLElement; output: HTMLElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "react-flow__node";
  const body = document.createElement("div");
  body.setAttribute("data-testid", `node-${nodeId}`);
  const handle = (type: "source" | "target", id: string): HTMLElement => {
    const element = document.createElement("div");
    element.className = `react-flow__handle ${type}`;
    element.setAttribute("data-nodeid", nodeId);
    element.setAttribute("data-handleid", id);
    body.append(element);
    return element;
  };
  const input = handle("target", "in2#1");
  const output = handle("source", "out");
  wrapper.append(body);
  return { wrapper, body, input, output };
}

function canvasFixture(): {
  canvas: HTMLElement;
  layer: HTMLElement;
  a: ReturnType<typeof nodeFixture>;
  b: ReturnType<typeof nodeFixture>;
} {
  const canvas = document.createElement("div");
  const layer = document.createElement("div");
  layer.className = "react-flow__viewport-portal";
  const a = nodeFixture("a");
  const b = nodeFixture("b");
  canvas.append(a.wrapper, b.wrapper, layer);
  document.body.append(canvas);
  return { canvas, layer, a, b };
}

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("where on the border the bar starts", () => {
  const box = { width: 178, height: 150 };
  // A square-cornered box: 2 * (178 + 150) = 656 round.
  const perimeter = 656;

  it("a port on the left edge is counted clockwise from the top edge's left end", () => {
    // Top (178), right (150), bottom (178), then up the left edge to y = 100: 50 more.
    expect(borderPosition(box, 0, { x: 0, y: 100 })).toBeCloseTo((178 + 150 + 178 + 50) / perimeter, 9);
  });

  it("a port on the right edge is on the way down it", () => {
    expect(borderPosition(box, 0, { x: 178, y: 100 })).toBeCloseTo((178 + 100) / perimeter, 9);
  });

  it("two ports on one edge start their bars a row apart, in the row's direction", () => {
    const upper = borderPosition(box, 3, { x: 0, y: 100 });
    const lower = borderPosition(box, 3, { x: 0, y: 118 });
    const round = 2 * (172 + 144) + 2 * Math.PI * 3;
    // Clockwise runs UP the left edge, so the lower port comes first.
    expect((upper - lower) * round).toBeCloseTo(18, 6);
  });

  it("is a share of the border: within one turn, for any port and any box", () => {
    for (const port of [
      { x: 0, y: -40 },
      { x: 0, y: 0 },
      { x: 0, y: 75 },
      { x: 0, y: 400 },
      { x: 178, y: 0 },
      { x: 178, y: 150 },
    ]) {
      for (const radius of [0, 3, 500]) {
        const at = borderPosition(box, radius, port);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBeLessThanOrEqual(1);
      }
    }
    // A node with no size yet has no border to stand on.
    expect(borderPosition({ width: 0, height: 0 }, 3, { x: 0, y: 0 })).toBe(0);
  });
});

describe("it cannot touch the node's own box (§V389, against the cause)", () => {
  it("adds one box to React Flow's wrapper, after the node, and nothing inside the node", () => {
    const { layer, b } = canvasFixture();
    const before = b.body.innerHTML;

    playWireSnap({ handle: b.input, color: "var(--port-texture2d)", zoom: 1, wire: { path: "M0 0 L10 10", layer } });

    const boxes = b.wrapper.querySelectorAll(SELECTOR);
    expect(boxes).toHaveLength(1);
    const box = boxes[0] as HTMLElement;
    // A child of the wrapper and a LATER sibling of the node's own element: outside what
    // the layout model measures, and painted over the body.
    expect(box.parentElement).toBe(b.wrapper);
    expect(b.body.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(b.body.contains(box)).toBe(false);
    // The node's own element is byte for byte what it was.
    expect(b.body.innerHTML).toBe(before);
  });

  it("carries the port type's token as its colour, and no colour of its own", () => {
    const { layer, b } = canvasFixture();
    playWireSnap({ handle: b.input, color: "var(--port-value)", zoom: 1, wire: { path: "M0 0 L10 10", layer } });

    for (const element of document.querySelectorAll<HTMLElement>(SELECTOR)) {
      expect(element.style.getPropertyValue("--snap-color")).toBe("var(--port-value)");
    }
    // Nothing the script built names a colour: fill and stroke come from the stylesheet.
    for (const element of document.querySelectorAll(`${SELECTOR} *`)) {
      expect(element.getAttribute("fill")).toBeNull();
      expect(element.getAttribute("stroke")).toBeNull();
    }
  });

  it("draws the wire's colour fill along the curve it is given, in the viewport's layer", () => {
    const { layer, b } = canvasFixture();
    playWireSnap({ handle: b.input, color: "var(--port-value)", zoom: 1, wire: { path: "M1 2 C3 4 5 6 7 8", layer } });
    const fill = layer.querySelector(SELECTOR);
    expect(fill).not.toBeNull();
    const paths = [...(fill?.querySelectorAll("path") ?? [])].map((path) => path.getAttribute("d"));
    expect(paths).toEqual(["M1 2 C3 4 5 6 7 8", "M1 2 C3 4 5 6 7 8"]);
  });

  it("holds its sizes on screen below 100 % zoom and lets them grow above", () => {
    const { layer, b } = canvasFixture();
    const scaleAt = (zoom: number): string => {
      playWireSnap({ handle: b.input, color: "var(--port-value)", zoom, wire: { path: "M0 0 L1 1", layer } });
      return (b.wrapper.querySelector(SELECTOR) as HTMLElement).style.getPropertyValue("--snap-k");
    };
    expect(Number(scaleAt(0.35))).toBeCloseTo(1 / 0.35, 9);
    expect(scaleAt(1)).toBe("1");
    expect(scaleAt(4)).toBe("1");
  });
});

describe("nothing of it outlives it", () => {
  it("is all there until the snap is over, and all gone the moment it is", () => {
    const { layer, b } = canvasFixture();
    playWireSnap({ handle: b.input, color: "var(--port-texture2d)", zoom: 1, wire: { path: "M0 0 L10 10", layer } });
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(2);

    vi.advanceTimersByTime(WIRE_SNAP_MS - 1);
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(2);

    vi.advanceTimersByTime(1);
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(0);
    // And no timer is left waiting to do something later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a second wire landing on the same node replaces the first one's effect", () => {
    const { layer, b } = canvasFixture();
    const play = (): void =>
      playWireSnap({ handle: b.input, color: "var(--port-texture2d)", zoom: 1, wire: { path: "M0 0 L10 10", layer } });
    play();
    vi.advanceTimersByTime(200);
    play();
    expect(b.wrapper.querySelectorAll(SELECTOR)).toHaveLength(1);

    vi.advanceTimersByTime(WIRE_SNAP_MS);
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(0);
  });

  it("a node deleted mid-effect takes its box with it, and the timer finds nothing to do", () => {
    const { layer, b } = canvasFixture();
    playWireSnap({ handle: b.input, color: "var(--port-texture2d)", zoom: 1, wire: { path: "M0 0 L10 10", layer } });
    b.wrapper.remove();
    expect(() => vi.advanceTimersByTime(WIRE_SNAP_MS)).not.toThrow();
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(0);
  });

  it("a handle that is in no node plays nothing at all", () => {
    const stray = document.createElement("div");
    document.body.append(stray);
    playWireSnap({ handle: stray, color: "var(--port-texture2d)", zoom: 1 });
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reduced motion keeps the ring and the colour, and drops what travels (§V19)", () => {
  it("with motion: two bars and their glow run the border, two rings and the dot at the port", () => {
    const { layer, b } = canvasFixture();
    playWireSnap({ handle: b.input, color: "var(--port-texture2d)", zoom: 1, wire: { path: "M0 0 L10 10", layer } });
    const box = b.wrapper.querySelector(SELECTOR) as HTMLElement;
    // The border as one outline of length 1, four times: two bars, and the glow's two.
    const outlines = [...box.querySelectorAll("rect")];
    expect(outlines).toHaveLength(4);
    for (const outline of outlines) expect(outline.getAttribute("pathLength")).toBe("1");
    expect(box.querySelectorAll("circle")).toHaveLength(3);
    expect(box.hasAttribute("data-reduced")).toBe(false);
  });

  it("reduced: one still ring and the wire in its colour, nothing that travels, gone sooner", () => {
    setReducedMotion(true);
    const { layer, b } = canvasFixture();
    playWireSnap({ handle: b.input, color: "var(--port-texture2d)", zoom: 1, wire: { path: "M0 0 L10 10", layer } });

    const box = b.wrapper.querySelector(SELECTOR) as HTMLElement;
    expect(box.hasAttribute("data-reduced")).toBe(true);
    expect(box.querySelectorAll("rect")).toHaveLength(0);
    expect(box.querySelectorAll("circle")).toHaveLength(1);
    const fill = layer.querySelector(SELECTOR) as SVGElement;
    expect(fill.hasAttribute("data-reduced")).toBe(true);
    expect(fill.querySelectorAll("path")).toHaveLength(2);

    vi.advanceTimersByTime(WIRE_SNAP_REDUCED_MS - 1);
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(0);
  });
});

describe("a landing is found from the wire's two ends", () => {
  const landing = (canvas: HTMLElement, on: "source" | "target") => ({
    canvas,
    toGraph: (point: { x: number; y: number }) => point,
    curve: (from: { x: number; y: number }, to: { x: number; y: number }) =>
      `M${String(from.x)} ${String(from.y)} L${String(to.x)} ${String(to.y)}`,
    zoom: 1,
    color: "var(--port-texture2d)",
    source: { nodeId: "a", handleId: "out" },
    target: { nodeId: "b", handleId: "in2#1" },
    on,
  });

  it("plays on the INPUT's node for a wire dragged from an output", () => {
    const { canvas, a, b } = canvasFixture();
    playWireLanding(landing(canvas, "target"));
    expect(b.wrapper.querySelectorAll(SELECTOR)).toHaveLength(1);
    expect(a.wrapper.querySelectorAll(SELECTOR)).toHaveLength(0);
  });

  it("plays on the OUTPUT's node for a wire dragged backwards", () => {
    const { canvas, a, b } = canvasFixture();
    playWireLanding(landing(canvas, "source"));
    expect(a.wrapper.querySelectorAll(SELECTOR)).toHaveLength(1);
    expect(b.wrapper.querySelectorAll(SELECTOR)).toHaveLength(0);
  });

  it("finds a variadic socket by its id as data (the id carries a hash sign)", () => {
    const { canvas, b } = canvasFixture();
    // `in2#1` spliced into a selector would be read as an id selector and match nothing.
    playWireLanding(landing(canvas, "target"));
    expect(b.wrapper.querySelector(SELECTOR)).not.toBeNull();
  });

  it("plays nothing when the port it landed on is not drawn", () => {
    const { canvas } = canvasFixture();
    playWireLanding({ ...landing(canvas, "target"), target: { nodeId: "b", handleId: "gone" } });
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(0);
  });
});
