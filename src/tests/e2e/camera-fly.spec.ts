import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { buildProjectFile } from "@domain/project/project-file.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { document, edge, expressionSlot, graph, named, settings } from "@/examples/documents/builders.ts";
import { APP_VIEWPORT, fitAll, focusGraph, modKey, openApp, selectNode, viewportSettled } from "./app.ts";

/**
 * §T970 — FLY A CAMERA FROM THE VIEWER. THE REAL GESTURES, ON THE REAL GPU.
 *
 * The owner, twice: "i'm still missing a way to actually change the position of the camera
 * in the camera node via flying around in that preview instead of manually having to deal
 * with it". The viewer locks to the camera its picture is drawn through, by a button that
 * names it, and then its drag, wheel and fly keys are edits to that camera.
 *
 * Every claim here is on what the user has afterwards: the camera's STORED pose, read off
 * the inspector's own fields, and the picture on the glass. Not "the handler ran".
 *
 * GPU LANE ONLY (`playwright.config.ts` routes it by basename): the viewer has a picture,
 * and a plan is installed at all, only on a real adapter.
 */
test.use({ viewport: APP_VIEWPORT });
/* Each test is 10 to 14 s on an idle machine and was seen at 30 s with another session's
   heavy run beside it, where the default limit cut a green test off mid-read. */
test.describe.configure({ timeout: 90_000 });

const CELL = { x: 380, y: 440 } as const;
const at = (column: number, row: number): readonly [number, number] => [column * CELL.x, row * CELL.y];

async function open(page: Page, slug: string, nodes: GraphNode[], wires: ReadonlyArray<readonly [string, string, string]>): Promise<void> {
  const project = document(
    slug,
    `Camera fly ${slug}`,
    settings({ outputResolution: { width: 640, height: 360 } }),
    graph(
      nodes,
      // A source is a node, or `node:port` for an output other than `out`.
      wires.map(([from, to, port], index) => {
        const [source = from, sourcePort = "out"] = from.split(":");
        return edge(`e${String(index)}`, [source, sourcePort], [to, port]);
      }),
    ),
  );
  const file = buildProjectFile({ document: project, now: () => project.updatedAt });
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: `${slug}.loom.json`, mimeType: "application/json", buffer: Buffer.from(file.text) });
  await expect(page.locator(".react-flow__node")).toHaveCount(nodes.length);
  await fitAll(page);
}

/** A scene with something to see move: boxes on a grid, one light, a Render framed by `camera`. */
function shot(camera: GraphNode, render: Record<string, boolean> = {}): { nodes: GraphNode[]; wires: Array<readonly [string, string, string]> } {
  return {
    nodes: [
      named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }),
      named("boxes", "geometry", at(1, 0), { mode: "instances", scale: 0.12 }),
      named("key", "light", at(2, 0)),
      camera,
      named("shot", "render", at(1, 1), render),
      named("final", "output", at(2, 1)),
    ],
    wires: [
      ["grid_source", "geometry_boxes", "points"],
      ["geometry_boxes", "render_shot", "scenes"],
      [camera.id, "render_shot", "camera"],
      ["light_key", "render_shot", "lights"],
      ["render_shot", "output_final", "input"],
    ],
  };
}

/** The fraction of pixels that differ between two screenshots of the same box. */
async function changed(page: Page, before: Buffer, after: Buffer): Promise<number> {
  return page.evaluate(
    async ([left, right]) => {
      const decode = async (base64: string): Promise<ImageData> => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const copy = window.document.createElement("canvas");
        copy.width = image.naturalWidth;
        copy.height = image.naturalHeight;
        const context = copy.getContext("2d", { willReadFrequently: true });
        if (context === null) throw new Error("No 2D context for screenshot decoding");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, copy.width, copy.height);
      };
      const one = await decode(left as string);
      const two = await decode(right as string);
      if (one.width !== two.width || one.height !== two.height) throw new Error("the two shots are not the same box");
      let differing = 0;
      for (let index = 0; index < one.data.length; index += 4) {
        const delta = Math.max(
          Math.abs(one.data[index]! - two.data[index]!),
          Math.abs(one.data[index + 1]! - two.data[index + 1]!),
          Math.abs(one.data[index + 2]! - two.data[index + 2]!),
        );
        if (delta > 12) differing += 1;
      }
      return differing / (one.data.length / 4);
    },
    [before.toString("base64"), after.toString("base64")],
  );
}

