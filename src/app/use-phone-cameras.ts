import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { DeviceClient } from "@devices/device-client.ts";
import type { PhoneCameraRequest, PhoneDoorState } from "@devices/phone/phone-protocol.ts";
import type { PhoneCameraView } from "@editor/controls/phone-door-copy.ts";
import { cameraGrantOf, type CameraGrant, type CameraRequest, type CameraTrackSettings } from "./camera-request.ts";
import type { MediaElement } from "./media-sources.ts";
import type { OpenedCamera } from "./use-media-sources.ts";
import {
  createPhoneCameraReceiver,
  type PhoneCameraFeed,
  type PhoneCameraReceiver,
  type PhonePeerConnection,
} from "./phone-camera-receiver.ts";

/**
 * T1397b — A PHONE AS A WEBCAM DEVICE: the desk's end of every phone camera.
 *
 * There is no phone node. A Webcam whose `device` is `phone:<name>` (`media.ts`) is opened
 * by the media hook through `opener` here instead of `getUserMedia`, and gets back the same
 * `OpenedCamera` a local camera gives — an element, the grant read live, a stop — so
 * everything downstream (the media source, the resize to what arrived, the Camera section)
 * is the webcam's own. Owner's rule: one camera node, fewer concepts.
 *
 * ## What this hook does
 *
 *  - **Receives.** Every phone that presses Send camera gets an answer and a feed
 *    (`createPhoneCameraReceiver`), whether or not a node names it yet: a Webcam pointed at
 *    it later picks up a camera that is already live, the device picker can list it, and
 *    the Phone popover can say who is sending. The phone's own camera prompt was the
 *    consent; a remote track raises no permission on this machine.
 *  - **Opens, and never refuses.** `open` hands back an element at once. A phone that is
 *    not sending yet shows nothing (the node's texture keeps its contents) and starts
 *    showing the moment it does; meanwhile the node carries a `media.unavailable` warning
 *    saying which phone and why, like a missing camera. Opening does not WAIT for the
 *    phone, because the media hook opens its nodes as one set, and a phone arriving or
 *    leaving must not re-open every movie and camera in the document.
 *  - **Asks.** The node's Capture parameters (facing, size, rate, Require) go to the phone
 *    it is showing as a `request` whenever they ask anything — on open, which the media
 *    hook re-does on any Capture change, and again when that phone starts a new session.
 *    The phone's own buttons stay; whichever end chose last wins (`PhoneCameraRequest`).
 *
 * Teardown: a phone's bye ends its feed; a phone leaving the door drops it; the door
 * closing drops every one (its state lists no phones); the media hook's `stop` detaches a
 * node; unmount closes every connection.
 */

/** A `<video>` the hook points at whichever stream a node's phone is sending. */
export interface PhoneCameraVideo {
  readonly element: MediaElement;
  /** Show this stream, or nothing (the node then keeps its last frame). */
  show(stream: MediaStream | null): void;
  /** Detach for good. */
  stop(): void;
}

/** Where the hook meets the browser. Injectable: jsdom has no WebRTC and no decoder. */
export interface PhoneCameraEnvironment {
  createPeer(): PhonePeerConnection;
  createVideo(): PhoneCameraVideo;
}

export function browserPhoneCameraEnvironment(): PhoneCameraEnvironment {
  return {
    // LAN only: see `phone-camera-receiver.ts` for why no STUN/TURN server is named.
    createPeer: () => new RTCPeerConnection({ iceServers: [] }) as unknown as PhonePeerConnection,
    createVideo() {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      return {
        element: video as unknown as MediaElement,
        show(stream) {
          video.srcObject = stream;
          // Kicked, never awaited (T493): a stream that never produces a frame must not hang this.
          if (stream !== null) void video.play().catch(() => undefined);
        },
        stop() {
          video.pause();
          video.srcObject = null;
        },
      };
    },
  };
}

/** How the media hook opens a Webcam whose device is `phone:<name>`. Stable for the hook's life. */
export interface PhoneCameraOpener {
  open(nodeId: NodeId, name: string, request: CameraRequest): OpenedCamera;
}

