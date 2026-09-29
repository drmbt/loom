// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAC_FIREWALL_TOOL, type PhoneDoorState } from "@devices/phone/phone-protocol.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { PhoneDoorButton } from "./phone-door.tsx";
import { PHONE_FIREWALL_BLOCKED, type PhoneDoorView } from "./phone-door-copy.ts";

/**
 * T1511b — the Phone popover, on a door the helper measured the macOS firewall refusing:
 * the one sentence and the two commands a person runs, as text they can select and copy.
 * On a door with no block, none of it.
 */
installDomStubs();
afterEach(cleanup);

const BINARY = "/Users/flo/.nvm/versions/node/v24.11.1/bin/node";
const OPEN: PhoneDoorState = { open: true, url: "https://192.168.1.146:43920/?t=abc", fingerprint: "AA:BB", phones: [] };

function view(state: PhoneDoorState): PhoneDoorView {
  return {
    state,
    pending: false,
    publishedPanels: 1,
    refusal: null,
    awaitingHelper: false,
    open: () => undefined,
    close: () => undefined,
    dismissRefusal: () => undefined,
  };
}

async function openPopover(state: PhoneDoorState): Promise<void> {
  render(<PhoneDoorButton door={view(state)} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
    await Promise.resolve();
  });
}

describe("T1511b — the firewall note in the Phone popover", () => {
  it("a blocked door shows the sentence and both commands for the running binary, selectable whole", async () => {
    await openPopover({ ...OPEN, firewall: { blocked: true, binary: BINARY } });
    expect(screen.getByText(PHONE_FIREWALL_BLOCKED)).not.toBeNull();
    const commands = [...document.querySelectorAll(`[data-phone-firewall] code`)];
    expect(commands.map((code) => code.textContent)).toEqual([
      `sudo ${MAC_FIREWALL_TOOL} --add ${BINARY}`,
      `sudo ${MAC_FIREWALL_TOOL} --unblockapp ${BINARY}`,
    ]);
    // The QR is still there: the door is open, only the LAN cannot reach it yet.
    expect(document.querySelector("svg[data-phone-qr]")).not.toBeNull();
  });

  it("an open door with no block says nothing about the firewall", async () => {
    await openPopover(OPEN);
    expect(document.querySelector("svg[data-phone-qr]")).not.toBeNull();
    expect(document.querySelector("[data-phone-firewall]")).toBeNull();
    expect(screen.queryByText(PHONE_FIREWALL_BLOCKED)).toBeNull();
  });
});
