// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  KIND_LABEL_NONE_ZOOM,
  KIND_LABEL_ROLE_ZOOM,
  KIND_LABEL_TIER_ATTRIBUTE,
  KIND_LABEL_ZOOM,
  KIND_LABEL_ZOOM_PROPERTY,
  createKindLabelRegistry,
  kindLabelParts,
  kindLabelTier,
} from "./kind-label.ts";

/**
 * A NODE'S KIND STAYS LEGIBLE AT LOW ZOOM (T1597b).
 *
 * The owner had to zoom in to see what kind of operator a node is. Three things have to
 * hold for the answer to be a label that does not shrink, and each is tested as the thing
 * a person or the browser would observe:
 *
 *  - WHAT IT SAYS at each zoom: nothing while the header is readable, then the kind and
 *    the name, then the kind alone, then nothing when no word fits;
 *  - that it says the KIND whatever the node is called, because almost no shipped node is
 *    named for its kind yet;
 *  - WHAT IT COSTS: a pan writes nothing, working zoom writes nothing, and a zoom writes
 *    one property per label and never a property on anything they share.
 *
 * What these cannot see is the drawing itself: jsdom lays nothing out. That the label is
 * 11 px on screen at 15 %, stays inside its node and changes no node's box was read from a
 * real browser and is in docs/node-naming-2026-10-05.md.
 */

describe("kindLabelTier: what a node says at each zoom", () => {
  it("says nothing extra while the header itself can be read", () => {
    expect(kindLabelTier(8)).toBe("off");
    expect(kindLabelTier(1)).toBe("off");
    expect(kindLabelTier(KIND_LABEL_ZOOM)).toBe("off");
  });

  it("shows the kind and the rest of the name just below that", () => {
    expect(kindLabelTier(0.699)).toBe("name");
    expect(kindLabelTier(0.6)).toBe("name");
    expect(kindLabelTier(KIND_LABEL_ROLE_ZOOM)).toBe("name");
  });

  it("drops the role first, and keeps the kind", () => {
    expect(kindLabelTier(0.449)).toBe("kind");
    expect(kindLabelTier(0.35)).toBe("kind");
    // E79 Crucible opens at 15 %: the zoom the complaint was made at still shows the kind.
    expect(kindLabelTier(0.154)).toBe("kind");
    expect(kindLabelTier(KIND_LABEL_NONE_ZOOM)).toBe("kind");
  });

  it("shows nothing once a node is too narrow for any word", () => {
    expect(kindLabelTier(0.089)).toBe("none");
    expect(kindLabelTier(0.05)).toBe("none");
  });

  it("orders its thresholds, so a tier cannot be skipped by a typo", () => {
    expect(KIND_LABEL_ZOOM).toBeGreaterThan(KIND_LABEL_ROLE_ZOOM);
    expect(KIND_LABEL_ROLE_ZOOM).toBeGreaterThan(KIND_LABEL_NONE_ZOOM);
    expect(KIND_LABEL_NONE_ZOOM).toBeGreaterThan(0);
  });

  it("reads a zoom that is not a number as off, never as show everything", () => {
    expect(kindLabelTier(Number.NaN)).toBe("off");
  });
});

describe("kindLabelParts: the kind first, whatever the node is called", () => {
  it("splits a name that carries its kind where the kind ends", () => {
    expect(kindLabelParts("kernel_joints", "kernel")).toEqual({ kind: "kernel", rest: "_joints", joined: true });
    expect(kindLabelParts("lfo_path_x", "lfo")).toEqual({ kind: "lfo", rest: "_path_x", joined: true });
  });

  it("keeps an auto-name's number, and adds nothing to a bare kind", () => {
    expect(kindLabelParts("blur1", "blur")).toEqual({ kind: "blur", rest: "1", joined: true });
    expect(kindLabelParts("blur", "blur")).toEqual({ kind: "blur", rest: "", joined: true });
  });

  /*
   * 3,297 of the 3,393 shipped names do not carry their kind yet. The label must not wait
   * for the sweep: the kind comes from the type, and the name follows it untouched.
   */
  it("puts the kind in front of a name that does not carry it, as a separate word", () => {
    expect(kindLabelParts("dye1", "feedback")).toEqual({ kind: "feedback", rest: "dye1", joined: false });
    expect(kindLabelParts("swarm0flock1", "kernel")).toEqual({ kind: "kernel", rest: "swarm0flock1", joined: false });
    // A name that only begins with the letters of the kind is not split inside a word.
    expect(kindLabelParts("camerablur1", "camera")).toEqual({ kind: "camera", rest: "camerablur1", joined: false });
  });

  it("is the kind alone for an unnamed node", () => {
    expect(kindLabelParts(undefined, "blur")).toEqual({ kind: "blur", rest: "", joined: true });
  });

  it("says In or Out and then the socket's name for a component boundary", () => {
    expect(kindLabelParts("depth", "in")).toEqual({ kind: "in", rest: "depth", joined: false });
    expect(kindLabelParts("in1", "in")).toEqual({ kind: "in", rest: "1", joined: true });
  });
});

