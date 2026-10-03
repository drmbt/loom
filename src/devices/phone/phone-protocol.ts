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
    }
  /*
   * T1503b (§T1398b ruling 12) — a Presets bank, a Layer and a Cue List named on a remote
   * Panel's board. They are drawn on a BOARD only (`PhoneBoardItem`); `rows` never carry
   * one. A phone recalls, switches, fades and steps; it never stores a preset or edits a cue.
   */
  | {
      readonly kind: "preset";
      /** The bank node's id, as for the widgets above. */
      readonly handle: string;
      readonly caption: string;
      /** Preset NAMES, in bank order — a button each. */
      readonly presets: readonly string[];
      /** The preset recalled last (the destination, from the moment of the recall), or null. */
      readonly current: string | null;
      /** A fade is still running on screen. Set when it starts, cleared when it ends. */
      readonly morphing: boolean;
    }
  | {
      readonly kind: "layer";
      readonly handle: string;
      readonly caption: string;
      /** Not bypassed. */
      readonly on: boolean;
      /** The fader's level. Meaningful only while `opacityWritable`: a driven opacity has no level to show. */
      readonly opacity: number;
      /** False when the document drives the opacity: the phone draws the fader read-only. */
      readonly opacityWritable: boolean;
      /** T1526b: what the layer shows, for its label — the node NAME its Picture parameter holds; empty when it holds none. */
      readonly picture: string;
    }
  | {
      readonly kind: "cueList";
      readonly handle: string;
      readonly caption: string;
      /** Cue NAMES, in list order — what `standby` may name. */
      readonly cues: readonly string[];
      /** T1526b: each cue's operator note, in the order of `cues` (one per cue); empty where a cue has none. */
      readonly notes: readonly string[];
      /** The cue that fired last, or null before the first GO. */
      readonly current: string | null;
      /** The cue GO fires now (the standby, else the one after `current`), or null when GO would be refused. */
      readonly next: string | null;
      readonly canGo: boolean;
      readonly canBack: boolean;
      /**
       * T1508b: the list follows the timeline. `current` / `next` are then where the
       * playhead is, GO / BACK / standby are refused (`cue.timeline`), and the phone shows
       * the list read-only.
       */
      readonly following: boolean;
      /**
       * §T1544b: what a following list switches in the compiled structure at its cue times,
       * as `node.key` (a Layer's on/off as `node.on`) — a read-only note, the inspector's
       * "switches structure" line. Empty for a live list, and when the page builds the
       * snapshot without a node registry.
       */
      readonly structure: readonly string[];
    };

/** A Panel's row, with widget names already resolved to what the phone may draw. */
export type PhoneRow =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "widgets"; readonly widgets: readonly PhoneWidget[] };

export interface PhonePanel {
  readonly title: string;
  readonly rows: readonly PhoneRow[];
  /**
   * T1516b: the Panel's free board — every control placed and sized on a grid by the owner.
   * When present the phone draws THIS, not `rows` (which stays for a Panel laid out by the
   * legacy text override). Same grid as the editor, so the phone shows the arrangement the
   * owner made; the phone scales one column to `width / columns`.
   */
  readonly board?: PhoneBoard;
}

/** A rectangle on a Panel board, in whole grid cells; (0, 0) is the top-left cell. */
export interface BoardRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One thing on a board: a control, or a free text label the owner placed (no node). */
export type PhoneBoardItem =
  | { readonly kind: "widget"; readonly rect: BoardRect; readonly widget: PhoneWidget }
  | { readonly kind: "label"; readonly rect: BoardRect; readonly text: string };

export interface PhoneBoard {
  /** Grid width in cells. Cells are square. */
  readonly columns: number;
  /** Grid height in cells: the bottom edge of the lowest item. */
  readonly rows: number;
  readonly items: readonly PhoneBoardItem[];
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
  // T1503b. `recall` and `standby` carry a NAME (a list can change between the snapshot a
  // phone drew and its tap, and a stale index would recall the wrong preset); `go` and
  // `back` carry `true`. All but `opacity` are `commit` only. There is no `store`.
  preset: ["recall"],
  layer: ["on", "opacity"],
  cueList: ["go", "back", "standby"],
} as const satisfies Record<PhoneWidget["kind"], readonly string[]>;

