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

export interface PhoneDoorView {
  /** Null until this page first asks for the door. */
  readonly state: PhoneDoorState | null;
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
  "No Panel is published yet, so a phone sees nothing. Turn on Phone on a Panel to publish it.";

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