describe("the registry: who is told the zoom, and when", () => {
  function canvas(labelCount = 3) {
    const root = document.createElement("div");
    const nodes = document.createElement("div");
    root.append(nodes);
    const labels = Array.from({ length: labelCount }, () => {
      const label = document.createElement("span");
      nodes.append(label);
      return label;
    });
    const registry = createKindLabelRegistry();
    registry.attach(root);
    const leave = labels.map((label) => registry.register(label));
    const writes = labels.map((label) => vi.spyOn(label.style, "setProperty"));
    const zoomOf = (label: HTMLElement) => label.style.getPropertyValue(KIND_LABEL_ZOOM_PROPERTY);
    const totalWrites = () => writes.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    return { root, nodes, labels, registry, leave, zoomOf, totalWrites };
  }

  it("writes nothing at working zoom: no tier on the canvas, no property on any label", () => {
    const { root, labels, registry, zoomOf, totalWrites } = canvas();
    registry.apply(1);
    registry.apply(2.5);
    registry.apply(0.7);

    expect(root.hasAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe(false);
    expect(labels.map(zoomOf)).toEqual(["", "", ""]);
    expect(totalWrites()).toBe(0);
  });

  it("names the tier on the canvas root and tells every label the zoom once it is zoomed out", () => {
    const { root, labels, registry, zoomOf } = canvas();
    registry.apply(0.6);
    expect(root.getAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe("name");
    expect(labels.map(zoomOf)).toEqual(["0.6", "0.6", "0.6"]);

    registry.apply(0.154);
    expect(root.getAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe("kind");
    expect(labels.map(zoomOf)).toEqual(["0.154", "0.154", "0.154"]);
  });

  /*
   * §V142: a camera move must cost nothing. The canvas reports its transform on every
   * frame of a pan, and a pan does not change the zoom, so it must write NOTHING.
   */
  it("does no work for a pan: the same zoom again writes nothing at all", () => {
    const { root, registry, totalWrites } = canvas();
    registry.apply(0.3);
    const afterZoom = totalWrites();
    const setAttribute = vi.spyOn(root, "setAttribute");

    for (let frame = 0; frame < 120; frame += 1) registry.apply(0.3);

    expect(totalWrites()).toBe(afterZoom);
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("writes one property per label per zoom step, and the tier only when a threshold is crossed", () => {
    const { root, registry, totalWrites } = canvas(5);
    registry.apply(0.6);
    const setAttribute = vi.spyOn(root, "setAttribute");
    const before = totalWrites();

    registry.apply(0.58);
    registry.apply(0.56);

    expect(totalWrites() - before).toBe(10);
    expect(setAttribute).not.toHaveBeenCalled();
  });

  /*
   * THE MEASURED REASON FOR THE WHOLE DESIGN: a custom property on an ancestor of the
   * nodes is inherited by every element under every node, and changing it restyles all of
   * them (4.2 ms a zoom step on E79 against 0.35 ms written per label). So the zoom is
   * never written on anything the labels share.
   */
  it("never writes the zoom on the canvas root or on the nodes' common ancestor", () => {
    const { root, nodes, registry } = canvas();
    const onRoot = vi.spyOn(root.style, "setProperty");
    const onNodes = vi.spyOn(nodes.style, "setProperty");

    for (const zoom of [0.6, 0.4, 0.2, 0.05, 0.9, 0.3]) registry.apply(zoom);

    expect(onRoot).not.toHaveBeenCalled();
    expect(onNodes).not.toHaveBeenCalled();
    expect(root.style.getPropertyValue(KIND_LABEL_ZOOM_PROPERTY)).toBe("");
  });

  it("takes the tier off again when zoomed back in, or out past the point where anything fits", () => {
    const { root, registry, totalWrites } = canvas();
    registry.apply(0.3);
    expect(root.getAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe("kind");

    const before = totalWrites();
    registry.apply(0.05);
    expect(root.hasAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe(false);
    // Hidden labels are not told a zoom they have no use for.
    expect(totalWrites()).toBe(before);

    registry.apply(0.3);
    expect(root.getAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe("kind");
    registry.apply(1);
    expect(root.hasAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe(false);
  });

  it("tells a node that appears while zoomed out its size at once, not at the next zoom step", () => {
    const { registry, zoomOf } = canvas(0);
    registry.apply(0.3);
    const late = document.createElement("span");
    registry.register(late);
    expect(zoomOf(late)).toBe("0.3");
  });

  it("does not write on a node that appears at working zoom, and catches it up on the way out", () => {
    const { registry, zoomOf } = canvas(0);
    registry.apply(1);
    const late = document.createElement("span");
    registry.register(late);
    expect(zoomOf(late)).toBe("");

    registry.apply(0.5);
    expect(zoomOf(late)).toBe("0.5");
  });

  it("stops writing to a label whose node is gone", () => {
    const { labels, registry, leave, zoomOf } = canvas();
    registry.apply(0.6);
    leave[0]?.();
    registry.apply(0.3);
    expect(labels.map(zoomOf)).toEqual(["0.6", "0.3", "0.3"]);
  });

  it("moves the tier with the canvas root, and clears it from a root it leaves", () => {
    const { root, registry } = canvas();
    registry.apply(0.3);
    const next = document.createElement("div");

    registry.attach(next);
    expect(root.hasAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe(false);
    expect(next.getAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe("kind");

    registry.attach(null);
    expect(next.hasAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe(false);
  });

  it("keeps two canvases apart: each registry writes only its own root and labels", () => {
    const one = canvas(1);
    const two = canvas(1);
    one.registry.apply(0.3);
    two.registry.apply(0.9);

    expect(one.root.getAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe("kind");
    expect(two.root.hasAttribute(KIND_LABEL_TIER_ATTRIBUTE)).toBe(false);
    expect(two.zoomOf(two.labels[0] as HTMLElement)).toBe("");
  });
});
