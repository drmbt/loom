import { execFile } from "node:child_process";
import { X509Certificate, createPrivateKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";

import {
  PHONE_EVENTS_PATH,
  PHONE_PAGE_PATH,
  PHONE_PEER_PARAM,
  PHONE_SET_PATH,
  PHONE_SIGNAL_MAX_BYTES,
  PHONE_SIGNAL_PATH,
  PHONE_TOKEN_PARAM,
  PHONE_VALUE_MAX_CHARS,
  parsePhoneRefused,
  parsePhoneSignal,
  type PhoneDoorState,
  type PhoneEvent,
  type PhoneFirewallBlock,
  type PhonePeer,
  type PhoneRefused,
  type PhoneSet,
  type PhoneSignalFromPhone,
  type PhoneSignalToPhone,
  type PhoneSnapshot,
} from "./phone-protocol.ts";
import { phonePageHtml } from "./phone-page.ts";
import { probeMacFirewall } from "./mac-firewall.ts";

/**
 * T1396b — THE PHONE DOOR: the helper's SECOND listener, and the only one on the LAN.
 *
 * ## What it is, and what it is not
 *
 * The loopback bridge (`../transport/loopback-ws.ts`) binds 127.0.0.1 and accepts pages
 * served from localhost; that stays exactly as it is. This is a separate door with its
 * own address, its own credential and its own three routes, and it can do two things:
 * show a phone the controls the paired page chose to publish (`PhoneSnapshot`), and carry
 * a phone's `PhoneSet` back to that page. It holds no document, no tool and no bus. The
 * page vets every write and performs it (`phone-protocol.ts`); the door checks the token
 * and the shape and relays. When the page refuses a write it says so through the door
 * (`refuse`, T1526b): its sentence goes down the stream of the phone that wrote, and no other.
 *
 * ## The posture, one clause per owner condition (2026-09-27)
 *
 *  - **Opt-in per session.** Built only when the helper was started with `--phone`
 *    (`doors.ts`), and even then nothing binds until the paired page sends `phoneOpen`.
 *    It closes on `phoneClose` and when that page's device socket goes away — so a door
 *    nobody is looking at does not stay open.
 *  - **The LAN, never the world, never loopback.** It binds ONE private IPv4 address
 *    (10/8, 172.16/12, 192.168/16 — `pickLanAddress`), never the wildcard: a machine on a
 *    café's wifi and a VPN at once should not publish its controls on whichever interface
 *    the OS picks.
 *  - **A token per opening.** 128 bits from the CSPRNG, minted in `open` and dead at
 *    `close`. It rides the URL the QR code encodes (`?t=`), every request carries it, and
 *    a wrong or missing one is a bare 403 compared in constant time — the same answer on
 *    every path, so a scanner learns nothing about which routes exist.
 *  - **HTTPS, self-signed, accepted once.** A phone camera (§T1397b) needs a secure
 *    context. The certificate is made with the `openssl` CLI (no new dependency — owner
 *    ruling) and persisted per user, so the phone's "accept this certificate" is a
 *    one-time act rather than a per-session one; it is remade only when the LAN address
 *    moved out of its SAN or it expires. If it cannot be made, the door refuses by name —
 *    there is no plain-HTTP fallback, because a door that silently downgrades is a door
 *    whose token crosses the wifi in clear.
 *
 * ## Routing is a table on purpose
 *
 * A route is one entry in `routes` below, keyed by method and path, and every entry sits
 * behind the same token check — so the next route cannot forget it. §T1397b's WebRTC
 * signalling was the second writing route (`PHONE_SIGNAL_PATH`): a phone's offer, ICE
 * candidates and bye go up to the page, and the page's answer, candidates and bye come
 * back down that one phone's event stream (`signal`). The door relays; it never reads an
 * SDP past its shape and length (`parsePhoneSignal`), and the video never touches it.
 *
 * ## Every OS call is a parameter with a real default
 *
 * The address picker, the port, the certificate directory, the `openssl` binary and the
 * keepalive period are injectable, for the reason `doors.ts` gives: a gate binds loopback
 * and a temp directory, and the product path is the one with no injection at all.
 */

/** The port a phone door tries first. A fixed port keeps a bookmarked URL's host:port stable. */
export const PHONE_DOOR_PORT = 43920;
/** How many phones one opening serves. The ninth is told so (429). */
export const PHONE_DOOR_MAX_PHONES = 8;
/** The largest `PhoneSet` body accepted. A set is a handle and a couple of numbers. */
export const PHONE_SET_MAX_BYTES = 4096;
/** How often an idle event stream is told it is still alive (proxies and phones time out). */
const KEEPALIVE_MS = 15_000;
/** A certificate this close to its end is remade now rather than failing mid-session. */
const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
const CERT_VALID_DAYS = 365;
const CERT_COMMON_NAME = "Loom phone door";

/** Every response carries these; none carries a CORS header, so no other origin may read one. */
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * THE ONE ADDRESS THE DOOR MAY BIND: the best-ranked non-internal IPv4 in a private range.
 *
 * Loopback would make the door unreachable from the phone; a public or CGNAT address
 * (100.64/10, which is what an overlay VPN hands out) would put it somewhere other than
 * "the same wifi"; link-local 169.254/16 is a network that failed to configure. None of
 * those is the LAN the owner meant, so none is returned, and no address at all is a
 * refusal the door says out loud.
 *
 * Among the private ones, "the first" was whatever order the OS listed interfaces in, and a
 * laptop on home wifi with a work VPN up lists a `utun` on 10.x beside `en0` on 192.168.x.
 * So they are RANKED: 192.168/16 (what home and venue routers hand out) over 172.16/12 over
 * 10/8 (what VPNs and corporate networks use), and within a range a physical-looking
 * interface (`en*`, `eth*`, `wlan*`) over a tunnel (`utun*`, `tun*`, `ppp*`, `tailscale*`,
 * `wg*`), anything else between. Ties keep the OS's order.
 */
export function pickLanAddress(
  interfaces: NodeJS.Dict<readonly NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  let best: { address: string; score: number } | null = null;
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // `family` was the number 4 on Node 18.0–18.3; both spellings mean IPv4.
      const v4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (!v4 || entry.internal) continue;
      const range = privateRange(entry.address);
      if (range === null) continue;
      const score = range * 3 + interfaceClass(name);
      if (best === null || score < best.score) best = { address: entry.address, score };
    }
  }
  return best?.address ?? null;
}

