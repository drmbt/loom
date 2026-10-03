// @vitest-environment jsdom
import { useMemo, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceClient } from "@devices/device-client.ts";
import { PHONE_DOOR_UNAVAILABLE } from "@devices/helper.ts";
import type { PhoneDoorState, PhoneSet, PhoneSnapshot } from "@devices/phone/phone-protocol.ts";
import { ControlsPane } from "@editor/controls/controls-pane.tsx";
import { useControlBodies } from "@editor/controls/control-bodies.tsx";
import { CanvasFixture } from "@editor/graph-canvas/canvas-fixture.tsx";
import { fixtureContext, installFlowStubs, nodeProps } from "@editor/graph-canvas/testing.tsx";
import { useKeymapPane } from "@editor/keymap/pane.ts";
import { NodeView } from "@editor/nodes/node-view.tsx";
import type { FrameClock } from "@domain/types/frame.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { serializeCueList, serializePresetBank } from "@domain/presets/index.ts";
import type { FrameScheduler } from "@ui/controls/coalesce.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
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
installFlowStubs();
afterEach(cleanup);

const URL_WITH_TOKEN = "https://192.168.1.20:47811/?t=abc123";

function fakeClient(initially: PhoneDoorState) {
  const writes = new Set<(phone: string, set: PhoneSet) => void>();
  const states = new Set<(state: PhoneDoorState) => void>();
  const published: PhoneSnapshot[] = [];
  /** T1526b: every refusal the page told a phone — [phone, handle, reason], in order. */
  const refused: Array<[string, string, string]> = [];
  /** What the helper answers the next `phoneOpen` with, and how often it was asked. */
  const door = { answer: initially, asked: 0 };
  const client = {
    phoneOpen: () => {
      door.asked += 1;
      return Promise.resolve(door.answer);
    },
    phoneClose: () => Promise.resolve({ open: false, reason: "closed by the page" } as PhoneDoorState),
    phonePublish: (snapshot: PhoneSnapshot) => published.push(snapshot),
    phoneRefuse: (phone: string, handle: string, reason: string) => refused.push([phone, handle, reason]),
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
    door,
    published,
    refused,
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

function Desk({
  runtime,
  client,
  attached = true,
  schedule = soon,
}: {
  runtime: AppRuntime;
  client: DeviceClient;
  attached?: boolean;
  schedule?: FrameScheduler;
}) {
  const door = usePhoneDoor({ deviceClient: () => client, bus: runtime.bus, invocation: runtime.invocation, attached, schedule });
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

  /*
   * T1526b: the desk's notice was the ONLY place a refusal was said — the phone that pressed
   * saw nothing change. The page now tells that phone, through the helper: who, the control
   * (the id the snapshot gave it), and the same sentence the desk shows. An applied write
   * tells nobody anything, and one phone's refusal is not addressed to another.
   */
  it("T1526b: tells the phone that pressed — and only it — with the control and the sentence the desk shows", async () => {
    const runtime = await runtimeWithPanel();
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    render(<Desk runtime={runtime} client={helper.client} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    const fader = faderId(runtime);
    await act(async () => {
      // p1 moves the slider (applied); p2 tries a key a phone may not write, then a node that is no published control.
      helper.phoneWrites("p1", { handle: fader, values: { value: 0.6 }, phase: "commit" });
      helper.phoneWrites("p2", { handle: fader, values: { max: 50 }, phase: "commit" });
      helper.phoneWrites("p2", { handle: "not-a-control", values: { value: 1 }, phase: "commit" });
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[fader]!.parameters["value"]).toBe(0.6);
    const keyRefused = "A phone tried to write a key a slider does not let a phone write, on “heat”.";
    const unpublished = "A phone tried to move a control that is not published to the phone door.";
    expect(helper.refused).toEqual([
      ["p2", fader, keyRefused],
      // What the phone sent as a handle does not come back: the refusal names no control.
      ["p2", "", unpublished],
    ]);
    // The desk's notice is still said — the latest refusal, and the count of both.
    expect(document.querySelector('[data-notice="phone-refused"]')?.textContent).toContain(unpublished);
    expect(document.querySelector('[data-notice="phone-refused"]')?.textContent).toContain("2 phone writes refused");
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

  // T1512b: the Phone button is the Panel's own now, so pressing it on an unpublished Panel
  // PUBLISHES that Panel — and "Stop publishing" is how a phone is left with nothing.
  it("publishes the Panel it is pressed on, and says so when stopping leaves nothing published", async () => {
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
    expect(runtime.bus.store.getGraph().nodes[panel.id]!.parameters["remote"]).toBe(true);
    expect(helper.published.at(-1)?.panels.map((shown) => shown.title)).toEqual(["Furnace"]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop publishing" }));
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[panel.id]!.parameters["remote"]).toBe(false);
    expect(screen.getByText(/No Panel is published yet/)).not.toBeNull();
    expect(helper.published.at(-1)?.panels).toEqual([]);
  });
});

/**
 * T1495b — THE HELPER STARTED AFTER THE PAGE. The page asked for the door while no helper
 * was attached and got the helper's absence; the user then starts `--phone` and pairs. The
 * door must open on the attachment by itself — and ONLY because it was asked for: a LAN
 * listener that opened on an attach nobody asked for would be the door opening itself.
 */
describe("T1495b — the phone door follows the device attachment", () => {
  const ABSENT: PhoneDoorState = { open: false, reason: "No device bridge is attached, so there is no phone door." };
  const OPEN: PhoneDoorState = { open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] };
  const doorState = () => document.querySelector("[data-phone-door]")?.getAttribute("data-phone-door");

  it("opens by itself when the helper attaches after the ask — no Try again", async () => {
    const runtime = await runtimeWithPanel();
    const helper = fakeClient(ABSENT);
    const { rerender } = render(<Desk runtime={runtime} client={helper.client} attached={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    expect(document.querySelector("[data-phone-reason]")?.textContent).toBe(ABSENT.reason);
    expect(document.querySelector("[data-phone-awaiting]")).not.toBeNull();
    expect(doorState()).toBe("closed");

    // `pnpm helper --phone` runs, the tab pairs: the attachment rises.
    helper.door.answer = OPEN;
    await act(async () => {
      rerender(<Desk runtime={runtime} client={helper.client} attached />);
      await settle();
    });
    expect(helper.door.asked).toBe(2);
    expect(doorState()).toBe("open");
    expect(document.querySelector("svg[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe(URL_WITH_TOKEN);
    expect(document.querySelector("[data-phone-awaiting]")).toBeNull();
  });

  it("opens nothing on an attach nobody asked for, or after the user closed the door", async () => {
    const runtime = await runtimeWithPanel();
    const helper = fakeClient(OPEN);
    const { rerender } = render(<Desk runtime={runtime} client={helper.client} attached={false} />);
    await act(async () => {
      rerender(<Desk runtime={runtime} client={helper.client} attached />);
      await settle();
    });
    expect(helper.door.asked).toBe(0);
    expect(doorState()).toBe("closed");

    // Asked for, opened, then CLOSED by the user: a later re-attach leaves it closed.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    expect(doorState()).toBe("open");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close door" }));
      await settle();
    });
    expect(doorState()).toBe("closed");
    await act(async () => {
      rerender(<Desk runtime={runtime} client={helper.client} attached={false} />);
      await settle();
    });
    await act(async () => {
      rerender(<Desk runtime={runtime} client={helper.client} attached />);
      await settle();
    });
    expect(helper.door.asked).toBe(1);
    expect(doorState()).toBe("closed");
  });
});

/**
 * T1512b — THE PHONE ICON ON THE PANEL NODE: the owner's "one place" for the phone. On the
 * canvas, the Panel's header carries it beside P/B/M; pressing it on an unpublished Panel
 * publishes THAT Panel (its `remote`, through the bus) and opens the same door popover,
 * anchored there, with the QR for the helper's URL — and the phones get the Panel.
 */
describe("T1512b — the Panel node's header phone icon", () => {
  function PanelOnCanvas({ runtime, client, panelId }: { runtime: AppRuntime; client: DeviceClient; panelId: NodeId }) {
    const door = usePhoneDoor({ deviceClient: () => client, bus: runtime.bus, invocation: runtime.invocation, attached: true, schedule: soon });
    const bodies = useControlBodies({ bus: runtime.bus, invocation: runtime.invocation, write: () => undefined, phone: door });
    const { value } = useMemo(
      () => fixtureContext({ store: runtime.bus.store, registry: runtime.bus.registry, ...bodies }),
      [runtime, bodies],
    );
    return (
      <CanvasFixture value={value}>
        <NodeView {...nodeProps(panelId)} />
      </CanvasFixture>
    );
  }

  it("publishes the Panel and shows the QR, right on the node", async () => {
    const runtime = await runtimeWithPanel();
    const panel = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.type === "panel")!;
    await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: panel.id, parameters: { remote: false } }] },
      runtime.invocation,
    );
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    render(<PanelOnCanvas runtime={runtime} client={helper.client} panelId={panel.id} />);
    const icon = screen.getByRole("button", { name: /^Phone/ });
    expect(icon.getAttribute("aria-pressed")).toBe("false");
    // It sits in the header row with the node's own toggles.
    expect(icon.closest("header")?.querySelector('[aria-label="Mute"]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(icon);
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[panel.id]!.parameters["remote"]).toBe(true);
    expect(screen.getByRole("button", { name: /^Phone/ }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("svg[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe(URL_WITH_TOKEN);
    expect(helper.published.at(-1)?.panels.map((shown) => shown.title)).toEqual(["Furnace"]);
  });

  /**
   * T1518b — THE BUTTONS IN THAT POPOVER DO WHAT THEY SAY. Found in the browser: on the canvas
   * the popover is portalled out of the node in the DOM but not in React, so a press on
   * "Stop publishing" bubbled to the graph pane, whose own `onPointerDown` takes focus
   * (`useKeymapPane`, B66/B67) — and Radix read that as focus leaving the popover and closed
   * it between pointerdown and click. The click never landed: the Panel stayed published,
   * the door stayed open. So the Panel sits inside the REAL pane here, and each press is the
   * whole gesture a hand makes, not a bare click that would skip the step that broke it.
   */
  function GraphPane({ children }: { children: ReactNode }) {
    const ref = useRef<HTMLDivElement | null>(null);
    return <div {...useKeymapPane("graph", ref)}>{children}</div>;
  }

  /** Pointer down, up, click — re-finding the button each time, as it must still be there. */
  async function press(name: string): Promise<void> {
    const find = () => screen.getByRole("button", { name });
    await act(async () => {
      fireEvent.pointerDown(find(), { pointerId: 1 });
      await settle();
    });
    await act(async () => {
      fireEvent.pointerUp(find(), { pointerId: 1 });
      fireEvent.click(find());
      await settle();
    });
  }

  it("Stop publishing turns the Panel's Phone off, and Close door closes the door — inside the graph pane", async () => {
    const runtime = await runtimeWithPanel();
    const panel = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.type === "panel")!;
    const remote = () => runtime.bus.store.getGraph().nodes[panel.id]!.parameters["remote"];
    const doorState = () => document.querySelector("[data-phone-door]")?.getAttribute("data-phone-door");
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    const view = render(
      <GraphPane>
        <PanelOnCanvas runtime={runtime} client={helper.client} panelId={panel.id} />
      </GraphPane>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    expect(remote()).toBe(true);
    expect(doorState()).toBe("open");

    await press("Stop publishing");
    expect(remote()).toBe(false);
    // The popover is still there, and says so: the way back is the same button.
    expect(screen.getByRole("button", { name: "Publish" })).not.toBeNull();

    await press("Close door");
    expect(doorState()).toBe("closed");
    // The press stayed in the popover: the pane behind it never took focus.
    expect(document.activeElement).not.toBe(view.container.firstElementChild);
  });
});

/**
 * T1503b (§T1398b ruling 12, the design doc §5.5) — A FADE ON THE PHONE. A phone that
 * recalls a preset with a morph sees the destination lit at once and a fade mark until the
 * fade is over. The start is a document change; the END is not — the frame clock simply
 * passes the record's end — so this is the test that the phones are told anyway, exactly
 * twice per fade, and that a page with nothing fading does no per-frame work for it.
 */
describe("T1503b — the phone door tells phones when a fade starts and when it ends", () => {
  const LOOKS = serializePresetBank({
    version: 1,
    presets: [
      { name: "soft", values: { blur1: { size: 4 } } },
      { name: "hard", values: { blur1: { size: 20 } } },
    ],
  });

  async function runtimeWithBank(): Promise<{ runtime: AppRuntime; looks: NodeId }> {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "desk", label: "Desk" } });
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "setup",
        operations: [
          { op: "addNode", ref: "$blur", type: "blur", position: { x: 0, y: 0 }, label: "blur1", parameters: { size: 9 } },
          // The bank's own Morph: two seconds. A phone cannot name one; it gets the bank's.
          { op: "addNode", ref: "$looks", type: "presets", position: { x: 0, y: 100 }, label: "looks", parameters: { targets: "blur1", presets: LOOKS, morph: 2, curve: "linear" } },
          {
            op: "addNode",
            ref: "$panel",
            type: "panel",
            position: { x: 0, y: 200 },
            label: "panel1",
            parameters: { title: "Show", remote: true, board: serializePanelBoard({ columns: 8, items: [{ member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } }] }) },
          },
        ],
      } as never,
      runtime.invocation,
    );
    expect(result.output.status).toBe("applied");
    return { runtime, looks: (result.output.createdIds as Record<string, NodeId>)["$looks"]! };
  }

  /** What each published snapshot told the phones about the bank. */
  const told = (published: readonly PhoneSnapshot[]) =>
    published.map((snapshot) => {
      const item = snapshot.panels[0]?.board?.items[0];
      const bank = item?.kind === "widget" && item.widget.kind === "preset" ? item.widget : null;
      return bank === null ? null : { current: bank.current, morphing: bank.morphing };
    });

  it("publishes `morphing` at the recall and clears it when the frame clock passes the fade's end — two publishes, no document change for the second", async () => {
    const { runtime, looks } = await runtimeWithBank();
    let clock: FrameClock = { epoch: "run-1", absTimeSeconds: 5 };
    runtime.bus.attachFrameClock(() => clock);
    let frames = 0;
    const counted: FrameScheduler = (callback) => {
      frames += 1;
      return soon(callback);
    };
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    render(<Desk runtime={runtime} client={helper.client} schedule={counted} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    expect(told(helper.published)).toEqual([{ current: null, morphing: false }]);
    // Nothing fading: the door asks for no frames at all.
    const idle = frames;
    await act(settle);
    expect(frames).toBe(idle);

    await act(async () => {
      helper.phoneWrites("p1", { handle: looks, values: { recall: "hard" }, phase: "commit" });
      await settle();
    });
    // The destination at once, and the fade still to do.
    expect(told(helper.published)).toEqual([
      { current: null, morphing: false },
      { current: "hard", morphing: true },
    ]);

    // Frames go by with the fade still running (and a paused transport is exactly this): nothing more is sent.
    clock = { epoch: "run-1", absTimeSeconds: 6.9 };
    await act(settle);
    expect(helper.published).toHaveLength(2);

    // The clock passes the end. The document does not change — only the clock did.
    const revision = runtime.bus.store.getRevision();
    clock = { epoch: "run-1", absTimeSeconds: 7 };
    await act(settle);
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(told(helper.published)).toEqual([
      { current: null, morphing: false },
      { current: "hard", morphing: true },
      { current: "hard", morphing: false },
    ]);
    expect(helper.published.at(-1)!.seq).toBeGreaterThan(helper.published.at(-2)!.seq);

    // The fade is over and so is the watch: more frames, nothing asked for, nothing sent.
    const after = frames;
    clock = { epoch: "run-1", absTimeSeconds: 9 };
    await act(settle);
    expect(frames).toBe(after);
    expect(helper.published).toHaveLength(3);
  });

  it("an undo that takes the fade away mid-fade clears `morphing` with it, and the watch stops", async () => {
    const { runtime, looks } = await runtimeWithBank();
    const clock: FrameClock = { epoch: "run-1", absTimeSeconds: 5 };
    runtime.bus.attachFrameClock(() => clock);
    let frames = 0;
    const counted: FrameScheduler = (callback) => {
      frames += 1;
      return soon(callback);
    };
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    render(<Desk runtime={runtime} client={helper.client} schedule={counted} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    await act(async () => {
      helper.phoneWrites("p1", { handle: looks, values: { recall: "hard" }, phase: "commit" });
      await settle();
    });
    expect(told(helper.published).at(-1)).toEqual({ current: "hard", morphing: true });
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, { ...runtime.invocation, actor: { kind: "human", id: "remote-p1", label: "Phone" } });
      await settle();
    });
    expect(told(helper.published).at(-1)).toEqual({ current: null, morphing: false });
    const after = frames;
    await act(settle);
    expect(frames).toBe(after);
  });
});

