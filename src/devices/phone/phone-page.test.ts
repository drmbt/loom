import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import { PHONE_EXPIRED_SENTENCE, PHONE_NAME_STORAGE_KEY, PHONE_TAB_STORAGE_KEY, phonePageHtml } from "./phone-page.ts";
import {
  PHONE_EVENTS_PATH,
  PHONE_SET_PATH,
  PHONE_SIGNAL_PATH,
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

function openPage(options: { hello?: boolean; camera?: CameraOptions; storage?: Record<string, string> } = {}) {
  const frames: (() => void)[] = [];
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
    const early = { kind: "ice", candidate: "candidate:9 1 udp 1 fd00::1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 } as const;
    signal(page, early);
    expect(peer.remoteIce).toEqual([]);
    signal(page, { kind: "answer", sdp: "ANSWER-SDP" });
    await page.flush();
    expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "ANSWER-SDP" });
    const late = { kind: "ice", candidate: "candidate:10 1 udp 1 192.168.1.20 5001 typ host", sdpMid: "0", sdpMLineIndex: 0 } as const;
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
    const slider = { kind: "slider", handle: "h-x", caption: "Wide", value: 0, min: 0, max: 1, step: 0 } as const;
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
    page.pointer("pointerdown", bloom, 50);
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
