import { cx } from "@ui/cx.ts";
import { wireScale } from "./wire-range.ts";
import styles from "./wire-snap.module.css";

/**
 * The snap: what plays when a wire lands in a port (T1639b).
 *
 * The wire's colour fill, two rings out of the port, the dot's pulse, and the bar that
 * leaves the port and runs the node's border both ways with a glow in the body behind it.
 * What each part is measured from is in docs/wire-snap-design-2026-10-06.md.
 *
 * ## It is DOM made by hand, not a component, and that is the point
 *
 * It lasts 0.72 s and then must not exist: no element, no running animation, no state
 * anywhere. A component would need a place in the tree, state to mount it and a render to
 * unmount it, on every node, for something that is absent all but a second of a session.
 * So this appends one box to the node's wrapper and one path to React Flow's viewport
 * portal, lets CSS animate them, and removes both on one timer.
 *
 * ## It cannot move or resize the node (§V389)
 *
 * The box is `position: absolute; inset: 0` in `.react-flow__node`, AFTER the node's own
 * element and not inside it. Nothing is added to the element the layout model measures;
 * the wrapper's size is the node's and an absolutely positioned child cannot change it.
 * `wire-snap.spec.ts` compares every node's box before, during and after.
 *
 * ## Where it stacks
 *
 * The wrapper is a stacking context (React Flow writes its z-index). The box has none of
 * its own, so it paints after the node's body and before the two things on the node that
 * carry one: the port dots (2) and the low-zoom kind label (1). The bar passes behind the
 * dots and behind the label's plate, which stands on the node's top edge (B258).
 *
 * ## A timer ends it, not `animationend`
 *
 * `animationend` does not fire for an animation that is cancelled, and under
 * `prefers-reduced-motion` the base layer ends every animation at once, so a still ring
 * could not be held on screen by one. The timer fires whatever happened. A node deleted
 * mid-effect takes its box with it and the removal finds nothing to do.
 */

/** The whole snap, in milliseconds. The reference's bright part is 750; see the note for why this is shorter. */
export const WIRE_SNAP_MS = 720;
/** Under reduced motion: how long the still ring and the wire's colour show. */
export const WIRE_SNAP_REDUCED_MS = 300;
/** Marks every element the snap adds, so a test (and the next snap) can find them. */
export const WIRE_SNAP_ATTRIBUTE = "data-wire-snap";

/** Each bar is this share of the border's length. */
const BAR_OF_PERIMETER = 0.07;
/** The glow's copy of the bar is longer, so it reaches ahead of and behind it. */
const GLOW_OF_PERIMETER = 0.11;

const SVG_NS = "http://www.w3.org/2000/svg";

export interface NodeBox {
  readonly width: number;
  readonly height: number;
}

/**
 * Where on a rounded rectangle's border a port sits, as a share of the border's length.
 *
 * Measured the way SVG draws a `<rect>`: from the left end of the top edge, clockwise.
 * The bar is one dash on that outline, so this number is where both copies of it start.
 * A port in the left half of the box is on the left edge, otherwise on the right; `y` is
 * held to the straight part of the edge, so a port level with a corner starts at the
 * corner's end and not half way round it.
 */
