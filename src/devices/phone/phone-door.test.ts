import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PHONE_DOOR_MAX_PHONES,
  createPhoneDoor,
  ensurePhoneCertificate,
  pickLanAddress,
  type PhoneDoor,
  type PhoneDoorOptions,
  type PhoneDoorSink,
} from "./phone-door.ts";
import { phonePageHtml } from "./phone-page.ts";
import {
  PHONE_EVENTS_PATH,
  PHONE_PAGE_PATH,
  PHONE_PEER_PARAM,
  PHONE_SDP_MAX_CHARS,
  PHONE_SET_PATH,
  PHONE_SIGNAL_MAX_BYTES,
  PHONE_SIGNAL_PATH,
  PHONE_VALUE_MAX_CHARS,
  type PhoneDoorState,
  type PhoneEvent,
  type PhoneSet,
  type PhoneSignalFromPhone,
  type PhoneSignalToPhone,
  type PhoneSnapshot,
} from "./phone-protocol.ts";
import { createDeviceDoors } from "../doors.ts";
import { DEVICE_HELPER_PHONE_COMMAND, HELPER_PHONE_BANNER, PHONE_DOOR_UNAVAILABLE } from "../helper.ts";
import { createDeviceHelper } from "../../mcp/serve.ts";

/**
 * T1396b — THE PHONE DOOR, OVER REAL TLS SOCKETS.
 *
 * Nothing here stubs `node:https`: the certificate is a real one made by the real `openssl`,
 * the server is the door's own, and the client is Node's `https.request` PINNING that
 * certificate as its only CA — which is what a phone does after its owner accepts it once.
 * The single injection is the address: a gate binds 127.0.0.1 because a CI box has no LAN,
 * and the production picker is proven separately never to return what the gate uses.
 *
 * What each block defends, in the owner's words: "stuff that we selectively publish" is the
 * snapshot fan-out; "drive stuff from our phone" is the relayed write; "same wifi" and the
 * one-session token are the address picker, the 403s and the token dying at close.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

let sharedCertDir = "";
beforeAll(() => {
  sharedCertDir = mkdtempSync(join(tmpdir(), "loom-phone-door-"));
});
afterAll(() => {
  rmSync(sharedCertDir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Recorded {
  readonly writes: Array<{ phone: string; set: PhoneSet }>;
  readonly states: PhoneDoorState[];
  readonly signals: Array<{ phone: string; message: PhoneSignalFromPhone }>;
}

function recorder(): Recorded & PhoneDoorSink {
  const writes: Array<{ phone: string; set: PhoneSet }> = [];
  const states: PhoneDoorState[] = [];
  const signals: Array<{ phone: string; message: PhoneSignalFromPhone }> = [];
  return {
    writes,
    states,
    signals,
    onWrite: (phone, set) => writes.push({ phone, set }),
    onState: (state) => states.push(state),
    onSignal: (phone, message) => signals.push({ phone, message }),
  };
}

async function openDoor(
  options: PhoneDoorOptions = {},
): Promise<{ door: PhoneDoor; state: Extract<PhoneDoorState, { open: true }>; sink: ReturnType<typeof recorder>; ca: string }> {
  const certDir = options.certDir ?? sharedCertDir;
  const door = createPhoneDoor({ lanAddress: () => "127.0.0.1", port: 0, certDir, ...options });
  cleanups.push(() => door.dispose());
  const sink = recorder();
  const state = await door.open(sink);
  if (!state.open) throw new Error(`the door did not open: ${state.reason}`);
  return { door, state, sink, ca: readFileSync(join(certDir, "cert.pem"), "utf8") };
}

/** The same URL with its path and token replaced — how a test reaches each route. */
function at(url: string, path: string, token?: string | null): string {
  const parsed = new URL(url);
  parsed.pathname = path;
  if (token === null) parsed.searchParams.delete("t");
  else if (token !== undefined) parsed.searchParams.set("t", token);
  return parsed.toString();
}

/** T1397b: a camera signal to the door naming `phone` — or, with null, naming none. */
function postSignal(doorUrl: string, ca: string, phone: string | null, body: string, token?: string | null): Promise<Answer> {
  const url = new URL(at(doorUrl, PHONE_SIGNAL_PATH, token));
  if (phone !== null) url.searchParams.set(PHONE_PEER_PARAM, phone);
  return fetchPinned(url.toString(), ca, { method: "POST", body });
}

/** A write to the door naming `phone` in `PHONE_PEER_PARAM` — or, with null, naming none. */
function postSet(doorUrl: string, ca: string, phone: string | null, body = JSON.stringify(A_SET)): Promise<Answer> {
  const url = new URL(at(doorUrl, PHONE_SET_PATH));
  if (phone !== null) url.searchParams.set(PHONE_PEER_PARAM, phone);
  return fetchPinned(url.toString(), ca, { method: "POST", body });
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly peerFingerprint: string;
}

