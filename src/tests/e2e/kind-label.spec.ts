import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./app.ts";

// v17-allow-dynamic-color: pixel regression injects distinct status and component strip probes.

/**
 * A NODE'S KIND STAYS LEGIBLE AT LOW ZOOM, IN A BROWSER THAT LAYS THINGS OUT (T1597b),
 * AND IT NEITHER COVERS WHAT THE NODE SHOWS NOR IS COVERED BY IT (B258).
 *
 * The owner: "it's pretty damn hard that we need to zoom in and figure out, ah okay, this
 * is this kind of operator". E79 Crucible, 79 nodes, opens at about 15 %, where a node is
 * 27 px wide and its 11 px header text is under 2. Below 70 % every node now carries one
 * label, its kind and then the rest of its name, that does not shrink with the canvas.
 *
 * And then, on the first version: "the enlarging labels on the nodes now cover the
 * content weirdly on some and on others they get covered. like value operators get covered
 * by the label while previews overlap the thing. both is not great. also there seems to be
 * a space after all the prefixes in labels before the underscore". The label stands on
 * the line under the header now and grows UP, out of the node; the second half of this
 * file holds that, and the join.
 *
 * ## Why this is a browser spec
 *
 * Every claim that matters about that label is a claim about GEOMETRY, and jsdom lays
 * nothing out (§V339): that the text is the same size on screen at 60 % and at 15 %, that
 * a label never crosses into its node's content or over a neighbour, and that it changes
 * no node's box (§V389). `kind-label.test.tsx` holds the logic and the cost in writes;
 * this holds what a person would see, measured off the real page.
 *
 * Headless is enough: the header chrome, including its colour strip, renders without a GPU.
 *
 * ## What "on top" is asked of, and the one thing it cannot be asked
 *
 * `elementFromPoint` answers what is painted on top among the elements that take the
 * pointer, and the label takes none (a press on it is a press on the node). So the probes
 * below switch hit testing on for everything inside the nodes and the wires for the length
 * of one reading; the answer is then the paint order.
 *
 * A LIVE PREVIEW IS NOT AN ELEMENT IN A NODE. One canvas over the whole pane paints every
 * tile, above everything any node draws, and this lane has no GPU to paint one with. So
 * "the picture does not cover the label" is asked as geometry: no part of a label lies in
 * any picture's slot, which is the only place that canvas ever paints. The first test of
 * the second half checks that the canvas is where this says it is.
 *
 * E79 is the dense example the row names; E82 has value nodes, pictures, a Panel and notes
 * side by side. Node counts are not asserted as numbers: the claims are per label.
 */

const DENSE = "E79 Crucible";
const MIXED = "E82 Set List";

async function openExample(page: Page, name: string, atLeast: number): Promise<void> {
  await page.getByRole("tab", { name: "examples" }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  // The fit animation and the first measure pass.
  await expect.poll(async () => page.locator('[data-testid^="node-kind-label-"]').count()).toBeGreaterThan(atLeast);
  await page.waitForTimeout(600);
}

const zoomOf = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    return new DOMMatrixReadOnly(viewport === null ? "none" : getComputedStyle(viewport).transform).a;
  });

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Wheel until the canvas's own scale is the target, within 1 %: at the canvas centre, or
 * about `at`, which stays under the pointer and so stays in view.
 */
async function zoomTo(page: Page, target: number, at?: Point): Promise<void> {
  const box = await page.getByTestId("graph-canvas").boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const point = at ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  for (let step = 0; step < 80; step += 1) {
    const now = await zoomOf(page);
    if (Math.abs(now - target) / target < 0.01) break;
    const delta = Math.max(-240, Math.min(240, -Math.log2(target / now) * 300));
    await page.mouse.wheel(0, Math.abs(delta) < 2 ? Math.sign(delta) * 2 : delta);
    await page.waitForTimeout(40);
  }
  await expect.poll(async () => Math.abs((await zoomOf(page)) - target) / target).toBeLessThan(0.02);
  await page.waitForTimeout(150);
}

interface LabelGeometry {
  readonly tier: string | null;
  readonly nodes: number;
  /** Labels the browser is drawing (their clip box is not `display: none`). */
  readonly shown: number;
  readonly withRest: number;
  /** [min, max] height of a label on screen, CSS px. */
  readonly height: readonly [number, number];
  /** The furthest any DRAWN part of a label reaches past its own node's left or right edge, CSS px. Not an instance's (VNB15). */
  readonly furthestBeyondOwnWidth: number;
  /** The furthest any drawn part reaches BELOW the line under its own node's header, CSS px (B258). */
  readonly furthestBelowHeaderLine: number;
  /** The furthest any label rises above its own node's top edge, CSS px. */
  readonly furthestAboveOwnNode: number;
  readonly overlappingPairs: number;
  /** Labels with a drawn part on a node that is not their own. A note is a region behind the nodes, not a node. */
  readonly onAnotherNode: readonly string[];
  /** Labels with a drawn part inside a picture's or a plot's slot, their own node's or any other's. */
  readonly inASlot: readonly string[];
  readonly firstWords: readonly string[];
}