/** T1503b: the longest string a phone write's value may be — a preset or a cue name. */
export const PHONE_VALUE_MAX_CHARS = 120;

/**
 * One write from a phone. `live` while a finger is moving, `commit` when it lifts — the same
 * two phases the editor's own controls use, so one gesture is one undo group. A button press
 * is `held: true` (live) then `held: false` (commit); the page counts the press.
 */
export interface PhoneSet {
  readonly handle: string;
  /** A string is a NAME (T1503b: `recall`, `standby`), at most `PHONE_VALUE_MAX_CHARS` long. */
  readonly values: Readonly<Record<string, number | boolean | string>>;
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
  | { readonly type: "closed"; readonly reason: string }
  /** T1397b: the page's half of this phone's camera handshake, relayed as the page sent it. */
  | { readonly type: "signal"; readonly message: PhoneSignalToPhone }
  /** T1526b: the page refused one of THIS phone's writes. Sent down that phone's stream and no other. */
  | ({ readonly type: "refused" } & PhoneRefused);

/* ------------------------------------------------ a refused write, told (T1526b) */

/** The longest sentence a phone is told its write was refused with. The page that sends one cuts it to this. */
export const PHONE_REFUSAL_MAX_CHARS = 300;
/** The longest handle a refusal names. A handle is a node id the page published; a real one is far shorter. */
export const PHONE_HANDLE_MAX_CHARS = 128;

/**
 * T1526b — WHAT A PHONE IS TOLD WHEN ITS PRESS IS REFUSED. Until this, a recall, a GO or a
 * write the page's vet or the bus refused was said at the desk only, and the phone saw
 * nothing change.
 *
 * Both fields are the PAGE's, never the phone's own bytes coming back (LAN data is not
 * copy, and a phone never sees a node id it was not given):
 *  - `handle` is the control the refusal is about when the page's vet found it among the
 *    ones it published — the id the snapshot gave that phone. It is "" when the write named
 *    nothing published; the phone then shows the sentence as a notice, on no control.
 *  - `reason` is the vet's sentence or the bus command's own, cut to
 *    `PHONE_REFUSAL_MAX_CHARS`. Neither quotes what the phone sent.
 */
export interface PhoneRefused {
  readonly handle: string;
  readonly reason: string;
}

/** The refusal the page sends: its sentence cut to the cap, and a handle too long to be one of its ids dropped. */
export function phoneRefused(handle: string, reason: string): PhoneRefused {
  return {
    handle: handle.length <= PHONE_HANDLE_MAX_CHARS ? handle : "",
    reason: reason.length <= PHONE_REFUSAL_MAX_CHARS ? reason : `${reason.slice(0, PHONE_REFUSAL_MAX_CHARS - 1)}…`,
  };
}

/**
 * The one shape check a refusal gets at each hop after the page (the bridge host, the
 * door): two strings inside their caps, a sentence that says something, and nothing else
 * carried — the result is a fresh object. Returns the refusal, or a sentence saying why
 * it is not one.
 */
export function parsePhoneRefused(value: unknown): PhoneRefused | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "A refusal must be one JSON object.";
  const record = value as Record<string, unknown>;
  const handle = record["handle"];
  const reason = record["reason"];
  if (typeof handle !== "string" || handle.length > PHONE_HANDLE_MAX_CHARS) {
    return `A refusal's \`handle\` is a string of at most ${String(PHONE_HANDLE_MAX_CHARS)} characters.`;
  }
  if (typeof reason !== "string" || reason === "" || reason.length > PHONE_REFUSAL_MAX_CHARS) {
    return `A refusal needs a \`reason\` sentence of at most ${String(PHONE_REFUSAL_MAX_CHARS)} characters.`;
  }
  return { handle, reason };
}