function fetchPinned(
  url: string,
  ca: string,
  init: { method?: string; body?: string; userAgent?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        ca,
        agent: false,
        headers: {
          ...(init.userAgent === undefined ? {} : { "User-Agent": init.userAgent }),
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      },
      (res) => {
        const peer = (res.socket as import("node:tls").TLSSocket).getPeerCertificate();
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            peerFingerprint: peer.fingerprint256,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

interface Stream {
  readonly status: number;
  /** The id this stream said in its `hello` — which the door guarantees is its FIRST event. */
  readonly phone: string;
  /** Every event AFTER the hello. */
  readonly events: PhoneEvent[];
  readonly comments: string[];
  ended: boolean;
  close(): void;
}

/**
 * A phone's event stream, parsed the way `EventSource` does: blocks split on a blank line.
 * Resolves once the stream has said `hello`, as the phone page waits for it before writing;
 * REJECTS if anything else came first.
 */
function openStream(url: string, ca: string, userAgent = "PhoneTest/1.0"): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { ca, agent: false, headers: { "User-Agent": userAgent } }, (res) => {
      let buffer = "";
      let greeted = false;
      const stream: Stream & { phone: string } = {
        status: res.statusCode ?? 0,
        phone: "",
        events: [],
        comments: [],
        ended: false,
        close: () => req.destroy(),
      };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let cut = buffer.indexOf("\n\n");
        while (cut !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              const event = JSON.parse(line.slice(6)) as PhoneEvent;
              if (!greeted) {
                greeted = true;
                if (event.type !== "hello") reject(new Error(`the first event was ${event.type}, not hello`));
                else {
                  stream.phone = event.phone;
                  resolve(stream);
                }
                continue;
              }
              stream.events.push(event);
            }
            else if (line.startsWith(":")) stream.comments.push(line);
          }
          cut = buffer.indexOf("\n\n");
        }
      });
      res.on("end", () => {
        stream.ended = true;
      });
      res.on("error", () => {
        stream.ended = true;
      });
      if (stream.status !== 200) resolve(stream);
    });
    req.on("error", reject);
    req.end();
    cleanups.push(() => {
      req.destroy();
    });
  });
}

const SNAPSHOT_A: PhoneSnapshot = {
  seq: 1,
  panels: [
    {
      title: "Stage",
      rows: [{ kind: "widgets", widgets: [{ kind: "slider", handle: "h1", caption: "Glow", value: 0.25, min: 0, max: 1, step: 0 }] }],
    },
  ],
};
const SNAPSHOT_B: PhoneSnapshot = {
  seq: 2,
  panels: [{ title: "Stage", rows: [{ kind: "widgets", widgets: [{ kind: "toggle", handle: "h2", caption: "Strobe", on: true }] }] }],
};
const A_SET: PhoneSet = { handle: "h1", values: { value: 0.75 }, phase: "live" };

function iface(address: string, internal = false, family: "IPv4" | "IPv6" = "IPv4"): NetworkInterfaceInfo {
  return { address, internal, family, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null } as NetworkInterfaceInfo;
}

