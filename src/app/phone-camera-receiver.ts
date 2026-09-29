import type {
  PhoneIceCandidate,
  PhoneSignalFromPhone,
  PhoneSignalToPhone,
} from "@devices/phone/phone-protocol.ts";

/**
 * T1397b — THE PAGE'S END OF EVERY PHONE CAMERA: one `RTCPeerConnection` per sending phone.
 *
 * The phone offers (it has the camera); this answers. What arrives from the helper is the
 * phone's offer, its ICE candidates and its bye (`phoneSignal`, shape-checked on the way);
 * what goes back is the answer, this page's candidates and a bye with a reason. The video
 * then flows phone → this tab directly; the helper never carries a frame.
 *
 * ## Receive-only, by construction
 *
 * The answer is made against the phone's send-only offer with no local track added, which
 * is what makes this side's transceiver `recvonly`: nothing on this page is offered back to
 * the phone, so there is nothing of the desk's to leak onto the wifi.
 *
 * ## LAN only: `iceServers: []`
 *
 * No STUN, no TURN. On one wifi the host candidates are enough — and this page's own host
 * candidates are usually mDNS names (`….local`, the browser hides the address from a page
 * that holds no camera permission), which is fine: the PHONE holds a camera grant, so its
 * candidates carry real addresses, and this side's checks reach it and are answered. A
 * network that blocks peers from reaching each other also blocks the phone door itself.
 *
 * ## Why the connection id and not the name keys a feed
 *
 * The helper's id for a phone is per event stream; the name is what the phone's owner
 * typed. Two phones may carry one name, and one phone's reconnect is a new stream that
 * offers again. So feeds are keyed by the stream that sent them, and the NAME is data a
 * Webcam node's `phone:<name>` device chooses by (`use-phone-cameras.ts`).
 */

