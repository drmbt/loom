import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

import { MAC_FIREWALL_TOOL, type PhoneFirewallBlock } from "./phone-protocol.ts";

/**
 * T1511b — IS THE macOS APPLICATION FIREWALL GOING TO REFUSE THE PHONES?
 *
 * The owner's first live test: the door listened on the LAN and answered from the Mac
 * itself, and every phone got "connection refused". The firewall was on and allowed an
 * older nvm `node`; the helper ran a newer one, so the LAN never reached the door. Nothing
 * on the page said so. This asks, read-only, and the popover says it.
 *
 * ## What is asked, and why not `--getappblocked`
 *
 * Measured on macOS 26 (2026-09-29), without sudo:
 *
 *   --getglobalstate  → "Firewall is enabled. (State = 1)"   (0 off, 1 on, 2 block-all)
 *   --listapps        → "N : <path> \n\t(Allow incoming connections)" per entry
 *   --getappblocked X → "Incoming connection to X is permitted." for EVERY X not listed
 *                       as blocked — including a binary missing from the list, which is
 *                       exactly the one the firewall refused, and a path that does not
 *                       exist. So it cannot tell the owner's case apart and is not used.
 *
 * The verdict is therefore: on, and the binary is not listed as allowed. Listed as blocked
 * and not listed at all are the same answer — both refuse.
 *
 * ## It never gets in the door's way
 *
 * Not macOS → not asked. The tool missing, failing, slow (2 s each) or saying something
 * this parser does not recognise → no warning. A warning that is wrong sends someone to
 * run sudo for nothing; a missing one leaves them where they were before T1511b.
 */

/** Runs a command and resolves its stdout. Injectable so a gate can script the tool. */
export type FirewallRun = (file: string, args: readonly string[]) => Promise<string>;

export interface MacFirewallProbeOptions {
  /** Default `process.platform`. Anything but `darwin` is never probed. */
  readonly platform?: NodeJS.Platform;
  /** The executable the phones must reach. Default `process.execPath`, symlinks resolved. */
  readonly binary?: string;
  readonly run?: FirewallRun;
}

const PROBE_TIMEOUT_MS = 2_000;

const execRun: FirewallRun = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error === null) resolve(String(stdout));
      else reject(error);
    });
  });

function helperBinary(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/**
 * The block, when the firewall was measured refusing `binary`; null otherwise — including
 * every way of not knowing. Never rejects.
 */
export async function probeMacFirewall(options: MacFirewallProbeOptions = {}): Promise<PhoneFirewallBlock | null> {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const run = options.run ?? execRun;
  const binary = options.binary ?? helperBinary();
  try {
    const [globalState, apps] = await Promise.all([
      run(MAC_FIREWALL_TOOL, ["--getglobalstate"]),
      run(MAC_FIREWALL_TOOL, ["--listapps"]),
    ]);
    return firewallRefuses(globalState, apps, binary) ? { blocked: true, binary } : null;
  } catch {
    return null;
  }
}

/** The pure verdict over the tool's two outputs. Unrecognised output is "does not refuse". */
export function firewallRefuses(globalState: string, listApps: string, binary: string): boolean {
  const state = /\(State = (\d)\)/.exec(globalState)?.[1];
  if (state === undefined || state === "0") return false;
  // An empty list reads "Total number of apps = 0"; anything without that header is not
  // an answer this parser understands.
  if (!/Total number of apps = \d+/.test(listApps)) return false;
  return listedAs(listApps, binary) !== "allow";
}

/** How `--listapps` lists `binary`: its path on one line, the verdict on the next. */
function listedAs(listApps: string, binary: string): "allow" | "block" | null {
  const lines = listApps.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const path = /^\s*\d+\s*:\s*(.*?)\s*$/.exec(lines[index] ?? "")?.[1];
    if (path !== binary) continue;
    const verdict = lines[index + 1] ?? "";
    if (/\(Allow incoming connections\)/.test(verdict)) return "allow";
    if (/\(Block incoming connections\)/.test(verdict)) return "block";
  }
  return null;
}
