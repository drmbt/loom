import { expect, test } from "@playwright/test";

/**
 * §V23 ON A REAL BROWSER GPU: A LOST DEVICE IS REBUILT AND THE LIVE LOOP DRAWS AGAIN.
 *
 * T1705b: vgpu 0.6.0 changed loss handling (`gpu.lost`, and a frame loop stops when its
 * device is lost). The backend's own path — halt, report, rebuild, restart the loops — was
 * covered on the mock device only, which loses a device by calling a function the browser
 * does not have. Here the device is the browser's, and it is lost the way a page can lose
 * one: `GPUDevice.destroy()`. The claim is what a user sees: the loop keeps submitting
 * frames on a NEW device, and the picture it reads back is the picture from before the loss.
 */
test("a destroyed device is rebuilt and the running loop renders the same picture again", async ({ page }) => {
  // An isolated module page: no editor competes for the device.
  await page.goto("/experiments/canvas-export/");
  const result = await page.evaluate(async () => {
    const devices: GPUDevice[] = [];
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
      const device = await request.call(this, descriptor);
      devices.push(device);
      return device;
    };
    const backendPath = "/src/runtime/backend/index.ts";
    const wgslPath = "/src/runtime/backend/wgsl.ts";
    const { createVgpuBackend, browserGpuHost } = await import(/* @vite-ignore */ backendPath) as typeof import("../../runtime/backend/index.ts");
    const { wgsl } = await import(/* @vite-ignore */ wgslPath) as typeof import("../../runtime/backend/wgsl.ts");
    const backend = createVgpuBackend({ host: browserGpuHost() });
    const codes: string[] = [];
    backend.onDiagnostic((d) => { if (d.severity === "error") codes.push(`${d.code} ${d.message}`.slice(0, 200)); });
    await backend.initialize({});
    const plan = await backend.compile({
      resources: [{ kind: "target", id: "output", size: [16, 16], format: "rgba8unorm" }],
      passes: [{ kind: "effect", id: "paint", target: "output",
        shader: wgsl`@fragment fn fs() -> @location(0) vec4f { return vec4f(0.25, 0.5, 0.75, 1.0); }` }],
      diagnostics: [],
    } as never);
    const input = { frame: { frameIndex: 0, timeSeconds: 0, deltaSeconds: 1 / 60, mode: "realtime" as const, randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 }, resolution: [16, 16] as const };
    let ticks = 0;
    const loop = backend.loop(() => { ticks += 1; backend.render(plan, input); });
    const until = async (predicate: () => boolean, what: string) => {
      const deadline = performance.now() + 10_000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    };
    try {
      await until(() => ticks >= 5, "the loop's first frames");
      const before = Array.from((await backend.readOutput("output")).bytes.subarray(0, 4));
      const generation = backend.status.deviceGeneration;

      devices[0]!.destroy();
      await until(() => backend.status.deviceGeneration > generation, "the rebuilt device");
      const submitted = backend.status.framesSubmitted;
      await until(() => backend.status.framesSubmitted >= submitted + 5, "frames on the rebuilt device");
      const after = Array.from((await backend.readOutput("output")).bytes.subarray(0, 4));
      return { before, after, devices: devices.length, codes };
    } finally {
      loop.stop();
      backend.dispose();
    }
  });
  // 0.25 / 0.5 / 0.75 in an rgba8unorm target: 64, 128, 191 (round to nearest), alpha 255.
  expect(result.before).toEqual([64, 128, 191, 255]);
  expect(result.after).toEqual(result.before);
  // A second device was requested, and the loss was reported, once, as the only error: no
  // halt, and no failed pass (a timer readback the loss drops is a warning, T1705b).
  expect(result.devices).toBe(2);
  expect(result.codes.filter((code) => code.startsWith("backend/device-lost"))).toHaveLength(1);
  expect(result.codes.filter((code) => !code.startsWith("backend/device-lost"))).toEqual([]);
});
