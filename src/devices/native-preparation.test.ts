// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARIGOLD_BUNDLE_ID, MARIGOLD_MODEL_ID } from "../domain/media/photo-depth-recipe.ts";
import { hasNativePreparation, probeNativePreparation, runNativePreparation, type NativePreparationRequest } from "./native-preparation.ts";

const request = (): NativePreparationRequest => ({ modelId: MARIGOLD_MODEL_ID, inputSide: 512, seed: 2025,
  width: 512, height: 256, rgba: new ArrayBuffer(512 * 256 * 4) });
const output = () => ({ width: 512, height: 256, values: new Float32Array(512 * 256).fill(0.25).buffer, semantics: "relative-log" });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
function harness() {
  const bridge = { probe: vi.fn(async () => ({ available: true, cached: false, bundleId: MARIGOLD_BUNDLE_ID,
    bytes: 12_000_000_000, backend: "mlx", inputSides: [512, 768, 1024] })),
  start: vi.fn<(request: NativePreparationRequest) => Promise<string>>(async () => "job1"),
  status: vi.fn<(id: string) => Promise<unknown>>(async () => ({ kind: "complete", result: output() })),
  cancel: vi.fn<(id: string) => Promise<void>>(async () => {}), close: vi.fn<(id: string) => Promise<void>>(async () => {}) };
  (window as Window & { loomDesktop?: unknown }).loomDesktop = { preparation: bridge };
  return bridge;
}
afterEach(() => {
  delete (window as Window & { loomDesktop?: unknown }).loomDesktop;
  vi.useRealTimers();
});

