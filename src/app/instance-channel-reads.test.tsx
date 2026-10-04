// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { componentNodeType } from "@domain/components/index.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { expressionSlot } from "@/examples/documents/builders.ts";
import { ANALYSIS_COMPONENT_ID, analysisComponentDefinition } from "../tests/fixtures/analysis-component.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { liveParameters, type LiveReads } from "./perform-mapping.ts";
import { usePulseFiring } from "./pulse-firing.ts";

/**
 * §T1551b — `op('<instance>').chan.<c>` reads the instance's value in the readers OUTSIDE the
 * compiler and the inspector.
 *
 * T1485b taught the compiler and the inspector to read a component instance's channels
 * (the flattening deletes the instance, so the read goes through the inner node its exposed
 * output publishes from). Every other reader built its context by hand without the
 * flattening's instance map, so the same expression failed "there is no node named
 * analysis1" there and sat on §V108's retained static. Two of them, through the app's own
 * wiring: the pulse watcher (`usePulseFiring`, which hands the watcher the runtime's
 * flattening) and the perform window's / viewer's parameter read (`liveParameters`, handed
 * the reads `app.tsx` builds: the runtime's flattening, whole).
 */

afterEach(cleanup);

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 1,
});

/** The app's runtime with `analysis1` (an instance) and one root node reading it. */
async function staged(type: string, parameters: Record<string, unknown>): Promise<{ runtime: AppRuntime; reader: string }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  // `level = frame / 10` on the instance's `levels` output: 0.5 at frame 5.
  runtime.components.register(analysisComponentDefinition("frame / 10"));
  let reader = "";
  await act(async () => {
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        operations: [
          { op: "addNode", ref: "$inst", type: componentNodeType(ANALYSIS_COMPONENT_ID, 1), position: { x: 0, y: 0 }, label: "analysis1" },
          { op: "addNode", ref: "$reader", type, position: { x: 240, y: 0 }, parameters: parameters as never, label: "reader1" },
        ],
        label: "seed",
      },
      runtime.invocation,
    );
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
    reader = result.output.createdIds["$reader"] ?? "";
  });
  // The premise: the instance is gone from the flat document every reader here reads.
  expect(Object.values(runtime.flattened.current().graph.nodes).map((entry) => entry.label)).not.toContain("analysis1");
  return { runtime, reader };
}

/** The value graph's resolver at `frame`, over the runtime's flat document — what the compile hands on. */
function channelsAt(runtime: AppRuntime, frame: FrameEvaluationInput): ChannelResolver {
  return createValueGraphSession(runtime.registry).evaluate(runtime.flattened.current().graph, frame).resolver;
}

describe("§T1551b — the pulse watcher reads op('<instance>').chan.<c>", () => {
  it("fires once, on the frame the instance's level crosses 0.5", async () => {
    const { runtime, reader } = await staged("feedback", {
      // A pulse's retained value is `false`: a document cannot hold it armed.
      resetPulse: {
        mode: "expression",
        bindings: {
          static: { kind: "static", value: false },
          expression: { kind: "expression", source: "max(0, sign(op('analysis1').chan.level - 0.5))" },
        },
      },
    });
    const cleared: Array<{ frame: number; nodeIds: readonly string[] }> = [];
    let frameIndex = 0;
    runtime.bus.registerCommand({
      name: "runtime.resetFeedback",
      description: "Test double for the feedback reset the pulse fires.",
      handler: (input) => {
        cleared.push({ frame: frameIndex, nodeIds: [...(input.nodeIds ?? [])] });
        return { status: "applied", output: { cleared: 1 }, diagnostics: [] };
      },
      rejectionOutput: () => ({ cleared: 0 }),
    });
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());

    let channels: ChannelResolver = () => undefined;
    const { result } = renderHook(() => usePulseFiring(runtime, runtime.invocation, () => channels));
    await act(async () => {
      for (frameIndex = 0; frameIndex < 10; frameIndex += 1) {
        const frame = frameAt(frameIndex);
        channels = channelsAt(runtime, frame);
        result.current.observe(frame);
        await Promise.resolve();
      }
    });
    // level = frame / 10 is 0.5 at frame 5 (sign 0, disarmed) and 0.6 at frame 6: the edge.
    // Read without the instance map, the read fails, the pulse holds its retained 0, and
    // nothing fires at all.
    expect(cleared).toEqual([{ frame: 6, nodeIds: [reader] }]);
  });
});

describe("§T1551b — a perform window's parameter read gets op('<instance>').chan.<c>", () => {
  it("reads the instance's level at the frame, and follows it", async () => {
    const { runtime, reader } = await staged("level", {
      brightness: expressionSlot("op('analysis1').chan.level", 0.25),
    });
    let frame = frameAt(3);
    // The reads `app.tsx` builds (`liveReads` + the frame last rendered).
    const reads: LiveReads = {
      channels: () => channelsAt(runtime, frame),
      flattening: () => runtime.flattened.current(),
      frame: () => frame,
    };
    const flat = runtime.flattened.current().graph;
    const target = flat.nodes[reader]!;
    const read = () => liveParameters(target, flat, runtime.registry, reads).get("brightness");

    expect(read()?.diagnostic).toBeNull();
    // 0.3, not the retained 0.25: the read reached the instance.
    expect(read()?.value).toBeCloseTo(0.3, 12);
    frame = frameAt(8);
    expect(read()?.value).toBeCloseTo(0.8, 12);
  });
});
