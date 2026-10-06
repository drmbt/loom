import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument, ProjectDocument } from "../../domain/types/graph.ts";
import { expressionSlot, named } from "../../examples/documents/builders.ts";
import {
  nodeGpuHost as dawnGpuHost,
  probeDawn,
} from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { LAMP_OUTPUT, lampDocument } from "../fixtures/never-effective.ts";
import { ANIMATE_OFF_CODE, renderHeadless } from "./render-harness.ts";

/**
 * T630 — THE HARNESS IS NOT ALLOWED TO BE QUIETER THAN THE APP.
 *
 * `renderHeadless` reported BACKEND diagnostics only. A compiler warning lives on
 * `plan.diagnostics`, and the harness threw on compiler errors but silently dropped
 * everything below that severity — so `compiler/substeps-refused` never surfaced, and
 * three example builds shipped believing substeps worked while the render was
 * byte-identical to one step. This harness is what every example agent verifies with:
 * a build that reads its diagnostics must see what the app's problems pane would show.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/** The shipped mistake, verbatim: substeps on a feedback that closes no loop. */
function substepsWithoutALoop(): GraphDocument {
  const doc: GraphDocument = { revision: 1, nodes: {}, edges: {}, groups: {} };
  const add = (id: string, type: string, parameters: Record<string, unknown>, x: number): void => {
    doc.nodes[id] = { id, type, definitionVersion: 1, position: { x, y: 0 }, parameters } as never;
  };
  add("solid", "solid", { color: [0.25, 0.5, 0.75, 1] }, 0);
  add("feedback", "feedback", { substeps: 4 }, 200);
  add("out", "output", {}, 400);
  doc.edges["e0"] = { id: "e0", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "feedback", portId: "in" } } as never;
  doc.edges["e1"] = { id: "e1", source: { nodeId: "feedback", portId: "out" }, target: { nodeId: "out", portId: "input" } } as never;
  return doc;
}

describe("T630 — renderHeadless surfaces compiler warnings", () => {
  it("substeps on a loopless feedback reaches the result's diagnostics", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const result = await renderHeadless({
      host: dawnGpuHost(),
      graph: substepsWithoutALoop(),
      frames: 2,
    });

    // The exact code the shipped builds never saw. Not "some warning": the claim is that
    // THIS class of quiet refusal travels to the caller.
    const refused = result.diagnostics.filter((d) => d.code === "compiler/substeps-refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.severity).toBe("warning");
    // And it is the plan's own copy, message and all — the caller can print it verbatim.
    expect(refused[0]?.message).toContain("no loop to iterate");
  });
});

/**
 * T791 — THE PER-FRAME PLAN'S DIAGNOSTICS ARE READ.
 *
 * Under `animate`, the harness recompiles every frame with the live channel resolver and
 * used to hand the result straight to `animator.push` — nobody read its diagnostics, so a
 * per-frame ERROR was structurally invisible to every animated gate. That is the third
 * blind spot B155 exposed: the app blacked out on diagnostics 935 green tests never saw.
 *
 * The fixture drives an ENUM parameter from an LFO channel. A channel delivers a number,
 * an enum in driven mode refuses it at error severity, and — decisive for this test —
 * the error exists ONLY in the per-frame compile: the structural compile has no channel
 * resolver, so the driven parameter falls back at info severity and compiles clean.
 * (If driven enums ever learn the expression path's index coercion, this fixture stops
 * erroring and this test needs a new per-frame-only error — that is the test working.)
 */
describe("T791 — a per-frame compile error fails the render", () => {
  it("throws, naming the frame, on an error only the animated path can produce", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const doc: GraphDocument = { revision: 1, nodes: {}, edges: {}, groups: {} };
    const add = (id: string, type: string, parameters: Record<string, unknown>, label?: string): void => {
      doc.nodes[id] = {
        id,
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters,
        ...(label === undefined ? {} : { label }),
      } as never;
    };
    add("wob", "lfo", { shape: "sine", frequency: 1, amplitude: 1, offset: 0, phase: 0 }, "wob1");
    add("solid", "solid", { color: [0.25, 0.5, 0.75, 1] });
    add("fold", "mirror", {
      extend: {
        mode: "driven",
        bindings: {
          driven: { kind: "driven", channel: "wob1" },
          static: { kind: "static", value: "hold" },
        },
      },
    });
    add("out", "output", {});
    doc.edges["e0"] = { id: "e0", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "fold", portId: "input" } } as never;
    doc.edges["e1"] = { id: "e1", source: { nodeId: "fold", portId: "out" }, target: { nodeId: "out", portId: "input" } } as never;

    await expect(
      renderHeadless({ host: dawnGpuHost(), graph: doc, frames: 3, animate: true }),
    ).rejects.toThrow(/Per-frame compile produced errors[\s\S]*frame \d/);
  });
});

