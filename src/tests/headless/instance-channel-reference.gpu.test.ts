import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { componentNodeType, createComponentSystem } from "../../domain/components/index.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * §T1485b — `op('<instance>').chan.<c>` READS A COMPONENT INSTANCE'S CHANNELS.
 *
 * The bug, literally: an expression OUTSIDE a component naming the INSTANCE
 * (`op('analysis1').chan.level`) neither read nor completed, because the compiler resolves
 * `op()` names against the FLATTENED graph and flattening deletes the instance node. The
 * parameter held §V108's retained value and the picture never moved with the component.
 *
 * Through the real stack: the real flattener, the value graph the harness evaluates per
 * frame, the per-frame compile, Dawn. The value is asserted from PIXELS against renders of
 * the same graph with the knob STATIC at the number the instance publishes — byte-identical,
 * so no colour arithmetic is restated here — and the instance's output is changed to show
 * the picture follows it, which is what a read that fell back to the retained value cannot do.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const settings: ProjectSettings = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 8,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const RETAINED = 0.25;

const node = (id: string, type: string, x: number, parameters: Record<string, unknown>, label?: string): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x, y: 0 }, parameters, ...(label === undefined ? {} : { label }) }) as never;

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

/**
 * AudioAnalysis's shape without a sound card: two value outputs, `levels` and `hits`, each
 * fed by its own publisher, and one channel name (`shared`) on BOTH.
 */
function analysis(level: number): GraphComponentDefinition {
  return {
    componentId: "analysis",
    version: 1,
    name: "Analysis",
    graph: {
      revision: 1,
      groups: {},
      nodes: {
        bands: node("bands", "valueExpression", 0, { expressions: `level = ${level}; shared = 1` }, "bands1"),
        onsets: node("onsets", "valueExpression", 0, { expressions: "kick = 0.6; shared = 2" }, "onsets1"),
        // Socket order is canvas order (T607): `levels` first.
        levels: { ...node("levels", "componentOutValue", 300, {}, "levels"), position: { x: 300, y: 0 } },
        hits: { ...node("hits", "componentOutValue", 300, {}, "hits"), position: { x: 300, y: 100 } },
      },
      edges: {
        a: edge("a", ["bands", "out"], ["levels", "in"]),
        b: edge("b", ["onsets", "out"], ["hits", "in"]),
      },
    },
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

/** Instance `analysis1` beside White Solid → Custom WGSL (rgb × amount × tint) → Output. */
function document(red: StoredParameter): GraphDocument {
  return {
    revision: 1,
    nodes: {
      inst: node("inst", componentNodeType("analysis", 1), -400, {}, "analysis1"),
      solid: node("solid", "solid", 0, { color: [1, 1, 1, 1] }),
      fx: node("fx", "customWgsl", 200, { amount: 1, tint: [1, 1, 1, 1], "tint.r": red }),
      out: node("out", "output", 400, {}),
    },
    edges: {
      e0: edge("e0", ["solid", "out"], ["fx", "input"]),
      e1: edge("e1", ["fx", "out"], ["out", "input"]),
    },
    groups: {},
  };
}

async function render(red: StoredParameter, level = 0.75) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  system.components.register(analysis(level));
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document(red),
    settings,
    frames: 2,
    animate: true,
    components: system.components.view(),
  });
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return Buffer.from(frame.bytes);
}

/*
 * PIXELS ONLY. The harness reports the STRUCTURAL compile's diagnostics, which has no
 * channels (an info-tier "no channel resolver", never the read), and drops the per-frame
 * plan's warnings — so the refusal's wording is asserted where the compiler hands it back,
 * `src/tests/integration/instance-channel-reference.test.ts`.
 */
describe("§T1485b — an expression outside a component reads the instance's channels", () => {
  it("drives the parameter with the instance's published value, and follows it when it changes", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const retained = await render(RETAINED);
    const read = expressionSlot("op('analysis1').chan.level", RETAINED);

    const at075 = await render(read, 0.75);
    expect(Buffer.compare(at075, await render(0.75))).toBe(0);
    // Not the retained value: the read really happened.
    expect(Buffer.compare(at075, retained)).not.toBe(0);

    // The instance's output moves, so the picture moves with it — the cut-the-wire question.
    const at05 = await render(read, 0.5);
    expect(Buffer.compare(at05, await render(0.5))).toBe(0);
    expect(Buffer.compare(at05, at075)).not.toBe(0);
  }, 120_000);

  it("reads a channel from the OTHER output too — the union of the instance's value outputs", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const kick = await render(expressionSlot("op('analysis1').chan.kick", RETAINED));
    expect(Buffer.compare(kick, await render(0.6))).toBe(0);
  }, 60_000);

  it("refuses a channel two outputs publish — the frame shows the retained value, not either output's", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const shared = await render(expressionSlot("op('analysis1').chan.shared", RETAINED));
    expect(Buffer.compare(shared, await render(RETAINED))).toBe(0);
  }, 60_000);
});
