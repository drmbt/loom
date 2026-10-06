import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { diagnosticClass } from "../../domain/diagnostics/classes.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { HAZE, HAZE_OUTPUT, LAMP, LAMP_OUTPUT, boundTo, hazeFile, lampFile, openedFile, openedLamp } from "../fixtures/never-effective.ts";
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

async function render(
  brightness: StoredParameter,
  expectedFindings?: readonly string[],
  also: Readonly<Record<string, StoredParameter>> = {},
) {
  const opened = openedLamp(lampFile(brightness, [], also));
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

/**
 * §T1641b slice 1b — A BIND IS THE SAME SEAM. `parameter.bind` was one warning for a bind
 * that names nothing this node has (it can never read) and for one whose value does not
 * fit at the moment. A build script that binds to a misspelled sibling shipped the stored
 * value exactly as §B262's lamps did. Split by kind: the first is an error that leaves the
 * plan usable, the second stays a warning.
 */
describe("slice 1b — a document built by code whose bind names no parameter of its node", () => {
  it("stops a headless render with an ERROR by the node's name, the keys it has and the nearest one", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    let thrown: unknown;
    try {
      await render(boundTo("contrst", 0.5));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(`"${LAMP}"`);
    expect(message).toContain("parameter.bind.unreadable");
    expect(message).toContain('"brightness" is bound to "contrst"');
    expect(message).toContain("it names no parameter on this node (it has blacklevel, brightness, contrast,");
    expect(message).toContain('Nearest: "contrast".');
  }, 60_000);

  it("renders the rest of the document when the finding is named: the lamp holds its stored value", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const named = await render(boundTo("contrst", 0.5), ["parameter.bind.unreadable"]);
    const findings = named.diagnostics.filter((d) => d.severity === "error");
    expect(findings.map((d) => [d.code, d.nodeId, diagnosticClass(d.code)])).toEqual([["parameter.bind.unreadable", LAMP, "never"]]);
    expect(Buffer.compare(named.bytes, (await render(0.5)).bytes)).toBe(0);
    expect(Buffer.compare(named.bytes, (await render(0)).bytes)).not.toBe(0);
  }, 60_000);

  it("leaves a bind that reads alone: the lamp follows its sibling and nothing is said", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    // Brightness reads Opacity, which holds 0.25: the picture of brightness written 0.25.
    const opacity = { opacity: 0.25 };
    const bound = await render(boundTo("opacity", 0.5), undefined, opacity);
    expect(bound.diagnostics.filter((d) => d.severity === "error" || d.code.startsWith("parameter."))).toEqual([]);
    expect(Buffer.compare(bound.bytes, (await render(0.25, undefined, opacity)).bytes)).toBe(0);
    expect(Buffer.compare(bound.bytes, (await render(0.5, undefined, opacity)).bytes)).not.toBe(0);
  }, 60_000);

  it("keeps a bound value past the parameter's limit a warning: the render goes on at the stored value", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    // Opacity is 0…1 and reads Brightness, which holds 2. Another value of the sibling would
    // fit, so this is not a bind that can never read: degraded, and said as a warning.
    const past = await render(2, undefined, { opacity: boundTo("brightness", 0.5) });
    expect(past.diagnostics.filter((d) => d.nodeId === LAMP).map((d) => [d.severity, d.code, diagnosticClass(d.code)])).toEqual([
      ["warning", "parameter.bind.value", "degraded"],
    ]);
    expect(Buffer.compare(past.bytes, (await render(2, undefined, { opacity: 0.5 })).bytes)).toBe(0);
  }, 60_000);
});

/**
 * §T1641b slice 2 / §B264 — A SLOT UNDER A KEY THE NODE DOES NOT DECLARE WAS A WARNING, AND
 * THE VALUE WAS SILENTLY NOT DRIVEN.
 *
 * The report: a shader's `eyeColor: vec3f`, driven by a build script under `eyeColor.x`,
 * `.y` and `.z`. A vec3f whose name reads as a colour is a COLOUR parameter, so its parts
 * are r, g, b, and `.x` is a key of nothing. The compile said so as a warning under
 * `compiler/parameter-unknown`, the save path wrote it, and the robot's light stayed red
 * whatever its lenses did, for a day; `eyesAt.x` beside it worked, which is why it read as
 * right. And nothing in `struct Params { eyeColor: vec3f }` says which parts it has.
 *
 * The literal bug through the real stack, as §B262's above: built by code, the real save and
 * load, the harness, Dawn, pixels against the same document with the value static.
 */
