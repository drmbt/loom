import { expect, test, type Locator, type Page } from "@playwright/test";

import { APP_VIEWPORT, focusGraph, modKey, openApp, selectNode } from "./app.ts";

/**
 * VN106 — clip tracks in the timeline under a REAL mouse: a video dropped on a clip lane
 * becomes a region; dragging its body moves it, its right edge trims it, Alt-dragging the
 * right edge extends it past its source so it loops, each snapped (to seconds here) and each
 * ONE undo step. The stored regions are read back from the node's `track` parameter in the
 * inspector, the text the document holds. jsdom asserts the same writes through the bus
 * (`clip-lanes.test.tsx`); this is the browser's half: real pointer events, real capture,
 * real `<video>` metadata.
 *
 * Geometry: the default view puts tick 0 at the lane's left edge at 100 px a second; one
 * wheel notch of deltaY ln(4)/0.0015 at the left edge zooms out 4× about tick 0, to 25 px a
 * second, so the whole clip is on screen. The strip is an 18 px ruler, then a 30 px row.
 */
test.use({ viewport: APP_VIEWPORT });

const S = 240_000;

interface StoredRegion { readonly timelineStart: number; readonly length: number; readonly sourceIn: number; readonly sourceOut: number }

async function regions(page: Page): Promise<StoredRegion[]> {
  const text = await page.getByRole("tabpanel", { name: "inspector" }).locator('[data-parameter-key="track"] .cm-content').first().evaluate((element) => {
    // CodeMirror renders one element per line: join them back into the stored text.
    return Array.from(element.querySelectorAll(".cm-line")).map((line) => line.textContent ?? "").join("\n");
  });
  return (JSON.parse(text) as { regions: StoredRegion[] }).regions;
}

async function dropVideo(strip: Locator, x: number): Promise<void> {
  await strip.evaluate(async (element, at) => {
    const bytes = await (await fetch("/media/shibuya-crossing.mp4")).arrayBuffer();
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "shibuya.mp4", { type: "video/mp4" }));
    const box = element.getBoundingClientRect();
    const point = { clientX: box.x + at, clientY: box.y + 18 + 15 };
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, ...point }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, ...point }));
  }, x);
}

async function drag(page: Page, strip: Locator, fromX: number, toX: number, alt = false): Promise<void> {
  const box = (await strip.boundingBox())!;
  const y = box.y + 18 + 15;
  await page.mouse.move(box.x + fromX, y);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.down();
  const steps = 10;
  for (let step = 1; step <= steps; step += 1) await page.mouse.move(box.x + fromX + ((toX - fromX) * step) / steps, y);
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

/** Undo from the graph (focusing it clears the selection), then show the track again. */
async function undo(page: Page, nodeId: string): Promise<void> {
  await focusGraph(page);
  await page.keyboard.press(`${await modKey(page)}+z`);
  await selectNode(page, nodeId);
}

test("a dropped video becomes a region; move, trim and Alt-extend it, snapped, one undo each", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "timeline" }).click();
  await page.locator("[data-add-clip-track]").click();
  const strip = page.locator("[data-clip-canvas]");
  await expect(strip).toBeVisible();
  await page.locator('select[aria-label="snap"]').selectOption("seconds");
  const nodeId = (await page.locator(".react-flow__node").first().getAttribute("data-id"))!;
  await selectNode(page, nodeId);
  await page.getByRole("tab", { name: "timeline" }).click();

  // Zoom out 4× about tick 0: 25 px a second.
  const P = 25;
  const curve = (await page.locator("[data-timeline-canvas]").boundingBox())!;
  await page.mouse.move(curve.x, curve.y + curve.height / 2);
  await page.mouse.wheel(0, Math.log(4) / 0.0015);
  // The wheel is dispatched asynchronously; let the view state land before the drop reads it.
  await page.waitForTimeout(250);

  // Drop at 1 s.
  await dropVideo(strip, P);
  await expect.poll(async () => (await regions(page)).length).toBe(1);
  const dropped = (await regions(page))[0]!;
  expect(dropped.timelineStart).toBe(S);
  expect(dropped.sourceIn).toBe(0);
  expect(dropped.length).toBe(dropped.sourceOut);
  expect(dropped.length).toBeGreaterThan(S);
  const lengthPx = (dropped.length / S) * P;
  if (process.env["VN106_SHOTS"] !== undefined) await page.locator("[data-timeline-pane]").screenshot({ path: `${process.env["VN106_SHOTS"]}/clip-lane-dropped.png` });

  // Move: grab the body 30 px in, drag 1.04 s right — the start snaps to 2 s.
  await drag(page, strip, P + 30, P + 30 + 1.04 * P);
  await expect.poll(async () => (await regions(page))[0]!.timelineStart).toBe(2 * S);
  await undo(page, nodeId);
  await expect.poll(async () => (await regions(page))[0]!.timelineStart).toBe(S);

  // Trim: the right edge 3.4 s left; the end snaps to a whole second.
  const end = P + lengthPx;
  await drag(page, strip, end - 2, end - 2 - 3.4 * P);
  const trimmedEnd = Math.round((end - 3.4 * P) / P) * S;
  await expect.poll(async () => (await regions(page))[0]!.length).toBe(trimmedEnd - S);
  await undo(page, nodeId);
  await expect.poll(async () => (await regions(page))[0]!.length).toBe(dropped.length);

  // A plain drag outwards stops at the source's end.
  await drag(page, strip, end - 2, end + 6 * P);
  await expect.poll(async () => (await regions(page))[0]!.length).toBe(dropped.length);

  // Alt: extends past it, to a whole second; the source span is unchanged, so it loops.
  await drag(page, strip, end - 2, end - 2 + 6.3 * P, true);
  const extendedEnd = Math.round((end + 6.3 * P) / P) * S;
  await expect.poll(async () => (await regions(page))[0]!.length).toBe(extendedEnd - S);
  expect((await regions(page))[0]!.sourceOut).toBe(dropped.sourceOut);
  if (process.env["VN106_SHOTS"] !== undefined) await page.locator("[data-timeline-pane]").screenshot({ path: `${process.env["VN106_SHOTS"]}/clip-lane-looped.png` });
  await undo(page, nodeId);
  await expect.poll(async () => (await regions(page))[0]!.length).toBe(dropped.length);
});

