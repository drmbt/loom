import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import { PHONE_EXPIRED_SENTENCE, phonePageHtml } from "./phone-page.ts";
import { PHONE_EVENTS_PATH, PHONE_SET_PATH, type PhoneEvent, type PhoneSet, type PhoneSnapshot } from "./phone-protocol.ts";

/**
 * T1396b — the phone page, driven as the phone runs it: the SERVED HTML string is parsed by
 * jsdom with scripts on, so the inline client under test is byte-for-byte what the helper
 * sends. A fresh JSDOM per test (rather than `@vitest-environment jsdom`'s one shared
 * window) because the page's script owns its window for the whole session. jsdom ships
 * without type declarations here, so the constructor is typed at the one place it is used.
 *
 * The network is fake at the page's own globals — `EventSource`, `fetch`,
 * `requestAnimationFrame` — so every assertion is about what the phone would put on the wire
 * or on the screen.
 */

interface PageWindow extends Window {
  PointerEvent: typeof PointerEvent;
  MouseEvent: typeof MouseEvent;
  HTMLElement: typeof HTMLElement;
}
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: PageWindow };
  VirtualConsole: new () => { on(event: string, listener: (...args: unknown[]) => void): void };
};

/** Everything any page printed or threw. The page is meant to be silent: no console noise. */
const noise: unknown[][] = [];
afterEach(() => {
  const heard = noise.splice(0);
  expect(heard).toEqual([]);
});

const TOKEN = "tok-123";

interface Post {
  readonly url: string;
  readonly set: PhoneSet;
  settle(status?: number, body?: string): void;
  settled: boolean;
}

class FakeEventSource {
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

function openPage() {
  const frames: (() => void)[] = [];
  const posts: Post[] = [];
  const sources: FakeEventSource[] = [];
  const otherRequests: string[] = [];
  let open = 0;
  let maxOpen = 0;
  const virtualConsole = new VirtualConsole();
  for (const level of ["jsdomError", "error", "warn", "info", "log", "debug"]) {
    virtualConsole.on(level, (...args) => noise.push([level, ...args.map(String)]));
  }
  const dom = new JSDOM(phonePageHtml(), {
    virtualConsole,
    url: `https://192.168.1.20:8443/?t=${TOKEN}`,
    runScripts: "dangerously",
    beforeParse(win: PageWindow) {
      const globals = win as unknown as Record<string, unknown>;
      globals["EventSource"] = class extends FakeEventSource {
        constructor(url: string) {
          super(url);
          sources.push(this);
        }
      };
      globals["requestAnimationFrame"] = (callback: () => void) => frames.push(callback);
      globals["fetch"] = (url: string, init: { method?: string; body?: string }) => {
        if (init?.method !== "POST" || !url.startsWith(PHONE_SET_PATH)) otherRequests.push(url);
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        return new Promise((resolve) => {
          const post: Post = {
            url,
            set: JSON.parse(init.body ?? "null") as PhoneSet,
            settled: false,
            settle(status = 204, body = "") {
              post.settled = true;
              open -= 1;
              resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
            },
          };
          posts.push(post);
        });
      };
      // jsdom lays nothing out: every control is a 200 × 200 box at the origin.
      win.HTMLElement.prototype.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0 }) as DOMRect;
    },
  });
  const win = dom.window;
  const doc = win.document;
  const source = sources[0];
  if (source === undefined) throw new Error("the page opened no EventSource");

  const flush = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const page = {
    win,
    doc,
    source,
    sources,
    posts,
    otherRequests,
    get maxOpen() {
      return maxOpen;
    },
    emit(event: PhoneEvent) {
      source.onmessage?.({ data: JSON.stringify(event) });
    },
    snapshot(snapshot: PhoneSnapshot) {
      page.emit({ type: "snapshot", snapshot });
    },
    /** One animation frame. */
    frame() {
      const due = frames.splice(0);
      for (const callback of due) callback();
    },
    /** Answer the oldest unanswered POST and let the page react. */
    async settle(status = 204, body = "") {
      const next = posts.find((post) => !post.settled);
      if (next === undefined) throw new Error("no POST in flight");
      next.settle(status, body);
      await flush();
    },
    /** Answer every POST, including the ones the answers release, until none is left. */
    async drain() {
      for (let guard = 0; guard < 50; guard += 1) {
        page.frame();
        const next = posts.find((post) => !post.settled);
        if (next === undefined) return;
        next.settle();
        await flush();
      }
      throw new Error("the page never stopped posting");
    },
    widget(caption: string): HTMLElement {
      const all = [...doc.querySelectorAll<HTMLElement>(".w")];
      const found = all.find((w) => w.querySelector(".name")?.textContent === caption);
      if (found === undefined) throw new Error(`no widget captioned ${caption}`);
      return found;
    },
    value(caption: string): string {
      const w = page.widget(caption);
      return (w.querySelector(".val") ?? w.querySelector(".state"))?.textContent ?? "";
    },
    pointer(type: string, target: EventTarget, clientX = 0, clientY = 0, pointerId = 1) {
      target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX, clientY }));
    },
    notice(): string {
      const notice = doc.getElementById("notice");
      return notice === null || notice.hidden ? "" : (notice.textContent ?? "");
    },
    status(): string {
      const status = doc.getElementById("status");
      return status === null || status.hidden ? "" : (status.textContent ?? "");
    },
  };
  return page;
}

