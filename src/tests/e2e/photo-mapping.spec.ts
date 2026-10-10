import { expect, test, type Route } from "@playwright/test";
import { DEPTH_ACCURATE, PHOTO_FACADE } from "@runtime/models/model-catalogue.ts";
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
  const dialog = page.getByRole("dialog");
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
  await expect(maskMethod.getByRole("option")).toHaveText(["Facade walls and openings", "Object background removal"]);
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
  await expect(effect.getByRole("option")).toHaveText(["Neon contours", "Prismatic sweep", "Chromatic relief", "Surface trace", "Depth reveal"]);
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
  const dialog = page.getByRole("dialog");
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
  expect(Math.abs(referenceBounds.y - previewBounds.y)).toBeLessThan(1);
  expect(Math.abs(referenceBounds.height - previewBounds.height)).toBeLessThan(1);
  expect(previewBounds.x).toBeGreaterThan(referenceBounds.x + referenceBounds.width);
  expect(referenceBounds.height).toBeGreaterThan(100);
  await expect(dialog.getByRole("combobox", { name: "Preview fit" })).toHaveValue("stretch");
  expect(modelRequests).toEqual([]);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await dialog.screenshot({ path: "/tmp/loom-photo-pair-preview.png" });
  await dialog.getByRole("switch", { name: "Use surface mask", exact: true }).click();
  const animated = dialog.getByRole("img", { name: "Animated mapping preview", exact: true });
  await expect(animated).toBeVisible();
  const centre = await animated.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("The animated preview needs a canvas");
    return [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
  });
  // A missing bitmap extent draws no photograph: overlays alone are translucent.
  expect(centre[3]).toBe(255);
  expect(centre[0]).toBeGreaterThan(90);
  expect(centre[2]).toBeLessThan(200);
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
  const dialog = page.getByRole("dialog");
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
  await expect(dialog.getByRole("img", { name: "Animated mapping preview" })).toBeVisible();
  const depthPreview = dialog.getByTestId("depth-preview-frame");
  const maskPreview = dialog.getByTestId("mask-preview-frame");
  const desktopDepth = await depthPreview.boundingBox();
  const desktopMask = await maskPreview.boundingBox();
  const depthDetail = dialog.getByRole("combobox", { name: "Detail", exact: true });
  const maskDetail = dialog.getByRole("combobox", { name: "Mask detail", exact: true });
  await expect(depthDetail).toBeVisible(); await expect(maskDetail).toBeVisible();
  const desktopDepthDetail = await depthDetail.boundingBox();
  const desktopMaskDetail = await maskDetail.boundingBox();
  if (desktopDepth === null || desktopMask === null) throw new Error("Both map preview frames must exist before depth inference");
  if (desktopDepthDetail === null || desktopMaskDetail === null) throw new Error("Both native detail controls must be visible above the map previews");
  expect(desktopDepthDetail.y + desktopDepthDetail.height).toBeLessThan(desktopDepth.y);
  expect(desktopMaskDetail.y + desktopMaskDetail.height).toBeLessThan(desktopMask.y);
  expect(Math.abs(desktopDepth.y - desktopMask.y)).toBeLessThan(1);
  expect(Math.abs(desktopDepth.y + desktopDepth.height - desktopMask.y - desktopMask.height)).toBeLessThan(1);
  expect(Math.abs(desktopDepth.width - desktopMask.width)).toBeLessThan(1);
  expect(desktopMask.x).toBeGreaterThan(desktopDepth.x + desktopDepth.width);
  await dialog.screenshot({ path: "/tmp/loom-photo-mapping-panel.png" });

  await page.setViewportSize({ width: 640, height: 900 });
  const narrowDepth = await depthPreview.boundingBox();
  const narrowMask = await maskPreview.boundingBox();
  await expect(depthDetail).toBeVisible(); await expect(maskDetail).toBeVisible();
  const narrowDepthDetail = await depthDetail.boundingBox();
  const narrowMaskDetail = await maskDetail.boundingBox();
  if (narrowDepth === null || narrowMask === null) throw new Error("Both map preview frames must remain present at narrow widths");
  if (narrowDepthDetail === null || narrowMaskDetail === null) throw new Error("Both detail controls must remain visible at narrow widths");
  expect(narrowDepthDetail.y + narrowDepthDetail.height).toBeLessThan(narrowDepth.y);
  expect(narrowMaskDetail.y + narrowMaskDetail.height).toBeLessThan(narrowMask.y);
  expect(Math.abs(narrowDepth.x - narrowMask.x)).toBeLessThan(1);
  expect(Math.abs(narrowDepth.width - narrowMask.width)).toBeLessThan(1);
  expect(narrowMask.y).toBeGreaterThan(narrowDepth.y + narrowDepth.height);
  expect(narrowDepth.width / narrowDepth.height).toBeCloseTo(2, 1);
  expect(narrowMask.width / narrowMask.height).toBeCloseTo(2, 1);
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
  await expect(dialog.getByRole("combobox", { name: "Brush", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Rerun mask", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save mask…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Start manual mask", exact: true })).toBeDisabled();
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

test("mismatched photos explain crop, borders and stretch and allow an unlit alignment comparison", async ({ page }) => {
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
  const dialog = page.getByRole("dialog");
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
  const animated = dialog.getByRole("img", { name: "Animated mapping preview", exact: true });
  await expect(animated).toBeVisible();
  await expect.poll(() => animated.evaluate(element => {
    const canvas = element as HTMLCanvasElement; const context = canvas.getContext("2d");
    if (context === null) throw new Error("The animated preview requires a canvas");
    return { size: [canvas.width, canvas.height], centre: [...context.getImageData(150, 100, 1, 1).data], corner: [...context.getImageData(1, 1, 1, 1).data] };
  })).toEqual({ size: [300, 200], centre: [101, 120, 154, 255], corner: [16, 24, 40, 255] });
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
  const dialog = page.getByRole("dialog");
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
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("group", { name: "Reference photo", exact: true }).locator('input[type="file"]').setInputFiles({
    name: "high-resolution-mask.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
  });
  await dialog.getByRole("combobox", { name: "Mask detail", exact: true }).selectOption("1536");
  await dialog.getByRole("button", { name: "Start manual mask", exact: true }).click();
  const editor = dialog.getByRole("img", { name: "Surface mask editor", exact: true });
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
  const erased = await sample();
  expect(erased[0]).toBeGreaterThan(erased[1]!);
  const radius = dialog.getByRole("slider", { name: /^Radius/ });
  await radius.focus();
  await radius.press("End"); await radius.press("Home");
  await expect(radius).toHaveValue("1");
  expect(await sample()).toEqual(erased);
  await dialog.getByRole("button", { name: "Undo stroke", exact: true }).click();
  expect(await sample()).toEqual(original);
  const durations = await timings.evaluate(value => { value.observer.disconnect(); return value.durations; });
  await timings.dispose();
  // A half-second main-thread task is a visible input stall, not a frame-rate benchmark.
  expect(durations.filter(duration => duration >= 500)).toEqual([]);
});