/* ------------------------------------------------ the camera handshake (T1397b) */

/**
 * T1397b — POST: one `PhoneSignalFromPhone` as a JSON body, the phone's half of a WebRTC
 * handshake. Token and `PHONE_PEER_PARAM` exactly as `PHONE_SET_PATH`; answered 204, 409
 * for a phone whose stream is not open, 400 with a sentence for a body that is not one.
 *
 * ## The helper relays signalling and nothing else
 *
 * The phone has the camera, so the phone OFFERS; the page ANSWERS (a receive-only video
 * transceiver, which is what answering a send-only offer with no tracks of its own
 * produces). The video itself goes phone → page directly, peer to peer on the wifi. The
 * helper carries the offer, the answer, the ICE candidates and a `bye` between the two, one
 * JSON object at a time, and never reads an SDP past its type and length: the only party
 * that interprets one is a browser.
 *
 * LAN ONLY, NO STUN/TURN: both halves build their `RTCPeerConnection` with `iceServers: []`.
 * On one wifi the host candidates are enough, and a STUN server would be a third party on
 * the internet learning this machine's address for a stream that never leaves the room.
 */
export const PHONE_SIGNAL_PATH = "/signal";
/** The largest signal body the door accepts. An offer for one video track is a few KB. */
export const PHONE_SIGNAL_MAX_BYTES = 32_768;
/** The longest SDP either half may relay, in characters — the body cap less its envelope. */
export const PHONE_SDP_MAX_CHARS = 30_000;
/** The longest ICE candidate line. A real one is well under 200 characters. */
export const PHONE_ICE_MAX_CHARS = 1_024;
/** The longest name a phone may send under (a Webcam node's `phone:<name>` device). */
export const PHONE_NAME_MAX_CHARS = 40;
/** The longest reason a page's `bye` may carry. */
export const PHONE_REASON_MAX_CHARS = 200;

/** One trickled ICE candidate: the three fields `RTCIceCandidateInit` needs, nothing else. */
export interface PhoneIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

/** PHONE → PAGE, through `PHONE_SIGNAL_PATH` and the `phoneSignal` push. */
export type PhoneSignalFromPhone =
  /**
   * `name` is what the phone's owner typed on the phone page (remembered by that phone),
   * and what a Webcam node's `phone:<name>` device matches. Not the connection id: that
   * is minted per stream and changes on every reconnect, and a saved document must find
   * "Back cam" again tomorrow.
   */
  | { readonly kind: "offer"; readonly sdp: string; readonly name: string }
  | ({ readonly kind: "ice" } & PhoneIceCandidate)
  /** The phone stopped sending — `reason` when it did not choose to (a camera it could not open). */
  | { readonly kind: "bye"; readonly reason?: string };

/**
 * What the desk asks a sending phone's camera for: the Webcam node's Capture parameters
 * (§T1043), passed on as they stand. 0 (or a null facing) is UNASKED, and the phone keeps
 * what it has for that member. `exact` is the node's Require fit, for size and rate only —
 * facing is always a preference, for the reason `media.ts` gives.
 *
 * The phone's own Front/Back and resolution buttons stay, and the LATEST choice from either
 * end wins: a request re-points the phone's selection (its buttons show it), and a button
 * pressed on the phone afterwards is simply newer. The desk sends a request only when a
 * Webcam node on a phone asks for something, when it opens that phone and each time one of
 * those parameters changes (the media hook re-opens on any Capture change).
 */
export interface PhoneCameraRequest {
  readonly facing: "user" | "environment" | null;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly exact: boolean;
}