/** 0 for 192.168/16, 1 for 172.16/12, 2 for 10/8, null for anything that is not private. */
function privateRange(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  const [a, b] = parts as [number, number, number, number];
  if (a === 192 && b === 168) return 0;
  if (a === 172 && b >= 16 && b <= 31) return 1;
  if (a === 10) return 2;
  return null;
}

/** 0 for a physical-looking interface, 2 for a tunnel, 1 for anything else. */
function interfaceClass(name: string): number {
  if (/^(en|eth|wlan)/i.test(name)) return 0;
  if (/^(utun|tun|ppp|tailscale|wg)/i.test(name)) return 2;
  return 1;
}

/** Where the certificate lives between sessions: one per user, not per project. */
export function defaultPhoneCertDir(): string {
  return join(homedir(), ".loom", "phone-door");
}

export interface PhoneCertificate {
  readonly key: string;
  readonly cert: string;
  /** SHA-256, colon-separated hex — what a person compares on the phone's warning screen. */
  readonly fingerprint: string;
}

export interface PhoneCertificateOptions {
  readonly dir: string;
  /** The LAN address the certificate must name in its SAN. */
  readonly ip: string;
  /** The `openssl` binary. Injectable so a gate can prove the refusal when it is missing. */
  readonly openssl?: string;
  readonly now?: () => number;
}

/**
 * The certificate for `ip`: the persisted one when it still fits, a fresh one otherwise.
 *
 * "Fits" is three checks, all read back through `X509Certificate` rather than trusted from
 * a file name: the SAN names this address (a laptop that moved to another network has a
 * certificate for the old one, and a phone would refuse it), it is inside its validity
 * window with a day to spare, and the key on disk is the key it was made for. Anything
 * else — including a file that does not parse — is remade, never patched.
 *
 * Rejects with a sentence (§V288) when `openssl` is missing or fails; the caller turns
 * that into the door's refusal.
 */
