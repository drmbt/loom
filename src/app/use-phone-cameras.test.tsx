// @vitest-environment jsdom
import { flatDocument } from "@compiler/test-support.ts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DeviceClient } from "@devices/device-client.ts";
import type {
  PhoneDoorState,
  PhoneIceCandidate,
  PhoneSignalFromPhone,
  PhoneSignalToPhone,
} from "@devices/phone/phone-protocol.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { LoomBackend, MediaSource } from "@runtime/backend/index.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import type { MediaElement } from "./media-sources.ts";
import type { PhonePeerConnection } from "./phone-camera-receiver.ts";
import { useMediaSources, type MediaEnvironment } from "./use-media-sources.ts";
import { usePhoneCameras, type PhoneCameraEnvironment } from "./use-phone-cameras.ts";

/**
 * T1397b — A PHONE IS A WEBCAM DEVICE, through the webcam's own path.
 *
 * The desk's two hooks run together as `app.tsx` composes them: `usePhoneCameras` receives
 * the phones, and `useMediaSources` opens a Webcam whose device is `phone:<name>` through
 * its opener. The browser is faked at the two seams the hooks take — the phone hook's
 * `PhoneCameraEnvironment` (jsdom has no WebRTC and no decoder) and the media hook's
 * `MediaEnvironment` (whose `openCamera` must never be called for a phone) — and the
 * helper at the device client's two phone-signal members. What is asserted is what the
 * desk SAYS to the phone (answer, candidates, request, bye), what it hands its peer
 * connection, and what the renderer would READ BACK from the node's registered source.
 */

afterEach(() => cleanup());

class FakePeer implements PhonePeerConnection {
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  onicecandidate: PhonePeerConnection["onicecandidate"] = null;
  ontrack: PhonePeerConnection["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;
  remote: unknown = null;
  readonly ice: PhoneIceCandidate[] = [];
  closed = false;
  setRemoteDescription(description: { type: "offer"; sdp: string }): Promise<void> {
    this.remote = description;
    return Promise.resolve();
  }
  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: "answer", sdp: "ANSWER-SDP" });
  }
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = { sdp: description.sdp ?? "" };
    return Promise.resolve();
  }
  addIceCandidate(candidate: PhoneIceCandidate): Promise<void> {
    this.ice.push(candidate);
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
  }
  state(next: string): void {
    this.connectionState = next;
    this.onconnectionstatechange?.();
  }
}

/** A `<video>` as far as the media hook reads one: a size, events, a frame per `timeupdate`. */
class FakeVideo implements MediaElement {
  videoWidth = 0;
  videoHeight = 0;
  shown: MediaStream | null = null;
  stopped = false;
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  /** One decoded frame at this size, with the events a real element raises for it. */
  frame(width: number, height: number): void {
    const resized = width !== this.videoWidth || height !== this.videoHeight;
    this.videoWidth = width;
    this.videoHeight = height;
    if (resized) {
      this.fire("loadedmetadata");
      this.fire("resize");
    }
    this.fire("timeupdate");
  }
}

const stream = (id: string): MediaStream => ({ id, getVideoTracks: () => [] }) as unknown as MediaStream;

function harness() {
  const peers: FakePeer[] = [];
  const videos: FakeVideo[] = [];
  const phoneEnvironment: PhoneCameraEnvironment = {
    createPeer: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer;
    },
    createVideo: () => {
      const video = new FakeVideo();
      videos.push(video);
      return {
        element: video,
        show: (shown) => {
          video.shown = shown;
          if (shown === null) {
            video.videoWidth = 0;
            video.videoHeight = 0;
          }
        },
        stop: () => {
          video.stopped = true;
        },
      };
    },
  };
  const localCameraOpens: unknown[] = [];
  const mediaEnvironment: MediaEnvironment = {
    openFile: () => Promise.reject(new Error("no files here")),
    openStill: () => Promise.reject(new Error("no stills here")),
    openCamera: (request) => {
      localCameraOpens.push(request);
      return Promise.reject(Object.assign(new Error("no local camera"), { name: "NotFoundError" }));
    },
  };
  const listeners = new Set<(phone: string, message: PhoneSignalFromPhone) => void>();
  const sent: Array<{ phone: string; message: PhoneSignalToPhone }> = [];
  const client = {
    onPhoneSignal(listener: (phone: string, message: PhoneSignalFromPhone) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    phoneSignal(phone: string, message: PhoneSignalToPhone) {
      sent.push({ phone, message });
    },
  } as unknown as DeviceClient;
  const deviceClient = (): DeviceClient => client;
  /** What the renderer would find under each source id right now. */
  const sources = new Map<string, MediaSource>();
  const backend = {
    registerMediaSource(id: string, source: MediaSource) {
      sources.set(id, source);
      return () => {
        if (sources.get(id) === source) sources.delete(id);
      };
    },
  } as unknown as LoomBackend;
  return {
    peers,
    videos,
    phoneEnvironment,
    mediaEnvironment,
    localCameraOpens,
    sent,
    deviceClient,
    sources,
    backend,
    /** The helper relays a phone's signal to this page. */
    async fromPhone(phone: string, message: PhoneSignalFromPhone) {
      await act(async () => {
        for (const listener of [...listeners]) listener(phone, message);
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
      });
    },
    /** Which phone stream the renderer would draw for a node: the element its source hands back. */
    drawn(nodeId: string): string | null {
      const frame = sources.get(`media:${nodeId}`)?.currentFrame() as { image?: unknown } | undefined;
      const video = videos.find((each) => each === frame?.image);
      return video?.shown === null || video === undefined ? null : ((video.shown as unknown as { id: string }).id ?? null);
    },
  };
}

