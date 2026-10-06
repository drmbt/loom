import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { addNode, focusGraph, handle, modKey, openApp, viewportSettled } from "./app.ts";

/**
 * A WIRE THAT SNAPS, IN A BROWSER THAT LAYS OUT AND ANIMATES (T1639b).
 *
 * The owner, of a reference video: "This kind of magnetic snapping, visual snap effect
 * glow shimmer travel and the little electric spark indicator for the magnetic range and
 * the drop to snap range is beautiful. I want this".
 *
 * `wire-connect.test.tsx` holds the logic through React Flow's own pointer code: what
 * sparks, what refuses, one command per release. jsdom lays nothing out and animates
 * nothing, so everything that is geometry or time is here, off the real page:
 *
 *  - THE RANGE IS A SCREEN SIZE. 40 px from a port sparks at 100 % and at 35 %, where it
 *    is 114 graph px and the library's fixed radius of 20 was 7 px. The ring is the same
 *    size on screen at both.
 *  - NO NODE'S BOX MOVES OR CHANGES SIZE (§V389): with the arc showing, on every frame of
 *    the snap, and after. Measured on every node, not only the one the wire lands in.
 *  - NOTHING IS LEFT: no element of the effect, and no running animation, once it is over.
 *  - The bar really travels, and under reduced motion nothing does.
 *
 * ## How "no box moves" is kept from being a statement about something else
 *
 * A node that gains its first input changes by itself: its diagnostic row goes, and the
 * page's layout shifts when the compile errors clear. That is the document changing the
 * node, not the effect. So the wire under test lands in an input that is ALREADY fed, and
 * replaces the wire that was there (§V14a): the node is fed before and after, and the only
 * thing that differs between the measurements is the effect. Pulling a wire off and
 * putting it back changes nothing in the document at all, and is measured the same way.
 *
 * ## The snap is read inside the page, one sample per frame
 *
 * It lasts 0.72 s, and 0.3 s under reduced motion. Asking about it over the wire, one
 * question per round trip, would be measuring how busy the machine is: several sessions
 * share this one. So a probe in the page samples every animation frame from before the
 * release until after the effect has gone, and the assertions read that record.
 *
 * Headless, in the default lane: no pixel is read. Port ids are the definitions' own
 * (`out`, `input`).
 */

interface Point {
  readonly x: number;
  readonly y: number;
}

/** One animation frame, as the probe saw it. */
interface Frame {
  /** Every node's box, serialised (see `boxes`). */
  readonly boxes: string;
  /** The ids of the nodes that carry a snap box as a direct child of their wrapper. */
  readonly snapOn: readonly string[];
  /** Snap elements that are NOT where they belong: inside a node's own element. */
  readonly snapInsideNode: number;
  /** The wire's colour fill, in React Flow's viewport portal. */
  readonly fills: number;
  readonly bars: number;
  readonly rings: number;
  readonly reduced: boolean;
  /** Computed `stroke-dashoffset` and `stroke-dasharray` of the first bar; "" without one. */
  readonly offset: string;
  readonly dash: string;
  /** Computed radius of the first ring; "" without one. */
  readonly radius: string;
  /** Animations running on anything the effect drew. */
  readonly animations: number;
  /** Everything the effect has on the page: snap elements and the wire in flight. */
  readonly elements: number;
}

interface Probe {
  boxes: () => string[];
  start: () => void;
  stop: () => Frame[];
}

const RANGE_PX = 48;
/** Longer than the snap (0.72 s) by enough frames to see the page after it. */
const SNAP_AND_AFTER_MS = 1100;

/*
 * A window the furniture fits in. The project's `Desktop Chrome` device is 1280 x 720,
 * where the graph pane is about 400 px tall: the lower of the two Noises stood half
 * outside it, and a wire held near the pane's edge makes the canvas auto-pan, which moves
 * every node on screen and is not what is being measured. `stage` checks the pane is big
 * enough to keep every pointer position in this file well inside it.
 */
test.use({ viewport: { width: 1920, height: 1200 } });

const zoomOf = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    return new DOMMatrixReadOnly(viewport === null ? "none" : getComputedStyle(viewport).transform).a;
  });

