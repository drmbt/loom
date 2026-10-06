import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, focusGraph, modKey, openApp, selectNode } from "./app.ts";

/**
 * T1619b S2 — RESET A CONTROL ON THE DESK, in the real app.
 *
 * Owner: "resetting in the controls is not visible for me anywhere … i have to reload right
 * now if i screw something up. want to be able reset individual controls or all page or all".
 *
 * The jsdom suite (`control-reset.test.tsx`) holds what each row dispatches. What only a
 * browser can say is the gesture: that a real right-click opens the control's menu WITHOUT
 * moving the control under it, that the reset is one patch in the document a save writes,
 * that the app's own undo takes it back, and that nothing short of the menu resets — a drag,
 * a click, a double click, a wheel.
 *
 * E81 Phone Desk is the document: a Slider, a Toggle and an XY Pad on a Panel, each shipped
 * at its default. No device is needed (the default lane has none): the Controls tab and the
 * document are editor and domain.
 */

test.use({ viewport: APP_VIEWPORT });

async function openPhoneDesk(page: Page): Promise<Locator> {
  await openApp(page);
  await page.getByRole("tab", { name: "examples" }).click();
  await page.getByRole("button", { name: /^E81 / }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("tab", { name: "controls" }).click();
  const pane = page.locator("[data-controls-pane]");
  await expect(pane.getByRole("slider", { name: "Heat" })).toBeVisible();
  return pane;
}

/** The document as a save writes it: its revision counts every patch that went out. */
async function saved(page: Page): Promise<{ revision: number; heat: Record<string, unknown> }> {
  const downloading = page.waitForEvent("download");
  await page.getByTestId("project-save").click();
  const download = await downloading;
  const path = join(await mkdtemp(join(tmpdir(), "loom-control-reset-")), download.suggestedFilename());
  await download.saveAs(path);
  const document = JSON.parse(await readFile(path, "utf8")) as { graph: { revision: number; nodes: Record<string, { parameters: Record<string, unknown> }> } };
  return { revision: document.graph.revision, heat: document.graph.nodes["heat"]?.parameters ?? {} };
}

/**
 * By attribute, not by role: while the control's menu is open the rest of the page is hidden
 * from the accessibility tree, and a role query cannot see the slider the menu was opened on.
 */
const heatOf = (pane: Locator): Locator => pane.locator('[role="slider"][aria-label="Heat"]');
const valueOf = async (slider: Locator): Promise<number> => Number(await slider.getAttribute("aria-valuenow"));
const markOf = (pane: Locator): Locator => pane.locator('[data-control="slider"] [data-default-mark]');

/** A real drag along the slider's bar, from one share of its width to another. */
async function drag(page: Page, slider: Locator, from: number, to: number): Promise<void> {
  const box = await slider.boundingBox();
  if (box === null) throw new Error("the slider has no box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, y, { steps: 5 });
  await page.mouse.up();
}

test("a moved slider is reset from its right-click menu: it reads its default, ONE patch went out, and undo gives the move back", async ({ page }) => {
  const pane = await openPhoneDesk(page);
  const heat = heatOf(pane);
  const mod = await modKey(page);

  // Shipped at its default, and marked as at it.
  expect(await valueOf(heat)).toBe(1);
  await expect(markOf(pane)).toHaveAttribute("data-default-mark", "at");

  await drag(page, heat, 0.5, 0.82);
  const moved = await valueOf(heat);
  expect(moved).toBeGreaterThan(1.5);
  await expect(markOf(pane)).toHaveAttribute("data-default-mark", "away");
  // The header counts it.
  await expect(pane.locator("[data-reset-all]")).toHaveAttribute("data-reset-all", "1");

  const before = await saved(page);
  expect(before.heat["value"]).toBe(moved);

  // THE GESTURE: a right-click on the control, then the row. Two inputs, never one.
  await heat.click({ button: "right" });
  const menu = page.locator('[data-menu-surface="control"]');
  await expect(menu).toBeVisible();
  // Opening the menu did not move what it was opened on.
  expect(await valueOf(heat)).toBe(moved);
  await menu.getByRole("menuitem", { name: "Reset", exact: true }).click();

  await expect(heat).toHaveAttribute("aria-valuenow", "1");
  await expect(markOf(pane)).toHaveAttribute("data-default-mark", "at");
  await expect(pane.locator("[data-reset-all]")).toHaveAttribute("data-reset-all", "0");

  // ONE patch: the saved document is exactly one revision on, and holds the default.
  const after = await saved(page);
  expect(after.revision).toBe(before.revision + 1);
  expect(after.heat["value"]).toBe(1);

  // The app's own undo takes the reset back alone, and the next one the drag.
  await focusGraph(page);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => valueOf(heat)).toBe(moved);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => valueOf(heat)).toBe(1);
});