export interface PhoneCamerasOptions {
  readonly deviceClient: () => DeviceClient | null;
  /** The phone door as `usePhoneDoor` last heard it. Null until the page asked. */
  readonly door: PhoneDoorState | null;
  readonly environment?: PhoneCameraEnvironment;
}

export interface PhoneCameras {
  readonly opener: PhoneCameraOpener;
  /** Why a Webcam on a phone shows nothing new. Merged into the problems surface. */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** Which phones are sending, for the Phone popover. */
  readonly feeds: readonly PhoneCameraView[];
  /** The names phones are sending under now, for the Webcam's device picker. */
  readonly sending: readonly string[];
}

/**
 * The feed a phone device shows: the first one still sending under its name (ignoring
 * case), or — for a bare `phone:` — the first one still sending at all. When nothing
 * matching is sending, the latest matching feed that ENDED, so the node can say which
 * phone stopped and why.
 */
export function choosePhoneFeed(feeds: readonly PhoneCameraFeed[], name: string): PhoneCameraFeed | null {
  const wanted = name.trim().toLowerCase();
  const matching = wanted === "" ? feeds : feeds.filter((feed) => feed.name.toLowerCase() === wanted);
  return matching.find((feed) => feed.state !== "ended") ?? matching.at(-1) ?? null;
}

/** The node's Capture parameters as a phone request, or null when they ask for nothing. */
export function phoneRequestOf(request: CameraRequest): PhoneCameraRequest | null {
  const whole = (value: number, max: number): number =>
    Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : 0;
  const ask: PhoneCameraRequest = {
    facing: request.facing === "any" ? null : request.facing,
    width: whole(request.width, 7680),
    height: whole(request.height, 4320),
    frameRate: whole(request.frameRate, 240),
    exact: request.exact,
  };
  return ask.facing === null && ask.width === 0 && ask.height === 0 && ask.frameRate === 0 ? null : ask;
}

interface Binding {
  readonly nodeId: NodeId;
  readonly name: string;
  readonly request: CameraRequest;
  readonly video: PhoneCameraVideo;
  /** The stream the element shows now. */
  stream: MediaStream | null;
  /** The phone (connection id) the request was last sent to; null = send on the next feed. */
  askedOf: string | null;
}

const label = (name: string): string => (name === "" ? "any phone" : `"${name}"`);

function diagnosticFor(binding: Binding, feed: PhoneCameraFeed | null, door: PhoneDoorState | null): RuntimeDiagnostic | null {
  const { nodeId, name } = binding;
  if (feed?.state === "live") return null;
  if (feed?.state === "connecting") {
    return { severity: "info", code: "media.connecting", nodeId, message: `The phone camera ${label(name)} for "${nodeId}" is connecting.` };
  }
  if (feed?.state === "ended") {
    return {
      severity: "warning",
      code: "media.unavailable",
      nodeId,
      message: `The phone camera ${label(name)} for "${nodeId}" stopped sending; its last frame holds.`,
      suggestion: feed.reason ?? "Press Send camera on the phone again.",
    };
  }
  return {
    severity: "warning",
    code: "media.unavailable",
    nodeId,
    message: `The phone camera ${label(name)} for "${nodeId}" is not sending.`,
    suggestion:
      door?.open === true
        ? `On the phone${name === "" ? "" : ` named "${name}"`}, press Send camera.`
        : "Open Phone in the controls pane, scan the code with the phone, and press Send camera there.",
  };
}