export async function ensurePhoneCertificate(options: PhoneCertificateOptions): Promise<PhoneCertificate> {
  const now = options.now ?? Date.now;
  const keyPath = join(options.dir, "key.pem");
  const certPath = join(options.dir, "cert.pem");
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  chmodSync(options.dir, 0o700);
  const existing = readFitting(keyPath, certPath, options.ip, now());
  if (existing !== null) return existing;

  const nextKey = `${keyPath}.next`;
  const nextCert = `${certPath}.next`;
  const openssl = options.openssl ?? "openssl";
  try {
    await run(openssl, [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-sha256",
      "-days",
      String(CERT_VALID_DAYS),
      "-subj",
      `/CN=${CERT_COMMON_NAME}`,
      "-keyout",
      nextKey,
      "-out",
      nextCert,
      "-addext",
      `subjectAltName=IP:${options.ip}`,
      // iOS 13+ refuses a TLS server certificate without serverAuth, even one the user
      // accepted by hand; the other two say what this certificate is and is not.
      "-addext",
      "extendedKeyUsage=serverAuth",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature",
    ]);
    chmodSync(nextKey, 0o600);
    renameSync(nextKey, keyPath);
    renameSync(nextCert, certPath);
  } catch (error) {
    rmSync(nextKey, { force: true });
    rmSync(nextCert, { force: true });
    throw error;
  }
  // No clock check on what was made a moment ago: its window is `openssl`'s clock, and a
  // skewed `now` must not turn a fresh certificate into a refusal.
  const made = readFitting(keyPath, certPath, options.ip, null);
  if (made === null) {
    throw new Error(
      `\`${openssl}\` ran but the certificate it wrote does not name ${options.ip} or does not match its key, so the phone door stays shut.`,
    );
  }
  return made;
}

function readFitting(keyPath: string, certPath: string, ip: string, now: number | null): PhoneCertificate | null {
  try {
    const key = readFileSync(keyPath, "utf8");
    const cert = readFileSync(certPath, "utf8");
    const x509 = new X509Certificate(cert);
    if (x509.checkIP(ip) === undefined) return null;
    if (now !== null && (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) - RENEW_MARGIN_MS < now)) {
      return null;
    }
    if (!x509.checkPrivateKey(createPrivateKey(key))) return null;
    return { key, cert, fingerprint: x509.fingerprint256 };
  } catch {
    return null;
  }
}

function run(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve();
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new Error(
          code === "ENOENT"
            ? `the phone door makes its HTTPS certificate with the \`${file}\` command, and there is none on this machine's PATH. Install OpenSSL (macOS ships one at /usr/bin/openssl) and open the door again.`
            : `\`${file}\` could not make the phone door's certificate: ${String(stderr).trim() || error.message}`,
        ),
      );
    });
  });
}

/** Where the door tells the page what happened. Bound per opening, dropped at close. */
export interface PhoneDoorSink {
  /** A phone holding the token wrote. Already shape-checked; the page vets the rest. */
  onWrite(phone: string, set: PhoneSet): void;
  /** The door changed on its own: a phone came or went, or the listener failed. */
  onState(state: PhoneDoorState): void;
  /** T1397b: a phone holding the token sent its half of a camera handshake. Shape-checked. */
  onSignal(phone: string, message: PhoneSignalFromPhone): void;
}

export interface PhoneDoorOptions {
  /** The address to bind. Default `pickLanAddress()`, read at each opening. Tests pass loopback. */
  readonly lanAddress?: () => string | null;
  /** The port to try first; EADDRINUSE falls back to an ephemeral one. Default `PHONE_DOOR_PORT`. */
  readonly port?: number;
  /** Where the certificate persists. Default `defaultPhoneCertDir()`. */
  readonly certDir?: string;
  /** The `openssl` binary. Default `openssl` on PATH. */
  readonly openssl?: string;
  /** How often idle event streams get a comment line. Default 15 s. */
  readonly keepaliveMs?: number;
  /**
   * T1511b — whether the OS firewall will refuse the phones. Default `probeMacFirewall()`
   * (read-only, macOS only). Asked at each opening; a rejection counts as "cannot tell".
   */
  readonly firewall?: () => Promise<PhoneFirewallBlock | null>;
}

export interface PhoneDoor {
  /**
   * Open the listener (or report the one already open). Never rejects: a door that cannot
   * open resolves `{ open: false, reason }` with the reason in words.
   */
  open(sink: PhoneDoorSink): Promise<PhoneDoorState>;
  /** Close it: every phone is told `closed`, the token dies. Keeps the last snapshot. */
  close(reason: string): PhoneDoorState;
  /**
   * The page that published went away: close, and forget its snapshot too, so the next
   * page's phones never see a panel the previous page chose to show.
   */
  release(reason: string): void;
  /** Store the page's current snapshot and send it to every phone. */
  publish(snapshot: PhoneSnapshot): void;
  /**
   * T1397b: the page's half of one phone's camera handshake, down THAT phone's stream and
   * no other. False — and nothing sent — when the door is closed or no stream by that id
   * is open (the phone left; its next stream offers again under a new id).
   */
  signal(phone: string, message: PhoneSignalToPhone): boolean;
  /**
   * T1526b: the page refused one of that phone's writes — said down THAT phone's stream
   * and no other, as a `refused` event. Shape-checked again here (the last hop before a
   * phone draws the sentence). False — and nothing sent — when it is not a refusal, the
   * door is closed, or no stream by that id is open.
   */
  refuse(phone: string, refused: PhoneRefused): boolean;
  state(): PhoneDoorState;
  dispose(): void;
}

