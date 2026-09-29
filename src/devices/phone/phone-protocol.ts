/**
 * T1396b — THE PHONE DOOR: the contract its three halves share.
 *
 * A phone on the same wifi drives the controls the owner chose to publish, and nothing else.
 * Three parties, two wires:
 *
 *   phone ──HTTPS (LAN, self-signed)──▶ helper ──loopback device role──▶ editor page ──▶ bus
 *
 *  - **The page owns the document.** It builds a `PhoneSnapshot` from every Panel whose
 *    `remote` parameter is on and hands it to the helper (`phonePublish`). It is also the
 *    only party that turns a phone's `PhoneSet` into a write: it re-checks the widget is on a
 *    remote Panel and the key is writable for that widget type (`PHONE_WRITABLE_KEYS`), then
 *    writes through the command bus as a human actor whose id says it is a phone
 *    (`phoneActorId`). The phone never sees a node id it was not given, a tool, or the
 *    document.
 *  - **The helper is a relay with a door.** With `--phone` it MAY open a second listener; it
 *    opens one only when the paired page asks (`phoneOpen`), on the machine's LAN address,
 *    with a token minted per opening, and closes it on `phoneClose` or when the page's device
 *    socket goes away. The loopback bridge (`../transport/bridge-wire.ts`,
 *    `../transport/loopback-ws.ts`) is not touched and stays loopback-only.
 *  - **The phone is a browser tab** on a page the helper serves. HTTPS because a phone
 *    camera (§T1397b) needs a secure context; the certificate is self-signed and the phone
 *    accepts it once.
 *
 * ## The phone's wire is HTTP, not a WebSocket
 *
 * Server-Sent Events down (`PHONE_EVENTS_PATH`) and a POST per write up (`PHONE_SET_PATH`),
 * both on the page's own origin. iOS Safari's exception for a self-signed certificate is
 * known to cover the page and its same-origin fetches; whether it also covers a `wss://`
 * handshake has varied by release, and a door that pairs and then cannot talk is worse than
 * none. Plain HTTP also leaves the loopback RFC 6455 server alone. Every request carries the
 * token (`PHONE_TOKEN_PARAM` in the query); a wrong or missing token is a 403 and nothing
 * else.
 */

/** The query parameter every phone request carries its token in. */
export const PHONE_TOKEN_PARAM = "t";
/** GET: the phone page itself (HTML, inline script). */
export const PHONE_PAGE_PATH = "/";
/** GET: `text/event-stream` of `PhoneEvent`s, one JSON object per `data:` line. */
export const PHONE_EVENTS_PATH = "/events";
/**
 * POST: one `PhoneSet` as a JSON body. Answered 204, or 4xx with a sentence. Carries the
 * token AND `PHONE_PEER_PARAM`; a phone id whose event stream is not open is a 409, and the
 * phone answers that by reconnecting its stream (which says `hello` with a fresh id).
 */
export const PHONE_SET_PATH = "/set";
/**
 * The query parameter a write names its phone in (T1396b, added after the first cut): the
 * id the phone's own event stream said in `hello`. Without it the helper could only guess
 * which stream a POST belonged to, and two tabs on one phone share an address.
 */
export const PHONE_PEER_PARAM = "p";

/** One control as the phone sees it: enough to draw it and nothing to reach past it. */
export type PhoneWidget =
  | {
      readonly kind: "slider";
      /** Opaque handle the page chose. The phone echoes it back; it means nothing else. */
      readonly handle: string;
      readonly caption: string;
      readonly value: number;
      readonly min: number;
      readonly max: number;
      /** 0 = continuous. */
      readonly step: number;
    }
  | { readonly kind: "toggle"; readonly handle: string; readonly caption: string; readonly on: boolean }
  | { readonly kind: "button"; readonly handle: string; readonly caption: string; readonly held: boolean }
  | {
      readonly kind: "xyPad";
      readonly handle: string;
      readonly caption: string;
      readonly x: number;
      readonly y: number;
      readonly min: number;
      readonly max: number;
    };

/** A Panel's row, with widget names already resolved to what the phone may draw. */
export type PhoneRow =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "widgets"; readonly widgets: readonly PhoneWidget[] };

export interface PhonePanel {
  readonly title: string;
  readonly rows: readonly PhoneRow[];
}

/** Everything a phone can see. Replaced whole on every change; there is no diff protocol. */
export interface PhoneSnapshot {
  /** Monotonic per page session; a phone ignores an older one. */
  readonly seq: number;
  readonly panels: readonly PhonePanel[];
}

/** The widget keys a phone may write, per widget type. The page enforces this, not the phone. */
export const PHONE_WRITABLE_KEYS = {
  slider: ["value"],
  toggle: ["on"],
  button: ["held"],
  xyPad: ["x", "y"],
} as const satisfies Record<PhoneWidget["kind"], readonly string[]>;

/**
 * One write from a phone. `live` while a finger is moving, `commit` when it lifts — the same
 * two phases the editor's own controls use, so one gesture is one undo group. A button press
 * is `held: true` (live) then `held: false` (commit); the page counts the press.
 */
export interface PhoneSet {
  readonly handle: string;
  readonly values: Readonly<Record<string, number | boolean>>;
  readonly phase: "live" | "commit";
}

/** HELPER → PHONE, one per SSE `data:` line. */
export type PhoneEvent =
  /**
   * Always the FIRST event on a stream: the id this connection is known by. The phone puts
   * it in every write (`PHONE_PEER_PARAM`); a reconnected stream says a new one.
   */
  | { readonly type: "hello"; readonly phone: string }
  | { readonly type: "snapshot"; readonly snapshot: PhoneSnapshot }
  /** The page went away or closed the door. The phone shows `reason` and stops sending. */
  | { readonly type: "closed"; readonly reason: string };

/** Who the helper says a phone is: an id per connection, and what its browser called itself. */
export interface PhonePeer {
  readonly phone: string;
  readonly userAgent: string;
}

/** The actor id a phone's writes carry: kind `human`, so undo/ownership are per phone. */
export function phoneActorId(phone: string): string {
  return `remote-${phone}`;
}

/* ------------------------------------------------ page ⇄ helper, on the device role */

/** PAGE → HOST additions to `DeviceClientMessage`. */
export type PhoneClientMessage =
  /** Open the LAN listener (or return the one already open). One owed reply: `phoneOpened`. */
  | { readonly type: "phoneOpen"; readonly id: number }
  /** Close it and drop every phone. One owed reply: `phoneOpened` with `open: false`. */
  | { readonly type: "phoneClose"; readonly id: number }
  /** The current snapshot. Told, not asked: no `id`, no reply. Fanned out to every phone. */
  | { readonly type: "phonePublish"; readonly snapshot: PhoneSnapshot };

/** What `phoneOpen`/`phoneClose` report. `url` carries the token; it is what the QR encodes. */
export type PhoneDoorState =
  | { readonly open: true; readonly url: string; readonly fingerprint: string; readonly phones: readonly PhonePeer[] }
  | { readonly open: false; readonly reason: string };

/** HOST → PAGE additions to `DeviceHostMessage`. Same id/push rule as the device role. */
export type PhoneHostMessage =
  | { readonly type: "phoneOpened"; readonly id: number; readonly state: PhoneDoorState }
  /** PUSH. A phone wrote. The page vets it; the helper has already checked the token. */
  | { readonly type: "phoneWrite"; readonly stream: "phone"; readonly phone: string; readonly set: PhoneSet }
  /** PUSH. The door's state changed on its own: a phone came or went, the listener failed. */
  | { readonly type: "phoneState"; readonly stream: "phone"; readonly state: PhoneDoorState };