describe("the door binds the LAN and nothing else (T1396b)", () => {
  /*
   * The gates below bind 127.0.0.1 through the injection; production never may. So the
   * picker is asked about every kind of address a Mac actually carries, and must return
   * only a private IPv4 — loopback, link-local, CGNAT (an overlay VPN), public and IPv6
   * all refused, and "none" said as null rather than a guess.
   */
  it("never picks loopback, internal, link-local, CGNAT, public or IPv6 — and says null when that is all there is", () => {
    const hostile = {
      lo0: [iface("127.0.0.1", true), iface("::1", true, "IPv6")],
      lo1: [iface("127.0.0.2")],
      utun3: [iface("100.64.12.7")],
      en5: [iface("169.254.10.2"), iface("fe80::1", false, "IPv6")],
      en6: [iface("8.8.8.8"), iface("172.15.255.1"), iface("172.32.0.1"), iface("192.169.0.1"), iface("11.0.0.1")],
      internalLan: [iface("192.168.9.9", true)],
    };
    expect(pickLanAddress(hostile)).toBeNull();
    expect(pickLanAddress({ ...hostile, en0: [iface("192.168.1.20")] })).toBe("192.168.1.20");
    expect(pickLanAddress({ ...hostile, en0: [iface("10.0.0.5")] })).toBe("10.0.0.5");
    expect(pickLanAddress({ ...hostile, en0: [iface("172.16.0.1")] })).toBe("172.16.0.1");
    expect(pickLanAddress({ ...hostile, en0: [iface("172.31.255.254")] })).toBe("172.31.255.254");
  });

  /*
   * Which private address, when there are several. OS order used to decide, and a laptop
   * with a VPN up lists its tunnel beside its wifi — so a phone on the wifi was handed a URL
   * on the VPN. Each row lists the LOSER first, so "first wins" fails every one of them.
   */
  it("ranks 192.168 over 172.16 over 10, and within a range the wifi/ethernet over a tunnel", () => {
    const rows: Array<[NodeJS.Dict<NetworkInterfaceInfo[]>, string]> = [
      [{ en1: [iface("10.0.0.5")], en0: [iface("192.168.1.20")] }, "192.168.1.20"],
      [{ en1: [iface("10.0.0.5")], en0: [iface("172.20.1.2")] }, "172.20.1.2"],
      [{ en1: [iface("172.20.1.2")], en0: [iface("192.168.1.20")] }, "192.168.1.20"],
      // The case the ranking exists for: work VPN on 10.x listed ahead of wifi.
      [{ utun4: [iface("10.8.0.2")], en0: [iface("192.168.1.20")] }, "192.168.1.20"],
      // Same range: the tunnel loses to the physical interface, whatever the order.
      [{ utun4: [iface("10.8.0.2")], en0: [iface("10.1.2.3")] }, "10.1.2.3"],
      [{ wg0: [iface("192.168.50.2")], wlan0: [iface("192.168.1.9")] }, "192.168.1.9"],
      [{ tailscale0: [iface("10.9.9.9")], eth0: [iface("10.0.0.40")] }, "10.0.0.40"],
      [{ ppp0: [iface("172.16.5.5")], tun0: [iface("172.16.6.6")], en2: [iface("172.16.7.7")] }, "172.16.7.7"],
      // Unrecognised names sit between: a bridge beats a tunnel, loses to en*.
      [{ utun2: [iface("10.2.0.1")], bridge0: [iface("10.3.0.1")] }, "10.3.0.1"],
      [{ bridge0: [iface("10.3.0.1")], en0: [iface("10.4.0.1")] }, "10.4.0.1"],
      // Only a tunnel has a private address: it is still the answer, not null.
      [{ utun4: [iface("10.8.0.2")], lo0: [iface("127.0.0.1", true)] }, "10.8.0.2"],
    ];
    for (const [interfaces, expected] of rows) {
      expect(pickLanAddress(interfaces), JSON.stringify(Object.keys(interfaces))).toBe(expected);
    }
  });

  it("the real machine's answer obeys the same rule, whatever network this runs on", () => {
    const real = pickLanAddress();
    if (real !== null) expect(real).toMatch(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/);
  });

  it("refuses to open, in words, when there is no LAN address", async () => {
    const door = createPhoneDoor({ lanAddress: () => null, port: 0, certDir: sharedCertDir });
    cleanups.push(() => door.dispose());
    const state = await door.open(recorder());
    expect(state.open).toBe(false);
    expect(!state.open && state.reason).toContain("private LAN address");
  });
});

