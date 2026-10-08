import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { APP_VIEWPORT, addNode, openApp, selectNode } from "./app.ts";

interface CaptureProbe {
  calls: { userActive: boolean; options: unknown }[];
  stops: number[];
  adapterRequests: number;
  failNext: boolean;
  end(index: number): void;
  trackStates(): MediaStreamTrackState[];
}

test.use({ viewport: APP_VIEWPORT });

/** The native chooser is stubbed; video decode, MediaStream tracks and the UI are real. */
async function installCapturePicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: CaptureProbe = {
      calls: [], stops: [], adapterRequests: 0, failNext: false,
      end(index) {
        const capture = captures[index];
        if (capture === undefined) throw new Error(`Missing capture ${index}`);
        // Simulate the browser's Stop sharing: native stop changes readyState, then ended fires.
        capture.nativeStop();
        capture.track.dispatchEvent(new Event("ended"));
      },
      trackStates: () => captures.map(capture => capture.track.readyState),
    };
    const captures: { track: MediaStreamTrack; nativeStop: () => void }[] = [];
    (window as unknown as { screenCaptureProbe: CaptureProbe }).screenCaptureProbe = probe;

    // This spec needs no adapter. Also fail/count any request made through a retained GPU.
    const gpu = navigator.gpu;
    if (gpu !== undefined) Object.defineProperty(gpu, "requestAdapter", {
      configurable: true,
      value: () => {
        probe.adapterRequests++;
        throw new Error("Screen capture UI proof must not request a WebGPU adapter.");
      },
    });
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async (options: DisplayMediaStreamOptions) => {
        probe.calls.push({ userActive: navigator.userActivation.isActive, options: structuredClone(options) });
        if (probe.failNext) {
          probe.failNext = false;
          throw new DOMException("Picker cancelled.", "NotAllowedError");
        }
        const canvas = document.createElement("canvas");
        canvas.width = 64; canvas.height = 32;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("The capture fixture requires Canvas2D.");
        const stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0];
        if (track === undefined) throw new Error("Canvas capture returned no video track.");
        const index = captures.length;
        probe.stops.push(0);
        const nativeStop = track.stop.bind(track);
        let animation = 0;
        let tick = 0;
        const draw = () => {
          context.fillStyle = tick++ % 2 === 0 ? "red" : "blue";
          context.fillRect(0, 0, canvas.width, canvas.height);
          animation = requestAnimationFrame(draw);
        };
        animation = requestAnimationFrame(draw);
        Object.defineProperty(track, "stop", {
          configurable: true,
          value: () => {
            probe.stops[index] = (probe.stops[index] ?? 0) + 1;
            cancelAnimationFrame(animation);
            nativeStop();
          },
        });
        captures.push({ track, nativeStop });
        return stream;
      },
    });
  });
}

function snapshot(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { screenCaptureProbe: CaptureProbe }).screenCaptureProbe;
    return { calls: probe.calls, stops: probe.stops, adapterRequests: probe.adapterRequests, trackStates: probe.trackStates() };
  });
}

async function addScreen(page: Page): Promise<string> {
  const id = await addNode(page, "input", "Screen In");
  await selectNode(page, id);
  await expect(page.getByRole("region", { name: "Screen In", exact: true })).toBeVisible();
  return id;
}

test("Screen In opens only on a gesture and owns stop, ended, cancellation and reshare cleanup", async ({ page }) => {
  await installCapturePicker(page);
  await openApp(page);
  expect((await snapshot(page)).calls).toHaveLength(0);
  const id = await addScreen(page);
  const section = page.getByRole("region", { name: "Screen In", exact: true });
  const status = section.locator("[data-screen-status]");
  await expect(status).toHaveAttribute("data-screen-status", "idle");
  expect((await snapshot(page)).calls).toHaveLength(0);

  await section.getByRole("button", { name: "Share tab/window", exact: true }).click();
  await expect(status).toHaveAttribute("data-screen-status", "sharing");
  await expect.poll(async () => (await snapshot(page)).calls.length).toBe(1);
  await section.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await expect(status).toHaveAttribute("data-screen-status", "idle");
  expect((await snapshot(page)).stops).toEqual([1]);

  await section.getByRole("button", { name: "Share tab/window", exact: true }).click();
  await expect(status).toHaveAttribute("data-screen-status", "sharing");
  await page.evaluate(() => (window as unknown as { screenCaptureProbe: CaptureProbe }).screenCaptureProbe.end(1));
  await expect(status).toHaveAttribute("data-screen-status", "ended");
  expect((await snapshot(page)).stops).toEqual([1, 1]);

  await page.evaluate(() => { (window as unknown as { screenCaptureProbe: CaptureProbe }).screenCaptureProbe.failNext = true; });
  await section.getByRole("button", { name: "Share again", exact: true }).click();
  await expect(status).toHaveAttribute("data-screen-status", "error");
  await expect(section.getByRole("alert")).toContainText("cancelled or permission was denied");
  expect((await snapshot(page)).stops).toEqual([1, 1]);
  await section.getByRole("button", { name: "Retry sharing", exact: true }).click();
  await expect(status).toHaveAttribute("data-screen-status", "sharing");

  await section.getByRole("button", { name: "Share another", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).stops).toEqual([1, 1, 1, 0]);
  await expect(status).toHaveAttribute("data-screen-status", "sharing");
  // Clicking empty graph space clears selection; select the live node before deleting it.
  await selectNode(page, id);
  await page.keyboard.press("Backspace");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const final = await snapshot(page);
  expect(final.stops).toEqual([1, 1, 1, 1]);
  expect(final.trackStates).toEqual(["ended", "ended", "ended", "ended"]);
  expect(final.calls).toHaveLength(5);
  for (const call of final.calls) {
    expect(call.userActive).toBe(true);
    expect(call.options).toEqual({ video: { frameRate: 30, displaySurface: "browser" }, audio: false, surfaceSwitching: "include" });
  }
  expect(final.adapterRequests).toBe(0);
});

test("restoring a Screen In project never restores permission or opens the picker", async ({ page }) => {
  await installCapturePicker(page);
  await openApp(page);
  const id = await addScreen(page);
  const section = page.getByRole("region", { name: "Screen In", exact: true });
  await section.getByRole("button", { name: "Share tab/window", exact: true }).click();
  await expect(section.locator("[data-screen-status]")).toHaveAttribute("data-screen-status", "sharing");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-save").click();
  const path = await (await downloaded).path();
  if (path === null) throw new Error("Saved Screen In project has no downloaded bytes.");
  const bytes = await readFile(path);
  await section.getByRole("button", { name: "Stop sharing", exact: true }).click();
  expect((await snapshot(page)).stops).toEqual([1]);

  await page.reload();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  expect((await snapshot(page)).calls).toHaveLength(0);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: "screen.loom.json", mimeType: "application/json", buffer: bytes });
  await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
  await selectNode(page, id);
  await expect(section.locator("[data-screen-status]")).toHaveAttribute("data-screen-status", "idle");
  await expect(section.getByRole("button", { name: "Share tab/window", exact: true })).toBeVisible();
  const restored = await snapshot(page);
  expect(restored.calls).toHaveLength(0);
  expect(restored.stops).toEqual([]);
  expect(restored.adapterRequests).toBe(0);
});
