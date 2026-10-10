import { afterEach, expect, it, vi } from "vitest";
import { BOTTOM_UP_TRANSPORTS, createNativeInputSource, type DesktopInputBridge, type NativeInputMetadata } from "./native-input.ts";
afterEach(() => vi.useRealTimers());

function setup(options: { transport?: "syphon" | "ndi" | "spout" } = {}) {
  vi.useFakeTimers();
  let consume!: (frame: VideoFrame, metadata: NativeInputMetadata) => Promise<void>;
  const owned = { close: vi.fn() };
  const frame = { clone: vi.fn(() => owned), close: vi.fn() } as unknown as VideoFrame;
  const bridge: DesktopInputBridge = {
    list: vi.fn(async () => []),
    open: vi.fn(async (_uuid, callback) => { consume = callback; return "session"; }),
    poll: vi.fn(async () => ({ kind: "empty" as const })), close: vi.fn(async () => ({})),
  };
  let size: readonly [number, number] = [1280, 720];
  const report = vi.fn();
  const resize = vi.fn(async (width: number, height: number) => { size = [width, height]; });
  const input = createNativeInputSource(bridge, "uuid", { size: () => size, resize, report, transport: options.transport ?? "ndi" });
  return { input, bridge, owned, frame, resize, report,
    deliver: () => consume(frame, { session: "session", sequence: 1, width: 1920, height: 1080 }) };
}
it("clones the preload frame, adopts full resolution, and releases after synchronous consumers", async () => {
  const h = setup(); await h.input.ready; await h.deliver();
  expect(h.frame.clone).toHaveBeenCalledTimes(1);
  expect(h.resize).toHaveBeenCalledWith(1920, 1080);
  const first = h.input.source.currentFrame();
  expect(first?.image).toBe(h.owned);
  expect(h.input.source.currentFrame()?.image).toBe(h.owned);
  expect(h.owned.close).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(h.owned.close).toHaveBeenCalledTimes(1);
  expect(h.frame.close).not.toHaveBeenCalled();
  expect(h.input.source.currentFrame()).toBeUndefined();
  h.input.dispose(); h.input.dispose();
  expect(h.bridge.close).toHaveBeenCalledTimes(1);
});
it("retains one unconsumed frame while paused and closes it on deletion", async () => {
  const h = setup(); await h.input.ready; await h.deliver();
  const before = vi.mocked(h.bridge.poll).mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.bridge.poll).toHaveBeenCalledTimes(before);
  expect(h.owned.close).not.toHaveBeenCalled();
  h.input.dispose();
  expect(h.owned.close).toHaveBeenCalledTimes(1);
  const calls = vi.mocked(h.bridge.poll).mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.bridge.poll).toHaveBeenCalledTimes(calls);
});
it("reports disconnect as stale and closes the native session without retry", async () => {
  const h = setup(); await h.input.ready;
  vi.mocked(h.bridge.poll).mockRejectedValue(new Error("source disconnected"));
  await vi.advanceTimersByTimeAsync(32);
  expect(h.report).toHaveBeenLastCalledWith(expect.stringMatching(/stale.*disconnected/));
  expect(h.bridge.close).toHaveBeenCalledTimes(1);
});

it("reports offline frames as stale without reopening and clears status on resumed video", async () => {
  const h = setup(); await h.input.ready;
  vi.mocked(h.bridge.poll).mockResolvedValue({ kind: "offline" });
  await vi.advanceTimersByTimeAsync(64);
  expect(h.report).toHaveBeenLastCalledWith(expect.stringMatching(/offline.*stale/));
  expect(h.bridge.close).not.toHaveBeenCalled();
  expect(h.bridge.open).toHaveBeenCalledTimes(1);
  await h.deliver();
  expect(h.report).toHaveBeenLastCalledWith(null);
  expect(h.input.source.currentFrame()).toBeDefined();
  h.input.dispose();
  expect(h.bridge.close).toHaveBeenCalledTimes(1);
});
it("releases a retained renderer frame on navigation without racing main teardown", async () => {
  const h = setup(); await h.input.ready; await h.deliver();
  h.input.releaseForNavigation();
  expect(h.owned.close).toHaveBeenCalledTimes(1);
  expect(h.bridge.close).not.toHaveBeenCalled();
  const calls = vi.mocked(h.bridge.poll).mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.bridge.poll).toHaveBeenCalledTimes(calls);
  expect(h.input.source.currentFrame()).toBeUndefined();
});
it("stops polling an explicitly retired session without a second close", async () => {
  const h = setup(); await h.input.ready;
  vi.mocked(h.bridge.poll).mockResolvedValue({ kind: "closed" });
  await vi.advanceTimersByTimeAsync(32);
  const calls = vi.mocked(h.bridge.poll).mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.bridge.poll).toHaveBeenCalledTimes(calls);
  expect(h.bridge.close).not.toHaveBeenCalled();
  expect(h.report).toHaveBeenLastCalledWith("Native input session closed");
  expect(h.input.source.currentFrame()).toBeUndefined();
});
it("a close before open resolves retires the late session", async () => {
  const h = setup(); h.input.dispose(); await h.input.ready;
  expect(h.bridge.close).toHaveBeenCalledWith("session");
  expect(h.bridge.poll).not.toHaveBeenCalled();
});

it("VNB13: a Syphon source's frames are bottom row first and say so; NDI and Spout frames are top first", async () => {
  // VN85: the native FFGL host's output surface is bottom-first too (an OpenGL render target).
  expect([...BOTTOM_UP_TRANSPORTS]).toEqual(["syphon", "ffgl"]);
  const syphon = setup({ transport: "syphon" }); await syphon.input.ready; await syphon.deliver();
  expect(syphon.input.source.currentFrame()).toMatchObject({ image: syphon.owned, flipY: true });
  syphon.input.dispose();
  for (const transport of ["ndi", "spout"] as const) {
    const other = setup({ transport }); await other.input.ready; await other.deliver();
    expect(other.input.source.currentFrame()?.flipY).toBeUndefined();
    other.input.dispose();
  }
});
