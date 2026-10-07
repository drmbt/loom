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
import { serializePresetBank } from "@domain/presets/bank.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

import { BARS_LEGIBLE_SCALE, CURVE_LEGIBLE_SCALE } from "@editor/nodes/value-plot-mode.ts";

import { APP_VIEWPORT, fitAll, openApp, selectNode, viewportSettled } from "./app.ts";

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
 * The XY pad's puck is not a share (a point in two axes) and is held here by the same
 * count: it is drawn by a background's position in a box that does not move (T1669b).
 */

test.use({ viewport: APP_VIEWPORT });

const CATEGORIES = ["devtools.timeline", "blink", "disabled-by-default-blink.invalidation", "disabled-by-default-devtools.timeline.invalidationTracking"];

interface TraceEvent {
  readonly name?: string;
  readonly ph?: string;
  readonly cat?: string;
  readonly args?: { readonly object?: string; readonly data?: { readonly nodeName?: string; readonly reason?: string; readonly stackTrace?: ReadonlyArray<{ readonly functionName?: string; readonly url?: string; readonly lineNumber?: number }> } };
}

interface PaintCounts {
  /** `PaintArtifactCompositor::Update`: the full compositor update. */
  readonly fullUpdates: number;
  /** Canvas NODES the paint invalidator visited (each visit of a node's root box). */
  readonly nodeVisits: number;
  /** Any object under the canvas it visited: nodes, their insides, edges. */
  readonly canvasVisits: number;
  /**
   * WHAT WAS LAID OUT AGAIN in those seconds, by Chromium's own account (element and reason):
   * a full update is forced by geometry that changed, so this is where to look when the
   * count above is not zero. Said in every failure message.
   */
  readonly laidOut: string;
}