/**
 * What is on screen, as numbers.
 *
 * The DRAWN part of a label is the label cut by its clip box — but only if that box really
 * clips. The first version of this took the clip box's edge on trust, and so could not
 * fail for the one cause it exists to catch: with the clip's `overflow` switched to
 * `visible` the labels ran out over their neighbours and this still reported them inside
 * (found by breaking it on purpose). So the clip is believed only when the browser says
 * the box hides its overflow; otherwise the label is drawn as wide as it is.
 */
const measure = (page: Page): Promise<LabelGeometry> =>
  page.evaluate(() => {
    interface Box {
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
    }
    // Half a pixel of grace on each axis: two boxes that share an edge do not overlap.
    const overlap = (one: Box, two: Box): boolean =>
      one.left < two.right - 0.5 && two.left < one.right - 0.5 && one.top < two.bottom - 0.5 && two.top < one.bottom - 0.5;
    const labels = [...document.querySelectorAll<HTMLElement>('[data-testid^="node-kind-label-"]')];
    const wrappers = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].filter(
      (wrapper) => wrapper.querySelector('[data-testid^="annotation-"]') === null,
    );
    const slots = [...document.querySelectorAll<HTMLElement>('[data-testid^="node-preview-"]')].map((slot) =>
      slot.getBoundingClientRect(),
    );
    const drawn = labels
      .filter((label) => getComputedStyle(label.parentElement as HTMLElement).display !== "none")
      .map((label) => {
        const full = label.getBoundingClientRect();
        const clipBox = label.parentElement as HTMLElement;
        const clip = clipBox.getBoundingClientRect();
        const own = clipBox.parentElement as HTMLElement;
        const node = own.getBoundingClientRect();
        const header = (own.querySelector("header") as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(clipBox);
        const clips = (value: string): boolean => value === "hidden" || value === "clip";
        const left = clips(style.overflowX) ? Math.max(full.left, clip.left) : full.left;
        const right = clips(style.overflowX) ? Math.min(full.right, clip.right) : full.right;
        const top = clips(style.overflowY) ? Math.max(full.top, clip.top) : full.top;
        const bottom = clips(style.overflowY) ? Math.min(full.bottom, clip.bottom) : full.bottom;
        const rest = label.children[1] as HTMLElement | undefined;
        const wrapper = label.closest(".react-flow__node");
        const box: Box = { left, top, right, bottom };
        return {
          ...box,
          id: (label.dataset["testid"] ?? "").slice("node-kind-label-".length),
          height: full.height,
          beyondWidth: Math.max(node.left - left, right - node.right, 0),
          belowHeaderLine: Math.max(bottom - header.bottom, 0),
          aboveNode: Math.max(node.top - top, 0),
          onAnotherNode: wrappers.some((other) => other !== wrapper && overlap(box, other.getBoundingClientRect())),
          inASlot: slots.some((slot) => overlap(box, slot)),
          rest: rest !== undefined && getComputedStyle(rest).display !== "none",
          word: label.firstElementChild?.textContent ?? "",
          instance: clipBox.dataset["instance"] !== undefined,
        };
      });
    /*
     * VNB15 — by the owner's ruling of 2026-10-07 (option (b)), a COMPONENT INSTANCE's label
     * is not clipped at its node's edge: its kind is its component's whole name, which the
     * clip cut to `sta` on the stage previz. It runs on as far as the next node in its row.
     * So an instance is exempt from ONE claim, staying inside its own width; it is held to
     * every other one below like any node: on no other node, no picture, no other label.
     * `component-name-labels.spec.ts` holds that it reads whole where its row has room.
     */
    const plain = drawn.filter((each) => !each.instance);
    let overlappingPairs = 0;
    for (let a = 0; a < drawn.length; a += 1) {
      for (let b = a + 1; b < drawn.length; b += 1) {
        if (overlap(drawn[a]!, drawn[b]!)) overlappingPairs += 1;
      }
    }
    const heights = drawn.map((each) => each.height);
    return {
      tier: document.querySelector(".react-flow")?.getAttribute("data-kind-labels") ?? null,
      nodes: labels.length,
      shown: drawn.length,
      withRest: drawn.filter((each) => each.rest).length,
      height: [Math.min(...heights), Math.max(...heights)] as const,
      furthestBeyondOwnWidth: Math.max(0, ...plain.map((each) => each.beyondWidth)),
      furthestBelowHeaderLine: Math.max(0, ...drawn.map((each) => each.belowHeaderLine)),
      furthestAboveOwnNode: Math.max(0, ...drawn.map((each) => each.aboveNode)),
      overlappingPairs,
      onAnotherNode: drawn.filter((each) => each.onAnotherNode).map((each) => each.id),
      inASlot: drawn.filter((each) => each.inASlot).map((each) => each.id),
      firstWords: [...new Set(drawn.map((each) => each.word))].sort(),
    };
  });

