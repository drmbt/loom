import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * §B231 — AN EXPRESSION ON ONE COMPONENT OF A COMPOUND KNOB FAILED IN SILENCE.
 *
 * The report came from the On Nothing shots: an unknown function in an expression on a
 * shader-declared knob held the retained value, and the headless render (whose script
 * stopped on an expression failure, then all one code, `parameter.expression`) did not
 * stop. The same mistake on a SCALAR knob did stop it. The difference is the key, not the node: the silent knobs were written per
 * component (`place.x` on a kernel's `vec3f`, `tint.r` here on a Custom WGSL `vec3f`), and
 * the resolver's per-component verdict never reached `plan.diagnostics` — the compiler read
 * each parameter's bare-key diagnostic and dropped its components' (§V288, §V109).
 *
 * The literal bug, through the real stack: the headless harness `render.ts` is built on,
 * Dawn underneath, `animate` on as it is there. The value is asserted from PIXELS, against
 * renders of the same graph with the knob static — byte-identical, so no colour-space
 * arithmetic has to be restated here to know which number reached the shader.
 *
 * §T1641b: an unknown function can never evaluate, so it is an ERROR now and stops a
 * headless render by itself. This file is a fallback's own test, so it names the finding it
 * renders through (`expectedFindings`). A failure of arithmetic at these inputs is still a
 * warning that travels with the frames.
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

/** White Solid → Custom WGSL (default source: rgb × amount × tint) → Output, `tint.r` as given. */
function tinted(red: StoredParameter): GraphDocument {
  const node = (id: string, type: string, x: number, parameters: Record<string, unknown>) =>
    ({ id, type, definitionVersion: 1, position: { x, y: 0 }, parameters }) as never;
  return {
    revision: 1,
    nodes: {
      solid: node("solid", "solid", 0, { color: [1, 1, 1, 1] }),
      fx: node("fx", "customWgsl", 200, { amount: 1, tint: [1, 1, 1, 1], "tint.r": red }),
      out: node("out", "output", 400, {}),
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e1: { id: "e1", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

async function render(red: StoredParameter, expectedFindings: readonly string[] = []) {
  const result = await renderHeadless({ host: nodeGpuHost(), graph: tinted(red), settings, frames: 2, animate: true, expectedFindings });
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return { bytes: Buffer.from(frame.bytes), expression: result.diagnostics.filter((d) => d.code.startsWith("parameter.expression.")) };
}

describe("§B231 — a failing expression on one component of a WGSL-declared knob", () => {
  it("names the node, the component key and the function, and the pixels show the retained value", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const retained = await render(0.25);

    // `saturate` is real WGSL/HLSL an author reaches for; the grammar does not have it.
    await expect(render(expressionSlot("saturate(abstime)", 0.25))).rejects.toThrow(/"tint\.r".*unknown function "saturate"/);
    const unknown = await render(expressionSlot("saturate(abstime)", 0.25), ["parameter.expression.syntax"]);
    expect(unknown.expression).toHaveLength(1);
    expect([unknown.expression[0]?.severity, unknown.expression[0]?.code]).toEqual(["error", "parameter.expression.syntax"]);
    expect(unknown.expression[0]?.suggestion).toBe("Write clamp(abstime, 0, 1).");
    expect(unknown.expression[0]?.nodeId).toBe("fx");
    expect(unknown.expression[0]?.message).toContain('"tint.r"');
    expect(unknown.expression[0]?.message).toContain('unknown function "saturate"');
    // What the diagnostic says is what the frame did: §V108's retained 0.25, byte for byte.
    expect(Buffer.compare(unknown.bytes, retained.bytes)).toBe(0);

    // The EVALUATION half: it parses, and fails only once it runs.
    const evaluation = await render(expressionSlot("mod(abstime, 0)", 0.25));
    expect(evaluation.expression).toHaveLength(1);
    expect([evaluation.expression[0]?.severity, evaluation.expression[0]?.code]).toEqual(["warning", "parameter.expression.value"]);
    expect(evaluation.expression[0]?.nodeId).toBe("fx");
    expect(evaluation.expression[0]?.message).toContain('"tint.r"');
    expect(evaluation.expression[0]?.message).toContain("mod(): the period is zero");
    expect(Buffer.compare(evaluation.bytes, retained.bytes)).toBe(0);
  }, 60_000);

  it("leaves the legitimate case alone: a valid expression is silent and is the value on screen", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const retained = await render(0.25);
    const intended = await render(0.75);

    const valid = await render(expressionSlot("0.5 + 0.25 + abstime * 0", 0.25));
    expect(valid.expression).toEqual([]);
    // The expression's value, not the retained one — so the component path is really live
    // and the diagnostics above are not the product of a knob that never resolved at all.
    expect(Buffer.compare(valid.bytes, intended.bytes)).toBe(0);
    expect(Buffer.compare(valid.bytes, retained.bytes)).not.toBe(0);
  }, 60_000);
});