/** A picture MOVED above this fraction and stood STILL below `STILL` (as `preview-camera.spec.ts` measures them). */
const MOVED = 0.01;
const STILL = 0.002;

type Vec3 = readonly [number, number, number];

/**
 * The camera's STORED pose, as the inspector shows it: the document, not a view of it.
 *
 * SETTLED: a gesture's writes go to the bus one after another, so on a loaded machine the
 * document is still catching up with a flight for a moment after the key comes up (seen
 * here with six specs in parallel: a pose read at once was a frame the flight had already
 * left). Two equal reads are the pose the gesture ended on.
 */
async function storedPose(page: Page, nodeId: string): Promise<{ eye: Vec3; lookAt: Vec3 }> {
  await selectNode(page, nodeId);
  const field = async (label: string): Promise<number> => Number(await page.locator(`input[aria-label="${label}"]`).inputValue());
  const read = async (): Promise<{ eye: Vec3; lookAt: Vec3 }> => ({
    eye: [await field("Eye x"), await field("Eye y"), await field("Eye z")],
    lookAt: [await field("Look At x"), await field("Look At y"), await field("Look At z")],
  });
  let previous = await read();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(120);
    const next = await read();
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  throw new Error(`the stored pose of ${nodeId} never settled`);
}

const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const size = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Points the viewer at a node (`v`, the keymap's own row) and waits for its picture to settle. */
async function view(page: Page, nodeId: string): Promise<Locator> {
  await page.getByTestId(`node-name-${nodeId}`).click();
  await page.keyboard.press("v");
  await expect(page.getByTestId("viewer-output-select")).toHaveValue(`${nodeId}:out`);
  const canvas = page.getByTestId("viewer-canvas");
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => {
      const first = await canvas.screenshot();
      await page.waitForTimeout(150);
      return changed(page, first, await canvas.screenshot());
    })
    .toBeLessThan(STILL);
  return canvas;
}

async function undo(page: Page): Promise<void> {
  await focusGraph(page);
  await page.keyboard.press(`${await modKey(page)}+z`);
}

test("the viewer flies the camera its Render is framed by: hold W, the stored pose and the picture move, one undo puts both back", async ({ page }) => {
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await open(page, "lock", nodes, wires);
  const start = await storedPose(page, "camera_shot");
  expect(start).toEqual({ eye: [0, 0.5, 3], lookAt: [0, 0, 0] });

  // The viewer shows the RENDER. Its button names the node the gestures will write.
  const canvas = await view(page, "render_shot");
  const button = page.getByTestId("viewer-fly-camera");
  await expect(button).toHaveText("Fly camera_shot");
  await expect(button).toHaveAttribute("aria-pressed", "false");

  // Not armed, nothing here is an edit: a key and a drag leave the document alone.
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the viewer's picture has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await canvas.focus();
  await page.keyboard.down("w");
  await page.waitForTimeout(250);
  await page.keyboard.up("w");
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y + 20, { steps: 6 });
  await page.mouse.up();
  expect(await storedPose(page, "camera_shot"), "the viewer moved a camera it was not locked to").toEqual(start);

  const before = await canvas.screenshot();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("viewer-camera-note")).toHaveText("Flying camera_shot: every move is an edit, undo steps back.");

  // HOLD W. A held key is a flight (the keymap says which key; the pane integrates it).
  await page.keyboard.down("w");
  await page.waitForTimeout(600);
  await page.keyboard.up("w");

  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "the picture did not move with the flight" }).toBeGreaterThan(MOVED);
  const flown = await storedPose(page, "camera_shot");
  const moved = minus(flown.eye, start.eye);
  // Forward is toward Look At: the eye sat at +z looking at the origin, so z went DOWN.
  expect(moved[2], "W did not carry the camera forward").toBeLessThan(-0.3);
  // The whole rig translated: Look At went with the eye, so the heading is unchanged.
  const target = minus(flown.lookAt, start.lookAt);
  expect(size(minus(target, moved)), "Eye and Look At did not travel together").toBeLessThan(1e-4);
  // And along the camera's own view axis (from [0, 0.5, 3] toward the origin), not along world z.
  expect(moved[1] / moved[2]).toBeCloseTo(0.5 / 3, 3);
  expect(Math.abs(moved[0])).toBeLessThan(1e-4);

  // A SECOND flight, sideways. Each flight is its own undo step: the first key coming up
  // closed the first, so they do not run together into one.
  await canvas.focus();
  await page.keyboard.down("d");
  await page.waitForTimeout(400);
  await page.keyboard.up("d");
  const strafed = await storedPose(page, "camera_shot");
  expect(strafed.eye[0] - flown.eye[0], "D did not carry the camera to its right").toBeGreaterThan(0.2);

  // ONE flight is ONE undo step: one undo lands exactly where the second flight began…
  await undo(page);
  expect(await storedPose(page, "camera_shot")).toEqual(flown);
  // …and the next lands exactly where the first began, with the picture.
  await undo(page);
  expect(await storedPose(page, "camera_shot")).toEqual(start);
  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "undo did not put the picture back" }).toBeLessThan(STILL);
});

