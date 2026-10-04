// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as React from "react";
// Expose a configurable module boundary for the state-dispatch allocation probe;
// all hooks still delegate to the real React implementation.
vi.mock("react", async () => ({ ...await vi.importActual<typeof React>("react") }));
import { DEVICE_HELPER_COMMAND } from "@devices/helper.ts";

import type { GraphDocument } from "../domain/types/graph.ts";
import type { CompiledGraph } from "../compiler/index.ts";
import type { DeviceClient } from "@devices/device-client.ts";
import type { VisionOutcome } from "@devices/device-protocol.ts";
import type { LoomBackend } from "../runtime/backend/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { buildMorphIndex } from "@domain/presets/morph-index.ts";
import { presetBankNode, presetSession } from "@domain/presets/test-support.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import {
  maskCoverage,
  maskToFloats,
  texelsToRgbaBase64,
  useVisionBridge,
} from "./use-vision-bridge.ts";
import { NO_FLATTENING } from "@domain/parameters/index.ts";

const registry = createNodeRegistry(allNodeDefinitions).view();
/** What the node's own parameters are read with: the real catalogue, no channels, no fade. */
const READS = { registry, channels: () => undefined, flattening: () => NO_FLATTENING };

/**
 * T1029 — the Person Mask CPU half, per path and by mechanism (the laser pump's
 * discipline applied to a reader): the no-helper path is asserted behaviourally
 * (nothing crosses, the diagnostic says what to do), the ONE firing path is asserted
 * to the exact bytes on the wire AND the exact floats published back, and §V856's
 * coverage scalar is pinned so "found nobody" can never again be confused with
 * "did not run".
 */

