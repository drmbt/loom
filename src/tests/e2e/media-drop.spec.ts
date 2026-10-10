import { expect, test, type Page } from "@playwright/test";

import { APP_VIEWPORT, openApp } from "./app.ts";

/**
 * VN99 / VN64 — a real browser's file drop: a WAV built in the page, carried by a real
 * `DataTransfer`, dropped on the canvas and on the timeline. jsdom has no decoder, no
 * Worker and no 2D canvas, so this is where the timeline's waveform is shown to be decoded
 * (OfflineAudioContext), computed (the peaks worker) and drawn (pixels that were not there
 * before the drop). The writes themselves are asserted in `media-file-drop.test.tsx` and
 * `reference-media.test.tsx`.
 */
test.use({ viewport: APP_VIEWPORT });

/** Dispatches dragover + drop of a generated 2 s 220 Hz WAV named `name` on `selector`. */
async function dropWav(page: Page, selector: string, name: string): Promise<void> {
  await page.evaluate(({ selector: target, name: fileName }) => {
    const rate = 48_000;
    const frames = rate * 2;
    const bytes = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(bytes);
    const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i)); };
    ascii(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); ascii(8, "WAVE");
    ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, "data"); view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i += 1) view.setInt16(44 + i * 2, Math.round(0.8 * 32767 * Math.sin((2 * Math.PI * 220 * i) / rate)), true);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], fileName, { type: "audio/wav" }));
    const element = document.querySelector(target);
    if (element === null) throw new Error(`no ${target}`);
    const box = element.getBoundingClientRect();
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, ...at }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, ...at }));
  }, { selector, name });
}

test("a WAV dropped on the canvas becomes an Audio File In named for the file", async ({ page }) => {
  await openApp(page);
  await dropWav(page, '[data-keymap-context="graph"]', "Kick Loop.wav");
  // The new node is the selection, so the inspector shows it by name and type.
  const inspector = page.getByRole("tabpanel", { name: "inspector" });
  await expect(inspector).toContainText("audiofile_kick_loop");
  await expect(inspector.getByRole("button", { name: /^audioFileIn/ })).toBeVisible();
});

test("a WAV dropped on the timeline becomes the reference, and its waveform is drawn under the lanes", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "timeline" }).click();
  const canvas = page.locator("[data-timeline-canvas]");
  await expect(canvas).toBeVisible();

  /** The curve area's middle row, as RGB. */
  const row = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const ratio = element.width / Math.max(1, element.clientWidth);
    const y = Math.floor(element.height / 2 + 16 * ratio);
    return Array.from(element.getContext("2d")!.getImageData(0, y, element.width, 1).data);
  });
  const before = await row();
  /** How many pixels of the row differ from what it was before the drop. */
  const lit = async (): Promise<number> => {
    const now = await row();
    let differing = 0;
    for (let o = 0; o < now.length; o += 4) {
      if (Math.abs(now[o]! - before[o]!) + Math.abs(now[o + 1]! - before[o + 1]!) + Math.abs(now[o + 2]! - before[o + 2]!) > 24) differing += 1;
    }
    return differing;
  };


  await dropWav(page, "[data-timeline-pane]", "Score.wav");
  const select = page.locator('select[aria-label="reference media"]');
  await expect(select.locator("option:checked")).toHaveText("audiofile_reference");
  await expect(page.locator("[data-timeline-reference]")).not.toContainText("decoding");
  await expect(page.locator("[data-timeline-reference]")).not.toContainText("no waveform");
  // The default view is 100 px a second and the node loops (its default at-end), so the
  // tone lights most of the row; 2 s alone is about 200 columns.
  await expect.poll(lit).toBeGreaterThan(150);
});
