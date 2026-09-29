import type { PhoneDoorState } from "@devices/phone/phone-protocol.ts";

/**
 * T1396b — what the controls pane's Phone popover is handed, and the sentences it says.
 *
 * The view is an interface here rather than the hook's return type imported from
 * `src/app`, so the editor does not depend on the composition root; `use-phone-door.ts`
 * satisfies it. The sentences live in a `.ts` beside the component because they ARE
 * sentences (the copy guard keeps prose out of `.tsx` chrome, §V90).
 */

/** The latest refused phone write, and how many have been refused since the last dismiss. */
export interface PhoneRefusal {
  readonly phone: string;
  readonly reason: string;
  readonly count: number;
}

/** T1397b: one phone's camera as the desk hears it (`use-phone-cameras.ts`). */
export interface PhoneCameraView {
  /** The door's id for the phone (`PhonePeer.phone`). */
  readonly phone: string;
  /** The name the phone sends under. */
  readonly name: string;
  readonly state: "connecting" | "live" | "ended";
}

export interface PhoneDoorView {
  /** Null until this page first asks for the door. */
  readonly state: PhoneDoorState | null;
  /** T1397b: which phones are sending a camera. Absent where nothing receives cameras. */
  readonly cameras?: readonly PhoneCameraView[];
  /** An open or close is in flight. */
  readonly pending: boolean;
  /** How many Panels the last snapshot carried — zero means nothing is published. */
  readonly publishedPanels: number;
  readonly refusal: PhoneRefusal | null;
  /** T1495b: asked for while no helper is attached — it opens by itself when one attaches. */
  readonly awaitingHelper: boolean;
  open(): void;
  close(): void;
  dismissRefusal(): void;
}

export const PHONE_NOTHING_PUBLISHED =
  "No Panel is published yet, so a phone sees no controls (it can still send its camera). Press the phone icon on a Panel to publish it.";

/** T1512b — what the Panel's phone icon says about THIS Panel, at the top of its popover. */
export const PHONE_PANEL_PUBLISHED = "This Panel is on the phones.";
export const PHONE_PANEL_UNPUBLISHED = "This Panel is not on the phones.";
export const PHONE_PUBLISH_TITLE = "Phone — publish this Panel and show the QR code";
export const PHONE_PUBLISHED_TITLE = "Phone — this Panel is published; show the QR code";

/** T1512b — a fresh Panel's body, saying the one gesture that fills it. */
export const PANEL_EMPTY_HINT = "Wire a Slider, Toggle, Button or XY Pad here";

/** T1397b: what a phone's line in the popover adds when it is sending its camera. */
export function phoneCameraLine(camera: PhoneCameraView): string {
  switch (camera.state) {
    case "live":
      return `sending camera “${camera.name}”`;
    case "connecting":
      return `camera “${camera.name}” connecting`;
    case "ended":
      return `camera “${camera.name}” stopped`;
  }
}

export const PHONE_AWAITING_HELPER = "Opens by itself once the helper attaches.";

export const PHONE_SCAN_HINT = "Scan with a phone on the same wifi. Accept the certificate once.";

/**
 * The certificate fingerprint, short enough to compare at a glance with what the phone
 * shows: the first four and last two bytes of a colon-separated hex fingerprint, or the
 * first sixteen characters of any other spelling.
 */
export function shortFingerprint(fingerprint: string): string {
  const groups = fingerprint.split(":");
  if (groups.length > 6) return `${groups.slice(0, 4).join(":")}…${groups.slice(-2).join(":")}`;
  return fingerprint.length > 16 ? `${fingerprint.slice(0, 16)}…` : fingerprint;
}

/** How a phone is listed: what its browser called itself, cut to a line. */
export function phoneLabel(userAgent: string): string {
  const said = userAgent.trim();
  if (said === "") return "a phone";
  const device = /\(([^)]*)\)/.exec(said)?.[1]?.split(";")[0]?.trim();
  const label = device !== undefined && device !== "" ? device : said;
  return label.length > 32 ? `${label.slice(0, 32)}…` : label;
}

/** T1511b — above the commands that fix it (`firewallAllowCommands`), which the note shows. */
export const PHONE_FIREWALL_BLOCKED = "The macOS firewall is refusing phones, because this helper's Node is not allowed:";
