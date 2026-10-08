import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, openApp, viewportSettled } from "./app.ts";

/**
 * VNB15 — A COMPONENT INSTANCE'S NAME IS NOT CROPPED TO THREE LETTERS.
 *
 * Reported 2026-10-06. On the owner's stage previz, fitted at about 14 %, the instances
 * read `sta`, `sta`, `pro`, `haz`, `wor`: stagecamera1, stagefeeds1 and stageset1 became
 * the same three letters. The cause is T1597b's low-zoom label, which is clipped at its
 * node's width — and an instance's KIND is its component's whole name, the longest and
 * the most telling word on the canvas. By the owner's ruling (2026-10-07, option (b), after
 * seeing option (a)'s uncapped label run over E79's next row at 10 %) an instance's label
 * runs past its node's edge AS FAR AS THE NEXT NODE IN ITS ROW: whole where there is room,
 * cut there, on no neighbour and no neighbour's label, and its hover gives the whole name.
 * Every other node keeps the clip, and the legitimate case is asserted with it: a plain
 * node whose kind is wider than the node is still cut at its edge.
 *
 * The second half is T1593b's header at working zoom, which elides a long name's KIND
 * first to a three-letter floor (`dep…_frontwall_left`). For an instance the kind is the
 * component's name, so there the ROLE gives way first and the kind is cut last.
 *
 * E47 Hologram has two instances of DepthPoints; one is renamed to a long role before the
 * document is opened. Geometry only, so the headless lane: no GPU.
 */

test.use({ viewport: APP_VIEWPORT });

const LONG_ROLE = "depthpoints_frontwall_left";

async function openHologram(page: Page): Promise<void> {
  const shipped = JSON.parse(await readFile(join(process.cwd(), "examples/E47-Hologram.loom.json"), "utf8")) as {
    graph: { nodes: Record<string, { label?: string; size?: { width: number; height: number } }> };
  };
  const holo2 = shipped.graph.nodes["holo2"];
  if (holo2 === undefined) throw new Error("E47 no longer has its second DepthPoints instance");
  holo2.label = LONG_ROLE;
  // Wide enough that the component's name fits whole beside a role cut to its floor, and
  // too narrow for the whole name: the width where the order of giving way decides.
  holo2.size = { width: 220, height: 160 };
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: "hologram.loom.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(shipped)) });
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await viewportSettled(page);
}

const zoomOf = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    return new DOMMatrixReadOnly(viewport === null ? "none" : getComputedStyle(viewport).transform).a;
  });

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
  await viewportSettled(page);
}

interface LabelBox {
  readonly name: string;
  readonly instance: boolean;
  /** The label as laid out, before any clip. */
  readonly full: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  /** What of it is DRAWN: cut by every ancestor that hides its overflow, and by a fading mask. */
  readonly drawn: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  readonly node: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  readonly title: string | null;
}

/**
 * Every shown low-zoom label, from the browser's computed styles and boxes, so a clip that
 * really clips is counted and one switched off is not.
 */
const labelBoxes = (page: Page): Promise<LabelBox[]> =>
  page.evaluate(() => {
    const plain = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    return [...document.querySelectorAll<HTMLElement>('[data-testid^="node-kind-label-"]')]
      .filter((label) => getComputedStyle(label.parentElement as HTMLElement).display !== "none")
      .map((label) => {
        const wrapper = label.closest<HTMLElement>(".react-flow__node") as HTMLElement;
        const full = label.getBoundingClientRect();
        let { left, right, top, bottom } = full;
        for (let element = label.parentElement; element !== null && element !== wrapper; element = element.parentElement) {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (style.overflowX !== "visible") {
            left = Math.max(left, rect.left);
            right = Math.min(right, rect.right);
          }
          if (style.overflowY !== "visible") {
            top = Math.max(top, rect.top);
            bottom = Math.min(bottom, rect.bottom);
          }
          if (style.maskImage !== "none") right = Math.min(right, rect.left + rect.width * 0.875);
        }
        return {
          name: wrapper.querySelector('[data-testid^="node-name-"]')?.textContent ?? "",
          instance: (label.parentElement as HTMLElement).dataset["instance"] !== undefined,
          full: plain(full),
          drawn: { left, right: Math.max(left, right), top, bottom },
          node: plain(wrapper.getBoundingClientRect()),
          title: label.getAttribute("title"),
        };
      });
  });

type Box = LabelBox["drawn"];
// Half a pixel of grace: two boxes that share an edge do not overlap.
const overlaps = (one: Box, two: Box): boolean =>
  one.left < two.right - 0.5 && two.left < one.right - 0.5 && one.top < two.bottom - 0.5 && two.top < one.bottom - 0.5;