async function webcams(devices: Array<Record<string, unknown>>): Promise<{ runtime: AppRuntime; ids: string[] }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "desk", label: "Desk" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "cameras",
      operations: devices.map((parameters, index) => ({
        op: "addNode",
        ref: `$cam${String(index)}`,
        type: "webcam",
        position: { x: index * 300, y: 0 },
        label: `cam${String(index + 1)}`,
        parameters,
      })),
    } as never,
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  const ids = devices.map((_, index) => {
    const node = Object.values(runtime.bus.store.getGraph().nodes).find((each) => each.label === `cam${String(index + 1)}`);
    if (node === undefined) throw new Error("the node did not land");
    return node.id;
  });
  return { runtime, ids };
}

const OPEN = (...phones: string[]): PhoneDoorState => ({
  open: true,
  url: "https://192.168.1.20:43920/?t=x",
  fingerprint: "AA:BB",
  phones: phones.map((phone) => ({ phone, userAgent: `Agent ${phone}` })),
});
const OFFER = (name: string): PhoneSignalFromPhone => ({ kind: "offer", sdp: `OFFER-${name}`, name });

/** The desk: both hooks, as `app.tsx` composes them. */
function mountDesk(
  h: ReturnType<typeof harness>,
  runtime: AppRuntime,
  initial: { door: PhoneDoorState; graph?: GraphDocument },
) {
  return renderHook(
    ({ door, graph }: { door: PhoneDoorState; graph: GraphDocument }) => {
      const phones = usePhoneCameras({ deviceClient: h.deviceClient, door, environment: h.phoneEnvironment });
      const media = useMediaSources(runtime, h.backend, flatDocument(graph), null, h.mediaEnvironment, undefined, phones.opener);
      return { phones, media };
    },
    { initialProps: { door: initial.door, graph: initial.graph ?? runtime.bus.store.getGraph() } },
  );
}

