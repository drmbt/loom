import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { firewallRefuses, probeMacFirewall, type FirewallRun } from "./mac-firewall.ts";
import { createPhoneDoor, type PhoneDoorOptions } from "./phone-door.ts";
import { MAC_FIREWALL_TOOL, firewallAllowCommands, type PhoneDoorState } from "./phone-protocol.ts";
import { createDeviceDoors } from "../doors.ts";
import { createDeviceHelper } from "../../mcp/serve.ts";

/**
 * T1511b — THE PHONE DOOR SAYS WHEN THE macOS FIREWALL WILL REFUSE ITS PHONES.
 *
 * The owner's first live test: firewall on, `~/.nvm/.../v24.7.0/bin/node` allowed, the
 * helper running v24.11.1 — every phone "connection refused", and the page silent. The
 * fixtures below are the tool's real output on that machine (2026-09-29), trimmed to the
 * entries that matter; the tool itself is scripted, because what a gate can assert is the
 * verdict over its words, and a real run's answer depends on whose Mac runs the suite.
 */

const RUNNING = "/Users/flo/.nvm/versions/node/v24.11.1/bin/node";
const ALLOWED_OLDER = "/Users/flo/.nvm/versions/node/v24.7.0/bin/node";

const ON = "Firewall is enabled. (State = 1)\n";
const OFF = "Firewall is disabled. (State = 0)\n";

function listApps(entries: ReadonlyArray<readonly [string, "Allow" | "Block"]>): string {
  return (
    `Total number of apps = ${String(entries.length)} \n` +
    entries
      .map(([path, verdict], index) => `${String(index + 1)} : ${path} \n             (${verdict} incoming connections)\n`)
      .join("")
  );
}

/** The owner's list: the older node allowed, the running one absent. */
const OWNERS_LIST = listApps([
  ["/Applications/zoom.us.app/Contents/MacOS/zoom.us", "Allow"],
  [ALLOWED_OLDER, "Allow"],
  ["/usr/sbin/smbd", "Allow"],
]);

/** A scripted `socketfilterfw`: answers per flag, records what it was asked. */
function tool(globalState: string, apps: string): FirewallRun & { readonly asked: string[] } {
  const asked: string[] = [];
  const run = (file: string, args: readonly string[]): Promise<string> => {
    asked.push(`${file} ${args.join(" ")}`);
    if (args[0] === "--getglobalstate") return Promise.resolve(globalState);
    if (args[0] === "--listapps") return Promise.resolve(apps);
    return Promise.reject(new Error(`unexpected ${args.join(" ")}`));
  };
  return Object.assign(run, { asked });
}

const onMac = (run: FirewallRun) => () => probeMacFirewall({ platform: "darwin", binary: RUNNING, run });

describe("T1511b — the firewall verdict", () => {
  it("on, and the running node is not in the list (the owner's case): refused, naming that binary", async () => {
    const run = tool(ON, OWNERS_LIST);
    expect(await onMac(run)()).toEqual({ blocked: true, binary: RUNNING });
    // Read-only: exactly the two questions, never a setting.
    expect(run.asked.sort()).toEqual([`${MAC_FIREWALL_TOOL} --getglobalstate`, `${MAC_FIREWALL_TOOL} --listapps`]);
  });

  it("on, and the running node is listed as allowed: nothing to say", async () => {
    const run = tool(ON, listApps([[ALLOWED_OLDER, "Allow"], [RUNNING, "Allow"]]));
    expect(await onMac(run)()).toBeNull();
  });

  it("on, and the running node is listed as BLOCKED: refused", async () => {
    const run = tool(ON, listApps([[RUNNING, "Block"]]));
    expect(await onMac(run)()).toEqual({ blocked: true, binary: RUNNING });
  });

  it("off: nothing to say, whatever the list", async () => {
    expect(await onMac(tool(OFF, OWNERS_LIST))()).toBeNull();
  });

  it("a tool that fails, or says something unrecognised, is 'cannot tell' — never a warning", async () => {
    const failing: FirewallRun = () => Promise.reject(new Error("spawn ENOENT"));
    expect(await onMac(failing)()).toBeNull();
    expect(await onMac(tool("socketfilterfw: unknown option\n", OWNERS_LIST))()).toBeNull();
    expect(await onMac(tool(ON, "Error: not permitted\n"))()).toBeNull();
  });

  it("not macOS: the tool is never run", async () => {
    const run = tool(ON, OWNERS_LIST);
    expect(await probeMacFirewall({ platform: "linux", binary: RUNNING, run })).toBeNull();
    expect(run.asked).toEqual([]);
  });

  it("matches the path exactly — an allowed OLDER node does not cover the running one", () => {
    expect(firewallRefuses(ON, OWNERS_LIST, ALLOWED_OLDER)).toBe(false);
    expect(firewallRefuses(ON, OWNERS_LIST, RUNNING)).toBe(true);
  });

  it("the commands to allow it name the binary as one shell argument", () => {
    expect(firewallAllowCommands(RUNNING)).toEqual([
      `sudo ${MAC_FIREWALL_TOOL} --add ${RUNNING}`,
      `sudo ${MAC_FIREWALL_TOOL} --unblockapp ${RUNNING}`,
    ]);
    expect(firewallAllowCommands("/Applications/My Node/node")[0]).toBe(
      `sudo ${MAC_FIREWALL_TOOL} --add '/Applications/My Node/node'`,
    );
  });
});