describe("B252 — a value-graph error fails the render instead of blacking it out", () => {
  /*
   * The harness evaluated the value graph every frame and never read what it reported — the
   * sixth reader-that-cannot-see in this file's history. A loop through `op()` references
   * makes every member emit nothing (`valueGraph.cycle`, severity error), so a rate that
   * read its own output rendered black with no diagnostic reaching the script that printed
   * them (sentinel-bot, 2026-10-05). The app shows the same error in its Problems list.
   */
  it("throws, naming the frame and the members, on a loop closed through a wire and an op() reference", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const doc: GraphDocument = { revision: 1, nodes: {}, edges: {}, groups: {} };
    const reads = (name: string) => ({
      mode: "expression",
      bindings: { static: { kind: "static", value: 0 }, expression: { kind: "expression", source: `op('${name}').chan.value` } },
    });
    const add = (id: string, type: string, parameters: Record<string, unknown>, label?: string): void => {
      doc.nodes[id] = { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(label === undefined ? {} : { label }) } as never;
    };
    // The loop a rate that depends on its own output makes: `a` reads `b` by NAME, and `b`
    // takes `a` on a WIRE. A loop of references alone is refused at compile ("Parameter
    // reference chain is circular"); this one only the value graph's ordering can see.
    add("a", "lfo", { shape: "sine", frequency: 1, amplitude: 1, offset: reads("lag_b"), phase: 0 }, "lfo_a");
    add("b", "valueLag", { lag: 0.2 }, "lag_b");
    add("solid", "solid", { color: [0.25, 0.5, 0.75, 1] });
    add("level", "level", { brightness: reads("lfo_a") }, "level_out");
    add("out", "output", {});
    doc.edges["v0"] = { id: "v0", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" } } as never;
    doc.edges["e0"] = { id: "e0", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "level", portId: "input" } } as never;
    doc.edges["e1"] = { id: "e1", source: { nodeId: "level", portId: "out" }, target: { nodeId: "out", portId: "input" } } as never;

    await expect(
      renderHeadless({ host: dawnGpuHost(), graph: doc, frames: 3, animate: true }),
    ).rejects.toThrow(/frame 0: valueGraph\.cycle: Value graph cycle: a, b depend on each other/);
  });
});

/**
 * §T1641b slice 3 — THE HARNESS READS EVERY FRAME, AND SAYS WHAT IT WAS NOT ASKED TO DO.
 *
 * The seventh reader-that-cannot-see in this file's history. Under `animate` every frame is
 * compiled with that frame's clock and channels, and the harness kept the ERRORS of each
 * and dropped the rest: a channel not published at a frame, an expression with no finite
 * answer at one, were computed sixty times a second and read by nobody. And with `animate`
 * off it evaluates no expression per frame at all, returning plausible pictures of the
 * values at the zero frame.
 *
 * Each document is the lamp of `../fixtures/never-effective.ts`, as a build script holds it.
 */
type Request = Parameters<typeof renderHeadless>[0];
type Result = Awaited<ReturnType<typeof renderHeadless>>;

/** What a caller reads off a finding: its code, where it was first said, its class. */
const saidOf = (result: Result) => result.findings.map((finding) => [finding.diagnostic.code, finding.frame, finding.class]);

