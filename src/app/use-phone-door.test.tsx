// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceClient } from "@devices/device-client.ts";
import { PHONE_DOOR_UNAVAILABLE } from "@devices/helper.ts";
import type { PhoneDoorState, PhoneSet, PhoneSnapshot } from "@devices/phone/phone-protocol.ts";
import { ControlsPane } from "@editor/controls/controls-pane.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import { NoticeStrip } from "./notices.tsx";
import { phoneDoorNotices, usePhoneDoor } from "./use-phone-door.ts";

/**
 * T1396b — THE PHONE DOOR FROM THE DESK: press Phone in the controls pane, the door opens
 * and shows the QR code for the address the helper gave; the published Panel goes to the
 * phones; a phone moving the slider moves the slider THE DESK SEES; and a write the page
 * refuses is said, in the popover and in the notice strip.
 *
 * The helper is a fake device client — the page half is what is under test, and the
 * wire it speaks is the shared contract (`phone-protocol.ts`).
 */
installDomStubs();
afterEach(cleanup);

const URL_WITH_TOKEN = "https://192.168.1.20:47811/?t=abc123";

function fakeClient(opened: PhoneDoorState) {
  const writes = new Set<(phone: string, set: PhoneSet) => void>();
  const states = new Set<(state: PhoneDoorState) => void>();
  const published: PhoneSnapshot[] = [];
  const client = {
    phoneOpen: () => Promise.resolve(opened),
    phoneClose: () => Promise.resolve({ open: false, reason: "closed by the page" } as PhoneDoorState),
    phonePublish: (snapshot: PhoneSnapshot) => published.push(snapshot),
    onPhoneWrite: (listener: (phone: string, set: PhoneSet) => void) => {
      writes.add(listener);
      return () => writes.delete(listener);
    },
    onPhoneState: (listener: (state: PhoneDoorState) => void) => {
      states.add(listener);
      return () => states.delete(listener);
    },
    reconnectRemembered: () => undefined,
  } as unknown as DeviceClient;
  return {
    client,
    published,
    phoneWrites: (phone: string, set: PhoneSet) => {
      for (const listener of writes) listener(phone, set);
    },
    pushState: (state: PhoneDoorState) => {
      for (const listener of states) listener(state);
    },
  };
}

async function runtimeWithPanel(): Promise<AppRuntime> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "desk", label: "Desk" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        { op: "addNode", ref: "$fader", type: "slider", position: { x: 0, y: 0 }, label: "fader1", parameters: { channel: "heat", value: 0.25 } },
        { op: "addNode", ref: "$panel", type: "panel", position: { x: 0, y: 200 }, label: "panel1", parameters: { title: "Furnace", layout: "fader1", remote: true } },
      ],
    } as never,
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return runtime;
}

const soon = (callback: () => void): (() => void) => {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
};

function Desk({ runtime, client }: { runtime: AppRuntime; client: DeviceClient }) {
  const door = usePhoneDoor({ deviceClient: () => client, bus: runtime.bus, invocation: runtime.invocation, schedule: soon });
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return (
    <>
      <NoticeStrip notices={phoneDoorNotices(door)} />
      <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} phone={door} />
    </>
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const faderId = (runtime: AppRuntime) => Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === "fader1")!.id;

describe("T1396b — the phone door, page side", () => {
  it("opens from the pane, shows the QR for the helper's URL, publishes the Panel, and a phone's write moves the desk's slider", async () => {
    const runtime = await runtimeWithPanel();
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "AB:CD:EF:01:23:45:67:89:AA:BB", phones: [] });
    render(<Desk runtime={runtime} client={helper.client} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    const qr = document.querySelector(`svg[data-phone-qr]`);
    expect(qr?.getAttribute("data-phone-qr")).toBe(URL_WITH_TOKEN);
    expect(qr?.querySelectorAll("path")).toHaveLength(1);
    expect(qr?.querySelector("path")?.getAttribute("d")).not.toBe("");
    expect(document.querySelector("[data-phone-url]")?.textContent).toBe(URL_WITH_TOKEN);
    expect(screen.getByText("AB:CD:EF:01…AA:BB")).not.toBeNull();

    // What went to the phones: the published Panel, its slider at the stored value.
    const fader = faderId(runtime);
    const last = helper.published.at(-1)!;
    expect(last.panels).toEqual([
      { title: "Furnace", rows: [{ kind: "widgets", widgets: [{ kind: "slider", handle: fader, caption: "heat", value: 0.25, min: 0, max: 1, step: 0 }] }] },
    ]);

    await act(async () => {
      helper.phoneWrites("p1", { handle: fader, values: { value: 0.8 }, phase: "commit" });
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[fader]!.parameters["value"]).toBe(0.8);
    // The desk's own slider shows it…
    expect(screen.getByRole("slider", { name: "heat" }).getAttribute("aria-valuenow")).toBe("0.8");
    // …and the other phones are told, once, with a newer seq.
    const echoed = helper.published.at(-1)!;
    expect(echoed.seq).toBeGreaterThan(last.seq);
    expect(JSON.stringify(echoed.panels)).toContain('"value":0.8');
    const sent = helper.published.length;
    await act(async () => {
      // A document change nobody on a phone can see sends nothing.
      const moved = await runtime.bus.execute(
        "graph.applyPatch",
        { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "moveNodes", positions: { [fader]: { x: 40, y: 40 } } }] },
        runtime.invocation,
      );
      expect(moved.output.status).toBe("applied");
      await settle();
    });
    expect(helper.published.length).toBe(sent);
  });

  it("a refused phone write is said in the popover and in the notice strip, and changes nothing", async () => {
    const runtime = await runtimeWithPanel();
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    render(<Desk runtime={runtime} client={helper.client} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    const fader = faderId(runtime);
    await act(async () => {
      helper.phoneWrites("p1", { handle: fader, values: { max: 50 }, phase: "commit" });
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[fader]!.parameters["max"]).toBe(1);
    const sentence = "A phone tried to write a key a slider does not let a phone write, on “heat”.";
    expect(document.querySelector("[data-phone-refusal]")?.textContent).toContain(sentence);
    expect(document.querySelector('[data-notice="phone-refused"]')?.textContent).toContain(sentence);
  });

  it("shows the helper's reason verbatim when the door stays shut, and a closed socket closes it", async () => {
    const runtime = await runtimeWithPanel();
    const reason = PHONE_DOOR_UNAVAILABLE;
    const helper = fakeClient({ open: false, reason });
    render(<Desk runtime={runtime} client={helper.client} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    expect(document.querySelector("[data-phone-reason]")?.textContent).toBe(reason);

    const open = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    cleanup();
    render(<Desk runtime={runtime} client={open.client} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    expect(document.querySelector("[data-phone-door]")?.getAttribute("data-phone-door")).toBe("open");
    await act(async () => {
      open.pushState({ open: false, reason: "The device bridge closed the connection, and the phone door with it." });
      await settle();
    });
    expect(document.querySelector("[data-phone-door]")?.getAttribute("data-phone-door")).toBe("closed");
  });

  it("says so when no Panel is published", async () => {
    const runtime = await runtimeWithPanel();
    const panel = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.type === "panel")!;
    await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: panel.id, parameters: { remote: false } }] },
      runtime.invocation,
    );
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    render(<Desk runtime={runtime} client={helper.client} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    expect(screen.getByText(/No Panel is published yet/)).not.toBeNull();
    expect(helper.published.at(-1)?.panels).toEqual([]);
  });
});