describe("the page, the token and the 403 (T1396b)", () => {
  it("serves the phone page to a request carrying the token, over the certificate the page is told about", async () => {
    const { state, ca } = await openDoor();
    expect(state.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{22}$/);
    const page = await fetchPinned(state.url, ca);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toBe(phonePageHtml());
    // What the phone's TLS stack sees IS what the editor shows next to the QR code.
    expect(page.peerFingerprint).toBe(state.fingerprint);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(Object.keys(page.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
  });

  it("answers a bare 403 on every path without the token or with a wrong one — and 404 only past the token", async () => {
    const { state, ca, sink } = await openDoor();
    const token = new URL(state.url).searchParams.get("t") ?? "";
    // Same length, one character off: the constant-time compare must still say no.
    const wrong = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const routes: Array<{ path: string; method: string; body?: string }> = [
      { path: PHONE_PAGE_PATH, method: "GET" },
      { path: PHONE_EVENTS_PATH, method: "GET" },
      { path: PHONE_SET_PATH, method: "POST", body: JSON.stringify(A_SET) },
      { path: "/favicon.ico", method: "GET" },
    ];
    for (const route of routes) {
      for (const given of [null, "", wrong]) {
        const answer = await fetchPinned(at(state.url, route.path, given), ca, {
          method: route.method,
          ...(route.body === undefined ? {} : { body: route.body }),
        });
        expect(answer.status, `${route.method} ${route.path} with ${String(given)}`).toBe(403);
        expect(answer.body).toBe("");
      }
    }
    expect(sink.writes).toEqual([]);
    expect(sink.states).toEqual([]);
    // The legitimate case the 403 must not swallow: a real token on an unknown path is a 404.
    expect((await fetchPinned(at(state.url, "/favicon.ico"), ca)).status).toBe(404);
  });
});

describe("the snapshot reaches every phone (T1396b)", () => {
  it("delivers the snapshot published BEFORE a phone connected, then every later one", async () => {
    const { door, state, ca, sink } = await openDoor();
    door.publish(SNAPSHOT_A);
    const phone = await openStream(at(state.url, PHONE_EVENTS_PATH), ca, "iPhone Test");
    expect(phone.status).toBe(200);
    await until(() => phone.events.length === 1, "the first snapshot");
    expect(phone.events[0]).toEqual({ type: "snapshot", snapshot: SNAPSHOT_A });
    door.publish(SNAPSHOT_B);
    await until(() => phone.events.length === 2, "the second snapshot");
    expect(phone.events[1]).toEqual({ type: "snapshot", snapshot: SNAPSHOT_B });
    // The page learns a phone arrived, with what its browser called itself.
    const arrived = sink.states.at(-1);
    expect(arrived?.open === true && arrived.phones.map((peer) => peer.userAgent)).toEqual(["iPhone Test"]);
    // …and that it left.
    phone.close();
    await until(() => {
      const last = sink.states.at(-1);
      return last?.open === true && last.phones.length === 0;
    }, "the phone to leave");
  });

  it("sends nothing before the page publishes, and keeps an idle stream alive with a comment", async () => {
    const { state, ca } = await openDoor({ keepaliveMs: 30 });
    const phone = await openStream(at(state.url, PHONE_EVENTS_PATH), ca);
    await until(() => phone.comments.length >= 1, "a keepalive");
    expect(phone.comments[0]).toBe(": keepalive");
    expect(phone.events).toEqual([]);
  });

  it(`refuses the ${String(PHONE_DOOR_MAX_PHONES + 1)}th phone with a 429 and keeps serving the ${String(PHONE_DOOR_MAX_PHONES)}`, async () => {
    const { door, state, ca } = await openDoor();
    const phones: Stream[] = [];
    for (let index = 0; index < PHONE_DOOR_MAX_PHONES; index += 1) {
      phones.push(await openStream(at(state.url, PHONE_EVENTS_PATH), ca));
    }
    expect(phones.map((phone) => phone.status)).toEqual(phones.map(() => 200));
    const extra = await fetchPinned(at(state.url, PHONE_EVENTS_PATH), ca);
    expect(extra.status).toBe(429);
    expect(extra.body).toContain(String(PHONE_DOOR_MAX_PHONES));
    door.publish(SNAPSHOT_A);
    await until(() => phones.every((phone) => phone.events.length === 1), "all eight to hear the snapshot");
  });
});

describe("a phone's write reaches the page exactly, under the phone that sent it, or not at all (T1396b)", () => {
  it("relays exactly the PhoneSet, attributed to the phone its `p` names, and answers 204", async () => {
    const { state, ca, sink } = await openDoor();
    const phone = await openStream(at(state.url, PHONE_EVENTS_PATH), ca);
    // The id the stream said in `hello` IS the id the page is told about.
    const arrived = sink.states.at(-1);
    expect(arrived?.open === true && arrived.phones.map((peer) => peer.phone)).toEqual([phone.phone]);
    const answer = await postSet(state.url, ca, phone.phone);
    expect(answer.status).toBe(204);
    expect(sink.writes).toEqual([{ phone: phone.phone, set: A_SET }]);
  });

  /*
   * THE GAP THIS CLOSES: two tabs on one phone are one address and two streams. Guessing by
   * address credited both tabs' writes to whichever stream opened last, so undo and
   * ownership ("per phone", §T1396b) were per ADDRESS. Each write now carries its stream.
   */
  it("tells two streams from ONE address apart: each write lands under the stream it names", async () => {
    const { state, ca, sink } = await openDoor();
    const tabA = await openStream(at(state.url, PHONE_EVENTS_PATH), ca, "Tab A");
    const tabB = await openStream(at(state.url, PHONE_EVENTS_PATH), ca, "Tab B");
    expect(tabA.phone).not.toBe(tabB.phone);
    const setA: PhoneSet = { handle: "h1", values: { value: 0.1 }, phase: "commit" };
    const setB: PhoneSet = { handle: "h1", values: { value: 0.9 }, phase: "commit" };
    // A first, then B: the OLDER stream's write must not be credited to the newer one.
    expect((await postSet(state.url, ca, tabA.phone, JSON.stringify(setA))).status).toBe(204);
    expect((await postSet(state.url, ca, tabB.phone, JSON.stringify(setB))).status).toBe(204);
    expect(sink.writes).toEqual([
      { phone: tabA.phone, set: setA },
      { phone: tabB.phone, set: setB },
    ]);
  });

  it("refuses with 409 and a sentence — relaying nothing — a write naming no phone, an unknown one, or one whose stream closed", async () => {
    const { state, ca, sink } = await openDoor();
    const gone = await openStream(at(state.url, PHONE_EVENTS_PATH), ca);
    const live = await openStream(at(state.url, PHONE_EVENTS_PATH), ca);
    gone.close();
    await until(() => {
      const last = sink.states.at(-1);
      return last?.open === true && last.phones.length === 1;
    }, "the closed stream to leave");
    for (const phone of [null, "", "not-a-phone", gone.phone]) {
      const answer = await postSet(state.url, ca, phone);
      expect(answer.status, `p=${String(phone)}`).toBe(409);
      expect(answer.body).toContain("Reconnecting");
    }
    expect(sink.writes).toEqual([]);
    // The legitimate case the 409 must not swallow: the stream still open is served.
    expect((await postSet(state.url, ca, live.phone)).status).toBe(204);
    expect(sink.writes).toEqual([{ phone: live.phone, set: A_SET }]);
  });

  it("refuses oversized and malformed bodies with a sentence, and relays none of them", async () => {
    const { state, ca, sink } = await openDoor();
    const phone = await openStream(at(state.url, PHONE_EVENTS_PATH), ca);
    const bodies = [
      JSON.stringify({ ...A_SET, values: { value: 1, pad: "x".repeat(5000) } }),
      JSON.stringify({ handle: "h1", values: { value: 1 }, phase: "live", pad: "y".repeat(4100) }),
      "not json",
      JSON.stringify([A_SET]),
      JSON.stringify({ values: { value: 1 }, phase: "live" }),
      // T1503b: a value may be a NAME, but not a longer one than a name is, and nothing nested.
      JSON.stringify({ handle: "h1", values: { recall: "x".repeat(PHONE_VALUE_MAX_CHARS + 1) }, phase: "commit" }),
      JSON.stringify({ handle: "h1", values: { recall: { name: "soft" } }, phase: "commit" }),
      JSON.stringify({ handle: "h1", values: { recall: null }, phase: "commit" }),
      JSON.stringify({ handle: "h1", values: [1], phase: "live" }),
      JSON.stringify({ handle: "h1", values: { value: 1 }, phase: "later" }),
    ];
    for (const body of bodies) {
      const answer = await postSet(state.url, ca, phone.phone, body);
      expect(answer.status, body.slice(0, 60)).toBe(400);
      expect(answer.body.length, "a 400 says why").toBeGreaterThan(10);
    }
    expect(sink.writes).toEqual([]);
  });

  /*
   * T1503b: `recall` and `standby` carry a preset's or a cue's NAME. The door hands the page
   * the string exactly as sent — which name is real is the page's vet, against the document.
   */
  it("relays a write whose value is a name, as sent — up to the longest a name may be", async () => {
    const { state, ca, sink } = await openDoor();
    const phone = await openStream(at(state.url, PHONE_EVENTS_PATH), ca);
    const recall: PhoneSet = { handle: "bank1", values: { recall: "hard" }, phase: "commit" };
    const longest: PhoneSet = { handle: "set1", values: { standby: "c".repeat(PHONE_VALUE_MAX_CHARS) }, phase: "commit" };
    expect((await postSet(state.url, ca, phone.phone, JSON.stringify(recall))).status).toBe(204);
    expect((await postSet(state.url, ca, phone.phone, JSON.stringify(longest))).status).toBe(204);
    expect(sink.writes).toEqual([
      { phone: phone.phone, set: recall },
      { phone: phone.phone, set: longest },
    ]);
  });
});

/*
 * T1397b — THE CAMERA HANDSHAKE THROUGH THE DOOR. The helper relays signalling only, so
 * what it must get right is WHO: a phone's offer reaches the page under that phone's id,
 * the page's answer reaches THAT phone's stream and no other, and nothing crosses without
 * the token, a named open stream and a body inside its caps.
 */
const OFFER = { kind: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n", name: "Back cam" } as const;
const ANSWER: PhoneSignalToPhone = { kind: "answer", sdp: "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n" };

describe("a phone's camera handshake is relayed, to and from the phone that sent it, and nothing else (T1397b)", () => {
  it("relays the phone's offer to the page under its `p`, extra keys stripped, and the page's answer down that phone's stream only", async () => {
    const { door, state, ca, sink } = await openDoor();
    const sender = await openStream(at(state.url, PHONE_EVENTS_PATH), ca, "Sender");
    const bystander = await openStream(at(state.url, PHONE_EVENTS_PATH), ca, "Bystander");
    const answer = await postSignal(state.url, ca, sender.phone, JSON.stringify({ ...OFFER, smuggled: "x" }));
    expect(answer.status).toBe(204);
    expect(sink.signals).toEqual([{ phone: sender.phone, message: OFFER }]);

    expect(door.signal(sender.phone, ANSWER)).toBe(true);
    const ice: PhoneSignalToPhone = { kind: "ice", candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    expect(door.signal(sender.phone, ice)).toBe(true);
    await until(() => sender.events.length === 2, "the answer and the candidate on the sender's stream");
    expect(sender.events).toEqual([
      { type: "signal", message: ANSWER },
      { type: "signal", message: ice },
    ]);
    // A phone that is not connected is told nothing, and the door says so.
    expect(door.signal("not-a-phone", ANSWER)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bystander.events).toEqual([]);
  });

  it("refuses without the token (403), without an open named stream (409), and past the caps or the shape (400) — relaying none of them", async () => {
    const { state, ca, sink } = await openDoor();
    const phone = await openStream(at(state.url, PHONE_EVENTS_PATH), ca);
    const offer = JSON.stringify(OFFER);
    expect((await postSignal(state.url, ca, phone.phone, offer, null)).status).toBe(403);
    for (const named of [null, "", "not-a-phone"]) {
      expect((await postSignal(state.url, ca, named, offer)).status, `p=${String(named)}`).toBe(409);
    }
    const bodies = [
      // Over the byte cap: the door stops reading.
      JSON.stringify({ ...OFFER, sdp: "x".repeat(PHONE_SIGNAL_MAX_BYTES) }),
      // Under the byte cap, over the SDP's own.
      JSON.stringify({ ...OFFER, sdp: "x".repeat(PHONE_SDP_MAX_CHARS + 1) }),
      JSON.stringify({ ...OFFER, name: "n".repeat(41) }),
      JSON.stringify({ kind: "offer", name: "no sdp" }),
      // A phone does not answer; only the page does.
      JSON.stringify(ANSWER),
      JSON.stringify({ kind: "ice", candidate: 7, sdpMid: "0", sdpMLineIndex: 0 }),
      JSON.stringify({ kind: "ice", candidate: "c", sdpMid: "0", sdpMLineIndex: -1 }),
      JSON.stringify([OFFER]),
      "not json",
    ];
    for (const body of bodies) {
      const answer = await postSignal(state.url, ca, phone.phone, body);
      expect(answer.status, body.slice(0, 60)).toBe(400);
      expect(answer.body.length, "a 400 says why").toBeGreaterThan(10);
    }
    expect(sink.signals).toEqual([]);
    // The legitimate case none of those refusals may swallow: a bye, and a candidate with no mid.
    expect((await postSignal(state.url, ca, phone.phone, JSON.stringify({ kind: "bye" }))).status).toBe(204);
    const ice = { kind: "ice", candidate: "candidate:2 1 udp 1 10.0.0.3 5001 typ host", sdpMid: null, sdpMLineIndex: null };
    expect((await postSignal(state.url, ca, phone.phone, JSON.stringify(ice))).status).toBe(204);
    expect(sink.signals).toEqual([
      { phone: phone.phone, message: { kind: "bye" } },
      { phone: phone.phone, message: ice },
    ]);
  });

  it("a closed door relays nothing either way", async () => {
    const { door, state, ca, sink } = await openDoor();
    const phone = await openStream(at(state.url, PHONE_EVENTS_PATH), ca);
    door.close("closed for the test");
    await until(() => phone.ended, "the stream to end");
    expect(door.signal(phone.phone, ANSWER)).toBe(false);
    await expect(postSignal(state.url, ca, phone.phone, JSON.stringify(OFFER))).rejects.toThrow();
    expect(sink.signals).toEqual([]);
  });
});

describe("closing the door (T1396b)", () => {
  it("tells every phone `closed`, ends the streams, and the token dies with the opening", async () => {
    const { door, state, ca } = await openDoor();
    const phones = [
      await openStream(at(state.url, PHONE_EVENTS_PATH), ca),
      await openStream(at(state.url, PHONE_EVENTS_PATH), ca),
    ];
    const closed = door.close("the owner closed it");
    expect(closed.open).toBe(false);
    await until(() => phones.every((phone) => phone.ended), "both streams to end");
    for (const phone of phones) expect(phone.events.at(-1)).toEqual({ type: "closed", reason: "the owner closed it" });
    await expect(fetchPinned(state.url, ca)).rejects.toThrow();
    // Reopened: a NEW token, and the old one is a 403 on the new listener.
    const again = await door.open(recorder());
    if (!again.open) throw new Error(again.reason);
    const oldToken = new URL(state.url).searchParams.get("t");
    expect(new URL(again.url).searchParams.get("t")).not.toBe(oldToken);
    expect((await fetchPinned(at(again.url, PHONE_PAGE_PATH, oldToken), ca)).status).toBe(403);
    expect((await fetchPinned(again.url, ca)).status).toBe(200);
  });

  it("falls back to an ephemeral port when the preferred one is taken", async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const taken = (blocker.address() as AddressInfo).port;
    const { state, ca } = await openDoor({ port: taken });
    expect(new URL(state.url).port).not.toBe(String(taken));
    expect((await fetchPinned(state.url, ca)).status).toBe(200);
  });
});

describe("the certificate: made once, kept, remade when it no longer fits (T1396b)", () => {
  it("persists the certificate across openings — same fingerprint — with a private key only the user can read", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "loom-phone-cert-"));
    cleanups.push(() => rmSync(certDir, { recursive: true, force: true }));
    const first = await openDoor({ certDir });
    first.door.close("first session over");
    const second = await openDoor({ certDir });
    expect(second.state.fingerprint).toBe(first.state.fingerprint);
    expect(statSync(certDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(certDir, "key.pem")).mode & 0o777).toBe(0o600);
    const x509 = new X509Certificate(readFileSync(join(certDir, "cert.pem")));
    expect(x509.subject).toBe("CN=Loom phone door");
    expect(x509.checkIP("127.0.0.1")).toBe("127.0.0.1");
    const days = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / 86_400_000;
    expect(Math.round(days)).toBe(365);
  });

  it("remakes the certificate when the LAN address moved out of its SAN, and keeps the new one", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "loom-phone-cert-"));
    cleanups.push(() => rmSync(certDir, { recursive: true, force: true }));
    const home = await ensurePhoneCertificate({ dir: certDir, ip: "192.168.1.20" });
    const moved = await ensurePhoneCertificate({ dir: certDir, ip: "10.0.0.7" });
    expect(moved.fingerprint).not.toBe(home.fingerprint);
    expect(new X509Certificate(moved.cert).checkIP("10.0.0.7")).toBe("10.0.0.7");
    expect(new X509Certificate(moved.cert).checkIP("192.168.1.20")).toBeUndefined();
    expect((await ensurePhoneCertificate({ dir: certDir, ip: "10.0.0.7" })).fingerprint).toBe(moved.fingerprint);
  });

  it("remakes an expired certificate", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "loom-phone-cert-"));
    cleanups.push(() => rmSync(certDir, { recursive: true, force: true }));
    const made = await ensurePhoneCertificate({ dir: certDir, ip: "192.168.1.20" });
    const expiry = Date.parse(new X509Certificate(made.cert).validTo);
    const later = await ensurePhoneCertificate({ dir: certDir, ip: "192.168.1.20", now: () => expiry + 1 });
    expect(later.fingerprint).not.toBe(made.fingerprint);
  });

  it("refuses to open — never plain HTTP — when openssl is missing, and says so", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "loom-phone-cert-"));
    cleanups.push(() => rmSync(certDir, { recursive: true, force: true }));
    const door = createPhoneDoor({
      lanAddress: () => "127.0.0.1",
      port: 0,
      certDir,
      openssl: "/nonexistent/openssl",
    });
    cleanups.push(() => door.dispose());
    const state = await door.open(recorder());
    expect(state.open).toBe(false);
    expect(!state.open && state.reason).toContain("/nonexistent/openssl");
    expect(!state.open && state.reason).toContain("PATH");
    expect(door.state()).toEqual(state);
  });
});

