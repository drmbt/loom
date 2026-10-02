// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useMemo, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createDeviceClient, type DeviceClient } from "@devices/device-client.ts";
import { createDeviceDoors } from "@devices/doors.ts";
import {
  PHONE_EVENTS_PATH,
  PHONE_PEER_PARAM,
  PHONE_SET_PATH,
  PHONE_SIGNAL_PATH,
  phoneActorId,
  type PhoneEvent,
  type PhoneSet,
  type PhoneSignalFromPhone,
  type PhoneSnapshot,
  type PhoneWidget,
} from "@devices/phone/phone-protocol.ts";
import { serializeCueList, serializePresetBank } from "@domain/presets/index.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { PhonePeerConnection } from "./phone-camera-receiver.ts";
import { usePhoneCameras, type PhoneCameraEnvironment } from "./use-phone-cameras.ts";
import { useMediaSources, type MediaEnvironment } from "./use-media-sources.ts";
import { ControlsPane } from "@editor/controls/controls-pane.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createBridgeHost } from "../mcp/bridge-host.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import { phoneDoorNotices, usePhoneDoor } from "./use-phone-door.ts";
import { NoticeStrip } from "./notices.tsx";

/**
 * T1396b — THE PHONE DOOR, END TO END, THE ROW'S ACCEPTANCE.
 *
 * Every party is the product's own, and every wire between them is a real socket:
 *
 *   phone (node https, pinning the door's certificate)
 *     ──HTTPS──▶ the helper's phone door (`createDeviceDoors` + `createBridgeHost`, as
 *                `createDeviceHelper` composes them; a real openssl certificate)
 *     ──loopback WebSocket──▶ the desk's `createDeviceClient`
 *     ──▶ `usePhoneDoor` (the desk's hook, opened by pressing Phone in the controls pane)
 *     ──▶ `createPhoneWrites` ──▶ the real bus of a real `createAppRuntime`.
 *
 * The only injection is the door's address (loopback: a test box has no LAN) and its
 * certificate directory (a temp dir, not the developer's home). What is asserted is what
 * each end reads back: the phone reads a `hello`, a snapshot with the published slider and
 * nothing else, and an echo of its own write; the desk's document holds the value, and its
 * audit names the phone. A Panel NOT marked remote is invisible to the phone and a write
 * aimed at its slider changes nothing — the owner's "stuff that we selectively publish".
 */
installDomStubs();

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanup();
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function until(predicate: () => boolean, what: string, budgetMs = 8_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Waits for something the desk or the phone will show, letting React commit in between:
 * each poll is its own `act`, so a state update from a socket is rendered before the next
 * look (waiting INSIDE one `act` would hold every update back until the wait gave up).
 */
async function rendered(predicate: () => boolean, what: string, budgetMs = 8_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
  }
}

const storedValue = (runtime: AppRuntime, id: string): unknown =>
  runtime.bus.store.getGraph().nodes[id as never]?.parameters["value"];

const soon = (callback: () => void): (() => void) => {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
};

/**
 * The desk as `app.tsx` builds it. `deviceClient` is passed in STABLE, as `use-osc-bridge`
 * hands it over (a `useCallback`): the hook closes the door when it changes.
 */
function Desk({ runtime, deviceClient }: { runtime: AppRuntime; deviceClient: () => DeviceClient }) {
  // The e2e pairs before the desk mounts, so the helper is attached from the first render.
  const door = usePhoneDoor({ deviceClient, attached: true, bus: runtime.bus, invocation: runtime.invocation, schedule: soon });
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return (
    <>
      <NoticeStrip notices={phoneDoorNotices(door)} />
      <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} phone={door} />
    </>
  );
}