/** Every node's box in FLOW units, so two readings at one zoom can be compared exactly. */
const nodeBoxes = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    const zoom = new DOMMatrixReadOnly(viewport === null ? "none" : getComputedStyle(viewport).transform).a;
    return [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
      .map((node) => {
        const box = node.getBoundingClientRect();
        return `${node.dataset["id"]}:${(box.width / zoom).toFixed(1)}x${(box.height / zoom).toFixed(1)}`;
      })
      .sort()
      .join("|");
  });

test.describe("T1597b — the label, on the dense example", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await openExample(page, DENSE, 40);
  });

  test("at working zoom no node carries the label: the header is readable and nothing is added", async ({ page }) => {
    await zoomTo(page, 1);
    const seen = await measure(page);
    expect(seen.tier).toBeNull();
    expect(seen.nodes).toBeGreaterThan(40);
    expect(seen.shown).toBe(0);
  });

  test("zoomed out, every node says its kind at a size that does not shrink with the canvas", async ({ page }) => {
    await zoomTo(page, 0.6);
    const at60 = await measure(page);
    await zoomTo(page, 0.35);
    const at35 = await measure(page);
    await zoomTo(page, 0.15);
    const at15 = await measure(page);

    // Every node, not most of them: the label is on the node, not on a list of chosen types.
    for (const seen of [at60, at35, at15]) expect(seen.shown).toBe(seen.nodes);

    // THE SIZE. A canvas at 15 % draws its own 11 px text at 1.65 px. The label's box is the
    // same height on screen at all three zooms, to a tenth of a pixel, and tall enough to hold
    // text a person can read.
    expect(at60.height[0]).toBeGreaterThan(12);
    for (const seen of [at60, at35, at15]) expect(seen.height[1] - seen.height[0]).toBeLessThan(0.1);
    expect(Math.abs(at35.height[0] - at60.height[0])).toBeLessThan(0.1);
    expect(Math.abs(at15.height[0] - at60.height[0])).toBeLessThan(0.1);

    // WHAT IT SAYS. The name while there is room, then the kind alone.
    expect(at60.tier).toBe("name");
    expect(at60.withRest).toBeGreaterThan(0);
    expect(at35.tier).toBe("kind");
    expect(at35.withRest).toBe(0);
    expect(at15.tier).toBe("kind");
    // And the words are KINDS, from the node's type: this example names almost nothing for
    // its kind yet, and reads `kernel`, `geometry`, `wgsl` all the same.
    expect(at15.firstWords).toEqual(expect.arrayContaining(["geometry", "kernel", "light", "material", "wgsl"]));
  });

  test("the growing label retains the node's colour strip and component identity at every zoom", async ({ page }) => {
    for (const zoom of [0.35, 0.6, 0.15]) {
      await zoomTo(page, zoom);
      // Pick a visible part of a plate, before its right-edge fade. Endpoint colours make its strip
      // distinguishable from text, family tint and the normal status palette.
      const probeId = await page.evaluate(() => {
        const pane = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect();
        const label = [...document.querySelectorAll<HTMLElement>('[data-testid^="node-kind-label-"]')].find((candidate) => {
          const box = candidate.getBoundingClientRect();
          const clip = candidate.parentElement!.getBoundingClientRect();
          const right = Math.min(box.right, clip.right);
          return box.left > pane.left + 8 && box.top > pane.top + 8
            && right < pane.right - 8 && box.bottom < pane.bottom - 8
            && right - box.left >= 20;
        });
        if (label === undefined) throw new Error("no kind label has a visible colour-strip probe");
        const node = label.parentElement!.parentElement!;
        node.removeAttribute("data-component");
        node.style.setProperty("--status-color", "rgb(0, 255, 255)");
        node.style.setProperty("--component", "rgb(255, 128, 0)");
        return label.dataset["testid"]!;
      });
      const label = page.getByTestId(probeId);
      const before = await label.boundingBox();
      if (before === null) throw new Error("the colour-strip probe has no box");
      expect(await label.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
      const width = Math.min(12, before.width - 6);

      const colourPixels = async (component: boolean): Promise<number> => {
        const box = await label.boundingBox();
        if (box === null) throw new Error("the colour-strip probe has no box");
        const shot = await page.screenshot({ clip: { x: box.x + 3, y: box.y, width, height: 3 } });
        return page.evaluate(async ({ base64, component }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (context === null) throw new Error("the screenshot decoder has no 2D context");
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const r = pixels[offset]!;
            const g = pixels[offset + 1]!;
            const b = pixels[offset + 2]!;
            // Fractional layout can split a one-pixel hairline over two raster rows.
            if (component ? r > b + 80 && r > g + 30 : g > r + 80 && b > r + 80) count += 1;
          }
          return count;
        }, { base64: shot.toString("base64"), component });
      };

      expect(await colourPixels(false), `status strip at ${String(zoom)}`).toBeGreaterThan(width * 0.6);
      await label.evaluate((element) => element.parentElement!.parentElement!.setAttribute("data-component", "true"));
      expect(await colourPixels(true), `component strip at ${String(zoom)}`).toBeGreaterThan(width * 0.6);
      const after = await label.boundingBox();
      expect(after?.width).toBeCloseTo(before.width, 4);
      expect(after?.height).toBeCloseTo(before.height, 4);
    }
  });

  /**
   * B258 — WHERE A LABEL MAY BE, on 79 nodes at once.
   *
   * It stays within its node's width; it never goes below the line under its header, which
   * is where the node's content starts; it lies in no picture's or plot's slot, its own or
   * a neighbour's (a tile is painted over everything there); and it lies on no other node
   * and on no other label.
   *
   * The last two are arithmetic, not luck, down to 22 %: the header band and the 36 px the
   * layout rule keeps above every node are 59 × zoom on screen and the label is 13.2.
   * At 15 % a label needs 65 of the node's px above it. This layout's tightest stack has
   * 86, so the count is 0 here too; a layout packed to the rule's minimum would not pass
   * at 15 %, and `kind-label.ts` says what happens then.
   */
  test("a label keeps to its node's width and the room above its header line, on no content and no neighbour", async ({
    page,
  }) => {
    for (const zoom of [0.6, 0.35, 0.15]) {
      await zoomTo(page, zoom);
      const seen = await measure(page);
      const at = `at ${String(zoom)}`;
      expect(seen.shown, `${at} the labels are showing`).toBeGreaterThan(40);
      expect(seen.furthestBeyondOwnWidth, `${at} a label runs past its node's side`).toBeLessThanOrEqual(0.5);
      expect(seen.furthestBelowHeaderLine, `${at} a label crosses the line under its header, onto the content`).toBeLessThanOrEqual(0.5);
      expect(seen.inASlot, `${at} a label lies in a picture's slot, where a tile is painted over it`).toEqual([]);
      expect(seen.onAnotherNode, `${at} a label lies on a node that is not its own`).toEqual([]);
      expect(seen.overlappingPairs, `${at} labels overlap`).toBe(0);
    }
    // And it does leave the box: at 15 % the header band is 3.6 px and the label is 13.
    // Without this the claims above would hold for a label squeezed into the band.
    expect((await measure(page)).furthestAboveOwnNode).toBeGreaterThan(8);
  });

  test("the label costs no layout: every node's box is the same with it and without it (§V389)", async ({ page }) => {
    await zoomTo(page, 0.35);
    const withLabels = await nodeBoxes(page);
    expect((await measure(page)).shown).toBeGreaterThan(40);

    // Take the labels away the way zooming in does, without moving the canvas.
    await page.evaluate(() => document.querySelector(".react-flow")?.removeAttribute("data-kind-labels"));
    expect((await measure(page)).shown).toBe(0);

    expect(await nodeBoxes(page)).toBe(withLabels);
  });

  /**
   * §V142/§V16: a camera move must cost nothing. What can be observed from outside is the
   * DOM: a re-render that changed anything, or a write to anything but a label, would show
   * as a mutation under the nodes.
   */
  test("a pan changes nothing under the nodes, and a zoom changes only the labels' own style", async ({ page }) => {
    await zoomTo(page, 0.5);
    const box = await page.getByTestId("graph-canvas").boundingBox();
    if (box === null) throw new Error("the canvas has no box");

    const watch = () =>
      page.evaluate(() => {
        const counts: Record<string, number> = {};
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target as HTMLElement;
            const label = (target.dataset?.["testid"] ?? "").startsWith("node-kind-label-");
            const what = `${record.type}:${record.attributeName ?? ""}:${label ? "label" : "other"}`;
            counts[what] = (counts[what] ?? 0) + 1;
          }
        });
        observer.observe(document.querySelector(".react-flow__nodes") as Element, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
        (window as unknown as { __kindLabelWatch: { observer: MutationObserver; counts: Record<string, number> } }).__kindLabelWatch = {
          observer,
          counts,
        };
      });
    const stop = () =>
      page.evaluate(() => {
        const held = (window as unknown as { __kindLabelWatch: { observer: MutationObserver; counts: Record<string, number> } })
          .__kindLabelWatch;
        held.observer.disconnect();
        return held.counts;
      });

    await watch();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "middle" });
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(box.x + box.width / 2 + step * 12, box.y + box.height / 2 + step * 6);
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: "middle" });
    await page.waitForTimeout(200);
    expect(await stop()).toEqual({});

    const labels = await page.locator('[data-testid^="node-kind-label-"]').count();
    await watch();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -12);
    await page.waitForTimeout(250);
    const zoomed = await stop();
    // One zoom step: each label's own `style` (the zoom it is told), and nothing else at all.
    expect(Object.keys(zoomed)).toEqual(["attributes:style:label"]);
    expect((zoomed["attributes:style:label"] ?? 0) % labels).toBe(0);
  });
});

