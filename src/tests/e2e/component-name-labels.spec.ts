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
 * the most telling word on the canvas. By the owner's ruling (2026-10-07) an instance's
 * label runs past its node's edge, uncapped, reading the component's whole name. Every
 * other node keeps the clip, and the legitimate case is asserted with it: a plain node
 * whose kind is wider than the node is still cut at its edge.
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

/**
 * How much of a node's low-zoom label is DRAWN, as a share of its width: the label cut by
 * every ancestor that hides its overflow, and by a mask that fades its last eighth. Taken
 * from the browser's computed styles and boxes, so a clip that really clips is counted and
 * one switched off is not.
 */
const drawnShare = (page: Page, nodeName: string): Promise<number> =>
  page.evaluate((name) => {
    const nameElement = [...document.querySelectorAll<HTMLElement>('[data-testid^="node-name-"]')].find((each) => each.textContent === name);
    const node = nameElement?.closest<HTMLElement>(".react-flow__node");
    const label = node?.querySelector<HTMLElement>('[data-testid^="node-kind-label-"]');
    if (label === null || label === undefined) throw new Error(`no kind label on ${name}`);
    const box = label.getBoundingClientRect();
    let left = box.left;
    let right = box.right;
    for (let element = label.parentElement; element !== null && element !== node; element = element.parentElement) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
      if (style.maskImage !== "none") right = Math.min(right, rect.left + rect.width * 0.875);
    }
    return Math.max(0, right - left) / box.width;
  }, nodeName);

test("zoomed out, an instance's label reads its component's whole name; a plain node's long kind is still cut at its edge", async ({ page }) => {
  await openHologram(page);
  await zoomTo(page, 0.2);
  await expect(page.locator("[data-kind-labels]")).toHaveAttribute("data-kind-labels", "kind");
  for (const instance of ["depthpoints_holo1", LONG_ROLE, "depthcut1"]) {
    expect(await drawnShare(page, instance), `${instance}'s label is cut`).toBeCloseTo(1, 3);
  }
  // The clip still holds for everything else: `geometry` is wider than its node at 20 %.
  expect(await drawnShare(page, "geometry_dots")).toBeLessThan(0.95);
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