/** One Panel published to phones, one not; a slider on each. */
async function stagedRuntime(): Promise<AppRuntime> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "desk", label: "Desk" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "stage",
      operations: [
        { op: "addNode", ref: "$heat", type: "slider", position: { x: 0, y: 0 }, label: "fader1", parameters: { channel: "heat", value: 0.25 } },
        { op: "addNode", ref: "$shown", type: "panel", position: { x: 0, y: 200 }, label: "panel1", parameters: { title: "Furnace", layout: "fader1", remote: true } },
        { op: "addNode", ref: "$secret", type: "slider", position: { x: 400, y: 0 }, label: "fader2", parameters: { channel: "secret", value: 0.5 } },
        { op: "addNode", ref: "$hidden", type: "panel", position: { x: 400, y: 200 }, label: "panel2", parameters: { title: "Backstage", layout: "fader2", remote: false } },
      ],
    } as never,
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return runtime;
}

const nodeId = (runtime: AppRuntime, label: string): string => {
  const node = Object.values(runtime.bus.store.getGraph().nodes).find((each) => each.label === label);
  if (node === undefined) throw new Error(`no node ${label}`);
  return node.id;
};

/**
 * Node's own `Event`, which jsdom's global replaced. Read off a Node `MessageChannel`
 * message (jsdom has none of its own), whose `MessageEvent` extends it.
 */
function nodeEventClass(): Promise<typeof Event> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (message) => {
      resolve(Object.getPrototypeOf(Object.getPrototypeOf(message)).constructor as typeof Event);
      port1.close();
    };
    port2.postMessage(0);
  });
}

interface PhoneStream {
  readonly events: PhoneEvent[];
  close(): void;
}

/** A phone's event stream: what `EventSource` would parse, one JSON event per `data:` line. */
function openPhoneStream(url: string, ca: string): PhoneStream {
  const stream: PhoneStream = { events: [], close: () => req.destroy() };
  const req = httpsRequest(url, { ca, agent: false, headers: { "User-Agent": "E2E Phone" } }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        for (const line of buffer.slice(0, cut).split("\n")) {
          if (line.startsWith("data: ")) stream.events.push(JSON.parse(line.slice(6)) as PhoneEvent);
        }
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
      }
    });
  });
  req.on("error", () => undefined);
  req.end();
  cleanups.push(() => req.destroy());
  return stream;
}

function postPhoneSet(url: string, ca: string, set: PhoneSet): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", ca, agent: false, headers: { "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(JSON.stringify(set));
  });
}

const snapshots = (stream: PhoneStream): PhoneSnapshot[] =>
  stream.events.flatMap((event) => (event.type === "snapshot" ? [event.snapshot] : []));

const sliderValue = (snapshot: PhoneSnapshot | undefined, handle: string): number | undefined => {
  for (const panel of snapshot?.panels ?? []) {
    for (const row of panel.rows) {
      if (row.kind !== "widgets") continue;
      for (const widget of row.widgets) if (widget.handle === handle && widget.kind === "slider") return widget.value;
    }
  }
  return undefined;
};