/* ---- B258: what is on top of what, and the join ------------------------------------- */

/** A point in the header of a value node: zooming about it keeps it, the pictures round it and the Panel in view. */
const valueNodeHeader = (page: Page): Promise<Point> =>
  page.evaluate(() => {
    const node = document.querySelector('[data-testid^="value-plot-"]')?.closest(".react-flow__node");
    if (node === null || node === undefined) throw new Error("the example has no value node");
    const box = node.getBoundingClientRect();
    return { x: box.left + 3, y: box.top + 2 };
  });

interface Probes {
  /** Nodes of this sort wholly inside the pane, with the room above them. */
  nodes: number;
  /** Points taken inside labels' own rectangles, and how many of them the label is on top at. */
  labelPoints: number;
  labelOnTop: number;
  /** Points taken in the node's body just under the header line, and how many a label is on top at. */
  bodyPoints: number;
  bodyUnderALabel: number;
}

interface OnTop {
  /** By what the node shows under its header: a value's readout and plot, a picture, a Panel's controls, or ports alone. */
  readonly value: Probes;
  readonly picture: Probes;
  readonly controls: Probes;
  readonly plain: Probes;
  /** Is the canvas that paints every preview tile on top at the middle of a label? `null`: there is no such canvas. */
  readonly tileSurfaceOverLabels: boolean | null;
}

