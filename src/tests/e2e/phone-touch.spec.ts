import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";

import { createPhoneWrites } from "@/app/phone-writes.ts";
import { createPhoneDoor } from "@devices/phone/phone-door.ts";
import type { PhonePanel, PhoneSet, PhoneSnapshot } from "@devices/phone/phone-protocol.ts";
import { buildPhoneSnapshot } from "@devices/phone/phone-snapshot.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { controlNodeDefinitions, serializePanelBoard, type StoredBoardItem } from "@nodes/definitions/controls.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

import { FROZEN_PANELS } from "./phone-touch.fixture.ts";

/**
 * §T1607b — THE PHONE PAGE UNDER A REAL TOUCH. Owner: "we can still scroll with touch on the
 * page to get to all the controls without constantly accidentally moving sliders".
 *
 * What decides that is the BROWSER: whether a finger that lands on a slider and goes up
 * the page scrolls it (and cancels the pointer), or is handed to the slider. jsdom has no
 * such thing, so this drives the real page in Chromium with a touch-enabled phone context,
 * through CDP `Input.dispatchTouchEvent` — real touch input, through Chromium's own gesture
 * detector, `touch-action` filter and compositor scroll.
 *
 * The stack is the product's but for the loopback bridge between helper and editor (which
 * `phone-door-end-to-end.test.tsx` covers): a document on the real bus, the snapshot the
 * editor would publish (`buildPhoneSnapshot`), the helper's real door (HTTPS, its own
 * certificate, token, event stream) serving the real page, and every write the door
 * receives vetted and applied through `createPhoneWrites`, as the editor does. So "nothing
 * was written" is asserted where it matters — on the wire AND in the document.
 *
 * THIS SPEC READS NO PROJECT (§T1647b). Its boards are its own: one built here (the tall
 * board), three frozen in `phone-touch.fixture.ts` — copies of a real project's phone Panels
 * at named commits. It used to read that project's shipped file and went red three times
 * for layout changes nobody ran it for. A project's panels may now change freely.
 *
 * NOT covered, and not coverable here: iOS Safari and Android Chrome on a phone. Chromium's
 * touch emulation uses a 15 px slop; a real phone's is its platform's.
 */

const DESK: InvocationContext = { actor: { kind: "human", id: "desk" }, projectId: "phone-touch", capabilities: [] };

/** One certificate for the file: the door mints it with openssl on first opening. */
let certDir = "";
test.beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "loom-phone-touch-"));
});
test.afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

interface Stage {
  /** The page's address, token included — what the QR code carries. */
  readonly url: string;
  /** Every write that reached the door, in order. */
  readonly writes: PhoneSet[];
  /** Every sentence the vet or the bus refused a write with. A correct page causes none. */
  readonly refused: string[];
  /** Resolves when every write received so far is in the document. */
  settled(): Promise<void>;
  close(): void;
}

/** The helper's door on loopback, publishing what `snapshot` says and (with `apply`) writing what phones send. */
async function openStage(
  snapshot: (seq: number) => PhoneSnapshot,
  apply: (phone: string, set: PhoneSet) => Promise<void>,
  onChange: (publish: () => void) => () => void,
): Promise<Stage> {
  const door = createPhoneDoor({ lanAddress: () => "127.0.0.1", port: 0, certDir, firewall: () => Promise.resolve(null) });
  const writes: PhoneSet[] = [];
  const refused: string[] = [];
  let pending: Promise<void> = Promise.resolve();
  const state = await door.open({
    onWrite: (phone, set) => {
      writes.push(set);
      pending = pending.then(() => apply(phone, set));
    },
    onState: () => undefined,
    onSignal: () => undefined,
  });
  if (!state.open) throw new Error(`the phone door did not open: ${state.reason}`);
  let seq = 0;
  const publish = (): void => door.publish(snapshot((seq += 1)));
  publish();
  const stop = onChange(publish);
  return {
    url: state.url,
    writes,
    refused,
    settled: () => pending,
    close: () => {
      stop();
      door.dispose();
    },
  };
}

/*
 * THE TALL BOARD: one Panel, eight columns, every control the full width — twenty sliders,
 * a toggle, a momentary button, an XY pad six rows tall, twenty more sliders. No gaps to
 * scroll from, which is the owner's complaint in its purest form. About three screens of a
 * 390 × 664 phone.
 */
const SLIDERS = 40;
const sliderName = (index: number): string => `slider_row${String(index).padStart(2, "0")}`;
const sliderCaption = (index: number): string => `Row ${String(index).padStart(2, "0")}`;

async function tallStage(): Promise<Stage & { graph(): GraphDocument; node(name: string): GraphNode }> {
  const store = createGraphStore();
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(controlNodeDefinitions).view() });
  const operations: GraphPatchOperation[] = [];
  const items: StoredBoardItem[] = [];
  let row = 0;
  const place = (type: string, name: string, parameters: Record<string, unknown>, h = 1): void => {
    operations.push({ op: "addNode", ref: `$${name}`, type, position: { x: 0, y: row * 40 }, label: name, parameters } as GraphPatchOperation);
    items.push({ member: name, rect: { x: 0, y: row, w: 8, h } });
    row += h;
  };
  const slider = (index: number): void => place("slider", sliderName(index), { caption: sliderCaption(index), value: 0.5 });
  for (let index = 1; index <= SLIDERS / 2; index += 1) slider(index);
  place("toggle", "toggle_arm", { caption: "Arm" });
  place("button", "button_flash", { caption: "Flash" });
  place("xyPad", "xypad_aim", { caption: "Aim" }, 6);
  for (let index = SLIDERS / 2 + 1; index <= SLIDERS; index += 1) slider(index);
  operations.push({
    op: "addNode",
    ref: "$panel_tall",
    type: "panel",
    position: { x: 400, y: 0 },
    label: "panel_tall",
    parameters: { title: "Tall", remote: true, board: serializePanelBoard({ columns: 8, items }) },
  } as GraphPatchOperation);
  for (const item of items) {
    if (!("member" in item)) continue;
    operations.push({ op: "connect", source: { nodeId: `$${item.member}`, portId: "out" }, target: { nodeId: "$panel_tall", portId: "controls" } } as GraphPatchOperation);
  }
  const created = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label: "the tall board", operations }, DESK);
  expect(created.status).toBe("applied");

  const refused: string[] = [];
  const phoneWrites = createPhoneWrites({ bus, invocation: DESK, onRefused: (_phone, reason) => refused.push(reason) });
  const stage = await openStage(
    (seq) => buildPhoneSnapshot(bus.store.getGraph(), seq),
    async (phone, set) => {
      await phoneWrites.write(phone, set);
      await phoneWrites.settled();
    },
    (publish) => bus.store.subscribe(publish),
  );
  return {
    ...stage,
    refused,
    graph: () => bus.store.getGraph(),
    node: (name) => {
      const found = Object.values(bus.store.getGraph().nodes).find((node) => node.label === name);
      if (found === undefined) throw new Error(`no node named ${name}`);
      return found;
    },
    close: () => {
      phoneWrites.dispose();
      stage.close();
    },
  };
}