interface Phone {
  readonly peer: PhonePeer;
  readonly response: ServerResponse;
}

interface Opened {
  readonly server: Server;
  readonly url: string;
  readonly token: string;
  readonly fingerprint: string;
  readonly sink: PhoneDoorSink;
  readonly phones: Map<string, Phone>;
  readonly keepalive: ReturnType<typeof setInterval>;
  readonly firewall: PhoneFirewallBlock | null;
}

const CLOSED_STATE: PhoneDoorState = { open: false, reason: "the phone door is closed." };

export function createPhoneDoor(options: PhoneDoorOptions = {}): PhoneDoor {
  const lanAddress = options.lanAddress ?? (() => pickLanAddress());
  const preferredPort = options.port ?? PHONE_DOOR_PORT;
  const certDir = options.certDir ?? defaultPhoneCertDir();
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const firewall = options.firewall ?? (() => probeMacFirewall());

  let opened: Opened | null = null;
  let opening: Promise<PhoneDoorState> | null = null;
  /** Bumped by every close, so an opening that finishes after one knows it lost. */
  let generation = 0;
  let snapshot: PhoneSnapshot | null = null;
  let lastRefusal: PhoneDoorState = CLOSED_STATE;

  const state = (): PhoneDoorState => {
    if (opened === null) return lastRefusal;
    return {
      open: true,
      url: opened.url,
      fingerprint: opened.fingerprint,
      phones: [...opened.phones.values()].map((phone) => phone.peer),
      ...(opened.firewall === null ? {} : { firewall: opened.firewall }),
    };
  };

  const writeEvent = (response: ServerResponse, event: PhoneEvent): void => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const shut = (reason: string): void => {
    const current = opened;
    opened = null;
    generation += 1;
    if (current === null) return;
    clearInterval(current.keepalive);
    for (const phone of current.phones.values()) {
      writeEvent(phone.response, { type: "closed", reason });
      // The stream is over: once the last event has left, so has the socket.
      const socket = phone.response.socket;
      phone.response.end(() => socket?.destroy());
    }
    current.phones.clear();
    // Stop accepting, drop idle keep-alive sockets now, and anything still mid-request
    // shortly after: a request that lands in between is answered 403 by the `opened`
    // check, because the token died with this opening. Not `closeAllConnections` at once
    // — that would destroy the sockets before the `closed` events above were flushed.
    current.server.close();
    current.server.closeIdleConnections();
    setTimeout(() => current.server.closeAllConnections(), 1_000).unref();
  };

  const tokenMatches = (expected: string, given: string | null): boolean => {
    if (given === null) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const refuse = (response: ServerResponse, status: number, sentence?: string): void => {
    response.writeHead(status, {
      ...BASE_HEADERS,
      ...(sentence === undefined ? {} : { "Content-Type": "text/plain; charset=utf-8" }),
    });
    response.end(sentence);
  };

  /**
   * A POST body, whole, or a 400 once it passes `max` bytes (and the socket closed, rather
   * than read to the end for a body that will be refused anyway).
   */
  const readBody = (
    request: IncomingMessage,
    response: ServerResponse,
    max: number,
    tooBig: string,
    then: (text: string) => void,
  ): void => {
    let size = 0;
    const chunks: Buffer[] = [];
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > max) {
        refused = true;
        response.setHeader("Connection", "close");
        refuse(response, 400, tooBig);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!refused) then(Buffer.concat(chunks).toString("utf8"));
    });
  };

  /**
   * WHICH PHONE SENT IT: the one the request names (`PHONE_PEER_PARAM`, the id its stream
   * said in `hello`), and only while that stream is open. Not guessed from the address —
   * two tabs on one phone share it and are two phones here, each with its own undo. An id
   * with no open stream is refused with a 409, never relayed under.
   */
  const namedPhone = (door: Opened, url: URL, response: ServerResponse): Phone | null => {
    const named = url.searchParams.get(PHONE_PEER_PARAM);
    const phone = named === null ? undefined : door.phones.get(named);
    if (phone !== undefined) return phone;
    refuse(response, 409, "This phone's connection to Loom is not open, so the change was not sent. Reconnecting.");
    return null;
  };

  /** Every route, behind the one token check. */
  const routes: Record<
    string,
    (door: Opened, request: IncomingMessage, response: ServerResponse, url: URL) => void
  > = {
    [`GET ${PHONE_PAGE_PATH}`]: (_door, _request, response) => {
      response.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      response.end(phonePageHtml());
    },
    [`GET ${PHONE_EVENTS_PATH}`]: (door, request, response) => {
      if (door.phones.size >= PHONE_DOOR_MAX_PHONES) {
        refuse(
          response,
          429,
          `This phone door already serves ${String(PHONE_DOOR_MAX_PHONES)} phones; close one of them first.`,
        );
        return;
      }
      const id = randomUUID().slice(0, 8);
      const agent = request.headers["user-agent"];
      const phone: Phone = {
        peer: { phone: id, userAgent: typeof agent === "string" ? agent.slice(0, 200) : "" },
        response,
      };
      response.writeHead(200, {
        ...BASE_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
      });
      // Headers now, not with the first event: a phone that connects before anything is
      // published must still see its stream open.
      response.flushHeaders();
      door.phones.set(id, phone);
      // First, always: the id this stream is, which every write from it must name.
      writeEvent(response, { type: "hello", phone: id });
      if (snapshot !== null) writeEvent(response, { type: "snapshot", snapshot });
      request.socket.setNoDelay(true);
      response.on("close", () => {
        if (opened !== door || !door.phones.delete(id)) return;
        door.sink.onState(state());
      });
      door.sink.onState(state());
    },
    [`POST ${PHONE_SET_PATH}`]: (door, request, response, url) => {
      readBody(
        request,
        response,
        PHONE_SET_MAX_BYTES,
        `A phone write is at most ${String(PHONE_SET_MAX_BYTES)} bytes; this one was not relayed.`,
        (text) => {
          const set = parsePhoneSet(text);
          if (typeof set === "string") {
            refuse(response, 400, set);
            return;
          }
          const phone = namedPhone(door, url, response);
          if (phone === null) return;
          door.sink.onWrite(phone.peer.phone, set);
          response.writeHead(204, BASE_HEADERS);
          response.end();
        },
      );
    },
    // T1397b: a phone's half of its camera handshake, relayed to the page as it came.
    [`POST ${PHONE_SIGNAL_PATH}`]: (door, request, response, url) => {
      readBody(
        request,
        response,
        PHONE_SIGNAL_MAX_BYTES,
        `A camera signal is at most ${String(PHONE_SIGNAL_MAX_BYTES)} bytes; this one was not relayed.`,
        (text) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            refuse(response, 400, "A camera signal must be one JSON object; this body did not parse.");
            return;
          }
          const message = parsePhoneSignal(parsed, "phone");
          if (typeof message === "string") {
            refuse(response, 400, message);
            return;
          }
          const phone = namedPhone(door, url, response);
          if (phone === null) return;
          door.sink.onSignal(phone.peer.phone, message);
          response.writeHead(204, BASE_HEADERS);
          response.end();
        },
      );
    },
  };

  const handle = (door: Opened, request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "https://phone.invalid");
    if (!tokenMatches(door.token, url.searchParams.get(PHONE_TOKEN_PARAM))) {
      refuse(response, 403);
      return;
    }
    const route = routes[`${request.method ?? ""} ${url.pathname}`];
    if (route === undefined) {
      refuse(response, 404);
      return;
    }
    route(door, request, response, url);
  };

  const listen = (server: Server, host: string, port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });

  const openNow = async (sink: PhoneDoorSink): Promise<PhoneDoorState> => {
    const ticket = generation;
    const host = lanAddress();
    if (host === null) {
      return {
        open: false,
        reason:
          "this machine has no private LAN address (10.x, 172.16–31.x or 192.168.x) to put the phone door on. Join the same wifi as the phone and open it again.",
      };
    }
    // T1511b: asked alongside the certificate; any failure is "cannot tell", never a refusal.
    const firewallVerdict = Promise.resolve()
      .then(firewall)
      .catch(() => null);
    let certificate: PhoneCertificate;
    try {
      certificate = await ensurePhoneCertificate({
        dir: certDir,
        ip: host,
        ...(options.openssl === undefined ? {} : { openssl: options.openssl }),
      });
    } catch (error) {
      return { open: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const server = createServer({ key: certificate.key, cert: certificate.cert });
    let port: number;
    try {
      port = await listen(server, host, preferredPort).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EADDRINUSE" || preferredPort === 0) throw error;
        return listen(server, host, 0);
      });
    } catch (error) {
      server.close();
      return {
        open: false,
        reason: `the phone door could not listen on ${host}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const blocked = await firewallVerdict;
    if (ticket !== generation) {
      // Closed (or released) while the certificate was being made: the caller lost.
      server.close();
      return CLOSED_STATE;
    }
    const token = randomBytes(16).toString("base64url");
    const door: Opened = {
      server,
      url: `https://${host}:${String(port)}${PHONE_PAGE_PATH}?${PHONE_TOKEN_PARAM}=${token}`,
      token,
      fingerprint: certificate.fingerprint,
      sink,
      phones: new Map(),
      keepalive: setInterval(() => {
        for (const phone of door.phones.values()) phone.response.write(": keepalive\n\n");
      }, keepaliveMs),
      firewall: blocked,
    };
    door.keepalive.unref();
    server.on("request", (request, response) => {
      if (opened !== door) {
        refuse(response, 403);
        return;
      }
      handle(door, request, response);
    });
    server.on("error", (error) => {
      if (opened !== door) return;
      const reason = `the phone door's listener failed: ${error.message}`;
      shut(reason);
      lastRefusal = { open: false, reason };
      sink.onState(lastRefusal);
    });
    opened = door;
    return state();
  };

  return {
    open(sink) {
      if (opened !== null) return Promise.resolve(state());
      if (opening !== null) return opening;
      const attempt = openNow(sink).then((result) => {
        if (opening === attempt) opening = null;
        if (!result.open) lastRefusal = result;
        return result;
      });
      opening = attempt;
      return attempt;
    },
    close(reason) {
      opening = null;
      shut(reason);
      lastRefusal = CLOSED_STATE;
      return CLOSED_STATE;
    },
    release(reason) {
      opening = null;
      shut(reason);
      lastRefusal = CLOSED_STATE;
      snapshot = null;
    },
    publish(next) {
      snapshot = next;
      if (opened === null) return;
      for (const phone of opened.phones.values()) writeEvent(phone.response, { type: "snapshot", snapshot: next });
    },
    signal(phone, message) {
      const target = opened?.phones.get(phone);
      if (target === undefined) return false;
      writeEvent(target.response, { type: "signal", message });
      return true;
    },
    refuse(phone, refused) {
      const target = opened?.phones.get(phone);
      const checked = parsePhoneRefused(refused);
      if (target === undefined || typeof checked === "string") return false;
      writeEvent(target.response, { type: "refused", ...checked });
      return true;
    },
    state,
    dispose() {
      opening = null;
      shut("the helper shut down.");
      snapshot = null;
    },
  };
}