describe("T1396b — a phone drives a published slider through the whole stack", () => {
  it("hello, the published Panel only, a live+commit write stored as the phone, echoed back — and the unpublished Panel unreachable", async () => {
    /*
     * The helper, with its phone door: the doors and the bridge host exactly as
     * `createDeviceHelper` (`pnpm helper --devices-only --phone`) composes them. Built here
     * from those two parts rather than through `serve.ts`, because `serve.ts` also loads the
     * example catalogue, which resolves a file: URL that jsdom cannot give it — and this
     * test must run under jsdom to mount the desk's hook and pane.
     */
    const certDir = mkdtempSync(join(tmpdir(), "loom-phone-e2e-cert-"));
    const handoffDir = mkdtempSync(join(tmpdir(), "loom-phone-e2e-"));
    const doors = createDeviceDoors({
      udpSocketFactory: () => {
        throw new Error("no UDP in this test");
      },
      phone: { enabled: true, lanAddress: () => "127.0.0.1", port: 0, certDir },
    });
    const helper = createBridgeHost({
      devices: doors.devices,
      laser: doors.laser,
      vision: doors.vision,
      ...(doors.phone ? { phone: doors.phone } : {}),
      port: 0,
      handoffDir,
    });
    cleanups.push(() => {
      helper.dispose();
      doors.dispose();
      rmSync(handoffDir, { recursive: true, force: true });
      rmSync(certDir, { recursive: true, force: true });
    });
    await until(() => helper.status().port != null, "the helper to bind");

    /*
     * The desk: the product's device client over the loopback socket, paired by code, with
     * its DEFAULT socket (`browserSocket` over the global `WebSocket`). Under vitest's jsdom
     * that global is Node's own (undici), which builds its events with the GLOBAL `Event`
     * — jsdom's here — and then refuses to dispatch them. So Node's `Event` is put back for
     * this test; the adapter, the socket and the client are all the product's.
     */
    const jsdomEvent = globalThis.Event;
    globalThis.Event = await nodeEventClass();
    cleanups.push(() => {
      globalThis.Event = jsdomEvent;
    });
    const client = createDeviceClient({
      port: helper.status().port ?? 0,
      client: "e2e desk",
      memory: { read: () => null, write: () => undefined, forget: () => undefined },
      autoConnect: false,
      onState: () => undefined,
      onReadings: () => undefined,
    });
    cleanups.push(() => client.dispose());
    client.connect(helper.pairingCode);

    const runtime = await stagedRuntime();
    const heat = nodeId(runtime, "fader1");
    const secret = nodeId(runtime, "fader2");
    const deviceClient = (): DeviceClient => client;
    render(<Desk runtime={runtime} deviceClient={deviceClient} />);

    // Press Phone in the controls pane: the door opens and the desk shows its URL (the QR).
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Phone/ })[0]!);
    });
    await rendered(() => document.querySelector("[data-phone-url]") !== null, "the desk to show the door's URL");
    const doorUrl = document.querySelector("[data-phone-url]")?.textContent ?? "";
    expect(doorUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{22}$/);
    const ca = readFileSync(join(certDir, "cert.pem"), "utf8");
    const at = (path: string, phone?: string): string => {
      const url = new URL(doorUrl);
      url.pathname = path;
      if (phone !== undefined) url.searchParams.set(PHONE_PEER_PARAM, phone);
      return url.toString();
    };

    // THE PHONE: hello first, then a picture holding the published slider and nothing else.
    const phone = openPhoneStream(at(PHONE_EVENTS_PATH), ca);
    await rendered(() => snapshots(phone).length >= 1, "the phone's first snapshot");
    const hello = phone.events[0];
    expect(hello?.type).toBe("hello");
    const phoneId = hello?.type === "hello" ? hello.phone : "";
    const first = snapshots(phone).at(-1);
    expect(first?.panels.map((panel) => panel.title)).toEqual(["Furnace"]);
    expect(sliderValue(first, heat)).toBe(0.25);
    expect(JSON.stringify(snapshots(phone))).not.toContain(secret);
    expect(JSON.stringify(snapshots(phone))).not.toContain("Backstage");

    // A finger drags and lifts: one live, one commit, both naming this phone.
    const auditBefore = runtime.bus.store.getAudit().length;
    expect(await postPhoneSet(at(PHONE_SET_PATH, phoneId), ca, { handle: heat, values: { value: 0.5 }, phase: "live" })).toBe(204);
    expect(await postPhoneSet(at(PHONE_SET_PATH, phoneId), ca, { handle: heat, values: { value: 0.8 }, phase: "commit" })).toBe(204);
    await rendered(() => storedValue(runtime, heat) === 0.8, "the stored value to move");
    // The document holds it, and the audit says a phone — THIS phone — did it.
    const entries = runtime.bus.store.getAudit().slice(auditBefore);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.map((entry) => [entry.actor.kind, entry.actor.id, entry.status])).toEqual(
      entries.map(() => ["human", phoneActorId(phoneId), "applied"]),
    );
    // The desk's own slider shows it…
    await rendered(
      () => screen.getByRole("slider", { name: "heat" }).getAttribute("aria-valuenow") === "0.8",
      "the desk's slider to show it",
    );
    // …and the phone is told, with a newer picture.
    await rendered(() => sliderValue(snapshots(phone).at(-1), heat) === 0.8, "the echoed snapshot");
    expect(snapshots(phone).at(-1)!.seq).toBeGreaterThan(first!.seq);

    // The unpublished Panel's slider: the helper relays (it cannot know), the desk refuses,
    // nothing is stored, nothing is audited, and the refusal is said on the desk.
    const auditAfterWrite = runtime.bus.store.getAudit().length;
    expect(await postPhoneSet(at(PHONE_SET_PATH, phoneId), ca, { handle: secret, values: { value: 0.9 }, phase: "commit" })).toBe(204);
    await rendered(() => document.querySelector("[data-phone-refusal]") !== null, "the desk to say it refused");
    expect(storedValue(runtime, secret)).toBe(0.5);
    expect(runtime.bus.store.getAudit().length).toBe(auditAfterWrite);
    expect(JSON.stringify(snapshots(phone))).not.toContain(secret);
  });
});