describe("T1029 — the pure halves, exact", () => {
  it("texels cross as clamped RGBA8, base64 — the wire's own shape", () => {
    // 0.5 → 128 (round), out-of-range clamps, NaN-free by construction upstream (G4's
    // cousin lives in the preprocess; this is just the byte conversion).
    const texels = new Float32Array([0, 1, 0.5, 2, -1, 0.25, 1, 1]);
    const decoded = Uint8Array.from(atob(texelsToRgbaBase64(texels)), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([0, 255, 128, 255, 0, 64, 255, 255]);
  });

  it("maskToFloats undoes the letterbox: only the centred band maps onto the picture", () => {
    // A 4×4 mask for a 2:1 picture: the picture occupies the middle 4×2 band. Rows 0
    // and 3 are letterbox padding and must never reach the output.
    const mask = new Uint8Array([
      9, 9, 9, 9,
      255, 0, 255, 0,
      0, 255, 0, 255,
      9, 9, 9, 9,
    ]);
    const out = maskToFloats(mask, 4, 4, 4, 2);
    expect([...out]).toEqual([1, 0, 1, 0, 0, 1, 0, 1]);
  });

  it("coverage counts the confident fraction from the result's own bytes (§V856)", () => {
    const floats = new Float32Array([0, 0.4, 0.6, 1]);
    const bytes = new Uint8Array(floats.buffer);
    expect(maskCoverage(bytes)).toBe(0.5);
    expect(maskCoverage(new Uint8Array(new Float32Array(4).buffer))).toBe(0);
  });
});

/* ------------------------------------------------------------------ the hook */

it("unchanged native diagnostics do not enqueue React updates on every frame", () => {
  const original = React.useState, setters: ReturnType<typeof vi.fn>[] = [];
  const spy = vi.spyOn(React, "useState").mockImplementation(((value?: unknown) => {
    const [state, set] = original(value), setter = vi.fn(set);
    setters.push(setter); return [state, setter];
  }) as typeof React.useState);
  try {
    const view = renderHook(() => useVisionBridge({ ...READS, deviceClient: () => null }));
    setters.forEach(setter => setter.mockClear());
    act(() => { for (let index = 0; index < 60; index++) view.result.current.observe({
      frameIndex: index, timeSeconds: index / 60, deltaSeconds: 1 / 60, mode: "offline", randomSeed: 1,
    }); });
    expect(setters.reduce((sum, setter) => sum + setter.mock.calls.length, 0)).toBe(0);
    view.unmount();
  } finally { spy.mockRestore(); }
});

const graph = {
  revision: 1,
  nodes: {
    mask: { id: "mask", type: "personMask", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "mask1" },
  },
  edges: {},
  groups: {},
} as unknown as GraphDocument;

/** The plan allocated the node: result external sized 4×2, input buffer present. */
const compiled = {
  resources: [
    { id: "scratch:mask:modelResult", size: [4, 2] },
    { id: "scratch:mask:modelInput", size: [512, 512] },
  ],
} as unknown as CompiledGraph;

function fakeClient(outcome: VisionOutcome) {
  const requests: Array<{ width: number; height: number; rgbaBase64: string }> = [];
  const client = {
    vision: (request: { width: number; height: number; rgbaBase64: string }) => {
      requests.push(request);
      return Promise.resolve(outcome);
    },
  } as unknown as DeviceClient;
  return { client, requests };
}

function fakeBackend(texels: Float32Array) {
  const registered = new Map<string, { currentFrame(): { frameId: number; bytes: Uint8Array } | undefined }>();
  const backend = {
    readBuffer: () => Promise.resolve(texels.buffer),
    registerMediaSource: (id: string, source: never) => {
      registered.set(id, source);
      return () => registered.delete(id);
    },
  } as unknown as LoomBackend;
  return { backend, registered };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const frame = { frameIndex: 1, timeSeconds: 0.1, deltaSeconds: 1 / 60, mode: "realtime", randomSeed: 7 } as never;

describe("T1029 — the hook, per path", () => {
  it("follows the compiler's native transport without asking a paired helper to substitute", async () => {
    const { client, requests } = fakeClient({ ok: true, maskWidth: 1, maskHeight: 1, maskBase64: 'AA==', millis: 1 });
    const { backend } = fakeBackend(new Float32Array(4));
    const nativePlan = { ...compiled, resources: [{ kind: "externalTexture", id: "scratch:mask:modelResult", size: [4, 2], format: "rgba16float", sourceId: "inference:mask" }] } as unknown as CompiledGraph;
    const view = renderHook(() => useVisionBridge({ ...READS, deviceClient: () => client, backend: () => backend }));
    act(() => view.result.current.track(graph, nativePlan));
    act(() => view.result.current.observe(frame)); await flush();
    expect(requests).toEqual([]);
    expect(view.result.current.diagnostics.map(value => value.code)).toEqual(["vision.native.refused"]);
    expect(view.result.current.resolver("mask1:ready", { frame } as never)).toBe(0);
    view.unmount();
  });
  it("NO HELPER: a WARNING at the node, coverage READS ZERO, and nothing ever crosses (T1067)", async () => {
    const { backend } = fakeBackend(new Float32Array(4));
    const view = renderHook(() =>
      useVisionBridge({ ...READS, deviceClient: () => null, backend: () => backend }),
    );
    act(() => view.result.current.track(graph, compiled));
    // WARNING, so the node's own badge lights: info reached only the problems pane and
    // the owner met a silently black node (the shipped E52 report, verbatim).
    expect(view.result.current.diagnostics[0]?.severity).toBe("warning");
    expect(view.result.current.diagnostics[0]?.code).toBe("vision.helper.absent");
    expect(view.result.current.diagnostics[0]?.message).toContain(DEVICE_HELPER_COMMAND);
    /* THE SHIPPED FAILURE: E52 spends `mask1:coverage`, and with no helper this hook
       tracked the entry but never joined the channel chain — so the expression FAILED
       ("publishes no channel") instead of dimming the room. The channel must exist
       whenever the NODE exists: zero, with the distinction carried by the warning. */
    expect(view.result.current.resolver("mask1:coverage", { frame } as never)).toBe(0);
    // And BEFORE any track at all (the first structural compile's world): the channel
    // belongs to the NODE, answered from the live document, or the first compile pins
    // an expression error nothing later clears — the shipped E52 failure exactly.
    const cold = renderHook(() =>
      useVisionBridge({ ...READS, deviceClient: () => null, graph: () => graph }),
    );
    expect(cold.result.current.resolver("mask1:coverage", { frame } as never)).toBe(0);
    expect(cold.result.current.resolver("depth1:coverage", { frame } as never)).toBeUndefined();
    // The typo protection survives: a channel nothing publishes still refuses by name.
    expect(view.result.current.resolver("mask1:nonsense", { frame } as never)).toBeUndefined();
    await flush();
  });

  it("THE FIRING PATH: planner bytes cross exactly, the mask comes back as exact floats, coverage separates found-nobody from did-not-run", async () => {
    // Two lit texels then zeros: the wire must carry round(v*255) of exactly these.
    const texels = new Float32Array(512 * 512 * 4);
    texels[0] = 1;
    texels[1] = 0.5;
    // A 4×4 mask, fully confident top-left quadrant of the centred band.
    const mask = new Uint8Array([9, 9, 9, 9, 255, 255, 0, 0, 0, 0, 0, 0, 9, 9, 9, 9]);
    const { client, requests } = fakeClient({
      ok: true,
      maskWidth: 4,
      maskHeight: 4,
      maskBase64: btoa(String.fromCharCode(...mask)),
      millis: 21,
    });
    const { backend, registered } = fakeBackend(texels);
    const view = renderHook(() =>
      useVisionBridge({ ...READS, deviceClient: () => client, backend: () => backend }),
    );
    act(() => view.result.current.track(graph, compiled));
    act(() => view.result.current.observe(frame));
    await flush();
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ width: 512, height: 512 });
    const sent = Uint8Array.from(atob(requests[0]!.rgbaBase64), (c) => c.charCodeAt(0));
    expect(sent[0]).toBe(255);
    expect(sent[1]).toBe(128);
    expect(sent[2]).toBe(0);

    // The published frame: the media source the node's external texture uploads from,
    // at the OUTPUT size (4×2), letterbox undone — band rows 1..2 of the mask.
    const source = registered.get("infer:mask");
    expect(source).toBeDefined();
    const published = source!.currentFrame();
    expect(published).toBeDefined();
    const floats = new Float32Array(published!.bytes.buffer, published!.bytes.byteOffset, 8);
    expect([...floats]).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
    expect(maskCoverage(published!.bytes)).toBe(0.25);
  });

  it("A DOOR REFUSAL surfaces as the node's own warning on the next track — never a silent zero mask", async () => {
    const { client } = fakeClient({ ok: false, reason: "person segmentation needs Apple's Vision framework, which only exists on macOS" });
    const { backend } = fakeBackend(new Float32Array(512 * 512 * 4));
    const view = renderHook(() =>
      useVisionBridge({ ...READS, deviceClient: () => client, backend: () => backend }),
    );
    act(() => view.result.current.track(graph, compiled));
    act(() => view.result.current.observe(frame));
    await flush();
    await flush();
    act(() => view.result.current.track(graph, compiled));
    const warning = view.result.current.diagnostics.find((entry) => entry.code === "vision.refused");
    expect(warning?.message).toContain("only exists on macOS");
  });
});

