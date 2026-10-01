import { useMemo, useState } from "react";
import { Button, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger, cx } from "@ui/index.ts";
import { encodeQr, qrToSvgPath } from "@devices/phone/qr.ts";
import {
  PHONE_AWAITING_HELPER,
  PHONE_NOTHING_PUBLISHED,
  PHONE_PANEL_PUBLISHED,
  PHONE_PANEL_UNPUBLISHED,
  PHONE_PUBLISHED_TITLE,
  PHONE_PUBLISH_TITLE,
  PHONE_SCAN_HINT,
  phoneCameraLine,
  phoneLabel,
  shortFingerprint,
  type PhoneDoorView,
} from "./phone-door-copy.ts";
import styles from "./phone-door.module.css";
import { FirewallNote } from "./firewall-note.tsx";
import { popoverEventStops } from "./popover-events.ts";

/**
 * T1396b — the phone door's popover: open the door, show the QR code a phone scans, the
 * address as text for one that cannot scan, the certificate's fingerprint to compare with
 * what the phone is asked to accept, and who is connected. A door the helper refused shows
 * the helper's own sentence; nothing is paraphrased. T1512b moved its trigger onto the
 * Panel (`PhoneDoorButton`, below).
 */

/** Modules of light margin a scanner needs around the code (the QR standard's four). */
const QUIET_ZONE = 4;

export function PhoneQr({ text }: { readonly text: string }) {
  const qr = useMemo(() => encodeQr(text), [text]);
  const d = useMemo(() => qrToSvgPath(qr, { quietZone: QUIET_ZONE }), [qr]);
  const extent = qr.size + QUIET_ZONE * 2;
  return (
    <svg
      className={styles.qr}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Phone door QR code"
      data-phone-qr={text}
    >
      <path className={styles.qrInk} d={d} />
    </svg>
  );
}

/** A phone outline, in the text colour — the Panel's "publish to phones" mark. */
function PhoneIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="4" y="1.5" width="8" height="13" rx="1.5" />
      <line x1="7" y1="12" x2="9" y2="12" />
    </svg>
  );
}

/** A Panel's Phone switch, when the button sits on a Panel. */
export interface PanelPublish {
  /** This Panel's Phone switch (`remote`) as the document holds it. */
  readonly published: boolean;
  /** Writes this Panel's `remote` through the bus — one patch, undoable. */
  readonly publish: (on: boolean) => void;
}

export interface PhoneDoorButtonProps {
  readonly door: PhoneDoorView;
  /** Present when the button sits ON a Panel: then it publishes that Panel. */
  readonly panel?: PanelPublish | undefined;
}

/**
 * T1512b — THE PHONE ICON: one component and one popover, drawn on the Panel node's
 * header on the canvas and in the Controls tab's header — so the phone's affordance is ON
 * the Panel it publishes.
 *
 * On a Panel (`panel` given), pressing it on an unpublished Panel publishes it (`remote`
 * on) and opens the door's popover right there (QR, address, fingerprint, phones, Close
 * door — T1396b); on a published Panel it opens the popover, which carries the way back
 * ("Stop publishing"). Pressing never unpublishes by itself: the press that shows the QR
 * must not be the press that hides the controls from the phone about to scan it.
 *
 * With no Panel (the Controls tab of a document that has none) it is the door alone —
 * still needed there, because a phone can send its camera with no controls published
 * (T1397b).
 */
export function PhoneDoorButton({ door, panel }: PhoneDoorButtonProps) {
  const [shown, setShown] = useState(false);
  const state = door.state;
  const open = state?.open === true;
  const phones = open ? state.phones.length : 0;
  const published = panel?.published === true;
  return (
    <PopoverRoot
      open={shown}
      onOpenChange={(next) => {
        setShown(next);
        if (next && panel !== undefined && !panel.published) panel.publish(true);
        if (next && !open && !door.pending) door.open();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cx(styles.trigger, "nodrag", "nopan", (panel === undefined ? open : published) && styles.published)}
          aria-label={phones > 0 ? `Phone · ${phones}` : "Phone"}
          aria-pressed={panel === undefined ? open : published}
          title={panel === undefined ? "Phone door" : published ? PHONE_PUBLISHED_TITLE : PHONE_PUBLISH_TITLE}
          data-phone-door={open ? "open" : "closed"}
          // §V20: a press on header chrome must not start a node drag or a canvas pan.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <PhoneIcon />
          {phones > 0 ? <span className={styles.count}>{phones}</span> : null}
        </button>
      </PopoverTrigger>
      {/* T1518b: on a Panel node, a press in here closed the popover before its click landed
          — "Stop publishing" and "Close door" did nothing (`popover-events.ts`). */}
      <PopoverContent className={styles.popover} aria-label="Phone door" {...popoverEventStops}>
        <PopoverHeader>Phone door</PopoverHeader>
        {panel === undefined ? null : (
          <div className={styles.publish} data-phone-published={published ? "on" : "off"}>
            <span className={styles.dim}>{published ? PHONE_PANEL_PUBLISHED : PHONE_PANEL_UNPUBLISHED}</span>
            <Button variant="outline" onClick={() => panel.publish(!published)}>{published ? "Stop publishing" : "Publish"}</Button>
          </div>
        )}
        {door.pending && !open ? <p className={styles.dim}>Opening…</p> : null}
        {state !== null && !state.open && !door.pending ? (
          <div className={styles.section}>
            <p className={styles.reason} data-phone-reason>{state.reason}</p>
            {door.awaitingHelper ? <p className={styles.dim} data-phone-awaiting>{PHONE_AWAITING_HELPER}</p> : null}
            <Button variant="outline" onClick={door.open}>Try again</Button>
          </div>
        ) : null}
        {open ? (
          <div className={styles.section}>
            <FirewallNote block={state.firewall} />
            <PhoneQr text={state.url} />
            <p className={styles.dim}>{PHONE_SCAN_HINT}</p>
            <code className={styles.url} data-phone-url>{state.url}</code>
            <p className={styles.meta}>
              certificate <code title={state.fingerprint}>{shortFingerprint(state.fingerprint)}</code>
            </p>
            {door.publishedPanels === 0 ? <p className={styles.warn}>{PHONE_NOTHING_PUBLISHED}</p> : null}
            <p className={styles.meta}>
              {state.phones.length === 0 ? "no phones connected" : `${state.phones.length} connected`}
            </p>
            {state.phones.length > 0 ? (
              <ul className={styles.phones}>
                {state.phones.map((peer) => {
                  // T1397b: which of them is sending its camera, and under what name.
                  const camera = door.cameras?.find((each) => each.phone === peer.phone);
                  return (
                    <li key={peer.phone} title={peer.userAgent} data-phone-camera={camera?.state}>
                      {phoneLabel(peer.userAgent)}
                      {camera === undefined ? null : <span className={styles.camera}> · {phoneCameraLine(camera)}</span>}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <Button variant="danger" onClick={door.close} disabled={door.pending}>Close door</Button>
          </div>
        ) : null}
        {door.refusal !== null ? (
          <div className={styles.refusal} data-phone-refusal>
            <span>{door.refusal.reason}</span>
            <Button onClick={door.dismissRefusal}>Dismiss</Button>
          </div>
        ) : null}
      </PopoverContent>
    </PopoverRoot>
  );
}
