import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { rafScheduler, type FrameScheduler } from "@ui/controls/coalesce.ts";
import type { DeviceClient } from "@devices/device-client.ts";
import { DEVICE_HELPER_START } from "@devices/helper.ts";
import type { PhoneDoorState } from "@devices/phone/phone-protocol.ts";
import { morphRunning, type MorphRecord } from "@domain/presets/index.ts";
import { buildPhoneSnapshot, publishedMorphs } from "@devices/phone/phone-snapshot.ts";
import type { PhoneDoorView, PhoneRefusal } from "@editor/controls/phone-door-copy.ts";
import { createPhoneWrites } from "./phone-writes.ts";
import type { Notice } from "./notices.tsx";

/**
 * T1396b — THE PHONE DOOR, PAGE SIDE: the door's state, what the phones see, and what
 * they write.
 *
 * Rides the tab's ONE device attachment (`use-osc-bridge.ts` owns it; laser and vision
 * borrow it the same way), because the phone door is a door of the same helper and a
 * second attachment would be refused.
 *
 * ## What it publishes, and when
 *
 * While the door is open, every document change schedules ONE rebuild for the next
 * animation frame; the rebuilt snapshot is sent only when it differs from the last one
 * sent (compared as JSON, `seq` aside). So a phone's drag, which changes the document
 * sixty times a second, echoes its values to every OTHER phone at most once a frame, and
 * a change nobody on a phone can see (a node moved, an unpublished parameter) sends
 * nothing at all. A phone arriving forces one send, so a late joiner is never waiting on
 * the next edit for its first picture.
 *
 * ## The end of a fade (T1503b)
 *
 * A bank's `morphing` is true while a recall's fade is still running on the page's frame
 * clock. The START is a document change (the recall wrote its morph record), so the rule
 * above publishes it. The END changes nothing in the document: the clock simply passes the
 * record's end. So while a published snapshot says some bank is morphing, the hook holds
 * the records behind that and asks `morphRunning` of them once a frame — a handful of
 * comparisons, not a rebuilt snapshot — and rebuilds exactly when one stops running (the
 * clock crossed its end, or a render zeroed the clock). Two publishes per fade, and no
 * frame callback at all while nothing fades.
 *
 * ## What it writes
 *
 * Every `phoneWrite` goes to `createPhoneWrites` — vetted against the document as it is
 * now and applied as that phone's own human actor (see that module). A refusal is kept as
 * `refusal` and becomes a notice (`phoneDoorNotices`); the popover shows it too. And the
 * phone that pressed is TOLD (T1526b): the same sentence, with the control it is about,
 * goes back through the helper to that phone's stream only (`phoneRefuse`), where the page
 * shows it on the control. Until then a refused recall or GO looked, on the phone, like a
 * press that did nothing.
 *
 * ## When the door is closed without anybody pressing Close
 *
 * The device client reports a CLOSED door when its socket goes away (the helper closes
 * the listener then too), and the tab going away takes the socket with it. The hook also
 * asks for a close when it unmounts, best-effort, so a remount does not leave a door open
 * nobody on this page is watching.
 *
 * ## When the helper arrives after the ask (T1495b)
 *
 * A door asked for while no helper is attached answers with the helper's absence, and
 * nothing would ask again. So the ask is REMEMBERED until a door actually opens (or the
 * user closes it), and the rising edge of the device attachment — the same one the OSC
 * status line reports — asks again by itself. Only the edge: an attached helper that
 * refused the door (no `--phone`) is not asked twice in a row.
 */

export interface PhoneDoorOptions {
  readonly deviceClient: () => DeviceClient | null;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** Whether the device client is attached to a helper now (T1495b). */
  readonly attached: boolean;
  /** Injected by tests; the default is the animation frame. */
  readonly schedule?: FrameScheduler;
}

/** What the hook hands the app: the popover's view, plus the notices it feeds. */
export type PhoneDoorBinding = PhoneDoorView;

const NO_CLIENT = `No device bridge is attached, so there is no phone door — ${DEVICE_HELPER_START}.`;

