// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { InferenceRequest, InferenceResponse } from "@runtime/models/inference-protocol.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import * as acquisitionModule from "@runtime/models/model-acquisition.ts";
import { MATTE_RVM } from "@runtime/models/model-catalogue.ts";
import { compileGraph } from "@compiler/index.ts";
import { DEFAULT_PROJECT_SETTINGS, type GraphDocument } from "@domain/types/graph.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { buildMorphIndex } from "@domain/presets/morph-index.ts";
import { presetBankNode, presetSession } from "@domain/presets/test-support.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { TIER_B_CAPABILITIES } from "@/examples/runner.ts";
import { useModelInference } from "./use-model-inference.ts";

/**
 * T1525b — A MATTE'S PER-RUN PARAMETERS REACH THE WORKER THROUGH THE ONE READ PATH.
 *
 * The seam handed the node definition's settings reader `node.parameters` — the STORED
 * slots — so an expression on Detail Ratio did nothing (the slot is an object, `Number()`
 * of it is NaN, the default stood), and a bank fading Smoothing reached the worker at its
 * destination on the frame of the recall. What is asserted is the `run` request the worker
 * is posted: the `ratio` and `smoothing` it is actually told to use.
 *
 * The document: an RVM matte at Smoothing 0.2 whose Detail Ratio is `op('knob1').par.value`
 * (an index into 0.25 / 0.375 / 0.5 / 0.75 / 1), and two banks recalled on frame 0 with a
 * 1 s linear morph — one takes Smoothing to 1, the other the knob from 0 to 2. At frame 30
 * Smoothing is 0.6 and the knob 1, so the ratio is 0.375; read at the destination they are
 * 1 and 0.5, and off the raw slots 1 and the default 0.5.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const registry = createNodeRegistry(allNodeDefinitions).view();
const EPOCH = "session-1";
const liveFrame = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "realtime",
  randomSeed: 1,
  absFrameIndex: frameIndex,
  absTimeSeconds: frameIndex / 60,
  absEpoch: EPOCH,
});

async function fading(): Promise<GraphDocument> {
  const session = presetSession(
    {
      revision: 1,
      groups: {},
      nodes: {
        src: { id: "src", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        cut: {
          id: "cut",
          type: "matte",
          label: "matte1",
          definitionVersion: 1,
          position: { x: 200, y: 0 },
          parameters: {
            model: MATTE_RVM.id,
            smoothing: 0.2,
            downsampleRatio: {
              mode: "expression",
              bindings: {
                static: { kind: "static", value: "0.5" },
                expression: { kind: "expression", source: "op('knob1').par.value" },
              },
            },
          },
        },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
        knob: { id: "knob", type: "constant", label: "knob1", definitionVersion: 1, position: { x: 0, y: 200 }, parameters: { value: 0 } },
        smooth: presetBankNode("smooth", "smooth1", "matte1", [{ name: "go", values: { matte1: { smoothing: 1 } } }]),
        dial: presetBankNode("dial", "dial1", "knob1", [{ name: "go", values: { knob1: { value: 2 } } }]),
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "cut", portId: "input" } },
        e2: { id: "e2", source: { nodeId: "cut", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
    } as unknown as GraphDocument,
    registry,
  );
  session.at({ epoch: EPOCH, absTimeSeconds: 0 });
  await session.recall("smooth", "go", { seconds: 1, curve: "linear" });
  await session.recall("dial", "go", { seconds: 1, curve: "linear" });
  return session.graph();
}

/** What each `run` the worker is posted says about ratio and smoothing, frame by frame. */
async function runsAcross(
  graph: GraphDocument,
  reads: Parameters<typeof useModelInference>[4],
  frames: readonly number[],
): Promise<Array<{ ratio: number; smoothing: number }>> {
  const createAcquisition = acquisitionModule.createModelAcquisition;
  vi.spyOn(acquisitionModule, "createModelAcquisition").mockImplementation((options) => ({
    ...createAcquisition(options),
    refresh: async (descriptor) => {
      options.onStateChange?.(descriptor.id, { kind: "ready" });
      return { kind: "ready" };
    },
    acquire: async () => new ArrayBuffer(8),
  }));
  const runs: Array<{ ratio: number; smoothing: number }> = [];
  // A worker that loads at once and answers every run, so each frame can issue the next.
  vi.stubGlobal(
    "Worker",
    class {
      private listener: ((event: { data: InferenceResponse }) => void) | undefined;
      addEventListener(kind: string, listener: (event: { data: InferenceResponse }) => void) {
        if (kind === "message") this.listener = listener;
      }
      postMessage(message: InferenceRequest) {
        const answer = (data: InferenceResponse) => queueMicrotask(() => this.listener?.({ data }));
        if (message.kind === "load") answer({ kind: "loaded", sessionKey: message.sessionKey, backend: "wasm", millis: 1 } as InferenceResponse);
        if (message.kind === "run") {
          runs.push({ ratio: message.ratio, smoothing: message.smoothing });
          answer({ kind: "result", requestId: message.requestId, bytes: new ArrayBuffer(16), backend: "wasm", millis: 1, isolated: false });
        }
      }
      terminate() {}
    },
  );
  const backend = {
    readBuffer: async () => new ArrayBuffer(16),
    registerMediaSource: () => () => undefined,
  } as unknown as LoomBackend;
  const plan = compileGraph({ graph, settings: DEFAULT_PROJECT_SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
  const view = renderHook(() => useModelInference(backend, undefined, undefined, undefined, reads));
  act(() => view.result.current.track(graph, plan));
  const settle = async () =>
    act(async () => {
      for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  await settle();
  for (const frameIndex of frames) {
    act(() => view.result.current.observe(liveFrame(frameIndex)));
    await settle();
  }
  view.unmount();
  return runs;
}

describe("T1525b — the matte's ratio and smoothing reach the worker at the frame's values", () => {
  it("frame 30 of the fades runs at smoothing 0.6 and ratio 0.375; frame 60 at 1 and 0.5", async () => {
    const graph = await fading();
    // The document holds the destinations from the recall on.
    expect(graph.nodes["cut"]?.parameters["smoothing"]).toBe(1);
    expect(graph.nodes["knob"]?.parameters["value"]).toBe(2);
    const morphs = buildMorphIndex({ document: graph, registry });
    const runs = await runsAcross(graph, { registry, channels: () => undefined, morphs: () => morphs }, [0, 30, 60]);
    expect(runs).toEqual([
      { ratio: 0.25, smoothing: 0.2 },
      { ratio: 0.375, smoothing: 0.6 },
      { ratio: 0.5, smoothing: 1 },
    ]);
  });

  it("cut the wire: without the morph index frame 30 runs at the destinations, 0.5 and 1", async () => {
    const graph = await fading();
    const runs = await runsAcross(graph, { registry, channels: () => undefined, morphs: () => undefined }, [30]);
    expect(runs).toEqual([{ ratio: 0.5, smoothing: 1 }]);
  });
});