test("locked, a drag on the viewer orbits the camera itself, and Home leaves the lock without an edit", async ({ page }) => {
  // Depth Output ON and READ, as on the owner's Render: its rows are then `depth` and `out`,
  // and `v` must still show the PICTURE (§T1659b item 2: it showed `depth`, the first row
  // by key, which is not what anyone pressed `v` on a Render for).
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }), { depthOutput: true });
  nodes.push(named("lens", "camera", at(3, 0)), named("haze", "cameraBlur", at(3, 1)));
  wires.push(["render_shot", "camerablur_haze", "input"], ["render_shot:depth", "camerablur_haze", "depth"], ["camera_lens", "camerablur_haze", "camera"]);
  await open(page, "orbit", nodes, wires);
  // The premise: the depth row IS there to be picked first (it sorts before `out`).
  await expect(page.getByTestId("viewer-output-select").locator('option[value="render_shot:depth"]')).toHaveCount(1);
  const start = await storedPose(page, "camera_shot");
  const canvas = await view(page, "render_shot");
  const button = page.getByTestId("viewer-fly-camera");

  // `c` is the lock's key (a keymap row in the viewer context), from the picture.
  await canvas.focus();
  await page.keyboard.press("c");
  await expect(button).toHaveAttribute("aria-pressed", "true");

  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the viewer's picture has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + box.width * 0.25, centre.y, { steps: 8 });
  await page.mouse.up();

  const orbited = await storedPose(page, "camera_shot");
  // An orbit: the eye went round Look At at the same distance, and Look At stayed.
  expect(orbited.lookAt).toEqual(start.lookAt);
  expect(Math.abs(orbited.eye[0] - start.eye[0])).toBeGreaterThan(0.3);
  expect(size(minus(orbited.eye, orbited.lookAt))).toBeCloseTo(size(minus(start.eye, start.lookAt)), 4);

  // HOME leaves the mode and is NOT an edit: the flown pose stands, the lock is off.
  await canvas.focus();
  await page.keyboard.press("h");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  expect(await storedPose(page, "camera_shot")).toEqual(orbited);
  // The way back from an edit is undo, and the drag was one step.
  await undo(page);
  expect(await storedPose(page, "camera_shot")).toEqual(start);
});

test("a key held in a text field does not fly the camera", async ({ page }) => {
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await open(page, "typing", nodes, wires);
  const start = await storedPose(page, "camera_shot");
  await view(page, "render_shot");
  await page.getByTestId("viewer-fly-camera").click();
  await expect(page.getByTestId("viewer-fly-camera")).toHaveAttribute("aria-pressed", "true");

  // Typing a name that has a W in it, with the lock armed.
  const search = page.locator('input[aria-label="Search nodes"]');
  await search.click();
  await page.keyboard.down("w");
  await page.waitForTimeout(400);
  await page.keyboard.up("w");
  await expect(search).toHaveValue(/^w+$/);
  expect(await storedPose(page, "camera_shot"), "typing flew the camera").toEqual(start);
});

