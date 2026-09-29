import { useMemo, useState } from "react";
import { Button, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@ui/index.ts";
import { encodeQr, qrToSvgPath } from "@devices/phone/qr.ts";
import {
  PHONE_AWAITING_HELPER,
  PHONE_NOTHING_PUBLISHED,
  PHONE_SCAN_HINT,
  phoneLabel,
  shortFingerprint,
  type PhoneDoorView,
} from "./phone-door-copy.ts";
import styles from "./phone-door.module.css";

/**
 * T1396b — the controls pane's Phone button and its popover: open the door, show the QR
 * code a phone scans, the address as text for one that cannot scan, the certificate's
 * fingerprint to compare with what the phone is asked to accept, and who is connected.
 * A door the helper refused shows the helper's own sentence; nothing is paraphrased.
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

export function PhoneDoorButton({ door }: { readonly door: PhoneDoorView }) {
  const [shown, setShown] = useState(false);
  const state = door.state;
  const open = state?.open === true;
  return (
    <PopoverRoot
      open={shown}
      onOpenChange={(next) => {
        setShown(next);
        if (next && !open && !door.pending) door.open();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" aria-pressed={open} data-phone-door={open ? "open" : "closed"}>
          Phone{open && state.phones.length > 0 ? ` · ${state.phones.length}` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent className={styles.popover} aria-label="Phone door">
        <PopoverHeader>Phone door</PopoverHeader>
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
                {state.phones.map((peer) => (
                  <li key={peer.phone} title={peer.userAgent}>{phoneLabel(peer.userAgent)}</li>
                ))}
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