describe("native static preparation renderer ownership", () => {
  it("reports Desktop required in browser and never starts during probing", async () => {
    expect(hasNativePreparation()).toBe(false);
    expect(await probeNativePreparation()).toEqual({ available: false, reason: "Marigold native preparation requires the Loom desktop app." });
    await expect(runNativePreparation(request(), vi.fn(), new AbortController().signal)).rejects.toThrow(/desktop app/);
    const bridge = harness();
    expect(hasNativePreparation()).toBe(true);
    expect(await probeNativePreparation()).toMatchObject({ available: true, backend: "mlx", inputSides: [512, 768, 1024] });
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("diagnoses partial bridge and malformed capabilities explicitly", async () => {
    (window as Window & { loomDesktop?: unknown }).loomDesktop = { preparation: { probe() {} } };
    expect(() => hasNativePreparation()).toThrow(/bridge is incomplete/);
    await expect(probeNativePreparation()).rejects.toThrow(/bridge is incomplete/);
    await expect(runNativePreparation(request(), vi.fn(), new AbortController().signal)).rejects.toThrow(/bridge is incomplete/);
    const bridge = harness();
    bridge.probe.mockResolvedValue({ available: true } as never);
    await expect(probeNativePreparation()).rejects.toThrow(/bundle, runtime or supported sizes/);
    bridge.probe.mockResolvedValue({ available: false, reason: "Worker not installed" } as never);
    expect(await probeNativePreparation()).toEqual({ available: false, reason: "Worker not installed" });
  });

  it("returns the raw float32 prediction only after the owned job closes", async () => {
    const bridge = harness(), retirement = deferred<void>();
    bridge.close.mockReturnValue(retirement.promise);
    const running = runNativePreparation(request(), vi.fn(), new AbortController().signal);
    await vi.waitFor(() => expect(bridge.close).toHaveBeenCalledWith("job1"));
    let complete = false; void running.then(() => { complete = true; });
    expect(complete).toBe(false);
    retirement.resolve();
    const result = await running;
    expect(result.semantics).toBe("relative-log");
    expect(new Float32Array(result.values)[123]).toBe(0.25);
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it("polls real stage and measured download progress every 250 ms", async () => {
    vi.useFakeTimers();
    const bridge = harness(), progress = vi.fn();
    bridge.status.mockResolvedValueOnce({ kind: "running", progress: { phase: "downloading", message: "Downloading…", fraction: 0.3 } });
    const running = runNativePreparation(request(), progress, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledWith({ phase: "downloading", message: "Downloading…", fraction: 0.3 });
    expect(bridge.status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249); expect(bridge.status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await running;
    expect(bridge.status).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort during an outstanding status waits for process retirement and discards late results", async () => {
    const bridge = harness(), status = deferred<unknown>(), retirement = deferred<void>(), abort = new AbortController();
    bridge.status.mockReturnValue(status.promise); bridge.cancel.mockReturnValue(retirement.promise);
    const running = runNativePreparation(request(), vi.fn(), abort.signal);
    const assertion = expect(running).rejects.toThrow("User cancelled");
    await vi.waitFor(() => expect(bridge.status).toHaveBeenCalled());
    abort.abort(new Error("User cancelled"));
    await vi.waitFor(() => expect(bridge.cancel).toHaveBeenCalledWith("job1"));
    expect(bridge.close).not.toHaveBeenCalled();
    status.resolve({ kind: "complete", result: output() });
    retirement.resolve(); await assertion;
    expect(bridge.close).toHaveBeenCalledWith("job1");
  });

  it("abort during start acquires its identifier before cancelling and closing", async () => {
    const bridge = harness(), started = deferred<string>(), abort = new AbortController();
    bridge.start.mockReturnValue(started.promise);
    const running = runNativePreparation(request(), vi.fn(), abort.signal);
    const assertion = expect(running).rejects.toThrow("Closed preparation");
    abort.abort(new Error("Closed preparation")); expect(bridge.cancel).not.toHaveBeenCalled();
    started.resolve("job1"); await assertion;
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.cancel).toHaveBeenCalledWith("job1"); expect(bridge.close).toHaveBeenCalledWith("job1");
  });

  it("abort while polling removes its wait timer and closes the job", async () => {
    vi.useFakeTimers();
    const bridge = harness(), abort = new AbortController();
    bridge.status.mockResolvedValue({ kind: "running", progress: { message: "Predicting…" } });
    const running = runNativePreparation(request(), vi.fn(), abort.signal);
    const assertion = expect(running).rejects.toThrow("Cancelled");
    await vi.advanceTimersByTimeAsync(0); abort.abort(new Error("Cancelled"));
    await vi.advanceTimersByTimeAsync(0); await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(bridge.cancel).toHaveBeenCalledTimes(1); expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: "failed", reason: "Metal allocation failed" }, { kind: "running", progress: { message: "Invalid fraction", fraction: 2 } },
    { kind: "complete", result: { ...output(), width: 256 } },
    { kind: "complete", result: { ...output(), values: new Float32Array(512 * 256).fill(NaN).buffer } },
    { kind: "unknown" },
  ])("retires failed or invalid job responses: %j", async state => {
    const bridge = harness(); bridge.status.mockResolvedValue(state);
    await expect(runNativePreparation(request(), vi.fn(), new AbortController().signal)).rejects.toThrow();
    expect(bridge.cancel).toHaveBeenCalledWith("job1"); expect(bridge.close).toHaveBeenCalledWith("job1");
  });

  it("keeps original failure and cleanup failure diagnostics", async () => {
    const bridge = harness(); bridge.status.mockRejectedValue(new Error("Worker failed"));
    bridge.cancel.mockRejectedValue(new Error("Worker still alive")); bridge.close.mockRejectedValue(new Error("Close failed"));
    await expect(runNativePreparation(request(), vi.fn(), new AbortController().signal)).rejects.toMatchObject({
      name: "AggregateError", errors: [expect.objectContaining({ message: "Worker failed" }),
        expect.objectContaining({ message: "Worker still alive" }), expect.objectContaining({ message: "Close failed" })],
    });
  });

  it.each(["cancel", "close"] as const)("reports retirement failure after abort through %s", async method => {
    const bridge = harness(), status = deferred<unknown>(), abort = new AbortController();
    bridge.status.mockReturnValue(status.promise);
    bridge[method].mockRejectedValue(new Error(`Native ${method} retirement failed`));
    const running = runNativePreparation(request(), vi.fn(), abort.signal);
    const assertion = expect(running).rejects.toMatchObject({ name: "AggregateError",
      message: expect.stringContaining(`Native ${method} retirement failed`),
      errors: [expect.objectContaining({ message: "Operator cancelled" }),
        expect.objectContaining({ message: `Native ${method} retirement failed` })],
    });
    await vi.waitFor(() => expect(bridge.status).toHaveBeenCalled());
    abort.abort(new Error("Operator cancelled"));
    await assertion;
    expect(bridge.close).toHaveBeenCalledWith("job1");
  });

  it("rejects a completed prediction with an aggregate when its single close fails", async () => {
    const bridge = harness();
    bridge.close.mockRejectedValue(new Error("Native child is still alive"));
    await expect(runNativePreparation(request(), vi.fn(), new AbortController().signal)).rejects.toMatchObject({
      name: "AggregateError", message: expect.stringContaining("Native child is still alive"),
      errors: [expect.objectContaining({ message: "Native child is still alive" })],
    });
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it("bounds displayed retirement diagnostics while keeping complete underlying errors", async () => {
    const bridge = harness(), reason = "Worker retirement failed " + "x".repeat(20_000);
    bridge.close.mockRejectedValue(new Error(reason));
    let failure: unknown;
    try { await runNativePreparation(request(), vi.fn(), new AbortController().signal); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    const error = failure as AggregateError;
    expect(error.message.length).toBeLessThanOrEqual(4096);
    expect(error.message).toContain("Worker retirement failed");
    expect(error.errors[0].message).toBe(reason);
  });

  it("validates bounded input and pre-abort before starting a job", async () => {
    const bridge = harness(), abort = new AbortController();
    await expect(runNativePreparation({ ...request(), rgba: new ArrayBuffer(4) }, vi.fn(), abort.signal)).rejects.toThrow(/Invalid native preparation request/);
    abort.abort(new Error("Already closed"));
    await expect(runNativePreparation(request(), vi.fn(), abort.signal)).rejects.toThrow("Already closed");
    expect(bridge.start).not.toHaveBeenCalled(); expect(bridge.close).not.toHaveBeenCalled();
  });
});