/**
 * WHAT IS PAINTED ON TOP, asked of the browser at points, for every labelled node the pane
 * shows whole.
 *
 * Hit testing is switched on for everything inside the nodes and the wires for the length
 * of the reading (the label itself takes no pointer), so `elementsFromPoint` is the paint
 * order. The first answer INSIDE the canvas's own content is the one taken: the pane's own
 * chrome (a gizmo handle, the map) is over the whole graph by design and is not what this
 * asks about.
 */
const whatIsOnTop = (page: Page): Promise<OnTop> =>
  page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ".react-flow__nodes *, .react-flow__edges * { pointer-events: auto !important; }";
    document.head.append(style);
    const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
    const pane = (document.querySelector('[data-testid="graph-canvas"]') as HTMLElement).getBoundingClientRect();
    const topAt = (x: number, y: number): Element | null =>
      document.elementsFromPoint(x, y).find((element) => viewport.contains(element)) ?? null;
    const empty = (): { nodes: number; labelPoints: number; labelOnTop: number; bodyPoints: number; bodyUnderALabel: number } => ({
      nodes: 0,
      labelPoints: 0,
      labelOnTop: 0,
      bodyPoints: 0,
      bodyUnderALabel: 0,
    });
    const seen = { value: empty(), picture: empty(), controls: empty(), plain: empty() };
    let middle: { x: number; y: number } | null = null;

    for (const label of document.querySelectorAll<HTMLElement>('[data-testid^="node-kind-label-"]')) {
      const clip = label.parentElement as HTMLElement;
      if (getComputedStyle(clip).display === "none") continue;
      const node = clip.parentElement as HTMLElement;
      const box = node.getBoundingClientRect();
      // Whole, and with the room above it that a label may use: elsewhere another pane is on top.
      if (!(box.left > pane.left + 8 && box.right < pane.right - 8 && box.top > pane.top + 24 && box.bottom < pane.bottom - 8)) continue;

      const controls = node.querySelector<HTMLElement>('[class*="_controls_"]');
      const sort =
        node.querySelector('[data-testid^="value-plot-"]') !== null
          ? "value"
          : node.querySelector('[data-testid^="node-preview-"]') !== null
            ? "picture"
            : controls !== null && controls.getBoundingClientRect().height > 0
              ? "controls"
              : "plain";
      const into = seen[sort];
      into.nodes += 1;

      const full = label.getBoundingClientRect();
      const cut = clip.getBoundingClientRect();
      const left = Math.max(full.left, cut.left);
      const right = Math.min(full.right, cut.right);
      const top = Math.max(full.top, cut.top);
      const bottom = Math.min(full.bottom, cut.bottom);
      // Across the part that is drawn solid: the last eighth of the node's width fades out.
      for (const fx of [0.1, 0.45, 0.8]) {
        for (const fy of [0.2, 0.5, 0.8]) {
          const x = left + (right - left) * fx;
          const y = top + (bottom - top) * fy;
          into.labelPoints += 1;
          if (label.contains(topAt(x, y))) into.labelOnTop += 1;
        }
      }
      // For the question below: the middle of a label that none of the pane's own chrome is over.
      const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };
      const first = document.elementFromPoint(centre.x, centre.y);
      if (middle === null && first !== null && viewport.contains(first)) middle = centre;

      // The body starts at the line under the header: a value's first row, the top of a picture.
      const header = (node.querySelector("header") as HTMLElement).getBoundingClientRect();
      for (const down of [1.5, 5, 9]) {
        const y = header.bottom + down;
        if (y > box.bottom - 1) continue;
        for (const fx of [0.06, 0.3, 0.6, 0.9]) {
          into.bodyPoints += 1;
          const on = topAt(box.left + box.width * fx, y);
          if (on !== null && on.closest('[data-testid^="node-kind-label-"]') !== null) into.bodyUnderALabel += 1;
        }
      }
    }

    // The canvas that paints every tile takes no pointer either; ask where it is in the order.
    const surface = document.querySelector<HTMLElement>('canvas[class*="previewSurface"]');
    let tileSurfaceOverLabels: boolean | null = null;
    if (surface !== null && middle !== null) {
      surface.style.pointerEvents = "auto";
      tileSurfaceOverLabels = document.elementFromPoint(middle.x, middle.y) === surface;
      surface.style.pointerEvents = "";
    }
    style.remove();
    return { ...seen, tileSurfaceOverLabels };
  });

