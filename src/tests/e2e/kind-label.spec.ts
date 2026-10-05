import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./app.ts";

/**
 * A NODE'S KIND STAYS LEGIBLE AT LOW ZOOM, IN A BROWSER THAT LAYS THINGS OUT (T1597b).
 *
 * The owner: "it's pretty damn hard that we need to zoom in and figure out, ah okay, this
 * is this kind of operator". E79 Crucible, 79 nodes, opens at about 15 %, where a node is
 * 27 px wide and its 11 px header text is under 2. Below 70 % every node now carries one
 * label, its kind and then the rest of its name, that does not shrink with the canvas.
 *
 * ## Why this is a browser spec
 *
 * Every claim that matters about that label is a claim about GEOMETRY, and jsdom lays
 * nothing out (§V339): that the text is the same size on screen at 60 % and at 15 %, that
 * a label never leaves its own node (so two labels cannot collide), and that it changes
 * no node's box (§V389). `kind-label.test.tsx` holds the logic and the cost in writes;
 * this holds what a person would see, measured off the real page.
 *
 * Headless is enough: no pixel is read, and the header chrome renders without a GPU.
 *
 * The example is the dense one the row names. Its node count is not asserted as a number:
 * the claims are per label, over however many nodes it has.
 */

const EXAMPLE = "E79 Crucible";

async function openExample(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "examples" }).click();
  await page.getByRole("button", { name: new RegExp(`^${EXAMPLE}`) }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  // The fit animation and the first measure pass.
  await expect.poll(async () => page.locator('[data-testid^="node-kind-label-"]').count()).toBeGreaterThan(40);
  await page.waitForTimeout(600);
}

const zoomOf = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    return new DOMMatrixReadOnly(viewport === null ? "none" : getComputedStyle(viewport).transform).a;
  });

/** Wheel at the canvas centre until the canvas's own scale is the target, within 1 %. */
async function zoomTo(page: Page, target: number): Promise<void> {
  const box = await page.getByTestId("graph-canvas").boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
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
  /** The furthest any DRAWN part of a label reaches outside its own node, CSS px. */
  readonly furthestOutsideOwnNode: number;
  readonly overlappingPairs: number;
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
    const labels = [...document.querySelectorAll<HTMLElement>('[data-testid^="node-kind-label-"]')];
    const drawn = labels
      .filter((label) => getComputedStyle(label.parentElement as HTMLElement).display !== "none")
      .map((label) => {
        const full = label.getBoundingClientRect();
        const clipBox = label.parentElement as HTMLElement;
        const clip = clipBox.getBoundingClientRect();
        const node = (clipBox.parentElement as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(clipBox);
        const clips = (value: string): boolean => value === "hidden" || value === "clip";
        const right = clips(style.overflowX) ? Math.min(full.right, clip.right) : full.right;
        const bottom = clips(style.overflowY) ? Math.min(full.bottom, clip.bottom) : full.bottom;
        const rest = label.children[1] as HTMLElement | undefined;
        return {
          left: full.left,
          top: full.top,
          right,
          bottom,
          height: full.height,
          outside: Math.max(node.left - full.left, right - node.right, node.top - full.top, bottom - node.bottom, 0),
          rest: rest !== undefined && getComputedStyle(rest).display !== "none",
          word: label.firstElementChild?.textContent ?? "",
        };
      });
    let overlappingPairs = 0;
    for (let a = 0; a < drawn.length; a += 1) {
      for (let b = a + 1; b < drawn.length; b += 1) {
        const one = drawn[a]!;
        const two = drawn[b]!;
        if (one.left < two.right - 0.5 && two.left < one.right - 0.5 && one.top < two.bottom - 0.5 && two.top < one.bottom - 0.5) {
          overlappingPairs += 1;
        }
      }
    }
    const heights = drawn.map((each) => each.height);
    return {
      tier: document.querySelector(".react-flow")?.getAttribute("data-kind-labels") ?? null,
      nodes: labels.length,
      shown: drawn.length,
      withRest: drawn.filter((each) => each.rest).length,
      height: [Math.min(...heights), Math.max(...heights)] as const,
      furthestOutsideOwnNode: Math.max(0, ...drawn.map((each) => each.outside)),
      overlappingPairs,
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

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openExample(page);
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

test("no label leaves its own node, so no two labels can collide, at any of the zooms", async ({ page }) => {
  for (const zoom of [0.6, 0.35, 0.15]) {
    await zoomTo(page, zoom);
    const seen = await measure(page);
    expect(seen.furthestOutsideOwnNode, `at ${String(zoom)} a label reaches outside its node`).toBeLessThanOrEqual(0.5);
    expect(seen.overlappingPairs, `at ${String(zoom)} labels overlap`).toBe(0);
  }
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