function count(buffer: Buffer): PaintCounts {
  const events = (JSON.parse(buffer.toString("utf8")) as { traceEvents: TraceEvent[] }).traceEvents;
  const visited = events.filter((event) => event.ph === "X" && event.name === "PaintInvalidator::InvalidatePaint()").map((event) => event.args?.object ?? "");
  const layouts = new Map<string, number>();
  for (const event of events) {
    if (event.name !== "LayoutInvalidationTracking") continue;
    const reason = event.args?.data?.reason ?? "?";
    // A node that came or went was put there by script: say whose (the app's own frames, not React's).
    const by = /Added|Removed/.test(reason)
      ? (event.args?.data?.stackTrace ?? []).filter((frame) => /\/src\//.test(frame.url ?? "")).slice(0, 2).map((frame) => `${frame.functionName ?? "?"}@${(frame.url ?? "").split("/src/")[1]?.split("?")[0] ?? "?"}:${String(frame.lineNumber)}`).join(" < ")
      : "";
    const what = `${event.args?.data?.nodeName ?? "?"} (${reason}${by === "" ? "" : `, by ${by}`})`.replace(/_[a-z0-9]{5}_\d+/g, "");
    layouts.set(what, (layouts.get(what) ?? 0) + 1);
  }
  return {
    laidOut: [...layouts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([what, times]) => `${String(times)}x ${what}`).join("; ") || "nothing",
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

/**
 * After the FIRST writes of a gesture, before anything is counted: the document became
 * dirty, a control left its default, the Controls header gained its count — real geometry,
 * once, and under a busy machine React commits it some frames after the write that caused
 * it (seen: three text nodes added inside a traced drag, two runs in four). Not a sleep in
 * place of a condition on the claim: the claim is about the writes AFTER this.
 */
const firstWritesSettled = async (page: Page): Promise<void> => {
  await page.waitForTimeout(400);
  await drawn(page);
};

/** Two animation frames: what was just written has been drawn, and nothing of it is left for the next write's frame. */
const drawn = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/**
 * A chain of `levels` Level nodes on a grid, a Slider (0..1, default 0.5) on a published
 * Panel, an Output. Built through the bus and written as the app saves, so opening it is
 * opening a project.
 *
 * `signals` (T1691b): that many LFOs, each into a Lag, in a row to the left of the slider:
 * tiles whose value moves by itself, a curve and a bar of each.
 */
async function documentOf(levels: number, signals = 0): Promise<{ path: string; slider: string; level: string; lag: string; signals: string[] }> {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const operations: unknown[] = [
    { op: "addNode", ref: "$src", type: "noise", position: { x: 0, y: 0 }, label: "noise_src" },
    { op: "addNode", ref: "$slider", type: "slider", position: { x: -800, y: 0 }, label: "slider_gain", parameters: { caption: "Gain", channel: "gain", value: 0.5, min: 0, max: 1, step: 0, defaultValue: 0.5 } },
    { op: "addNode", ref: "$pad", type: "xyPad", position: { x: -800, y: 900 }, label: "xypad_aim", parameters: { caption: "Aim" } },
    // A bank over the slider, three seconds a recall: a fade in flight draws the bank's fade bar.
    {
      op: "addNode", ref: "$bank", type: "presets", position: { x: -800, y: 1500 }, label: "presets_looks",
      parameters: { targets: "slider_gain", morph: 3, presets: serializePresetBank({ version: 1, presets: [{ name: "low", values: { slider_gain: { value: 0.1 } } }, { name: "high", values: { slider_gain: { value: 0.9 } } }] }) },
    },
    {
      op: "addNode", ref: "$panel", type: "panel", position: { x: -800, y: 400 }, label: "panel_desk",
      parameters: {
        title: "Desk",
        board: serializePanelBoard({ columns: 8, items: [{ member: "slider_gain", rect: { x: 0, y: 0, w: 8, h: 1 } }, { member: "presets_looks", rect: { x: 0, y: 1, w: 8, h: 1 } }, { member: "xypad_aim", rect: { x: 0, y: 2, w: 4, h: 4 } }] }),
      },
    },
    { op: "connect", source: { nodeId: "$slider", portId: "out" }, target: { nodeId: "$panel", portId: "controls" } },
    { op: "connect", source: { nodeId: "$pad", portId: "out" }, target: { nodeId: "$panel", portId: "controls" } },
  ];
  let previous = "$src";
  for (let index = 0; index < levels; index += 1) {
    const ref = `$level${String(index)}`;
    operations.push({ op: "addNode", ref, type: "level", position: { x: ((index % 20) + 1) * 360, y: Math.floor(index / 20) * 260 }, label: `level_n${String(index)}` });
    operations.push({ op: "connect", source: { nodeId: previous, portId: "out" }, target: { nodeId: ref, portId: "input" } });
    previous = ref;
  }
  for (let index = 0; index < signals; index += 1) {
    const x = -1200 - index * 360;
    operations.push({ op: "addNode", ref: `$lfo${String(index)}`, type: "lfo", position: { x, y: 0 }, label: `lfo_s${String(index)}` });
    operations.push({ op: "addNode", ref: `$lag${String(index)}`, type: "valueLag", position: { x, y: 300 }, label: `lag_s${String(index)}` });
    operations.push({ op: "connect", source: { nodeId: `$lfo${String(index)}`, portId: "out" }, target: { nodeId: `$lag${String(index)}`, portId: "in" } });
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
  const signalIds = Array.from({ length: signals }, (_, index) => [idOf(`lfo_s${String(index)}`), idOf(`lag_s${String(index)}`)]).flat();
  return { path, slider: idOf("slider_gain"), level: idOf("level_n0"), lag: idOf("lag_s0"), signals: signalIds };
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
  await firstWritesSettled(page);
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
    expect(counts.fullUpdates, `writing the Controls SLIDER (its fill, and its node's VALUE BAR) forced ${String(counts.fullUpdates)} full compositor updates in ${String(MOVES.length)} writes; laid out again: ${counts.laidOut}`).toBe(0);
  });
}

test("a document whose values do not change repaints nothing on the canvas, frame after frame", async ({ browser, page }) => {
  const built = await documentOf(200);
  await openDocument(page, built.path);
  const counts = await traced(browser, page, async () => {
    await page.waitForTimeout(1000);
  });
  expect(counts.canvasVisits, `the paint invalidator visited ${String(counts.canvasVisits)} canvas objects in an idle second`).toBe(0);
  expect(counts.fullUpdates, `an idle second forced a full compositor update; laid out again: ${counts.laidOut}`).toBe(0);
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
  await firstWritesSettled(page);
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
  expect(counts.fullUpdates, `dragging a NUMBER FIELD forced ${String(counts.fullUpdates)} full compositor updates in 10 writes; laid out again: ${counts.laidOut}`).toBe(0);
});

test("an XY pad dragged forces no full compositor update: its puck is drawn, not moved (T1669b)", async ({ browser, page }) => {
  const built = await documentOf(50);
  await openDocument(page, built.path);
  await page.getByRole("tab", { name: "controls" }).click();
  const pad = page.locator('[data-controls-pane] [data-control="xy"] [role="group"]');
  await expect(pad).toBeVisible();
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  if (box === null) throw new Error("the pad has no box");
  const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x as number, y as number); return `${e?.tagName ?? "?"}.${String(e?.className ?? "")} in ${e?.closest("[data-control]")?.getAttribute("data-control") ?? "no control"}`; }, [box.x + box.width * 0.4, box.y + box.height * 0.4]);
  const at = (u: number, v: number): Promise<void> => page.mouse.move(box.x + box.width * u, box.y + box.height * v).then(() => drawn(page));
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  // The first writes make the document dirty and take the pad off its default: geometry, once.
  await at(0.42, 0.42);
  await at(0.44, 0.44);
  await firstWritesSettled(page);
  const puck = pad.locator("div").last();
  const before = await puck.evaluate((element) => (element as HTMLElement).style.backgroundPosition);

  const counts = await traced(browser, page, async () => {
    for (let step = 1; step <= 10; step += 1) await at(0.44 + step * 0.04, 0.44 + step * 0.03);
  });
  const after = await puck.evaluate((element) => (element as HTMLElement).style.backgroundPosition);
  await page.mouse.up();

  expect(after, `the puck did not move: the drag wrote nothing (the press landed on ${under}; box ${JSON.stringify(box)})`).not.toBe(before);
  expect(counts.fullUpdates, `dragging the XY PAD forced ${String(counts.fullUpdates)} full compositor updates in 10 writes; laid out again: ${counts.laidOut}`).toBe(0);
});

