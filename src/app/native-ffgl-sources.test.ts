import { expect, it, vi } from "vitest";
import type { LoomBackend, MediaSource } from "@runtime/backend/backend-types.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { createNativeFfglSource, manifestFromDescription } from "@devices/native-ffgl.ts";
import { createNativeFfglSources, ffglFrameRequest, type FfglTarget } from "./native-ffgl-sources.ts";

vi.mock("@devices/native-ffgl.ts", () => ({
  createNativeFfglSource: vi.fn(), desktopFfglBridge: vi.fn(),
  manifestFromDescription: (d: { id: string; name: string; version: string; pluginType: number; parameters: unknown[] }) =>
    JSON.stringify({ format: 1, id: d.id, name: d.name, version: d.version, pluginType: d.pluginType, parameters: d.parameters }),
}));

const frame = (index: number, mode: FrameEvaluationInput["mode"] = "realtime", delta = 1 / 60): FrameEvaluationInput => ({
  frameIndex: index, timeSeconds: index / 60, deltaSeconds: delta, mode, randomSeed: 1, absTimeSeconds: 100 + index / 60,
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const row = (index: number, name: string, type: number) => ({ index, name, type, default: 0, range: { min: 0, max: 1 }, elements: [] });
const DESCRIPTION = { id: "VGNP", name: "VignettePlus", version: "1.1", pluginType: 0, clock: { mode: "host" as const },
  parameters: [row(0, "Size", 10), row(1, "BlackBG", 0), row(2, "Recall", 1)] };
const MANIFEST = manifestFromDescription(DESCRIPTION);

function harness(manifest = MANIFEST) {
  const media = new Map<string, MediaSource>();
  const backend = { registerMediaSource: (id: string, source: MediaSource) => { media.set(id, source); return () => media.delete(id); } } as unknown as LoomBackend;
  const source = { source: { currentFrame: vi.fn(() => undefined) }, ready: Promise.resolve(), available: true, description: DESCRIPTION,
    run: vi.fn(async (request: unknown) => ({ request, session: "s", sequence: 1, width: 4, height: 2, bottomUp: true })), close: vi.fn(async () => {}) };
  vi.mocked(createNativeFfglSource).mockReturnValue(source as never);
  const bridge = { describe: vi.fn(async () => DESCRIPTION) };
  const stored: Array<[string, string]> = [];
  const sources = createNativeFfglSources({ bridge: () => bridge as never, onManifest: (id, text) => stored.push([id, text]) });
  const values: Record<string, unknown> = { size: 0.25, blackBG: true };
  const target: FfglTarget = { nodeId: "ffgl1", plugin: "VignettePlus", manifest, size: [4, 2], inputResourceId: "scratch:ffgl1:ffglInput",
    read: () => ({ bpm: 128, value: key => values[key] as never }) };
  return { sources, source, backend, target, media, bridge, stored, values };
}

it("a frame's request: abs time, the frame interval, the node's writes, and a reset only at a take's first frame", () => {
  expect(ffglFrameRequest(frame(3), 120, [[0, 1]], [2])).toEqual({ time: 100 + 3 / 60, bpm: 120, barPhase: ((100 + 3 / 60) * 2 / 4) % 1,
    interval: 1 / 60, parameters: [[0, 1]], pulses: [2] });
  expect(ffglFrameRequest(frame(0, "offline"), 120, [], []).reset).toBe(true);
  expect(ffglFrameRequest(frame(0, "realtime"), 120, [], []).reset).toBeUndefined();
  expect(ffglFrameRequest(frame(1, "offline", 0), 120, [], []).interval).toBe(1 / 60);
});

it("runs each live frame with the node's resolved values as FFGL writes; an event pulse is raised once", async () => {
  const h = harness(); h.sources.track([h.target], h.backend); await flush();
  expect(createNativeFfglSource).toHaveBeenCalledWith(h.backend, expect.anything(), { plugin: "VignettePlus", size: [4, 2], inputResourceId: "scratch:ffgl1:ffglInput" });
  expect(h.media.get("ffgl:ffgl1")?.currentFrame()?.bytes?.length).toBe(32);
  expect(h.sources.fire(["ffgl1"], "recall")).toBe(1);
  expect(h.sources.fire(["ffgl1"], "size")).toBe(0);
  h.sources.observe(frame(1)); await flush();
  expect(h.source.run).toHaveBeenLastCalledWith(expect.objectContaining({ bpm: 128, parameters: [[0, 0.25], [1, true]], pulses: [2] }));
  h.sources.observe(frame(2)); await flush();
  expect(h.source.run).toHaveBeenLastCalledWith(expect.objectContaining({ pulses: [] }));
  expect(h.stored).toEqual([]);
  h.sources.track([], h.backend); await flush();
  expect(h.source.close).toHaveBeenCalled(); expect(h.media.size).toBe(0);
});

it("offline waits for each frame's result exactly once", async () => {
  const h = harness(); h.sources.track([h.target], h.backend); await flush();
  for (const index of [0, 1, 2]) { h.sources.observe(frame(index, "offline")); await h.sources.settle(index); await h.sources.settle(index); }
  expect(h.source.run).toHaveBeenCalledTimes(3);
  expect(h.source.run.mock.calls[0]![0]).toMatchObject({ reset: true });
  expect(h.source.run.mock.calls[1]![0]).not.toHaveProperty("reset");
});

it("a node whose stored table is not the plugin's gets the probed table stored; a matching one is left alone", async () => {
  const h = harness(""); h.sources.track([h.target], h.backend); await flush();
  expect(h.bridge.describe).toHaveBeenCalledWith("VignettePlus");
  expect(h.stored).toEqual([["ffgl1", MANIFEST]]);
});

it("outside the desktop, or with no plugin named, the node says so and nothing runs", async () => {
  const h = harness();
  const none = createNativeFfglSources({ bridge: () => undefined });
  none.track([h.target], h.backend); await flush();
  expect(none.diagnostics()).toEqual([expect.objectContaining({ code: "ffgl.native.refused", nodeId: "ffgl1", message: expect.stringMatching(/desktop app/) })]);
  h.sources.track([{ ...h.target, plugin: "" }], h.backend); await flush();
  expect(h.sources.diagnostics()[0]?.message).toMatch(/Set Plugin/);
});