/** The camera's parameters as the SAVED FILE holds them: the document, through the app's own save. */
async function savedParameters(page: Page, nodeId: string): Promise<Record<string, unknown>> {
  const download = page.waitForEvent("download");
  await page.getByTestId("project-save").click();
  const path = await (await download).path();
  if (path === null) throw new Error("the saved project has no local download");
  const saved = JSON.parse(await readFile(path, "utf8")) as { graph: GraphDocument };
  const node = saved.graph.nodes[nodeId];
  if (node === undefined) throw new Error(`${nodeId} is not in the saved file`);
  return node.parameters as Record<string, unknown>;
}

test("⚑ a driven rig is flown through Origin: the rig's expressions stand, the flight is an offset, undo returns it", async ({ page }) => {
  /*
   * THE OWNER'S SHAPE (§T970, §T1656b). Their camera follows a robot by expressions on Eye
   * and Look At, so a flown view could only be kept by replacing the rig with numbers. Here
   * the rig is where it belongs: Origin and Heading on expressions (all six channels), and
   * Eye and Look At plain offsets. The flight must write the offsets and nothing else.
   */
  const rig = {
    "origin.x": expressionSlot("1.5", 1.5),
    "origin.y": expressionSlot("0.25", 0.25),
    "origin.z": expressionSlot("0.5", 0.5),
    "heading.x": expressionSlot("1", 1),
    "heading.y": expressionSlot("0", 0),
    "heading.z": expressionSlot("0 - 1", -1),
  };
  const { nodes, wires } = shot(named("rig", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }, { parameters: rig }));
  /*
   * A plain camera placed BY HAND where the rig puts this one, and a Render through it. The
   * frame faces (1, 0, −1), so its back is (−1, 0, 1)/√2: the offset (0, 0.5, 3) is half
   * above the Origin and three behind it, and Look At, at the frame's own origin, IS Origin.
   */
  const behind = 3 / Math.SQRT2;
  nodes.push(
    named("plain", "camera", at(0, 2), { eye: [1.5 - behind, 0.75, 0.5 + behind], lookAt: [1.5, 0.25, 0.5] }),
    named("plain", "render", at(1, 2)),
  );
  wires.push(["geometry_boxes", "render_plain", "scenes"], ["camera_plain", "render_plain", "camera"], ["light_key", "render_plain", "lights"]);
  await open(page, "rig", nodes, wires);
  const start = await storedPose(page, "camera_rig");
  expect(start).toEqual({ eye: [0, 0.5, 3], lookAt: [0, 0, 0] });

  // ORIGIN AND HEADING REACH THE PICTURE: the rigged Render draws what the hand-placed one draws.
  const byHand = await (await view(page, "render_plain")).screenshot();
  const canvas = await view(page, "render_shot");
  const before = await canvas.screenshot();
  expect(await changed(page, byHand, before), "the rig's Origin and Heading did not place the camera").toBeLessThan(STILL);

  const button = page.getByTestId("viewer-fly-camera");
  // It IS offered: nothing the flight writes is driven.
  await expect(button).toHaveText("Fly camera_rig");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.down("w");
  await page.waitForTimeout(600);
  await page.keyboard.up("w");

  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "the picture did not move with the flight" }).toBeGreaterThan(MOVED);
  // The OFFSET moved, in the frame: forward is the frame's own −z, whichever way the rig faces.
  const flown = await storedPose(page, "camera_rig");
  const moved = minus(flown.eye, start.eye);
  expect(moved[2], "W did not carry the offset forward").toBeLessThan(-0.3);
  expect(size(minus(minus(flown.lookAt, start.lookAt), moved))).toBeLessThan(1e-4);

  // THE RIG STANDS, as the saved file holds it: six expressions, exactly as written.
  const saved = await savedParameters(page, "camera_rig");
  for (const [key, slot] of Object.entries(rig)) {
    expect([key, saved[key]], "the flight replaced a channel of the rig").toEqual([key, slot]);
  }
  // And what the flight wrote is plain numbers on Eye and Look At, with no slot minted on them.
  expect(saved["eye"]).toEqual([...flown.eye]);
  expect(saved["lookAt"]).toEqual([...flown.lookAt]);
  for (const key of ["eye.x", "eye.y", "eye.z", "lookAt.x", "lookAt.y", "lookAt.z"]) expect([key, saved[key]]).toEqual([key, undefined]);

  // One undo: the offset is back where the flight began, and so is the picture.
  await undo(page);
  expect(await storedPose(page, "camera_rig")).toEqual(start);
  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "undo did not put the picture back" }).toBeLessThan(STILL);
});

