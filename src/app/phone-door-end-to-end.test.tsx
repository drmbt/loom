// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createDeviceClient, type DeviceClient } from "@devices/device-client.ts";
import { createDeviceDoors } from "@devices/doors.ts";
import {
  PHONE_EVENTS_PATH,
  PHONE_PEER_PARAM,
  PHONE_SET_PATH,
  phoneActorId,
  type PhoneEvent,
  type PhoneSet,
  type PhoneSnapshot,
} from "@devices/phone/phone-protocol.ts";
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
