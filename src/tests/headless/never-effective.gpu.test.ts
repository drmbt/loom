import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { diagnosticClass } from "../../domain/diagnostics/classes.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { LAMP, LAMP_OUTPUT, lampFile, openedLamp } from "../fixtures/never-effective.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * §T1641b slice 1 / §B262 — A DOCUMENT WHOSE EXPRESSION CALLS A FUNCTION THE GRAMMAR DOES
 * NOT HAVE SAVED, LOADED AND RENDERED WITH ONLY A WARNING.
 *
 * The report: three lamps written by a build script with `pow(x, 2)` in their intensity.
 * The save path wrote them, `renderHeadless` returned a warning under `parameter.expression`,
 * and every frame rendered with the stored value: 26, 0 and 0, plausibly, for a day.
 *
 * The literal bug, through the real stack: the document is built by code and goes through
 * the real save and load (`../fixtures/never-effective.ts`), then the headless harness a
 * render script is built on, Dawn underneath, `animate` on as it is there. The value is
 * asserted from PIXELS against renders of the same document with the knob static, byte for
 * byte, so no colour arithmetic is restated here to know which number reached the shader.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/** `pow(x, 2)` with an `x` that evaluates, so the remedy the message names can be run. */
const POW = "pow(0.5 + abstime * 0, 2)";
/** What the grammar writes that as. 0.25 at every frame. */
const WRITTEN = "(0.5 + abstime * 0) ^ 2";

async function render(brightness: StoredParameter, expectedFindings?: readonly string[]) {
  const opened = openedLamp(lampFile(brightness));
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: opened.graph,
    settings: opened.settings,
    outputNodeId: LAMP_OUTPUT,
    frames: 2,
    animate: true,
    ...(expectedFindings === undefined ? {} : { expectedFindings }),
  });
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return { bytes: Buffer.from(frame.bytes), diagnostics: result.diagnostics };
}

describe("§B262 — a document built by code whose expression calls pow()", () => {
  it("stops a headless render with an ERROR by the node's name that says what to write instead", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    let thrown: unknown;
    try {
      await render(expressionSlot(POW, 0.5));
    } catch (error) {
      thrown = error;
    }
    // The render does not come back: a script that reads no diagnostics still stops.
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(`"${LAMP}"`);
    expect(message).toContain("parameter.expression.syntax");
    expect(message).toContain('"brightness"');
    expect(message).toContain('unknown function "pow"');
    // What to write instead, in the caller's own operands.
    expect(message).toContain(`Write ${WRITTEN}.`);
  }, 60_000);

  it("renders the rest of the document when the finding is named: the lamp holds its stored value", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const retained = await render(0.5);
    const dark = await render(0);

    const named = await render(expressionSlot(POW, 0.5), ["parameter.expression.syntax"]);
    const findings = named.diagnostics.filter((d) => d.code === "parameter.expression.syntax");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.nodeId).toBe(LAMP);
    expect(findings[0]?.suggestion).toContain(`Write ${WRITTEN}.`);
    expect(diagnosticClass("parameter.expression.syntax")).toBe("never");
    // `local`: the plan is whole. The Solid and the Level both ran, and the Level's knob is
    // §V108's retained 0.5, byte for byte, where a withdrawn plan would have left nothing.
    expect(Buffer.compare(named.bytes, retained.bytes)).toBe(0);
    expect(Buffer.compare(named.bytes, dark.bytes)).not.toBe(0);
    // Nothing else was let through under the name.
    expect(named.diagnostics.filter((d) => d.severity === "error")).toHaveLength(1);
  }, 60_000);

  it("names a remedy that is the expression: written as told, the lamp is driven and nothing is said", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const retained = await render(0.5);
    const intended = await render(0.25);

    const written = await render(expressionSlot(WRITTEN, 0.5));
    expect(written.diagnostics.filter((d) => d.severity === "error" || d.code.startsWith("parameter."))).toEqual([]);
    // The expression's value, not the stored one: what §B262's picture lacked.
    expect(Buffer.compare(written.bytes, intended.bytes)).toBe(0);
    expect(Buffer.compare(written.bytes, retained.bytes)).not.toBe(0);
  }, 60_000);

  it("refuses to let a finding through that is not local, or that the render never produced", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    // A name is not a licence: only a finding that leaves the plan usable can be rendered through.
    await expect(render(0.5, ["compiler/unknown-node-type"])).rejects.toThrow(/compiler\/unknown-node-type.*not local/);
    // And an expected finding that did not appear is a test that no longer tests it.
    await expect(render(0.5, ["parameter.expression.syntax"])).rejects.toThrow(/expected.*parameter\.expression\.syntax/);
  }, 60_000);
});
