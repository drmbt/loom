import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

import {
  PHONE_EXPIRED_SENTENCE,
  PHONE_NAME_STORAGE_KEY,
  PHONE_PAGE_LOGIC,
  PHONE_PAGE_STORAGE_KEY,
  PHONE_TAB_STORAGE_KEY,
  PHONE_TRIAL_STORAGE_KEY,
  phonePageHtml,
} from "./phone-page.ts";
import { cueListBoardLayout, layerBoardLayout, presetStripGrid } from "../../editor/controls/board-fit.ts";
import {
  PHONE_EVENTS_PATH,
  PHONE_SET_PATH,
  PHONE_SIGNAL_PATH,
  PHONE_WRITABLE_KEYS,
  type BoardRect,
  type PhoneEvent,
  type PhoneSet,
  type PhoneSignalToPhone,
  type PhoneSnapshot,
} from "./phone-protocol.ts";

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
  Event: typeof Event;
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

const PHONE_ID = "ph-1";

/*
 * T1397b — the phone's camera and WebRTC, faked at the page's own globals like the network
 * above: what is asserted is what the phone would put on the wire (the signal POSTs) and
 * what it hands its peer connection (the page's answer and candidates).
 */
class FakeTrack {
  stopped = false;
  readonly facing: string;
  constructor(facing: string) {
    this.facing = facing;
  }
  stop(): void {
    this.stopped = true;
  }
  getSettings(): { width: number; height: number } {
    return { width: 1280, height: 720 };
  }
}

class FakeStream {
  readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakePeer {
  readonly added: FakeTrack[] = [];
  readonly replaced: FakeTrack[] = [];
  readonly remoteIce: unknown[] = [];
  closed = false;
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly config: unknown;
  constructor(config: unknown) {
    this.config = config;
  }
  addTrack(track: FakeTrack): void {
    this.added.push(track);
  }
  getSenders(): Array<{ replaceTrack(track: FakeTrack): Promise<void> }> {
    return [{ replaceTrack: (track) => (this.replaced.push(track), Promise.resolve()) }];
  }
  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: "offer", sdp: "OFFER-SDP" });
  }
  setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description;
    return Promise.resolve();
  }
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }
  addIceCandidate(candidate: unknown): Promise<void> {
    this.remoteIce.push(candidate);
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
  }
  /** The browser found a local candidate. */
  candidate(candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }): void {
    this.onicecandidate?.({ candidate });
  }
  state(next: string): void {
    this.connectionState = next;
    this.onconnectionstatechange?.();
  }
}

interface CameraOptions {
  /** Leave the camera API off the page (an insecure context, an old browser). */
  readonly none?: boolean;
  /** What `getUserMedia` does; default: a fresh one-track stream. */
  readonly open?: (constraints: unknown) => Promise<FakeStream>;
  readonly userAgent?: string;
}

/**
 * T1526b: jsdom lays nothing out, so a test of the cue list's own scrolling says what the
 * browser would have measured — every cue row `row` px tall and `pitch` px apart, in a list
 * `list` px tall (and 0 while its tab is hidden, as a list with no box is).
 */
interface CueLayout {
  readonly row: number;
  readonly pitch: number;
  readonly list: number;
}

function openPage(
  options: {
    hello?: boolean;
    camera?: CameraOptions;
    storage?: Record<string, string>;
    cueLayout?: CueLayout;
    /** T1647b trial: the Touch mode this phone has chosen (a key of TOUCH_MODES). Default: none chosen, so the page's own default. */
    touch?: string;
    /** T1647b trial: the row height this phone has chosen, px. */
    rows?: number;
  } = {},
) {
  const frames: (() => void)[] = [];
  /** T1526b: the page's own timers (its notice, a refusal's few seconds), run by `elapse`. */
  let timers: Array<{ id: number; at: number; callback: () => void }> = [];
  let now = 0;
  let timerIds = 0;
  const posts: Post[] = [];
  const sources: FakeEventSource[] = [];
  const otherRequests: string[] = [];
  const peers: FakePeer[] = [];
  const opened: Array<{ constraints: unknown; stream: FakeStream }> = [];
  let open = 0;
  let maxOpen = 0;
  let plays = 0;
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
      // One storage per origin across every JSDOM in this process: start each page clean.
      win.localStorage.clear();
      for (const [key, value] of Object.entries(options.storage ?? {})) win.localStorage.setItem(key, value);
      if (options.touch !== undefined || options.rows !== undefined) {
        win.localStorage.setItem(PHONE_TRIAL_STORAGE_KEY, JSON.stringify({ touch: options.touch, rows: options.rows }));
      }
      const camera = options.camera ?? {};
      if (camera.userAgent !== undefined) {
        Object.defineProperty(win.navigator, "userAgent", { value: camera.userAgent, configurable: true });
      }
      if (camera.none !== true) {
        Object.defineProperty(win.navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: (constraints: unknown) => {
              const made = camera.open
                ? camera.open(constraints)
                : Promise.resolve(new FakeStream([new FakeTrack(String(opened.length))]));
              return made.then((stream) => {
                opened.push({ constraints, stream });
                return stream;
              });
            },
          },
        });
        globals["RTCPeerConnection"] = class extends FakePeer {
          constructor(config: unknown) {
            super(config);
            peers.push(this);
          }
        };
      }
      globals["EventSource"] = class extends FakeEventSource {
        constructor(url: string) {
          super(url);
          sources.push(this);
        }
      };
      globals["requestAnimationFrame"] = (callback: () => void) => frames.push(callback);
      globals["setTimeout"] = (callback: () => void, ms = 0) => {
        timerIds += 1;
        timers.push({ id: timerIds, at: now + ms, callback });
        return timerIds;
      };
      globals["clearTimeout"] = (id: number) => {
        timers = timers.filter((timer) => timer.id !== id);
      };
      const cueLayout = options.cueLayout;
      if (cueLayout !== undefined) {
        const cueIndex = (element: Element): number =>
          element.hasAttribute("data-cue") && element.parentElement !== null ? [...element.parentElement.children].indexOf(element) : -1;
        Object.defineProperty(win.HTMLElement.prototype, "offsetTop", {
          configurable: true,
          get(this: HTMLElement) {
            return Math.max(0, cueIndex(this)) * cueLayout.pitch;
          },
        });
        Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
          configurable: true,
          get(this: HTMLElement) {
            return cueIndex(this) >= 0 ? cueLayout.row : 0;
          },
        });
        Object.defineProperty(Object.getPrototypeOf(win.HTMLElement.prototype), "clientHeight", {
          configurable: true,
          get(this: Element) {
            return this.classList.contains("cuelist") && this.closest("[hidden]") === null ? cueLayout.list : 0;
          },
        });
      }
      // jsdom has no media playback (it logs "not implemented"): count the preview's play() calls.
      (globals["HTMLMediaElement"] as typeof HTMLMediaElement).prototype.play = () => {
        plays += 1;
        return Promise.resolve();
      };
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
  if (sources[0] === undefined) throw new Error("the page opened no EventSource");
  /** The stream the page holds now; a reconnect replaces it. */
  const latest = (): FakeEventSource => {
    const last = sources.at(-1);
    if (last === undefined) throw new Error("the page opened no EventSource");
    return last;
  };

  const flush = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const page = {
    win,
    doc,
    get source() {
      return latest();
    },
    sources,
    posts,
    otherRequests,
    peers,
    opened,
    /** T1397b: every camera signal the phone posted, in order, with the URL it went to. */
    signals(): Array<{ url: string; body: unknown }> {
      return posts.filter((post) => post.url.startsWith(PHONE_SIGNAL_PATH)).map((post) => ({ url: post.url, body: post.set }));
    },
    /** Let the page's promise chains run (getUserMedia, createOffer, …). */
    flush,
    camera(id: string): HTMLElement {
      const found = doc.getElementById(id);
      if (found === null) throw new Error(`no #${id}`);
      return found;
    },
    get maxOpen() {
      return maxOpen;
    },
    /** T1517b: how often the camera preview was asked to play. */
    get plays() {
      return plays;
    },
    emit(event: PhoneEvent) {
      latest().onmessage?.({ data: JSON.stringify(event) });
    },
    /** What the helper says first on every stream: this connection's phone id. */
    hello(phone: string) {
      page.emit({ type: "hello", phone });
    },
    snapshot(snapshot: PhoneSnapshot) {
      page.emit({ type: "snapshot", snapshot });
    },
    /** One animation frame. */
    frame() {
      const due = frames.splice(0);
      for (const callback of due) callback();
    },
    /** T1526b: `ms` of the page's own clock pass; its timers that came due run, in order. */
    elapse(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) return;
        timers = timers.filter((timer) => timer !== due);
        due.callback();
      }
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
  if (options.hello !== false) page.hello(PHONE_ID);
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

/**
 * T1607b: a slider, fader or pad takes a touch once it has travelled 12 px along it, and
 * moves by the travel AFTER that — `grab` is a finger landing at (x, y) and going exactly
 * that far, so the control holds the touch at (x + 12, y) with its value untouched. Every
 * control here is a 200 px box (jsdom lays nothing out): 20 px along a slider is a tenth
 * of its range.
 *
 * T1647b: where the finger LANDS now matters. The page's default asks for the knob — within
 * 28 px of where the handle is drawn (Bloom, at 0.25 of a 200 px track: x from 22 to 78) —
 * so every `grab` in this file that is not about the landing lands there. It is then a
 * take in every mode but the ones that ask for a rest first (`take`, further down).
 */