describe("T1254 — the resolver's identity does not follow the caller's accessor", () => {
  it("a fresh `graph` arrow per render keeps the SAME resolver, and that resolver reads the LATEST document", () => {
    // The composition root hands `graph: () => runtime.flattened.current().graph` — a new
    // function every `App` render. With that arrow in the resolver's dependency array,
    // every render re-keyed `externalChannels`, the compile hook's channel resolver, its
    // `CompileRequest` and its per-frame compiler: one full compile per RENDER on a knob
    // drag (1935 renders, 1935 resolvers on E24 scenario C). Identity is what the compile
    // memos key on, so identity is what this pins — and the ref must not go stale, or a
    // renamed mask would keep answering for its old name.
    let current = graph;
    const view = renderHook(() => useVisionBridge({ ...READS, deviceClient: () => null, graph: () => current }));
    const first = view.result.current.resolver;
    view.rerender();
    view.rerender();
    expect(view.result.current.resolver).toBe(first);
    expect(first("mask1:coverage", { frame } as never)).toBe(0);

    current = {
      ...graph,
      nodes: { mask: { ...graph.nodes["mask"], label: "mask2" } },
    } as unknown as GraphDocument;
    view.rerender();
    expect(view.result.current.resolver).toBe(first);
    expect(first("mask2:coverage", { frame } as never)).toBe(0);
    expect(first("mask1:coverage", { frame } as never)).toBeUndefined();
  });
});

