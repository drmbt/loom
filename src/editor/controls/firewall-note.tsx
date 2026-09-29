import { firewallAllowCommands, type PhoneFirewallBlock } from "@devices/phone/phone-protocol.ts";
import { PHONE_FIREWALL_BLOCKED } from "./phone-door-copy.ts";
import styles from "./phone-door.module.css";

/**
 * T1511b — the Phone popover's note when the helper measured the macOS firewall refusing
 * it: one sentence, then the two commands for the person to run, each selectable whole.
 * Nothing when there is no block (including when the helper could not tell).
 */
export function FirewallNote({ block }: { readonly block: PhoneFirewallBlock | undefined }) {
  if (block === undefined) return null;
  return (
    <div className={styles.section} data-phone-firewall={block.binary}>
      <p className={styles.warn}>{PHONE_FIREWALL_BLOCKED}</p>
      {firewallAllowCommands(block.binary).map((command) => (
        <code key={command} className={styles.url}>{command}</code>
      ))}
    </div>
  );
}
