import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { ProjectDocument } from "../../domain/types/graph.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";
import { APP_VIEWPORT, dragNumber, modKey, openApp, selectNode } from "./app";

/**
 * §T1696b / §B286 — A KEY PRESSED INSIDE A COMPONENT ACTS ON THE COMPONENT, in a real browser.
 *
 * The defect is a keystroke and a click, and it was measured in jsdom with React Flow
 * stubbed (`docs/component-session-commands-design-2026-10-06.md` §0.3): inside a component,
 * Cmd+Z undid the PROJECT, and Delete on an interior node whose id a root node shares
 * removed the ROOT node. `src/tests/integration/session-doors.test.tsx` holds the same
 * claims against the mounted app; this file presses the keys where a person presses them,
 * with real focus, real selection and the real React Flow.
 *
 * Nothing here needs a GPU: these are editor and document claims, read off the DOM the
 * canvas draws (a node's `data-id`). The `chromium` project, no window.
 */

test.use({ viewport: APP_VIEWPORT });

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

/** The double-click on an instance's body, which is TD's gesture and `graph.diveIn`'s door (T602). */
async function diveInto(page: Page, id: string): Promise<void> {
  const box = await node(page, id).boundingBox();
  if (box === null) throw new Error(`the instance "${id}" has no bounding box`);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
}

const idsOnCanvas = (page: Page): Promise<string[]> =>
  page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((each) => each.getAttribute("data-id") ?? ""));

/**
 * Adds a Noise from the node library into the graph on the canvas, and returns the id of the
 * node that APPEARED. By difference, not by position: inside a component the new node is not
 * the last element React Flow draws.
 */
async function addNoise(page: Page): Promise<string> {
  const before = await idsOnCanvas(page);
  await page.locator('section[aria-label="generator"] button', { hasText: /^Noise/ }).first().click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before.length + 1);
  const added = (await idsOnCanvas(page)).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  return added[0] as string;
}

async function openExample(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles(file);
}

test("Delete inside E47's DepthCut removes the interior `cut`, and the instance `cut` stands", async ({ page }) => {
  await openApp(page);
  await openExample(page, "examples/E47-Hologram.loom.json");
  // The collision the report rests on: the project's node `cut` is the DepthCut instance,
  // and DepthCut holds a node `cut` of its own.
  await expect(node(page, "holo")).toBeVisible();
  await expect(node(page, "cut")).toBeVisible();

  await diveInto(page, "cut");
  // Inside: the component's nodes are on the canvas and the project's are not.
  await expect(node(page, "matte")).toBeVisible();
  await expect(node(page, "holo")).toHaveCount(0);
  await expect(node(page, "cut")).toBeVisible();

  // Click the interior node's name (the selection a person makes), then the key.
  await page.getByTestId("node-name-cut").click();
  await expect(node(page, "cut")).toHaveClass(/selected/);
  await page.keyboard.press("Delete");

  // The interior node is gone, and the editor is STILL inside. On main the key deleted the
  // instance being edited instead, which threw the editor back out to the project.
  await expect(node(page, "cut")).toHaveCount(0);
  await expect(node(page, "matte")).toBeVisible();

  // Back out: the instance of the same id stands in the project.
  await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("u");
  await expect(node(page, "holo")).toBeVisible();
  await expect(node(page, "cut")).toBeVisible();
});

test("Cmd+Z inside Bloom undoes the edit made inside, and the edit made at the root stays", async ({ page }) => {
  await openApp(page);
  const mod = await modKey(page);

  // The project: one Bloom instance, placed from the component library...
  await page.getByRole("tab", { name: "components" }).click();
  await page.getByRole("button", { name: /^Bloom\s*v\d/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  const bloom = await page.locator(".react-flow__node").first().getAttribute("data-id");
  if (bloom === null) throw new Error("the Bloom instance carries no data-id");
  // ...and then an edit AT THE ROOT, which is the project's most recent undo step.
  await page.getByRole("tab", { name: "node library" }).click();
  const rootNode = await addNoise(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);

  await diveInto(page, bloom);
  await expect(node(page, "bright")).toBeVisible();
  await expect(node(page, rootNode)).toHaveCount(0);
  const interior = await page.locator(".react-flow__node").count();
  expect(interior).toBeGreaterThan(2);

  // An edit INSIDE: one more node, from the same library, into the graph on the canvas.
  const innerNode = await addNoise(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(interior + 1);

  // THE REPORT: Cmd+Z, standing inside the component.
  await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
  await page.keyboard.press(`${mod}+z`);

  // The inside edit came back out...
  await expect(node(page, innerNode)).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(interior);

  // ...and the project's edit is where it was. On main this key removed `rootNode`.
  await page.keyboard.press("u");
  await expect(node(page, bloom)).toBeVisible();
  await expect(node(page, rootNode)).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
});

test("Bloom Pyramid is placed from the library, tuned and reopened with its editable graph", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "components" }).click();
  await page.getByRole("button", { name: /^Bloom Pyramid\s*v\d/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  const instanceId = await page.locator(".react-flow__node").first().getAttribute("data-id");
  if (instanceId === null) throw new Error("Bloom Pyramid instance has no id");
  await selectNode(page, instanceId);
  const inspector = page.getByRole("tabpanel", { name: "inspector" });
  for (const label of ["Threshold", "Knee", "Radius", "Spread", "Firefly Filter"]) {
    await expect(inspector.getByRole("spinbutton", { name: label, exact: true })).toHaveCount(1);
  }
  const change = await dragNumber(page, "Threshold", 80);
  expect(change.after).not.toBe(change.before);

  const downloading = page.waitForEvent("download");
  await page.getByTestId("project-save").click();
  const savedPath = await (await downloading).path();
  if (savedPath === null) throw new Error("Saved project has no local download");
  const saved = JSON.parse(await readFile(savedPath, "utf8")) as ProjectDocument;
  expect(storedStaticValue(saved.graph.nodes[instanceId]?.parameters["threshold"])).toBe(Number(change.after));
  await openExample(page, savedPath);
  await selectNode(page, instanceId);
  await expect(inspector.getByRole("spinbutton", { name: "Threshold", exact: true })).toHaveValue(change.after);

  await diveInto(page, instanceId);
  await expect(node(page, "bright")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(11);
  await expect(node(page, "bloomUp0")).toHaveCount(1);
  await expect(node(page, "in_picture")).toHaveCount(1);
  await expect(node(page, "out_out")).toHaveCount(1);
});