/** Wheel until the canvas's own scale is the target, within 1 %, about a point that stays in view. */
async function zoomTo(page: Page, target: number, at: Point): Promise<void> {
  await page.mouse.move(at.x, at.y);
  for (let step = 0; step < 80; step += 1) {
    const now = await zoomOf(page);
    if (Math.abs(now - target) / target < 0.01) break;
    const delta = Math.max(-240, Math.min(240, -Math.log2(target / now) * 300));
    await page.mouse.wheel(0, Math.abs(delta) < 2 ? Math.sign(delta) * 2 : delta);
    await page.waitForTimeout(40);
  }
  await expect.poll(async () => Math.abs((await zoomOf(page)) - target) / target).toBeLessThan(0.02);
  await viewportSettled(page);
}

/** Drags a node by its name until its top-left corner is at (x, y) on screen. */
async function place(page: Page, nodeId: string, x: number, y: number): Promise<void> {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const box = await node.boundingBox();
    const name = await page.getByTestId(`node-name-${nodeId}`).boundingBox();
    if (box === null || name === null) throw new Error(`node ${nodeId} is not on screen`);
    const dx = x - box.x;
    const dy = y - box.y;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const gx = name.x + 6;
    const gy = name.y + name.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx + dx / 2, gy + dy / 2, { steps: 6 });
    await page.mouse.move(gx + dx, gy + dy, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  }
}

