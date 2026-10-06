import { describe, expect, it } from "vitest";

import { compileGraph, compiledWithoutCatalogue } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/types.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { diagnosticClass, stopsFinalRender } from "../../domain/diagnostics/classes.ts";
import { NO_FLATTENING } from "../../domain/parameters/node-references.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import { frameFromClock } from "../../domain/types/frame.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot, named } from "../../examples/documents/builders.ts";
import { LAMP, NEVER_EFFECTIVE_REGISTRY, boundTo, lampFile, openedLamp } from "../fixtures/never-effective.ts";

/**
 * §T1641b slice 1 — THE RULE AT THE COMPILE, IN BOTH DIRECTIONS.
 *
 * `parameter.expression` was one warning for every way an expression fails. Split by kind,
 * the ones that can NEVER evaluate are errors that leave the plan usable (`local`), and the
 * ones the rule could swallow by mistake stay as loud as they were, each under a code whose
 * class says why: a channel nothing publishes YET, a node of a type a newer build declares,
 * a value pinned at a limit. The pixels of the first half are in
 * `../headless/never-effective.gpu.test.ts`; this file is the compiler's half, with the
 * document built by code and read back through the real save and load, and each frame
 * compiled through the real value graph's channels the way a render compiles it.
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

interface Compiled {
  /** The structural compile: the zero frame, no channel resolver. What an open reads. */
  readonly structural: CompiledGraph;
  /** A frame's compile, reading the value graph's channels. What a render reads. */
  readonly frame: CompiledGraph;
}

function compiled(
  brightness: StoredParameter,
  others: readonly GraphNode[] = [],
  also: Readonly<Record<string, StoredParameter>> = {},
): Compiled {
  const { graph, settings } = openedLamp(lampFile(brightness, others, also));
  const request = { graph, settings, registry: NEVER_EFFECTIVE_REGISTRY, capabilities: CAPABILITIES };
  const frame = frameFromClock({ timeSeconds: 0.5, deltaSeconds: 1 / 60, frameIndex: 30, mode: "offline", randomSeed: 1, fps: 60 });
  const channels = createValueGraphSession(NEVER_EFFECTIVE_REGISTRY).evaluate(compiledWithoutCatalogue(graph), frame, {
    flattening: NO_FLATTENING,
  }).resolver;
  return { structural: compileGraph(request), frame: compileGraph({ ...request, resolution: { frame, channels } }) };
}

/** What a plan says about the lamp, as `[severity, code, class]`. */
const about = (plan: CompiledGraph): Array<readonly [string, string, string]> =>
  plan.diagnostics.filter((entry) => entry.nodeId === LAMP).map((entry) => [entry.severity, entry.code, diagnosticClass(entry.code)] as const);
const lampFinding = (plan: CompiledGraph): RuntimeDiagnostic | undefined => plan.diagnostics.find((entry) => entry.nodeId === LAMP);
/** The number the lamp's pass carries to the shader. */
function brightnessOf(plan: CompiledGraph): unknown {
  for (const pass of plan.passes) {
    if (pass.kind === "effect" && pass.nodeId === LAMP) return pass.uniforms?.["brightness"];
  }
  return undefined;
}

describe("§B262 at the compile: an expression that can never evaluate", () => {
  it("is an error on the node at the open and at every frame, and the plan is whole", () => {
    const sound = compiled(0.5);
    const broken = compiled(expressionSlot("pow(0.5 + abstime * 0, 2)", 0.5));
    for (const plan of [broken.structural, broken.frame]) {
      expect(about(plan)).toEqual([["error", "parameter.expression.syntax", "never"]]);
      // `local`: usable, with every pass the sound document has and the lamp at its stored
      // value. Without it the frame loop would install nothing and the document open black.
      expect(plan.ok).toBe(true);
      expect(plan.passes.map((pass) => pass.id)).toEqual(sound.structural.passes.map((pass) => pass.id));
      expect(brightnessOf(plan)).toBe(0.5);
    }
  });

  it("names a node spelled like a bare name nothing supplies, through the compile's own reader", () => {
    const { structural } = compiled(expressionSlot("flicker * 2", 0.5), [named("flicker", "slider", [0, 300])]);
    expect(about(structural)).toEqual([["error", "parameter.expression.name", "never"]]);
    expect(lampFinding(structural)?.suggestion).toContain(`A node is named "slider_flicker": write op('slider_flicker')`);
    expect(structural.ok).toBe(true);
  });
});

