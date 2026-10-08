import { expect, test, type Page } from "@playwright/test";
import type { PerformWindowHandle } from "../../app/perform-window.ts";

// No GPU fixture: this exercises the production window adapter and Chromium's actual
// activation/permission rules. The full browser stays headless; no desktop window opens.
test.use({ channel: "chromium" });

async function prepare(page: Page, fullscreen: boolean): Promise<void> {
  await page.route("**/__perform-test", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><button id="open">Open perform window</button>',
  }));
  await page.goto("/__perform-test");
  await page.evaluate(async (wantFullscreen) => {
    const modulePath = "/src/app/perform-window.ts";
    const { openPerformWindow, browserPerformOpener } = await import(modulePath) as typeof import("../../app/perform-window.ts");
    const host = window as unknown as { performHandle: PerformWindowHandle | null };
    document.querySelector<HTMLButtonElement>("#open")!.onclick = () => {
      host.performHandle = openPerformWindow({
        open: browserPerformOpener(window), parent: window,
        present: () => { throw new Error("No presentation target in this fullscreen fixture"); },
      }, {
        nodeId: "window_test", name: "loom-perform-test", title: "Loom fullscreen test",
        features: `popup=yes,width=640,height=360${wantFullscreen ? ",fullscreen" : ""}`,
        outputId: undefined, fullscreen: wantFullscreen, hideCursor: true,
        onClosed: () => {}, onMappingKey: () => false, onFullscreenChanged: () => {},
      });
    };
  }, fullscreen);
}

test("a refused automatic fullscreen request is visible and a child click enters fullscreen", async ({ page }) => {
  await prepare(page, true);
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open perform window" }).click();
  const child = await opened;
  await expect(child.getByRole("button", { name: "Enter fullscreen", exact: true })).toBeVisible();
  expect(await child.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { performHandle: PerformWindowHandle }).performHandle.fullscreenMessage)).toContain("refused");
  await child.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect.poll(() => child.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(child.locator("[data-perform-fullscreen-notice]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { performHandle: PerformWindowHandle }).performHandle.fullscreenMessage)).toBeNull();
  await child.close();
});

test("automatic fullscreen enters without a child click when the browser permission allows it", async ({ page, context }) => {
  await prepare(page, true);
  const session = await context.newCDPSession(page);
  const browserContextId = (await session.send("Target.getTargetInfo")).targetInfo.browserContextId;
  if (browserContextId === undefined) throw new Error("Fullscreen permission test needs its isolated browser context");
  await session.send("Browser.setPermission", {
    permission: { name: "fullscreen", allowWithoutGesture: true },
    setting: "granted", origin: new URL(page.url()).origin, browserContextId,
  });
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open perform window" }).click();
  const child = await opened;
  await expect.poll(() => child.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(child.locator("[data-perform-fullscreen-notice]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { performHandle: PerformWindowHandle }).performHandle.fullscreenMessage)).toBeNull();
  await child.close();
});

test("a windowed perform request remains windowed", async ({ page }) => {
  await prepare(page, false);
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open perform window" }).click();
  const child = await opened;
  expect(await child.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  await expect(child.locator("[data-perform-fullscreen-notice]")).toHaveCount(0);
  await child.close();
});