/** The middle of a port's dot, measured NOW: the page shifts when compile errors come and go. */
async function dot(page: Page, nodeId: string, portId: string, kind: "source" | "target"): Promise<Point> {
  const box = await handle(page, nodeId, portId, kind).boundingBox();
  if (box === null) throw new Error(`port ${nodeId}:${portId} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The middle of something the effect drew. */
async function middleOf(page: Page, testId: string): Promise<Point & { width: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} has no box on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width };
}

/**
 * The probe: every node's box, and a per-frame record of the effect.
 *
 * A node's box is read the way the layout model and React Flow each read it: the
 * wrapper's unscaled size and its position, the node's own element's size and offset, and
 * both rects on screen. "On screen" is measured from the canvas's own corner, so a strip
 * arriving above the pane (the page does that when compile errors come and go) is not
 * read as every node having moved, while a camera move or a node move still is.
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const round = (value: number): number => Math.round(value * 100) / 100;
    const rect = (element: Element | null): number[] => {
      const canvas = document.querySelector('[data-testid="graph-canvas"]');
      if (element === null || canvas === null) return [];
      const origin = canvas.getBoundingClientRect();
      const r = element.getBoundingClientRect();
      return [round(r.x - origin.x), round(r.y - origin.y), round(r.width), round(r.height)];
    };
    const boxes = (): string[] =>
      [...document.querySelectorAll<HTMLElement>(".react-flow__node")].map((wrapper) => {
        const own = wrapper.querySelector<HTMLElement>(':scope > [data-testid^="node-"]');
        return JSON.stringify({
          id: wrapper.dataset["id"],
          wrapper: [wrapper.offsetWidth, wrapper.offsetHeight, wrapper.style.transform],
          own: own === null ? null : [own.offsetWidth, own.offsetHeight, own.offsetLeft, own.offsetTop],
          onScreen: [rect(wrapper), rect(own)],
        });
      });
    const EFFECT = '[data-wire-snap], [data-testid="wire-in-flight"]';
    const sample = () => {
      const snaps = [...document.querySelectorAll<HTMLElement>("[data-wire-snap]")];
      const bar = document.querySelector("[data-wire-snap] rect");
      const ring = document.querySelector("[data-wire-snap] circle");
      return {
        boxes: JSON.stringify(boxes()),
        snapOn: [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
          .filter((wrapper) => wrapper.querySelector(":scope > [data-wire-snap]") !== null)
          .map((wrapper) => wrapper.dataset["id"] ?? ""),
        snapInsideNode: document.querySelectorAll('.react-flow__node > [data-testid^="node-"] [data-wire-snap]').length,
        fills: document.querySelectorAll(".react-flow__viewport-portal > [data-wire-snap]").length,
        bars: document.querySelectorAll("[data-wire-snap] rect").length,
        rings: document.querySelectorAll("[data-wire-snap] circle").length,
        reduced: snaps.length > 0 && snaps.every((element) => element.hasAttribute("data-reduced")),
        offset: bar === null ? "" : getComputedStyle(bar).strokeDashoffset,
        dash: bar === null ? "" : getComputedStyle(bar).strokeDasharray,
        radius: ring === null ? "" : getComputedStyle(ring).getPropertyValue("r"),
        animations: document.getAnimations().filter((animation) => {
          const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
          return target !== null && target.closest(EFFECT) !== null;
        }).length,
        elements: document.querySelectorAll(EFFECT).length,
      };
    };
    let log: ReturnType<typeof sample>[] = [];
    let recording = false;
    const tick = (): void => {
      if (!recording) return;
      log.push(sample());
      requestAnimationFrame(tick);
    };
    (window as unknown as { __wireProbe?: unknown }).__wireProbe = {
      boxes,
      start: () => {
        log = [];
        recording = true;
        requestAnimationFrame(tick);
      },
      stop: () => {
        recording = false;
        return log;
      },
    };
  });
}

const boxes = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __wireProbe: Probe }).__wireProbe.boxes());

/** Records every frame from now until the snap has had time to play and go, and returns the record. */
async function recordRelease(page: Page): Promise<Frame[]> {
  await page.evaluate(() => (window as unknown as { __wireProbe: Probe }).__wireProbe.start());
  await page.mouse.up();
  await page.waitForTimeout(SNAP_AND_AFTER_MS);
  return page.evaluate(() => (window as unknown as { __wireProbe: Probe }).__wireProbe.stop());
}

/** A token's colour as the browser computes it, to compare against a computed stroke. */
const tokenColor = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

const strokeOf = (page: Page, testId: string): Promise<string> =>
  page.getByTestId(testId).evaluate((element) => getComputedStyle(element).stroke);

interface Staged {
  readonly first: string;
  readonly second: string;
  readonly level: string;
}

/**
 * Two Noises on the left, one Level on the right at 1:1, and the first Noise already wired
 * into the Level, so the wire under test REPLACES one (see the docblock).
 */
async function stage(page: Page): Promise<Staged> {
  await openApp(page);
  const canvas = await page.getByTestId("graph-canvas").boundingBox();
  if (canvas === null) throw new Error("the canvas has no box");
  // Everything below happens within 330 px of the pane's middle across and 190 px up and
  // down. The canvas auto-pans when a wire is held within 40 px of its edge.
  expect(canvas.width).toBeGreaterThan(2 * (330 + 50));
  expect(canvas.height).toBeGreaterThan(2 * (190 + 50));
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;

  const first = await addNode(page, "generator", "Noise");
  await focusGraph(page);
  await page.keyboard.press("Shift+H");
  await viewportSettled(page);
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1, 2);
  const level = await addNode(page, "color", "Level");
  const second = await addNode(page, "generator", "Noise");
  /*
   * All three are added BEFORE any is placed, and then given a moment. An unfed Level
   * reports compile errors, and the strip that says so pushes the whole pane down by some
   * 40 px. Placed one by one as they arrived, the first node was put down before that
   * strip and the others after it, and the layout was 40 px out of true once the Level was
   * fed and the strip left. Placed together, they move together.
   */
  await page.waitForTimeout(700);
  // Last added first: a new node lands over the one before, and the one on top is the
  // one a press reaches.
  await place(page, second, cx - 330, cy + 30);
  await place(page, level, cx + 60, cy - 80);
  await place(page, first, cx - 330, cy - 190);

  // The first wire, by the gesture itself.
  const from = await dot(page, first, "out", "source");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 4 });
  const to = await dot(page, level, "input", "target");
  await page.mouse.move(to.x - 20, to.y + 6, { steps: 8 });
  await expect(page.getByTestId("wire-in-flight")).toHaveAttribute("data-wire-state", "live");
  await page.mouse.up();
  await expect(page.locator(`.react-flow__edge[aria-label="Edge from ${first} to ${level}"]`)).toHaveCount(1);

  // Settled: the effect is over, and the page has stopped shifting under the nodes.
  await installProbe(page);
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('[data-wire-snap], [data-testid="wire-in-flight"]').length))
    .toBe(0);
  let previous = await boxes(page);
  await expect
    .poll(async () => {
      await page.waitForTimeout(200);
      const now = await boxes(page);
      const same = JSON.stringify(now) === JSON.stringify(previous);
      previous = now;
      return same;
    })
    .toBe(true);
  return { first, second, level };
}

/** A point `pixels` screen px from a port: 0.8 of it to the left and 0.6 below. */
const offPort = (port: Point, pixels: number): Point => ({ x: port.x - pixels * 0.8, y: port.y + pixels * 0.6 });

/** Press on a dot and carry the wire to `at`, by a path a hand would take. */
async function carry(page: Page, from: Point, at: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y - 5, { steps: 4 });
  await page.mouse.move((from.x + at.x) / 2, (from.y + at.y) / 2 + 30, { steps: 6 });
  await page.mouse.move(at.x, at.y, { steps: 8 });
}

/** What every frame of a release must show, with motion on. Returns the frames the snap was on. */
function expectSnap(frames: readonly Frame[], atRest: readonly string[], on: string): Frame[] {
  const during = frames.filter((frame) => frame.snapOn.length > 0);
  // Non-vacuity: the probe saw the snap, for a good part of its 0.72 s.
  expect(during.length).toBeGreaterThan(10);
  for (const frame of frames) {
    // §V389 on EVERY frame, the effect's and the ones around it.
    expect(JSON.parse(frame.boxes)).toEqual(atRest);
    expect(frame.snapInsideNode).toBe(0);
  }
  for (const frame of during) {
    // On the node the wire landed in, and only there.
    expect(frame.snapOn).toEqual([on]);
    expect(frame.fills).toBe(1);
  }
  // NOTHING LEFT: the record ends with frames in which the effect has nothing on the
  // page and nothing running.
  const last = frames.slice(-5);
  expect(last).toHaveLength(5);
  for (const frame of last) {
    expect(frame.elements).toBe(0);
    expect(frame.animations).toBe(0);
  }
  return during;
}

test("at 100 %: the arc is the range, a release connects, the snap leaves nothing and no node's box moves", async ({
  page,
}) => {
  const { first, second, level } = await stage(page);
  const atRest = await boxes(page);
  expect(atRest).toHaveLength(3);
  const wired = page.locator(`.react-flow__edge[aria-label="Edge from ${second} to ${level}"]`);
  const replaced = page.locator(`.react-flow__edge[aria-label="Edge from ${first} to ${level}"]`);
  const white = await tokenColor(page, "--text");

  // OUT OF RANGE: a white wire with its round tip at the pointer, and nothing else.
  const from = await dot(page, second, "out", "source");
  const to = await dot(page, level, "input", "target");
  const far = offPort(to, RANGE_PX + 12);
  await carry(page, from, far);
  const flight = page.getByTestId("wire-in-flight");
  await expect(flight).toHaveAttribute("data-wire-state", "free");
  await expect(page.getByTestId("wire-ring")).toBeHidden();
  await expect(page.getByTestId("wire-arc")).toBeHidden();
  expect(await strokeOf(page, "wire-line")).toBe(white);
  const tipFar = await middleOf(page, "wire-tip");
  // Mouse coordinates reach the page as whole pixels.
  expect(Math.abs(tipFar.x - far.x)).toBeLessThan(1.5);
  expect(Math.abs(tipFar.y - far.y)).toBeLessThan(1.5);

  // IN RANGE: the ring on the port and the arc from the tip, in the texture's colour.
  const near = offPort(to, RANGE_PX - 12);
  await page.mouse.move(near.x, near.y, { steps: 4 });
  await expect(flight).toHaveAttribute("data-wire-state", "live");
  await expect(page.getByTestId("wire-ring")).toBeVisible();
  await expect(page.getByTestId("wire-arc")).toBeVisible();
  expect(await strokeOf(page, "wire-ring")).toBe(await tokenColor(page, "--port-texture2d"));
  // The wire is still white and its tip is still at the pointer: it has not jumped.
  expect(await strokeOf(page, "wire-line")).toBe(white);
  const tipNear = await middleOf(page, "wire-tip");
  expect(Math.abs(tipNear.x - near.x)).toBeLessThan(1.5);
  expect(Math.abs(tipNear.y - near.y)).toBeLessThan(1.5);
  // The ring is on the port's dot (once it has arrived: it scales in over 70 ms).
  await page.waitForTimeout(150);
  const ring = await middleOf(page, "wire-ring");
  expect(Math.abs(ring.x - to.x)).toBeLessThan(1.5);
  expect(Math.abs(ring.y - to.y)).toBeLessThan(1.5);
  // It crackles: a different shape a quarter of a second later, the pointer held still.
  const shape = await page.getByTestId("wire-arc").getAttribute("d");
  await page.waitForTimeout(250);
  expect(await page.getByTestId("wire-arc").getAttribute("d")).not.toBe(shape);
  // §V389 with the arc showing.
  expect(await boxes(page)).toEqual(atRest);

  // RELEASE, recorded frame by frame.
  const frames = await recordRelease(page);
  // The new wire is in the document and the old one is gone.
  await expect(wired).toHaveCount(1);
  await expect(replaced).toHaveCount(0);

  const during = expectSnap(frames, atRest, level);
  // Two bars and the glow's two, two rings and the dot.
  expect(during[0]?.bars).toBe(4);
  expect(during[0]?.rings).toBe(3);
  expect(during[0]?.reduced).toBe(false);
  // The bar is one dash on a border of length 1: two lengths, the dash and the rest. `none`
  // would be a declaration the browser dropped, and a bar that is the whole border.
  expect(during[3]?.dash).toMatch(/^[\d.]+px,? [\d.]+px$/);
  // And it TRAVELS: its offset is a different number on most frames.
  expect(new Set(during.map((frame) => frame.offset)).size).toBeGreaterThan(during.length / 2);
  // Animations were running while it played.
  expect(Math.max(...during.map((frame) => frame.animations))).toBeGreaterThan(3);

  // One edit: one undo puts the first wire back and takes the new one away (§V32).
  await focusGraph(page);
  await page.keyboard.press(`${await modKey(page)}+z`);
  await expect(replaced).toHaveCount(1);
  await expect(wired).toHaveCount(0);
});

test("at 35 %: the same range on screen, the same ring, and the same nothing left behind", async ({ page }) => {
  const { second, level } = await stage(page);
  const wired = page.locator(`.react-flow__edge[aria-label="Edge from ${second} to ${level}"]`);
  const flight = page.getByTestId("wire-in-flight");

  // The ring's and the tip's size at 100 %, to compare.
  const to100 = await dot(page, level, "input", "target");
  await carry(page, await dot(page, second, "out", "source"), offPort(to100, 40));
  await expect(flight).toHaveAttribute("data-wire-state", "live");
  await page.waitForTimeout(150);
  const ringAt100 = await middleOf(page, "wire-ring");
  const tipAt100 = await middleOf(page, "wire-tip");
  // Back out of every range, into the open between the nodes, and let go: nothing connects.
  await page.mouse.move(to100.x - 150, to100.y - 150, { steps: 6 });
  await expect(flight).toHaveAttribute("data-wire-state", "free");
  await page.mouse.up();
  await expect(flight).toHaveCount(0);
  await expect(wired).toHaveCount(0);

  await zoomTo(page, 0.35, { x: to100.x - 120, y: to100.y });
  const atRest = await boxes(page);
  const node = await page.locator(`.react-flow__node[data-id="${level}"]`).boundingBox();
  // The canvas did shrink: a node is about 62 px wide here.
  expect(node?.width ?? 0).toBeLessThan(70);

  const to = await dot(page, level, "input", "target");
  await carry(page, await dot(page, second, "out", "source"), offPort(to, RANGE_PX + 12));
  await expect(flight).toHaveAttribute("data-wire-state", "free");
  // 40 screen px is 114 graph px here: outside any radius that shrinks with the canvas.
  const near = offPort(to, 40);
  await page.mouse.move(near.x, near.y, { steps: 4 });
  await expect(flight).toHaveAttribute("data-wire-state", "live");
  await page.waitForTimeout(150);

  // The ring and the tip did not shrink with it.
  const ring = await middleOf(page, "wire-ring");
  const tip = await middleOf(page, "wire-tip");
  expect(ringAt100.width).toBeGreaterThan(14);
  expect(Math.abs(ring.width - ringAt100.width)).toBeLessThan(1);
  expect(Math.abs(tip.width - tipAt100.width)).toBeLessThan(1);
  expect(Math.abs(ring.x - to.x)).toBeLessThan(1.5);
  expect(Math.abs(ring.y - to.y)).toBeLessThan(1.5);
  expect(await boxes(page)).toEqual(atRest);

  const frames = await recordRelease(page);
  await expect(wired).toHaveCount(1);
  expectSnap(frames, atRest, level);
});

test("a connected wire is pulled off at its port, put back, and pulled off for good", async ({ page }) => {
  const { first, level } = await stage(page);
  const atRest = await boxes(page);
  const edge = page.locator(`.react-flow__edge[aria-label="Edge from ${first} to ${level}"]`);
  const flight = page.getByTestId("wire-in-flight");
  await expect(edge.locator(".react-flow__edge-path")).toHaveCount(1);

  // A press ON the dot and a first move: the wire is in the hand, held by its output.
  let to = await dot(page, level, "input", "target");
  await page.mouse.move(to.x, to.y);
  await page.mouse.down();
  await page.mouse.move(to.x - 5, to.y + 3, { steps: 3 });
  // Still in range of the port it came off, so it sparks at once, as in the reference.
  await expect(flight).toHaveAttribute("data-wire-state", "live");
  await expect(edge.locator(".react-flow__edge-path")).toHaveCount(0);
  // It is the wire from the first Noise's output, not a new one out of the Level's input.
  const out = await dot(page, first, "out", "source");
  const line = await page.getByTestId("wire-line").boundingBox();
  expect(Math.abs((line?.x ?? 0) - out.x)).toBeLessThan(6);

  await page.mouse.move(to.x - 120, to.y + 90, { steps: 8 });
  await expect(flight).toHaveAttribute("data-wire-state", "free");
  expect(await boxes(page)).toEqual(atRest);

  // BACK ON ITS OWN PORT: the wire is where it was, and the snap plays.
  await page.mouse.move(to.x - 24, to.y + 10, { steps: 8 });
  await expect(flight).toHaveAttribute("data-wire-state", "live");
  const frames = await recordRelease(page);
  expectSnap(frames, atRest, level);
  await expect(edge.locator(".react-flow__edge-path")).toHaveCount(1);
  // Nothing was said to the document: there is nothing of this gesture to undo, so one
  // undo takes back the edit BEFORE it, which is the wire itself.
  await focusGraph(page);
  const mod = await modKey(page);
  await page.keyboard.press(`${mod}+z`);
  await expect(edge).toHaveCount(0);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(edge.locator(".react-flow__edge-path")).toHaveCount(1);

  // LET GO IN THE OPEN: the wire comes off, as one edit, and no snap plays for it.
  to = await dot(page, level, "input", "target");
  await page.mouse.move(to.x, to.y);
  await page.mouse.down();
  await page.mouse.move(to.x - 5, to.y + 3, { steps: 3 });
  await page.mouse.move(to.x - 130, to.y + 100, { steps: 8 });
  await expect(flight).toHaveAttribute("data-wire-state", "free");
  const off = await recordRelease(page);
  await expect(edge).toHaveCount(0);
  expect(off.every((frame) => frame.snapOn.length === 0 && frame.fills === 0)).toBe(true);
  await focusGraph(page);
  await page.keyboard.press(`${mod}+z`);
  await expect(edge).toHaveCount(1);
});

test("reduced motion: the ring and the colour stay, nothing crackles and nothing travels", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { second, level } = await stage(page);
  const atRest = await boxes(page);

  const to = await dot(page, level, "input", "target");
  await carry(page, await dot(page, second, "out", "source"), offPort(to, 30));
  await expect(page.getByTestId("wire-in-flight")).toHaveAttribute("data-wire-state", "live");
  await expect(page.getByTestId("wire-ring")).toBeVisible();
  expect(await strokeOf(page, "wire-ring")).toBe(await tokenColor(page, "--port-texture2d"));
  // The arc is there, and it is one still shape.
  await expect(page.getByTestId("wire-arc")).toBeVisible();
  const shape = await page.getByTestId("wire-arc").getAttribute("d");
  await page.waitForTimeout(300);
  expect(await page.getByTestId("wire-arc").getAttribute("d")).toBe(shape);

  const frames = await recordRelease(page);
  await expect(page.locator(`.react-flow__edge[aria-label="Edge from ${second} to ${level}"]`)).toHaveCount(1);

  const during = frames.filter((frame) => frame.snapOn.length > 0);
  // It shows for 0.3 s: a still ring on the node, and the wire in its colour.
  expect(during.length).toBeGreaterThan(5);
  for (const frame of during) {
    expect(frame.snapOn).toEqual([level]);
    expect(frame.reduced).toBe(true);
    expect(frame.fills).toBe(1);
    // No bar at all, and one ring.
    expect(frame.bars).toBe(0);
    expect(frame.rings).toBe(1);
  }
  // The ring does not grow: one radius for as long as it shows.
  expect(new Set(during.map((frame) => frame.radius)).size).toBe(1);
  expect(during[0]?.radius).not.toBe("");
  for (const frame of frames) {
    expect(JSON.parse(frame.boxes)).toEqual(atRest);
  }
  const last = frames.slice(-5);
  for (const frame of last) {
    expect(frame.elements).toBe(0);
    expect(frame.animations).toBe(0);
  }
});