/* ------------------------------------------------------------------ the door itself */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
let certDir = "";
beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "loom-phone-firewall-"));
});
afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

const sink = () => ({ onWrite: () => undefined, onState: () => undefined });

async function openWith(firewall: PhoneDoorOptions["firewall"]): Promise<PhoneDoorState> {
  const door = createPhoneDoor({ lanAddress: () => "127.0.0.1", port: 0, certDir, ...(firewall ? { firewall } : {}) });
  cleanups.push(() => door.dispose());
  const state = await door.open(sink());
  expect(door.state()).toEqual(state);
  return state;
}

describe("T1511b — the door's opened state carries the verdict", () => {
  it("on + not allowed: the door OPENS (the Mac itself can still reach it) and its state names the binary", async () => {
    const state = await openWith(onMac(tool(ON, OWNERS_LIST)));
    expect(state.open).toBe(true);
    expect(state.open && state.firewall).toEqual({ blocked: true, binary: RUNNING });
  });

  it("on + allowed, and off: an open door with no firewall field at all", async () => {
    const allowed = await openWith(onMac(tool(ON, listApps([[RUNNING, "Allow"]]))));
    expect(allowed.open).toBe(true);
    expect(allowed.open && "firewall" in allowed).toBe(false);
    const off = await openWith(onMac(tool(OFF, OWNERS_LIST)));
    expect(off.open && "firewall" in off).toBe(false);
  });

  it("a probe that rejects or throws never stops the door opening, and says nothing", async () => {
    const rejected = await openWith(() => Promise.reject(new Error("probe exploded")));
    expect(rejected.open).toBe(true);
    expect(rejected.open && "firewall" in rejected).toBe(false);
    const thrown = await openWith(() => {
      throw new Error("probe threw before it returned a promise");
    });
    expect(thrown.open).toBe(true);
    expect(thrown.open && "firewall" in thrown).toBe(false);
  });

  it("reaches the page over the device bridge in `phoneOpened`", async () => {
    const handoffDir = mkdtempSync(join(tmpdir(), "loom-phone-firewall-helper-"));
    const helper = createDeviceHelper({
      port: 0,
      handoffDir,
      doors: createDeviceDoors({
        udpSocketFactory: () => {
          throw new Error("no UDP in this test");
        },
        phone: { enabled: true, lanAddress: () => "127.0.0.1", port: 0, certDir, firewall: onMac(tool(ON, OWNERS_LIST)) },
      }),
    });
    cleanups.push(() => {
      helper.dispose();
      rmSync(handoffDir, { recursive: true, force: true });
    });
    await until(() => helper.status().port != null, "the helper to bind");
    const socket = new WebSocket(`ws://127.0.0.1:${String(helper.status().port)}`);
    const received: Array<Record<string, unknown>> = [];
    socket.onmessage = (event: MessageEvent) => received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("the device socket did not open"));
    });
    cleanups.push(() => socket.close());
    socket.send(JSON.stringify({ type: "deviceAttach", code: helper.pairingCode, client: "firewall gate" }));
    await until(() => received.some((message) => message["type"] === "deviceAttached"), "deviceAttached");
    socket.send(JSON.stringify({ type: "phoneOpen", id: 1 }));
    await until(() => received.some((message) => message["type"] === "phoneOpened"), "phoneOpened");
    const state = received.find((message) => message["type"] === "phoneOpened")?.["state"] as PhoneDoorState;
    expect(state.open && state.firewall).toEqual({ blocked: true, binary: RUNNING });
  });
});

async function until(predicate: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
