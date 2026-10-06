import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { buildProjectFile } from "@domain/project/project-file.ts";
import type { ProjectDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { SCHEMA_VERSION } from "@domain/types/schemas.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

import { APP_VIEWPORT, openApp, selectNode } from "./app.ts";

/**
 * T1653b — WHAT A VALUE WRITTEN COSTS CHROMIUM'S PAINT PIPELINE, counted in its own trace.
 *
 * Two things made one moved slider repaint the whole canvas, and neither was a DOM change
 * a test of the DOM could see:
 *
 *  1. THE CANVAS ROOT'S WHEEL LISTENER WAS RE-BOUND ON EVERY RENDER (a new `panOnDrag`
 *     array per render keyed an effect in the library). For a blocking wheel listener that
 *     changed, Chromium re-derives the hit-test data of everything under it: its paint
 *     invalidator visited every object of every node. `library-props.test.tsx` holds the
 *     cause in jsdom; here the EFFECT is counted — the canvas nodes the invalidator visits
 *     for a run of writes are the nodes that show the value, under ONE bound at 50 nodes
 *     and at 200.
 *
 *  2. A SHARE WAS DRAWN AS A BOX THAT CHANGES SIZE (a fill, a value bar, a number field's
 *     fill), and a changed box forces the full compositor update
 *     (`PaintArtifactCompositor::Update`). `ShareFill` draws a share by padding on a fixed
 *     box that is not a plainly opaque square, which takes the repaint path. That is a
 *     reading of Chromium's heuristics, so this is where it is held: a run of writes to
 *     each control makes NO full update, and if a browser changes its mind this goes red
 *     and says which control.
 *
 * Counts, never a clock. The lane is the GPU one because that is the app a performer
 * runs: the frame loop is drawing while the values move.
 *
 * Not held here: the preset's fade bar (the same primitive; it needs a fade in flight) and
 * the XY pad's puck, which is a point and still moves as geometry (`share-geometry.test.ts`
 * names both).
 */

test.use({ viewport: APP_VIEWPORT });

const CATEGORIES = ["devtools.timeline", "blink", "disabled-by-default-blink.invalidation"];

interface TraceEvent {
  readonly name?: string;
  readonly ph?: string;
  readonly cat?: string;
  readonly args?: { readonly object?: string };
}

interface PaintCounts {
  /** `PaintArtifactCompositor::Update`: the full compositor update. */
  readonly fullUpdates: number;
  /** Canvas NODES the paint invalidator visited (each visit of a node's root box). */
  readonly nodeVisits: number;
  /** Any object under the canvas it visited: nodes, their insides, edges. */
  readonly canvasVisits: number;
}

function count(buffer: Buffer): PaintCounts {
  const events = (JSON.parse(buffer.toString("utf8")) as { traceEvents: TraceEvent[] }).traceEvents;
  const visited = events.filter((event) => event.ph === "X" && event.name === "PaintInvalidator::InvalidatePaint()").map((event) => event.args?.object ?? "");
  return {
    fullUpdates: events.filter((event) => event.ph === "X" && event.name === "PaintArtifactCompositor::Update").length,
    nodeVisits: visited.filter((name) => /class='react-flow__node /.test(name)).length,
    canvasVisits: visited.filter((name) => /react-flow__(node|edge|handle)/.test(name)).length,
  };
}

async function traced(browser: Browser, page: Page, act: () => Promise<void>): Promise<PaintCounts> {
  await browser.startTracing(page, { categories: CATEGORIES });
  await act();
  return count(await browser.stopTracing());
}

/** Two animation frames: what was just written has been drawn, and nothing of it is left for the next write's frame. */
const drawn = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/**
 * A chain of `levels` Level nodes on a grid, a Slider (0..1, default 0.5) on a published
 * Panel, an Output. Built through the bus and written as the app saves, so opening it is
 * opening a project.
 */
async function documentOf(levels: number): Promise<{ path: string; slider: string; level: string }> {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const operations: unknown[] = [
    { op: "addNode", ref: "$src", type: "noise", position: { x: 0, y: 0 }, label: "noise_src" },
    { op: "addNode", ref: "$slider", type: "slider", position: { x: -800, y: 0 }, label: "slider_gain", parameters: { caption: "Gain", channel: "gain", value: 0.5, min: 0, max: 1, step: 0, defaultValue: 0.5 } },
    { op: "addNode", ref: "$panel", type: "panel", position: { x: -800, y: 400 }, label: "panel_desk", parameters: { title: "Desk", board: serializePanelBoard({ columns: 8, items: [{ member: "slider_gain", rect: { x: 0, y: 0, w: 8, h: 1 } }] }) } },
    { op: "connect", source: { nodeId: "$slider", portId: "out" }, target: { nodeId: "$panel", portId: "controls" } },
  ];
  let previous = "$src";
  for (let index = 0; index < levels; index += 1) {
    const ref = `$level${String(index)}`;
    operations.push({ op: "addNode", ref, type: "level", position: { x: ((index % 20) + 1) * 360, y: Math.floor(index / 20) * 260 }, label: `level_n${String(index)}` });
    operations.push({ op: "connect", source: { nodeId: previous, portId: "out" }, target: { nodeId: ref, portId: "input" } });
    previous = ref;
  }
  operations.push({ op: "addNode", ref: "$out", type: "output", position: { x: 22 * 360, y: 0 }, label: "output_frame" });
  operations.push({ op: "connect", source: { nodeId: previous, portId: "out" }, target: { nodeId: "$out", portId: "input" } });
  const result = await bus.execute(
    "graph.applyPatch",
    { baseRevision: store.view.getRevision(), operations: operations as GraphPatchOperation[], label: "canvas-paint" },
    { actor: { kind: "system", id: "t1653b" }, projectId: "t1653b", capabilities: [] },
  );
  if (result.status !== "applied") throw new Error(`the document did not build: ${JSON.stringify(result.diagnostics).slice(0, 400)}`);
  const graph = store.view.getGraph();
  const now = "2026-10-06T00:00:00.000Z";
  const document: ProjectDocument = { schemaVersion: SCHEMA_VERSION, projectId: `t1653b-${String(levels)}`, name: `paint-${String(levels)}`, graph, settings: store.view.getSettings(), assets: [], createdAt: now, updatedAt: now };
  const path = join(await mkdtemp(join(tmpdir(), "loom-canvas-paint-")), `paint-${String(levels)}.loom.json`);
  await writeFile(path, buildProjectFile({ document, now: () => now }).text);
  const idOf = (label: string): string => Object.values(graph.nodes).find((node) => node.label === label)?.id ?? "";
  return { path, slider: idOf("slider_gain"), level: idOf("level_n0") };
}

async function openDocument(page: Page, path: string): Promise<void> {
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles(path);
  await expect(page.locator('.react-flow__node[data-id]').first()).toBeAttached({ timeout: 60_000 });
  // The first frames after an open build programs and measure nodes; let that end.
  await page.waitForTimeout(2500);
}

/** The Controls tab's slider, held down by the mouse at `share` of its width, away from its default. */
async function holdSlider(page: Page): Promise<{ slider: Locator; to: (share: number) => Promise<void>; release: () => Promise<void> }> {
  await page.getByRole("tab", { name: "controls" }).click();
  const slider = page.locator("[data-controls-pane]").getByRole("slider", { name: "Gain" });
  await expect(slider).toBeVisible();
  const box = await slider.boundingBox();
  if (box === null) throw new Error("the slider has no box");
  const y = box.y + box.height / 2;
  const to = async (share: number): Promise<void> => {
    await page.mouse.move(box.x + box.width * share, y);
    await drawn(page);
  };
  await page.mouse.move(box.x + box.width * 0.62, y);
  await page.mouse.down();
  // The first write makes the document dirty and takes the control off its default: both change real geometry, once.
  await to(0.64);
  await to(0.66);
  return { slider, to, release: () => page.mouse.up() };
}

const MOVES = [0.7, 0.74, 0.78, 0.82, 0.86, 0.9, 0.86, 0.8, 0.75, 0.7] as const;
/**
 * What ten writes may repaint on the canvas, AT ANY SIZE OF DOCUMENT: the two nodes that
 * draw the slider (its own, and the Panel that holds it), each in the frame of the write
 * and in the one after it, where the node's value plot follows. Measured: 14 to 24 visits
 * of a node's root for the ten, at 50 nodes as at 200. With the wheel listener re-bound per
 * render it was every node for every write: 500 and 2000.
 */
const MAY_REPAINT = MOVES.length * 2 * 2;

for (const levels of [50, 200]) {
  test(`${String(levels)} nodes: ten values written repaint only the nodes that show them, and force no full compositor update`, async ({ browser, page }) => {
    const built = await documentOf(levels);
    await openDocument(page, built.path);
    const held = await holdSlider(page);
    const fill = held.slider.locator("span").first();
    const before = await fill.evaluate((element) => (element as HTMLElement).style.paddingInlineEnd);

    const counts = await traced(browser, page, async () => {
      for (const share of MOVES) await held.to(share);
    });
    await held.release();

    // Not vacuous: the slider moved, as a share of a box that did not.
    expect(await held.slider.getAttribute("aria-valuenow")).not.toBe("0.5");
    expect(await fill.evaluate((element) => (element as HTMLElement).style.paddingInlineEnd)).not.toBe(before);
    expect(counts.nodeVisits, "no canvas node was repainted: the trace category is gone, or the node does not show its value").toBeGreaterThan(0);

    // 1. Bounded by what shows the value: the SAME bound at 50 nodes and at 200.
    expect(counts.nodeVisits, `the paint invalidator visited ${String(counts.nodeVisits)} canvas nodes for ${String(MOVES.length)} writes on a ${String(levels)}-node document`).toBeLessThanOrEqual(MAY_REPAINT);
    // 2. THE SLIDER'S FILL and THE VALUE BAR of its node: a share that moved is not a box that moved.
    expect(counts.fullUpdates, `writing the Controls SLIDER (its fill, and its node's VALUE BAR) forced ${String(counts.fullUpdates)} full compositor updates in ${String(MOVES.length)} writes`).toBe(0);
  });
}

test("a document whose values do not change repaints nothing on the canvas, frame after frame", async ({ browser, page }) => {
  const built = await documentOf(200);
  await openDocument(page, built.path);
  const counts = await traced(browser, page, async () => {
    await page.waitForTimeout(1000);
  });
  expect(counts.canvasVisits, `the paint invalidator visited ${String(counts.canvasVisits)} canvas objects in an idle second`).toBe(0);
  expect(counts.fullUpdates, "an idle second forced a full compositor update").toBe(0);
});

test("a number field dragged in the inspector forces no full compositor update: its fill is a share too", async ({ browser, page }) => {
  const built = await documentOf(50);
  await openDocument(page, built.path);
  await selectNode(page, built.level);
  // Opacity runs 0..1 and rests at 1, so the field has a fill and the drag goes down from the top.
  const field = page.locator('input[aria-label="Opacity"]');
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  if (box === null) throw new Error("the Opacity field has no box");
  const y = box.y + box.height / 2;
  const x = box.x + box.width - 20;
  // The fill is the field's first child, before its input (`number-field.tsx`).
  const fill = field.locator("xpath=preceding-sibling::span[1]");
  await page.mouse.move(x, y);
  await page.mouse.down();
  // The press, the first write (the dirty mark) and the drag's own chrome are geometry, once.
  for (const back of [8, 16, 24]) {
    await page.mouse.move(x - back, y);
    await drawn(page);
  }
  const before = await fill.evaluate((element) => (element as HTMLElement).style.paddingInlineEnd);

  const counts = await traced(browser, page, async () => {
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(x - 24 - step * 5, y);
      await drawn(page);
    }
  });
  const after = await fill.evaluate((element) => (element as HTMLElement).style.paddingInlineEnd);
  await page.mouse.up();

  expect(after, "the field's fill did not move: the drag wrote nothing").not.toBe(before);
  expect(counts.fullUpdates, `dragging a NUMBER FIELD forced ${String(counts.fullUpdates)} full compositor updates in 10 writes`).toBe(0);
});