/** PAGE → PHONE, through the `phoneSignal` request and the `signal` event. */
export type PhoneSignalToPhone =
  | { readonly kind: "answer"; readonly sdp: string }
  | ({ readonly kind: "ice" } & PhoneIceCandidate)
  /** The page stopped receiving; the phone shows `reason` and stops its camera. */
  | { readonly kind: "bye"; readonly reason: string }
  /** The desk asks the camera for a facing, a size and a rate. The phone re-opens its camera. */
  | ({ readonly kind: "request" } & PhoneCameraRequest);

/**
 * The one shape check a signal gets at every hop that crosses a process (the door, the
 * bridge host, the device client): the kind is one that direction may send, every field
 * is the right type and inside its cap, and nothing else is carried — the result is a
 * fresh object, so an extra key never rides along. Returns the signal, or a sentence
 * saying why it is not one. An SDP is checked for type and length only (see above).
 */
export function parsePhoneSignal(value: unknown, from: "phone"): PhoneSignalFromPhone | string;
export function parsePhoneSignal(value: unknown, from: "page"): PhoneSignalToPhone | string;
export function parsePhoneSignal(value: unknown, from: "phone" | "page"): PhoneSignalFromPhone | PhoneSignalToPhone | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "A camera signal must be one JSON object.";
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const text = (key: string, max: number): string | null => {
    const field = record[key];
    return typeof field === "string" && field.length <= max ? field : null;
  };
  if (kind === "ice") {
    const candidate = text("candidate", PHONE_ICE_MAX_CHARS);
    // Absent reads as null: `RTCIceCandidateInit` treats the two alike.
    const mid = record["sdpMid"] ?? null;
    const line = record["sdpMLineIndex"] ?? null;
    if (candidate === null) return `An ICE signal needs a \`candidate\` string of at most ${String(PHONE_ICE_MAX_CHARS)} characters.`;
    if (mid !== null && (typeof mid !== "string" || mid.length > 64)) return "An ICE signal's `sdpMid` is a short string or null.";
    if (line !== null && (typeof line !== "number" || !Number.isInteger(line) || line < 0 || line > 255)) {
      return "An ICE signal's `sdpMLineIndex` is a small whole number or null.";
    }
    return { kind: "ice", candidate, sdpMid: mid as string | null, sdpMLineIndex: line as number | null };
  }
  if (from === "phone") {
    if (kind === "bye") {
      if (record["reason"] === undefined) return { kind: "bye" };
      const reason = text("reason", PHONE_REASON_MAX_CHARS);
      if (reason === null) return `A bye's \`reason\` is a string of at most ${String(PHONE_REASON_MAX_CHARS)} characters.`;
      return { kind: "bye", reason };
    }
    if (kind !== "offer") return "A phone's camera signal is `offer`, `ice` or `bye`.";
    const sdp = text("sdp", PHONE_SDP_MAX_CHARS);
    if (sdp === null || sdp === "") return `An offer needs an \`sdp\` string of at most ${String(PHONE_SDP_MAX_CHARS)} characters.`;
    const name = text("name", PHONE_NAME_MAX_CHARS);
    if (name === null) return `An offer needs a \`name\` string of at most ${String(PHONE_NAME_MAX_CHARS)} characters.`;
    return { kind: "offer", sdp, name: name.trim() };
  }
  if (kind === "bye") {
    const reason = text("reason", PHONE_REASON_MAX_CHARS);
    if (reason === null) return `A bye needs a \`reason\` string of at most ${String(PHONE_REASON_MAX_CHARS)} characters.`;
    return { kind: "bye", reason };
  }
  if (kind === "request") {
    const facing = record["facing"] ?? null;
    if (facing !== null && facing !== "user" && facing !== "environment") {
      return "A camera request's `facing` is `user`, `environment` or null.";
    }
    const whole = (key: string, max: number): number | null => {
      const field = record[key];
      return typeof field === "number" && Number.isInteger(field) && field >= 0 && field <= max ? field : null;
    };
    const width = whole("width", 7680);
    const height = whole("height", 4320);
    const frameRate = whole("frameRate", 240);
    if (width === null || height === null || frameRate === null) {
      return "A camera request's `width`, `height` and `frameRate` are whole numbers within a camera's range (0 = unasked).";
    }
    if (typeof record["exact"] !== "boolean") return "A camera request's `exact` is a boolean.";
    return { kind: "request", facing, width, height, frameRate, exact: record["exact"] };
  }
  if (kind !== "answer") return "A page's camera signal is `answer`, `ice`, `bye` or `request`.";
  const sdp = text("sdp", PHONE_SDP_MAX_CHARS);
  if (sdp === null || sdp === "") return `An answer needs an \`sdp\` string of at most ${String(PHONE_SDP_MAX_CHARS)} characters.`;
  return { kind: "answer", sdp };
}

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
  | { readonly type: "phonePublish"; readonly snapshot: PhoneSnapshot }
  /**
   * T1397b — the page's half of one phone's camera handshake. Told, not asked: relayed to
   * that phone's stream only, and dropped when no phone by that id is connected.
   */
  | { readonly type: "phoneSignal"; readonly phone: string; readonly message: PhoneSignalToPhone }
  /**
   * T1526b — the page refused one of that phone's writes (`PhoneRefused`). Told, not asked:
   * relayed to that phone's stream only as a `refused` event, dropped when it is gone.
   */
  | ({ readonly type: "phoneRefuse"; readonly phone: string } & PhoneRefused);