interface Join {
  readonly text: string;
  /** Where the part after the kind starts, from the start of the kind, as drawn. */
  readonly drawn: number;
  /** The same in ONE span of the same text and style: the font's own advance. */
  readonly inOneSpan: number;
  /** The kind's letters, and the 3.4em floor it elides down to, in the same px. */
  readonly kindWidth: number;
  readonly floor: number;
  readonly kindLetters: number;
}

/**
 * THE JOIN, measured against the font.
 *
 * A name is drawn in parts (the kind, the join, the role) so the kind can be the heavy
 * part or the part that gives way. Drawn in parts it must still read as one name, so the
 * part after the kind starts exactly where it would if the whole name were one run of
 * text. The reference is that run: the same text in one span inside the same element, so
 * it has the same font, weight, stretch and tracking, and the offset of the character
 * after the kind is read off it.
 *
 * `headers`: every name at rest that is in parts and not elided. `labels`: every low-zoom
 * label that continues its kind (`slider` + `_master`); the reference there is in the
 * KIND's style, which is the style the kind's last letter advances in.
 */
const joins = (page: Page): Promise<{ readonly headers: readonly Join[]; readonly labels: readonly Join[] }> =>
  page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    const zoom = new DOMMatrixReadOnly(viewport === null ? "none" : getComputedStyle(viewport).transform).a;
    const lettersOf = (element: Element): DOMRect => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    const inOneSpan = (host: HTMLElement, text: string, at: number): number => {
      const probe = document.createElement("span");
      probe.textContent = text;
      probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;pointer-events:none";
      host.append(probe);
      const range = document.createRange();
      range.setStart(probe.firstChild as Text, at);
      range.setEnd(probe.firstChild as Text, at + 1);
      const offset = range.getBoundingClientRect().left - probe.getBoundingClientRect().left;
      probe.remove();
      return offset;
    };

    const headers = [...document.querySelectorAll<HTMLElement>('[data-testid^="node-name-"]')]
      .filter((name) => name.children.length === 3)
      .map((name) => ({ name, kind: name.children[0] as HTMLElement, join: name.children[1] as HTMLElement }))
      // An elided kind ends in an ellipsis: what is drawn is not the whole word, and the test of the floor is below.
      .filter(({ kind }) => lettersOf(kind).width <= kind.getBoundingClientRect().width + 0.5)
      .map(({ name, kind, join }) => ({
        text: name.textContent ?? "",
        // In the node's own px, so the numbers read the same at any zoom.
        drawn: (lettersOf(join).left - kind.getBoundingClientRect().left) / zoom,
        inOneSpan: inOneSpan(name, name.textContent ?? "", (kind.textContent ?? "").length) / zoom,
        kindWidth: lettersOf(kind).width / zoom,
        floor: Number.parseFloat(getComputedStyle(kind).fontSize) * 3.4,
        kindLetters: (kind.textContent ?? "").length,
      }));

    const labels = [...document.querySelectorAll<HTMLElement>('[data-testid^="node-kind-label-"]')]
      .filter((label) => getComputedStyle(label.parentElement as HTMLElement).display !== "none")
      .map((label) => ({ kind: label.children[0] as HTMLElement, rest: label.children[1] as HTMLElement | undefined }))
      .filter(({ rest }) => rest !== undefined && rest.dataset["joined"] === "true" && getComputedStyle(rest).display !== "none")
      .map(({ kind, rest }) => {
        const whole = `${kind.textContent ?? ""}${rest?.textContent ?? ""}`;
        return {
          text: whole,
          // On screen: the label undoes the canvas's zoom, so its px are screen px.
          drawn: lettersOf(rest as HTMLElement).left - kind.getBoundingClientRect().left,
          inOneSpan: inOneSpan(kind, whole, (kind.textContent ?? "").length),
          kindWidth: lettersOf(kind).width,
          floor: Number.parseFloat(getComputedStyle(kind).fontSize) * 3.4,
          kindLetters: (kind.textContent ?? "").length,
        };
      });
    return { headers, labels };
  });

/** The largest difference between where the join is drawn and where the font puts it, and whose it is. */
const worstJoin = (rows: readonly Join[]): { readonly off: number; readonly text: string } =>
  rows.reduce(
    (worst, row) => (Math.abs(row.drawn - row.inOneSpan) > worst.off ? { off: Math.abs(row.drawn - row.inOneSpan), text: row.text } : worst),
    { off: 0, text: "" },
  );