/**
 * The three frozen Panels (`phone-touch.fixture.ts`), published as a phone would get them.
 * No bus behind this one: what it is asked is whether anything is SENT.
 */
function frozenStage(): Promise<Stage> {
  return openStage(
    (seq) => ({ seq, panels: FROZEN_PANELS }),
    () => Promise.resolve(),
    () => () => undefined,
  );
}

/** A frozen Panel's board, by its title. */
function frozenBoard(title: string) {
  const board = FROZEN_PANELS.find((panel) => panel.title === title)?.board;
  if (board === undefined) throw new Error(`the fixture has no board titled ${title}`);
  return board;
}

interface Phone {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly errors: string[];
}

/** The page in a phone's browser: touch, a phone's viewport. `touch: false` is the same page opened on a desktop. */
async function openPhone(browser: Browser, url: string, viewport: { width: number; height: number }, touch = true): Promise<Phone> {
  const context = await browser.newContext(
    touch ? { viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true } : { viewport, ignoreHTTPSErrors: true },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, errors };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** One finger, as Chromium receives a real one. */
function finger(cdp: CDPSession) {
  let at: Point = { x: 0, y: 0 };
  const send = (type: "touchStart" | "touchMove" | "touchEnd"): Promise<unknown> =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: at.x, y: at.y, id: 1 }] });
  return {
    async down(point: Point): Promise<void> {
      at = point;
      await send("touchStart");
    },
    /** Travel (dx, dy) from where the finger is, in `steps` equal moves a frame apart. */
    async travel(dx: number, dy: number, steps: number): Promise<void> {
      const from = at;
      for (let step = 1; step <= steps; step += 1) {
        at = { x: from.x + (dx * step) / steps, y: from.y + (dy * step) / steps };
        await send("touchMove");
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    },
    async up(): Promise<void> {
      await send("touchEnd");
    },
  };
}

const scrollTop = (page: Page): Promise<number> => page.evaluate(() => Math.round(window.scrollY));
/** How far the page can scroll. A layout a fraction of a pixel tall rounds either way, so "at the end" is within one pixel of this. */
const scrollEnd = (page: Page): Promise<number> => page.evaluate(() => Math.round(document.documentElement.scrollHeight - window.innerHeight));
const atEnd = async (page: Page, end: number): Promise<boolean> => (await scrollTop(page)) >= end - 1;

/** Wait until a fling has run out, and say where the page stopped. */
async function settledScroll(page: Page): Promise<number> {
  let last = -1;
  for (let tries = 0; tries < 100; tries += 1) {
    const now = await scrollTop(page);
    if (now === last) return now;
    last = now;
    await page.waitForTimeout(120);
  }
  throw new Error("the page never stopped scrolling");
}

/** What a touch at `point` would land on: the nearest of the page's own kinds of thing. */
const kindAt = (page: Page, point: Point): Promise<string> =>
  page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    for (const kind of [".track", ".pad", "button.ctl", "#rail", "#pager", "#tabs"]) if (hit?.closest(kind)) return kind;
    return hit === null ? "nothing" : hit.tagName;
  }, point);

/**
 * A point 30% along the lowest slider that is wholly in view above the bars — where a
 * thumb reaching for the next screen would land.
 */
const lowestSlider = (page: Page): Promise<Point | null> =>
  page.evaluate(() => {
    const floor = Math.min(...["#tabs", "#pager"].map((id) => document.querySelector<HTMLElement>(id)).map((bar) => (bar === null || bar.hidden ? window.innerHeight : bar.getBoundingClientRect().top)));
    let best: { x: number; y: number } | null = null;
    for (const track of document.querySelectorAll<HTMLElement>(".track")) {
      const box = track.getBoundingClientRect();
      if (box.width === 0 || box.top < 0 || box.bottom > floor) continue;
      if (best === null || box.top > best.y) best = { x: box.left + box.width * 0.3, y: box.top + box.height / 2 };
    }
    return best;
  });

/**
 * Flick up the page from the lowest slider in view. Returns where the finger landed.
 *
 * `hesitant` is a thumb that starts slowly and wanders sideways before it commits: six
 * small moves, 5 px across and 12 px up in all. The browser has not yet decided that is a
 * scroll, so every one of them reaches the page as a pointermove along the slider — the
 * moves a slider with no threshold of its own would follow.
 */
async function flickFromSlider(phone: Phone, distance: number, hesitant = false): Promise<Point> {
  const start = await lowestSlider(phone.page);
  if (start === null) throw new Error("no slider is wholly in view to flick from");
  expect(await kindAt(phone.page, start), "the flick must start ON a slider").toBe(".track");
  const touch = finger(phone.cdp);
  await touch.down(start);
  if (hesitant) await touch.travel(5, -12, 6);
  // Up the page, drifting sideways the way a thumb does.
  await touch.travel(6, -distance, Math.max(4, Math.round(distance / 30)));
  await touch.up();
  await settledScroll(phone.page);
  return start;
}