test("a preset's fade in flight forces no full compositor update: its bar and the slider it carries are shares", async ({ browser, page }) => {
  const built = await documentOf(50);
  await openDocument(page, built.path);
  await page.getByRole("tab", { name: "controls" }).click();
  const pane = page.locator("[data-controls-pane]");
  const bar = pane.locator("[data-morph-progress]");
  await pane.locator('[data-preset="high"]').click();
  // The fade is three seconds of PLAYBACK: it is in flight once its bar is there and moving.
  await expect(bar).toHaveCount(1);
  const early = Number(await bar.getAttribute("data-morph-progress"));
  await expect.poll(async () => Number(await bar.getAttribute("data-morph-progress")), { message: "the fade is not advancing: the transport is not running" }).toBeGreaterThan(early);

  const counts = await traced(browser, page, async () => {
    await page.waitForTimeout(700);
  });
  // Still in flight when the trace ended, so every frame of it was a frame of the fade.
  await expect(bar).toHaveCount(1);
  expect(Number(await bar.getAttribute("data-morph-progress"))).toBeLessThan(1);
  expect(counts.fullUpdates, `a preset's FADE BAR in flight forced ${String(counts.fullUpdates)} full compositor updates in 0.7 s; laid out again: ${counts.laidOut}`).toBe(0);
});

/*
 * T1691b, T1683b — A TILE NOBODY CAN READ MAKES NO PERIODIC WRITE.
 *
 * Measured on a 220-node project fitted on the canvas (zoom 5 %, a value bar 0.2 px tall):
 * the tiles' ten writes a second made the browser raster the whole canvas again, 12 to
 * 13 ms of every frame on the GPU process's main thread, 24 frames a second where the same
 * scene runs at 47 with the bars hidden. Behind a fullscreen Viewer the same raster was
 * paid for tiles under the picture. The cause is the WRITE, so the writes are counted (a
 * MutationObserver over the tiles) and so is what they invalidate (the canvas nodes
 * Chromium's paint invalidator visits): none while a tile cannot be read, some while it can.
 *
 * And nothing stale: the first frame on which a tile can be read again already shows the
 * value of that moment, not the one it last wrote.
 */

/** Every DOM write inside a canvas tile for `ms`, by node id: attributes, text, children. */
const tileWrites = (page: Page, ms: number): Promise<Record<string, number>> =>
  page.evaluate(
    (duration) =>
      new Promise<Record<string, number>>((resolve) => {
        const writes: Record<string, number> = {};
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : (record.target as Element);
            const id = target?.closest(".react-flow__node")?.getAttribute("data-id");
            if (id !== null && id !== undefined) writes[id] = (writes[id] ?? 0) + 1;
          }
        });
        const viewport = document.querySelector(".react-flow__viewport");
        if (viewport === null) throw new Error("no canvas viewport");
        observer.observe(viewport, { subtree: true, attributes: true, characterData: true, childList: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(writes);
        }, duration);
      }),
    ms,
  );