/**
 * The instance's drawn label, against everything else: it overlaps no other node and no
 * other label, it is never narrower than its own node allows, and where it is cut it was
 * cut AT a node (the next one in its row), not short of one.
 */
function expectStopsAtItsNeighbour(all: readonly LabelBox[], name: string): LabelBox {
  const own = all.find((each) => each.name === name);
  if (own === undefined) throw new Error(`no label shown on ${name}`);
  for (const other of all) {
    if (other === own) continue;
    expect(overlaps(own.drawn, other.node), `${name}'s label lies on ${other.name}`).toBe(false);
    expect(overlaps(own.drawn, other.drawn), `${name}'s label lies on ${other.name}'s label`).toBe(false);
  }
  expect(own.drawn.right).toBeGreaterThanOrEqual(Math.min(own.full.right, own.node.right) - 0.5);
  if (own.drawn.right < own.full.right - 0.5) {
    const stoppedAt = all.some((other) => other !== own && Math.abs(other.node.left - own.drawn.right) <= 1);
    expect(stoppedAt, `${name}'s label is cut where no node is`).toBe(true);
  }
  return own;
}

test("zoomed out, an instance's label reads its component's whole name where its row has room; a plain node's long kind is still cut at its edge", async ({ page }) => {
  await openHologram(page);
  await zoomTo(page, 0.2);
  await expect(page.locator("[data-kind-labels]")).toHaveAttribute("data-kind-labels", "kind");
  const all = await labelBoxes(page);
  for (const instance of ["depthpoints_holo1", LONG_ROLE, "depthcut1"]) {
    const own = expectStopsAtItsNeighbour(all, instance);
    // Wider than its node: the component's name is not cut at the node's own edge.
    expect(own.drawn.right, `${instance}'s label is cut at its own node's edge`).toBeGreaterThan(own.node.right + 0.5);
  }
  // The clip still holds for everything else: `geometry` is wider than its node at 20 %.
  const geometry = all.find((each) => each.name === "geometry_dots");
  if (geometry === undefined) throw new Error("no label on geometry_dots");
  expect(geometry.drawn.right).toBeLessThanOrEqual(geometry.node.right + 0.5);
  expect(geometry.drawn.right).toBeLessThan(geometry.full.right - 0.5);
});

test("E79 at 10 %: audioanalysis1's label stops at its neighbour instead of running over its row, and its hover gives the whole name", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "examples" }).click();
  await page.getByRole("button", { name: /^E79 / }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await viewportSettled(page);
  await zoomTo(page, 0.1);
  await expect(page.locator("[data-kind-labels]")).toHaveAttribute("data-kind-labels", "kind");
  const own = expectStopsAtItsNeighbour(await labelBoxes(page), "audioanalysis1");
  // Past its own edge as far as the row allows: under (a) it ran over the next labels.
  expect(own.drawn.right).toBeGreaterThan(own.node.right + 0.5);
  // The whole name, on the label and on the node, and the label takes the pointer.
  expect(own.title).toContain("audioanalysis1");
  const node = page.locator(".react-flow__node").filter({ has: page.getByText("audioanalysis1", { exact: true }) });
  await expect(node.locator('[data-testid^="node-"][title]').first()).toHaveAttribute("title", /audioanalysis1/);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[title]")?.getAttribute("title") ?? null, {
    x: (own.drawn.left + own.drawn.right) / 2,
    y: (own.drawn.top + own.drawn.bottom) / 2,
  });
  expect(hit).toContain("audioanalysis1");
});

test("at working zoom an instance's header gives up its ROLE before its component's name", async ({ page }) => {
  await openHologram(page);
  await zoomTo(page, 1);
  const parts = await page.evaluate((name) => {
    const element = [...document.querySelectorAll<HTMLElement>('[data-testid^="node-name-"]')].find((each) => each.textContent === name);
    if (element === undefined) throw new Error(`no header for ${name}`);
    const [kind, , role] = [...element.children] as HTMLElement[];
    if (kind === undefined || role === undefined) throw new Error(`${name} is not drawn in parts`);
    return {
      kindWhole: kind.scrollWidth <= kind.clientWidth + 0.5,
      roleWhole: role.scrollWidth <= role.clientWidth + 0.5,
    };
  }, LONG_ROLE);
  expect(parts.kindWhole, "the component's name was elided before its role").toBe(true);
  // The precondition: the name does not fit, so one part had to give — and it was the role.
  expect(parts.roleWhole, "the whole name fits: nothing here decides which part gives way").toBe(false);
});