/*
 * T1397b — A PHONE'S CAMERA HANDSHAKE, THROUGH THE WHOLE STACK. The same parties and real
 * sockets as above, plus the desk's `usePhoneCameras` and `useMediaSources` composed as
 * `app.tsx` composes them, with a Webcam whose device is `phone:back cam`: the phone (node
 * https) posts an offer to the door, the helper relays it over the loopback device socket,
 * the desk asks the phone for the Webcam's facing and answers, and both come back down the
 * phone's own event stream. WebRTC cannot run under node/jsdom, so the fakes are the
 * desk's `RTCPeerConnection` and `<video>` (the phone hook's environment seam) and a media
 * environment with no local camera — every wire is real.
 */
class DeskPeer implements PhonePeerConnection {
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  onicecandidate: PhonePeerConnection["onicecandidate"] = null;
  ontrack: PhonePeerConnection["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;
  remote: { type: string; sdp: string } | null = null;
  readonly ice: unknown[] = [];
  closed = false;
  setRemoteDescription(description: { type: "offer"; sdp: string }): Promise<void> {
    this.remote = description;
    return Promise.resolve();
  }
  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: "answer", sdp: "v=0 desk answer" });
  }
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = { sdp: description.sdp ?? "" };
    return Promise.resolve();
  }
  addIceCandidate(candidate: unknown): Promise<void> {
    this.ice.push(candidate);
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
  }
}

function CameraDesk({ runtime, deviceClient, environment }: {
  runtime: AppRuntime;
  deviceClient: () => DeviceClient;
  environment: PhoneCameraEnvironment;
}) {
  const door = usePhoneDoor({ deviceClient, attached: true, bus: runtime.bus, invocation: runtime.invocation, schedule: soon });
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  // As `app.tsx` composes them: the phone hook's opener is how the media hook opens a phone.
  const cameras = usePhoneCameras({ deviceClient, door: door.state, environment });
  useMediaSources(runtime, environmentBackend, graph, null, noLocalMedia, undefined, cameras.opener);
  const view = useMemo(() => ({ ...door, cameras: cameras.feeds }), [door, cameras.feeds]);
  return <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} phone={view} />;
}

/** The desk has no local camera or file here: a phone is the only thing that may open. */
const noLocalMedia: MediaEnvironment = {
  openFile: () => Promise.reject(new Error("no files in this test")),
  openStill: () => Promise.reject(new Error("no stills in this test")),
  openCamera: () => Promise.reject(new Error("getUserMedia must not be reached for a phone device")),
};

/** What the renderer would find under each source id. */
const registered = new Map<string, unknown>();
const environmentBackend = {
  registerMediaSource(id: string, source: unknown) {
    registered.set(id, source);
    return () => {
      if (registered.get(id) === source) registered.delete(id);
    };
  },
} as unknown as LoomBackend;

function postPhoneSignal(url: string, ca: string, signal: PhoneSignalFromPhone): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", ca, agent: false, headers: { "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(JSON.stringify(signal));
  });
}