/** Flick up from sliders until the page is at its end, `end` px down. Every flick must move it. */
async function flickToEnd(phone: Phone, end: number, hesitant = false): Promise<void> {
  for (let flick = 1; !(await atEnd(phone.page, end)); flick += 1) {
    if (flick > 12) throw new Error("twelve flicks did not reach the foot of the board");
    const before = await scrollTop(phone.page);
    await flickFromSlider(phone, 240, hesitant);
    expect(await scrollTop(phone.page), `flick ${String(flick)} must move the page`).toBeGreaterThan(before);
  }
}

const center = async (page: Page, selector: string): Promise<Point & { width: number; height: number }> => {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height };
};

/** Bring a control to the middle of the screen — navigation by script, no touch involved. */
const bringToMiddle = async (page: Page, selector: string): Promise<void> => {
  await page.locator(selector).evaluate((element) => element.scrollIntoView({ block: "center" }));
  await settledScroll(page);
};

test.describe("§T1607b the phone page under a real touch — a board three screens tall", () => {
  const VIEWPORT = { width: 390, height: 664 };

  test("flicked through from top to bottom touching only sliders, the page scrolls and NOTHING is written", async ({ browser }) => {
    const stage = await tallStage();
    const phone = await openPhone(browser, stage.url, VIEWPORT);
    try {
      await expect(phone.page.getByRole("slider", { name: sliderCaption(1) })).toBeVisible();
      const revision = stage.graph().revision;
      // The premise: the board is three screens tall, and there is nothing to scroll from but controls.
      const end = await scrollEnd(phone.page);
      expect(end).toBeGreaterThanOrEqual(2 * VIEWPORT.height);

      const visited = new Set<number>();
      for (let flick = 0; flick < 30 && !(await atEnd(phone.page, end)); flick += 1) {
        const before = await scrollTop(phone.page);
        // Every other flick starts slowly and off-line, as a real thumb often does.
        await flickFromSlider(phone, 260, flick % 2 === 0);
        const after = await scrollTop(phone.page);
        expect(after, `flick ${String(flick + 1)} must move the page`).toBeGreaterThan(before);
        visited.add(after);
      }
      expect(await atEnd(phone.page, end), "the flicks must reach the foot of the board").toBe(true);
      expect(visited.size).toBeGreaterThanOrEqual(3);
      // The last slider of the board is on screen: every control was reachable.
      await expect(phone.page.getByRole("slider", { name: sliderCaption(SLIDERS) })).toBeInViewport();

      // And back up, the same way, from the top-most slider downwards.
      const touch = finger(phone.cdp);
      for (let flick = 0; flick < 30 && (await scrollTop(phone.page)) > 0; flick += 1) {
        const start = await phone.page.evaluate(() => {
          for (const track of document.querySelectorAll<HTMLElement>(".track")) {
            const box = track.getBoundingClientRect();
            if (box.top >= 8) return { x: box.left + box.width * 0.7, y: box.top + box.height / 2 };
          }
          return null;
        });
        if (start === null) throw new Error("no slider in view to flick from");
        expect(await kindAt(phone.page, start)).toBe(".track");
        await touch.down(start);
        await touch.travel(-5, 260, 9);
        await touch.up();
        await settledScroll(phone.page);
      }
      expect(await scrollTop(phone.page)).toBe(0);

      // Nothing on the wire, nothing in the document, nothing moved on the phone.
      await phone.page.waitForTimeout(300);
      await stage.settled();
      expect(stage.writes).toEqual([]);
      expect(stage.graph().revision).toBe(revision);
      for (let index = 1; index <= SLIDERS; index += 1) expect(stage.node(sliderName(index)).parameters["value"], sliderName(index)).toBe(0.5);
      await expect(phone.page.getByRole("slider", { name: sliderCaption(1) })).toHaveAttribute("aria-valuenow", "0.5");
      expect(stage.refused).toEqual([]);
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });

  test("a deliberate drag along a slider moves it at once — the first write leaves while the finger is still moving — and the value follows the finger's travel, not its position", async ({ browser }) => {
    const stage = await tallStage();
    const phone = await openPhone(browser, stage.url, VIEWPORT);
    try {
      const caption = sliderCaption(3);
      const slider = phone.page.getByRole("slider", { name: caption });
      await expect(slider).toBeVisible();
      const box = await center(phone.page, `[role=slider][aria-label="${caption}"]`);
      // The finger lands a quarter of the way along a slider that shows 0.5: an absolute
      // slider would jump DOWN to 0.25 on touch.
      const touch = finger(phone.cdp);
      await touch.down({ x: box.x - box.width / 4, y: box.y });
      await phone.page.waitForTimeout(120);
      expect(stage.writes, "touch-down writes nothing").toEqual([]);
      // 16 px in two moves: the slider takes the touch at the second (past its 12 px), unmoved.
      await touch.travel(16, 1, 2);
      await touch.travel(48, -2, 6);
      // Still down, still moving: the document already has it.
      await expect.poll(() => stage.writes.length).toBeGreaterThan(0);
      expect(stage.writes[0]).toMatchObject({ handle: stage.node(sliderName(3)).id, phase: "live" });
      await expect.poll(() => stage.node(sliderName(3)).parameters["value"]).not.toBe(0.5);
      await touch.travel(40, 2, 5);
      await touch.up();
      await expect.poll(() => stage.writes.at(-1)?.phase).toBe("commit");
      await stage.settled();

      // 104 px of travel, 88 of it after the slider took the touch, over a track `width` px long, 0..1.
      const value = stage.node(sliderName(3)).parameters["value"] as number;
      expect(value).toBeCloseTo(0.5 + 88 / box.width, 9);
      await expect(slider).toHaveAttribute("aria-valuenow", String(value));
      // It only ever rose: no write of the finger's POSITION (0.25 and up) came first.
      const values = stage.writes.map((set) => set.values["value"] as number);
      expect(values).toEqual([...values].sort((a, b) => a - b));
      expect(values[0]).toBeGreaterThan(0.5);
      expect(stage.writes.filter((set) => set.phase === "commit")).toHaveLength(1);
      // The drag was the slider's alone: the page stayed, every other control stayed.
      expect(await scrollTop(phone.page)).toBe(0);
      expect(new Set(stage.writes.map((set) => set.handle)).size).toBe(1);
      expect(stage.refused).toEqual([]);
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });

  test("a slider that has started moving keeps the touch when the finger then wanders up the page", async ({ browser }) => {
    const stage = await tallStage();
    const phone = await openPhone(browser, stage.url, VIEWPORT);
    try {
      const caption = sliderCaption(5);
      await expect(phone.page.getByRole("slider", { name: caption })).toBeVisible();
      const box = await center(phone.page, `[role=slider][aria-label="${caption}"]`);
      const touch = finger(phone.cdp);
      await touch.down({ x: box.x, y: box.y });
      await touch.travel(40, 0, 5);
      // Far up the page, off the slider entirely, and on along it.
      await touch.travel(0, -200, 8);
      await touch.travel(40, 0, 5);
      await touch.up();
      await expect.poll(() => stage.writes.at(-1)?.phase).toBe("commit");
      await stage.settled();
      // Taken at 16 px; 64 px more along the track, whatever the finger did across it.
      expect(stage.node(sliderName(5)).parameters["value"]).toBeCloseTo(0.5 + 64 / box.width, 9);
      expect(await scrollTop(phone.page)).toBe(0);
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });

  test("a toggle under a scrolling finger does not flip; a tap flips it, on release", async ({ browser }) => {
    const stage = await tallStage();
    const phone = await openPhone(browser, stage.url, VIEWPORT);
    try {
      const toggle = phone.page.getByRole("button", { name: "Arm" });
      await bringToMiddle(phone.page, ".w.toggle button.ctl");
      await expect(toggle).toBeInViewport();
      const at = await center(phone.page, ".w.toggle button.ctl");
      expect(await kindAt(phone.page, at)).toBe("button.ctl");
      const touch = finger(phone.cdp);

      // A flick that starts ON the toggle.
      const before = await scrollTop(phone.page);
      await touch.down(at);
      await touch.travel(4, -220, 8);
      await touch.up();
      expect(await settledScroll(phone.page)).toBeGreaterThan(before);
      await phone.page.waitForTimeout(300);
      expect(stage.writes).toEqual([]);
      expect(stage.node("toggle_arm").parameters["on"]).toBe(false);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");

      // A tap: nothing while the finger is down, the flip when it lifts.
      await bringToMiddle(phone.page, ".w.toggle button.ctl");
      const again = await center(phone.page, ".w.toggle button.ctl");
      await touch.down(again);
      await phone.page.waitForTimeout(250);
      expect(stage.writes).toEqual([]);
      await touch.up();
      await expect.poll(() => stage.writes.length).toBe(1);
      await stage.settled();
      expect(stage.writes).toEqual([{ handle: stage.node("toggle_arm").id, values: { on: true }, phase: "commit" }]);
      expect(stage.node("toggle_arm").parameters["on"]).toBe(true);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(stage.refused).toEqual([]);
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });

  /*
   * A momentary Button is 1 while held and counts its presses. On a page that scrolls, a
   * touch on it may be a scroll starting: nothing is sent on touch-down. A tap is a whole
   * press on release; a finger that rests holds it down until it lifts.
   */
  test("a momentary button under a scrolling finger is not pressed; a tap is one press, on release; a resting finger holds it down", async ({ browser }) => {
    const stage = await tallStage();
    const phone = await openPhone(browser, stage.url, VIEWPORT);
    try {
      const selector = ".w.button button.ctl";
      const flash = (): Record<string, unknown> => stage.node("button_flash").parameters;
      await bringToMiddle(phone.page, selector);
      const touch = finger(phone.cdp);

      const before = await scrollTop(phone.page);
      await touch.down(await center(phone.page, selector));
      await touch.travel(4, -220, 8);
      await touch.up();
      expect(await settledScroll(phone.page)).toBeGreaterThan(before);
      await phone.page.waitForTimeout(400);
      expect(stage.writes).toEqual([]);
      expect([flash()["held"], flash()["presses"]]).toEqual([false, 0]);

      // A tap, shorter than the rest that would hold it.
      await bringToMiddle(phone.page, selector);
      await touch.down(await center(phone.page, selector));
      await phone.page.waitForTimeout(60);
      expect(stage.writes).toEqual([]);
      await touch.up();
      await expect.poll(() => stage.writes.length).toBe(2);
      await stage.settled();
      const handle = stage.node("button_flash").id;
      expect(stage.writes).toEqual([
        { handle, values: { held: true }, phase: "live" },
        { handle, values: { held: false }, phase: "commit" },
      ]);
      expect([flash()["held"], flash()["presses"]]).toEqual([false, 1]);

      // A finger that rests: held while it is down — the document says so — and let go when it lifts.
      await touch.down(await center(phone.page, selector));
      await expect.poll(() => flash()["held"]).toBe(true);
      await expect(phone.page.locator(selector)).toHaveAttribute("aria-pressed", "true");
      expect(stage.writes).toHaveLength(3);
      await phone.page.waitForTimeout(300);
      expect(flash()["held"], "still held: nothing lets go but the finger").toBe(true);
      await touch.up();
      await expect.poll(() => flash()["held"]).toBe(false);
      await stage.settled();
      expect(flash()["presses"]).toBe(2);
      expect(stage.writes).toHaveLength(4);
      expect(stage.refused).toEqual([]);
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });

  /* The same page opened on a desktop: it is an ordinary scrolling document, and a mouse drags by the same rule. */
  test("on a desktop a wheel over a slider scrolls the page and writes nothing; a mouse drag moves the slider by its travel", async ({ browser }) => {
    const stage = await tallStage();
    const desk = await openPhone(browser, stage.url, { width: 900, height: 664 }, false);
    try {
      const caption = sliderCaption(2);
      await expect(desk.page.getByRole("slider", { name: caption })).toBeVisible();
      const box = await center(desk.page, `[role=slider][aria-label="${caption}"]`);
      await desk.page.mouse.move(box.x, box.y);
      await desk.page.mouse.wheel(0, 300);
      await expect.poll(() => scrollTop(desk.page)).toBe(300);
      await desk.page.waitForTimeout(300);
      expect(stage.writes).toEqual([]);

      const again = await center(desk.page, `[role=slider][aria-label="${sliderCaption(6)}"]`);
      await desk.page.mouse.move(again.x - 100, again.y);
      await desk.page.mouse.down();
      await desk.page.waitForTimeout(100);
      expect(stage.writes, "a click on a slider writes nothing").toEqual([]);
      await desk.page.mouse.move(again.x - 84, again.y, { steps: 2 }); // taken at 16 px
      await desk.page.mouse.move(again.x - 34, again.y + 30, { steps: 5 });
      await desk.page.mouse.up();
      await expect.poll(() => stage.writes.at(-1)?.phase).toBe("commit");
      await stage.settled();
      expect(stage.node(sliderName(6)).parameters["value"]).toBeCloseTo(0.5 + 50 / again.width, 9);
      expect(await scrollTop(desk.page)).toBe(300);
      expect(desk.errors).toEqual([]);
    } finally {
      await desk.context.close();
      stage.close();
    }
  });

  test("an XY pad still tracks a finger and never scrolls the page; the rail beside it does, and writes nothing", async ({ browser }) => {
    const stage = await tallStage();
    const phone = await openPhone(browser, stage.url, VIEWPORT);
    try {
      await bringToMiddle(phone.page, ".pad");
      const pad = await center(phone.page, ".pad");
      expect(await kindAt(phone.page, pad)).toBe(".pad");
      const rested = await scrollTop(phone.page);
      const touch = finger(phone.cdp);

      // Down the screen and to the right, from the middle of a pad that shows (0.5, 0.5).
      await touch.down(pad);
      await touch.travel(60, 60, 10);
      await touch.up();
      await expect.poll(() => stage.writes.at(-1)?.phase).toBe("commit");
      await stage.settled();
      // Taken after two 6 px moves each way (17 px of travel): 48 px more on each axis, y up.
      const aim = stage.node("xypad_aim").parameters;
      expect(aim["x"]).toBeCloseTo(0.5 + 48 / pad.width, 9);
      expect(aim["y"]).toBeCloseTo(0.5 - 48 / pad.height, 9);
      expect(await scrollTop(phone.page), "a drag on a pad is the pad's: the page does not move").toBe(rested);

      // A drag straight up the pad is the pad's too — which is why the page needs the rail.
      const written = stage.writes.length;
      await touch.down(pad);
      await touch.travel(0, -120, 6);
      await touch.up();
      await expect.poll(() => stage.writes.length).toBeGreaterThan(written);
      expect(await settledScroll(phone.page)).toBe(rested);

      // THE RAIL: there because this view scrolls and shows a pad; no control lies under it.
      const rail = phone.page.locator("#rail");
      await expect(rail).toBeVisible();
      const railBox = (await rail.boundingBox())!;
      const rightmost = await phone.page.evaluate(() => Math.max(...[...document.querySelectorAll(".board > *")].map((cell) => cell.getBoundingClientRect().right)));
      expect(rightmost).toBeLessThanOrEqual(railBox.x);
      const onRail = { x: railBox.x + railBox.width / 2, y: pad.y };
      expect(await kindAt(phone.page, onRail)).toBe("#rail");
      await stage.settled();
      const quiet = stage.writes.length;
      await touch.down(onRail);
      await touch.travel(0, -200, 8);
      await touch.up();
      expect(await settledScroll(phone.page)).toBeGreaterThanOrEqual(rested + 150);
      await phone.page.waitForTimeout(300);
      expect(stage.writes).toHaveLength(quiet);
      expect(stage.refused).toEqual([]);
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });
});

/*
 * A REAL PROJECT'S PHONE PANELS, FROZEN (`phone-touch.fixture.ts`, §T1647b): three tabs, each
 * taller than a small phone's screen. Lights is every slider the board's full width — nowhere
 * to scroll from but a slider. Robot and Scene are inset, a bare strip beside the controls:
 * what the project did after the owner, on a real phone, found it "still pretty hard to not
 * screw with the sliders when scrolling on mobile". Either way a flick that STARTS on a slider
 * must scroll and write nothing: that is what this holds.
 */
test.describe("§T1607b the phone page under a real touch — a project's Panels, frozen", () => {
  const VIEWPORT = { width: 375, height: 600 };
  const tabNames = (page: Page): Promise<string[]> => page.locator("#tabs [role=tab]").allTextContents();
  const pageNames = (page: Page): Promise<string[]> => page.locator("#pager [role=tab]").allTextContents();
  const chosenPage = (page: Page): Promise<string[]> => page.locator("#pager [aria-selected=true]").allTextContents();
  const shownCells = (page: Page): Promise<number> => page.locator("section.panel:not([hidden]) .board > :not([hidden])").count();

  test("each tab scrolls from a flick that starts on a slider — full width or inset — and nothing is written", async ({ browser }) => {
    const stage = await frozenStage();
    const phone = await openPhone(browser, stage.url, VIEWPORT);
    try {
      await expect(phone.page.locator("#tabs [role=tab]")).toHaveCount(4);
      expect(await tabNames(phone.page)).toEqual(["Lights", "Robot", "Scene", "Camera"]);
      for (const [name, fullWidth] of [["Lights", true], ["Robot", false], ["Scene", false]] as const) {
        await phone.page.locator("#tabs [role=tab]", { hasText: name }).tap();
        await expect(phone.page.locator("#tabs [aria-selected=true]")).toHaveText(name);
        // The premise, which a frozen board cannot lose: taller than the screen, and sliders of the shape named.
        const end = await scrollEnd(phone.page);
        expect(end, `${name} must need scrolling`).toBeGreaterThan(0);
        const widths = await phone.page.evaluate(() => {
          const board = document.querySelector("section.panel:not([hidden]) .board")!.getBoundingClientRect().width;
          return [...document.querySelectorAll("section.panel:not([hidden]) .track")].map((track) => track.getBoundingClientRect().width / board);
        });
        expect(widths.length).toBeGreaterThanOrEqual(8);
        if (fullWidth) {
          expect(Math.min(...widths), `${name}: every slider is the board's full width`).toBeCloseTo(1, 3);
        } else {
          expect(Math.min(...widths), `${name}: every slider is most of the board's width`).toBeGreaterThan(0.7);
          expect(Math.max(...widths), `${name}: and none reaches into the bare strip beside them`).toBeLessThan(0.85);
        }

        // To its foot, however many flicks that takes (a row is at least a finger tall, §B269, so these are long boards).
        await flickToEnd(phone, end, true);
      }
      await phone.page.waitForTimeout(300);
      expect(stage.writes).toEqual([]);
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });

  test("pages switch and remember: the Scene Panel's sections, each Panel's place, and the choice on the next visit", async ({ browser }) => {
    const stage = await frozenStage();
    const phone = await openPhone(browser, stage.url, VIEWPORT);
    try {
      const tab = (name: string) => phone.page.locator("#tabs [role=tab]", { hasText: name });
      const chip = (name: string) => phone.page.locator("#pager [role=tab]", { hasText: name });
      await tab("Scene").tap();
      // Two labels with controls under them: All, and a page for each.
      await expect(phone.page.locator("#pager")).toBeVisible();
      expect(await pageNames(phone.page)).toEqual(["All", "Scene", "Camera"]);
      expect(await chosenPage(phone.page)).toEqual(["All"]);
      // All of the Panel's board: its two labels and every member under them.
      const whole = frozenBoard("Scene").items.length;
      expect(whole).toBe(16);
      expect(await shownCells(phone.page)).toBe(whole);

      await chip("Camera").tap();
      expect(await chosenPage(phone.page)).toEqual(["Camera"]);
      // Its label, a slider, a toggle and the pad — and nothing of the Scene section.
      expect(await shownCells(phone.page)).toBe(4);
      await expect(phone.page.locator("section.panel:not([hidden]) .board > .label:not([hidden])")).toHaveText("Camera");
      await expect(phone.page.locator(".pad")).toBeVisible();
      await expect(phone.page.getByRole("slider")).toHaveCount(1);

      // Another Panel has no sections and so no pager; scroll it to its end and leave.
      await tab("Robot").tap();
      await expect(phone.page.locator("#pager")).toBeHidden();
      const end = await scrollEnd(phone.page);
      expect(end).toBeGreaterThan(0);
      await flickToEnd(phone, end);
      const left = await scrollTop(phone.page);
      expect(left).toBeGreaterThanOrEqual(end - 1);

      // Back on Scene: its page is still Camera, at the top where it was left.
      await tab("Scene").tap();
      expect(await chosenPage(phone.page)).toEqual(["Camera"]);
      expect(await shownCells(phone.page)).toBe(4);
      expect(await scrollTop(phone.page)).toBe(0);
      // And Robot is where the finger left it.
      await tab("Robot").tap();
      expect(await scrollTop(phone.page)).toBe(left);

      // The next visit (a reload): the tab last shown, and Scene's page, are the phone's own memory.
      await tab("Scene").tap();
      await phone.page.reload();
      await expect(phone.page.locator("#tabs [aria-selected=true]")).toHaveText("Scene");
      expect(await chosenPage(phone.page)).toEqual(["Camera"]);
      expect(await shownCells(phone.page)).toBe(4);
      await chip("All").tap();
      expect(await shownCells(phone.page)).toBe(whole);

      expect(stage.writes).toEqual([]);
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });
});

/*
 * §B269 — A BOARD OF NARROW COLUMNS IS NEVER CRUSHED OR CLIPPED. Owner, on his phone, the day
 * a project re-gridded its panels from eight columns to ten: "on the phone the sliders are now
 * crunched and some buttons cut off". A board's row was as tall as its column is wide, so ten
 * columns on a 375 px phone made every slider, toggle and preset button 30 px tall.
 *
 * What a phone user must be able to rely on, whatever grid an author chose:
 *  - a row is never drawn lower than ROW. (36 px, between what the owner called crunched and
 *    what he called a smidge too chunky; which of 32, 36 and 44 it is to be is his to try.)
 *  - what a finger can HIT is more than what is drawn: a toggle, a button and a preset
 *    answer from half the gap above and below them too, HIT px in all, and no two of them
 *    answer for the same spot. (44 px, the usual finger size, would need rows of 38 or a
 *    gap of 8: with rows of 36 six px apart, 42 is all there is without overlapping.)
 *  - nothing is cut: a caption that does not fit ends in an ellipsis, a strip of presets too
 *    long for its row scrolls sideways with every name whole, a slider's handle stays inside
 *    its track at both ends.
 *  - the last control of a board scrolls clear of the bars fixed at the foot of the page.
 * Asserted on real boxes: the two frozen ten-column Panels, and CRAMPED, a board made of
 * the awkward cases.
 */
const ROW = 36;
const GAP = 6;
const HIT = ROW + GAP;
const LOOKS = ["reset_robot", "reset_scene", "reset_lights", "reset_all", "soft_amber", "hard_strobe"] as const;
const CRAMPED: PhonePanel = {
  title: "Cramped",
  rows: [],
  board: {
    columns: 10,
    rows: 7,
    items: [
      { kind: "label", rect: { x: 0, y: 0, w: 4, h: 1 }, text: "A heading far longer than its four cells" },
      { kind: "widget", rect: { x: 0, y: 1, w: 8, h: 1 }, widget: { kind: "preset", handle: "presets_looks", caption: "looks", presets: LOOKS, current: "reset_all", morphing: false } },
      { kind: "widget", rect: { x: 0, y: 2, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_top", caption: "At its top", value: 1, min: 0, max: 1, step: 0 } },
      { kind: "widget", rect: { x: 0, y: 3, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_foot", caption: "At its foot, under a caption much longer than the slider is wide", value: 0, min: 0, max: 1, step: 0 } },
      { kind: "widget", rect: { x: 0, y: 4, w: 3, h: 1 }, widget: { kind: "toggle", handle: "toggle_long", caption: "Follow the track closely", on: true } },
      { kind: "widget", rect: { x: 3, y: 4, w: 3, h: 1 }, widget: { kind: "button", handle: "button_long", caption: "Flash everything", held: false } },
      { kind: "widget", rect: { x: 6, y: 4, w: 2, h: 2 }, widget: { kind: "xyPad", handle: "xypad_small", caption: "Chase side / height", x: 2, y: 2, min: -2, max: 2 } },
      { kind: "widget", rect: { x: 0, y: 5, w: 6, h: 1 }, widget: { kind: "layer", handle: "layer_fx", caption: "fx", on: true, opacity: 1, opacityWritable: true, picture: "" } },
      { kind: "widget", rect: { x: 0, y: 6, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_last", caption: "Last", value: 0.5, min: 0, max: 1, step: 0 } },
    ],
  },
};

test.describe("§B269 the phone page — a board of narrow columns is never crushed or clipped", () => {
  /**
   * What is wrong with the board showing: parts drawn lower than a row, hit areas shorter
   * than a row and its gap, two hit areas answering for one spot, content cut by its own
   * box, preset names not whole, a page that pans sideways, a last control under the bars.
   */
  const faults = (page: Page) =>
    page.evaluate(({ row, hit }) => {
      const board = document.querySelector<HTMLElement>("section.panel:not([hidden]) .board");
      if (board === null) throw new Error("no board is showing");
      const say = (part: Element): string => `<${part.tagName.toLowerCase()}.${part.className}> "${(part.textContent ?? "").trim().slice(0, 24)}"`;
      const showing = (part: Element): boolean => part.closest("[hidden]") === null && getComputedStyle(part).display !== "none";
      const low: string[] = [];
      for (const part of board.querySelectorAll<HTMLElement>(".ctl, .press, .fader")) {
        const height = part.getBoundingClientRect().height;
        if (showing(part) && height < row - 0.5) low.push(`${say(part)} is ${height.toFixed(1)} px tall`);
      }
      // HIT AREAS, probed the way a finger meets them: up and down through the middle of each
      // toggle, button and preset, asking the browser what a touch at that point would land
      // on. A point is the control's when it lands inside the box that answers for it — the
      // board item, or a preset's strip (whose margin presses the button it is over).
      const short: string[] = [];
      const spans: Array<{ what: string; left: number; right: number; top: number; bottom: number }> = [];
      for (const part of board.querySelectorAll<HTMLElement>(".w.toggle > button.ctl, .w.button > button.ctl, .w.preset .press")) {
        if (!showing(part)) continue;
        const strip = part.closest<HTMLElement>(".strip");
        const answers = strip ?? part.closest<HTMLElement>(".w");
        if (answers === null) continue;
        window.scrollTo(0, part.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3);
        const box = part.getBoundingClientRect();
        const within = strip?.getBoundingClientRect();
        // A preset the strip has scrolled out of sight sideways is not there to be probed.
        if (within !== undefined && (box.left < within.left - 0.5 || box.right > within.right + 0.5)) continue;
        const x = (box.left + box.right) / 2;
        let top = NaN, bottom = NaN;
        for (let y = box.top - 10; y <= box.bottom + 10; y += 0.5) {
          const landed = document.elementFromPoint(x, y);
          if (landed === null || !answers.contains(landed)) continue;
          if (Number.isNaN(top)) top = y;
          bottom = y;
        }
        const tall = bottom - top + 0.5;
        if (!(tall >= hit - 1)) short.push(`${say(part)} answers over ${tall.toFixed(1)} px`);
        // What the page DECLARES as this control's hit area (a probe cannot show two areas
        // on one spot: a point lands on one thing). A preset: its own width, the strip's
        // height. A toggle or a button: its item, grown by the item's ::before.
        const item = answers.getBoundingClientRect();
        const before = getComputedStyle(answers, "::before");
        const grown = strip === null && before.content !== "none" ? -parseFloat(before.top) : 0;
        spans.push({
          what: say(part),
          left: strip === null ? item.left - grown : box.left,
          right: strip === null ? item.right + grown : box.right,
          top: item.top - grown + window.scrollY,
          bottom: item.bottom + grown + window.scrollY,
        });
      }
      const shared: string[] = [];
      spans.forEach((one, index) => {
        for (const other of spans.slice(index + 1)) {
          const across = Math.min(one.right, other.right) - Math.max(one.left, other.left);
          const down = Math.min(one.bottom, other.bottom) - Math.max(one.top, other.top);
          if (across > 0.5 && down > 0.5) shared.push(`${one.what} and ${other.what} both answer over ${across.toFixed(1)} x ${down.toFixed(1)} px`);
        }
      });
      // CUT: a box that hides what does not fit, holding content that reaches past it — on any
      // side (a caption that wraps upward out of a bottom-aligned heading is cut at the TOP,
      // which a scroll size does not report). The one exception is a box that ends its single
      // line of text in an ellipsis: that is how a caption that does not fit is shown.
      const cut: string[] = [];
      const range = document.createRange();
      for (const part of board.querySelectorAll<HTMLElement>("*")) {
        if (!showing(part)) continue;
        const style = getComputedStyle(part);
        const hides = (value: string): boolean => value === "hidden" || value === "clip";
        if (!hides(style.overflowX) && !hides(style.overflowY)) continue;
        // What the box holds directly: its child elements' boxes and its own text. (What a
        // child holds is that child's business, and is looked at when the walk reaches it.)
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const child of part.childNodes) {
          let rect: DOMRect | null = null;
          if (child instanceof HTMLElement) rect = showing(child) ? child.getBoundingClientRect() : null;
          else if ((child.textContent ?? "").trim() !== "") {
            range.selectNodeContents(child);
            rect = range.getBoundingClientRect();
          }
          if (rect === null) continue;
          left = Math.min(left, rect.left);
          top = Math.min(top, rect.top);
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
        }
        if (left === Infinity) continue;
        const outer = part.getBoundingClientRect();
        const box = { left: outer.left + part.clientLeft, top: outer.top + part.clientTop, right: outer.left + part.clientLeft + part.clientWidth, bottom: outer.top + part.clientTop + part.clientHeight };
        const elides = style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap";
        const across = Math.max(box.left - left, right - box.right);
        const down = Math.max(box.top - top, bottom - box.bottom);
        if (hides(style.overflowX) && across > 1 && !elides) cut.push(`${say(part)} is cut across by ${across.toFixed(0)} px`);
        if (hides(style.overflowY) && down > 1) cut.push(`${say(part)} is cut down by ${down.toFixed(0)} px`);
      }
      // A preset is recalled by its NAME: six buttons that all read "reset…" are six unknowns.
      const unnamed = [...board.querySelectorAll<HTMLElement>(".w.preset .press")].filter((button) => button.scrollWidth > button.clientWidth + 1).map((button) => button.textContent ?? "");
      const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      // THE FOOT: scrolled as far as the page goes, the lowest thing on the board is above the bars fixed below it.
      window.scrollTo(0, document.documentElement.scrollHeight);
      const lowest = Math.max(...[...board.children].filter(showing).map((cell) => cell.getBoundingClientRect().bottom));
      const bars = [...document.querySelectorAll<HTMLElement>("#tabs, #pager")].filter(showing).map((bar) => bar.getBoundingClientRect().top);
      const under = Math.max(0, Math.round(lowest - Math.min(...bars)));
      window.scrollTo(0, 0);
      return { low, short, shared, cut, unnamed, sideways, under };
    }, { row: ROW, hit: HIT });

  test("at 375 px wide no row is lower than the floor, a press reaches half the gap round its control, nothing is cut or under the bars, and a long strip of presets scrolls to its last button", async ({ browser }) => {
    const stage = await openStage(
      (seq) => ({ seq, panels: [...FROZEN_PANELS, CRAMPED] }),
      () => Promise.resolve(),
      () => () => undefined,
    );
    const phone = await openPhone(browser, stage.url, { width: 375, height: 667 });
    try {
      const tab = (name: string) => phone.page.locator("#tabs [role=tab]", { hasText: name });
      // The premise: these boards are ten columns, so a column — and, before the floor, a row — is about 30 px.
      const found: Record<string, Awaited<ReturnType<typeof faults>>> = {};
      for (const name of ["Robot", "Scene", "Cramped"]) {
        await tab(name).tap();
        await expect(phone.page.locator("#tabs [aria-selected=true]")).toHaveText(name);
        const column = await phone.page.evaluate(() => {
          const grid = document.querySelector<HTMLElement>("section.panel:not([hidden]) .board")!;
          const columns = Number(grid.style.getPropertyValue("--cols"));
          return (grid.getBoundingClientRect().width - (columns - 1) * 6) / columns;
        });
        expect(column, `${name}: a column narrower than the floor`).toBeLessThan(ROW - 4);
        found[name] = await faults(phone.page);
      }
      const none = { low: [], short: [], shared: [], cut: [], unnamed: [], sideways: 0, under: 0 };
      expect(found).toEqual({ Robot: none, Scene: none, Cramped: none });

      // THE REACH, pressed: a tap two pixels ABOVE what is drawn of a toggle flips it, and one above a preset recalls it.
      const touch = finger(phone.cdp);
      const above = async (selector: string): Promise<Point> => {
        const box = await center(phone.page, selector);
        return { x: box.x, y: box.y - box.height / 2 - 2 };
      };
      const onToggle = await above("section.panel:not([hidden]) .w.toggle > button.ctl");
      expect(await kindAt(phone.page, onToggle), "two pixels above a toggle is not on its button").not.toBe("button.ctl");
      await touch.down(onToggle);
      await touch.up();
      await expect.poll(() => stage.writes.length).toBe(1);
      const onPreset = await above('section.panel:not([hidden]) .w.preset [data-preset="reset_robot"]');
      await touch.down(onPreset);
      await touch.up();
      await expect.poll(() => stage.writes.length).toBe(2);
      expect(stage.writes).toEqual([
        { handle: "toggle_long", values: { on: false }, phase: "commit" },
        { handle: "presets_looks", values: { recall: "reset_robot" }, phase: "commit" },
      ]);

      // The strip of six presets is wider than its row: it scrolls sideways, and its last button can be reached and pressed.
      const strip = phone.page.locator("section.panel:not([hidden]) .w.preset .strip");
      const reach = await strip.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(reach).toBeGreaterThan(0);
      const last = phone.page.getByRole("button", { name: "hard_strobe" });
      await expect(last).not.toBeInViewport();
      const box = (await strip.boundingBox())!;
      await touch.down({ x: box.x + box.width - 30, y: box.y + box.height / 2 });
      await touch.travel(-(box.width - 60), 2, 8);
      await touch.up();
      await expect.poll(() => strip.evaluate((element) => Math.round(element.scrollLeft))).toBeGreaterThan(0);
      await phone.page.waitForTimeout(400);
      expect(stage.writes, "a swipe along the strip recalls nothing").toHaveLength(2);
      await expect(last).toBeInViewport();
      await last.tap();
      await expect.poll(() => stage.writes.length).toBe(3);
      expect(stage.writes[2]).toEqual({ handle: "presets_looks", values: { recall: "hard_strobe" }, phase: "commit" });
      expect(phone.errors).toEqual([]);
    } finally {
      await phone.context.close();
      stage.close();
    }
  });
});
