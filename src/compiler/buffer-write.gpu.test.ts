import { describe, expect, it } from "vitest";

import { createUniformAnimator } from "../app/animate-parameters.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { ProjectSettings } from "../domain/types/graph.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { ParameterSlot, ParameterValue } from "../domain/types/parameters.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { decodeHalf } from "../tests/headless/pixel-compare.ts";
import { tableProbeGraph, tableProbeNode } from "./buffer-write.fixture.ts";
import { prepareFrameCompiler } from "./frame-compile.ts";

/**
 * T1623b slice 2, THE WHOLE ROAD ON A REAL DEVICE: a node's parameter, driven by an
 * expression, becomes a row of a table, and a FRAGMENT shader reads it.
 *
 * The frame is run as the app runs one: the values-only frame compile, the uniform animator,
 * the render. Nothing is compiled after the first frame. The Table Probe draws the sum of its
 * live rows, row i being (Gain × (i + 1), 0.25 × (i + 1), 0.5), so a pixel is:
 *
 *   red   = Gain × (1 + 2 + … + n)        green = 0.25 × (1 + 2 + … + n)        blue = 0.5 × n
 *
 * Gain is 1 before frame 30 and 8 from it on; Rows is 2 before frame 60 and 4 from it on.
 * Every value is exact in a half float, so the claims are equalities.
 *
 * What differs if the road is cut: with the animator's push gone the pixel stays at frame 0's
 * value; with the backend's write gone it is black; with the count not following its rows the
 * blue channel is wrong.
 */

const SIZE = 16;
const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 20,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const registry = createNodeRegistry([...allNodeDefinitions, tableProbeNode]).view();

const frameAt = (frameIndex: number): FrameEvaluationInput => ({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 });

const expressionSlot = (source: string, retained: ParameterValue): ParameterSlot => ({
  mode: "expression",
  bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: retained } },
});

describe("T1623b: a driven row reaches a fragment shader with nothing recompiled", () => {
  it("draws the sum of the live rows at each frame's own values", async () => {
    // Required, never skipped: without a GPU this would be a green tick about nothing.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const problems: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => problems.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const graph = tableProbeGraph({ gain: expressionSlot("1 + 7 * (frame >= 30)", 1), rows: expressionSlot("2 + 2 * (frame >= 60) + 9 * (frame >= 90)", 2) });
      const prepared = prepareFrameCompiler({ graph, settings, registry, capabilities });
      expect(prepared.base.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      expect(prepared.uniformOnly).toBe(true);
      const compiled = await backend.compile(prepared.base);
      const animator = createUniformAnimator();
      const target = prepared.base.outputs.find((output) => output.nodeId === "probe_table")?.resourceId ?? "";
      expect(target).not.toBe("");

      /** One frame as the app runs it: values-only compile, push, render; then the centre pixel. */
      const pixelAt = async (frameIndex: number): Promise<number[]> => {
        const frame = frameAt(frameIndex);
        const next = prepared.compileFrame({ frame });
        expect(next, `frame ${frameIndex}: ${prepared.reason ?? ""}`).not.toBeNull();
        if (next !== null) expect(animator.push(backend, prepared.base, next)).not.toBeNull();
        backend.render(compiled, { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [SIZE, SIZE] });
        const image = await backend.readOutput(target);
        expect(image.format).toBe("rgba16float");
        const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
        const at = (SIZE / 2) * image.rowStride + (SIZE / 2) * 8;
        return [0, 2, 4].map((channel) => decodeHalf(view.getUint16(at + channel, true)));
      };

      /* Gain 1, two rows: red 1 + 2, green 0.25 + 0.5, blue 0.5 × 2. */
      expect(await pixelAt(0)).toEqual([3, 0.75, 1]);
      expect(await pixelAt(1)).toEqual([3, 0.75, 1]);
      /* Gain 8: the same two rows, other numbers. */
      expect(await pixelAt(30)).toEqual([24, 0.75, 1]);
      /* Four rows: the table grew inside its capacity. Red 8 × 10, green 0.25 × 10, blue 0.5 × 4. */
      expect(await pixelAt(60)).toEqual([80, 2.5, 2]);
      expect(problems.filter((diagnostic) => diagnostic.severity !== "info")).toEqual([]);

      /* Thirteen rows do not fit four: refused by the node's name, and the picture is the last that fitted. */
      expect(await pixelAt(90)).toEqual([80, 2.5, 2]);
      expect(problems.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => [diagnostic.nodeId, diagnostic.message])).toEqual([
        ["probe_table", 'Buffer values "probe_table#rows" for "scratch:probe_table:table": 13 rows do not fit its capacity of 4. Not written; the rows already there stay.'],
      ]);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