test("a rig on Eye and Look At themselves is not offered a flight, and the viewer says whose camera and why", async ({ page }) => {
  // The owner's file as it stands today: all six channels of Eye and Look At on expressions.
  // A flight there could only replace them, so there is no button, on the Render or anywhere.
  const driven = {
    "eye.x": expressionSlot("0", 0),
    "eye.y": expressionSlot("0.5", 0.5),
    "eye.z": expressionSlot("3", 3),
    "lookAt.x": expressionSlot("0", 0),
    "lookAt.y": expressionSlot("0", 0),
    "lookAt.z": expressionSlot("0", 0),
  };
  const { nodes, wires } = shot(named("rig", "camera", at(0, 1), {}, { parameters: driven }));
  await open(page, "driven", nodes, wires);
  await view(page, "render_shot");
  await expect(page.getByTestId("viewer-fly-camera")).toHaveCount(0);
  await expect(page.getByTestId("viewer-camera-note")).toHaveText("Framed by camera_rig. Driven by expressions (Eye, Look At).");
});

test("at 35 % zoom the tile's camera toggle is still 12 px and on top, and a partly driven camera says what it holds", async ({ page }) => {
  const { nodes, wires } = shot(
    named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }, { parameters: { "eye.x": expressionSlot("0", 0) } }),
  );
  await open(page, "small", nodes, wires);
  const toggle = page.getByTestId("preview-inspect-camera_shot");
  await expect(toggle).toHaveCount(1);
  // §T1659b item 6: it flies on five channels and holds one, and now says which.
  await expect(toggle).toHaveAttribute("title", /Stays driven: Eye x \(Expression\)\.$/);

  // Wheel out, about the middle of the canvas, to about 35 %.
  const pane = await page.getByTestId("graph-canvas").boundingBox();
  if (pane === null) throw new Error("the graph canvas has no box on screen");
  const zoom = (): Promise<number> =>
    page.evaluate(() => new DOMMatrix(getComputedStyle(window.document.querySelector(".react-flow__viewport") as HTMLElement).transform).a);
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  for (let step = 0; step < 80; step += 1) {
    if ((await zoom()) <= 0.36) break;
    await page.mouse.wheel(0, 30);
    await page.waitForTimeout(25);
  }
  await viewportSettled(page);
  expect(await zoom()).toBeLessThanOrEqual(0.36);

  const facts = await toggle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = window.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { width: rect.width, height: rect.height, onTop: top === element, opacity: getComputedStyle(element).opacity };
  });
  // 16 px scaled by 0.35 would be 5.6. It holds 12 (measured on the glass, not on a style).
  expect(facts.width).toBeCloseTo(12, 1);
  expect(facts.height).toBeCloseTo(12, 1);
  expect(facts.onTop, "the toggle is painted under something").toBe(true);
  expect(facts.opacity).toBe("1");
  // And it is still ON the tile's corner, not beside the tile.
  const tile = await page.getByTestId("node-preview-camera_shot").boundingBox();
  const box = await toggle.boundingBox();
  if (tile === null || box === null) throw new Error("the tile or its toggle is not on screen");
  expect(box.x + box.width).toBeLessThanOrEqual(tile.x + tile.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(tile.y + tile.height + 0.5);
  expect(box.x).toBeGreaterThanOrEqual(tile.x - 0.5);
});