/**
 * THE DOOR THROUGH THE LOOPBACK BRIDGE. The device client is a real WebSocket against the
 * real devices-only helper; the phone is a real HTTPS client. What is asserted is what the
 * page reads off its socket (`phoneOpened`, `phoneState`, `phoneWrite`) and what the phone
 * reads off its stream.
 */
describe("the phone door over the device bridge (T1396b)", () => {
  async function helperWith(phone: boolean): Promise<{ port: number; code: string }> {
    const handoffDir = mkdtempSync(join(tmpdir(), "loom-phone-helper-"));
    const helper = createDeviceHelper({
      port: 0,
      handoffDir,
      doors: createDeviceDoors({
        udpSocketFactory: () => {
          throw new Error("no UDP in this test");
        },
        ...(phone ? { phone: { enabled: true, lanAddress: () => "127.0.0.1", port: 0, certDir: sharedCertDir } } : {}),
      }),
    });
    cleanups.push(() => {
      helper.dispose();
      rmSync(handoffDir, { recursive: true, force: true });
    });
    await until(() => helper.status().port != null, "the helper to bind");
    return { port: helper.status().port ?? 0, code: helper.pairingCode };
  }

  async function attachDevice(helper: { port: number; code: string }): Promise<{
    socket: WebSocket;
    received: Array<Record<string, unknown>>;
  }> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(helper.port)}`);
    const received: Array<Record<string, unknown>> = [];
    socket.onmessage = (event: MessageEvent) => {
      received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("the device socket did not open"));
    });
    cleanups.push(() => socket.close());
    socket.send(JSON.stringify({ type: "deviceAttach", code: helper.code, client: "phone gate" }));
    await until(() => received.some((message) => message["type"] === "deviceAttached"), "deviceAttached");
    return { socket, received };
  }

  const reply = (received: Array<Record<string, unknown>>, type: string, id?: number) =>
    received.find((message) => message["type"] === type && (id === undefined || message["id"] === id));

  it("opens on phoneOpen with a tokened URL, fans the page's snapshot out, relays a write back, and closes when the page's socket goes", async () => {
    const helper = await helperWith(true);
    const { socket, received } = await attachDevice(helper);
    socket.send(JSON.stringify({ type: "phonePublish", snapshot: SNAPSHOT_A }));
    socket.send(JSON.stringify({ type: "phoneOpen", id: 1 }));
    await until(() => reply(received, "phoneOpened", 1) !== undefined, "phoneOpened");
    const opened = reply(received, "phoneOpened", 1)?.["state"] as PhoneDoorState;
    if (!opened.open) throw new Error(opened.reason);
    expect(opened.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{22}$/);
    const ca = readFileSync(join(sharedCertDir, "cert.pem"), "utf8");

    const phone = await openStream(at(opened.url, PHONE_EVENTS_PATH), ca, "Pixel Test");
    await until(() => phone.events.length === 1, "the published snapshot on the phone");
    expect(phone.events[0]).toEqual({ type: "snapshot", snapshot: SNAPSHOT_A });
    await until(() => reply(received, "phoneState") !== undefined, "phoneState");
    const came = reply(received, "phoneState")?.["state"] as PhoneDoorState;
    expect(came.open && came.phones.map((peer) => [peer.phone, peer.userAgent])).toEqual([[phone.phone, "Pixel Test"]]);

    expect((await postSet(opened.url, ca, phone.phone)).status).toBe(204);
    await until(() => reply(received, "phoneWrite") !== undefined, "phoneWrite");
    expect(reply(received, "phoneWrite")).toEqual({ type: "phoneWrite", stream: "phone", phone: phone.phone, set: A_SET });

    socket.close();
    await until(() => phone.ended, "the phone's stream to end with the page");
    expect(phone.events.at(-1)?.type).toBe("closed");
    await expect(fetchPinned(opened.url, ca)).rejects.toThrow();
  });

  it("T1397b: relays a camera handshake both ways over the device socket — to the named phone only, malformed page signals dropped", async () => {
    const helper = await helperWith(true);
    const { socket, received } = await attachDevice(helper);
    socket.send(JSON.stringify({ type: "phoneOpen", id: 1 }));
    await until(() => reply(received, "phoneOpened", 1) !== undefined, "phoneOpened");
    const opened = reply(received, "phoneOpened", 1)?.["state"] as PhoneDoorState;
    if (!opened.open) throw new Error(opened.reason);
    const ca = readFileSync(join(sharedCertDir, "cert.pem"), "utf8");
    const sender = await openStream(at(opened.url, PHONE_EVENTS_PATH), ca, "Sender");
    const bystander = await openStream(at(opened.url, PHONE_EVENTS_PATH), ca, "Bystander");

    expect((await postSignal(opened.url, ca, sender.phone, JSON.stringify(OFFER))).status).toBe(204);
    await until(() => reply(received, "phoneSignal") !== undefined, "phoneSignal on the page's socket");
    expect(reply(received, "phoneSignal")).toEqual({ type: "phoneSignal", stream: "phone", phone: sender.phone, message: OFFER });

    // A page signal that is not one (an SDP that is not a string) goes nowhere; the
    // well-formed one after it arrives alone, and only on the phone it names.
    socket.send(JSON.stringify({ type: "phoneSignal", phone: sender.phone, message: { kind: "answer", sdp: 42 } }));
    socket.send(JSON.stringify({ type: "phoneSignal", phone: sender.phone, message: ANSWER }));
    // The Webcam's Capture parameters, asked of the phone — and one outside a camera's range, dropped.
    const request: PhoneSignalToPhone = { kind: "request", facing: "user", width: 1280, height: 720, frameRate: 30, exact: false };
    socket.send(JSON.stringify({ type: "phoneSignal", phone: sender.phone, message: { ...request, width: -1 } }));
    socket.send(JSON.stringify({ type: "phoneSignal", phone: sender.phone, message: request }));
    await until(() => sender.events.filter((event) => event.type === "signal").length === 2, "the answer and request on the sender's stream");
    expect(sender.events.filter((event) => event.type === "signal")).toEqual([
      { type: "signal", message: ANSWER },
      { type: "signal", message: request },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bystander.events.filter((event) => event.type === "signal")).toEqual([]);

    socket.close();
    await until(() => sender.ended, "the sender's stream to end with the page");
    expect(sender.events.at(-1)?.type).toBe("closed");
  });

  it("phoneClose closes the door and says so; the phones are told", async () => {
    const helper = await helperWith(true);
    const { socket, received } = await attachDevice(helper);
    socket.send(JSON.stringify({ type: "phoneOpen", id: 1 }));
    await until(() => reply(received, "phoneOpened", 1) !== undefined, "phoneOpened");
    const opened = reply(received, "phoneOpened", 1)?.["state"] as PhoneDoorState;
    if (!opened.open) throw new Error(opened.reason);
    const ca = readFileSync(join(sharedCertDir, "cert.pem"), "utf8");
    const phone = await openStream(at(opened.url, PHONE_EVENTS_PATH), ca);
    await until(() => reply(received, "phoneState") !== undefined, "the phone to arrive");
    socket.send(JSON.stringify({ type: "phoneClose", id: 2 }));
    await until(() => reply(received, "phoneOpened", 2) !== undefined, "the close reply");
    expect((reply(received, "phoneOpened", 2)?.["state"] as PhoneDoorState).open).toBe(false);
    await until(() => phone.ended, "the phone's stream to end");
    expect(phone.events.at(-1)?.type).toBe("closed");
  });

  it("a helper built with the phone door says at startup that it is armed, and one without says nothing of it", async () => {
    for (const phone of [true, false]) {
      const handoffDir = mkdtempSync(join(tmpdir(), "loom-phone-helper-"));
      const said: string[] = [];
      // The real door construction (the flag's path, not an injected door); nothing opens.
      const helper = createDeviceHelper({ port: 0, handoffDir, phone, announce: (line) => said.push(line) });
      cleanups.push(() => {
        helper.dispose();
        rmSync(handoffDir, { recursive: true, force: true });
      });
      expect(said.includes(HELPER_PHONE_BANNER), `phone: ${String(phone)}`).toBe(phone);
    }
  });

  it("without the phone flag, answers phoneOpen open:false with the command to restart with", async () => {
    const helper = await helperWith(false);
    const { socket, received } = await attachDevice(helper);
    socket.send(JSON.stringify({ type: "phoneOpen", id: 7 }));
    await until(() => reply(received, "phoneOpened", 7) !== undefined, "phoneOpened");
    const state = reply(received, "phoneOpened", 7)?.["state"] as PhoneDoorState;
    expect(state).toEqual({ open: false, reason: PHONE_DOOR_UNAVAILABLE });
    expect(PHONE_DOOR_UNAVAILABLE).toContain(DEVICE_HELPER_PHONE_COMMAND);
  });
});