function grab(page: ReturnType<typeof openPage>, target: HTMLElement, x: number, y = 0, pointerId = 1): void {
  page.pointer("pointerdown", target, x, y, pointerId);
  page.pointer("pointermove", target, x + 12, y, pointerId);
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

  it("sends the token from its own URL on both endpoints, and the stream's phone id on every write", async () => {
    const page = openPage();
    expect(page.source.url).toBe(`${PHONE_EVENTS_PATH}?t=${TOKEN}`);
    page.snapshot(SNAPSHOT);
    track(page, "Strobe").click();
    expect(page.posts.map((post) => post.url)).toEqual([`${PHONE_SET_PATH}?t=${TOKEN}&p=${PHONE_ID}`]);
    await page.drain();
    expect(page.otherRequests).toEqual([]);
  });

  it("sends nothing until its stream has said hello — a write with no phone id is one the helper refuses", async () => {
    const page = openPage({ hello: false });
    page.snapshot(SNAPSHOT);
    track(page, "Strobe").click();
    expect(page.posts).toHaveLength(0);
    page.hello("ph-late");
    expect(page.posts.map((post) => [post.url, post.set])).toEqual([
      [`${PHONE_SET_PATH}?t=${TOKEN}&p=ph-late`, { handle: "h-strobe", values: { on: true }, phase: "commit" }],
    ]);
  });

  /*
   * The helper answers 409 when the write names a stream it no longer has (the phone slept,
   * the stream was replaced). The page must not lose the gesture: it reconnects, waits for
   * the new id, and sends the same write again under it.
   */
  it("a 409 reconnects the stream and resends the refused write under the new phone id", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    track(page, "Strobe").click();
    const first = page.source;
    await page.settle(409, "This phone's connection to Loom is not open.");
    expect(page.sources).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(page.posts).toHaveLength(1); // held until the new stream says who it is
    page.hello("ph-2");
    await page.drain();
    expect(page.posts.map((post) => [post.url, post.set])).toEqual([
      [`${PHONE_SET_PATH}?t=${TOKEN}&p=${PHONE_ID}`, { handle: "h-strobe", values: { on: true }, phase: "commit" }],
      [`${PHONE_SET_PATH}?t=${TOKEN}&p=ph-2`, { handle: "h-strobe", values: { on: true }, phase: "commit" }],
    ]);
    // The OLD stream's events no longer move the page.
    first.onmessage?.({ data: JSON.stringify({ type: "closed", reason: "stale" }) });
    expect(page.notice()).toBe("");
  });

  it("draws every row of a snapshot: headings, text, and each widget with its caption and value", () => {
    const page = openPage();
    expect(page.doc.getElementById("panels")?.textContent).toContain("Connecting");
    page.snapshot(SNAPSHOT);
    // T1517b: the Panel's title is its tab, not a heading over its controls.
    expect([...page.doc.querySelectorAll("#tabs [role=tab]")].map((tab) => tab.textContent)).toEqual(["Stage", "Camera"]);
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
    grab(page, bloom, 38); // taken at x = 50, still 0.25
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
    const steps = track(page, "Steps"); // 4 of 0..10 in steps of 2: 20 px is one unit
    grab(page, steps, 100);
    page.pointer("pointermove", steps, 142); // 4 + 1.5 = 5.5 → 6
    page.frame();
    page.pointer("pointerup", steps, -40); // far below the start → 0
    await page.drain();
    expect(page.posts.map((p) => [p.set.phase, p.set.values["value"]])).toEqual([
      ["live", 6],
      ["commit", 0],
    ]);
  });

  /*
   * T1607b: a momentary Button on a page that scrolls. A touch on it may be the start of a
   * scroll, so touch-down sends nothing. A finger that RESTS on it holds it down (the
   * button's `held` is 1 for as long, as its node says); a quick tap is a whole press,
   * sent when the finger lifts inside the button. Either way the document sees held:true
   * then held:false, which is what counts a press.
   */
  it("a button a finger rests on is held:true once it has rested, and held:false when it lifts", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const flash = track(page, "Flash");
    page.pointer("pointerdown", flash, 10, 10);
    page.elapse(149);
    page.frame();
    expect(page.posts).toHaveLength(0);
    expect(page.value("Flash")).toBe("Press");
    page.elapse(1);
    page.frame();
    expect(page.value("Flash")).toBe("Held");
    expect(page.posts.map((p) => p.set)).toEqual([{ handle: "h-flash", values: { held: true }, phase: "live" }]);
    // Held is held: where the finger lifts does not matter, and neither does a cancel.
    page.pointer("pointerup", flash, 900, 900);
    await page.drain();
    expect(page.value("Flash")).toBe("Press");
    page.pointer("pointerdown", flash, 10, 10, 2);
    page.elapse(150);
    page.pointer("pointercancel", flash, 0, 0, 2);
    await page.drain();
    expect(page.posts.map((p) => p.set)).toEqual([
      { handle: "h-flash", values: { held: true }, phase: "live" },
      { handle: "h-flash", values: { held: false }, phase: "commit" },
      { handle: "h-flash", values: { held: true }, phase: "live" },
      { handle: "h-flash", values: { held: false }, phase: "commit" },
    ]);
  });

  it("a tap on a button is one whole press, sent on release — even a tap faster than a frame", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const flash = track(page, "Flash");
    page.pointer("pointerdown", flash, 10, 10);
    page.frame();
    expect(page.posts).toHaveLength(0); // touch-down sends nothing
    page.pointer("pointerup", flash, 12, 11);
    await page.drain();
    expect(page.posts.map((p) => p.set)).toEqual([
      { handle: "h-flash", values: { held: true }, phase: "live" },
      { handle: "h-flash", values: { held: false }, phase: "commit" },
    ]);
    // The tap's own timer is gone with it: nothing fires later.
    page.elapse(1000);
    await page.drain();
    expect(page.posts).toHaveLength(2);
  });

  it("a button under a finger that scrolls away, or lifts outside it, is never pressed", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const flash = track(page, "Flash");
    // The browser took the touch for a scroll before the finger had rested.
    page.pointer("pointerdown", flash, 10, 10);
    page.elapse(60);
    page.pointer("pointercancel", flash, 0, 0);
    // A finger that slid off the button and lifted there.
    page.pointer("pointerdown", flash, 10, 10, 2);
    page.elapse(60);
    page.pointer("pointerup", flash, 10, 260, 2);
    page.elapse(1000);
    await page.drain();
    expect(page.posts).toHaveLength(0);
    expect(page.value("Flash")).toBe("Press");
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
    const pad = track(page, "Center"); // (0, 0) of -1..1: 100 px is one unit, either way
    grab(page, pad, 80, 100); // taken at (92, 100)
    page.pointer("pointermove", pad, 142, 50); // 50 px right, 50 px UP the screen
    page.frame();
    page.pointer("pointerup", pad, -300, 400); // far left and down: both ends
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
    grab(page, bloom, 30);
    page.pointer("pointermove", bloom, 172); // 0.25 + 130 px of 200
    page.frame();
    // The page republishes with a Bloom that is not the finger's (the live write not yet applied).
    page.snapshot(withWidget(6, "h-bloom", { value: 0.1 }));
    expect(page.value("Bloom")).toBe("0.90");
    expect(track(page, "Bloom").getAttribute("aria-valuenow")).toBe("0.9");
    page.pointer("pointerup", bloom, 172);
    await page.drain();
    // Acknowledged: the next snapshot is the truth again, whatever it says.
    page.snapshot(withWidget(7, "h-bloom", { value: 0.3 }));
    expect(page.value("Bloom")).toBe("0.30");
  });

  it("the other snapshot fields still land while one control is held", () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const bloom = track(page, "Bloom");
    grab(page, bloom, 30);
    page.pointer("pointermove", bloom, 172);
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
    grab(page, track(page, "Bloom"), 30);
    page.pointer("pointermove", track(page, "Bloom"), 130);
    page.pointer("pointerdown", track(page, "Flash"), 10, 10, 2);
    page.elapse(1000);
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
    await page.settle(400, "That control is no longer published.");
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

describe("T1397b phone page — Send camera", () => {
  /** Press a camera-section button by its text. */
  const press = (page: ReturnType<typeof openPage>, text: string): void => {
    const button = [...page.camera("camera").querySelectorAll<HTMLButtonElement>("button")].find(
      (each) => each.textContent === text,
    );
    if (button === undefined) throw new Error(`no camera button "${text}"`);
    button.click();
  };
  const state = (page: ReturnType<typeof openPage>): string => page.camera("camState").textContent ?? "";
  const signal = (page: ReturnType<typeof openPage>, message: PhoneSignalToPhone): void =>
    page.emit({ type: "signal", message });
  const kinds = (page: ReturnType<typeof openPage>): string[] =>
    page.signals().map((each) => (each.body as { kind: string }).kind);

  it("opens the chosen camera, builds a LAN-only peer, and posts the offer under this phone's id and name — its candidates after it, one POST at a time", async () => {
    const page = openPage();
    const name = page.camera("camName") as HTMLInputElement;
    name.value = "  Back cam  ";
    name.dispatchEvent(new page.win.Event("change"));
    press(page, "Start camera");
    await page.flush();

    expect(page.opened.map((each) => each.constraints)).toEqual([
      { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    ]);
    const peer = page.peers[0];
    if (peer === undefined) throw new Error("no peer connection");
    // No STUN, no TURN: the stream never leaves the room, and nobody outside learns where the phone is.
    expect(peer.config).toEqual({ iceServers: [] });
    expect(peer.added).toEqual(page.opened[0]?.stream.tracks);
    // The phone found a candidate while its offer was still on the wire: it waits its turn.
    const ice = { candidate: "candidate:1 1 udp 2122260223 192.168.1.40 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    peer.candidate(ice);
    expect(page.signals()).toEqual([
      { url: `${PHONE_SIGNAL_PATH}?t=${TOKEN}&p=${PHONE_ID}`, body: { kind: "offer", sdp: "OFFER-SDP", name: "Back cam" } },
    ]);
    await page.drain();
    expect(page.signals().map((each) => each.body)).toEqual([
      { kind: "offer", sdp: "OFFER-SDP", name: "Back cam" },
      { kind: "ice", ...ice },
    ]);
    expect(page.maxOpen).toBe(1);
    // The name is the phone's own, kept for next time.
    expect(page.win.localStorage.getItem(PHONE_NAME_STORAGE_KEY)).toBe("Back cam");
    expect((page.camera("camPreview") as HTMLVideoElement).hidden).toBe(false);
    expect((page.camera("camName") as HTMLInputElement).disabled).toBe(true);
  });

  it("applies the page's answer, holds the page's candidates until it is in, and says when it is sending", async () => {
    const page = openPage();
    press(page, "Start camera");
    await page.flush();
    const peer = page.peers[0]!;
    const early = { kind: "ice", candidate: "candidate:9 1 udp 1 fd00::1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0, structure: [] as readonly string[] } as const;
    signal(page, early);
    expect(peer.remoteIce).toEqual([]);
    signal(page, { kind: "answer", sdp: "ANSWER-SDP" });
    await page.flush();
    expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "ANSWER-SDP" });
    const late = { kind: "ice", candidate: "candidate:10 1 udp 1 192.168.1.20 5001 typ host", sdpMid: "0", sdpMLineIndex: 0, structure: [] as readonly string[] } as const;
    signal(page, late);
    const strip = ({ candidate, sdpMid, sdpMLineIndex }: typeof early | typeof late) => ({ candidate, sdpMid, sdpMLineIndex });
    expect(peer.remoteIce).toEqual([strip(early), strip(late)]);
    expect(state(page)).toBe("Connecting to Loom…");
    peer.state("connected");
    expect(state(page)).toBe("Sending to Loom — 1280×720.");
  });

  it("Stop tells the page (bye), closes the connection and turns the camera off", async () => {
    const page = openPage();
    press(page, "Start camera");
    await page.flush();
    await page.drain();
    press(page, "Stop camera");
    await page.drain();
    expect(kinds(page)).toEqual(["offer", "bye"]);
    expect(page.peers[0]?.closed).toBe(true);
    expect(page.opened[0]?.stream.tracks.every((track) => track.stopped)).toBe(true);
    expect((page.camera("camPreview") as HTMLVideoElement).hidden).toBe(true);
    expect(state(page)).toBe("Not sending.");
  });

  it("Front or a new size while sending re-opens the camera and swaps the track on the SAME connection — no new offer", async () => {
    const page = openPage();
    press(page, "Start camera");
    await page.flush();
    press(page, "1080p");
    await page.flush();
    press(page, "Front");
    await page.flush();
    await page.drain();
    expect(page.opened.map((each) => each.constraints)).toEqual([
      { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: { ideal: "user" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    ]);
    expect(page.peers).toHaveLength(1);
    expect(page.peers[0]?.replaced).toEqual([page.opened[1]?.stream.tracks[0], page.opened[2]?.stream.tracks[0]]);
    // The camera that was replaced is off; the one sending is not.
    expect(page.opened.map((each) => each.stream.tracks[0]?.stopped)).toEqual([true, true, false]);
    expect(kinds(page)).toEqual(["offer"]);
    expect(page.camera("camera").querySelector('[data-facing="user"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  /*
   * The desk's Webcam asks (its Capture parameters); the phone's own buttons stay; the
   * latest choice from either end wins. A request re-opens the camera on the same
   * connection, and one it cannot meet (Require) stops the camera and tells the desk why.
   */
  it("a desk request re-points the camera — facing, size, rate, Require — on the same connection; a later button press is newer", async () => {
    const page = openPage();
    press(page, "Start camera");
    await page.flush();
    signal(page, { kind: "request", facing: "user", width: 1920, height: 1080, frameRate: 30, exact: true });
    await page.flush();
    expect(page.opened.at(-1)?.constraints).toEqual({
      video: { facingMode: { ideal: "user" }, width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { exact: 30 } },
      audio: false,
    });
    expect(page.peers).toHaveLength(1);
    expect(page.peers[0]?.replaced).toEqual([page.opened[1]?.stream.tracks[0]]);
    // The phone's buttons show what the desk chose.
    const pressed = [...page.camera("camera").querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent);
    expect(pressed).toEqual(["Front", "1080p"]);
    // An unasked member leaves the phone's own choice alone; the next button press is simply newer.
    signal(page, { kind: "request", facing: null, width: 0, height: 0, frameRate: 0, exact: false });
    await page.flush();
    press(page, "Back");
    await page.flush();
    expect(page.opened.at(-1)?.constraints).toEqual({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  });

  it("a Required size the camera cannot open stops the camera, and the bye tells the desk why", async () => {
    let calls = 0;
    const page = openPage({
      camera: {
        open: () =>
          ++calls === 1
            ? Promise.resolve(new FakeStream([new FakeTrack("first")]))
            : Promise.reject(Object.assign(new Error("no such mode"), { name: "OverconstrainedError" })),
      },
    });
    press(page, "Start camera");
    await page.flush();
    await page.drain();
    signal(page, { kind: "request", facing: null, width: 7680, height: 4320, frameRate: 0, exact: true });
    await page.flush();
    await page.drain();
    expect(page.signals().at(-1)?.body).toEqual({ kind: "bye", reason: "This phone has no camera that matches." });
    expect(page.peers[0]?.closed).toBe(true);
    expect(state(page)).toBe("This phone has no camera that matches.");
  });

  it("the page's bye, or the door closing, stops the camera and says why", async () => {
    const page = openPage();
    press(page, "Start camera");
    await page.flush();
    signal(page, { kind: "bye", reason: "The Loom tab stopped receiving." });
    expect(page.peers[0]?.closed).toBe(true);
    expect(page.opened[0]?.stream.tracks[0]?.stopped).toBe(true);
    expect(state(page)).toBe("The Loom tab stopped receiving.");

    press(page, "Start camera");
    await page.flush();
    await page.drain();
    page.emit({ type: "closed", reason: "Loom closed the phone door." });
    expect(page.peers[1]?.closed).toBe(true);
    expect(page.opened[1]?.stream.tracks[0]?.stopped).toBe(true);
    await page.drain();
    // Neither was answered with a bye of the phone's own: the page already knows.
    expect(kinds(page)).toEqual(["offer", "offer"]);
  });

  it("a new event stream (a reconnect) offers again under the new id — the page dropped the old one's camera", async () => {
    const page = openPage();
    press(page, "Start camera");
    await page.flush();
    await page.drain();
    page.hello("ph-2");
    await page.flush();
    await page.drain();
    expect(page.peers).toHaveLength(2);
    expect(page.peers[0]?.closed).toBe(true);
    // The same camera, a fresh handshake.
    expect(page.peers[1]?.added).toEqual(page.opened[0]?.stream.tracks);
    expect(page.signals().map((each) => [each.url.split("p=")[1], (each.body as { kind: string }).kind])).toEqual([
      [PHONE_ID, "offer"],
      ["ph-2", "offer"],
    ]);
  });

  it("a refused camera, and a browser with no camera API, are said in words — and nothing is sent", async () => {
    const refused = openPage({
      camera: { open: () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })) },
    });
    press(refused, "Start camera");
    await refused.flush();
    expect(state(refused)).toContain("Camera access was refused");
    expect(refused.peers).toEqual([]);

    const none = openPage({ camera: { none: true } });
    press(none, "Start camera");
    expect(state(none)).toBe("This browser cannot open a camera on this page.");
    expect(none.signals()).toEqual([]);
  });

  it("waits for its stream's hello before it can start, and names itself after the phone's model", () => {
    const early = openPage({ hello: false, camera: { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) Chrome/129" } });
    expect((early.camera("camGo") as HTMLButtonElement).disabled).toBe(true);
    expect(state(early)).toBe("Waiting for Loom…");
    expect((early.camera("camName") as HTMLInputElement).value).toBe("Pixel 8");
    early.hello("ph-9");
    expect((early.camera("camGo") as HTMLButtonElement).disabled).toBe(false);

    const agents: Array<[string, string]> = [
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15", "iPhone"],
      // A reduced agent says "K" where the model was; that names nothing.
      ["Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/129 Mobile", "Android"],
    ];
    for (const [userAgent, expected] of agents) {
      const page = openPage({ camera: { userAgent } });
      expect((page.camera("camName") as HTMLInputElement).value, userAgent).toBe(expected);
    }
  });
});

/*
 * T1517b — the phone page in tabs: one per Panel and a Camera tab, a bottom bar, so the
 * camera is one tap away instead of below every Panel; a Panel with a board (T1516b) is
 * drawn as the owner arranged it in the editor, cell for cell.
 */
describe("T1517b phone page — tabs, the board, the Camera tab", () => {
  const BOARD: PhoneSnapshot = {
    seq: 9,
    panels: [
      {
        title: "Stage",
        // A Panel with a board draws the board; these legacy rows must not appear.
        rows: [{ kind: "heading", text: "Legacy layout" }],
        board: {
          columns: 8,
          rows: 5,
          items: [
            { kind: "label", rect: { x: 0, y: 0, w: 8, h: 1 }, text: "Look" },
            {
              kind: "widget",
              rect: { x: 0, y: 1, w: 4, h: 1 },
              widget: { kind: "slider", handle: "h-bloom", caption: "Bloom", value: 0.25, min: 0, max: 1, step: 0 },
            },
            { kind: "widget", rect: { x: 4, y: 1, w: 2, h: 1 }, widget: { kind: "toggle", handle: "h-strobe", caption: "Strobe", on: false } },
            { kind: "widget", rect: { x: 6, y: 1, w: 2, h: 1 }, widget: { kind: "button", handle: "h-flash", caption: "Flash", held: false } },
            {
              kind: "widget",
              rect: { x: 5, y: 2, w: 3, h: 3 },
              widget: { kind: "xyPad", handle: "h-center", caption: "Center", x: 0, y: 0, min: -1, max: 1 },
            },
          ],
        },
      },
      {
        title: "Lights",
        rows: [
          { kind: "heading", text: "House" },
          { kind: "widgets", widgets: [{ kind: "slider", handle: "h-dim", caption: "Dim", value: 0.5, min: 0, max: 1, step: 0 }] },
        ],
      },
    ],
  };
  type Page = ReturnType<typeof openPage>;
  const tabLabels = (page: Page): string[] => [...page.doc.querySelectorAll("#tabs [role=tab]")].map((tab) => tab.textContent ?? "");
  const tab = (page: Page, label: string): HTMLElement => {
    const found = [...page.doc.querySelectorAll<HTMLElement>("#tabs [role=tab]")].find((each) => each.textContent === label);
    if (found === undefined) throw new Error(`no tab "${label}"`);
    return found;
  };
  /** What is on screen: the selected tab and each content area's visibility, by name. */
  const showing = (page: Page) => ({
    selected: [...page.doc.querySelectorAll("#tabs [aria-selected=true]")].map((each) => each.textContent),
    panels: [...page.doc.querySelectorAll<HTMLElement>("#panels section")]
      .filter((section) => !section.hidden && !page.camera("panels").hidden)
      .map((section) => section.getAttribute("aria-label")),
    camera: !page.camera("camera").hidden,
  });
  const press = (page: Page, text: string): void => {
    const button = [...page.camera("camera").querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === text);
    if (button === undefined) throw new Error(`no camera button "${text}"`);
    button.click();
  };

  it("the bottom bar has one tab per published Panel, then Camera — and Camera even before anything is published", () => {
    const page = openPage();
    // Before the first snapshot: the Panel area (connecting) and the camera, which works without it.
    expect(tabLabels(page)).toEqual(["Controls", "Camera"]);
    expect(page.doc.querySelector("#tabs")?.getAttribute("role")).toBe("tablist");
    page.snapshot(BOARD);
    expect(tabLabels(page)).toEqual(["Stage", "Lights", "Camera"]);
    // Nothing published: the Panel area says so, and the Camera tab is still there.
    page.snapshot({ seq: 10, panels: [] });
    expect(tabLabels(page)).toEqual(["Controls", "Camera"]);
    expect(page.camera("panels").textContent).toContain("Nothing is published");
    tab(page, "Camera").click();
    expect(showing(page).camera).toBe(true);
  });

  it("a tab shows its own content and nothing else", () => {
    const page = openPage();
    page.snapshot(BOARD);
    expect(showing(page)).toEqual({ selected: ["Stage"], panels: ["Stage"], camera: false });
    tab(page, "Lights").click();
    expect(showing(page)).toEqual({ selected: ["Lights"], panels: ["Lights"], camera: false });
    tab(page, "Camera").click();
    expect(showing(page)).toEqual({ selected: ["Camera"], panels: [], camera: true });
    // A republished snapshot with a new shape redraws the tabs, not the choice.
    page.snapshot({ ...BOARD, seq: 11, panels: [...BOARD.panels, { title: "Extra", rows: [] }] });
    expect(showing(page)).toEqual({ selected: ["Camera"], panels: [], camera: true });
  });

  it("the phone remembers the last tab chosen; a Panel no longer published falls back to the first tab", () => {
    const first = openPage();
    first.snapshot(BOARD);
    tab(first, "Lights").click();
    const kept = first.win.localStorage.getItem(PHONE_TAB_STORAGE_KEY);
    expect(kept).not.toBeNull();

    // Next visit: the same tab, as soon as the Panel it names arrives.
    const again = openPage({ storage: { [PHONE_TAB_STORAGE_KEY]: kept! } });
    again.snapshot(BOARD);
    expect(showing(again)).toEqual({ selected: ["Lights"], panels: ["Lights"], camera: false });

    // The camera tab is there before any snapshot is.
    const camera = openPage({ storage: { [PHONE_TAB_STORAGE_KEY]: "camera" } });
    expect(showing(camera)).toEqual({ selected: ["Camera"], panels: [], camera: true });

    // A tab whose Panel is gone: the first tab, and the choice is not overwritten by the fallback.
    const gone = openPage({ storage: { [PHONE_TAB_STORAGE_KEY]: "panel:Gone" } });
    gone.snapshot(BOARD);
    expect(showing(gone)).toEqual({ selected: ["Stage"], panels: ["Stage"], camera: false });
    expect(gone.win.localStorage.getItem(PHONE_TAB_STORAGE_KEY)).toBe("panel:Gone");
    // And the Lights Panel going away while it is shown does the same.
    again.snapshot({ seq: 12, panels: [BOARD.panels[0]!] });
    expect(showing(again)).toEqual({ selected: ["Stage"], panels: ["Stage"], camera: false });
  });

  /*
   * The board is the owner's arrangement: each control at its rect, in cells. jsdom lays
   * nothing out, so what is asserted is the grid placement the page asks the browser for —
   * 1-based grid lines, spans in cells, the column count the cell width is derived from.
   */
  it("a Panel with a board puts every control and label at its rect, on a grid of the board's columns; its legacy rows are not drawn", () => {
    const page = openPage();
    page.snapshot(BOARD);
    const stage = page.doc.querySelector<HTMLElement>('#panels section[aria-label="Stage"]')!;
    const grid = stage.querySelector<HTMLElement>(".board")!;
    expect(grid.style.getPropertyValue("--cols")).toBe("8");
    const placed = [...grid.children].map((child) => {
      const item = child as HTMLElement;
      return [item.className, item.querySelector(".name")?.textContent ?? item.textContent, item.style.gridColumn, item.style.gridRow];
    });
    expect(placed).toEqual([
      ["label", "Look", "1 / span 8", "1 / span 1"],
      ["w slider", "Bloom", "1 / span 4", "2 / span 1"],
      ["w toggle", "Strobe", "5 / span 2", "2 / span 1"],
      ["w button", "Flash", "7 / span 2", "2 / span 1"],
      ["w xyPad", "Center", "6 / span 3", "3 / span 3"],
    ]);
    expect(stage.textContent).not.toContain("Legacy layout");
    // A board's controls are the same live controls as a row's: values drawn, captions inline.
    expect(page.value("Bloom")).toBe("0.25");
    expect(page.value("Center")).toBe("0.00, 0.00");
  });

  it("a rect past the board's edge is kept on the board, not pushed off the screen", () => {
    const page = openPage();
    const slider = { kind: "slider", handle: "h-x", caption: "Wide", value: 0, min: 0, max: 1, step: 0, structure: [] as readonly string[] } as const;
    page.snapshot({
      seq: 1,
      panels: [{ title: "P", rows: [], board: { columns: 4, rows: 1, items: [{ kind: "widget", rect: { x: 6, y: 0, w: 9, h: 0 }, widget: slider }] } }],
    });
    const item = page.widget("Wide");
    expect([item.style.gridColumn, item.style.gridRow]).toEqual(["4 / span 1", "1 / span 1"]);
  });

  it("a Panel without a board still draws its rows", () => {
    const page = openPage();
    page.snapshot(BOARD);
    const lights = page.doc.querySelector<HTMLElement>('#panels section[aria-label="Lights"]')!;
    expect(lights.querySelector(".board")).toBeNull();
    expect(lights.querySelector("h2")?.textContent).toBe("House");
    expect(lights.querySelector(".row .name")?.textContent).toBe("Dim");
    expect(page.value("Dim")).toBe("0.50");
  });

  it("a slider on a board keeps the write rules: at most one live POST per frame, one in flight, the commit last", async () => {
    const page = openPage();
    page.snapshot(BOARD);
    const bloom = track(page, "Bloom");
    grab(page, bloom, 38); // taken at x = 50, at its 0.25
    page.pointer("pointermove", bloom, 80);
    expect(page.posts).toHaveLength(0);
    page.frame();
    page.pointer("pointermove", bloom, 100);
    page.frame();
    page.pointer("pointermove", bloom, 120);
    page.frame();
    expect(page.posts.map((p) => p.set)).toEqual([{ handle: "h-bloom", values: { value: 0.4 }, phase: "live" }]);
    page.pointer("pointerup", bloom, 150);
    await page.drain();
    const sent = page.posts.map((p) => p.set);
    expect(page.maxOpen).toBe(1);
    expect(sent).toEqual([
      { handle: "h-bloom", values: { value: 0.4 }, phase: "live" },
      { handle: "h-bloom", values: { value: 0.6 }, phase: "live" },
      { handle: "h-bloom", values: { value: 0.75 }, phase: "commit" },
    ]);
  });

  it("switching to a Panel while the camera sends keeps it sending — no bye, no closed connection, no stopped track — and the Camera tab says it is live", async () => {
    const page = openPage();
    page.snapshot(BOARD);
    tab(page, "Camera").click();
    press(page, "Start camera");
    await page.flush();
    await page.drain();
    const peer = page.peers[0]!;
    peer.state("connected");
    const dot = (): HTMLElement => page.doc.querySelector<HTMLElement>("#tabs .dot")!;
    expect([dot().hidden, dot().classList.contains("live")]).toEqual([false, true]);

    tab(page, "Stage").click();
    // A snapshot of a new shape redraws every tab while the camera runs.
    page.snapshot({ ...BOARD, seq: 13, panels: [...BOARD.panels, { title: "Extra", rows: [] }] });
    track(page, "Strobe").click();
    await page.drain();
    expect(showing(page)).toEqual({ selected: ["Stage"], panels: ["Stage"], camera: false });
    expect(page.signals().map((each) => (each.body as { kind: string }).kind)).toEqual(["offer"]);
    expect(peer.closed).toBe(false);
    expect(page.opened[0]?.stream.tracks[0]?.stopped).toBe(false);
    expect([dot().hidden, dot().classList.contains("live")]).toEqual([false, true]);

    tab(page, "Camera").click();
    expect((page.camera("camPreview") as HTMLVideoElement).hidden).toBe(false);
    expect(page.camera("camGo").textContent).toBe("Stop camera");
  });

  /*
   * iOS may pause a <video> that was out of view and not resume it on its own: the camera
   * still sends, but the phone's own preview freezes. Coming back to the Camera tab while
   * sending asks the preview to play — once per return, not on every redraw.
   */
  it("coming back to the Camera tab while sending resumes the preview — once, and not when the camera is off", async () => {
    const page = openPage();
    page.snapshot(BOARD);
    tab(page, "Camera").click();
    tab(page, "Stage").click();
    tab(page, "Camera").click();
    expect(page.plays).toBe(0); // nothing to resume: the camera is off

    press(page, "Start camera");
    await page.flush();
    await page.drain();
    tab(page, "Stage").click();
    tab(page, "Camera").click();
    expect(page.plays).toBe(1);
    // Already showing: a tap on its own tab, or a redraw of the tabs, is not a return.
    tab(page, "Camera").click();
    page.snapshot({ ...BOARD, seq: 14, panels: [...BOARD.panels, { title: "Extra", rows: [] }] });
    expect(page.plays).toBe(1);
  });

  /*
   * A board slider draws its caption and value inside the bar, and the handle line runs
   * under them: each sits on a chip of the page's ground colour, on a layer above the
   * track, so the line never cuts through the digits. jsdom paints nothing, so what is
   * asserted is the style the browser is given for the text.
   */
  it("a board slider's caption and value sit on a ground-coloured chip, a layer above the handle", () => {
    const page = openPage();
    page.snapshot(BOARD);
    const slider = page.widget("Bloom");
    for (const part of [".val", ".name"]) {
      const style = page.win.getComputedStyle(slider.querySelector(part)!);
      expect(style.backgroundColor, part).toContain("var(--bg-void)");
      expect(style.paddingLeft, part).toBe("6px");
    }
    expect(page.win.getComputedStyle(slider.querySelector(".cap")!).zIndex).toBe("1");
    expect(page.win.getComputedStyle(slider.querySelector(".track")!).zIndex).not.toBe("1");
  });
});

/**
 * T1503b (§T1398b ruling 12) — A BANK, A LAYER AND A CUE LIST ON THE PHONE PAGE, as the
 * person holding the phone meets them: a strip of preset buttons, a layer's switch and
 * fader, GO and BACK with where the set is. What is asserted is what the phone puts on the
 * wire for each touch, and what it shows — which for a recall and a GO is what LOOM says
 * happened, never what the finger hoped.
 */
describe("T1503b phone page — banks, layers and cue lists", () => {
  type Page = ReturnType<typeof openPage>;
  type Widget = Extract<PhoneSnapshot["panels"][number]["board"], object>["items"][number];
  const LOOKS = { kind: "preset", handle: "h-looks", caption: "looks", presets: ["soft", "hard", "strobe"], current: "soft", morphing: false, structure: [] as readonly string[] } as const;
  const FX = { kind: "layer", handle: "h-fx", caption: "fx", on: true, opacity: 0.5, opacityWritable: true, picture: "", structure: [] as readonly string[] } as const;
  const KEY = { kind: "layer", handle: "h-key", caption: "key", on: false, opacity: 1, opacityWritable: true, picture: "", structure: [] as readonly string[] } as const;
  const SET = { kind: "cueList", handle: "h-set", caption: "set", cues: ["1", "2", "3"], notes: ["", "", ""], current: "1", next: "2", canGo: true, canBack: false, following: false, structure: [] as readonly string[] } as const;

  /** A board holding all three kinds; `over` replaces fields of a widget by handle. */
  function show(seq: number, over: Record<string, Record<string, unknown>> = {}): PhoneSnapshot {
    const item = (rect: BoardRect, widget: { handle: string }): Widget =>
      ({ kind: "widget", rect, widget: { ...widget, ...(over[widget.handle] ?? {}) } }) as Widget;
    return {
      seq,
      panels: [
        {
          title: "Show",
          rows: [],
          board: {
            columns: 8,
            rows: 6,
            items: [
              item({ x: 0, y: 0, w: 8, h: 1 }, LOOKS),
              item({ x: 0, y: 1, w: 6, h: 1 }, FX),
              item({ x: 6, y: 1, w: 2, h: 1 }, KEY),
              item({ x: 0, y: 2, w: 8, h: 4 }, SET),
            ],
          },
        },
      ],
    };
  }
  const part = (page: Page, selector: string): HTMLElement => {
    const found = page.doc.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`nothing matches ${selector}`);
    return found;
  };
  const preset = (page: Page, name: string): HTMLButtonElement => part(page, `.w.preset [data-preset="${name}"]`) as HTMLButtonElement;
  const lit = (page: Page): string[] =>
    [...page.doc.querySelectorAll<HTMLElement>(".w.preset [data-preset]")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent ?? "");
  const fading = (page: Page): string[] => [...page.doc.querySelectorAll<HTMLElement>(".w.preset .fading")].map((b) => b.textContent ?? "");
  /** The layer whose switch is captioned `caption`. */
  const layer = (page: Page, caption: string): HTMLElement => {
    const found = [...page.doc.querySelectorAll<HTMLElement>(".w.layer")].find((w) => w.querySelector(".sw .lbl")?.textContent === caption);
    if (found === undefined) throw new Error(`no layer ${caption}`);
    return found;
  };
  const cueLine = (page: Page): string => part(page, ".w.cueList .cues").textContent ?? "";
  const sets = (page: Page) => page.posts.map((post) => post.set);

  it("draws all three at their rects: the strip with the current preset lit, the switch and fader, GO, BACK and where the set is", () => {
    const page = openPage();
    page.snapshot(show(1));
    const grid = part(page, ".board");
    expect([...grid.children].map((child) => [child.className, (child as HTMLElement).style.gridColumn, (child as HTMLElement).style.gridRow])).toEqual([
      ["w preset", "1 / span 8", "1 / span 1"],
      ["w layer", "1 / span 6", "2 / span 1"],
      ["w layer", "7 / span 2", "2 / span 1"],
      ["w cueList", "1 / span 8", "3 / span 4"],
    ]);
    expect([...page.doc.querySelectorAll(".w.preset [data-preset]")].map((b) => b.textContent)).toEqual(["soft", "hard", "strobe"]);
    expect(lit(page)).toEqual(["soft"]);
    expect(fading(page)).toEqual([]);
    // fx: on, with its fader at half; key: off, and too small a rect for a fader.
    expect(layer(page, "fx").querySelector(".sw")?.getAttribute("aria-pressed")).toBe("true");
    expect(layer(page, "fx").querySelector(".sw .state")?.textContent).toBe("On");
    expect(layer(page, "fx").querySelector(".fader .val")?.textContent).toBe("0.50");
    expect(layer(page, "fx").querySelector<HTMLElement>(".fader .fill")?.style.width).toBe("50%");
    expect(layer(page, "key").querySelector(".sw .state")?.textContent).toBe("Off");
    expect(layer(page, "key").querySelector(".fader")).toBeNull();
    expect(cueLine(page)).toBe("1▸2");
    expect((part(page, ".w.cueList .go") as HTMLButtonElement).disabled).toBe(false);
    // Cue 1 is the first: there is nothing to go BACK to, and the phone does not offer it.
    expect((part(page, ".w.cueList .back") as HTMLButtonElement).disabled).toBe(true);
    expect([...page.doc.querySelectorAll(".w.cueList [data-cue]")].map((b) => b.textContent)).toEqual(["1", "2", "3"]);
  });

  it("a preset tap is exactly one commit naming the preset — and the lit button moves only when Loom says it was recalled", async () => {
    const page = openPage();
    page.snapshot(show(1));
    preset(page, "hard").click();
    expect(sets(page)).toEqual([{ handle: "h-looks", values: { recall: "hard" }, phase: "commit" }]);
    await page.drain();
    expect(sets(page)).toHaveLength(1);
    // Answered 204, but no snapshot yet: the page (not the helper) decides, so nothing has moved.
    expect(lit(page)).toEqual(["soft"]);
    page.snapshot(show(2, { "h-looks": { current: "hard" } }));
    expect(lit(page)).toEqual(["hard"]);
  });

  it("marks the preset being faded to while `morphing`, and clears the mark when the fade ends", () => {
    const page = openPage();
    page.snapshot(show(1));
    page.snapshot(show(2, { "h-looks": { current: "hard", morphing: true } }));
    expect(lit(page)).toEqual(["hard"]);
    expect(fading(page)).toEqual(["hard"]);
    page.snapshot(show(3, { "h-looks": { current: "hard", morphing: false } }));
    expect(lit(page)).toEqual(["hard"]);
    expect(fading(page)).toEqual([]);
  });

  it("two presets tapped in a hurry are two commits, in order, one in flight at a time", async () => {
    const page = openPage();
    page.snapshot(show(1));
    preset(page, "hard").click();
    preset(page, "strobe").click();
    await page.drain();
    expect(page.maxOpen).toBe(1);
    expect(sets(page)).toEqual([
      { handle: "h-looks", values: { recall: "hard" }, phase: "commit" },
      { handle: "h-looks", values: { recall: "strobe" }, phase: "commit" },
    ]);
  });

  it("a bank that gains a preset gets its button", () => {
    const page = openPage();
    page.snapshot(show(1));
    page.snapshot(show(2, { "h-looks": { presets: ["soft", "hard", "strobe", "wash"] } }));
    expect([...page.doc.querySelectorAll(".w.preset [data-preset]")].map((b) => b.textContent)).toEqual(["soft", "hard", "strobe", "wash"]);
    expect(lit(page)).toEqual(["soft"]);
  });

  it("a layer's switch sends the STATE it now shows — off, then on — one commit a tap", async () => {
    const page = openPage();
    page.snapshot(show(1));
    const sw = layer(page, "fx").querySelector<HTMLButtonElement>(".sw")!;
    sw.click();
    expect(sw.querySelector(".state")?.textContent).toBe("Off");
    sw.click();
    expect(sw.querySelector(".state")?.textContent).toBe("On");
    await page.drain();
    expect(sets(page)).toEqual([
      { handle: "h-fx", values: { on: false }, phase: "commit" },
      { handle: "h-fx", values: { on: true }, phase: "commit" },
    ]);
  });

  it("a layer's fader keeps the slider's write rules: one live POST a frame, latest value only, the commit last", async () => {
    const page = openPage();
    page.snapshot(show(1));
    const fader = layer(page, "fx").querySelector<HTMLElement>(".fader")!;
    grab(page, fader, 88); // taken at x = 100, at its 0.5
    page.pointer("pointermove", fader, 80);
    expect(page.posts).toHaveLength(0);
    page.frame();
    page.pointer("pointermove", fader, 100);
    page.frame();
    page.pointer("pointermove", fader, 120);
    page.frame();
    expect(sets(page)).toEqual([{ handle: "h-fx", values: { opacity: 0.4 }, phase: "live" }]);
    // The finger's value shows at once, whatever the last snapshot said.
    expect(fader.querySelector(".val")?.textContent).toBe("0.60");
    page.pointer("pointerup", fader, 150);
    await page.drain();
    expect(page.maxOpen).toBe(1);
    expect(sets(page)).toEqual([
      { handle: "h-fx", values: { opacity: 0.4 }, phase: "live" },
      { handle: "h-fx", values: { opacity: 0.6 }, phase: "live" },
      { handle: "h-fx", values: { opacity: 0.75 }, phase: "commit" },
    ]);
  });

  it("a driven opacity is shown as driven and a finger on it sends nothing — the switch beside it still works", async () => {
    const page = openPage();
    page.snapshot(show(1, { "h-fx": { opacityWritable: false } }));
    const fader = layer(page, "fx").querySelector<HTMLElement>(".fader")!;
    expect(fader.querySelector(".val")?.textContent).toBe("driven");
    expect(fader.getAttribute("aria-disabled")).toBe("true");
    expect(fader.classList.contains("driven")).toBe(true);
    page.pointer("pointerdown", fader, 100);
    page.pointer("pointermove", fader, 200);
    page.frame();
    page.pointer("pointerup", fader, 200);
    await page.drain();
    expect(page.posts).toHaveLength(0);
    layer(page, "fx").querySelector<HTMLButtonElement>(".sw")!.click();
    await page.drain();
    expect(sets(page)).toEqual([{ handle: "h-fx", values: { on: false }, phase: "commit" }]);
    // Freed again at the desk: the fader takes the finger — the same drag now moves it.
    page.snapshot(show(2, { "h-fx": { opacityWritable: true, on: false } }));
    const freed = layer(page, "fx").querySelector<HTMLElement>(".fader")!;
    page.pointer("pointerdown", freed, 100);
    page.pointer("pointermove", freed, 200); // taken here, at its 0.5
    page.pointer("pointerup", freed, 220);
    await page.drain();
    expect(sets(page).at(-1)).toEqual({ handle: "h-fx", values: { opacity: 0.6 }, phase: "commit" });
  });

  it("GO and BACK are one commit each, a cue tapped in the list stands it by, and the names follow Loom's answer", async () => {
    const page = openPage();
    page.snapshot(show(1));
    const go = part(page, ".w.cueList .go") as HTMLButtonElement;
    const back = part(page, ".w.cueList .back") as HTMLButtonElement;
    go.click();
    // BACK is not on offer at the first cue: a tap on it is nothing on the wire.
    back.click();
    await page.drain();
    expect(sets(page)).toEqual([{ handle: "h-set", values: { go: true }, phase: "commit" }]);
    expect(cueLine(page)).toBe("1▸2");

    page.snapshot(show(2, { "h-set": { current: "2", next: "3", canBack: true } }));
    expect(cueLine(page)).toBe("2▸3");
    back.click();
    part(page, '.w.cueList [data-cue="1"]').click();
    await page.drain();
    expect(sets(page).slice(1)).toEqual([
      { handle: "h-set", values: { back: true }, phase: "commit" },
      { handle: "h-set", values: { standby: "1" }, phase: "commit" },
    ]);
    // The standby is marked in the list once Loom says it stands by.
    page.snapshot(show(3, { "h-set": { current: "2", next: "1", canBack: true } }));
    expect(cueLine(page)).toBe("2▸1");
    expect([...page.doc.querySelectorAll(".w.cueList [data-cue].standby")].map((b) => b.textContent)).toEqual(["1"]);
    expect([...page.doc.querySelectorAll(".w.cueList [data-cue].on")].map((b) => b.textContent)).toEqual(["2"]);

    // The end of the list with Wrap off: GO is not offered, and "next" is a dash.
    page.snapshot(show(4, { "h-set": { current: "3", next: null, canGo: false, canBack: true } }));
    expect(cueLine(page)).toBe("3▸—");
    expect(go.disabled).toBe(true);
  });

  it("T1508b: a list that follows the timeline is shown, not driven — every press off, the reason on it, and nothing on the wire", async () => {
    const page = openPage();
    page.snapshot(show(1, { "h-set": { following: true, current: "2", next: "3", canGo: false, canBack: false } }));
    const go = part(page, ".w.cueList .go") as HTMLButtonElement;
    const back = part(page, ".w.cueList .back") as HTMLButtonElement;
    const cue = part(page, '.w.cueList [data-cue="1"]') as HTMLButtonElement;
    expect(cueLine(page)).toBe("⏱ 2▸3");
    for (const button of [go, back, cue]) {
      expect(button.disabled).toBe(true);
      expect(button.title).toContain("Follows the timeline");
    }
    go.click();
    back.click();
    cue.click();
    await page.drain();
    expect(sets(page)).toEqual([]);
    // Back to live at the desk: the list is pressable again.
    page.snapshot(show(2, { "h-set": { following: false, current: "2", next: "3", canGo: true, canBack: true } }));
    expect([go.disabled, back.disabled, cue.disabled]).toEqual([false, false, false]);
    expect(cueLine(page)).toBe("2▸3");
  });

  it("§T1544b: a following list says what it switches in the structure — a note, nothing to press; live, no note", async () => {
    const page = openPage();
    page.snapshot(show(1, { "h-set": { following: true, current: "2", next: "3", canGo: false, canBack: false, structure: ["fx.on", "fx.picture"] } }));
    const note = part(page, ".w.cueList .structure");
    expect(note.textContent).toBe("⏱ Switches at its cue times: fx.on, fx.picture");
    expect(note.querySelector("button")).toBeNull();
    // A live list carries no structure, and the note is empty (hidden by `:empty`).
    page.snapshot(show(2, { "h-set": { following: false, current: "2", next: "3", canGo: true, canBack: true, structure: [] } }));
    expect(part(page, ".w.cueList .structure").textContent).toBe("");
    await page.drain();
    expect(sets(page)).toEqual([]);
  });

  it("lays each out by the desk's own rule for the rect, so the phone shows the owner's arrangement", () => {
    const rects: BoardRect[] = [
      { x: 0, y: 0, w: 2, h: 1 },
      { x: 0, y: 0, w: 4, h: 1 },
      { x: 0, y: 0, w: 6, h: 1 },
      { x: 0, y: 0, w: 2, h: 2 },
      { x: 0, y: 0, w: 8, h: 3 },
    ];
    for (const [index, rect] of rects.entries()) {
      const page = openPage();
      const at = (y: number): BoardRect => ({ ...rect, y });
      page.snapshot({
        seq: index,
        panels: [
          {
            title: "P",
            rows: [],
            board: {
              columns: 8,
              rows: 9,
              items: [
                { kind: "widget", rect: at(0), widget: FX },
                { kind: "widget", rect: at(3), widget: SET },
                { kind: "widget", rect: at(6), widget: LOOKS },
              ],
            },
          },
        ],
      });
      const where = JSON.stringify(rect);
      expect(part(page, ".w.layer").getAttribute("data-layout"), where).toBe(layerBoardLayout(rect));
      expect(part(page, ".w.cueList").getAttribute("data-layout"), where).toBe(cueListBoardLayout(rect));
      const strip = presetStripGrid(LOOKS.presets.length, rect.h);
      expect([part(page, ".w.preset").style.getPropertyValue("--rows"), part(page, ".w.preset").style.getPropertyValue("--per")], where).toEqual([
        String(strip.rows),
        String(strip.perRow),
      ]);
    }
  });

  it("every button on the three sends only a key the contract lets a phone write — there is nothing to Store with", async () => {
    const page = openPage();
    page.snapshot(show(1, { "h-set": { current: "2", next: "3", canBack: true } }));
    const kinds: Record<string, keyof typeof PHONE_WRITABLE_KEYS> = { "h-looks": "preset", "h-fx": "layer", "h-key": "layer", "h-set": "cueList" };
    const buttons = [...page.doc.querySelectorAll<HTMLButtonElement>(".w.preset button, .w.layer button, .w.cueList button")];
    expect(buttons.length).toBe(3 + 2 + 3 + 2);
    for (const button of buttons) button.click();
    await page.drain();
    expect(sets(page)).toHaveLength(buttons.length);
    for (const sent of sets(page)) {
      const allowed: readonly string[] = PHONE_WRITABLE_KEYS[kinds[sent.handle]!];
      expect(Object.keys(sent.values).every((key) => allowed.includes(key)), JSON.stringify(sent)).toBe(true);
      expect(sent.phase).toBe("commit");
    }
    expect(JSON.stringify(sets(page))).not.toMatch(/store|delete/i);
  });

  it("sends nothing from any of them once the door has closed", async () => {
    const page = openPage();
    page.snapshot(show(1));
    page.emit({ type: "closed", reason: "The door was closed at the desk." });
    preset(page, "hard").click();
    layer(page, "fx").querySelector<HTMLButtonElement>(".sw")!.click();
    (part(page, ".w.cueList .go") as HTMLButtonElement).click();
    page.frame();
    await page.flush();
    expect(page.posts).toHaveLength(0);
  });

  /**
   * T1526b — A REFUSED PRESS IS SAID ON THE PHONE THAT PRESSED, ON THE CONTROL IT PRESSED.
   * Until this, a GO past the end of the list, or a recall of a preset deleted a moment
   * ago, looked on the phone like a press that did nothing: the refusal was said at the
   * desk only. What is asserted is what the person holding the phone sees — Loom's
   * sentence, where, and for how long — and that nothing else on the board moves for it.
   */
  describe("T1526b — a refused press is said on its control", () => {
    const PAST_THE_END = 'Cue list "set": "3" is its last cue and Wrap is off; nothing was fired.';
    /** Every refusal sentence on screen: [the control's classes, the sentence]. */
    const said = (page: Page): Array<[string, string]> =>
      [...page.doc.querySelectorAll<HTMLElement>(".w > .said")].map((line) => [line.parentElement!.className, line.textContent ?? ""]);
    const refuse = (page: Page, handle: string, reason: string): void => page.emit({ type: "refused", handle, reason });
    const placed = (page: Page): string[][] =>
      [...part(page, ".board").children].map((child) => [(child as HTMLElement).style.gridColumn, (child as HTMLElement).style.gridRow]);

    it("shows Loom's sentence on the control it names, outlined, for three seconds — and no other control moves", async () => {
      const page = openPage();
      page.snapshot(show(1));
      const before = placed(page);
      (part(page, ".w.cueList .go") as HTMLButtonElement).click();
      await page.drain();
      refuse(page, "h-set", PAST_THE_END);
      expect(said(page)).toEqual([["w cueList refused", PAST_THE_END]]);
      // On the control, not in the page's notice — and that control alone is marked.
      expect(page.notice()).toBe("");
      expect(page.doc.querySelectorAll(".w.refused")).toHaveLength(1);
      const line = part(page, ".w.cueList > .said");
      expect(line.getAttribute("role")).toBe("alert");
      // Out of flow and inside its own item: the board holds the same four items at the
      // same rects, and the sentence takes no touch from the GO button it hangs near.
      const style = page.win.getComputedStyle(line);
      expect([style.position, style.pointerEvents]).toEqual(["absolute", "none"]);
      expect(placed(page)).toEqual(before);
      expect(part(page, ".board").children).toHaveLength(4);

      page.elapse(2999);
      expect(said(page)).toHaveLength(1);
      page.elapse(1);
      expect(said(page)).toEqual([]);
      expect(page.doc.querySelectorAll(".w.refused")).toHaveLength(0);
    });

    it("a newer refusal replaces the sentence and starts its own three seconds; the next press, on any control, takes every sentence away", async () => {
      const page = openPage();
      page.snapshot(show(1));
      refuse(page, "h-set", "first");
      page.elapse(2000);
      refuse(page, "h-set", "second");
      expect(said(page)).toEqual([["w cueList refused", "second"]]);
      // Two more seconds: past the FIRST sentence's end, inside the second's.
      page.elapse(2000);
      expect(said(page)).toEqual([["w cueList refused", "second"]]);
      // Another control refused meanwhile: each keeps its own sentence.
      refuse(page, "h-looks", "third");
      expect(said(page)).toEqual([
        ["w preset refused", "third"],
        ["w cueList refused", "second"],
      ]);
      // A sentence hangs over the controls below it. The next press — here on a layer's
      // switch, a control neither sentence is about — takes both away at once.
      layer(page, "key").querySelector<HTMLButtonElement>(".sw")!.click();
      expect(said(page)).toEqual([]);
      expect(page.doc.querySelectorAll(".w.refused")).toHaveLength(0);
      await page.drain();
      // And their clocks went with them: nothing comes back, nothing throws, when they would have ended.
      page.elapse(3000);
      expect(said(page)).toEqual([]);
    });

    it("stays on its control through a redraw of the board, and still ends on time", () => {
      const page = openPage();
      page.snapshot(show(1));
      refuse(page, "h-looks", "“looks” has no preset by the name a phone asked for.");
      page.elapse(1000);
      // The desk's rename arrives: a new preset list is a new strip of buttons — a rebuilt board.
      const strip = part(page, ".w.preset");
      page.snapshot(show(2, { "h-looks": { presets: ["soft", "harder", "strobe"] } }));
      expect(part(page, ".w.preset")).not.toBe(strip);
      expect(said(page)).toEqual([["w preset refused", "“looks” has no preset by the name a phone asked for."]]);
      page.elapse(2000);
      expect(said(page)).toEqual([]);
      expect(part(page, ".w.preset").classList.contains("refused")).toBe(false);
    });

    it("a refused switch goes back to what Loom holds — an answered one that was not refused keeps the finger's state", async () => {
      const page = openPage();
      page.snapshot(show(1));
      const sw = layer(page, "fx").querySelector<HTMLButtonElement>(".sw")!;
      sw.click();
      await page.drain();
      // Relayed (204) and no word from Loom yet: what the finger set stands.
      expect([sw.querySelector(".state")?.textContent, sw.getAttribute("aria-pressed")]).toEqual(["Off", "false"]);
      refuse(page, "h-fx", "A phone tried to move a control that is not published to the phone door.");
      // Nothing was written, so no snapshot will come to correct it: the page corrects itself.
      expect([sw.querySelector(".state")?.textContent, sw.getAttribute("aria-pressed")]).toEqual(["On", "true"]);
    });

    it("does not pull a fader from under a finger that is still down; the lift's refusal puts it back", async () => {
      const page = openPage();
      page.snapshot(show(1));
      const fader = layer(page, "fx").querySelector<HTMLElement>(".fader")!;
      const shown = (): string => fader.querySelector(".val")?.textContent ?? "";
      grab(page, fader, 88); // taken at x = 100, at its 0.5
      page.pointer("pointermove", fader, 150);
      page.frame();
      await page.settle();
      refuse(page, "h-fx", "“fx” has its opacity driven by the document, so a phone cannot move it.");
      expect(said(page)).toHaveLength(1);
      expect(shown()).toBe("0.75");
      // The lift is a new press: the sentence goes, and comes back with the lift's own refusal.
      page.pointer("pointerup", fader, 150);
      expect(said(page)).toEqual([]);
      await page.drain();
      refuse(page, "h-fx", "“fx” has its opacity driven by the document, so a phone cannot move it.");
      expect(said(page)).toHaveLength(1);
      expect(shown()).toBe("0.50");
    });

    it("a refusal naming nothing this page shows is the page's notice — a handle is never looked up as anything but a control", () => {
      const page = openPage();
      page.snapshot(show(1));
      // "" is what Loom sends for a write that named nothing published; the rest are what a
      // stale page (the control was unpublished since) or a hostile relay could carry.
      for (const handle of ["", "h-gone", "__proto__", "constructor", "toString"]) {
        const reason = `refused (${handle})`;
        refuse(page, handle, reason);
        expect(page.notice(), handle).toBe(reason);
        expect(said(page), handle).toEqual([]);
      }
      expect(page.doc.querySelectorAll(".w.refused")).toHaveLength(0);
    });

    it("says nothing once the door has closed", () => {
      const page = openPage();
      page.snapshot(show(1));
      page.emit({ type: "closed", reason: "The door was closed at the desk." });
      refuse(page, "h-set", PAST_THE_END);
      refuse(page, "", PAST_THE_END);
      expect(said(page)).toEqual([]);
      expect(page.notice()).toBe("The door was closed at the desk.");
    });
  });

  /**
   * T1526b — the two fields the design (§9.2) names and the first cut left out, and the
   * list that follows its standby: what a person running a set from a phone reads before
   * pressing GO — which picture a layer holds, what the operator noted on the next cue —
   * and a cue list long enough to scroll that keeps "next" on screen by itself.
   */
  describe("T1526b — a layer's picture, a cue's note, the standby in view", () => {
    it("a layer's switch names its picture and follows it — hidden where the switch is too narrow for it", () => {
      const page = openPage();
      page.snapshot(show(1, { "h-fx": { picture: "city" }, "h-key": { picture: "smoke" } }));
      const pic = (caption: string): HTMLElement => layer(page, caption).querySelector<HTMLElement>(".sw .pic")!;
      expect([pic("fx").textContent, pic("fx").hidden]).toEqual(["city", false]);
      expect(page.win.getComputedStyle(pic("fx")).display).not.toBe("none");
      // `key` is two cells wide (a switch and nothing else): no room beside its name.
      expect(page.win.getComputedStyle(pic("key")).display).toBe("none");
      // Loom points the layer at another look: the label follows, the switch is not rebuilt.
      const sw = layer(page, "fx").querySelector(".sw");
      page.snapshot(show(2, { "h-fx": { picture: "riot" } }));
      expect(layer(page, "fx").querySelector(".sw")).toBe(sw);
      expect(pic("fx").textContent).toBe("riot");
      // No picture: nothing drawn, and no gap left for it.
      page.snapshot(show(3));
      expect([pic("fx").textContent, pic("fx").hidden]).toEqual(["", true]);
    });

    it("a cue shows its note — beside its name in the list, and the standby's beside current ▸ next", () => {
      const page = openPage();
      const notes = ["", "house lights out", "bows"];
      page.snapshot(show(1, { "h-set": { notes } }));
      const note = (cue: string): string => part(page, `.w.cueList [data-cue="${cue}"] .note`).textContent ?? "";
      const standbyNote = (): string => part(page, ".w.cueList .cues .note").textContent ?? "";
      expect(["1", "2", "3"].map(note)).toEqual(notes);
      // GO fires cue 2 next: its note is the one to read before pressing.
      expect(standbyNote()).toBe("house lights out");
      page.snapshot(show(2, { "h-set": { notes, current: "2", next: "3", canBack: true } }));
      expect(standbyNote()).toBe("bows");
      // The operator rewrites a note at the desk: the phone follows.
      page.snapshot(show(3, { "h-set": { notes: ["", "house lights out", "bows, then blackout"], current: "2", next: "3", canBack: true } }));
      expect(note("3")).toBe("bows, then blackout");
      expect(standbyNote()).toBe("bows, then blackout");
      // The end of the list: no standby, no note.
      page.snapshot(show(4, { "h-set": { notes, current: "3", next: null, canGo: false, canBack: true } }));
      expect(standbyNote()).toBe("");
      // The cue's NAME is still what a tap stands by.
      expect(part(page, '.w.cueList [data-cue="2"]').getAttribute("data-cue")).toBe("2");
    });

    /*
     * Eight cues, 34 px rows 36 px apart, in a list 72 px tall (two rows show). jsdom lays
     * nothing out, so those numbers are given to it; what is asserted is the scroll offset
     * the page leaves the LIST at. The page itself is never scrolled: jsdom has no
     * `scrollIntoView` and logs `window.scrollTo`, so either would fail this file's
     * no-noise check.
     */
    const CUES = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
    const LAYOUT = { row: 34, pitch: 36, list: 72 };
    const standing = (seq: number, next: string, current = "c1"): PhoneSnapshot =>
      show(seq, { "h-set": { cues: CUES, notes: CUES.map(() => ""), current, next, canBack: true } });

    it("the cue list scrolls itself to keep the standby in view when Loom moves it — and stays where a finger left it otherwise", () => {
      const page = openPage({ cueLayout: LAYOUT });
      page.snapshot(standing(1, "c2"));
      const list = part(page, ".w.cueList .cuelist");
      // c2 is rows 36–70 of the 72 that show: in view already.
      expect(list.scrollTop).toBe(0);
      // Loom stands c6 by (180–214): scrolled just far enough that all of it shows.
      page.snapshot(standing(2, "c6"));
      expect(list.scrollTop).toBe(214 - 72);
      // And back to the first cue (0–34), above what shows.
      page.snapshot(standing(3, "c1"));
      expect(list.scrollTop).toBe(0);
      // The owner scrolls down to read ahead; a snapshot that does not move the standby
      // (cue c3 fired by name at the desk, the standby still c1) leaves the list alone.
      list.scrollTop = 100;
      page.snapshot(standing(4, "c1", "c3"));
      expect(list.scrollTop).toBe(100);
      // The next move of the standby is followed again.
      page.snapshot(standing(5, "c8", "c3"));
      expect(list.scrollTop).toBe(7 * 36 + 34 - 72);
    });

    it("a list drawn while another tab shows finds its standby when its own tab is shown", () => {
      const page = openPage({ cueLayout: LAYOUT, storage: { [PHONE_TAB_STORAGE_KEY]: "camera" } });
      page.snapshot(standing(1, "c6"));
      const list = part(page, ".w.cueList .cuelist");
      // Not laid out: there is nothing to scroll yet, and the standby is not counted as shown.
      expect(list.scrollTop).toBe(0);
      part(page, '#tabs [data-tab="panel:Show"]').click();
      expect(list.scrollTop).toBe(214 - 72);
    });
  });
});

/**
 * T1607b — SCROLL TO EVERY CONTROL WITHOUT MOVING ONE, AND PAGES. Owner: "we can still
 * scroll with touch on the page to get to all the controls without constantly accidentally
 * moving sliders". What a phone user must be able to rely on: a touch that LANDS on a
 * control changes nothing; a control moves only for a finger that travels along it, by
 * that travel; and a board's labelled sections can be shown one at a time.
 *
 * Three layers. The rules are plain functions (`PHONE_PAGE_LOGIC`), run here from the very
 * string the phone runs. What reaches the wire is asserted on the served page in jsdom.
 * What the BROWSER does with a touch that goes up the page (it scrolls, and cancels the
 * pointer) is not something jsdom has: that is `src/tests/e2e/phone-touch.spec.ts`.
 */
/**
 * B269 — A BOARD OF NARROW COLUMNS IS NEVER CRUSHED OR CLIPPED. Owner, on a real phone the
 * day a project went from eight columns to ten: "on the phone the sliders are now crunched
 * and some buttons cut off". A row was as tall as a column is wide, whatever that came to.
 *
 * jsdom lays nothing out, so what is asserted here is the rule the browser is handed for
 * each case — a row's height, where a handle sits, what a heading, a strip of presets and a
 * pad's caption do when they do not fit. That those rules produce boxes a finger can press
 * with nothing cut is asserted on real boxes in `src/tests/e2e/phone-touch.spec.ts`.
 */
describe("B269 phone page — a board of narrow columns is never crushed or clipped", () => {
  type Page = ReturnType<typeof openPage>;
  const LOOKS = ["reset_robot", "reset_scene", "reset_lights", "reset_all", "soft_amber", "hard_strobe"];
  const slider = (handle: string, caption: string, value: number) => ({ kind: "slider", handle, caption, value, min: 0, max: 1, step: 0 }) as const;
  /** Ten columns, as the project that hit this laid its panels out: on a 375 px phone a column is 30 px. */
  const NARROW: PhoneSnapshot = {
    seq: 2,
    panels: [
      {
        title: "Narrow",
        rows: [],
        board: {
          columns: 10,
          rows: 6,
          items: [
            { kind: "label", rect: { x: 0, y: 0, w: 4, h: 1 }, text: "A heading far longer than its four cells" },
            { kind: "widget", rect: { x: 0, y: 1, w: 8, h: 1 }, widget: { kind: "preset", handle: "h-looks", caption: "looks", presets: LOOKS, current: "reset_all", morphing: false } },
            { kind: "widget", rect: { x: 0, y: 2, w: 8, h: 1 }, widget: slider("h-top", "Top", 1) },
            { kind: "widget", rect: { x: 0, y: 3, w: 8, h: 1 }, widget: slider("h-foot", "Foot", 0) },
            { kind: "widget", rect: { x: 0, y: 4, w: 3, h: 1 }, widget: { kind: "toggle", handle: "h-long", caption: "Follow the track closely", on: true } },
            { kind: "widget", rect: { x: 6, y: 4, w: 2, h: 2 }, widget: { kind: "xyPad", handle: "h-pad", caption: "Chase side / height", x: 0, y: 0, min: -2, max: 2 } },
          ],
        },
      },
    ],
  };
  const part = (page: Page, selector: string): HTMLElement => {
    const found = page.doc.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`nothing matches ${selector}`);
    return found;
  };
  /** The declarations the page's stylesheet gives a selector, as written (jsdom computes no layout and knows no `max()`). */
  const rule = (page: Page, selector: string): string => {
    const css = page.doc.querySelector("style")?.textContent ?? "";
    const at = css.indexOf(`\n${selector} {`);
    if (at < 0) throw new Error(`the stylesheet has no rule for ${selector}`);
    return css.slice(at, css.indexOf("}", at));
  };

  /*
   * The floor is the owner's eye, not a guideline: 30 px rows were "crunched", 39 to 45 px
   * "a smidge too chunky", so it is 36 until he has tried 32, 36 and 44 (§T1647b). It must
   * hold on BOTH lines that size a row — the container-unit one phones use and the viewport
   * one for a browser without it — and must not replace the column width: a board of wide
   * columns keeps its square cells.
   */
  it("a board's row is as tall as its column is wide, and never lower than the floor", () => {
    const page = openPage();
    page.snapshot(NARROW);
    expect(rule(page, "body")).toContain("--row: 36px;");
    const rows = [...rule(page, ".board").matchAll(/grid-auto-rows:\s*([^;]+);/g)].map((match) => match[1] ?? "");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatch(/^max\(var\(--row\), calc\(\(100(vw|cqi) .*\/ var\(--cols\)\)\)$/);
    // The columns are the author's: ten stay ten.
    expect(part(page, ".board").style.getPropertyValue("--cols")).toBe("10");
  });

  /*
   * A row drawn 36 px tall is lower than a finger is wide. So what a finger can HIT is more
   * than what is drawn: half the gap all round a control answers too, which makes a hit area
   * of the row plus the gap and leaves no dead strip between two controls — and no overlap,
   * each taking its own half. The margin belongs to the board ITEM, so a touch there has the
   * item as its target, and the item hands it to its control.
   */
  it("a control answers from half the gap round it: a tap there flips a toggle, a touch there takes a slider", async () => {
    // "now": the one Touch mode left where a pad owns every touch on it (§T1647b).
    const page = openPage({ touch: "now" });
    page.snapshot(NARROW);
    expect(rule(page, "body")).toContain("--gap: 6px;");
    expect(rule(page, ".board .w.slider::before, .board .w.toggle::before, .board .w.button::before, .board .w.xyPad::before")).toContain(
      "inset: calc(var(--gap) / -2);",
    );
    // A scroll must still start from a slider's margin, and a pad's is the pad's.
    expect(page.win.getComputedStyle(page.widget("Top")).touchAction).toBe("pan-y");
    expect(page.win.getComputedStyle(page.widget("Chase side / height")).touchAction).toBe("none");

    const toggle = page.widget("Follow the track closely");
    toggle.dispatchEvent(new page.win.MouseEvent("click", { bubbles: true }));
    await page.drain();
    expect(page.posts.map((post) => post.set)).toEqual([{ handle: "h-long", values: { on: false }, phase: "commit" }]);

    // The item's own margin, not its control: the same drag as from the track.
    const foot = page.widget("Foot");
    page.pointer("pointerdown", foot, 0, 0);
    page.pointer("pointermove", foot, 12, 0);
    page.pointer("pointermove", foot, 52, 0);
    page.pointer("pointerup", foot, 52, 0);
    await page.drain();
    expect(page.posts.at(-1)?.set).toEqual({ handle: "h-foot", values: { value: 0.2 }, phase: "commit" });
  });

  it("a momentary button is pressed by a tap that lifts within its reach, three pixels past what is drawn, and no further", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const flash = track(page, "Flash"); // drawn 0..200, as every box is here
    page.pointer("pointerdown", flash, 100, 100);
    page.pointer("pointerup", flash, 100, 204);
    await page.drain();
    expect(page.posts).toHaveLength(0);
    page.pointer("pointerdown", flash, 100, 100, 2);
    page.pointer("pointerup", flash, 100, 203, 2);
    await page.drain();
    expect(page.posts.map((post) => post.set.values)).toEqual([{ held: true }, { held: false }]);
  });

  it("a press in the margin above or below a preset button recalls THAT preset, not its neighbour", async () => {
    const page = openPage();
    page.snapshot(NARROW);
    const strip = part(page, ".w.preset > .strip");
    // Six buttons 48 px wide, side by side, drawn from y = 3 to y = 39 inside a strip that reaches from 0 to 42.
    [...strip.children].forEach((button, index) => {
      (button as HTMLElement).getBoundingClientRect = () => ({ left: index * 50, right: index * 50 + 48, top: 3, bottom: 39, width: 48, height: 36, x: index * 50, y: 3 }) as DOMRect;
    });
    const press = (clientX: number, clientY: number): boolean => strip.dispatchEvent(new page.win.MouseEvent("click", { bubbles: true, clientX, clientY }));
    press(120, 1); // above the third
    press(270, 41); // below the sixth
    press(120, 60); // well below the strip: nobody's
    await page.drain();
    expect(page.posts.map((post) => post.set)).toEqual([
      { handle: "h-looks", values: { recall: "reset_lights" }, phase: "commit" },
      { handle: "h-looks", values: { recall: "hard_strobe" }, phase: "commit" },
    ]);
    expect(rule(page, ".board .w.preset > .strip")).toContain("inset: calc(var(--gap) / -2) 0;");
  });

  /*
   * Two things a desktop browser's phone emulation does not show and an iPhone does; both
   * are fixed from the documentation and wait for the owner's phone.
   *  - 100vh is the viewport with Safari's bars away, taller than what shows while they are
   *    there; 100dvh is what shows now. The vh line stays first, for a browser without dvh.
   *  - Safari before 16 has no container queries. The toggle's state line used to be HIDDEN
   *    by one where the button is low, so there it showed — two lines in a one-row button,
   *    cut off top and bottom. Now it is hidden unless a container query shows it.
   */
  it("the page is as tall as what shows now, and a toggle's second line shows only where a container query makes room", () => {
    const page = openPage();
    page.snapshot(NARROW);
    expect([...rule(page, "body").matchAll(/min-height:\s*([^;]+);/g)].map((match) => match[1])).toEqual(["100vh", "100dvh"]);
    const state = part(page, ".w.toggle button.ctl .state");
    expect(state.textContent).toBe("On");
    expect(page.win.getComputedStyle(state).display).toBe("none");
    const css = page.doc.querySelector("style")?.textContent ?? "";
    expect(css).toContain("@container (min-height: 47px) { .board .w > button.ctl .state { display: block; } }");
    expect(css).not.toMatch(/@container \(max-height/);
    // Outside a board a button has its own 56 px: both lines, always.
    page.snapshot(SNAPSHOT);
    expect(page.win.getComputedStyle(part(page, ".w.toggle button.ctl .state")).display).toBe("block");
  });

  it("a slider's handle is whole at both ends of its track: moved back by its own share of its width", () => {
    const page = openPage();
    page.snapshot(NARROW);
    const handle = (caption: string): string[] => {
      const thumb = page.widget(caption).querySelector<HTMLElement>(".thumb")!;
      return [thumb.style.left, thumb.style.transform];
    };
    expect(handle("Top")).toEqual(["100%", "translateX(-100%)"]);
    expect(handle("Foot")).toEqual(["0%", "translateX(-0%)"]);
    // No fixed pull to the left any more: that was what hung half the handle outside the track.
    expect(rule(page, ".thumb")).not.toContain("margin-left");
  });

  it("a heading that does not fit its cell ends in an ellipsis on one line", () => {
    const page = openPage();
    page.snapshot(NARROW);
    const heading = part(page, ".board .label");
    expect(heading.textContent).toBe("A heading far longer than its four cells");
    // The text is in a box of its own: bare text in the heading's flex box wraps, and is cut at the top.
    expect([...heading.childNodes].map((node) => node.nodeName)).toEqual(["SPAN"]);
    const style = page.win.getComputedStyle(heading.firstElementChild!);
    expect([style.whiteSpace, style.overflow, style.textOverflow]).toEqual(["nowrap", "hidden", "ellipsis"]);
  });

  /*
   * A preset is recalled by its name. Six buttons squeezed into one row all read "res…":
   * so a button is at least its name wide, and the STRIP scrolls sideways. The strip is a
   * box inside the item, because the item must not clip — Loom's sentence for a refused
   * recall hangs under it (§T1526b).
   */
  it("a strip of more presets than its row holds scrolls sideways with every name whole, and still shows a refusal under it", () => {
    const page = openPage();
    page.snapshot(NARROW);
    const item = part(page, ".w.preset");
    const strip = part(page, ".w.preset > .strip");
    expect([...strip.children].map((button) => button.textContent)).toEqual(LOOKS);
    // The desk's arrangement still: one row of six.
    expect([item.style.getPropertyValue("--rows"), item.style.getPropertyValue("--per")]).toEqual(["1", "6"]);
    const strips = rule(page, ".board .w.preset > .strip");
    expect(strips).toContain("grid-template-columns: repeat(var(--per), minmax(min-content, 1fr));");
    expect(strips).toContain("overflow-x: auto;");
    expect(page.win.getComputedStyle(strip.firstElementChild!).minWidth).toBe("var(--row)");
    // The item clips nothing, and the sentence is the item's child, not the strip's.
    expect(page.win.getComputedStyle(item).overflow).not.toBe("hidden");
    page.emit({ type: "refused", handle: "h-looks", reason: "“looks” has no preset by that name." });
    expect(part(page, ".w.preset > .said").textContent).toBe("“looks” has no preset by that name.");
  });

  it("a toggle's caption ends in an ellipsis inside its button; a pad's caption gets the pad's whole width before it does", () => {
    const page = openPage();
    page.snapshot(NARROW);
    const name = page.win.getComputedStyle(part(page, ".w.toggle button.ctl .name"));
    expect([name.whiteSpace, name.overflow, name.textOverflow, name.maxWidth]).toEqual(["nowrap", "hidden", "ellipsis", "100%"]);
    const caption = page.win.getComputedStyle(part(page, ".w.xyPad > .cap"));
    expect(caption.flexWrap).toBe("wrap");
    expect(page.win.getComputedStyle(part(page, ".w.xyPad > .cap .name")).textOverflow).toBe("ellipsis");
  });
});

describe("T1607b phone page — the gesture and paging rules, as the phone runs them", () => {
  interface Cell {
    readonly label: string | null;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  }
  interface PageBox {
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly cells: readonly number[];
  }
  interface Logic {
    readonly SLOP: number;
    claims(axes: "x" | "xy", dx: number, dy: number): boolean;
    nudge(value: number, travel: number, length: number, min: number, max: number): number;
    settle(value: number, step: number, min: number, max: number): number;
    pagesOf(cells: readonly Cell[]): PageBox[];
  }
  const logic = runInNewContext(`${PHONE_PAGE_LOGIC}; ({ SLOP: SLOP, claims: claims, nudge: nudge, settle: settle, pagesOf: pagesOf })`) as Logic;
  /** Pages as plain data of this realm (the functions ran in another). */
  const pagesOf = (cells: readonly Cell[]): PageBox[] => JSON.parse(JSON.stringify(logic.pagesOf(cells))) as PageBox[];
  const label = (name: string, x: number, y: number, w: number): Cell => ({ label: name, x, y, w, h: 1 });
  const control = (x: number, y: number, w: number, h = 1): Cell => ({ label: null, x, y, w, h });

  /*
   * A browser decides a touch is a scroll once it has moved about 8 px (Android) or 10 px
   * (iOS). A slider that started before that could start and THEN be cancelled — a write
   * the hand did not mean. So the slider's own threshold must stay above both.
   */
  it("a slider waits longer than the browser does to decide a touch is a scroll", () => {
    expect(logic.SLOP).toBeGreaterThan(10);
    // ...and not so long that a deliberate drag feels dead: under a fingertip's width.
    expect(logic.SLOP).toBeLessThanOrEqual(16);
  });

  it("a slider takes a touch that has gone along it, never one going up or down the page", () => {
    expect(logic.claims("x", logic.SLOP - 1, 0)).toBe(false);
    expect(logic.claims("x", logic.SLOP, 0)).toBe(true);
    expect(logic.claims("x", -logic.SLOP, 0)).toBe(true);
    // A flick up the page wobbles sideways; however far it wobbles, it went further up.
    expect(logic.claims("x", 30, -200)).toBe(false);
    expect(logic.claims("x", -60, 61)).toBe(false);
    // A tie is the browser's: Chromium scrolls unless the travel across is the larger.
    expect(logic.claims("x", 20, 20)).toBe(false);
    expect(logic.claims("x", 21, -20)).toBe(true);
  });

  it("an XY pad owns both axes: any travel past the slop is its own", () => {
    expect(logic.claims("xy", 0, logic.SLOP)).toBe(true);
    expect(logic.claims("xy", 0, -logic.SLOP)).toBe(true);
    expect(logic.claims("xy", 8, 8)).toBe(false); // 11.3 px
    expect(logic.claims("xy", 9, -9)).toBe(true); // 12.7 px
  });

  it("a drag moves a value by the finger's travel over the track, and stops at the ends without remembering the overshoot", () => {
    expect(logic.nudge(0.25, 40, 200, 0, 1)).toBeCloseTo(0.45, 12);
    expect(logic.nudge(0.25, -40, 200, 0, 1)).toBeCloseTo(0.05, 12);
    // A range that is not 0..1, and one that runs backwards (max on the left).
    expect(logic.nudge(0, 50, 200, -1, 1)).toBeCloseTo(0.5, 12);
    expect(logic.nudge(0.5, 20, 200, 1, 0)).toBeCloseTo(0.4, 12);
    // 100 px past the top: held at 1. Coming back 20 px moves it by 20 px — at once.
    const top = logic.nudge(0.9, 120, 200, 0, 1);
    expect(top).toBe(1);
    expect(logic.nudge(top, -20, 200, 0, 1)).toBeCloseTo(0.9, 12);
  });

  it("a stepped slider shows and sends only its steps, inside its range", () => {
    expect(logic.settle(5.5, 2, 0, 10)).toBe(6);
    expect(logic.settle(4.9, 2, 0, 10)).toBe(4);
    expect(logic.settle(11, 2, 0, 10)).toBe(10);
    expect(logic.settle(0.30000000000000004, 0, 0, 1)).toBe(0.3);
  });

  /*
   * sentinel-bot's first board, in small: three columns of sections on twelve cells, one
   * column holding a second label lower down, and a master fader above every label.
   */
  const DESK: readonly Cell[] = [
    control(0, 0, 12), // 0  master: under no label
    label("Robot", 0, 1, 4), // 1
    control(0, 2, 4), // 2
    control(0, 3, 4), // 3
    label("Scene", 4, 1, 4), // 4
    control(4, 2, 4), // 5
    label("Camera", 4, 3, 4), // 6
    control(4, 4, 4), // 7
    control(4, 5, 3, 3), // 8  the pad
    label("Lights", 8, 1, 4), // 9
    control(8, 2, 4), // 10
    control(8, 3, 4), // 11
  ];

  it("a board's pages are its labelled sections: each control under the nearest label above it, each page the box round one section", () => {
    expect(pagesOf(DESK)).toEqual([
      { name: "Robot", x: 0, y: 1, w: 4, h: 3, cells: [1, 2, 3] },
      { name: "Scene", x: 4, y: 1, w: 4, h: 2, cells: [4, 5] },
      { name: "Camera", x: 4, y: 3, w: 4, h: 5, cells: [6, 7, 8] },
      { name: "Lights", x: 8, y: 1, w: 4, h: 3, cells: [9, 10, 11] },
    ]);
  });

  it("sections stacked down one column page the same way; a control beside a label, or above every label, is on no page", () => {
    const stacked = [label("Scene", 0, 0, 8), control(0, 1, 8), label("Camera", 0, 2, 8), control(0, 3, 8), control(2, 4, 4, 3)];
    expect(pagesOf(stacked).map((page) => [page.name, page.y, page.h, page.cells])).toEqual([
      ["Scene", 0, 2, [0, 1]],
      ["Camera", 2, 5, [2, 3, 4]],
    ]);
    const beside = [label("A", 0, 0, 2), control(2, 0, 4), control(0, 1, 2), label("B", 0, 2, 2), control(0, 3, 2)];
    expect(pagesOf(beside).map((page) => page.cells)).toEqual([
      [0, 2],
      [3, 4],
    ]);
  });

  it("a control under two labels side by side goes with the one it overlaps most; a page grows to hold what is its own", () => {
    const cells = [label("Left", 0, 0, 4), label("Right", 4, 0, 4), control(0, 1, 4), control(3, 2, 5)];
    expect(pagesOf(cells)).toEqual([
      { name: "Left", x: 0, y: 0, w: 4, h: 2, cells: [0, 2] },
      { name: "Right", x: 3, y: 0, w: 5, h: 3, cells: [1, 3] },
    ]);
  });

  it("a board with fewer than two sections has no pages: one label, labels with nothing under them, or none", () => {
    expect(pagesOf([label("Look", 0, 0, 8), control(0, 1, 4), control(4, 1, 4)])).toEqual([]);
    expect(pagesOf([label("Look", 0, 0, 8), control(0, 1, 8), label("Notes", 0, 2, 8)])).toEqual([]);
    expect(pagesOf([control(0, 0, 8), control(0, 1, 8)])).toEqual([]);
    expect(pagesOf([label("", 0, 0, 8), control(0, 1, 8), label("", 0, 2, 8), control(0, 3, 8)])).toEqual([]);
  });
});

describe("T1607b phone page — a touch that lands on a control is not yet the control's", () => {
  const sent = (page: ReturnType<typeof openPage>) => page.posts.map((post) => post.set);

  it("touching a slider, tapping it, or dragging up the page from it puts NOTHING on the wire and moves nothing", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const bloom = track(page, "Bloom");
    // A finger lands and rests.
    page.pointer("pointerdown", bloom, 150, 100);
    page.frame();
    page.elapse(2000);
    // It goes up the page, wobbling sideways; then the browser takes it for the scroll it is.
    page.pointer("pointermove", bloom, 153, 80);
    page.pointer("pointermove", bloom, 158, 20);
    page.pointer("pointermove", bloom, 170, -140);
    page.pointer("pointercancel", bloom, 0, 0);
    // A tap, and a touch that moves less than the slop along the track before lifting.
    page.pointer("pointerdown", bloom, 30, 100, 2);
    page.pointer("pointerup", bloom, 30, 100, 2);
    page.pointer("pointerdown", bloom, 30, 100, 3);
    page.pointer("pointermove", bloom, 41, 100, 3);
    page.pointer("pointerup", bloom, 41, 100, 3);
    await page.drain();
    expect(sent(page)).toEqual([]);
    expect(page.value("Bloom")).toBe("0.25");
    expect(bloom.classList.contains("held")).toBe(false);
  });

  /* Never jump-to-touch: where on the track the finger lands says nothing about the value. */
  it("a slider starts from what it shows, wherever the finger lands: the same travel is the same change", async () => {
    for (const landing of [5, 90, 170]) {
      // "now": the Touch mode in which a slider takes a touch anywhere along it (§T1647b).
      const page = openPage({ touch: "now" });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom");
      grab(page, bloom, landing);
      expect(page.value("Bloom"), `landing at ${String(landing)}`).toBe("0.25"); // taking it moved nothing
      page.pointer("pointermove", bloom, landing + 12 + 40);
      page.pointer("pointerup", bloom, landing + 12 + 40);
      await page.drain();
      expect(sent(page).at(-1), `landing at ${String(landing)}`).toEqual({ handle: "h-bloom", values: { value: 0.45 }, phase: "commit" });
    }
  });

  it("a slider that has a touch keeps it when the finger strays up or down — only the travel along it counts", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const bloom = track(page, "Bloom");
    grab(page, bloom, 30, 100);
    page.pointer("pointermove", bloom, 62, 300); // 20 px along, 200 px down
    page.pointer("pointerup", bloom, 82, -400);
    await page.drain();
    expect(sent(page).at(-1)).toEqual({ handle: "h-bloom", values: { value: 0.45 }, phase: "commit" });
  });

  /*
   * iOS may take a touch back for a scroll after a slider has it. The hand moved the slider
   * to where it is and saw the stage follow: the value stays (Android's rule for a SeekBar).
   * A cancel carries no position (0, 0), so the drag must not read one from it.
   */
  it("a slider the browser takes the touch back from stays where the hand put it, and says so once", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const bloom = track(page, "Bloom");
    grab(page, bloom, 30);
    expect(bloom.classList.contains("held")).toBe(true);
    page.pointer("pointermove", bloom, 82);
    page.frame();
    page.pointer("pointercancel", bloom, 0, 0);
    await page.drain();
    expect(sent(page)).toEqual([
      { handle: "h-bloom", values: { value: 0.45 }, phase: "live" },
      { handle: "h-bloom", values: { value: 0.45 }, phase: "commit" },
    ]);
    expect(page.value("Bloom")).toBe("0.45");
    expect(bloom.classList.contains("held")).toBe(false);
  });

  it("a slider that took a touch and was not moved writes nothing; one moved and brought back commits where it is", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const bloom = track(page, "Bloom");
    grab(page, bloom, 30);
    page.pointer("pointerup", bloom, 42);
    await page.drain();
    expect(sent(page)).toEqual([]);
    // Out and back before a frame passed: the document may have seen nothing, but the
    // gesture moved the control, so it ends with one commit of where it stands.
    grab(page, bloom, 30, 0, 2);
    page.pointer("pointermove", bloom, 82, 0, 2);
    page.pointer("pointerup", bloom, 42, 0, 2);
    await page.drain();
    expect(sent(page).at(-1)).toEqual({ handle: "h-bloom", values: { value: 0.25 }, phase: "commit" });
  });

  it("an XY pad does not jump to the finger either: it moves by the finger's travel, from where it is", async () => {
    // "now": the Touch mode in which a pad takes a touch anywhere on it (§T1647b).
    const page = openPage({ touch: "now" });
    page.snapshot(SNAPSHOT);
    const pad = track(page, "Center");
    page.pointer("pointerdown", pad, 190, 10); // a corner: an absolute pad would jump to (0.9, 0.9)
    page.frame();
    page.pointer("pointerup", pad, 190, 10);
    await page.drain();
    expect(sent(page)).toEqual([]);
    expect(page.value("Center")).toBe("0.00, 0.00");
    page.pointer("pointerdown", pad, 190, 10, 2);
    page.pointer("pointermove", pad, 190, 22, 2); // taken, going DOWN the screen
    page.pointer("pointermove", pad, 170, 42, 2);
    page.pointer("pointerup", pad, 170, 42, 2);
    await page.drain();
    expect(sent(page).at(-1)).toEqual({ handle: "h-center", values: { x: -0.2, y: -0.2 }, phase: "commit" });
  });

  it("two fingers on two sliders are two drags, each from its own value", async () => {
    const page = openPage();
    page.snapshot(SNAPSHOT);
    const bloom = track(page, "Bloom");
    const steps = track(page, "Steps");
    grab(page, bloom, 30, 0, 1);
    grab(page, steps, 100, 0, 2);
    page.pointer("pointermove", bloom, 82, 0, 1);
    page.pointer("pointermove", steps, 152, 0, 2);
    page.pointer("pointerup", bloom, 82, 0, 1);
    page.pointer("pointerup", steps, 152, 0, 2);
    await page.drain();
    const commits = sent(page).filter((set) => set.phase === "commit");
    expect(commits).toEqual([
      { handle: "h-bloom", values: { value: 0.45 }, phase: "commit" },
      { handle: "h-steps", values: { value: 6 }, phase: "commit" },
    ]);
  });
});

describe("T1607b phone page — pages of a board, and the scroll rail", () => {
  type Page = ReturnType<typeof openPage>;
  const slider = (handle: string, caption: string) => ({ kind: "slider", handle, caption, value: 0.5, min: 0, max: 1, step: 0 }) as const;
  /** sentinel-bot's first board in small: sections drawn as columns, and a second label lower in one. */
  const DESK: PhoneSnapshot = {
    seq: 3,
    panels: [
      {
        title: "Sentinel",
        rows: [],
        board: {
          columns: 12,
          rows: 8,
          items: [
            { kind: "widget", rect: { x: 0, y: 0, w: 12, h: 1 }, widget: slider("h-master", "Master") },
            { kind: "label", rect: { x: 0, y: 1, w: 4, h: 1 }, text: "Robot" },
            { kind: "widget", rect: { x: 0, y: 2, w: 4, h: 1 }, widget: slider("h-speed", "Speed") },
            { kind: "label", rect: { x: 4, y: 1, w: 4, h: 1 }, text: "Scene" },
            { kind: "widget", rect: { x: 4, y: 2, w: 4, h: 1 }, widget: slider("h-bore", "Bore") },
            { kind: "label", rect: { x: 4, y: 3, w: 4, h: 1 }, text: "Camera" },
            { kind: "widget", rect: { x: 4, y: 4, w: 4, h: 1 }, widget: { kind: "toggle", handle: "h-cuts", caption: "Cuts", on: false } },
            {
              kind: "widget",
              rect: { x: 4, y: 5, w: 3, h: 3 },
              widget: { kind: "xyPad", handle: "h-view", caption: "View", x: 0, y: 0, min: -1, max: 1 },
            },
            { kind: "label", rect: { x: 8, y: 1, w: 4, h: 1 }, text: "Lights" },
            { kind: "widget", rect: { x: 8, y: 2, w: 4, h: 1 }, widget: slider("h-glow", "Glow") },
          ],
        },
      },
      { title: "Plain", rows: [{ kind: "widgets", widgets: [slider("h-dim", "Dim")] }] },
    ],
  };
  const pager = (page: Page): HTMLElement => page.camera("pager");
  const chips = (page: Page): string[] => [...pager(page).querySelectorAll("[role=tab]")].map((chip) => chip.textContent ?? "");
  const chosen = (page: Page): string[] => [...pager(page).querySelectorAll("[aria-selected=true]")].map((chip) => chip.textContent ?? "");
  const choose = (page: Page, name: string): void => {
    const chip = [...pager(page).querySelectorAll<HTMLElement>("[role=tab]")].find((each) => each.textContent === name);
    if (chip === undefined) throw new Error(`no page "${name}"`);
    chip.click();
  };
  const tab = (page: Page, name: string): void => {
    const found = [...page.doc.querySelectorAll<HTMLElement>("#tabs [role=tab]")].find((each) => each.textContent === name);
    if (found === undefined) throw new Error(`no tab "${name}"`);
    found.click();
  };
  /** What the shown board draws: [what it is, grid column, grid row] of every cell not hidden, and the columns the width is divided by. */
  const drawn = (page: Page) => {
    const grid = page.doc.querySelector<HTMLElement>('#panels section[aria-label="Sentinel"] .board')!;
    return {
      columns: grid.style.getPropertyValue("--cols"),
      cells: [...grid.children]
        .map((child) => child as HTMLElement)
        .filter((cell) => !cell.hidden)
        .map((cell) => [cell.querySelector(".name")?.textContent ?? cell.textContent, cell.style.gridColumn, cell.style.gridRow]),
    };
  };

  it("a board with labelled sections gets a pager above the tabs: All — the board as its owner drew it — and a page per label", () => {
    const page = openPage();
    page.snapshot(DESK);
    expect(pager(page).hidden).toBe(false);
    expect(pager(page).getAttribute("role")).toBe("tablist");
    expect(chips(page)).toEqual(["All", "Robot", "Scene", "Camera", "Lights"]);
    expect(chosen(page)).toEqual(["All"]);
    expect(page.doc.body.classList.contains("paged")).toBe(true);
    expect(drawn(page).columns).toBe("12");
    expect(drawn(page).cells).toHaveLength(10);
    expect(drawn(page).cells[7]).toEqual(["View", "5 / span 3", "6 / span 3"]);
  });

  it("a page shows its section and nothing else, moved to the top-left, on a grid of ITS columns — so its controls fill the phone's width", () => {
    const page = openPage();
    page.snapshot(DESK);
    choose(page, "Camera");
    expect(chosen(page)).toEqual(["Camera"]);
    expect(drawn(page)).toEqual({
      columns: "4",
      cells: [
        ["Camera", "1 / span 4", "1 / span 1"],
        ["Cuts", "1 / span 4", "2 / span 1"],
        ["View", "1 / span 3", "3 / span 3"],
      ],
    });
    choose(page, "Lights");
    expect(drawn(page).cells.map((cell) => cell[0])).toEqual(["Lights", "Glow"]);
    // All is the whole board again, each control back at its own rect.
    choose(page, "All");
    expect(drawn(page).columns).toBe("12");
    expect(drawn(page).cells[7]).toEqual(["View", "5 / span 3", "6 / span 3"]);
    expect(drawn(page).cells[0]).toEqual(["Master", "1 / span 12", "1 / span 1"]);
  });

  it("the controls on a page are the same live controls: one still drags, and a redraw of the board keeps the page", async () => {
    const page = openPage();
    page.snapshot(DESK);
    choose(page, "Robot");
    const speed = track(page, "Speed");
    grab(page, speed, 88); // on its knob: Speed shows 0.5
    page.pointer("pointermove", speed, 140);
    page.pointer("pointerup", speed, 140);
    await page.drain();
    expect(page.posts.at(-1)?.set).toEqual({ handle: "h-speed", values: { value: 0.7 }, phase: "commit" });
    // The desk adds a control to another section: a new shape, the same page.
    const board = DESK.panels[0]!.board!;
    const spark = { kind: "widget", rect: { x: 8, y: 3, w: 4, h: 1 }, widget: slider("h-spark", "Spark") } as const;
    page.snapshot({ seq: 4, panels: [{ ...DESK.panels[0]!, board: { ...board, items: [...board.items, spark] } }, DESK.panels[1]!] });
    expect(chosen(page)).toEqual(["Robot"]);
    expect(drawn(page).cells.map((cell) => cell[0])).toEqual(["Robot", "Speed"]);
  });

  it("the pager belongs to the shown Panel: a Panel without sections, and the Camera tab, show none", () => {
    const page = openPage();
    page.snapshot(DESK);
    choose(page, "Scene");
    tab(page, "Plain");
    expect(pager(page).hidden).toBe(true);
    expect(chips(page)).toEqual([]);
    expect(page.doc.body.classList.contains("paged")).toBe(false);
    tab(page, "Camera");
    expect(pager(page).hidden).toBe(true);
    // Back on the Panel: its page is the one it was left on.
    tab(page, "Sentinel");
    expect(chosen(page)).toEqual(["Scene"]);
    expect(drawn(page).cells.map((cell) => cell[0])).toEqual(["Scene", "Bore"]);
  });

  it("the phone remembers each Panel's page; a section that is gone shows All without forgetting the choice", () => {
    const first = openPage();
    first.snapshot(DESK);
    choose(first, "Lights");
    const kept = first.win.localStorage.getItem(PHONE_PAGE_STORAGE_KEY);
    expect(JSON.parse(kept ?? "null")).toEqual({ "panel:Sentinel": "Lights" });

    const again = openPage({ storage: { [PHONE_PAGE_STORAGE_KEY]: kept! } });
    again.snapshot(DESK);
    expect(chosen(again)).toEqual(["Lights"]);
    expect(drawn(again).cells.map((cell) => cell[0])).toEqual(["Lights", "Glow"]);
    // Choosing All forgets it.
    choose(again, "All");
    expect(JSON.parse(again.win.localStorage.getItem(PHONE_PAGE_STORAGE_KEY) ?? "null")).toEqual({});

    const gone = openPage({ storage: { [PHONE_PAGE_STORAGE_KEY]: JSON.stringify({ "panel:Sentinel": "Encore" }) } });
    gone.snapshot(DESK);
    expect(chosen(gone)).toEqual(["All"]);
    expect(drawn(gone).cells).toHaveLength(10);
    expect(JSON.parse(gone.win.localStorage.getItem(PHONE_PAGE_STORAGE_KEY) ?? "null")).toEqual({ "panel:Sentinel": "Encore" });
    // Storage that holds something else entirely is not a page: the board, whole.
    const junk = openPage({ storage: { [PHONE_PAGE_STORAGE_KEY]: "[1,2" } });
    junk.snapshot(DESK);
    expect(chosen(junk)).toEqual(["All"]);
  });

  /*
   * An XY pad takes every touch that lands on it, so it is the one control a scroll cannot
   * start from. The rail is for exactly that: a view that scrolls AND shows a pad. jsdom
   * lays nothing out, so the test says how tall the page is; that a touch on the rail really
   * scrolls is the browser's doing, asserted in the e2e spec.
   */
  it("the scroll rail shows only where a pad could trap a scroll: the view scrolls and a pad is on it", () => {
    // "now": a Touch mode in which a pad takes every touch on it, and so can trap a scroll (§T1647b).
    const page = openPage({ touch: "now" });
    let tall = true;
    Object.defineProperty(page.doc.documentElement, "clientHeight", { configurable: true, get: () => 700 });
    Object.defineProperty(page.doc.documentElement, "scrollHeight", { configurable: true, get: () => (tall ? 2100 : 700) });
    const rail = page.camera("rail");
    const railed = (): boolean[] => [!rail.hidden, page.doc.body.classList.contains("railed")];
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    page.snapshot(DESK); // All: the pad is on it, and it is three screens tall
    expect(railed()).toEqual([true, true]);
    // The thumb says where the page is: the first third of it.
    const thumb = rail.querySelector<HTMLElement>(".railthumb")!;
    expect([thumb.style.top, parseFloat(thumb.style.height).toFixed(1)]).toEqual(["0%", "33.3"]);
    choose(page, "Lights"); // no pad on this page: every control lets a scroll through
    expect(railed()).toEqual([false, false]);
    choose(page, "Camera"); // the pad's own page
    expect(railed()).toEqual([true, true]);
    tab(page, "Plain");
    expect(railed()).toEqual([false, false]);
    tab(page, "Sentinel");
    expect(railed()).toEqual([true, true]);
    // The phone is turned and the page now fits: nothing to scroll, no rail.
    tall = false;
    page.win.dispatchEvent(new page.win.Event("resize"));
    expect(railed()).toEqual([false, false]);
  });
});

/**
 * T1647b TRIAL — DELETED WHEN THE OWNER HAS CHOSEN (the modes that lose; the winner's cases
 * stay and lose their loop). §T1607b's rule failed in the owner's hand: "still pretty hard
 * to not screw with the sliders when scrolling on mobile". The page now holds the candidate
 * rules as modes of one "Touch" setting, kept on the phone, to be tried in one sitting:
 *
 *   K knob only · H hold to grab · L a Play / Scroll lock · G a scroll strip · A as before
 *
 * What every mode must keep: touch-down writes nothing; a touch that goes up the page from
 * a control writes nothing; a deliberate drag still moves a slider, by its travel; toggles
 * and buttons act on release. What each mode ADDS is what must be true before a slider,
 * fader or pad may take a touch at all — and that is what its own cases assert. Which of
 * them is right is not something a test can say: it is decided on the phone.
 */
describe("T1647b phone page — the Touch trial", () => {
  type Page = ReturnType<typeof openPage>;
  interface Mode {
    readonly letter: string;
    readonly says: string;
    readonly from: "any" | "knob";
    readonly rest: number;
    readonly strip: "" | "right" | "left";
    readonly lock: boolean;
  }
  interface Trial {
    readonly TOUCH_MODES: Readonly<Record<string, Mode>>;
    readonly TOUCH_DEFAULT: string;
    readonly SLOP: number;
    readonly REST: number;
    readonly GRIP: number;
    knobAt(share: number, length: number): number;
    grips(a: number, b: number): boolean;
  }
  const rules = runInNewContext(
    `${PHONE_PAGE_LOGIC}; ({ TOUCH_MODES: TOUCH_MODES, TOUCH_DEFAULT: TOUCH_DEFAULT, SLOP: SLOP, REST: REST, GRIP: GRIP, knobAt: knobAt, grips: grips })`,
  ) as Trial;
  const MODES = JSON.parse(JSON.stringify(rules.TOUCH_MODES)) as Record<string, Mode>;
  const KEYS = Object.keys(MODES);
  const sent = (page: Page) => page.posts.map((post) => post.set);
  const classes = (page: Page): string[] => [...page.doc.body.classList].sort();
  const choose = (page: Page, id: "touchMode" | "rowsMode", value: string): void => {
    const select = page.camera(id) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new page.win.Event("change", { bubbles: true }));
  };
  const modeOf = (page: Page): Mode => MODES[(page.camera("touchMode") as HTMLSelectElement).value]!;

  /** Where a control's knob is in its 200 px box: a slider's or fader's handle (kept whole inside the track), a pad's puck. */
  const knobOf = (target: HTMLElement): { x: number; y: number } => {
    const puck = target.querySelector<HTMLElement>(".puck");
    if (puck !== null) return { x: (parseFloat(puck.style.left) / 100) * 200, y: (parseFloat(puck.style.top) / 100) * 200 };
    const thumb = target.querySelector<HTMLElement>(".thumb");
    if (thumb === null) throw new Error("this control has no knob");
    return { x: rules.knobAt(parseFloat(thumb.style.left) / 100, 200), y: 100 };
  };
  /**
   * A DELIBERATE take, as a hand would do it in the mode the page is in: land on the knob,
   * rest as long as the mode asks, go SLOP along. Returns where the control took the touch.
   */
  const take = (page: Page, target: HTMLElement, pointerId = 1): { x: number; y: number } => {
    const at = knobOf(target);
    page.pointer("pointerdown", target, at.x, at.y, pointerId);
    if (modeOf(page).rest > 0) page.elapse(modeOf(page).rest);
    page.pointer("pointermove", target, at.x + rules.SLOP, at.y, pointerId);
    return { x: at.x + rules.SLOP, y: at.y };
  };

  /* ------------------------------------------------------------------ the numbers */

  it("the candidates are named, and the one a phone starts in is K", () => {
    expect(Object.fromEntries(KEYS.map((key) => [key, MODES[key]!.letter]))).toEqual({
      knob: "K",
      hold: "H",
      lock: "L",
      gutter: "G",
      gutterleft: "G",
      now: "A",
      knobgutter: "K+G",
      knobhold: "K+H",
    });
    expect(rules.TOUCH_DEFAULT).toBe("knob");
    // A mode differs from "as before" in exactly the conditions its letter names.
    const adds = (mode: Mode): string[] => [mode.from === "knob" ? "knob" : "", mode.rest > 0 ? "rest" : "", mode.strip !== "" ? "strip" : "", mode.lock ? "lock" : ""].filter((each) => each !== "");
    expect(Object.fromEntries(KEYS.map((key) => [key, adds(MODES[key]!)]))).toEqual({
      knob: ["knob"],
      hold: ["rest"],
      lock: ["lock"],
      gutter: ["strip"],
      gutterleft: ["strip"],
      now: [],
      knobgutter: ["knob", "strip"],
      knobhold: ["knob", "rest"],
    });
  });

  /*
   * A knob is sized for a FINGER, not for the row it sits in (a row may be drawn 32 px
   * tall): at least Apple's 44 pt, and not so wide that most of a short slider is knob.
   * A rest is longer than a scroll takes to start and shorter than a long press.
   */
  it("a knob is a finger wide, a rest is between a tap and a long press, and a resting finger may wander less than it takes to drag", () => {
    expect(rules.GRIP).toBeGreaterThanOrEqual(44);
    expect(rules.GRIP).toBeLessThanOrEqual(64);
    expect([MODES["hold"]!.rest, MODES["knobhold"]!.rest]).toEqual([200, 100]);
    expect(rules.REST).toBe(8);
    expect(rules.REST).toBeLessThan(rules.SLOP);
  });

  it("a knob is centred on the value and whole inside its track: at either end it is the last finger-width", () => {
    const half = rules.GRIP / 2;
    expect(rules.knobAt(0.5, 300)).toBe(150);
    expect(rules.knobAt(0, 300)).toBe(half);
    expect(rules.knobAt(1, 300)).toBe(300 - half);
    expect(rules.knobAt(0.05, 300)).toBe(half); // 15 px along: still the first finger-width
    // A track narrower than a finger is all knob.
    expect(rules.knobAt(0, 40)).toBe(half);
    expect(rules.knobAt(1, 40)).toBe(half);
    expect([rules.grips(100, 100 + half), rules.grips(100, 100 + half + 1), rules.grips(100 - half, 100)]).toEqual([true, false, true]);
  });

  /* --------------------------------------------- what every mode keeps (T1607b's acceptance) */

  describe.each(KEYS)("in mode %s", (key) => {
    it("a deliberate drag moves a slider by the finger's travel: a live write, then one commit", async () => {
      const page = openPage({ touch: key });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom");
      const at = take(page, bloom);
      expect(page.value("Bloom")).toBe("0.25"); // taking it moved nothing
      expect(bloom.classList.contains("held")).toBe(true);
      page.pointer("pointermove", bloom, at.x + 40, at.y);
      page.frame();
      page.pointer("pointerup", bloom, at.x + 40, at.y);
      await page.drain();
      expect(sent(page)).toEqual([
        { handle: "h-bloom", values: { value: 0.45 }, phase: "live" },
        { handle: "h-bloom", values: { value: 0.45 }, phase: "commit" },
      ]);
      expect(bloom.classList.contains("held")).toBe(false);
    });

    it("a touch that goes up the page from a slider writes nothing — from its knob or beside it, at once or after a pause", async () => {
      const page = openPage({ touch: key });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom"); // its knob is at x = 50
      let pointer = 0;
      for (const landing of [50, 150]) {
        for (const pause of [0, 400]) {
          pointer += 1;
          page.pointer("pointerdown", bloom, landing, 100, pointer);
          page.elapse(pause);
          // Up the page, wobbling sideways as a thumb does; then the browser takes it for the scroll it is.
          page.pointer("pointermove", bloom, landing + 3, 80, pointer);
          page.pointer("pointermove", bloom, landing + 8, 20, pointer);
          page.pointer("pointermove", bloom, landing + 20, -140, pointer);
          page.frame();
          page.pointer("pointercancel", bloom, 0, 0, pointer);
        }
      }
      page.elapse(1000);
      await page.drain();
      expect(sent(page)).toEqual([]);
      expect(page.value("Bloom")).toBe("0.25");
      expect(bloom.classList.contains("held")).toBe(false);
    });

    it("touch-down writes nothing on any control, and a toggle flips on its click alone", async () => {
      const page = openPage({ touch: key });
      page.snapshot(SNAPSHOT);
      let pointer = 0;
      for (const caption of ["Bloom", "Steps", "Strobe", "Flash", "Center"]) {
        const control = track(page, caption);
        const at = caption === "Strobe" || caption === "Flash" ? { x: 100, y: 100 } : knobOf(control);
        pointer += 1;
        page.pointer("pointerdown", control, at.x, at.y, pointer);
      }
      page.frame();
      await page.flush();
      expect(sent(page)).toEqual([]);
      track(page, "Strobe").click();
      await page.drain();
      expect(sent(page).filter((set) => set.handle === "h-strobe")).toEqual([{ handle: "h-strobe", values: { on: true }, phase: "commit" }]);
    });
  });

  /* ------------------------------------------------------------------------ K: the knob only */

  describe("K — a slider follows only a touch that starts on its knob", () => {
    it("landing on the knob takes it; landing anywhere else on the track does nothing, however far along it goes", async () => {
      const page = openPage({ touch: "knob" });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom"); // 0.25 of 200 px: the knob is 22..78
      for (const [pointer, landing] of [79, 110, 190, 21].entries()) {
        page.pointer("pointerdown", bloom, landing, 100, pointer + 1);
        page.pointer("pointermove", bloom, landing + 12, 100, pointer + 1);
        page.pointer("pointermove", bloom, landing - 80, 100, pointer + 1);
        page.frame();
        page.pointer("pointerup", bloom, landing - 80, 100, pointer + 1);
      }
      await page.drain();
      expect(sent(page)).toEqual([]);
      expect(page.value("Bloom")).toBe("0.25");
      // The two edges of the knob, and no jump: the same travel is the same change from either.
      for (const landing of [22, 78]) {
        const again = openPage({ touch: "knob" });
        again.snapshot(SNAPSHOT);
        const slider = track(again, "Bloom");
        again.pointer("pointerdown", slider, landing, 100);
        again.pointer("pointermove", slider, landing + 12, 100);
        again.pointer("pointerup", slider, landing + 52, 100);
        await again.drain();
        expect(sent(again), `landing at ${String(landing)}`).toEqual([{ handle: "h-bloom", values: { value: 0.45 }, phase: "commit" }]);
      }
    });

    it("the knob is where the value is — it moves with a drag, with the desk, and stays whole at the ends", async () => {
      const page = openPage({ touch: "knob" });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom");
      const grip = bloom.querySelector<HTMLElement>(".grip")!;
      // Drawn: as wide as it is to a finger, at the value.
      const drawn = page.win.getComputedStyle(grip);
      expect([drawn.display, drawn.width, grip.style.getPropertyValue("--at")]).toEqual(["block", `${String(rules.GRIP)}px`, "25%"]);
      // ...by the very rule that says where it is hit (knobAt): on the value, whole inside the track.
      const half = `${String(rules.GRIP / 2)}px`;
      expect(page.doc.querySelector("style")?.textContent).toContain(`left: clamp(${half}, var(--at), calc(100% - ${half}));`);
      /** Does a touch that lands at `landing` and goes 16 px to the left move the slider? (It is put back before it lifts.) */
      const tries = (landing: number, pointer: number): boolean => {
        const before = page.value("Bloom");
        page.pointer("pointerdown", bloom, landing, 100, pointer);
        page.pointer("pointermove", bloom, landing - 12, 100, pointer);
        page.pointer("pointermove", bloom, landing - 16, 100, pointer);
        const moved = page.value("Bloom") !== before;
        page.pointer("pointermove", bloom, landing - 12, 100, pointer);
        page.pointer("pointerup", bloom, landing - 12, 100, pointer);
        return moved;
      };
      expect([tries(50, 1), tries(150, 2)]).toEqual([true, false]);
      // The desk moves it to 0.75: the knob is at 150 now, and 50 is bare track.
      await page.drain();
      page.snapshot(withWidget(6, "h-bloom", { value: 0.75 }));
      expect(grip.style.getPropertyValue("--at")).toBe("75%");
      expect([tries(50, 3), tries(150, 4)]).toEqual([false, true]);
      // At its top the knob is the last finger-width of the track, not half off its end.
      await page.drain();
      page.snapshot(withWidget(7, "h-bloom", { value: 1 }));
      expect([tries(140, 5), tries(146, 6)]).toEqual([false, true]);
      await page.drain();
    });

    it("an XY pad follows only from its puck, by the finger's travel; the rest of it is the page's, so it traps no scroll and needs no rail", async () => {
      const page = openPage({ touch: "knob" });
      Object.defineProperty(page.doc.documentElement, "clientHeight", { configurable: true, get: () => 700 });
      Object.defineProperty(page.doc.documentElement, "scrollHeight", { configurable: true, get: () => 2100 });
      page.snapshot(SNAPSHOT);
      const pad = track(page, "Center"); // the puck is at (100, 100)
      // From a corner: far enough to be taken twice over, were the pad taking touches there.
      page.pointer("pointerdown", pad, 190, 10);
      page.pointer("pointermove", pad, 178, 22);
      page.pointer("pointermove", pad, 150, 60);
      page.pointer("pointerup", pad, 150, 60);
      await page.drain();
      expect(sent(page)).toEqual([]);
      expect(page.value("Center")).toBe("0.00, 0.00");
      page.pointer("pointerdown", pad, 120, 80, 2);
      page.pointer("pointermove", pad, 120, 92, 2); // taken, going down the screen
      page.pointer("pointermove", pad, 100, 112, 2);
      page.pointer("pointerup", pad, 100, 112, 2);
      await page.drain();
      expect(sent(page).at(-1)).toEqual({ handle: "h-center", values: { x: -0.2, y: -0.2 }, phase: "commit" });
      // What the browser is told: the pad lets a touch that goes up or down scroll; the puck does not.
      expect(page.win.getComputedStyle(pad).touchAction).toBe("pan-y");
      const puck = page.win.getComputedStyle(pad.querySelector(".puck")!);
      expect([puck.touchAction, puck.pointerEvents]).toEqual(["none", "auto"]);
      expect(page.camera("rail").hidden).toBe(true);
    });

    it("a layer's fader has a knob too", async () => {
      const page = openPage({ touch: "knob" });
      page.snapshot({
        seq: 1,
        panels: [{ title: "P", rows: [], board: { columns: 8, rows: 1, items: [{ kind: "widget", rect: { x: 0, y: 0, w: 6, h: 1 }, widget: { kind: "layer", handle: "h-fx", caption: "fx", on: true, opacity: 0.5, opacityWritable: true, picture: "" } }] } }],
      });
      const fader = page.doc.querySelector<HTMLElement>(".w.layer .fader")!; // 0.5 of 200 px: the knob is 72..128
      page.pointer("pointerdown", fader, 20, 100);
      page.pointer("pointermove", fader, 32, 100);
      page.pointer("pointermove", fader, 70, 100);
      page.pointer("pointerup", fader, 70, 100);
      await page.drain();
      expect(sent(page)).toEqual([]);
      const at = take(page, fader, 2);
      page.pointer("pointerup", fader, at.x + 20, at.y, 2);
      await page.drain();
      expect(sent(page)).toEqual([{ handle: "h-fx", values: { opacity: 0.6 }, phase: "commit" }]);
    });

    it("outside K no knob is drawn and a slider takes a touch anywhere along it", () => {
      const page = openPage({ touch: "now" });
      page.snapshot(SNAPSHOT);
      expect(page.win.getComputedStyle(track(page, "Bloom").querySelector(".grip")!).display).toBe("none");
      expect(page.win.getComputedStyle(track(page, "Center")).touchAction).toBe("none");
    });
  });

  /* --------------------------------------------------------------------- H: hold to grab */

  describe("H — a control follows only after the finger has rested on it", () => {
    it("the outline arrives when the finger has rested 200 ms, not a millisecond sooner, and nothing is written by resting", async () => {
      const page = openPage({ touch: "hold" });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom");
      page.pointer("pointerdown", bloom, 150, 100); // anywhere on it: H has no knob
      page.elapse(199);
      expect(bloom.classList.contains("held")).toBe(false);
      page.elapse(1);
      expect(bloom.classList.contains("held")).toBe(true);
      page.elapse(2000);
      page.frame();
      expect(sent(page)).toEqual([]);
      // Then it drags as ever: SLOP along takes it, the travel after that moves it.
      page.pointer("pointermove", bloom, 162, 100);
      page.pointer("pointerup", bloom, 202, 100);
      await page.drain();
      expect(sent(page)).toEqual([{ handle: "h-bloom", values: { value: 0.45 }, phase: "commit" }]);
      expect(bloom.classList.contains("held")).toBe(false);
    });

    it("a finger that moves before it has rested is let go: it does not grab then, or later in the same touch", async () => {
      const page = openPage({ touch: "hold" });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom");
      // A deliberate-looking drag along the slider, started at once.
      page.pointer("pointerdown", bloom, 50, 100);
      page.elapse(60);
      page.pointer("pointermove", bloom, 62, 100);
      page.pointer("pointermove", bloom, 110, 100);
      // ...and then it stops and rests, still down. Too late: this touch was let go.
      page.elapse(1000);
      expect(bloom.classList.contains("held")).toBe(false);
      page.pointer("pointermove", bloom, 160, 100);
      page.pointer("pointerup", bloom, 160, 100);
      await page.drain();
      expect(sent(page)).toEqual([]);
      expect(page.value("Bloom")).toBe("0.25");
    });

    it("a resting finger may wander 8 px and still be resting; 9 px is a move", async () => {
      const wander = async (px: number): Promise<boolean> => {
        const page = openPage({ touch: "hold" });
        page.snapshot(SNAPSHOT);
        const bloom = track(page, "Bloom");
        page.pointer("pointerdown", bloom, 50, 100);
        page.elapse(100);
        page.pointer("pointermove", bloom, 50, 100 + px);
        page.elapse(100);
        await page.drain();
        expect(sent(page)).toEqual([]);
        return bloom.classList.contains("held");
      };
      expect([await wander(rules.REST), await wander(rules.REST + 1)]).toEqual([true, false]);
    });

    it("a pad is grabbed the same way; a toggle and a button are not made to wait", async () => {
      const page = openPage({ touch: "hold" });
      page.snapshot(SNAPSHOT);
      const pad = track(page, "Center");
      page.pointer("pointerdown", pad, 30, 30);
      page.pointer("pointermove", pad, 60, 60);
      page.pointer("pointerup", pad, 60, 60);
      const at = take(page, pad, 2);
      page.pointer("pointerup", pad, at.x + 20, at.y, 2);
      await page.drain();
      expect(sent(page)).toEqual([{ handle: "h-center", values: { x: 0.2, y: 0 }, phase: "commit" }]);
      track(page, "Strobe").click();
      await page.drain();
      expect(sent(page).at(-1)).toEqual({ handle: "h-strobe", values: { on: true }, phase: "commit" });
    });
  });

  /* ---------------------------------------------------------------------------- L: a lock */

  describe("L — one switch puts the page in Play or in Scroll", () => {
    const LOCKED: PhoneSnapshot = {
      seq: 2,
      panels: [
        {
          title: "Stage",
          rows: [],
          board: {
            columns: 8,
            rows: 6,
            items: [
              { kind: "label", rect: { x: 0, y: 0, w: 8, h: 1 }, text: "Look" },
              { kind: "widget", rect: { x: 0, y: 1, w: 8, h: 1 }, widget: { kind: "preset", handle: "h-looks", caption: "looks", presets: ["soft", "hard"], current: "soft", morphing: false } },
              { kind: "widget", rect: { x: 0, y: 2, w: 8, h: 1 }, widget: { kind: "slider", handle: "h-bloom", caption: "Bloom", value: 0.25, min: 0, max: 1, step: 0 } },
              { kind: "label", rect: { x: 0, y: 3, w: 8, h: 1 }, text: "Hits" },
              { kind: "widget", rect: { x: 0, y: 4, w: 4, h: 1 }, widget: { kind: "toggle", handle: "h-strobe", caption: "Strobe", on: false } },
              { kind: "widget", rect: { x: 4, y: 4, w: 4, h: 1 }, widget: { kind: "button", handle: "h-flash", caption: "Flash", held: false } },
              { kind: "widget", rect: { x: 0, y: 5, w: 3, h: 3 }, widget: { kind: "xyPad", handle: "h-center", caption: "Center", x: 0, y: 0, min: -1, max: 1 } },
            ],
          },
        },
        { title: "Other", rows: [{ kind: "widgets", widgets: [{ kind: "slider", handle: "h-dim", caption: "Dim", value: 0.5, min: 0, max: 1, step: 0 }] }] },
      ],
    };
    const lock = (page: Page): HTMLElement => page.camera("lock");
    /** Everything a hand can do to the board: drag a slider and the pad, tap the toggle and a preset, rest on the button. */
    const everything = async (page: Page, pointer: number): Promise<void> => {
      const bloom = track(page, "Bloom");
      const at = take(page, bloom, pointer);
      page.pointer("pointermove", bloom, at.x + 40, at.y, pointer);
      page.pointer("pointerup", bloom, at.x + 40, at.y, pointer);
      const pad = track(page, "Center");
      const on = take(page, pad, pointer + 1);
      page.pointer("pointerup", pad, on.x + 20, on.y, pointer + 1);
      track(page, "Strobe").click();
      page.doc.querySelector<HTMLElement>('.w.preset [data-preset="hard"]')!.click();
      page.pointer("pointerdown", track(page, "Flash"), 100, 100, pointer + 2);
      page.elapse(300);
      page.pointer("pointerup", track(page, "Flash"), 100, 100, pointer + 2);
      await page.drain();
    };

    it("the switch is there in L and nowhere else, and the page starts in Play", () => {
      for (const key of KEYS) {
        const page = openPage({ touch: key });
        page.snapshot(LOCKED);
        expect(lock(page).hidden, key).toBe(key !== "lock");
        expect(classes(page).includes("scrollonly"), key).toBe(false);
      }
      const page = openPage({ touch: "lock" });
      expect([lock(page).tagName, lock(page).getAttribute("aria-pressed"), lock(page).textContent]).toEqual(["BUTTON", "false", "PlayScroll"]);
    });

    it("in Scroll no control answers — not a drag, not a tap, not a rest — and in Play they all do, as before", async () => {
      const page = openPage({ touch: "lock" });
      page.snapshot(LOCKED);
      lock(page).click();
      expect([lock(page).getAttribute("aria-pressed"), classes(page).includes("scrollonly")]).toEqual(["true", true]);
      // What makes the browser scroll from anywhere on the board: it takes no touch at all.
      expect(page.win.getComputedStyle(page.camera("panels")).pointerEvents).toBe("none");
      await everything(page, 1);
      expect(sent(page)).toEqual([]);
      expect([page.value("Bloom"), page.value("Strobe"), page.value("Center")]).toEqual(["0.25", "Off", "0.00, 0.00"]);

      lock(page).click();
      expect([lock(page).getAttribute("aria-pressed"), classes(page).includes("scrollonly")]).toEqual(["false", false]);
      await everything(page, 11);
      expect(sent(page).filter((set) => set.phase === "commit")).toEqual([
        { handle: "h-bloom", values: { value: 0.45 }, phase: "commit" },
        { handle: "h-center", values: { x: 0.2, y: 0 }, phase: "commit" },
        { handle: "h-strobe", values: { on: true }, phase: "commit" },
        { handle: "h-looks", values: { recall: "hard" }, phase: "commit" },
        { handle: "h-flash", values: { held: false }, phase: "commit" },
      ]);
    });

    it("the tab bar and the pager answer in Scroll as in Play, and getting around does not change the mode", () => {
      const page = openPage({ touch: "lock" });
      page.snapshot(LOCKED);
      lock(page).click();
      const chip = (name: string): HTMLElement => [...page.doc.querySelectorAll<HTMLElement>("#pager [role=tab]")].find((each) => each.textContent === name)!;
      const tab = (name: string): HTMLElement => [...page.doc.querySelectorAll<HTMLElement>("#tabs [role=tab]")].find((each) => each.textContent === name)!;
      chip("Hits").click();
      expect([...page.doc.querySelectorAll("#pager [aria-selected=true]")].map((each) => each.textContent)).toEqual(["Hits"]);
      tab("Other").click();
      expect([...page.doc.querySelectorAll("#tabs [aria-selected=true]")].map((each) => each.textContent)).toEqual(["Other"]);
      tab("Stage").click();
      expect(classes(page).includes("scrollonly")).toBe(true);
      expect(lock(page).getAttribute("aria-pressed")).toBe("true");
    });

    it("going to Scroll with a slider in hand lets it go where it is", async () => {
      const page = openPage({ touch: "lock" });
      page.snapshot(LOCKED);
      const bloom = track(page, "Bloom");
      const at = take(page, bloom);
      page.pointer("pointermove", bloom, at.x + 40, at.y);
      page.frame();
      lock(page).click();
      page.pointer("pointermove", bloom, at.x + 120, at.y);
      page.pointer("pointerup", bloom, at.x + 120, at.y);
      await page.drain();
      expect(sent(page)).toEqual([
        { handle: "h-bloom", values: { value: 0.45 }, phase: "live" },
        { handle: "h-bloom", values: { value: 0.45 }, phase: "commit" },
      ]);
    });
  });

  /* --------------------------------------------------------------------------- G: a gutter */

  describe("G — a strip of every board is never a control", () => {
    const BARE: PhoneSnapshot = {
      seq: 2,
      panels: [
        {
          title: "Sliders",
          rows: [],
          board: { columns: 8, rows: 1, items: [{ kind: "widget", rect: { x: 0, y: 0, w: 8, h: 1 }, widget: { kind: "slider", handle: "h-bloom", caption: "Bloom", value: 0.25, min: 0, max: 1, step: 0 } }] },
        },
      ],
    };
    const tall = (page: Page, height: number): void => {
      Object.defineProperty(page.doc.documentElement, "clientHeight", { configurable: true, get: () => 700 });
      Object.defineProperty(page.doc.documentElement, "scrollHeight", { configurable: true, get: () => height });
    };
    /** [the strip shows, the board is inset for it, it is the wide one, it is on the left]. */
    const strip = (page: Page): boolean[] => [!page.camera("rail").hidden, ...["railed", "gutter", "railleft"].map((name) => page.doc.body.classList.contains(name))];

    it("a board of nothing but sliders gets the strip where it scrolls — on the right, or on the left — and no mode without a strip gives it one", () => {
      const shows = (key: string, height: number): boolean[] => {
        const page = openPage({ touch: key });
        tall(page, height);
        page.snapshot(BARE);
        return strip(page);
      };
      expect(shows("gutter", 2100)).toEqual([true, true, true, false]);
      expect(shows("gutterleft", 2100)).toEqual([true, true, true, true]);
      expect(shows("knobgutter", 2100)).toEqual([true, true, true, false]);
      // Nothing to scroll: no strip, and the board keeps its whole width.
      expect(shows("gutter", 700).slice(0, 2)).toEqual([false, false]);
      for (const key of ["knob", "hold", "lock", "now", "knobhold"]) expect(shows(key, 2100).slice(0, 2), key).toEqual([false, false]);
    });

    it("the strip is a thumb wide and the board is inset beside it; it is the page's own rail, with its thumb", () => {
      const page = openPage({ touch: "gutter" });
      tall(page, 2100);
      page.snapshot(BARE);
      const css = page.doc.querySelector("style")?.textContent ?? "";
      expect(css).toContain(`body.gutter #rail { width: calc(${String(rules.GRIP)}px + env(safe-area-inset-right)); }`);
      expect(css).toContain(`body.gutter.railed { --rail: ${String(rules.GRIP - 4)}px; }`);
      const thumb = page.camera("rail").querySelector<HTMLElement>(".railthumb")!;
      expect([thumb.style.top, parseFloat(thumb.style.height).toFixed(1)]).toEqual(["0%", "33.3"]);
      // Nothing listens on it: a touch there is the browser's, to scroll.
      expect(page.win.getComputedStyle(page.camera("rail")).touchAction).toBe("pan-y");
      // The Camera tab is no board: no strip.
      [...page.doc.querySelectorAll<HTMLElement>("#tabs [role=tab]")].find((each) => each.textContent === "Camera")!.click();
      expect(strip(page).slice(0, 2)).toEqual([false, false]);
    });
  });

  /* ------------------------------------------------------------------------ combinations */

  it("K with a short rest asks for both: on the knob AND rested 100 ms", async () => {
    const attempt = async (landing: number, rest: number): Promise<number> => {
      const page = openPage({ touch: "knobhold" });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom");
      page.pointer("pointerdown", bloom, landing, 100);
      page.elapse(rest);
      page.pointer("pointermove", bloom, landing + 12, 100);
      page.pointer("pointerup", bloom, landing + 52, 100);
      await page.drain();
      return sent(page).length;
    };
    expect([await attempt(50, 100), await attempt(50, 99), await attempt(150, 100)]).toEqual([1, 0, 0]);
  });

  /* ----------------------------------------------------------------------- the setting */

  describe("the Touch control — on the phone page, kept by the phone", () => {
    it("offers every mode by its letter and what it does, and starts on K when the phone has kept nothing", () => {
      const page = openPage();
      const select = page.camera("touchMode") as HTMLSelectElement;
      expect([...select.options].map((option) => [option.value, option.textContent])).toEqual(KEYS.map((key) => [key, `${MODES[key]!.letter} · ${MODES[key]!.says}`]));
      expect(select.value).toBe("knob");
      expect(page.camera("touchNow").textContent).toBe("K");
      expect(classes(page)).toEqual(["knobs"]);
      expect(page.win.localStorage.getItem(PHONE_TRIAL_STORAGE_KEY)).toBeNull();
    });

    it("a choice takes effect at once, is kept on the phone, and is there on the next visit", async () => {
      const page = openPage();
      page.snapshot(SNAPSHOT);
      choose(page, "touchMode", "now");
      expect([page.camera("touchNow").textContent, classes(page)]).toEqual(["A", []]);
      // At once: a slider now takes a touch that lands far from its knob.
      const bloom = track(page, "Bloom");
      page.pointer("pointerdown", bloom, 150, 100);
      page.pointer("pointermove", bloom, 162, 100);
      page.pointer("pointerup", bloom, 202, 100);
      await page.drain();
      expect(sent(page)).toEqual([{ handle: "h-bloom", values: { value: 0.45 }, phase: "commit" }]);
      const kept = page.win.localStorage.getItem(PHONE_TRIAL_STORAGE_KEY);
      expect(JSON.parse(kept ?? "null")).toEqual({ touch: "now", rows: 36 });

      const again = openPage({ storage: { [PHONE_TRIAL_STORAGE_KEY]: kept! } });
      expect([(again.camera("touchMode") as HTMLSelectElement).value, again.camera("touchNow").textContent]).toEqual(["now", "A"]);
    });

    it("each mode puts its own marks on the page, and leaves none of another's", () => {
      const page = openPage();
      const marks: Record<string, string[]> = {};
      for (const key of KEYS) {
        choose(page, "touchMode", key);
        marks[key] = classes(page);
      }
      expect(marks).toEqual({
        knob: ["knobs"],
        hold: [],
        lock: ["locking"],
        gutter: ["gutter"],
        gutterleft: ["gutter", "railleft"],
        now: [],
        knobgutter: ["gutter", "knobs"],
        knobhold: ["knobs"],
      });
    });

    it("what the phone kept that is not a choice — nothing, junk, a mode since deleted — is the default", () => {
      for (const kept of ["", "[1,2", "null", '"knob"', JSON.stringify({ touch: "pinch", rows: 9 }), JSON.stringify({ touch: 3, rows: "36" })]) {
        const page = openPage({ storage: { [PHONE_TRIAL_STORAGE_KEY]: kept } });
        expect([(page.camera("touchMode") as HTMLSelectElement).value, (page.camera("rowsMode") as HTMLSelectElement).value], kept).toEqual(["knob", "36"]);
      }
    });

    it("changing the mode with a slider in hand lets it go where it is", async () => {
      const page = openPage({ touch: "now" });
      page.snapshot(SNAPSHOT);
      const bloom = track(page, "Bloom");
      const at = take(page, bloom);
      page.pointer("pointermove", bloom, at.x + 40, at.y);
      page.frame();
      choose(page, "touchMode", "hold");
      page.pointer("pointermove", bloom, at.x + 120, at.y);
      page.pointer("pointerup", bloom, at.x + 120, at.y);
      await page.drain();
      expect(sent(page)).toEqual([
        { handle: "h-bloom", values: { value: 0.45 }, phase: "live" },
        { handle: "h-bloom", values: { value: 0.45 }, phase: "commit" },
      ]);
    });
  });

  /* --------------------------------------------------------------------- the row's height */

  describe("Rows — how tall a row is drawn (§B269's floor), tried in the same sitting", () => {
    const row = (page: Page): string => page.doc.body.style.getPropertyValue("--row");

    it("offers 32, 36 and 44 px, starts at 36, and a choice is the floor at once and on the next visit", () => {
      const page = openPage();
      const select = page.camera("rowsMode") as HTMLSelectElement;
      expect([...select.options].map((option) => option.value)).toEqual(["32", "36", "44"]);
      expect([select.value, page.camera("rowsNow").textContent, row(page)]).toEqual(["36", "36", "36px"]);
      choose(page, "rowsMode", "44");
      expect([page.camera("rowsNow").textContent, row(page)]).toEqual(["44", "44px"]);
      const kept = page.win.localStorage.getItem(PHONE_TRIAL_STORAGE_KEY);
      expect(JSON.parse(kept ?? "null")).toEqual({ touch: "knob", rows: 44 });
      const again = openPage({ storage: { [PHONE_TRIAL_STORAGE_KEY]: kept! } });
      expect(row(again)).toBe("44px");
      expect(row(openPage({ rows: 32 }))).toBe("32px");
    });

    it("the two choices are kept together and do not disturb each other", () => {
      const page = openPage();
      choose(page, "rowsMode", "32");
      choose(page, "touchMode", "hold");
      expect(JSON.parse(page.win.localStorage.getItem(PHONE_TRIAL_STORAGE_KEY) ?? "null")).toEqual({ touch: "hold", rows: 32 });
      expect([row(page), page.camera("touchNow").textContent]).toEqual(["32px", "H"]);
    });
  });
});