describe("T1397b — a phone's camera handshake crosses the whole stack to a Webcam on that phone", () => {
  it("offer up through the helper, the desk's request and answer down the phone's own stream, the track on the webcam's source, the popover saying who sends — and bye lets go", async () => {
    registered.clear();
    const certDir = mkdtempSync(join(tmpdir(), "loom-phone-cam-cert-"));
    const handoffDir = mkdtempSync(join(tmpdir(), "loom-phone-cam-"));
    const doors = createDeviceDoors({
      udpSocketFactory: () => {
        throw new Error("no UDP in this test");
      },
      phone: { enabled: true, lanAddress: () => "127.0.0.1", port: 0, certDir },
    });
    const helper = createBridgeHost({
      devices: doors.devices,
      laser: doors.laser,
      vision: doors.vision,
      ...(doors.phone ? { phone: doors.phone } : {}),
      port: 0,
      handoffDir,
    });
    cleanups.push(() => {
      helper.dispose();
      doors.dispose();
      rmSync(handoffDir, { recursive: true, force: true });
      rmSync(certDir, { recursive: true, force: true });
    });
    await until(() => helper.status().port != null, "the helper to bind");
    const jsdomEvent = globalThis.Event;
    globalThis.Event = await nodeEventClass();
    cleanups.push(() => {
      globalThis.Event = jsdomEvent;
    });
    const client = createDeviceClient({
      port: helper.status().port ?? 0,
      client: "e2e camera desk",
      memory: { read: () => null, write: () => undefined, forget: () => undefined },
      autoConnect: false,
      onState: () => undefined,
      onReadings: () => undefined,
    });
    cleanups.push(() => client.dispose());
    client.connect(helper.pairingCode);

    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "desk", label: "Desk" } });
    const added = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "camera",
        operations: [
          {
            op: "addNode",
            ref: "$cam",
            type: "webcam",
            position: { x: 0, y: 0 },
            label: "cam1",
            parameters: { device: "phone:back cam", facing: "user" },
          },
        ],
      } as never,
      runtime.invocation,
    );
    expect(added.output.status).toBe("applied");
    const cam = nodeId(runtime, "cam1");
    const peers: DeskPeer[] = [];
    /** What the node's element has been told to show, in order. */
    const shown: Array<MediaStream | null> = [];
    const environment: PhoneCameraEnvironment = {
      createPeer: () => {
        const peer = new DeskPeer();
        peers.push(peer);
        return peer;
      },
      createVideo: () => ({
        element: { videoWidth: 0, videoHeight: 0, addEventListener: () => undefined, removeEventListener: () => undefined },
        show: (stream) => void shown.push(stream),
        stop: () => undefined,
      }),
    };
    const deviceClient = (): DeviceClient => client;
    render(<CameraDesk runtime={runtime} deviceClient={deviceClient} environment={environment} />);
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Phone/ })[0]!);
    });
    await rendered(() => document.querySelector("[data-phone-url]") !== null, "the door's URL");
    const doorUrl = document.querySelector("[data-phone-url]")?.textContent ?? "";
    const ca = readFileSync(join(certDir, "cert.pem"), "utf8");
    const at = (path: string, phone?: string): string => {
      const url = new URL(doorUrl);
      url.pathname = path;
      if (phone !== undefined) url.searchParams.set(PHONE_PEER_PARAM, phone);
      return url.toString();
    };

    const phone = openPhoneStream(at(PHONE_EVENTS_PATH), ca);
    await rendered(() => phone.events[0]?.type === "hello", "the phone's hello");
    const hello = phone.events[0];
    const phoneId = hello?.type === "hello" ? hello.phone : "";
    // The desk hears the phone arrive before the phone can offer (one ordered socket).
    await rendered(() => document.body.textContent?.includes("1 connected") === true, "the phone listed");

    // UP: the offer, through the door and the loopback socket, to the desk's peer.
    const offer: PhoneSignalFromPhone = { kind: "offer", sdp: "v=0 phone offer", name: "Back Cam" };
    expect(await postPhoneSignal(at(PHONE_SIGNAL_PATH, phoneId), ca, offer)).toBe(204);
    await rendered(() => peers[0]?.remote !== null && peers[0] !== undefined, "the desk to take the offer");
    expect(peers[0]?.remote).toEqual({ type: "offer", sdp: "v=0 phone offer" });
    // DOWN: the Webcam's facing asked of the phone, and the desk's answer — on this phone's
    // own event stream.
    const signals = () => phone.events.flatMap((event) => (event.type === "signal" ? [event.message] : []));
    await rendered(() => signals().length === 2, "the request and the answer on the phone");
    expect(signals()).toEqual([
      { kind: "request", facing: "user", width: 0, height: 0, frameRate: 0, exact: false },
      { kind: "answer", sdp: "v=0 desk answer" },
    ]);
    // The desk's candidates go down the same way; the phone's come up.
    act(() => peers[0]?.onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 1 abc.local 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 } }));
    const phoneIce = { kind: "ice", candidate: "candidate:2 1 udp 1 127.0.0.1 5001 typ host", sdpMid: "0", sdpMLineIndex: 0 } as const;
    expect(await postPhoneSignal(at(PHONE_SIGNAL_PATH, phoneId), ca, phoneIce)).toBe(204);
    await rendered(() => peers[0]?.ice.length === 1, "the phone's candidate on the desk's peer");
    await rendered(() => signals().length === 3, "the desk's candidate on the phone");

    // The track arrives: the Webcam on "phone:back cam" shows the phone named "Back Cam",
    // through the source the media hook registered for it.
    expect(registered.has(`media:${cam}`)).toBe(true);
    const track = { id: "phone-stream" } as unknown as MediaStream;
    act(() => peers[0]?.ontrack?.({ streams: [track] }));
    expect(shown).toEqual([track]);
    act(() => {
      peers[0]!.connectionState = "connected";
      peers[0]!.onconnectionstatechange?.();
    });
    await rendered(() => document.querySelector('[data-phone-camera="live"]') !== null, "the popover to say it sends");
    expect(document.querySelector('[data-phone-camera="live"]')?.textContent).toContain("sending camera “Back Cam”");

    // The phone stops: its bye crosses the same way and the desk lets go.
    expect(await postPhoneSignal(at(PHONE_SIGNAL_PATH, phoneId), ca, { kind: "bye" })).toBe(204);
    await rendered(() => peers[0]?.closed === true, "the desk's peer to close");
    // The element lets go of the stream; the source stays, so the texture keeps its last frame.
    await rendered(() => shown.at(-1) === null, "the node's element to let the stream go");
    expect(registered.has(`media:${cam}`)).toBe(true);
  });
});