const SNAPSHOT: PhoneSnapshot = {
  seq: 5,
  panels: [
    {
      title: "Stage",
      rows: [
        { kind: "heading", text: "Look" },
        { kind: "text", text: "Drive the bloom from the floor." },
        {
          kind: "widgets",
          widgets: [
            { kind: "slider", handle: "h-bloom", caption: "Bloom", value: 0.25, min: 0, max: 1, step: 0 },
            { kind: "slider", handle: "h-steps", caption: "Steps", value: 4, min: 0, max: 10, step: 2 },
          ],
        },
        {
          kind: "widgets",
          widgets: [
            { kind: "toggle", handle: "h-strobe", caption: "Strobe", on: false },
            { kind: "button", handle: "h-flash", caption: "Flash", held: false },
          ],
        },
        { kind: "widgets", widgets: [{ kind: "xyPad", handle: "h-center", caption: "Center", x: 0, y: 0, min: -1, max: 1 }] },
      ],
    },
  ],
};

/** The snapshot with one widget's fields replaced — what the page publishes after a write. */
function withWidget(seq: number, handle: string, fields: Record<string, number | boolean>): PhoneSnapshot {
  return {
    seq,
    panels: SNAPSHOT.panels.map((panel) => ({
      ...panel,
      rows: panel.rows.map((row) =>
        row.kind === "widgets"
          ? { ...row, widgets: row.widgets.map((w) => (w.handle === handle ? ({ ...w, ...fields } as typeof w) : w)) }
          : row,
      ),
    })),
  };
}

function track(page: ReturnType<typeof openPage>, caption: string): HTMLElement {
  const control = page.widget(caption).querySelector<HTMLElement>(".ctl");
  if (control === null) throw new Error(`${caption} has no control`);
  return control;
}