describe("slice 1b at the compile: a bind", () => {
  it("that names no parameter of its node is an error at the open and at every frame, and the plan is whole", () => {
    const sound = compiled(0.5);
    const broken = compiled(boundTo("contrst", 0.5));
    for (const plan of [broken.structural, broken.frame]) {
      expect(about(plan)).toEqual([["error", "parameter.bind.unreadable", "never"]]);
      expect(lampFinding(plan)?.suggestion).toBe('Nearest: "contrast".');
      expect(plan.ok).toBe(true);
      expect(plan.passes.map((pass) => pass.id)).toEqual(sound.structural.passes.map((pass) => pass.id));
      expect(brightnessOf(plan)).toBe(0.5);
    }
  });

  it("that reads a sibling is silent, and the sibling's value is what the pass carries", () => {
    const bound = compiled(boundTo("contrast", 0.5), [], { contrast: 1.5 });
    expect(about(bound.structural)).toEqual([]);
    expect(brightnessOf(bound.structural)).toBe(1.5);
  });

  it("whose value is past the parameter's limit stays degraded: the stored value stands in, and a final render goes on", () => {
    // Opacity is 0…1 and reads Brightness, which holds 2. Another value of it would fit.
    const past = compiled(2, [], { opacity: boundTo("brightness", 0.5) });
    for (const plan of [past.structural, past.frame]) {
      expect(about(plan)).toEqual([["warning", "parameter.bind.value", "degraded"]]);
      expect(plan.ok).toBe(true);
      expect(plan.diagnostics.filter(stopsFinalRender)).toEqual([]);
    }
  });
});

describe("what the rule must leave alone", () => {
  it("a channel nothing publishes YET stays a warning of class notYet", () => {
    // A Person Mask publishes `coverage` through the vision helper, which no compile has:
    // the read is right, and it reads the moment the helper runs (E52 ships exactly this).
    const waiting = compiled(expressionSlot("0.5 + op('personmask_seg').chan.coverage", 0.5), [named("seg", "personMask", [0, 300])]);
    // At the open there is no resolver at all: a fact about the caller, said at INFO.
    expect(about(waiting.structural)).toEqual([["info", "parameter.channels.unavailable", "elsewhereHost"]]);
    // At a frame, with the value graph's channels: not published yet.
    expect(about(waiting.frame)).toEqual([["warning", "parameter.reference.channel", "notYet"]]);
    expect(waiting.frame.ok).toBe(true);
    expect(brightnessOf(waiting.frame)).toBe(0.5);
    // A FINAL render stops on it all the same: it has no "later" (`stopsFinalRender`).
    expect(waiting.frame.diagnostics.filter(stopsFinalRender).map((entry) => entry.code)).toEqual(["parameter.reference.channel"]);
  });

  it("a parameter of a node type a newer build declares stays elsewhereBuild", () => {
    // §V10 keeps a node of an unknown type as a placeholder. What it declares is not absent,
    // it is unknowable here, so the read is not "a parameter the node does not have".
    const future: GraphNode = {
      id: "glow_next",
      type: "futureGlow",
      definitionVersion: 1,
      label: "glow_next",
      position: { x: 0, y: 300 },
      parameters: { amount: 2 },
    };
    const { structural } = compiled(expressionSlot("op('glow_next').par.amount", 0.5), [future]);
    expect(about(structural)).toEqual([["warning", "parameter.reference.unknownType", "elsewhereBuild"]]);
    // The placeholder itself is what this build cannot compile, as it was before the rule.
    expect(structural.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.code)).toEqual([
      "compiler/unknown-node-type",
    ]);
  });

  it("a value pinned at a declared limit stays degraded, and the limit is what renders", () => {
    // Brightness has a floor at 0. The expression is sound and evaluates; it is not in
    // effect as written, and the diagnostic says what stands in.
    const pinned = compiled(expressionSlot("abstime - 1", 0.5));
    for (const plan of [pinned.structural, pinned.frame]) {
      expect(about(plan)).toEqual([["warning", "parameter.expression.clamped", "degraded"]]);
      expect(plan.ok).toBe(true);
      expect(brightnessOf(plan)).toBe(0);
      expect(plan.diagnostics.filter(stopsFinalRender)).toEqual([]);
    }
  });

  it("an expression with no finite answer at one frame stays degraded: another frame reads it", () => {
    // `1 / abstime` divides by zero at the open's zero frame and is 2 at half a second.
    const late = compiled(expressionSlot("1 / abstime", 0.5));
    expect(about(late.structural)).toEqual([["warning", "parameter.expression.value", "degraded"]]);
    expect(brightnessOf(late.structural)).toBe(0.5);
    expect(about(late.frame)).toEqual([]);
    expect(brightnessOf(late.frame)).toBe(2);
  });
});