test("nothing short of the menu resets: a drag, a click, a double click and a wheel over a control leave it where the hand put it", async ({ page }) => {
  const pane = await openPhoneDesk(page);
  const heat = heatOf(pane);

  await drag(page, heat, 0.5, 0.82);
  const moved = await valueOf(heat);

  // A wheel over the control scrolls (or does nothing); it writes nothing.
  const box = await heat.boundingBox();
  if (box === null) throw new Error("the slider has no box");
  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await page.mouse.wheel(0, -240);
  expect(await valueOf(heat)).toBe(moved);

  // A click and a double click put the value where they landed: a fifth of the way along
  // 0..2 is 0.4, not the default 1.
  await heat.click({ position: { x: box.width * 0.2, y: box.height / 2 } });
  expect(await valueOf(heat)).toBeCloseTo(0.4, 1);
  await heat.dblclick({ position: { x: box.width * 0.2, y: box.height / 2 } });
  expect(await valueOf(heat)).toBeCloseTo(0.4, 1);

  // And no menu opened for any of it.
  await expect(page.locator('[data-menu-surface="control"]')).toHaveCount(0);
  await expect(markOf(pane)).toHaveAttribute("data-default-mark", "away");
});

test("reset all in the header: a count, a popover, one button, and one undo for the whole Panel", async ({ page }) => {
  const pane = await openPhoneDesk(page);
  const heat = heatOf(pane);
  const invert = pane.getByRole("switch", { name: /Invert/ });
  const mod = await modKey(page);

  await drag(page, heat, 0.5, 0.82);
  const moved = await valueOf(heat);
  await invert.click();
  await expect(invert).toHaveAttribute("aria-checked", "true");

  const trigger = pane.locator("[data-reset-all]");
  await expect(trigger).toHaveAttribute("data-reset-all", "2");
  const before = await saved(page);

  await trigger.click();
  await expect(page.locator("[data-reset-sentence]")).toHaveText("Phone Desk: 2 of 3 controls are away from their defaults.");
  // The popover alone resets nothing.
  expect(await valueOf(heat)).toBe(moved);
  await page.locator("[data-reset-confirm]").click();

  await expect(heat).toHaveAttribute("aria-valuenow", "1");
  await expect(invert).toHaveAttribute("aria-checked", "false");
  await expect(trigger).toHaveAttribute("data-reset-all", "0");
  expect((await saved(page)).revision).toBe(before.revision + 1);

  // One undo puts both back together.
  await focusGraph(page);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => valueOf(heat)).toBe(moved);
  await expect(invert).toHaveAttribute("aria-checked", "true");
});

test("the chord resets the SELECTED control on the canvas, and with nothing selected does nothing", async ({ page }) => {
  const pane = await openPhoneDesk(page);
  const heat = heatOf(pane);
  const mod = await modKey(page);

  await drag(page, heat, 0.5, 0.82);
  const moved = await valueOf(heat);

  // Nothing selected: the binding does not fire. It never means "everything".
  await focusGraph(page);
  await page.keyboard.press(`${mod}+Alt+KeyR`);
  expect(await valueOf(heat)).toBe(moved);

  // The slider's own node, selected on the canvas.
  await selectNode(page, "heat");
  await page.keyboard.press(`${mod}+Alt+KeyR`);
  await expect.poll(() => valueOf(heat)).toBe(1);
});