/** A synthesized Resolume composition: one file clip per (layer, column), with transport options. */
function composition(): string {
  const clip = (layer: number, column: number, media: string, ms: number, mode = 0, direction = 2) => `<Clip name="Clip" uniqueId="${layer}${column}" layerIndex="${layer}" columnIndex="${column}">
  <PreloadData><VideoFile value="${media}"/></PreloadData>
  <Transport name="Transport"><Params name="Params"><ParamRange name="Position" T="DOUBLE" default="0" value="0">
    <DurationSource defaultDuration="${ms / 1000}s"/><PhaseSourceTransportTimeline name="PhaseSourceTransportTimeline"><Params name="Params"><ParamChoice name="PlayMode" default="0" value="${mode}"/><ParamChoice name="PlayDirection" default="2" value="${direction}"/></Params></PhaseSourceTransportTimeline>
    <ValueRange name="minMax" min="0" max="${ms}"/></ParamRange></Params></Transport>
  <VideoTrack name="VideoTrack"><VideoSource name="VideoSource" type="VideoFormatReaderSource"><VideoFormatReaderSource fileName="${media}"/></VideoSource></VideoTrack>
</Clip>`;
  const layer = (index: number, name: string) => `<Layer name="Layer" layerIndex="${index}"><Params name="Params"><Param name="Name" value="${name}"/></Params></Layer>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<Composition name="Composition" numDecks="1">
  <CompositionInfo name="Tour" width="1920" height="1080"><DeckInfo name="Main" id="1"/></CompositionInfo>
  <TempoController name="TempoController"><Params name="Params"><ParamRange name="Tempo" T="DOUBLE" default="120" value="128"/></Params></TempoController>
  ${layer(0, "Backdrop")}${layer(1, "Strobes")}${layer(2, "Logo")}
  <Deck name="Deck" deckIndex="0">
    ${clip(0, 0, "/Volumes/Show/sky.mov", 6000)}${clip(0, 1, "/Volumes/Show/city.mov", 4000, 1)}${clip(0, 2, "/Volumes/Show/sea.mov", 5000)}
    ${clip(1, 0, "/Volumes/Show/flash.mov", 2000, 0, 0)}${clip(1, 1, "/Volumes/Show/burst.mov", 3000, 4)}
    ${clip(2, 0, "/Volumes/Show/logo.mov", 8000, 3)}
    <Clip name="Clip" uniqueId="99" layerIndex="2" columnIndex="1"><Params name="Params"><Param name="Name" value="gen"/></Params><VideoTrack name="VideoTrack"><VideoSource name="VideoSource" type="GeneratorVideoSource"/></VideoTrack></Clip>
  </Deck>
</Composition>`;
}

test("Import Resolume… previews the composition and makes a clip lane per layer, offline", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "timeline" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-import-resolume]").click();
  await (await chooser).setFiles({ name: "tour.avc", mimeType: "text/xml", buffer: Buffer.from(composition()) });
  const dialog = page.locator("[data-import-dialog=resolume]");
  await expect(dialog).toContainText("6 regions on 3 tracks");
  await expect(dialog).toContainText("1 generator");
  if (process.env["VN106_SHOTS"] !== undefined) await page.locator("[data-timeline-pane]").screenshot({ path: `${process.env["VN106_SHOTS"]}/import-resolume-preview.png` });
  await page.locator("[data-import-confirm]").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const strip = page.locator("[data-clip-canvas]");
  await expect(strip).toBeVisible();
  // Three rows under the ruler.
  expect((await strip.boundingBox())!.height).toBe(18 + 3 * 30);
  if (process.env["VN106_SHOTS"] !== undefined) await page.locator("[data-timeline-pane]").screenshot({ path: `${process.env["VN106_SHOTS"]}/import-resolume-lanes.png` });
});
