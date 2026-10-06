import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, openApp } from "./app.ts";

/**
 * B273 — A CLOSED POPOVER IS GONE, not waiting for its entry animation.
 *
 * Found by `control-reset.spec.ts`, which opens an example from the examples list and at
 * once drags a slider in the Controls tab: the drag moved nothing, two tests in four, on
 * a busy machine. Under the pointer was the example's hover card — closed, empty, 274 px
 * wide — still mounted over the pane.
 *
 * The cause is in how the library decides a closed popover may leave. It keeps one
 * mounted until an `animationend` whenever the animation it sees at the close differs from
 * the one it recorded at the mount. A popover is mounted UNPLACED with its animation
 * suppressed, so what is recorded is "none"; once placed it carries its entry animation,
 * and the record is brought up to date only by that animation's `animationstart`. Close it
 * before that event arrives — the click that picks an example loads a document, and the
 * event came 130 ms after the close — and the library waits for the ENTRY animation to
 * play to its end, with the popover closed.
 *
 * So the gate is on the cause, and does not depend on a busy machine: the entry
 * animation is made to start late (a delay, which is what a busy main thread is to it),
 * the card is closed inside that delay, and it must be out of the document at once. Red
 * without `[data-state="closed"] { animation: none }` in `popover.module.css`: the card is
 * still there, closed, a second later.
 */

test.use({ viewport: APP_VIEWPORT });

test("an example's hover card closed before its entry animation has started leaves the document at once", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "examples" }).click();
  const row = page.getByRole("button", { name: /^E81 / });
  await expect(row).toBeVisible();
  // The entry animation starts three seconds late: its `animationstart` cannot arrive before the close below.
  await page.addStyleTag({ content: '[role="tooltip"] { animation-delay: 3s !important; }' });

  await row.hover();
  const card = page.locator('[role="tooltip"]');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-state", "open");
  // The legitimate case the rule could swallow: an OPEN card is shown, with what it says.
  await expect(card).toContainText("E81");

  // The pointer leaves the row: the card closes.
  await page.mouse.move(900, 500);
  // Well inside the three seconds the entry animation has not even begun in.
  await expect(card, "a closed hover card is still in the document, waiting for its entry animation").toHaveCount(0, { timeout: 1000 });
});