export function usePhoneDoor(options: PhoneDoorOptions): PhoneDoorBinding {
  const { deviceClient, bus, invocation, attached } = options;
  const schedule = options.schedule ?? rafScheduler;
  const [state, setState] = useState<PhoneDoorState | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<PhoneRefusal | null>(null);
  const [publishedPanels, setPublishedPanels] = useState(0);
  /** T1495b: asked for, and not yet had — an attachment arriving asks again. */
  const [wanted, setWanted] = useState(false);
  const seq = useRef(0);
  const lastSent = useRef<string | null>(null);
  const phones = useRef<ReadonlySet<string>>(new Set());
  /** Whether this page ever asked for the door — a socket closing before that says nothing. */
  const asked = useRef(false);
  /** The open door's publish, so a phone arriving can force one send. */
  const publishNow = useRef<(() => void) | null>(null);
  /** The device client as of this render, for the refusal a phone is told (`writes` outlives a render). */
  const clientNow = useRef(deviceClient);
  clientNow.current = deviceClient;

  const writes = useMemo(
    () =>
      createPhoneWrites({
        bus,
        invocation,
        ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
        onRefused: (phone, reason, handle) => {
          setRefusal((previous) => ({ phone, reason, count: (previous?.count ?? 0) + 1 }));
          // T1526b: and the phone that pressed is told, on the control it pressed.
          clientNow.current()?.phoneRefuse(phone, handle, reason);
        },
      }),
    // The scheduler is injected once by a test; a new one per render would drop open gestures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bus, invocation],
  );
  useEffect(() => () => writes.dispose(), [writes]);

  /** A door state, applied: phones that left let go of what they held. */
  const adopt = useCallback(
    (next: PhoneDoorState): void => {
      const present = new Set(next.open ? next.phones.map((peer) => peer.phone) : []);
      for (const phone of phones.current) if (!present.has(phone)) void writes.release(phone);
      const arrived = [...present].some((phone) => !phones.current.has(phone));
      phones.current = present;
      setState(next);
      if (next.open) setWanted(false);
      if (!next.open) {
        lastSent.current = null;
        return;
      }
      // A new phone needs a picture now, not at the next edit.
      if (arrived) {
        lastSent.current = null;
        publishNow.current?.();
      }
    },
    [writes],
  );

  useEffect(() => {
    const client = deviceClient();
    if (client === null) return;
    const offWrite = client.onPhoneWrite((phone, set) => {
      void writes.write(phone, set);
    });
    const offState = client.onPhoneState((next) => {
      // A socket that closes while the door was never asked for says nothing to anyone.
      if (!asked.current && !next.open) return;
      adopt(next);
    });
    return () => {
      offWrite();
      offState();
      if (asked.current) void client.phoneClose();
    };
  }, [deviceClient, writes, adopt]);

  const open = state?.open === true;
  useEffect(() => {
    if (!open) return;
    const client = deviceClient();
    if (client === null) return;
    let cancel: (() => void) | null = null;
    /** T1503b: the fades behind the last snapshot's `morphing` flags, and the frame watch on them. */
    let fading: readonly MorphRecord[] = [];
    let cancelWatch: (() => void) | null = null;
    const watch = (): void => {
      cancelWatch = null;
      // Nothing fading any more (an undo took the record away): the watch ends here.
      if (fading.length === 0) return;
      const clock = bus.frameClock();
      if (clock !== undefined && fading.every((record) => morphRunning(record, clock))) {
        cancelWatch = schedule(watch);
        return;
      }
      // A fade ended. This publish stands in for one a document change had queued.
      cancel?.();
      publish();
    };
    const publish = (): void => {
      cancel = null;
      const graph = bus.store.getGraph();
      const clock = bus.frameClock();
      const snapshot = buildPhoneSnapshot(graph, 0, clock);
      fading = publishedMorphs(graph, clock);
      if (fading.length > 0) cancelWatch ??= schedule(watch);
      const body = JSON.stringify(snapshot.panels);
      setPublishedPanels(snapshot.panels.length);
      if (body === lastSent.current) return;
      lastSent.current = body;
      seq.current += 1;
      client.phonePublish({ seq: seq.current, panels: snapshot.panels });
    };
    publishNow.current = publish;
    publish();
    const unsubscribe = bus.store.subscribe(() => {
      if (cancel === null) cancel = schedule(publish);
    });
    return () => {
      publishNow.current = null;
      unsubscribe();
      cancel?.();
      cancelWatch?.();
    };
    // `schedule` is stable per mount (see `writes`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bus, deviceClient]);

  const openDoor = useCallback((): void => {
    asked.current = true;
    setWanted(true);
    const client = deviceClient();
    if (client === null) {
      setState({ open: false, reason: NO_CLIENT });
      return;
    }
    // A tab paired earlier this session picks its attachment back up; the request waits.
    client.reconnectRemembered();
    setPending(true);
    void client.phoneOpen().then((next) => {
      setPending(false);
      adopt(next);
    });
  }, [deviceClient, adopt]);

  const closeDoor = useCallback((): void => {
    setWanted(false);
    const client = deviceClient();
    if (client === null) return;
    setPending(true);
    void client.phoneClose().then((next) => {
      setPending(false);
      adopt(next);
    });
  }, [deviceClient, adopt]);

  // T1495b: the helper attached — ask again for a door asked for while it was absent.
  useEffect(() => {
    if (attached && wanted && !pending) openDoor();
    // The RISING EDGE of the attachment only: what it reads is current in this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached]);

  const dismissRefusal = useCallback(() => setRefusal(null), []);
  const awaitingHelper = wanted && !attached;

  return useMemo(
    () => ({ state, pending, publishedPanels, refusal, awaitingHelper, open: openDoor, close: closeDoor, dismissRefusal }),
    [state, pending, publishedPanels, refusal, awaitingHelper, openDoor, closeDoor, dismissRefusal],
  );
}

/** The notice strip's line for a refused phone write — refusals are never silent. */
export function phoneDoorNotices(door: PhoneDoorBinding): Notice[] {
  if (door.refusal === null) return [];
  return [
    {
      id: "phone-refused",
      tone: "warn",
      message: door.refusal.reason,
      detail:
        door.refusal.count > 1
          ? `${door.refusal.count} phone writes refused so far; this is the latest.`
          : "A phone on the phone door sent it; nothing was written.",
      actions: [{ label: "Dismiss", onSelect: door.dismissRefusal }],
    },
  ];
}