export function usePhoneCameras(options: PhoneCamerasOptions): PhoneCameras {
  const { deviceClient, door } = options;
  const [feeds, setFeeds] = useState<readonly PhoneCameraFeed[]>([]);
  /** Bumped when a node opens or stops a phone, so its diagnostic follows. */
  const [bound, setBound] = useState(0);
  const env = useMemo(
    () => options.environment ?? browserPhoneCameraEnvironment(),
    // The environment is injected once by a test; a new one per render would drop every feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const feedsRef = useRef<readonly PhoneCameraFeed[]>([]);
  const clientRef = useRef<DeviceClient | null>(null);
  const bindings = useRef(new Set<Binding>());

  /** Point every open node at its phone's current stream; ask a newly shown phone. */
  const sync = useRef((): void => {
    for (const binding of bindings.current) {
      const feed = choosePhoneFeed(feedsRef.current, binding.name);
      const live = feed !== null && feed.state !== "ended" ? feed : null;
      const stream = live?.stream ?? null;
      if (stream !== binding.stream) {
        binding.stream = stream;
        binding.video.show(stream);
      }
      if (live === null) {
        binding.askedOf = null;
      } else if (binding.askedOf !== live.phone) {
        binding.askedOf = live.phone;
        const ask = phoneRequestOf(binding.request);
        if (ask !== null) clientRef.current?.phoneSignal(live.phone, { kind: "request", ...ask });
      }
    }
  }).current;

  // Receive: one receiver per device client, fed by its pushes.
  const receiverRef = useRef<PhoneCameraReceiver | null>(null);
  useEffect(() => {
    const client = deviceClient();
    if (client === null) return;
    clientRef.current = client;
    const receiver = createPhoneCameraReceiver({
      send: (phone, message) => client.phoneSignal(phone, message),
      onChange: () => {
        feedsRef.current = receiver.feeds();
        setFeeds(feedsRef.current);
        sync();
      },
      createPeer: () => env.createPeer(),
    });
    receiverRef.current = receiver;
    const off = client.onPhoneSignal((phone, message) => receiver.signal(phone, message));
    return () => {
      off();
      receiver.dispose();
      if (receiverRef.current === receiver) receiverRef.current = null;
      if (clientRef.current === client) clientRef.current = null;
      feedsRef.current = [];
      setFeeds([]);
      sync();
    };
  }, [deviceClient, env, sync]);

  // A phone that left the door, or the door closing, takes its feed with it.
  const present = door?.open === true ? door.phones.map((peer) => peer.phone).join("\n") : "";
  useEffect(() => {
    receiverRef.current?.present(present === "" ? [] : present.split("\n"));
  }, [present, deviceClient]);

  const opener = useMemo<PhoneCameraOpener>(
    () => ({
      open(nodeId, name, request) {
        const video = env.createVideo();
        const binding: Binding = { nodeId, name, request, video, stream: null, askedOf: null };
        bindings.current.add(binding);
        sync();
        setBound((count) => count + 1);
        return {
          element: video.element,
          // Read per call (§V986): what ARRIVED — the element's decoded size — over whatever
          // the remote track reports. The phone's own camera limits are not reported here.
          grant(): CameraGrant | null {
            const track = binding.stream?.getVideoTracks?.()[0];
            const settings: CameraTrackSettings = { ...(track?.getSettings?.() ?? {}) };
            const { videoWidth, videoHeight } = video.element;
            return cameraGrantOf(videoWidth > 0 && videoHeight > 0 ? { ...settings, width: videoWidth, height: videoHeight } : settings);
          },
          limits: () => null,
          waiting: () => {
            const feed = choosePhoneFeed(feedsRef.current, name);
            return feed?.state === "live" ? null : (diagnosticFor(binding, feed, null)?.message ?? null);
          },
          stop() {
            if (!bindings.current.delete(binding)) return;
            video.stop();
            setBound((count) => count + 1);
          },
        };
      },
    }),
    [env, sync],
  );

  const diagnostics = useMemo(() => {
    const out: RuntimeDiagnostic[] = [];
    for (const binding of bindings.current) {
      const found = diagnosticFor(binding, choosePhoneFeed(feeds, binding.name), door);
      if (found !== null) out.push(found);
    }
    return out;
    // `bound` stands for the bindings set, which is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feeds, door, bound]);

  const views = useMemo(
    () => feeds.map((feed): PhoneCameraView => ({ phone: feed.phone, name: feed.name, state: feed.state })),
    [feeds],
  );
  const sending = useMemo(
    () => [...new Set(feeds.filter((feed) => feed.state !== "ended").map((feed) => feed.name))],
    [feeds],
  );

  return useMemo(() => ({ opener, diagnostics, feeds: views, sending }), [opener, diagnostics, views, sending]);
}