describe("T1396b phone page — the document the helper serves", () => {
  it("is one self-contained document: nothing fetched from anywhere but its own two endpoints", () => {
    const html = phonePageHtml();
    // An external script, font or stylesheet would be a request the LAN door cannot answer.
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect([...html.matchAll(/\bhref\s*=\s*"([^"]*)"/gi)].map((m) => m[1])).toEqual(["data:,"]);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(html).toContain("env(safe-area-inset-bottom)");
  });

  it("sends the token from its own URL on both endpoints, and nowhere else", async () => {
    const page = openPage();
    expect(page.source.url).toBe(`${PHONE_EVENTS_PATH}?t=${TOKEN}`);
    page.snapshot(SNAPSHOT);
    track(page, "Strobe").click();
    expect(page.posts.map((post) => post.url)).toEqual([`${PHONE_SET_PATH}?t=${TOKEN}`]);
    await page.drain();
    expect(page.otherRequests).toEqual([]);
  });

  it("draws every row of a snapshot: headings, text, and each widget with its caption and value", () => {
    const page = openPage();
    expect(page.doc.getElementById("panels")?.textContent).toContain("Connecting");
    page.snapshot(SNAPSHOT);
    expect(page.doc.querySelector(".panel h1")?.textContent).toBe("Stage");
    expect(page.doc.querySelector(".panel h2")?.textContent).toBe("Look");
    expect(page.doc.querySelector(".panel p")?.textContent).toBe("Drive the bloom from the floor.");
    expect([...page.doc.querySelectorAll(".w")].map((w) => w.className)).toEqual([
      "w slider",
      "w slider",
      "w toggle",
      "w button",
      "w xyPad",
    ]);
    expect(page.value("Bloom")).toBe("0.25");
    expect(page.value("Steps")).toBe("4.00");
    expect(track(page, "Bloom").getAttribute("aria-valuenow")).toBe("0.25");
    expect(page.value("Strobe")).toBe("Off");
    expect(page.value("Flash")).toBe("Press");
    expect(page.value("Center")).toBe("0.00, 0.00");
    // Two sliders share one row element: side by side when the screen is wide enough.
    expect(page.doc.querySelectorAll(".row")[0]?.children.length).toBe(2);
  });

  it("ignores a snapshot older than the one it shows", () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    page.snapshot(withWidget(4, "h-bloom", { value: 0.9 }));
    expect(page.value("Bloom")).toBe("0.25");
    page.snapshot(withWidget(6, "h-bloom", { value: 0.9 }));
    expect(page.value("Bloom")).toBe("0.90");
  });

  it("a slider drag posts at most one live write per frame, one at a time, latest value only, then commits the final value", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const bloom = track(page, "Bloom");
    page.pointer("pointerdown", bloom, 50);
    page.pointer("pointermove", bloom, 60);
    page.pointer("pointermove", bloom, 80);
    expect(page.posts).toHaveLength(0); // nothing leaves between frames
    page.frame();
    expect(page.posts.map((p) => p.set)).toEqual([{ handle: "h-bloom", values: { value: 0.4 }, phase: "live" }]);

    // The first write is still out: frames pass, the finger moves, nothing else is sent.
    page.pointer("pointermove", bloom, 100);
    page.frame();
    page.pointer("pointermove", bloom, 120);
    page.frame();
    expect(page.posts).toHaveLength(1);
    await page.settle();
    // Only the latest of the values held back goes out, not a backlog.
    expect(page.posts.map((p) => p.set.values)).toEqual([{ value: 0.4 }, { value: 0.6 }]);

    page.pointer("pointermove", bloom, 150);
    page.pointer("pointerup", bloom, 260); // past the end: clamped
    await page.drain();
    const sent = page.posts.map((p) => p.set);
    expect(page.maxOpen).toBe(1);
    expect(sent.at(-1)).toEqual({ handle: "h-bloom", values: { value: 1 }, phase: "commit" });
    expect(sent.filter((s) => s.phase === "commit")).toHaveLength(1);
    expect(page.value("Bloom")).toBe("1.00");
  });

  it("a stepped slider snaps to its step and clamps to its range", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const steps = track(page, "Steps");
    page.pointer("pointerdown", steps, 110); // 5.5 → 6
    page.frame();
    page.pointer("pointerup", steps, -40); // below min → 0
    await page.drain();
    expect(page.posts.map((p) => [p.set.phase, p.set.values["value"]])).toEqual([
      ["live", 6],
      ["commit", 0],
    ]);
  });

  it("a button is held:true live on down and held:false commit on up — even a tap faster than a frame", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const flash = track(page, "Flash");
    page.pointer("pointerdown", flash);
    page.frame();
    expect(page.value("Flash")).toBe("Held");
    page.pointer("pointerup", flash);
    await page.drain();
    // A tap with no frame between down and up: the press must still reach the page.
    page.pointer("pointerdown", flash, 0, 0, 2);
    page.pointer("pointercancel", flash, 0, 0, 2);
    await page.drain();
    expect(page.posts.map((p) => p.set)).toEqual([
      { handle: "h-flash", values: { held: true }, phase: "live" },
      { handle: "h-flash", values: { held: false }, phase: "commit" },
      { handle: "h-flash", values: { held: true }, phase: "live" },
      { handle: "h-flash", values: { held: false }, phase: "commit" },
    ]);
  });

  it("a toggle tap is exactly one commit of the flipped state", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    track(page, "Strobe").click();
    await page.drain();
    expect(page.posts.map((p) => p.set)).toEqual([{ handle: "h-strobe", values: { on: true }, phase: "commit" }]);
    expect(page.value("Strobe")).toBe("On");
  });

  it("an XY pad writes x and y together, y up, in its range", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const pad = track(page, "Center");
    page.pointer("pointerdown", pad, 150, 50);
    page.frame();
    page.pointer("pointerup", pad, 0, 200);
    await page.drain();
    expect(page.posts.map((p) => p.set)).toEqual([
      { handle: "h-center", values: { x: 0.5, y: 0.5 }, phase: "live" },
      { handle: "h-center", values: { x: -1, y: -1 }, phase: "commit" },
    ]);
  });

  it("a snapshot arriving mid-drag does not pull the control from under the finger", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const bloom = track(page, "Bloom");
    page.pointer("pointerdown", bloom, 180);
    page.frame();
    // The page republishes with a Bloom that is not the finger's (the live write not yet applied).
    page.snapshot(withWidget(6, "h-bloom", { value: 0.1 }));
    expect(page.value("Bloom")).toBe("0.90");
    expect(track(page, "Bloom").getAttribute("aria-valuenow")).toBe("0.9");
    page.pointer("pointerup", bloom, 180);
    await page.drain();
    // Acknowledged: the next snapshot is the truth again, whatever it says.
    page.snapshot(withWidget(7, "h-bloom", { value: 0.3 }));
    expect(page.value("Bloom")).toBe("0.30");
  });

  it("the other snapshot fields still land while one control is held", () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    page.pointer("pointerdown", track(page, "Bloom"), 180);
    page.snapshot(withWidget(6, "h-steps", { value: 8 }));
    expect(page.value("Steps")).toBe("8.00");
    expect(page.value("Bloom")).toBe("0.90");
  });

  it("`closed` shows the reason, closes the stream and sends nothing more", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    page.emit({ type: "closed", reason: "Loom closed the phone door." });
    expect(page.notice()).toBe("Loom closed the phone door.");
    expect(page.source.closed).toBe(true);
    track(page, "Strobe").click();
    page.pointer("pointerdown", track(page, "Bloom"), 100);
    page.frame();
    expect(page.posts).toHaveLength(0);
    expect(page.sources).toHaveLength(1); // no reconnect of its own
  });

  it("a 403 says the link expired and stops the page", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    track(page, "Strobe").click();
    await page.settle(403, "forbidden");
    expect(page.notice()).toBe(PHONE_EXPIRED_SENTENCE);
    expect(page.source.closed).toBe(true);
    track(page, "Strobe").click();
    expect(page.posts).toHaveLength(1);
  });

  it("any other refusal shows the server's sentence and the page keeps working", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    track(page, "Strobe").click();
    await page.settle(409, "That control is no longer published.");
    expect(page.notice()).toBe("That control is no longer published.");
    track(page, "Strobe").click();
    expect(page.posts).toHaveLength(2);
  });

  it("a lost connection is a status line, cleared when the stream is back", () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    page.source.readyState = 0;
    page.source.onerror?.();
    expect(page.status()).toContain("reconnecting");
    // Non-blocking: the controls are still there and still live.
    expect(page.doc.querySelectorAll(".w")).toHaveLength(5);
    page.source.readyState = 1;
    page.source.onopen?.();
    expect(page.status()).toBe("");
  });
});
