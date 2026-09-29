import { describe, expect, it } from "vitest";
import { createDeviceClient } from "../device-client.ts";
import type { BridgeSocket, PairingMemory } from "../transport/bridge-socket.ts";
import type { PhoneDoorState, PhoneSet } from "./phone-protocol.ts";

/**
 * T1396b — the device client's phone half, faked at the socket so the claims are about
 * what goes on the wire and what the page is told: an open is ONE id'd request answered by
 * ONE `phoneOpened`; an open asked while the attachment is still being made waits for it
 * rather than being lost; the pushes reach their listeners; and a socket that goes away
 * CLOSES the door for the page — both the owed answer and the listeners — because the
 * helper closes the LAN listener then too.
 */

interface FakeSocket extends BridgeSocket {
  readonly sent: Record<string, unknown>[];
  hear(message: Record<string, unknown>): void;
  drop(): void;
}

function harness(code: string | null) {
  const opened: FakeSocket[] = [];
  const memory: PairingMemory = { read: () => code, write: () => undefined, forget: () => undefined };
  const client = createDeviceClient({
    memory,
    onState: () => undefined,
    onReadings: () => undefined,
    socketFactory: () => {
      const socket: FakeSocket = {
        sent: [],
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data) => socket.sent.push(JSON.parse(data) as Record<string, unknown>),
        close: () => undefined,
        hear: (message) => socket.onmessage?.({ data: JSON.stringify(message) }),
        drop: () => socket.onclose?.(),
      };
      opened.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
  });
  return { client, socket: () => opened[0]! };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const OPEN: PhoneDoorState = { open: true, url: "https://10.0.0.2:47811/?t=x", fingerprint: "AA:BB", phones: [] };

describe("T1396b — the device client's phone door", () => {
  it("an open asked mid-attach waits for the attachment, then is answered by its own id", async () => {
    const { client, socket } = harness("ABCD-EFGH");
    const answered = client.phoneOpen();
    await tick();
    expect(socket().sent.map((message) => message["type"])).toEqual(["deviceAttach"]);
    socket().hear({ type: "deviceAttached" });
    const request = socket().sent.find((message) => message["type"] === "phoneOpen")!;
    expect(typeof request["id"]).toBe("number");
    socket().hear({ type: "phoneOpened", id: request["id"], state: OPEN });
    expect(await answered).toEqual(OPEN);
  });

  it("with no helper at all, the answer is a closed door that says how to start one", async () => {
    const { client } = harness(null);
    const state = await client.phoneOpen();
    expect(state.open).toBe(false);
    expect(state.open ? "" : state.reason).toMatch(/^No device bridge is attached, so there is no phone door — start /);
  });

  it("pushes reach their listeners; publish goes out only while attached", async () => {
    const { client, socket } = harness("ABCD-EFGH");
    const writes: Array<[string, PhoneSet]> = [];
    const states: PhoneDoorState[] = [];
    client.onPhoneWrite((phone, set) => writes.push([phone, set]));
    client.onPhoneState((state) => states.push(state));
    client.phonePublish({ seq: 1, panels: [] });
    await tick();
    socket().hear({ type: "deviceAttached" });
    client.phonePublish({ seq: 2, panels: [] });
    expect(socket().sent.filter((message) => message["type"] === "phonePublish")).toEqual([{ type: "phonePublish", snapshot: { seq: 2, panels: [] } }]);
    const set: PhoneSet = { handle: "nd_1", values: { value: 0.5 }, phase: "live" };
    socket().hear({ type: "phoneWrite", stream: "phone", phone: "p1", set });
    socket().hear({ type: "phoneWrite", stream: "phone", phone: "p1", set: { values: {} } }); // no handle: not a set
    socket().hear({ type: "phoneState", stream: "phone", state: { ...OPEN, phones: [{ phone: "p1", userAgent: "iPhone" }] } });
    expect(writes).toEqual([["p1", set]]);
    expect(states).toEqual([{ ...OPEN, phones: [{ phone: "p1", userAgent: "iPhone" }] }]);
  });

  it("T1511b: a firewall block the helper measured reaches the page; a malformed one is dropped, never guessed", async () => {
    const { client, socket } = harness("ABCD-EFGH");
    const states: PhoneDoorState[] = [];
    client.onPhoneState((state) => states.push(state));
    await tick();
    socket().hear({ type: "deviceAttached" });
    const binary = "/Users/me/.nvm/versions/node/v24.11.1/bin/node";
    socket().hear({ type: "phoneState", stream: "phone", state: { ...OPEN, firewall: { blocked: true, binary } } });
    socket().hear({ type: "phoneState", stream: "phone", state: { ...OPEN, firewall: { blocked: false, binary } } });
    socket().hear({ type: "phoneState", stream: "phone", state: { ...OPEN, firewall: { blocked: true } } });
    expect(states).toEqual([{ ...OPEN, firewall: { blocked: true, binary } }, OPEN, OPEN]);
  });

  it("a socket that goes away closes the door: the owed answer and the listeners both hear it", async () => {
    const { client, socket } = harness("ABCD-EFGH");
    const states: PhoneDoorState[] = [];
    client.onPhoneState((state) => states.push(state));
    await tick();
    socket().hear({ type: "deviceAttached" });
    const answered = client.phoneOpen();
    socket().drop();
    expect(await answered).toEqual({ open: false, reason: "The device bridge closed the connection, and the phone door with it." });
    expect(states.at(-1)).toEqual({ open: false, reason: "The device bridge closed the connection, and the phone door with it." });
  });
});
