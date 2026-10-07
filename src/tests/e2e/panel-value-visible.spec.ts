import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, openApp } from "./app.ts";

/**
 * VNB9 — A PANEL CONTROL'S VALUE IS ALWAYS VISIBLE, in a browser that lays things out.
 *
 * Reported 2026-10-06 on `stage-previz-2`: "Side keystone H, ° (squares the floor image)"
 * filled its board cell and the number was gone. T1518b's fit rule dropped the VALUE
 * whenever caption and value could not both fit at the minimum type size, and kept the
 * caption whole. A control whose number is hidden cannot be read on stage, so the order
 * is reversed: the caption gives way (a smaller size, then an ellipsis) and the value
 * stays. Hovering the control gives the whole caption and the value.
 *
 * The document is E81 Phone Desk with its Heat slider given the reported caption, on a
 * six-column board two cells wide. It is asserted on both surfaces that draw a board: the
 * Controls tab's fixed cells, and the Panel node's scaled-down body on the canvas. The
 * claims are geometry (the readout has a box, and the box is inside the cell), which jsdom
 * cannot answer. No GPU is needed: the board is DOM.
 */

test.use({ viewport: APP_VIEWPORT });

const LONG = "Side keystone H, ° (squares the floor image)";

async function openLongCaptionDesk(page: Page): Promise<void> {
  const shipped = JSON.parse(await readFile(join(process.cwd(), "examples/E81-Phone-Desk.loom.json"), "utf8")) as {
    graph: { nodes: Record<string, { parameters: Record<string, unknown> }> };
  };
  const heat = shipped.graph.nodes["heat"];
  const panel = shipped.graph.nodes["panel"];
  if (heat === undefined || panel === undefined) throw new Error("E81 no longer has its heat slider and panel");
  heat.parameters["caption"] = LONG;
  panel.parameters["board"] = JSON.stringify({
    columns: 6,
    items: [{ member: "slider_heat", rect: { x: 0, y: 0, w: 2, h: 1 } }],
  });
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: "long-caption.loom.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(shipped)) });
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
}

/** The readout's box lies inside its board cell, and has width: the number can be seen. */
async function expectValueInsideCell(board: Locator): Promise<void> {
  const cell = board.locator("[data-board-item]").filter({ has: board.page().locator(`[aria-label="${LONG}"]`) });
  const readout = cell.locator("[data-readout]");
  await expect(readout).toHaveText("1.00");
  const [cellBox, readoutBox] = await Promise.all([cell.boundingBox(), readout.boundingBox()]);
  if (cellBox === null || readoutBox === null) throw new Error("the cell or its readout has no box");
  expect(readoutBox.width).toBeGreaterThan(0);
  expect(readoutBox.x).toBeGreaterThanOrEqual(cellBox.x);
  expect(readoutBox.x + readoutBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 0.5);
  // The readout is not itself cut: every glyph of the number is drawn.
  expect(await readout.evaluate((element) => element.scrollWidth <= element.clientWidth + 0.5)).toBe(true);
  // What gave way is the caption, and the hover holds the whole of both.
  await expect(cell.locator('[role="slider"]')).toHaveAttribute("title", new RegExp(`^${LONG.replace(/[()]/g, "\\$&")} · 1\\.00`));
}

test("a slider whose caption is longer than its cell keeps its value in sight, in the Controls tab", async ({ page }) => {
  await openLongCaptionDesk(page);
  await page.getByRole("tab", { name: "controls" }).click();
  await expectValueInsideCell(page.locator('[data-controls-pane] [data-panel-board="tab"]'));
});

test("and on the Panel node's body on the canvas", async ({ page }) => {
  await openLongCaptionDesk(page);
  await expectValueInsideCell(page.locator('[data-panel-board="canvas"]'));
});
