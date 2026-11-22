import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, modKey, openApp } from "./app.ts";

/**
 * VN152 (upstream §T1648b) — RENAME A PRESET FROM ITS RIGHT-CLICK MENU, in the real app.
 *
 * The bug this was written for (Vincent, desktop app): Rename… never showed the field. The
 * row ran, the field mounted, and the menu's own close sequence then took focus from it; the
 * field read the blur as "cancel" and closed. jsdom passed, because jsdom runs no Radix close
 * sequence worth the name. Only a browser can say the field survives the menu closing.
 *
 * E82 Set List is the document: a Panel whose shots bank strip holds open, cross, drop, out.
 */

test.use({ viewport: APP_VIEWPORT });

async function openSetList(page: Page): Promise<Locator> {
  await openApp(page);
  await page.getByRole("tab", { name: "examples" }).click();
  await page.getByRole("button", { name: /^E82 / }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("tab", { name: "controls" }).click();
  const pane = page.locator("[data-controls-pane]");
  await expect(pane.locator('[data-preset="cross"]')).toBeVisible();
  return pane;
}

// By the strip's own name: a rename changes the buttons it would otherwise be found by.
const strip = (pane: Locator): Locator => pane.locator('[role="group"][aria-label="Presets of shots"]');
const names = async (pane: Locator): Promise<string[]> =>
  strip(pane).locator("[data-preset]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-preset") ?? ""));

test("Rename… opens a name field on the button that keeps focus after the menu closes; typing and Enter renames the preset", async ({ page }) => {
  const pane = await openSetList(page);
  expect(await names(pane)).toEqual(["open", "cross", "drop", "out"]);

  await pane.locator('[data-preset="cross"]').click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Rename…" }).click();
  await expect(menu).toBeHidden();

  // The field is there, and still there once the menu has finished closing.
  const field = pane.locator('[data-preset-rename="cross"]');
  await expect(field).toBeVisible();
  await page.waitForTimeout(300);
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("cross");

  await page.keyboard.type("bridge");
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
  await expect.poll(() => names(pane)).toEqual(["open", "bridge", "drop", "out"]);

  // The app's own undo takes it back.
  const mod = await modKey(page);
  await page.locator(".react-flow__pane").first().click({ position: { x: 10, y: 10 } });
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => names(pane)).toEqual(["open", "cross", "drop", "out"]);
});

test("Escape closes the field having renamed nothing; a click elsewhere does too", async ({ page }) => {
  const pane = await openSetList(page);
  for (const close of ["escape", "click"] as const) {
    await pane.locator('[data-preset="drop"]').click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: "Rename…" }).click();
    const field = pane.locator('[data-preset-rename="drop"]');
    await expect(field).toBeFocused();
    await page.keyboard.type("gone");
    if (close === "escape") await page.keyboard.press("Escape");
    else await pane.locator('[data-preset="open"]').hover().then(() => page.mouse.click(5, 5));
    await expect(field).toBeHidden();
    expect(await names(pane)).toEqual(["open", "cross", "drop", "out"]);
  }
});
