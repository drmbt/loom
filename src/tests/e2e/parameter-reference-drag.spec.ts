import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, addNode, openApp, selectNode } from "./app.ts";

/**
 * VN63 — the BROWSER's own drag carries a parameter reference: a real mouse press on a
 * parameter's name that moves at once starts an HTML5 drag (no pointer capture until a
 * hold arms the ladder), and dropping it on the timeline's lane list makes a lane the
 * parameter reads. jsdom starts no native drag, so this is the one place the browser's half
 * of the gesture is exercised; the writes themselves are asserted in
 * `src/editor/parameter-drag/parameter-drag.test.tsx`.
 */
test.use({ viewport: APP_VIEWPORT });

test("dragging a parameter's name onto the lane list makes a lane it reads", async ({ page }) => {
  await openApp(page);
  const lfo = await addNode(page, "value", "LFO");
  await selectNode(page, lfo);
  await page.getByRole("tab", { name: "timeline" }).click();

  const inspector = page.getByRole("tabpanel", { name: "inspector" });
  const name = inspector.locator('[data-parameter-key="frequency"] [draggable="true"]').last();
  await expect(name).toBeVisible();
  await name.dragTo(page.locator('[data-lane-drop="list"]'));

  await expect(page.locator("[data-lane]")).toHaveCount(1);
  await expect(page.locator("[data-lane]").first()).toContainText("frequency");
  // The lane's reference count is the parameter now reading it.
  await expect(page.locator("[data-lane] [data-references]").first()).toHaveText("1");
});

test("press, HOLD, then drag a compound's name scrubs every channel (the ladder), and starts no drag", async ({ page }) => {
  // T1026's ladder is on a COMPOUND's name; the hold must beat the browser's own drag,
  // which the name, being draggable, would otherwise start the moment the mouse moves.
  await openApp(page);
  const transform = await addNode(page, "filter", "Transform");
  await selectNode(page, transform);
  await page.getByRole("tab", { name: "timeline" }).click();

  const inspector = page.getByRole("tabpanel", { name: "inspector" });
  const x = inspector.locator('input[aria-label="Translate x"]').last();
  const y = inspector.locator('input[aria-label="Translate y"]').last();
  const before = [await x.inputValue(), await y.inputValue()];
  const name = inspector.locator('[data-parameter-key="t"] [draggable="true"]').last();
  const box = await name.boundingBox();
  if (box === null) throw new Error("the name has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await expect(name).toHaveAttribute("data-ladder-armed", "");
  for (let step = 1; step <= 6; step += 1) await page.mouse.move(box.x + box.width / 2 + step * 10, box.y + box.height / 2);
  await page.mouse.up();

  await expect(x).not.toHaveValue(before[0]!);
  await expect(y).not.toHaveValue(before[1]!);
  await expect(page.locator("[data-lane]")).toHaveCount(0);
});
