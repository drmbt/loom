import { expect, test } from "@playwright/test";
import { addNode, openApp } from "./app.ts";

/**
 * §T1329b — A PANE-RESIZE GESTURE REALLOCATES NOTHING; IT CHANGES WHAT IS DRAWN.
 *
 * ## The report, and the mechanism under it
 *
 * The owner: *"jank in the UI, especially noticeable in the preview canvases for each of
 * the nodes… when we're resizing panes and dragging them around."* Assigning
 * `canvas.width`/`height` is not a resize — it REALLOCATES the drawing buffer and CLEARS
 * it, and a WebGPU canvas has no valid swapchain texture again until the next present
 * lands. Every layout-backed surface was sized from its CSS box once per frame, so a
 * divider dragged across N frames reallocated N times. Measured on E32 Pasture, production
 * build, one 40-move drag of the bottom divider: 80 backing-store writes, 40 on the graph
 * preview surface and 40 on the graph background, every one of them from that per-frame
 * sizing. The row's original suspect — `use-output-presentation`'s ResizeObserver — wrote
 * nothing in that gesture, which is why the fix is in the backend and not there.
 *
 * ## What is asserted
 *
 * The two halves that make a hold honest rather than a debounce:
 *  1. through the drag, no canvas's backing store is written at all;
 *  2. the moment the gesture ENDS, every canvas matches its CSS box again.
 *
 * Instrumented at the `width`/`height` setters on `HTMLCanvasElement.prototype`, which is
 * where the cost is, rather than at any of the code paths that might call them — a fix
 * that moved the reallocation somewhere else would still fail this.
 *
 * ## Why the headed lane
 *
 * There is nothing to hold without a surface, and a surface needs a real adapter: the
 * headless lane resolves none (`app.ts`), so this claim would pass there by never having a
 * sized canvas at all. It is named in `NEEDS_A_REAL_ADAPTER` for that reason.
 */

interface CanvasSize {
  readonly width: number;
  readonly height: number;
  readonly wantWidth: number;
  readonly wantHeight: number;
}

declare global {
  interface Window {
    __paneResizeWrites?: number;
  }
}

test("a divider drag holds every backing store, and the release catches up", async ({ page }) => {
  await page.addInitScript(() => {
    window.__paneResizeWrites = 0;
    for (const name of ["width", "height"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name);
      if (descriptor?.set === undefined || descriptor.get === undefined) continue;
      const { get, set } = descriptor;
      Object.defineProperty(HTMLCanvasElement.prototype, name, {
        configurable: true,
        get,
        set(this: HTMLCanvasElement, value: number) {
          // Only a CHANGE reallocates; an assignment of the same number is free.
          if (get.call(this) !== value) window.__paneResizeWrites = (window.__paneResizeWrites ?? 0) + 1;
          set.call(this, value);
        },
      });
    }
  });

  await openApp(page);
  // One node with a picture, so the preview surface is real work rather than an empty one.
  await addNode(page, "generator", "Noise");
  await page.waitForTimeout(1500);

  const sizes = (): Promise<CanvasSize[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll("canvas")]
        .filter((canvas) => canvas.clientWidth > 0 && canvas.clientHeight > 0)
        .map((canvas) => ({
          width: canvas.width,
          height: canvas.height,
          wantWidth: Math.max(1, Math.floor(canvas.clientWidth * (window.devicePixelRatio || 1))),
          wantHeight: Math.max(1, Math.floor(canvas.clientHeight * (window.devicePixelRatio || 1))),
        })),
    );

  // NON-VACUITY: there is a laid-out canvas whose backing store already tracks its box, so
  // "nothing was written" below is a hold and not an absence of subjects.
  const before = await sizes();
  expect(before.length).toBeGreaterThan(0);
  for (const canvas of before) {
    expect(canvas.width).toBe(canvas.wantWidth);
    expect(canvas.height).toBe(canvas.wantHeight);
  }

  const separator = page.getByRole("separator", { name: "Resize bottom dock" });
  const box = await separator.boundingBox();
  if (box === null) throw new Error("the bottom divider is not laid out");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.evaluate(() => {
    window.__paneResizeWrites = 0;
  });
  for (let step = 1; step <= 20; step += 1) {
    await page.mouse.move(cx, cy - step * 4);
    await page.waitForTimeout(16);
  }
  // Measured WHILE THE GESTURE IS STILL LIVE — after the pointerup the release is allowed
  // to reallocate, and reading afterwards would count that and prove nothing.
  const duringDrag = await page.evaluate(() => window.__paneResizeWrites ?? 0);
  const held = await sizes();
  await page.mouse.up();

  expect(duringDrag, "a pane drag must not reallocate a drawing buffer").toBe(0);
  expect(held.length).toBe(before.length);
  // NON-VACUITY, the half that matters: a canvas's BOX really did change during the drag
  // while its backing store did not. Without this the zero above would also be what a
  // divider that could not move produces (§V1019's companion — an edge at its limit
  // barely resizes, and a clean reading from one says nothing).
  expect(
    held.some((canvas) => canvas.height !== canvas.wantHeight || canvas.width !== canvas.wantWidth),
    "the drag must actually change a canvas's box, or the hold proves nothing",
  ).toBe(true);

  // And the release catches up, without waiting for a later layout change.
  await expect
    .poll(async () => (await sizes()).every((canvas) => canvas.width === canvas.wantWidth && canvas.height === canvas.wantHeight), {
      message: "a held backing store must match its box again once the gesture ends",
      timeout: 5000,
    })
    .toBe(true);
});