describe("§B264 — a document built by code that drives eyeColor.x on a colour", () => {
  const RED: StoredParameter = [1, 0, 0, 1];
  const held = (value: number, retained: number): StoredParameter => expressionSlot(`${value} + abstime * 0`, retained);
  /** The three slots of the report: they would make the light green, if anything read them. */
  const WRITTEN_XYZ = { eyeColor: RED, "eyeColor.x": held(0, 1), "eyeColor.y": held(1, 0), "eyeColor.z": held(0, 0) };

  async function renderHaze(stored: Readonly<Record<string, StoredParameter>>, expectedFindings?: readonly string[]) {
    const opened = openedFile(hazeFile(stored));
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: opened.graph,
      settings: opened.settings,
      outputNodeId: HAZE_OUTPUT,
      frames: 2,
      animate: true,
      ...(expectedFindings === undefined ? {} : { expectedFindings }),
    });
    const frame = result.frames[0];
    if (frame === undefined) throw new Error("no frame captured");
    return { bytes: Buffer.from(frame.bytes), diagnostics: result.diagnostics };
  }

  it("stops a headless render with an ERROR by the node's name that says which parts a colour has, and why it is one", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    let thrown: unknown;
    try {
      await renderHaze(WRITTEN_XYZ);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(`"${HAZE}"`);
    expect(message).toContain("parameter.unknown");
    expect(message).toContain('stores a value under "eyeColor.x", which nothing reads');
    // The parts it has, and the one that was meant.
    expect(message).toContain('"eyeColor" is a colour, and its parts are r, g, b, a');
    expect(message).toContain('Write "eyeColor.r".');
    // The rule nothing in the WGSL shows: the NAME made this vec3f a colour.
    expect(message).toContain("a vec3f or vec4f whose name contains colour, color, tint, rgb, albedo or emissi is a colour");
  }, 60_000);

  it("renders the rest when the finding is named: the light is what is stored, whatever the slots say", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const named = await renderHaze(WRITTEN_XYZ, ["parameter.unknown"]);
    const findings = named.diagnostics.filter((d) => d.severity === "error");
    expect(findings.map((d) => [d.code, d.nodeId, diagnosticClass(d.code)])).toEqual([
      ["parameter.unknown", HAZE, "never"],
      ["parameter.unknown", HAZE, "never"],
      ["parameter.unknown", HAZE, "never"],
    ]);
    // Red, byte for byte: the plan is whole and nothing drove the colour.
    expect(Buffer.compare(named.bytes, (await renderHaze({ eyeColor: RED })).bytes)).toBe(0);
  }, 60_000);

  it("drives the colour when its parts are written r, g, b: the pixel moves with the driven value", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const driven = await renderHaze({ eyeColor: RED, "eyeColor.g": held(1, 0) });
    expect(driven.diagnostics.filter((d) => d.severity === "error" || d.code.startsWith("parameter."))).toEqual([]);
    // Red with its green driven to 1 is yellow, and no longer the stored red.
    expect(Buffer.compare(driven.bytes, (await renderHaze({ eyeColor: [1, 1, 0, 1] })).bytes)).toBe(0);
    expect(Buffer.compare(driven.bytes, (await renderHaze({ eyeColor: RED })).bytes)).not.toBe(0);
  }, 60_000);

  it("accepts eyesAt.x beside it: a position is a vector, and its parts are x, y, z", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const black: StoredParameter = [0, 0, 0, 1];
    const driven = await renderHaze({ eyeColor: black, "eyesAt.x": held(0.5, 0) });
    expect(driven.diagnostics.filter((d) => d.severity === "error" || d.code.startsWith("parameter."))).toEqual([]);
    expect(Buffer.compare(driven.bytes, (await renderHaze({ eyeColor: black, eyesAt: [0.5, 0, 0] })).bytes)).toBe(0);
    expect(Buffer.compare(driven.bytes, (await renderHaze({ eyeColor: black })).bytes)).not.toBe(0);
  }, 60_000);
});