describe("T1397b — a Webcam whose device is a phone", () => {
  it("opens through the phone door (never getUserMedia), answers the phone, relays candidates, and draws THAT phone's stream", async () => {
    const h = harness();
    const { runtime, ids } = await webcams([{ device: "phone:Back cam" }]);
    const cam = ids[0]!;
    const view = mountDesk(h, runtime, { door: OPEN("p1") });
    await waitFor(() => expect(h.sources.has(`media:${cam}`)).toBe(true));
    expect(h.localCameraOpens).toEqual([]);
    // Registered at once and black; the node says which phone and why, like a missing camera.
    expect(h.drawn(cam)).toBeNull();
    expect(view.result.current.phones.diagnostics.map((each) => [each.code, each.severity, each.message])).toEqual([
      ["media.unavailable", "warning", `The phone camera "Back cam" for "${cam}" is not sending.`],
    ]);
    expect(view.result.current.media.cameraStatus(cam as never)).toMatchObject({
      kind: "error",
      message: `The phone camera "Back cam" for "${cam}" is not sending.`,
    });

    await h.fromPhone("p1", OFFER("back CAM"));
    const peer = h.peers[0]!;
    expect(peer.remote).toEqual({ type: "offer", sdp: "OFFER-back CAM" });
    expect(h.sent).toEqual([{ phone: "p1", message: { kind: "answer", sdp: "ANSWER-SDP" } }]);
    const theirs = { candidate: "candidate:1 1 udp 1 192.168.1.40 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    await h.fromPhone("p1", { kind: "ice", ...theirs });
    expect(peer.ice).toEqual([theirs]);
    const ours = { candidate: "candidate:2 1 udp 1 abc.local 50001 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    act(() => peer.onicecandidate?.({ candidate: ours }));
    expect(h.sent.at(-1)).toEqual({ phone: "p1", message: { kind: "ice", ...ours } });

    // The track: the node's element now shows the phone's stream, and its frames are what is drawn.
    act(() => peer.ontrack?.({ streams: [stream("back")] }));
    act(() => h.videos[0]!.frame(1280, 720));
    expect(h.drawn(cam)).toBe("back");
    act(() => peer.state("connected"));
    expect(view.result.current.phones.diagnostics).toEqual([]);
    expect(view.result.current.phones.feeds).toEqual([{ phone: "p1", name: "back CAM", state: "live" }]);
    expect(view.result.current.phones.sending).toEqual(["back CAM"]);
    // The grant is what ARRIVED, read off the element — never the request echoed.
    expect(view.result.current.media.cameraStatus(cam as never)).toMatchObject({
      kind: "live",
      granted: { width: 1280, height: 720 },
      limits: null,
    });
  });

  it("the node's resolution follows what arrives — and follows the phone when it turns on its side", async () => {
    const h = harness();
    const { runtime, ids } = await webcams([{ device: "phone:Back cam" }]);
    const cam = ids[0]!;
    mountDesk(h, runtime, { door: OPEN("p1") });
    await waitFor(() => expect(h.videos).toHaveLength(1));
    await h.fromPhone("p1", OFFER("Back cam"));
    act(() => h.peers[0]!.ontrack?.({ streams: [stream("back")] }));
    const resolution = () => runtime.bus.store.getGraph().nodes[cam as never]?.resolution;
    await act(async () => h.videos[0]!.frame(1280, 720));
    await waitFor(() => expect(resolution()).toEqual({ mode: "fixed", width: 1280, height: 720 }));
    await act(async () => h.videos[0]!.frame(720, 1280));
    await waitFor(() => expect(resolution()).toEqual({ mode: "fixed", width: 720, height: 1280 }));
  });

  it("the Capture parameters are asked of the phone it shows — and nothing is asked when they ask nothing", async () => {
    const h = harness();
    const { runtime, ids } = await webcams([
      { device: "phone:Back cam", facing: "user", width: 1920, height: 1080, frameRate: 30, fit: "require" },
      { device: "phone:Plain" },
    ]);
    const view = mountDesk(h, runtime, { door: OPEN("p1", "p2") });
    await waitFor(() => expect(h.videos).toHaveLength(2));
    await h.fromPhone("p1", OFFER("Back cam"));
    await h.fromPhone("p2", OFFER("Plain"));
    const requests = () => h.sent.filter((each) => each.message.kind === "request");
    expect(requests()).toEqual([
      { phone: "p1", message: { kind: "request", facing: "user", width: 1920, height: 1080, frameRate: 30, exact: true } },
    ]);

    // Flip to the back camera on the desk: the webcam re-opens, and the phone is asked again.
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "flip",
        operations: [{ op: "setParameters", nodeId: ids[0], parameters: { facing: "environment" } }],
      } as never,
      runtime.invocation,
    );
    expect(result.output.status).toBe("applied");
    view.rerender({ door: OPEN("p1", "p2"), graph: runtime.bus.store.getGraph() });
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]).toEqual({
      phone: "p1",
      message: { kind: "request", facing: "environment", width: 1920, height: 1080, frameRate: 30, exact: true },
    });
    // Re-opening is not re-connecting: still the one connection per phone.
    expect(h.peers.map((peer) => peer.closed)).toEqual([false, false]);
  });

  it("a bye unbinds: the peer closes, nothing new is drawn (the texture keeps its last frame), the node says so — and a new session is shown and asked again", async () => {
    const h = harness();
    const { runtime, ids } = await webcams([{ device: "phone:Back cam", facing: "environment" }]);
    const cam = ids[0]!;
    const view = mountDesk(h, runtime, { door: OPEN("p1") });
    await waitFor(() => expect(h.videos).toHaveLength(1));
    await h.fromPhone("p1", OFFER("Back cam"));
    act(() => h.peers[0]!.ontrack?.({ streams: [stream("first")] }));
    act(() => h.videos[0]!.frame(640, 480));
    expect(h.drawn(cam)).toBe("first");

    await h.fromPhone("p1", { kind: "bye", reason: "The camera is busy — another app may be using it." });
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.drawn(cam)).toBeNull();
    expect(view.result.current.phones.diagnostics).toEqual([
      expect.objectContaining({
        code: "media.unavailable",
        message: `The phone camera "Back cam" for "${cam}" stopped sending; its last frame holds.`,
        suggestion: "The phone stopped: The camera is busy — another app may be using it.",
      }),
    ]);
    // The desk does not answer a phone's bye with one of its own. (The request goes the
    // moment the phone's offer lands, ahead of the answer; the phone takes either order.)
    expect(h.sent.map((each) => each.message.kind)).toEqual(["request", "answer"]);

    await h.fromPhone("p1", OFFER("Back cam"));
    act(() => h.peers[1]!.ontrack?.({ streams: [stream("second")] }));
    act(() => h.videos[0]!.frame(640, 480));
    expect(h.drawn(cam)).toBe("second");
    expect(h.sent.map((each) => each.message.kind)).toEqual(["request", "answer", "request", "answer"]);
  });

  it("a phone leaving the door, or the door closing, closes its connection; unmount closes the rest and detaches the node", async () => {
    const h = harness();
    const { runtime, ids } = await webcams([{ device: "phone:" }]);
    const cam = ids[0]!;
    const view = mountDesk(h, runtime, { door: OPEN("p1", "p2") });
    await waitFor(() => expect(h.videos).toHaveLength(1));
    await h.fromPhone("p1", OFFER("One"));
    await h.fromPhone("p2", OFFER("Two"));
    act(() => h.peers[0]!.ontrack?.({ streams: [stream("one")] }));
    act(() => h.peers[1]!.ontrack?.({ streams: [stream("two")] }));
    act(() => h.videos[0]!.frame(640, 480));
    // A bare `phone:` takes the first phone sending.
    expect(h.drawn(cam)).toBe("one");

    // p1 leaves: its connection closes and the node moves to the next phone sending.
    view.rerender({ door: OPEN("p2"), graph: runtime.bus.store.getGraph() });
    act(() => h.videos[0]!.frame(640, 480));
    expect(h.peers.map((peer) => peer.closed)).toEqual([true, false]);
    expect(h.drawn(cam)).toBe("two");

    // The door closes: everything goes, and the node says the door is where to start.
    view.rerender({ door: { open: false, reason: "closed" }, graph: runtime.bus.store.getGraph() });
    expect(h.peers[1]!.closed).toBe(true);
    expect(h.drawn(cam)).toBeNull();
    expect(view.result.current.phones.diagnostics.map((each) => each.suggestion)).toEqual([
      "Open Phone in the controls pane, scan the code with the phone, and press Send camera there.",
    ]);

    view.rerender({ door: OPEN("p3"), graph: runtime.bus.store.getGraph() });
    await h.fromPhone("p3", OFFER("Three"));
    view.unmount();
    expect(h.peers[2]!.closed).toBe(true);
    expect(h.videos[0]!.stopped).toBe(true);
    expect(h.sources.has(`media:${cam}`)).toBe(false);
  });

  it("each Webcam takes the phone its device names, ignoring case; a muted one opens nothing and says nothing", async () => {
    const h = harness();
    const { runtime, ids } = await webcams([{ device: "phone:front" }, { device: "phone:BACK" }, { device: "phone:Nobody" }]);
    const [front, back, missing] = ids as [string, string, string];
    const document = runtime.bus.store.getGraph();
    const mutedNode = document.nodes[missing as never]!;
    const graph = { ...document, nodes: { ...document.nodes, [missing]: { ...mutedNode, ui: { ...mutedNode.ui, muted: true } } } };
    const view = mountDesk(h, runtime, { door: OPEN("p1", "p2"), graph });
    await waitFor(() => expect(h.videos).toHaveLength(2));
    await h.fromPhone("p1", OFFER("Back"));
    await h.fromPhone("p2", OFFER("Front"));
    act(() => h.peers[0]!.ontrack?.({ streams: [stream("back")] }));
    act(() => h.peers[1]!.ontrack?.({ streams: [stream("front")] }));
    for (const video of h.videos) act(() => video.frame(640, 480));
    for (const peer of h.peers) act(() => peer.state("connected"));
    expect(h.drawn(front)).toBe("front");
    expect(h.drawn(back)).toBe("back");
    expect(h.sources.has(`media:${missing}`)).toBe(false);
    expect(view.result.current.phones.diagnostics).toEqual([]);
  });
});