/** The share of its own size a node's value plot is drawn at: what `useVisibleSubscribe` reads. */
const plotScale = (page: Page, nodeId: string): Promise<number> =>
  page.evaluate((id) => {
    const plot = document.querySelector<HTMLElement>(`[data-testid="value-plot-${id}"]`);
    return plot === null || plot.offsetHeight === 0 ? Number.NaN : plot.getBoundingClientRect().height / plot.offsetHeight;
  }, nodeId);

/** The value a node's plot shows for its first channel, as written in the DOM; null while it shows none. */
const shownValue = (page: Page, nodeId: string): Promise<string | null> =>
  page.evaluate((id) => document.querySelector(`[data-testid="value-plot-${id}"] [data-channel-name]`)?.getAttribute("data-channel-value") ?? null, nodeId);

interface SeenFrame {
  readonly scale: number;
  readonly covered: boolean;
  readonly value: string | null;
}

/** From now on, on every animation frame: how large the node's plot is drawn, whether something is fullscreen, and the value it shows. */
const recordFrames = (page: Page, nodeId: string): Promise<void> =>
  page.evaluate((id) => {
    const frames: SeenFrame[] = [];
    (window as unknown as { __t1691: SeenFrame[] }).__t1691 = frames;
    const sample = (): void => {
      const plot = document.querySelector<HTMLElement>(`[data-testid="value-plot-${id}"]`);
      if (plot !== null && plot.offsetHeight > 0) {
        frames.push({
          scale: plot.getBoundingClientRect().height / plot.offsetHeight,
          covered: document.fullscreenElement !== null,
          value: plot.querySelector("[data-channel-name]")?.getAttribute("data-channel-value") ?? null,
        });
      }
      if (frames.length < 900) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, nodeId);
const recordedFrames = (page: Page): Promise<SeenFrame[]> => page.evaluate(() => (window as unknown as { __t1691: SeenFrame[] }).__t1691);

/** The wheel over a node until its plot is drawn at `share` of its size or more. */
async function zoomOnto(page: Page, nodeId: string, share: number): Promise<void> {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  for (let step = 0; step < 80 && !((await plotScale(page, nodeId)) >= share); step += 1) {
    const box = await node.boundingBox();
    if (box === null) throw new Error("the node has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -200);
    await drawn(page);
  }
  expect(await plotScale(page, nodeId), "the wheel did not zoom the canvas in on the node").toBeGreaterThanOrEqual(share);
  await page.mouse.move(5, 5);
  await viewportSettled(page);
}

test("a canvas fitted to 200 nodes: tiles too small to read write nothing and repaint nothing while their values move; zoomed in they are live, from the first frame (T1691b)", async ({ browser, page }) => {
  const built = await documentOf(200, 12);
  await openDocument(page, built.path);
  await fitAll(page);
  // Not vacuous: the tiles with a value are there, and every picture is under the size it can be read at.
  expect(await page.locator('.react-flow__node [data-testid^="value-plot-"]').count()).toBeGreaterThanOrEqual(24);
  const fittedScale = await plotScale(page, built.lag);
  expect(fittedScale, "the fitted canvas draws a tile large enough to read: this document no longer tests the rule").toBeLessThan(CURVE_LEGIBLE_SCALE);
  expect(CURVE_LEGIBLE_SCALE).toBeLessThanOrEqual(BARS_LEGIBLE_SCALE);

  // 1. FITTED, the signals running: no write in any tile, nothing of the canvas invalidated.
  let small: Record<string, number> = {};
  const fitted = await traced(browser, page, async () => {
    small = await tileWrites(page, 1200);
  });
  expect(small, `tiles drawn at ${(fittedScale * 100).toFixed(1)} % of their size wrote to the DOM in 1.2 s (node id: writes)`).toEqual({});
  expect(fitted.nodeVisits, `the paint invalidator visited ${String(fitted.nodeVisits)} canvas nodes in 1.2 s of a fitted canvas`).toBe(0);

  // 2. A value written while nobody can read its tile: the tile does not follow it.
  const held = await holdSlider(page);
  await held.to(0.9);
  await held.release();
  const written = Number(await held.slider.getAttribute("aria-valuenow"));
  await page.waitForTimeout(400);
  const unread = await shownValue(page, built.slider);
  expect(unread === null ? Number.NaN : Number(unread), "the slider's tile followed a value at a size nobody reads it at: its writes were not stopped").not.toBe(written);

  // 3. ZOOMED IN on it: the first frame it is drawn large enough to read shows the value written, not the one from before.
  await recordFrames(page, built.slider);
  await zoomOnto(page, built.slider, 0.5);
  const frames = await recordedFrames(page);
  const firstRead = frames.findIndex((frame) => frame.scale >= BARS_LEGIBLE_SCALE);
  expect(firstRead, "no frame was recorded before the tile was readable: the claim below would hold of nothing").toBeGreaterThan(0);
  expect(frames[firstRead - 1]?.value ?? null, "the frame before it was readable already showed the new value").toBe(unread);
  expect(Number(frames[firstRead]?.value), `the first frame the tile was readable (drawn at ${((frames[firstRead]?.scale ?? 0) * 100).toFixed(0)} %) showed the value from before`).toBe(written);

  // 4. LIVE now: the tiles on screen write and repaint; a tile panned out of the canvas does neither.
  let large: Record<string, number> = {};
  const zoomed = await traced(browser, page, async () => {
    large = await tileWrites(page, 1200);
  });
  const where = await page.evaluate((ids) => {
    const canvas = document.querySelector('[data-testid="graph-canvas"]')?.getBoundingClientRect();
    if (canvas === undefined) throw new Error("no canvas");
    return Object.fromEntries(ids.map((id) => {
      const box = document.querySelector(`[data-testid="value-plot-${id}"]`)?.getBoundingClientRect();
      return [id, box !== undefined && box.right > canvas.left && box.left < canvas.right && box.bottom > canvas.top && box.top < canvas.bottom];
    }));
  }, built.signals);
  const onScreen = built.signals.filter((id) => where[id] === true);
  const offScreen = built.signals.filter((id) => where[id] !== true);
  expect(onScreen.length, "no signal's tile is on screen after the zoom").toBeGreaterThan(0);
  expect(offScreen.length, "every signal's tile is on screen: nothing here is off screen").toBeGreaterThan(0);
  expect(onScreen.filter((id) => (large[id] ?? 0) === 0), "a readable tile on screen, its signal running, wrote nothing in 1.2 s").toEqual([]);
  expect(offScreen.filter((id) => (large[id] ?? 0) > 0), "a tile outside the canvas wrote to the DOM").toEqual([]);
  expect(zoomed.nodeVisits, "no canvas node was repainted with readable tiles live: the count above is not counting").toBeGreaterThan(0);
});

test("under a fullscreen Viewer the tiles write nothing and repaint nothing; out of it they are current on the first frame (T1683b)", async ({ browser, page }) => {
  const built = await documentOf(50, 4);
  await openDocument(page, built.path);
  await fitAll(page);
  const lfo = built.signals[0] ?? "";
  await zoomOnto(page, lfo, 0.5);
  // Not vacuous: in front of the editor this tile is live.
  expect((await tileWrites(page, 600))[lfo] ?? 0, "the signal's tile is not live with the editor in front").toBeGreaterThan(0);

  await page.getByTestId("viewer-fullscreen").click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null), { message: "the Viewer did not go fullscreen" }).toBe(true);
  await drawn(page);
  let under: Record<string, number> = {};
  const covered = await traced(browser, page, async () => {
    under = await tileWrites(page, 1200);
  });
  expect(under, "tiles under a fullscreen Viewer wrote to the DOM in 1.2 s (node id: writes)").toEqual({});
  expect(covered.nodeVisits, `the paint invalidator visited ${String(covered.nodeVisits)} canvas nodes in 1.2 s under a fullscreen Viewer`).toBe(0);

  const stale = await shownValue(page, lfo);
  await recordFrames(page, lfo);
  await drawn(page);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await drawn(page);
  const frames = await recordedFrames(page);
  const firstBack = frames.findIndex((frame) => !frame.covered);
  expect(firstBack, "no frame was recorded under the Viewer").toBeGreaterThan(0);
  expect(frames[firstBack - 1]?.value ?? null).toBe(stale);
  expect(frames[firstBack]?.value ?? null, "the first frame with the editor back showed the value from before the Viewer covered it").not.toBe(stale);
});