/*
 * T1503b (§T1398b ruling 12) — A PHONE RUNS THE SET, THROUGH THE WHOLE STACK. The same
 * parties and real sockets as the first test: a phone over HTTPS recalls a preset and
 * presses GO on a bank and a cue list named on a published Panel. What each end reads
 * back: the document holds the look and the list's position, the audit names the command
 * and THIS phone, the two presses are the phone's own two undo steps, and the phone's next
 * picture carries the new `current` — the only way it learns its press took. A bank on a
 * Panel that is not published is unreachable, and a `store` key changes nothing.
 */
describe("T1503b — a phone recalls a preset and presses GO through the whole stack", () => {
  const LOOKS = serializePresetBank({
    version: 1,
    presets: [
      { name: "soft", values: { blur1: { size: 4 } } },
      { name: "hard", values: { blur1: { size: 20 } } },
    ],
  });
  const CUES = serializeCueList({
    version: 1,
    cues: [
      { name: "1", bank: "looks", preset: "soft" },
      { name: "2", bank: "looks", preset: "hard" },
    ],
  });
  const boardOf = (...members: string[]): string =>
    serializePanelBoard({ columns: 8, items: members.map((member, index) => ({ member, rect: { x: 0, y: index * 2, w: 4, h: 2 } })) });

  const parameter = (runtime: AppRuntime, id: string, key: string): unknown => runtime.bus.store.getGraph().nodes[id as never]?.parameters[key];
  /** A board widget in a snapshot, by handle and kind. */
  const onBoard = <K extends PhoneWidget["kind"]>(snapshot: PhoneSnapshot | undefined, handle: string, kind: K): Extract<PhoneWidget, { kind: K }> | undefined => {
    for (const panel of snapshot?.panels ?? []) {
      for (const item of panel.board?.items ?? []) {
        if (item.kind === "widget" && item.widget.handle === handle && item.widget.kind === kind) return item.widget as Extract<PhoneWidget, { kind: K }>;
      }
    }
    return undefined;
  };

  it("recall and GO change the document as the phone, land on the phone's undo stack, and the echo carries the new current", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "loom-phone-set-cert-"));
    const handoffDir = mkdtempSync(join(tmpdir(), "loom-phone-set-"));
    const doors = createDeviceDoors({
      udpSocketFactory: () => {
        throw new Error("no UDP in this test");
      },
      phone: { enabled: true, lanAddress: () => "127.0.0.1", port: 0, certDir },
    });
    const helper = createBridgeHost({
      devices: doors.devices,
      laser: doors.laser,
      vision: doors.vision,
      ...(doors.phone ? { phone: doors.phone } : {}),
      port: 0,
      handoffDir,
    });
    cleanups.push(() => {
      helper.dispose();
      doors.dispose();
      rmSync(handoffDir, { recursive: true, force: true });
      rmSync(certDir, { recursive: true, force: true });
    });
    await until(() => helper.status().port != null, "the helper to bind");
    const jsdomEvent = globalThis.Event;
    globalThis.Event = await nodeEventClass();
    cleanups.push(() => {
      globalThis.Event = jsdomEvent;
    });
    const client = createDeviceClient({
      port: helper.status().port ?? 0,
      client: "e2e set desk",
      memory: { read: () => null, write: () => undefined, forget: () => undefined },
      autoConnect: false,
      onState: () => undefined,
      onReadings: () => undefined,
    });
    cleanups.push(() => client.dispose());
    client.connect(helper.pairingCode);

    // blur1 at 9; `looks` and `set` on the published Panel's board; `backstage` on one that is not.
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "desk", label: "Desk" } });
    const staged = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "set",
        operations: [
          { op: "addNode", ref: "$blur", type: "blur", position: { x: 0, y: 0 }, label: "blur1", parameters: { size: 9 } },
          { op: "addNode", ref: "$looks", type: "presets", position: { x: 0, y: 100 }, label: "looks", parameters: { targets: "blur1", presets: LOOKS } },
          { op: "addNode", ref: "$set", type: "cueList", position: { x: 0, y: 200 }, label: "set", parameters: { cues: CUES } },
          { op: "addNode", ref: "$shown", type: "panel", position: { x: 0, y: 300 }, label: "panel1", parameters: { title: "Show", remote: true, board: boardOf("looks", "set") } },
          { op: "addNode", ref: "$backstage", type: "presets", position: { x: 400, y: 100 }, label: "backstage", parameters: { targets: "blur1", presets: LOOKS } },
          { op: "addNode", ref: "$hidden", type: "panel", position: { x: 400, y: 300 }, label: "panel2", parameters: { title: "Backstage", remote: false, board: boardOf("backstage") } },
        ],
      } as never,
      runtime.invocation,
    );
    expect(staged.output.status).toBe("applied");
    const blur = nodeId(runtime, "blur1");
    const looks = nodeId(runtime, "looks");
    const list = nodeId(runtime, "set");
    const backstage = nodeId(runtime, "backstage");
    const deviceClient = (): DeviceClient => client;
    render(<Desk runtime={runtime} deviceClient={deviceClient} />);

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Phone/ })[0]!);
    });
    await rendered(() => document.querySelector("[data-phone-url]") !== null, "the desk to show the door's URL");
    const doorUrl = document.querySelector("[data-phone-url]")?.textContent ?? "";
    const ca = readFileSync(join(certDir, "cert.pem"), "utf8");
    const at = (path: string, phone?: string): string => {
      const url = new URL(doorUrl);
      url.pathname = path;
      if (phone !== undefined) url.searchParams.set(PHONE_PEER_PARAM, phone);
      return url.toString();
    };

    // THE PHONE: the published board holds the bank and the list; the backstage bank is nowhere.
    const phone = openPhoneStream(at(PHONE_EVENTS_PATH), ca);
    await rendered(() => snapshots(phone).length >= 1, "the phone's first snapshot");
    const hello = phone.events[0];
    const phoneId = hello?.type === "hello" ? hello.phone : "";
    expect(phoneId).not.toBe("");
    const first = snapshots(phone).at(-1);
    expect(first?.panels.map((panel) => panel.title)).toEqual(["Show"]);
    expect(onBoard(first, looks, "preset")).toEqual({ kind: "preset", handle: looks, caption: "looks", presets: ["soft", "hard"], current: null, morphing: false });
    expect(onBoard(first, list, "cueList")).toMatchObject({ cues: ["1", "2"], current: null, next: "1", canGo: true, canBack: false });
    expect(JSON.stringify(snapshots(phone))).not.toContain(backstage);

    const phoneActor = { kind: "human", id: phoneActorId(phoneId), label: "Phone" } as const;
    const deskUndo = runtime.bus.store.getHistory(runtime.invocation.actor).undo.length;
    const auditBefore = runtime.bus.store.getAudit().length;

    // A tap on "hard": one commit carrying the preset's NAME.
    expect(await postPhoneSet(at(PHONE_SET_PATH, phoneId), ca, { handle: looks, values: { recall: "hard" }, phase: "commit" })).toBe(204);
    await rendered(() => parameter(runtime, blur, "size") === 20, "the recall to land in the document");
    expect(parameter(runtime, looks, "current")).toBe("hard");
    // …and the phone learns it took from its next picture.
    await rendered(() => onBoard(snapshots(phone).at(-1), looks, "preset")?.current === "hard", "the echo to carry the new current preset");

    // GO: the list's first cue fires — its preset recalled, the list moved on.
    expect(await postPhoneSet(at(PHONE_SET_PATH, phoneId), ca, { handle: list, values: { go: true }, phase: "commit" })).toBe(204);
    await rendered(() => parameter(runtime, list, "current") === "1", "GO to land in the document");
    expect(parameter(runtime, blur, "size")).toBe(4);
    expect(parameter(runtime, looks, "current")).toBe("soft");
    await rendered(() => onBoard(snapshots(phone).at(-1), list, "cueList")?.current === "1", "the echo to carry the new current cue");
    const echoed = snapshots(phone).at(-1);
    expect(onBoard(echoed, list, "cueList")).toMatchObject({ current: "1", next: "2", canGo: true, canBack: false });
    expect(onBoard(echoed, looks, "preset")?.current).toBe("soft");
    expect(echoed!.seq).toBeGreaterThan(first!.seq);

    // The audit names the command and THIS phone; the two presses are the phone's two undo steps.
    expect(runtime.bus.store.getAudit().slice(auditBefore).map((entry) => [entry.command, entry.actor.kind, entry.actor.id, entry.status])).toEqual([
      ["preset.recall", "human", phoneActorId(phoneId), "applied"],
      ["cue.go", "human", phoneActorId(phoneId), "applied"],
    ]);
    expect(runtime.bus.store.getHistory(phoneActor).undo).toHaveLength(2);
    expect(runtime.bus.store.getHistory(runtime.invocation.actor).undo).toHaveLength(deskUndo);

    // The bank on the unpublished Panel, and a `store` on the published one: relayed by the
    // helper (it cannot know), refused by the desk, nothing stored, nothing audited.
    const auditAfter = runtime.bus.store.getAudit().length;
    expect(await postPhoneSet(at(PHONE_SET_PATH, phoneId), ca, { handle: backstage, values: { recall: "hard" }, phase: "commit" })).toBe(204);
    await rendered(() => document.querySelector("[data-phone-refusal]") !== null, "the desk to say it refused");
    expect(document.querySelector("[data-phone-refusal]")?.textContent).toContain("not published to the phone door");
    expect(await postPhoneSet(at(PHONE_SET_PATH, phoneId), ca, { handle: looks, values: { store: "mine" }, phase: "commit" })).toBe(204);
    await rendered(
      () => document.querySelector("[data-phone-refusal]")?.textContent?.includes("does not let a phone write") === true,
      "the desk to say it refused the store",
    );
    expect(parameter(runtime, blur, "size")).toBe(4);
    expect(parameter(runtime, backstage, "current") ?? "").toBe("");
    expect(parameter(runtime, looks, "presets")).toBe(LOOKS);
    expect(runtime.bus.store.getAudit().length).toBe(auditAfter);
  });
});