describe("T1641b — a finding only a frame shows is returned with its frame, and stops a strict render", () => {
  const render = (built: ProjectDocument, more: Partial<Request> = {}): Promise<Result> =>
    renderHeadless({ host: dawnGpuHost(), graph: built.graph, settings: built.settings, outputNodeId: LAMP_OUTPUT, animate: true, ...more });

  // 0.5, 1, then a division by zero at frame 2, then -1, below the Level's floor.
  const FAILS_AT_FRAME_2 = "1 / (2 - frame)";

  it("an expression with no finite answer at frame 2 and a clamp at frame 3: neither was in the result before", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const result = await render(lampDocument(expressionSlot(FAILS_AT_FRAME_2, 0.5)), { frames: 4 });
    // What a script read until now: the structural plan's, at the zero frame. Nothing.
    expect(result.diagnostics).toEqual([]);
    expect(saidOf(result)).toEqual([
      ["parameter.expression.value", 2, "degraded"],
      ["parameter.expression.clamped", 3, "degraded"],
    ]);
  });

  it("strict stops on the frame's failed value, by frame and by the node's name", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    await expect(render(lampDocument(expressionSlot(FAILS_AT_FRAME_2, 0.5)), { frames: 4, strict: true })).rejects.toThrow(
      /A strict render stops on what a final render cannot carry:\nframe 2: parameter\.expression\.value: "level_lamp" \(level\): Parameter "brightness" expression "1 \/ \(2 - frame\)" failed/,
    );
  });

  it("strict lets a clamp through: the limit is in effect and the finding says so", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    // Opacity is 0…1: `frame` is past it from frame 2 on. Degraded, and a final render may carry it.
    const result = await render(lampDocument(0.5, [], { opacity: expressionSlot("frame", 1) }), { frames: 3, strict: true });
    expect(saidOf(result)).toEqual([["parameter.expression.clamped", 2, "degraded"]]);
  });

  it("a channel its node does not publish at that frame: returned as still waiting, and a strict render stops on it", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    // The shape of E52's `coverage`: the node is there, and the channel is not, at this frame.
    const built = lampDocument(expressionSlot("op('lfo_wave').chan.nope", 0.5), [named("wave", "lfo", [0, 300])]);
    const result = await render(built, { frames: 2 });
    // At rest there is no channel resolver to ask: host-bound, an info. That is all a script saw.
    expect(result.diagnostics.map((entry) => [entry.code, entry.severity])).toEqual([["parameter.channels.unavailable", "info"]]);
    expect(saidOf(result)).toEqual([
      ["parameter.channels.unavailable", null, "elsewhereHost"],
      ["parameter.reference.channel", 0, "notYet"],
    ]);
    await expect(render(built, { frames: 2, strict: true })).rejects.toThrow(/frame 0: parameter\.reference\.channel: "level_lamp" \(level\)/);
  });
});

describe("T1641b — a render with expression slots and animate off says so, and a strict one refuses", () => {
  const still = (built: ProjectDocument, more: Partial<Request> = {}): Promise<Result> =>
    renderHeadless({ host: dawnGpuHost(), graph: built.graph, settings: built.settings, outputNodeId: LAMP_OUTPUT, frames: 3, ...more });
  const trap = (result: Result) => result.findings.filter((finding) => finding.diagnostic.code === ANIMATE_OFF_CODE);

  it("names how many slots and on which nodes, as a warning beside the frames", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const built = lampDocument(expressionSlot("abstime * 30", 0.5), [], { opacity: expressionSlot("1 - abstime", 1) });
    const found = trap(await still(built));
    expect(found).toHaveLength(1);
    expect(found[0]?.diagnostic.severity).toBe("warning");
    expect(found[0]?.frame).toBeNull();
    expect(found[0]?.diagnostic.message).toBe(
      'This render holds 2 expression slots on 1 node ("level_lamp") and animate is off: none is evaluated per frame. ' +
        "Every frame carries each one's value at the zero frame, or its stored value where it reads a channel.",
    );
    expect(found[0]?.diagnostic.suggestion).toBe("Pass animate: true.");
  });

  it("is an error under strict, before a frame is stepped", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    await expect(still(lampDocument(expressionSlot("abstime * 30", 0.5)), { strict: true })).rejects.toThrow(
      /A strict render stops on what a final render cannot carry:\nbefore the first frame: harness\.animateOff: This render holds 1 expression slot on 1 node \("level_lamp"\) and animate is off/,
    );
  });

  it("says nothing of a document with no expression slot, or of a render that animates", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    expect(trap(await still(lampDocument(0.5), { strict: true }))).toEqual([]);
    expect(trap(await still(lampDocument(expressionSlot("abstime * 30", 0.5)), { animate: true, strict: true }))).toEqual([]);
  });
});

describe("T1641b — the document at rest is judged before a frame is stepped", () => {
  it("stops on what only the write gate checks of a value in effect: a payload under another mode's binding", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    // The bus refuses this slot. The resolver reads it as a mode with no payload, a warning,
    // and the lamp rendered at its default brightness with nothing stopping the script.
    const misfiled = { mode: "static", bindings: { static: { kind: "expression", source: "0.25" } } } as never;
    const built = lampDocument(misfiled);
    await expect(renderHeadless({ host: dawnGpuHost(), graph: built.graph, settings: built.settings, outputNodeId: LAMP_OUTPUT })).rejects.toThrow(
      /The document holds what the write gate refuses: parameter\.slot\.shape: "level_lamp" \(level\): Parameter "brightness" stores a expression payload under its static binding\./,
    );
  });
});