/**
 * T1511b — the macOS application firewall will refuse every phone before it reaches the
 * door: it is on, and `binary` (the helper's own executable, symlinks resolved) is not in
 * its allowed list. Said only when the helper MEASURED it; a probe that could not tell
 * says nothing.
 */
export interface PhoneFirewallBlock {
  readonly blocked: true;
  readonly binary: string;
}

/** What `phoneOpen`/`phoneClose` report. `url` carries the token; it is what the QR encodes. */
export type PhoneDoorState =
  | {
      readonly open: true;
      readonly url: string;
      readonly fingerprint: string;
      readonly phones: readonly PhonePeer[];
      /** T1511b: present only when the firewall was measured refusing this helper. */
      readonly firewall?: PhoneFirewallBlock;
    }
  | { readonly open: false; readonly reason: string };

/** T1511b — the macOS application firewall's command-line tool. */
export const MAC_FIREWALL_TOOL = "/usr/libexec/ApplicationFirewall/socketfilterfw";

/**
 * T1511b — the two commands that let `binary` take incoming connections, for a person to
 * run themselves: the helper never runs sudo and never changes a setting. `--add` puts it
 * in the list; `--unblockapp` flips it to allowed if it was there as blocked. A path with
 * anything outside the shell-safe set is single-quoted so it pastes as one argument.
 */
export function firewallAllowCommands(binary: string): readonly [string, string] {
  const arg = /^[A-Za-z0-9_./+@:-]+$/.test(binary) ? binary : `'${binary.replaceAll("'", "'\\''")}'`;
  return [`sudo ${MAC_FIREWALL_TOOL} --add ${arg}`, `sudo ${MAC_FIREWALL_TOOL} --unblockapp ${arg}`];
}

/** HOST → PAGE additions to `DeviceHostMessage`. Same id/push rule as the device role. */
export type PhoneHostMessage =
  | { readonly type: "phoneOpened"; readonly id: number; readonly state: PhoneDoorState }
  /** PUSH. A phone wrote. The page vets it; the helper has already checked the token. */
  | { readonly type: "phoneWrite"; readonly stream: "phone"; readonly phone: string; readonly set: PhoneSet }
  /** PUSH. The door's state changed on its own: a phone came or went, the listener failed. */
  | { readonly type: "phoneState"; readonly stream: "phone"; readonly state: PhoneDoorState }
  /** PUSH (T1397b). A phone's half of its camera handshake; the token was checked, the shape too. */
  | { readonly type: "phoneSignal"; readonly stream: "phone"; readonly phone: string; readonly message: PhoneSignalFromPhone };
