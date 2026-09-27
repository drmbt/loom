import { describe, expect, it } from "vitest";
import { performWindowName, physicalSize, placementFeatures, resolveScreen } from "./perform-screens.ts";
import type { ScreenInfo } from "./perform-screens.ts";

/**
 * §T1391b — which display a Window Out's stored Screen means, and where the popup goes.
 * Asserted on what the app hands `window.open` and what Match screen writes.
 */

const screen = (label: string, left: number, extra: Partial<ScreenInfo> = {}): ScreenInfo => ({
  label,
  left,
  top: 0,
  width: 1920,
  height: 1080,
  availLeft: left,
  availTop: 25,
  availWidth: 1920,
  availHeight: 1055,
  devicePixelRatio: 1,
  isPrimary: left === 0,
  isInternal: false,
  ...extra,
});

const laptop = screen("Built-in Retina Display", 0, { width: 1512, height: 982, devicePixelRatio: 2 });
const projector = screen("EPSON PJ", 1512);
const panel = screen("DELL U2720Q", 3432, { width: 2560, height: 1440 });

describe("a stored Screen resolves to a display", () => {
  it("matches a label exactly", () => {
    expect(resolveScreen([laptop, projector, panel], "DELL U2720Q", laptop)).toEqual({ screen: panel, warning: undefined });
  });

  it("Auto prefers a screen that is NOT the editor's — the projector, not the laptop", () => {
    expect(resolveScreen([laptop, projector], "", laptop).screen).toBe(projector);
    // Only one screen: that one.
    expect(resolveScreen([laptop], "", laptop).screen).toBe(laptop);
  });

  it("falls back to Auto with a warning when the named display is not connected", () => {
    const resolved = resolveScreen([laptop, projector], "DELL U2720Q", laptop);
    expect(resolved.screen).toBe(projector);
    expect(resolved.warning).toBe('No screen named "DELL U2720Q" is connected; using another screen.');
  });

  it("takes the first of two displays with the same label", () => {
    const twin = screen("EPSON PJ", 4000);
    expect(resolveScreen([laptop, projector, twin], "EPSON PJ", laptop).screen).toBe(projector);
  });
});

describe("Match screen and placement", () => {
  it("writes PHYSICAL pixels: a 1512×982 point display at 2× is 3024×1964", () => {
    expect(physicalSize(laptop)).toEqual([3024, 1964]);
    expect(physicalSize(projector)).toEqual([1920, 1080]);
  });

  it("places the popup on the display's usable area, and asks for fullscreen only when allowed", () => {
    expect(placementFeatures(projector, { fullscreen: false })).toBe("popup=yes,left=1512,top=25,width=1920,height=1055");
    expect(placementFeatures(projector, { fullscreen: true })).toBe("popup=yes,left=1512,top=25,width=1920,height=1055,fullscreen");
    expect(placementFeatures(undefined, { fullscreen: false })).toBe("popup=yes,width=960,height=540");
  });

  it("names each node's window uniquely, in the only alphabet Electron allows for popups", () => {
    const names = ["a_b", "a-b", "A_b", "win1"].map(performWindowName);
    for (const name of names) expect(name).toMatch(/^loom-[a-z0-9-]+$/i);
    expect(new Set(names).size).toBe(4);
    expect(performWindowName("win1")).toBe("loom-perform-77696e31");
  });
});