export function borderPosition(box: NodeBox, radius: number, port: { x: number; y: number }): number {
  const r = Math.max(0, Math.min(radius, box.width / 2, box.height / 2));
  const top = Math.max(0, box.width - 2 * r);
  const side = Math.max(0, box.height - 2 * r);
  const corner = (Math.PI * r) / 2;
  const perimeter = 2 * top + 2 * side + 4 * corner;
  if (!(perimeter > 0)) return 0;
  const down = Math.max(0, Math.min(side, port.y - r));
  const along =
    port.x <= box.width / 2
      ? // top, corner, right, corner, bottom, corner, then UP the left edge to the port.
        top + corner + side + corner + top + corner + (side - down)
      : // top, corner, then DOWN the right edge to the port.
        top + corner + down;
  return along / perimeter;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  className: string | undefined,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  if (className !== undefined) element.setAttribute("class", className);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** The node's border as a `<rect>` whose length is 1, so a dash is a share of the border. */
function outline(className: string | undefined, box: NodeBox, radius: number): SVGRectElement {
  // Half a pixel in: the stroke is centred on the node's 1 px border line.
  return svg("rect", className, {
    x: 0.5,
    y: 0.5,
    width: Math.max(0, box.width - 1),
    height: Math.max(0, box.height - 1),
    rx: Math.max(0, radius - 0.5),
    pathLength: 1,
  });
}

/** One end of a wire, as React Flow addresses it: a node and one of its handles. */
export interface WireEnd {
  readonly nodeId: string;
  readonly handleId: string;
}

function handleElement(root: ParentNode, end: WireEnd, type: "source" | "target"): HTMLElement | null {
  // Compared as data, not spliced into a selector: a variadic socket's id carries a `#`.
  for (const element of root.querySelectorAll<HTMLElement>(`.react-flow__handle.${type}`)) {
    if (element.dataset["nodeid"] === end.nodeId && element.dataset["handleid"] === end.handleId) return element;
  }
  return null;
}

export interface WireLanding {
  /** The canvas element. The handles and React Flow's viewport portal are found in it. */
  readonly canvas: HTMLElement;
  /** A screen point in graph coordinates (`screenToFlowPosition`). */
  readonly toGraph: (point: { x: number; y: number }) => { x: number; y: number };
  /** The curve between two graph points, as the edge component draws it. */
  readonly curve: (source: { x: number; y: number }, target: { x: number; y: number }) => string;
  readonly zoom: number;
  readonly color: string;
  /** The wire that now exists: its output end and its input end. */
  readonly source: WireEnd;
  readonly target: WireEnd;
  /** Which of the two ends the snap plays on: the port the wire's tip was let go at. */
  readonly on: "source" | "target";
}

/**
 * Plays the snap for a wire that has just landed, found from the document's own terms.
 *
 * The canvas knows a connection as two ends; where they are on screen is the DOM's to
 * say. An edge is drawn from the middle of each handle's OUTER edge (React Flow's rule,
 * measured in `e2e/app.ts`), so the colour fill is the same curve the new edge takes.
 */
export function playWireLanding(landing: WireLanding): void {
  const source = handleElement(landing.canvas, landing.source, "source");
  const target = handleElement(landing.canvas, landing.target, "target");
  const handle = landing.on === "source" ? source : target;
  if (handle === null) return;
  const layer = landing.canvas.querySelector<HTMLElement>(".react-flow__viewport-portal");
  let wire: WireSnapRequest["wire"];
  if (source !== null && target !== null && layer !== null) {
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    wire = {
      layer,
      path: landing.curve(
        landing.toGraph({ x: from.right, y: from.top + from.height / 2 }),
        landing.toGraph({ x: to.left, y: to.top + to.height / 2 }),
      ),
    };
  }
  playWireSnap({ handle, color: landing.color, zoom: landing.zoom, wire });
}

export interface WireSnapRequest {
  /** The port the wire landed in: React Flow's handle element. */
  readonly handle: HTMLElement;
  /** The colour of what the wire carries: a `var(--port-…)` token reference (§V26, §V17). */
  readonly color: string;
  /** The canvas's zoom, for the sizes that hold on screen below 100 % (`wireScale`). */
  readonly zoom: number;
  /**
   * The wire's curve in graph coordinates and the element to draw its colour fill in
   * (React Flow's viewport portal). Absent: the port and the border play without it.
   */
  readonly wire?: { readonly path: string; readonly layer: HTMLElement } | undefined;
}

/**
 * Plays the snap on the node `handle` belongs to. Returns at once; everything it adds
 * removes itself.
 */
export function playWireSnap(request: WireSnapRequest): void {
  const { handle, color, zoom } = request;
  const node = handle.closest<HTMLElement>(".react-flow__node");
  if (node === null) return;
  const reduced = prefersReducedMotion();
  const k = wireScale(zoom);

  // One snap at a time on a node: a second wire landing replaces the first one's effect.
  for (const earlier of node.querySelectorAll(`:scope > [${WIRE_SNAP_ATTRIBUTE}]`)) earlier.remove();

  // The port's centre inside the node, in the node's own pixels. Both rects are on
  // screen, so the canvas's scale divides out; `offsetWidth` is the same box unscaled.
  const box: NodeBox = { width: node.offsetWidth, height: node.offsetHeight };
  const nodeRect = node.getBoundingClientRect();
  const handleRect = handle.getBoundingClientRect();
  const scale = box.width > 0 && nodeRect.width > 0 ? nodeRect.width / box.width : 1;
  const port = {
    x: (handleRect.left + handleRect.width / 2 - nodeRect.left) / scale,
    y: (handleRect.top + handleRect.height / 2 - nodeRect.top) / scale,
  };
  // The node's own element is the wrapper's child the handle is inside. Its corner radius
  // is the token's, read from the element so a second copy of the number cannot drift.
  let body: HTMLElement = handle;
  while (body.parentElement !== null && body.parentElement !== node) body = body.parentElement;
  const radius = Number.parseFloat(getComputedStyle(body).borderTopLeftRadius) || 0;

  const root = document.createElement("div");
  root.className = cx(styles.snap);
  root.setAttribute(WIRE_SNAP_ATTRIBUTE, "node");
  if (reduced) root.setAttribute("data-reduced", "");
  root.style.setProperty("--snap-color", color);
  root.style.setProperty("--snap-k", String(k));
  // A length, as the dash is: the outline's length is 1, so `0.25px` is a quarter round.
  root.style.setProperty("--snap-at", `${borderPosition(box, radius, port).toFixed(5)}px`);

  const art = svg("svg", styles.art, { width: box.width, height: box.height, "aria-hidden": "true" });
  if (!reduced) {
    // The glow in the body: the same two bars, wide and blurred, clipped to the node.
    const bleed = document.createElement("div");
    bleed.className = cx(styles.bleed);
    bleed.style.setProperty("--snap-dash", `${String(GLOW_OF_PERIMETER)}px`);
    const bleedArt = svg("svg", styles.bleedArt, { width: box.width, height: box.height, "aria-hidden": "true" });
    bleedArt.append(
      outline(cx(styles.bar, styles.glow, styles.clockwise), box, radius),
      outline(cx(styles.bar, styles.glow, styles.counter), box, radius),
    );
    bleed.append(bleedArt);
    root.append(bleed);

    art.style.setProperty("--snap-dash", `${String(BAR_OF_PERIMETER)}px`);
    art.append(
      outline(cx(styles.bar, styles.core, styles.clockwise), box, radius),
      outline(cx(styles.bar, styles.core, styles.counter), box, radius),
    );
  }
  const at = { cx: port.x.toFixed(2), cy: port.y.toFixed(2) };
  art.append(svg("circle", cx(styles.ring, styles.ringOuter), at));
  if (!reduced) {
    art.append(svg("circle", cx(styles.ring, styles.ringInner), at), svg("circle", styles.dot, at));
  }
  root.append(art);
  node.append(root);

  let fill: SVGSVGElement | null = null;
  if (request.wire !== undefined && request.wire.path !== "") {
    fill = svg("svg", styles.fill, { "aria-hidden": "true" });
    fill.setAttribute(WIRE_SNAP_ATTRIBUTE, "wire");
    if (reduced) fill.setAttribute("data-reduced", "");
    fill.style.setProperty("--snap-color", color);
    fill.style.setProperty("--snap-k", String(k));
    fill.append(
      svg("path", styles.fillGlow, { d: request.wire.path }),
      svg("path", styles.fillCore, { d: request.wire.path }),
    );
    request.wire.layer.append(fill);
  }

  window.setTimeout(
    () => {
      root.remove();
      fill?.remove();
    },
    reduced ? WIRE_SNAP_REDUCED_MS : WIRE_SNAP_MS,
  );
}