/**
 * The one shape check a phone's body gets before it leaves the helper. The page re-checks
 * the handle and the keys against what it published; this only makes sure what it is
 * handed is a `PhoneSet` and nothing bigger. Returns the set, or the 400's sentence.
 */
export function parsePhoneSet(text: string): PhoneSet | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "A phone write must be one JSON object; this body did not parse.";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "A phone write must be one JSON object.";
  }
  const record = parsed as Record<string, unknown>;
  const handle = record["handle"];
  const values = record["values"];
  const phase = record["phase"];
  if (typeof handle !== "string" || handle.length === 0) return "A phone write needs a `handle` string.";
  if (phase !== "live" && phase !== "commit") return "A phone write's `phase` is `live` or `commit`.";
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return "A phone write needs a `values` object.";
  }
  const entries = Object.entries(values as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) continue;
    // T1503b: a NAME — a preset to recall, a cue to stand by. WHICH name is the page's vet.
    if (typeof value === "string" && value.length <= PHONE_VALUE_MAX_CHARS) continue;
    return `A phone write's values are finite numbers, booleans or names of at most ${String(PHONE_VALUE_MAX_CHARS)} characters, and \`${key}\` is not.`;
  }
  // A fresh object of own properties: a `__proto__` key stays a key, never a prototype.
  return { handle, values: Object.fromEntries(entries) as Record<string, number | boolean | string>, phase };
}