test.describe("B258 — the label neither covers what a node shows nor is covered by it", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await openExample(page, MIXED, 15);
  });

  /**
   * The owner's sentence, as the three things it rules out, on a value node, a node with a
   * picture and the Panel side by side in one document, at 60 %, 35 % and 15 %.
   *
   *  - "value operators get covered by the label": just under the header line, where a
   *    value node draws its first row, no label is on top at any point.
   *  - "previews overlap the thing": no label lies in a picture's slot. That is where the
   *    pane's own canvas paints the tile, above every node (asserted first, or the
   *    geometry would be answering the wrong question).
   *  - and the label is what is drawn at its own rectangle: at every point of it, it is on
   *    top of everything in the graph.
   */
  test("on a value node, a picture node and a Panel, at 60 %, 35 % and 15 %", async ({ page }) => {
    const anchor = await valueNodeHeader(page);
    for (const zoom of [0.6, 0.35, 0.15]) {
      await zoomTo(page, zoom, anchor);
      const at = `at ${String(zoom)}`;
      const top = await whatIsOnTop(page);
      const geometry = await measure(page);

      // A value node and a picture node, in the same pane at the same zoom, or nothing was compared.
      expect(top.value.nodes, `${at} a value node is in view`).toBeGreaterThan(0);
      expect(top.picture.nodes, `${at} a node with a picture is in view`).toBeGreaterThan(0);
      if (zoom < 0.6) expect(top.controls.nodes, `${at} the Panel is in view`).toBeGreaterThan(0);

      for (const [sort, probes] of Object.entries({ value: top.value, picture: top.picture, controls: top.controls, plain: top.plain })) {
        expect(probes.labelOnTop, `${at}, ${sort}: the label is on top at every point of its own rectangle`).toBe(probes.labelPoints);
        expect(probes.bodyUnderALabel, `${at}, ${sort}: a label is drawn over the node's content`).toBe(0);
      }
      expect(top.value.bodyPoints + top.picture.bodyPoints, `${at} content was probed`).toBeGreaterThan(0);

      // The premise of the next line: the tile surface is over everything in the nodes, so a
      // label in a slot would be under a tile whatever the label's own place in its node.
      expect(top.tileSurfaceOverLabels, `${at} the canvas that paints the tiles is over everything in the nodes`).toBe(true);
      expect(geometry.inASlot, `${at} a label lies in a picture's or a plot's slot`).toEqual([]);
      expect(geometry.furthestBelowHeaderLine, `${at} a label crosses the line under its header`).toBeLessThanOrEqual(0.5);
      expect(geometry.onAnotherNode, `${at} a label lies on a node that is not its own`).toEqual([]);
      expect(geometry.overlappingPairs, `${at} labels overlap`).toBe(0);
    }
  });

  /**
   * "there seems to be a space after all the prefixes in labels before the underscore".
   *
   * It was in the header at rest: `slider _master`, 6.8 px of nothing before the join,
   * because the kind's elision floor was a minimum WIDTH and `slider` is narrower than it.
   * The case is named below so the test cannot pass on a canvas that has none: a kind of
   * five letters or more whose letters are narrower than the floor.
   */
  test("the join reads as one name: after the kind, the rest starts where the font would put it", async ({ page }) => {
    const anchor = await valueNodeHeader(page);

    await zoomTo(page, 1, anchor);
    const atRest = (await joins(page)).headers;
    expect(atRest.length, "names in parts on the canvas").toBeGreaterThan(10);
    const underTheFloor = atRest.filter((row) => row.kindLetters > 4 && row.kindWidth < row.floor - 1);
    expect(underTheFloor.length, "names whose kind is narrower than its elision floor, where the gap was").toBeGreaterThan(3);
    const header = worstJoin(atRest);
    expect(header.off, `in the header, "${header.text}" draws its join ${header.off.toFixed(2)} px from where one span puts it`).toBeLessThan(0.5);

    await zoomTo(page, 0.6, anchor);
    const lowZoom = (await joins(page)).labels;
    expect(lowZoom.length, "labels that continue their kind").toBeGreaterThan(10);
    const label = worstJoin(lowZoom);
    expect(label.off, `in the label, "${label.text}" draws its join ${label.off.toFixed(2)} px from where one span puts it`).toBeLessThan(0.5);
  });

  /**
   * The floor the gap came from is still a floor (T1593b): a name too long for the header
   * gives up its KIND first, down to about three letters and the dots, and no further.
   * Renamed through the real field, because the floor only shows when a name does not fit.
   */
  test("a name too long for the header still elides its kind to the floor, and no further", async ({ page }) => {
    const name = page.locator('[data-testid^="node-name-"]', { hasText: /^transform_/ }).first();
    const box = await name.boundingBox();
    if (box === null) throw new Error("the example has no Transform");
    await zoomTo(page, 1, { x: box.x + 1, y: box.y + 1 });

    await name.dblclick();
    const field = page.locator('[data-testid^="node-name-input-"]');
    await field.fill("the_quick_brown_fox_jumps");
    await field.press("Enter");
    const renamed = page.locator('[data-testid^="node-name-"]', { hasText: "transform_the_quick_brown_fox_jumps" });
    await expect(renamed).toHaveCount(1);

    const seen = await renamed.evaluate((element) => {
      const [kind, join, role] = [...element.children] as HTMLElement[];
      if (kind === undefined || join === undefined || role === undefined) throw new Error("the name is not in parts");
      // A word is cut when its letters are wider than the box they are drawn in.
      const cut = (part: HTMLElement): boolean => {
        const range = document.createRange();
        range.selectNodeContents(part);
        return range.getBoundingClientRect().width > part.getBoundingClientRect().width + 0.5;
      };
      // In the node's own px: the canvas is within a percent of 100 %, and a percent of 37 px is the tolerance.
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
      const zoom = new DOMMatrixReadOnly(viewport === null ? "none" : getComputedStyle(viewport).transform).a;
      return {
        kindBox: kind.getBoundingClientRect().width / zoom,
        kindElided: cut(kind),
        floor: Number.parseFloat(getComputedStyle(kind).fontSize) * 3.4,
        joinAfterKind: (join.getBoundingClientRect().left - kind.getBoundingClientRect().right) / zoom,
        roleElided: cut(role),
        roleBeyondName: (role.getBoundingClientRect().right - element.getBoundingClientRect().right) / zoom,
      };
    });
    expect(seen.kindElided, "the kind is the part that gave way").toBe(true);
    expect(Math.abs(seen.kindBox - seen.floor), `the kind stopped at its floor of ${seen.floor.toFixed(1)} px`).toBeLessThan(0.5);
    // Box to box. Inside the kind's box the dots follow its last WHOLE letter, so up to a
    // letter's width of the floor is empty after them (`tran… _the_quic…`): that is how an
    // ellipsis is cut, it was so before B258, and it is not what this line measures.
    expect(Math.abs(seen.joinAfterKind), "the join's box follows the elided kind's box").toBeLessThan(0.5);
    // 25 letters do not fit beside a three-letter kind either, so the role ends in dots too: both are cut, in that order.
    expect(seen.roleElided).toBe(true);
    expect(seen.roleBeyondName, "the role ends inside the name's slot").toBeLessThanOrEqual(0.5);
  });

  /**
   * The label now rises out of the top of the node, which is where the debug timing
   * readout stands (T1010: "floating outside, next to but still attached"). With both on,
   * the readout moves up by what the label takes: the two never overlap, and the readout
   * is still attached, standing within a few px of the top of the label.
   */
  test("the timing readout stands clear of the label, and on top of it", async ({ page }) => {
    const anchor = await valueNodeHeader(page);
    await zoomTo(page, 0.35, anchor);

    // An empty spot of canvas for the right-click: the Debug rows are on the canvas's own menu.
    const spot = await page.evaluate(() => {
      const pane = (document.querySelector('[data-testid="graph-canvas"]') as HTMLElement).getBoundingClientRect();
      for (let y = pane.bottom - 30; y > pane.top + 30; y -= 20) {
        for (let x = pane.left + 30; x < pane.right - 30; x += 20) {
          if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane") === true) return { x, y };
        }
      }
      throw new Error("no empty canvas to open the menu on");
    });
    await page.mouse.click(spot.x, spot.y, { button: "right" });
    await page.getByRole("menuitem", { name: "Debug" }).hover();
    await page.getByRole("menuitem", { name: "Node timings" }).click();
    await expect.poll(async () => page.locator('[data-testid^="node-timing-value-"]').count()).toBeGreaterThan(15);

    for (const zoom of [0.35, 0.15]) {
      await zoomTo(page, zoom, anchor);
      const seen = await page.evaluate(() => {
        let readouts = 0;
        let overlapping = 0;
        let furthestApart = 0;
        for (const value of document.querySelectorAll<HTMLElement>('[data-testid^="node-timing-value-"]')) {
          const readout = (value.parentElement as HTMLElement).getBoundingClientRect();
          const label = value.closest(".react-flow__node")?.querySelector<HTMLElement>('[data-testid^="node-kind-label-"]');
          if (label === null || label === undefined) continue;
          const drawn = label.getBoundingClientRect();
          readouts += 1;
          if (readout.bottom > drawn.top + 0.5 && readout.top < drawn.bottom - 0.5) overlapping += 1;
          furthestApart = Math.max(furthestApart, drawn.top - readout.bottom);
        }
        return { readouts, overlapping, furthestApart };
      });
      expect(seen.readouts, `at ${String(zoom)} the readouts are showing`).toBeGreaterThan(15);
      expect(seen.overlapping, `at ${String(zoom)} a readout shares the label's rows`).toBe(0);
      expect(seen.furthestApart, `at ${String(zoom)} a readout floats away from its label`).toBeLessThan(2);
    }
  });
});