/** The members of `RTCPeerConnection` used here. Structural, so a test hands in a fake. */
export interface PhonePeerConnection {
  readonly connectionState: string;
  readonly localDescription: { readonly sdp: string } | null;
  onicecandidate:
    | ((event: { readonly candidate: { readonly candidate: string; readonly sdpMid: string | null; readonly sdpMLineIndex: number | null } | null }) => void)
    | null;
  ontrack: ((event: { readonly streams: readonly MediaStream[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  setRemoteDescription(description: { readonly type: "offer"; readonly sdp: string }): Promise<void>;
  createAnswer(): Promise<{ readonly type: string; readonly sdp?: string }>;
  setLocalDescription(description: { readonly type: string; readonly sdp?: string }): Promise<void>;
  addIceCandidate(candidate: PhoneIceCandidate): Promise<void>;
  close(): void;
}

export type PhoneCameraState = "connecting" | "live" | "ended";

/** One phone's camera as this page knows it. Replaced, never mutated, on every change. */
export interface PhoneCameraFeed {
  /** The helper's id for the phone's event stream (`PhonePeer.phone`). */
  readonly phone: string;
  /** What the phone sends under; what a Webcam node's `phone:<name>` device matches. */
  readonly name: string;
  readonly state: PhoneCameraState;
  /** Present from the moment the phone's track arrives; its frames once `live`. */
  readonly stream: MediaStream | null;
  /** Why it ended, when it did. */
  readonly reason?: string;
}

export interface PhoneCameraReceiverOptions {
  /** One signal to one phone, through the helper (`DeviceClient.phoneSignal`). */
  send(phone: string, message: PhoneSignalToPhone): void;
  /** Something about a feed changed; `feeds()` has the new list. */
  onChange(): void;
  /** Default: `new RTCPeerConnection({ iceServers: [] })`. */
  createPeer?: () => PhonePeerConnection;
}

export interface PhoneCameraReceiver {
  /** A phone's half of its handshake. */
  signal(phone: string, message: PhoneSignalFromPhone): void;
  /** The phones the door says are connected. A feed whose phone is not among them is dropped. */
  present(phones: readonly string[]): void;
  /** Every feed, in the order the phones started sending. */
  feeds(): readonly PhoneCameraFeed[];
  /** Close every connection. Nothing is sent: the door (or the tab) is going away. */
  dispose(): void;
}

interface Entry {
  readonly peer: PhonePeerConnection;
  feed: PhoneCameraFeed;
  /** Candidates that came before the offer was applied. */
  readonly early: PhoneIceCandidate[];
  described: boolean;
}

export function createPhoneCameraReceiver(options: PhoneCameraReceiverOptions): PhoneCameraReceiver {
  const createPeer =
    options.createPeer ?? (() => new RTCPeerConnection({ iceServers: [] }) as unknown as PhonePeerConnection);
  /** Insertion order is start order: a re-offer deletes and re-adds. */
  const entries = new Map<string, Entry>();
  let list: readonly PhoneCameraFeed[] = [];
  let disposed = false;

  const changed = (): void => {
    list = [...entries.values()].map((entry) => entry.feed);
    options.onChange();
  };

  const update = (phone: string, entry: Entry, next: Partial<PhoneCameraFeed>): void => {
    if (entries.get(phone) !== entry) return;
    entry.feed = { ...entry.feed, ...next };
    changed();
  };

  /** This side gives up on a feed: close it, say why to the phone, keep the entry as ended. */
  const end = (phone: string, entry: Entry, reason: string, tell: boolean): void => {
    if (entries.get(phone) !== entry || entry.feed.state === "ended") return;
    entry.peer.onicecandidate = null;
    entry.peer.ontrack = null;
    entry.peer.onconnectionstatechange = null;
    entry.peer.close();
    if (tell) options.send(phone, { kind: "bye", reason });
    update(phone, entry, { state: "ended", reason });
  };

  const drop = (phone: string): void => {
    const entry = entries.get(phone);
    if (entry === undefined) return;
    entry.peer.onicecandidate = null;
    entry.peer.ontrack = null;
    entry.peer.onconnectionstatechange = null;
    entry.peer.close();
    entries.delete(phone);
  };

  const offer = (phone: string, sdp: string, name: string): void => {
    // A new offer from the same stream replaces the old connection outright.
    drop(phone);
    const peer = createPeer();
    const entry: Entry = {
      peer,
      feed: { phone, name, state: "connecting", stream: null },
      early: [],
      described: false,
    };
    entries.set(phone, entry);
    peer.onicecandidate = (event) => {
      if (entries.get(phone) !== entry || event.candidate === null) return;
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
      options.send(phone, { kind: "ice", candidate, sdpMid, sdpMLineIndex });
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream !== undefined && entry.feed.stream !== stream) update(phone, entry, { stream });
    };
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === "connected") update(phone, entry, { state: "live" });
      else if (state === "failed") end(phone, entry, "The connection to the phone failed.", true);
      // `disconnected` is often a moment of bad wifi that ICE recovers from on its own.
      else if (state === "disconnected" && entry.feed.state === "live") update(phone, entry, { state: "connecting" });
    };
    changed();
    void (async () => {
      try {
        await peer.setRemoteDescription({ type: "offer", sdp });
        entry.described = true;
        for (const candidate of entry.early.splice(0)) void peer.addIceCandidate(candidate).catch(() => undefined);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (entries.get(phone) !== entry) return;
        options.send(phone, { kind: "answer", sdp: peer.localDescription?.sdp ?? answer.sdp ?? "" });
      } catch (error) {
        end(phone, entry, `This tab could not answer the phone's camera: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  };

  return {
    signal(phone, message) {
      if (disposed) return;
      if (message.kind === "offer") {
        offer(phone, message.sdp, message.name);
        return;
      }
      const entry = entries.get(phone);
      if (entry === undefined) return;
      if (message.kind === "bye") {
        end(phone, entry, message.reason === undefined ? "The phone stopped sending." : `The phone stopped: ${message.reason}`, false);
        return;
      }
      const candidate: PhoneIceCandidate = {
        candidate: message.candidate,
        sdpMid: message.sdpMid,
        sdpMLineIndex: message.sdpMLineIndex,
      };
      // One unusable candidate is not a failed connection; the others may well work.
      if (entry.described) void entry.peer.addIceCandidate(candidate).catch(() => undefined);
      else entry.early.push(candidate);
    },
    present(phones) {
      const here = new Set(phones);
      let any = false;
      for (const phone of [...entries.keys()]) {
        if (here.has(phone)) continue;
        drop(phone);
        any = true;
      }
      if (any) changed();
    },
    feeds: () => list,
    dispose() {
      disposed = true;
      for (const phone of [...entries.keys()]) drop(phone);
      list = [];
    },
  };
}