/**
 * T1525b — MIN INTERVAL IS A PARAMETER READ, AT THE FRAME THE HELPER IS ASKED ON.
 *
 * `rateLimit` was read off the stored slot, so an expression on it did nothing and a bank
 * fading it reached the helper at its DESTINATION on the frame of the recall. Here a bank
 * takes Min interval from 4.1 s down to 0.1 s over 2 s (linear), recalled on frame 0. The
 * fade puts the gap at 4.1 - 2t: at t = 1.35 it is 1.4 — a run 1.35 s after the last is
 * still refused — and at t = 1.40 it is 1.3, so that one goes. Read at the destination
 * (0.1), every one of those frames asks the helper. What is asserted is the request on the
 * wire, which is what the cadence knob exists to thin.
 */
describe("T1525b — a fading Min interval paces the helper at the value the fade is at", () => {
  const EPOCH = "session-1";
  const at = (seconds: number): FrameEvaluationInput => ({
    frameIndex: Math.round(seconds * 60),
    timeSeconds: seconds,
    deltaSeconds: 1 / 60,
    mode: "realtime",
    randomSeed: 7,
    absFrameIndex: Math.round(seconds * 60),
    absTimeSeconds: seconds,
    absEpoch: EPOCH,
  });

  async function fading(): Promise<GraphDocument> {
    const session = presetSession(
      {
        ...graph,
        nodes: {
          mask: { ...graph.nodes["mask"]!, parameters: { rateLimit: 4.1 } },
          bank: presetBankNode("bank", "looks", "mask1", [{ name: "quick", values: { mask1: { rateLimit: 0.1 } } }]),
        },
      } as unknown as GraphDocument,
      registry,
    );
    session.at({ epoch: EPOCH, absTimeSeconds: 0 });
    await session.recall("bank", "quick", { seconds: 2, curve: "linear" });
    return session.graph();
  }

  async function requestsAcross(document: GraphDocument, morphs: () => ReturnType<typeof buildMorphIndex> | undefined): Promise<number[]> {
    const mask = new Uint8Array([255]);
    const { client, requests } = fakeClient({ ok: true, maskWidth: 1, maskHeight: 1, maskBase64: btoa(String.fromCharCode(...mask)), millis: 1 });
    const { backend } = fakeBackend(new Float32Array(512 * 512 * 4));
    const view = renderHook(() =>
      useVisionBridge({ ...READS, flattening: () => { const index = morphs(); return index === undefined ? NO_FLATTENING : { ...NO_FLATTENING, morphs: index }; }, deviceClient: () => client, backend: () => backend }),
    );
    act(() => view.result.current.track(document, compiled));
    const counts: number[] = [];
    for (const seconds of [0, 1.0, 1.35, 1.4]) {
      act(() => view.result.current.observe(at(seconds)));
      await flush();
      await flush();
      counts.push(requests.length);
    }
    view.unmount();
    return counts;
  }

  it("refuses a run 1.35 s after the last while the gap is 1.4, and lets the one at 1.40 through", async () => {
    const document = await fading();
    // The document holds the destination from the recall on; only the frames are on their way.
    expect(document.nodes["mask"]?.parameters["rateLimit"]).toBe(0.1);
    const morphs = buildMorphIndex({ document, registry });
    expect(await requestsAcross(document, () => morphs)).toEqual([1, 1, 1, 2]);
  });

  it("cut the wire: read without the morph index, the destination's 0.1 s lets 1.0 and 1.35 ask too", async () => {
    const document = await fading();
    // 1.40 is 0.05 s after 1.35, inside even the destination's 0.1 s gap.
    expect(await requestsAcross(document, () => undefined)).toEqual([1, 2, 3, 3]);
  });
});
