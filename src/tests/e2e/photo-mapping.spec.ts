import { expect, test, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { encodeDepthExr } from "@runtime/media/depth-exr.ts";
import { makePreparedMap } from "@runtime/media/prepared-map.ts";
import { DEPTH_ACCURATE, PHOTO_FACADE, PHOTO_MASK } from "@runtime/models/model-catalogue.ts";
import { APP_VIEWPORT, openApp } from "./app.ts";

test.use({ viewport: APP_VIEWPORT });

test("Map from photo opens from File and reports an undecodable photograph", async ({ page }) => {
  const modelRequests: string[] = [];
  page.on("request", request => { if (request.resourceType() === "fetch" && (request.url() === PHOTO_FACADE.url || /\.onnx(?:\?|$)/.test(request.url()))) modelRequests.push(request.url()); });
  await openApp(page);
  await expect(page.getByRole("button", { name: "Map from photo", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Map from photo…", exact: true }).click();
  await expect(page.getByRole("menu", { name: "File actions" })).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  await expect(dialog.getByRole("heading", { name: "Map from photo" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Run depth", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("group", { name: "Existing depth map" }).getByRole("button", { name: "choose…" })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Existing mask map" }).getByRole("button", { name: "choose…" })).toBeVisible();
  const depthDetail = dialog.getByRole("combobox", { name: "Detail", exact: true });
  const maskDetail = dialog.getByRole("combobox", { name: "Mask detail", exact: true });
  await expect(depthDetail).toBeVisible(); await expect(maskDetail).toBeVisible();
  await expect(depthDetail.getByRole("option")).toHaveText([
    "266 × 266", "392 × 392", "518 × 518", "644 × 644", "770 × 770", "896 × 896", "1036 × 1036", "1288 × 1288",
  ]);
  await expect(maskDetail.getByRole("option")).toHaveText(["1024 × 1024", "1536 × 1536"]);
  await depthDetail.selectOption("1288"); await maskDetail.selectOption("1536");
  await expect(depthDetail).toHaveValue("1288"); await expect(maskDetail).toHaveValue("1536");
  const maskMethod = dialog.getByRole("combobox", { name: "Mask method", exact: true });
  await expect(maskMethod).toHaveValue("facade");
  await expect(maskMethod.getByRole("option")).toHaveText(["Facade walls and openings", "Object background removal", "Depth range"]);
  await dialog.getByText("Mask help and model details", { exact: true }).click();
  await expect(dialog.getByText(/TopFormer facade surfaces · 11\.5 MB · 512 input \/ 64 scene mask/)).toBeVisible();
  await expect(dialog.getByRole("slider", { name: "Opening cutoff" })).toHaveValue("14");
  await expect(dialog.getByRole("switch", { name: "Exclude blue glass", exact: true })).toBeChecked();
  await maskMethod.selectOption("background");
  await expect(dialog.getByText(/BiRefNet surface mask · 172\.5 MB/)).toBeVisible();
  await expect(dialog.getByRole("slider", { name: "Opening cutoff" })).toHaveCount(0);
  await maskMethod.selectOption("facade");
  await expect(dialog.getByRole("switch", { name: "Use surface mask", exact: true })).toBeChecked();
  const finish = dialog.getByRole("region", { name: "Create or update mapping" });
  const effect = finish.getByRole("combobox", { name: "First effect" });
  await expect(effect.getByRole("option")).toHaveText(["Photo point cloud", "Grazing light · modular", "Contour engraving · modular", "Depth slices · modular", "Neon contours", "Prismatic sweep", "Chromatic relief", "Surface trace", "Depth reveal", "Moonlit stone", "Liquid strata", "Depth constellation", "Thermal scan", "Mapped video"]);
  await effect.selectOption("3");
  await expect(finish.getByText(/mask.*bound|bound.*mask/i)).toBeVisible();
  await effect.selectOption("4");
  await expect(finish.getByText(/depth.*bands/i)).toBeVisible();
  await expect(finish.getByRole("switch", { name: "Preview on reference photo" })).toBeChecked();
  const previewLabel = finish.locator("label").filter({ hasText: "Preview on reference photo" });
  await expect(previewLabel).toBeVisible();
  await expect(previewLabel).toContainText("Preview on reference photo");
  await expect(dialog.getByRole("group", { name: "Preview photo (optional)" }).getByRole("button", { name: "choose…" })).toBeVisible();
  await dialog.getByRole("group", { name: "Reference photo" }).locator('input[type="file"]').setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not a photo") });
  await expect(dialog.getByRole("alert")).toContainText(/image|photo|decoded/i);
  await expect(dialog.getByRole("button", { name: "Run depth", exact: true })).toBeDisabled();
  expect(modelRequests).toEqual([]);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
});

test("File groups project actions and supports keyboard navigation", async ({ page }) => {
  await openApp(page);
  const file = page.getByRole("button", { name: "File", exact: true });
  await file.focus();
  await file.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu).toBeVisible();
  const first = menu.getByRole("menuitem", { name: "New project", exact: true });
  await expect(first).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Open project", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Save project", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Map from photo…", exact: true })).toBeVisible();
  await menu.screenshot({ path: "/tmp/loom-file-menu.png" });
  await first.press("End");
  await expect(menu.getByRole("menuitem").and(page.locator(":enabled")).last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(file).toBeFocused();
});

test("day and night photos stay visible together before map preparation at pixel-rounded resolutions", async ({ page }) => {
  const modelRequests: string[] = [];
  page.on("request", request => { if (request.resourceType() === "fetch" && (request.url() === PHOTO_FACADE.url || /\.onnx(?:\?|$)/.test(request.url()))) modelRequests.push(request.url()); });
  await openApp(page);
  const photos = await page.evaluate(() => ([[3000, 1688, [233, 222, 208]], [1672, 941, [16, 24, 40]]] as const).map(([width, height, color]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Photo fixtures require a canvas");
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x >= width * 0.2 && x < width * 0.8 && y >= height * 0.15 && y < height * 0.85;
      const offset = (y * width + x) * 4;
      image.data[offset] = inside ? 101 : color[0];
      image.data[offset + 1] = inside ? 120 : color[1];
      image.data[offset + 2] = inside ? 154 : color[2];
      image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }));
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Map from photo…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  await dialog.getByRole("group", { name: "Reference photo" }).locator('input[type="file"]').setInputFiles({
    name: "day.png", mimeType: "image/png", buffer: Buffer.from(photos[0]!, "base64"),
  });
  await dialog.getByRole("group", { name: "Preview photo (optional)" }).locator('input[type="file"]').setInputFiles({
    name: "night.png", mimeType: "image/png", buffer: Buffer.from(photos[1]!, "base64"),
  });
  const reference = dialog.getByRole("img", { name: "Reference photo", exact: true });
  const preview = dialog.getByRole("img", { name: "Preview photo", exact: true });
  await expect(reference).toBeVisible(); await expect(preview).toBeVisible();
  await expect(dialog.getByRole("note", { name: "Preview framing warning" })).toHaveCount(0);
  const referenceBounds = await reference.boundingBox(); const previewBounds = await preview.boundingBox();
  if (referenceBounds === null || previewBounds === null) throw new Error("Both reference and night photos must be rendered before any map is run");
  expect(Math.abs(referenceBounds.height - previewBounds.height)).toBeLessThan(1);
  expect(previewBounds.x >= referenceBounds.x + referenceBounds.width ||
    previewBounds.y >= referenceBounds.y + referenceBounds.height).toBe(true);
  expect(referenceBounds.height).toBeGreaterThan(100);
  await expect(dialog.getByRole("combobox", { name: "Preview fit" })).toHaveValue("stretch");
  expect(modelRequests).toEqual([]);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await dialog.screenshot({ path: "/tmp/loom-photo-pair-preview.png" });
  await dialog.getByRole("switch", { name: "Use surface mask", exact: true }).click();
  await dialog.getByRole("button", { name: "Projection effect", exact: true }).click();
  await expect(dialog.getByRole("note").filter({ hasText: "Projection effect preview unavailable" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Projection effect preview", exact: true })).toHaveCount(0);
  expect(modelRequests).toEqual([]);
  await dialog.screenshot({ path: "/tmp/loom-photo-pair-full-frame-preview.png" });
});

test("a manual photo mask starts without inference and explains unavailable durable saving", async ({ page }) => {
  const modelRequests: string[] = [];
  page.on("request", request => { if (request.resourceType() === "fetch" && (request.url() === PHOTO_FACADE.url || /\.onnx(?:\?|$)/.test(request.url()))) modelRequests.push(request.url()); });
  await openApp(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 2;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Photo fixture requires a canvas");
    const image = context.createImageData(4, 2);
    for (let i = 0; i < 8; i++) image.data.set([132, 132, 132, 255], 4 * i);
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.getByTestId("open-project-settings").click();
  await page.getByTestId("project-settings").getByRole("button", { name: "Map from photo…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  await dialog.getByRole("group", { name: "Reference photo" }).locator('input[type="file"]').setInputFiles({ name: "sculpture.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  const maskMethod = dialog.getByRole("combobox", { name: "Mask method", exact: true });
  await maskMethod.selectOption("background");
  await expect(dialog.getByRole("button", { name: "Run mask", exact: true })).toBeEnabled();
  await maskMethod.selectOption("facade");
  await expect(dialog.getByRole("button", { name: "Run mask", exact: true })).toBeEnabled();
  expect(modelRequests).toEqual([]);
  await expect(dialog.getByRole("button", { name: "Start manual mask", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Start manual mask", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save mask…", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Projection effect", exact: true }).click();
  await expect(dialog.getByRole("note").filter({ hasText: "Projection effect preview unavailable" })).toBeVisible();
  const inspection = dialog.getByRole("region", { name: "Photo and depth inspection" });
  await expect(inspection).toBeVisible();
  await inspection.getByRole("button", { name: "Surface mask", exact: true }).click();
  await expect(inspection.getByRole("group", { name: "Surface mask viewport" })).toBeVisible();
  await inspection.getByRole("button", { name: "100% map pixels" }).click();
  await inspection.getByRole("button", { name: "Zoom in" }).click();
  await inspection.getByRole("button", { name: "Fit image" }).click();
  const depthDetail = dialog.getByRole("combobox", { name: "Detail", exact: true });
  const maskDetail = dialog.getByRole("combobox", { name: "Mask detail", exact: true });
  await expect(depthDetail).toBeVisible(); await expect(maskDetail).toBeVisible();
  await dialog.screenshot({ path: "/tmp/loom-photo-mapping-panel.png" });

  await page.setViewportSize({ width: 640, height: 900 });
  await expect(inspection).toBeVisible();
  await expect(depthDetail).toBeVisible(); await expect(maskDetail).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await dialog.getByRole("button", { name: "Save mask…", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Saving reusable maps requires File System Access");
  await expect(dialog.getByRole("button", { name: "Create mapping network", exact: true })).toBeDisabled();
  const useMask = dialog.getByRole("switch", { name: "Use surface mask", exact: true });
  await expect(useMask).toBeChecked();
  await useMask.click();
  await expect(useMask).not.toBeChecked();
  await expect(dialog.getByText("Full frame · no mask file needed", { exact: true })).toBeVisible();
  await expect(maskDetail).toBeDisabled();
  await expect(maskMethod).toBeDisabled();
  await expect(dialog.getByRole("slider", { name: "Opening cutoff" })).toBeDisabled();
  await expect(dialog.getByRole("switch", { name: "Exclude blue glass", exact: true })).toBeDisabled();
  for (const name of ["Erase mask", "Restore mask", "Pan mask"]) await expect(inspection.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(inspection.getByRole("slider", { name: "Mask brush radius", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Rerun mask", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save mask…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Edit mask", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("group", { name: "Existing mask map" }).getByRole("button", { name: "choose…" })).toHaveCount(0);
  await expect(depthDetail).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Run depth", exact: true })).toBeEnabled();
  await useMask.click();
  await expect(useMask).toBeChecked();
  await expect(maskDetail).toBeEnabled();
  await expect(maskMethod).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Save mask…", exact: true })).toBeEnabled();
  expect(modelRequests).toEqual([]);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
});

test("mismatched photos explain crop, borders and stretch and report unavailable effect rendering", async ({ page }) => {
  const modelRequests: string[] = [];
  page.on("request", request => { if (request.resourceType() === "fetch" && (request.url() === PHOTO_FACADE.url || /\.onnx(?:\?|$)/.test(request.url()))) modelRequests.push(request.url()); });
  await openApp(page);
  const photos = await page.evaluate(() => ([[300, 200], [240, 180]] as const).map(([width, height]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Framing fixtures require a canvas");
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x >= width * 0.2 && x < width * 0.8 && y >= height * 0.15 && y < height * 0.85;
      image.data.set(inside ? [101, 120, 154, 255] : [16, 24, 40, 255], (y * width + x) * 4);
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }));
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Map from photo…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  await dialog.getByRole("group", { name: "Reference photo" }).locator('input[type="file"]').setInputFiles({
    name: "day-3x2.png", mimeType: "image/png", buffer: Buffer.from(photos[0]!, "base64"),
  });
  await dialog.getByRole("group", { name: "Preview photo (optional)" }).locator('input[type="file"]').setInputFiles({
    name: "night-4x3.png", mimeType: "image/png", buffer: Buffer.from(photos[1]!, "base64"),
  });
  await expect(dialog.getByRole("note", { name: "Preview framing warning" })).toBeVisible();
  const guide = dialog.getByRole("img", { name: "Preview framing guide", exact: true });
  await expect(guide).toBeVisible();
  await expect(dialog.getByText("All edges stay; horizontal proportions ×1.13", { exact: true })).toBeVisible();
  const fit = dialog.getByRole("combobox", { name: "Preview fit" });
  await expect(fit).toHaveValue("stretch");
  await fit.selectOption("fill");
  await expect(dialog.getByText("Crop removes 11% of the photo; outlined area stays", { exact: true })).toBeVisible();
  const crop = await guide.locator("rect").evaluate(element => {
    const rect = element as SVGRectElement;
    const box = rect.ownerSVGElement!.viewBox.baseVal;
    return { top: rect.y.baseVal.value / box.height * 100, height: rect.height.baseVal.value / box.height * 100,
      width: rect.width.baseVal.value / box.width * 100 };
  });
  expect(crop.top).toBeCloseTo(100 / 18, 2);
  expect(crop.height).toBeCloseTo(800 / 9, 2);
  expect(crop.width).toBe(100);
  await fit.selectOption("fit");
  await expect(dialog.getByText("Borders occupy 11% of the frame; all edges stay", { exact: true })).toBeVisible();
  await fit.selectOption("stretch");
  const overlayControl = dialog.getByRole("slider", { name: "Reference overlay" });
  await expect(overlayControl).toHaveValue("0");
  await overlayControl.focus(); await overlayControl.press("End");
  const overlay = dialog.getByRole("img", { name: "Reference alignment overlay", exact: true });
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveCSS("opacity", "1");
  await expect(fit).toHaveValue("stretch");
  await overlayControl.press("Home");
  await expect(overlay).toHaveCount(0);

  await dialog.getByRole("switch", { name: "Use surface mask", exact: true }).click();
  const light = dialog.getByRole("slider", { name: "Preview light" });
  await expect(light).toHaveValue("35");
  await light.focus(); await light.press("Home");
  await expect(light).toHaveValue("0");
  await dialog.getByRole("button", { name: "Projection effect", exact: true }).click();
  await expect(dialog.getByRole("note").filter({ hasText: "Projection effect preview unavailable" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Projection effect preview", exact: true })).toHaveCount(0);
  expect(modelRequests).toEqual([]);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await dialog.screenshot({ path: "/tmp/loom-photo-framing-guide.png" });
});

test("depth preparation shows native progress while the real model request is pending and reports its failure", async ({ page }) => {
  let blockedModel: Route | undefined;
  await page.route(DEPTH_ACCURATE.url, route => { blockedModel = route; });
  await openApp(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 2;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Processing fixture requires a canvas");
    const image = context.createImageData(4, 2);
    for (let i = 0; i < 8; i++) image.data.set([132, 132, 132, 255], i * 4);
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Map from photo…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  await dialog.getByRole("group", { name: "Reference photo" }).locator('input[type="file"]').setInputFiles({
    name: "pending-depth.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
  });
  await dialog.getByRole("button", { name: "Run depth", exact: true }).click();
  await expect.poll(() => blockedModel !== undefined).toBe(true);
  const pendingRoute = blockedModel;
  if (pendingRoute === undefined) throw new Error("The real depth model request must be pending");
  const progress = dialog.getByRole("progressbar", { name: "Depth preparation progress" });
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("max", "100");
  await expect(progress).toHaveAttribute("value", "0");
  const depthWell = dialog.getByTestId("depth-preview-frame").locator("..");
  await expect(depthWell).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Run depth", exact: true })).toBeDisabled();
  await dialog.screenshot({ path: "/tmp/loom-map-processing.png" });
  await pendingRoute.abort("failed");
  await expect(dialog.getByRole("alert")).toContainText("depth-anything-v2-small is not available");
  await expect(dialog.locator('p[role="status"]')).toContainText(/fetch|download|failed/i);
  await expect(progress).toHaveCount(0);
  await expect(depthWell).toHaveAttribute("aria-busy", "false");
  await expect(dialog.getByRole("button", { name: "Run depth", exact: true })).toBeEnabled();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
});

test("high-resolution mask strokes and radius edits avoid long stalls and remain undoable", async ({ page }) => {
  await openApp(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1536;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Mask interaction fixture requires a canvas");
    context.fillStyle = "rgb(128, 128, 128)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Map from photo…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  await dialog.getByRole("group", { name: "Reference photo", exact: true }).locator('input[type="file"]').setInputFiles({
    name: "high-resolution-mask.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
  });
  await dialog.getByRole("combobox", { name: "Mask detail", exact: true }).selectOption("1536");
  await dialog.getByRole("button", { name: "Start manual mask", exact: true }).click();
  await dialog.getByRole("button", { name: "Expand surface mask", exact: true }).click();
  const inspection = page.getByRole("dialog", { name: "Inspect photo mapping", exact: true });
  await inspection.getByRole("button", { name: "Erase mask", exact: true }).click();
  const editor = inspection.getByRole("img", { name: "Surface mask editor", exact: true });
  await editor.scrollIntoViewIfNeeded();
  const sample = () => editor.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Mask editor requires a canvas");
    return [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
  });
  const original = await sample();
  const timings = await page.evaluateHandle(() => {
    const durations: number[] = [];
    const observer = new PerformanceObserver(list => { durations.push(...list.getEntries().map(entry => entry.duration)); });
    observer.observe({ type: "longtask" });
    return { durations, observer };
  });
  const bounds = await editor.boundingBox();
  if (bounds === null) throw new Error("Mask editor must be reachable");
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(sample).not.toEqual(original);
  const erased = await sample();
  expect(erased[0]).toBeGreaterThan(erased[1]!);
  const radius = inspection.getByRole("slider", { name: "Mask brush radius", exact: true });
  await radius.focus();
  await radius.press("End"); await radius.press("Home");
  await expect(radius).toHaveValue("1");
  expect(await sample()).toEqual(erased);
  await inspection.getByRole("button", { name: "Undo mask stroke", exact: true }).click();
  await expect.poll(sample).toEqual(original);
  const durations = await timings.evaluate(value => { value.observer.disconnect(); return value.durations; });
  await timings.dispose();
  // A half-second main-thread task is a visible input stall, not a frame-rate benchmark.
  expect(durations.filter(duration => duration >= 500)).toEqual([]);
});


test("photo depth model choices disclose downloads and native requirements without starting inference", async ({ page }) => {
  const modelRequests: string[] = [];
  page.on("request", request => { if (request.resourceType() === "fetch" && /\.onnx(?:\?|$)/.test(request.url())) modelRequests.push(request.url()); });
  await openApp(page);
  await page.getByTestId("open-project-settings").click();
  await page.getByTestId("project-settings").getByRole("button", { name: "Map from photo…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  const model = dialog.getByRole("combobox", { name: "Model", exact: true });
  await expect(model.getByRole("option", { name: "Depth Anything V2 Large FP16 (637.7 MB)", exact: true })).toHaveCount(1);
  await expect(model.getByRole("option", { name: "Depth Anything V2 Large 4-bit (223.7 MB)", exact: true })).toHaveCount(1);
  await model.selectOption("depth-anything-v2-large-q4f16");
  await expect(dialog.getByText(/Large weights carry CC-BY-NC-4.0/)).toBeVisible();
  await model.selectOption("marigold-v2-q4");
  for (const label of ["Desktop only", "macOS", "Apple Silicon"]) await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/desktop app/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Run depth", exact: true })).toBeDisabled();
  expect(modelRequests).toEqual([]);
});


test("mask save suggestions distinguish corrected variants and retain the save gesture", async ({ page }) => {
  await openApp(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 2;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Photo fixture requires a canvas");
    context.fillRect(0, 0, 4, 2);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const photoBytes = Buffer.from(png, "base64");
  const source = { sha256: createHash("sha256").update(photoBytes).digest("hex"), width: 4, height: 2 };
  await page.getByTestId("open-project-settings").click();
  await page.getByTestId("project-settings").getByRole("button", { name: "Map from photo…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  await dialog.getByRole("group", { name: "Reference photo" }).locator('input[type="file"]').setInputFiles({ name: "Facade photo.png", mimeType: "image/png", buffer: photoBytes });
  await page.evaluate(() => {
    const scope = window as Window & { artifactSaveNames?: { name: string; activated: boolean }[]; showSaveFilePicker?: unknown };
    scope.artifactSaveNames = [];
    scope.showSaveFilePicker = async (options: { suggestedName: string }) => {
      scope.artifactSaveNames!.push({ name: options.suggestedName, activated: navigator.userActivation.isActive });
      throw new DOMException("Save cancelled by test", "AbortError");
    };
  });
  for (const value of [1, 0.75]) {
    const map = makePreparedMap(new Float32Array(8).fill(value), 4, 2, { kind: "mask", source,
      model: { id: PHOTO_MASK.id, url: PHOTO_MASK.url }, inputSide: 1024, registration: "stretch" });
    await dialog.getByRole("group", { name: "Existing mask map" }).locator('input[type="file"]').setInputFiles({
      name: "surface-mask.loom.exr", mimeType: "image/x-exr", buffer: Buffer.from(encodeDepthExr(map)),
    });
    const save = dialog.getByRole("button", { name: "Save mask again…", exact: true });
    await expect(save).toBeEnabled(); await save.click();
    await expect(save).toBeEnabled();
  }
  const names = await page.evaluate(() => (window as unknown as Window & { artifactSaveNames: { name: string; activated: boolean }[] }).artifactSaveNames);
  expect(names).toHaveLength(2);
  for (const entry of names) {
    expect(entry.name).toMatch(/^Facade-photo-mask-birefnet-lite-dynamic-in1024-4x2-[a-f0-9]{12}\.loom.exr$/);
    expect(entry.activated).toBe(true);
  }
  expect(names[0]!.name).not.toBe(names[1]!.name);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("preview slots retain their space and depth palettes change only inspection", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Map from photo…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
  const slots = [dialog.getByTestId("reference-photo-frame"), dialog.getByTestId("preview-photo-frame"), dialog.getByTestId("depth-preview-frame").locator("..")];
  const before = await Promise.all(slots.map(slot => slot.boundingBox()));
  for (const bounds of before) expect(bounds?.height).toBeGreaterThan(100);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext("2d"); if (context === null) throw new Error("Photo fixture needs a canvas");
    context.fillStyle = "#808080"; context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL().split(",")[1]!;
  });
  const photoBytes = Buffer.from(png, "base64");
  await dialog.getByRole("group", { name: "Reference photo", exact: true }).locator('input[type="file"]').setInputFiles({ name: "facade.png", mimeType: "image/png", buffer: photoBytes });
  await expect(dialog.getByRole("img", { name: "Reference photo", exact: true })).toBeVisible();
  const values = Float32Array.from({ length: 64 * 64 }, (_, index) => index % 64);
  const native = makePreparedMap(values, 64, 64, { kind: "depth", source: { sha256: createHash("sha256").update(photoBytes).digest("hex"), width: 600, height: 400 },
    model: { id: DEPTH_ACCURATE.id, url: DEPTH_ACCURATE.url }, inputSide: 518, registration: "letterbox" });
  await dialog.getByRole("group", { name: "Existing depth map", exact: true }).locator('input[type="file"]').setInputFiles({ name: "native.loom.exr", mimeType: "application/octet-stream", buffer: Buffer.from(encodeDepthExr(native)) });
  const canvas = dialog.getByLabel("Native depth display; numerical samples are shown below", { exact: true });
  await expect(canvas).toBeVisible();
  const after = await Promise.all(slots.map(slot => slot.boundingBox()));
  for (let index = 0; index < slots.length; index++) expect(Math.abs(after[index]!.height - before[index]!.height)).toBeLessThan(1);
  const frame = dialog.getByTestId("depth-preview-frame");
  const wellBounds = after[2]!; const frameBounds = (await frame.boundingBox())!;
  expect(frameBounds.y).toBeGreaterThanOrEqual(wellBounds.y - 1);
  expect(frameBounds.y + frameBounds.height).toBeLessThanOrEqual(wellBounds.y + wellBounds.height + 1);
  const colours = dialog.getByRole("combobox", { name: "Depth colours", exact: true });
  await expect(colours.getByRole("option")).toHaveText(["Grayscale", "Ocean", "Heat", "Spectrum"]);
  const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d"); if (context === null) throw new Error("Depth canvas needs a context");
    return [...context.getImageData(10, 10, 1, 1).data];
  });
  const grayscale = await pixels(); expect(grayscale[0]).toBe(grayscale[1]);
  await colours.selectOption("ocean");
  await expect.poll(pixels).not.toEqual(grayscale);
  await colours.selectOption("grayscale"); await expect.poll(pixels).toEqual(grayscale);
  await dialog.screenshot({ path: "/private/tmp/loom-photo-layout.png" });
  await page.setViewportSize({ width: 820, height: 1000 });
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const narrow = await dialog.boundingBox();
  expect(narrow!.x).toBeGreaterThanOrEqual(0);
  expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(820);
});

for (const viewport of [{ width: 1332, height: 900 }, { width: 1366, height: 768 }]) {
  test(`desktop photo workflow fits without scrolling at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page);
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("menuitem", { name: "Map from photo…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Map from photo", exact: true });
    const body = page.getByTestId("photo-mapping-body");
    const fits = async () => {
      await expect.poll(() => body.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      await expect.poll(() => body.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      for (const name of ["Choose reference photo", "Photo and depth inspection", "Depth preparation", "Surface mask preparation", "Create or update mapping"]) {
        await expect(dialog.getByRole("region", { name, exact: true })).toBeInViewport({ ratio: 1 });
      }
      await expect(dialog.getByRole("button", { name: "Create mapping network", exact: true })).toBeInViewport({ ratio: 1 });
    };
    await fits();
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 400;
      const context = canvas.getContext("2d"); if (context === null) throw new Error("Photo fixture needs a canvas");
      context.fillStyle = "#888"; context.fillRect(0, 0, 600, 400); return canvas.toDataURL().split(",")[1]!;
    });
    const image = { name: "facade.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") };
    await dialog.getByRole("group", { name: "Reference photo", exact: true }).locator('input[type="file"]').setInputFiles(image);
    await expect(dialog.getByRole("img", { name: "Reference photo", exact: true })).toBeVisible();
    await dialog.getByRole("group", { name: "Preview photo (optional)", exact: true }).locator('input[type="file"]').setInputFiles({ ...image, name: "night.png" });
    await expect(dialog.getByRole("combobox", { name: "Preview fit", exact: true })).toBeVisible();
    await dialog.getByRole("combobox", { name: "Model", exact: true }).selectOption("marigold-v2-q4");
    await dialog.getByRole("button", { name: "Start manual mask", exact: true }).click();
    for (const name of ["Erase mask", "Restore mask", "Pan mask"]) await expect(dialog.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(dialog.getByRole("slider", { name: "Mask brush radius", exact: true })).toBeVisible();
    await fits();
    await dialog.screenshot({ path: `/private/tmp/loom-photo-fit-${viewport.width}x${viewport.height}.png` });
    await page.setViewportSize({ width: 820, height: 700 });
    await expect(dialog.getByRole("button", { name: "Create mapping network", exact: true })).toBeInViewport({ ratio: 1 });
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(dialog.getByRole("combobox", { name: "First effect", exact: true })).toBeInViewport({ ratio: 1 });
  });
}