/**
 * §T1544b — the door hands the snapshot the bus's node REGISTRY, so a following cue list on a
 * published Panel tells the phone what it switches in the structure at its cue times (the
 * inspector's note). Without it the note would always be empty — built, tested, never wired.
 */
describe("§T1544b — a following cue list's structure note reaches the phone", () => {
  it("publishes the structural settings a timed list switches: `fx.on` for a cue that turns the fx Layer on", async () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "desk", label: "Desk" } });
    const presets = serializePresetBank({ version: 1, presets: [{ name: "drop", values: {}, on: { fx: true } }] });
    const cues = serializeCueList({ version: 1, cues: [{ name: "1", bank: "looks", preset: "drop", at: 1 }] });
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "setup",
        operations: [
          { op: "addNode", ref: "$fx", type: "layer", position: { x: 0, y: 0 }, label: "fx" },
          { op: "addNode", ref: "$looks", type: "presets", position: { x: 0, y: 100 }, label: "looks", parameters: { targets: "fx", presets } },
          { op: "addNode", ref: "$set", type: "cueList", position: { x: 0, y: 200 }, label: "set", parameters: { cues, follow: "timeline" } },
          {
            op: "addNode",
            ref: "$panel",
            type: "panel",
            position: { x: 0, y: 300 },
            label: "panel1",
            parameters: { title: "Show", remote: true, board: serializePanelBoard({ columns: 8, items: [{ member: "set", rect: { x: 0, y: 0, w: 4, h: 2 } }] }) },
          },
        ],
      } as never,
      runtime.invocation,
    );
    expect(result.output.status).toBe("applied");
    const fx = (result.output.createdIds as Record<string, NodeId>)["$fx"]!;
    const off = await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "setNodeUi", nodeId: fx, ui: { bypassed: true } }] } as never,
      runtime.invocation,
    );
    expect(off.output.status).toBe("applied");
    const helper = fakeClient({ open: true, url: URL_WITH_TOKEN, fingerprint: "ff", phones: [] });
    render(<Desk runtime={runtime} client={helper.client} schedule={soon} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
      await settle();
    });
    const item = helper.published.at(-1)?.panels[0]?.board?.items[0];
    const list = item?.kind === "widget" && item.widget.kind === "cueList" ? item.widget : null;
    expect(list).toMatchObject({ following: true, structure: ["fx.on"] });
  });
});
