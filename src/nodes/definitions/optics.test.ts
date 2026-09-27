import { describe, expect, it } from "vitest";

import { scratchResourceId } from "../../compiler/resources.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { passStructureKey } from "../../runtime/backend/plan.ts";
import type { PassDescriptor } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import {
  GLOW_BRIGHT_KEY,
  HALO_RING_KEY,
  HALO_SCALE,
  STREAK_LEG_KEYS,
  STREAK_LEG_STEPS,
  STREAK_SCALE,
  haloNode,
  lensNode,
  opticsNodes,
  streakNode,
} from "./optics.ts";
import { compileContext, inputResourceId, outputResourceId, readNodePlan } from "./test-support.ts";

/**
 * The optics family on the plan (T1402b). What the pixels do is `optics.gpu.test.ts`; this
 * file pins the SHAPE — which pass reads what, what is scratch, and that every knob is a
 * uniform VALUE (§V5) — because a knob that quietly became structural would rebuild the
 * pipeline on every drag without changing a pixel of the picture.
 */

type Values = Readonly<Record<string, ParameterValue>>;

function compile(
  definition: NodeDefinition,
  parameters: Values = {},
  inputs: ReadonlyArray<string> = ["input"],
  resolution: readonly [number, number] = [200, 100],
) {
  const compiled = definition.compile(compileContext({ inputs, parameters, resolution }));
  // Back through the BACKEND's own plan reader, with the scratch the node declared: a pass
  // the backend refuses is a broken node however right its fields look.
  const read = readNodePlan(compiled.passes, {
    inputs,
    parameters,
    resolution,
    scratch: (compiled.scratch ?? []).map((entry) => entry.key),
  });
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(read.ok).toBe(true);
  return { compiled, passes: compiled.passes as ReadonlyArray<PassDescriptor & { uniforms?: Record<string, unknown> }> };
}

const structure = (passes: ReadonlyArray<PassDescriptor>): string[] => passes.map(passStructureKey);

describe("optics nodes (T1402b)", () => {
  it("register together with no manifest diagnostics", () => {
    for (const definition of opticsNodes) expect(validateNodeDefinition(definition)).toEqual([]);
    expect(createNodeRegistry(opticsNodes).list().map((d) => d.type)).toEqual(["halo", "lens", "streak"]);
  });
});

describe("Streak", () => {
  const ids = (nodeId: string) => ({
    bright: scratchResourceId(nodeId, GLOW_BRIGHT_KEY),
    legs: STREAK_LEG_KEYS.map((key) => scratchResourceId(nodeId, key)),
  });

  it("is ONE node for the project's five passes: extract, three legs, add back", () => {
    const { compiled, passes } = compile(streakNode);
    const { bright, legs } = ids("n1");
    expect(passes.map((pass) => pass.kind === "effect" && pass.target)).toEqual([bright, ...legs, outputResourceId("out")]);
    // Each leg reads the one before it; the first reads the extract; the add reads the last.
    const reads = passes.map((pass) => (pass.kind === "effect" ? pass.textures?.map((t) => t.resourceId) : []));
    expect(reads).toEqual([
      [inputResourceId("input")],
      [bright],
      [legs[0]],
      [legs[1]],
      [inputResourceId("input"), legs[2]],
    ]);
    // All four intermediates at half size: the streak is soft, and the reduction is most of its cost.
    expect(compiled.scratch).toEqual([GLOW_BRIGHT_KEY, ...STREAK_LEG_KEYS].map((key) => ({ key, scale: STREAK_SCALE })));
  });

  it("derives the legs from Length and Angle: steps under each other's span, toward the source", () => {
    const { passes } = compile(streakNode, { length: 0.4, angle: 0, spread: 0.01, tail: 0.1, falloff: 2 });
    const legs = passes.slice(1, 4).map((pass) => pass.uniforms!);
    // Angle 0 rises: every leg gathers from BELOW the pixel (+y in uv), a step of length/160,
    // /48 and /10 — the project's STREAKS ratios.
    expect(legs.map((leg) => leg["gather"])).toEqual(STREAK_LEG_STEPS.map((step) => [-0, 0.4 * step]));
    // Each leg's step is UNDER the span of the leg before (its eight taps reach 7 steps), so
    // the gaps between one leg's taps are filled by the box the previous leg already drew:
    // the three convolve into one column instead of a ladder of copies.
    for (let index = 0; index < 2; index += 1) {
      expect(STREAK_LEG_STEPS[index + 1]!).toBeLessThan(7 * STREAK_LEG_STEPS[index]!);
    }
    // Spread only on the first leg (sideways, in frame widths); the tail only on the last,
    // pointing the other way; only the last leg's weights fall off.
    expect(legs.map((leg) => leg["spread"])).toEqual([[0.01, 0], [0, 0], [0, 0]]);
    expect(legs.map((leg) => leg["back"])).toEqual([[0, 0], [0, 0], [0, -0.1]]);
    expect(legs.map((leg) => leg["decay"])).toEqual([50, 50, 2]);
  });

  it("turns with Angle: 90 streaks to the right, so the gather reads from the LEFT, per frame height", () => {
    const { passes } = compile(streakNode, { length: 0.5, angle: 90 }, ["input"], [200, 100]);
    const gather = passes[3]!.uniforms!["gather"] as number[];
    // Aspect 2: a frame height is half a frame width in uv x.
    expect(gather[0]).toBeCloseTo(-0.5 * STREAK_LEG_STEPS[2] / 2, 12);
    expect(gather[1]).toBeCloseTo(0, 12);
    // The grooves run along the streak, so ACROSS it is now uv y, in frame widths.
    const across = passes[4]!.uniforms!["across"] as number[];
    expect(across[0]).toBeCloseTo(0, 12);
    expect(across[1]).toBeCloseTo(0.5, 12);
  });

  it("thresholds its input by default, and streaks the Bright input instead when one is wired", () => {
    const own = compile(streakNode).passes[0]!;
    expect(own.kind === "effect" && own.textures).toEqual([{ binding: "inputTexture", resourceId: inputResourceId("input") }]);
    expect(own.uniforms!["useBright"]).toBe(0);

    const wired = compile(streakNode, {}, ["input", "bright"]).passes[0]!;
    expect(wired.kind === "effect" && wired.textures).toEqual([{ binding: "inputTexture", resourceId: inputResourceId("bright") }]);
    expect(wired.uniforms!["useBright"]).toBe(1);
  });

  it("gates by source size only when Min Size is turned: the extract reads it, default off (T1422b)", () => {
    // Off by default, so a document saved before the knob existed streaks as it did.
    expect(compile(streakNode).passes[0]!.uniforms!["minSize"]).toBe(0);
    expect(compile(streakNode, { minSize: 3 }).passes[0]!.uniforms!["minSize"]).toBe(3);
    // Halo shares the extract and has no such knob: its gate is always off.
    expect(compile(haloNode, { minSize: 3 }).passes[0]!.uniforms!["minSize"]).toBe(0);
  });

  it("the extract's taps sit a quarter of a HALF-size texel either side of centre", () => {
    const { passes } = compile(streakNode, {}, ["input"], [200, 100]);
    expect(passes[0]!.uniforms!["texel"]).toEqual([1 / 100, 1 / 50]);
  });

  it("every knob is a uniform value: no parameter change moves the structure (§V5)", () => {
    const base = structure(compile(streakNode).passes);
    const turned = structure(
      compile(streakNode, {
        threshold: 3,
        knee: 0.1,
        minSize: 6,
        length: 0.9,
        angle: 33,
        falloff: 9,
        spread: 0.02,
        tail: 0,
        striation: 0,
        striationScale: 12,
        gain: 4,
        tint: [0.2, 0.3, 0.4, 1],
      }).passes,
    );
    expect(turned).toEqual(base);
  });
});

describe("Halo", () => {
  it("extracts and rings at quarter size, then adds back at full size with the glass off", () => {
    const { compiled, passes } = compile(haloNode, { radius: 0.2, width: 0.02, dispersion: 0.1, gain: 2 });
    const bright = scratchResourceId("n1", GLOW_BRIGHT_KEY);
    const ring = scratchResourceId("n1", HALO_RING_KEY);
    expect(passes.map((pass) => pass.kind === "effect" && pass.target)).toEqual([bright, ring, outputResourceId("out")]);
    expect(compiled.scratch).toEqual([GLOW_BRIGHT_KEY, HALO_RING_KEY].map((key) => ({ key, scale: HALO_SCALE })));
    expect(passes[1]!.uniforms).toEqual({ radius: 0.2, width: 0.02, dispersion: 0.1 });
    expect(passes[2]!.uniforms).toEqual({ tint: [1, 1, 1, 1], across: [0, 0], striation: 0, striationScale: 0, gain: 2 });
  });

  it("every knob is a uniform value (§V5)", () => {
    expect(structure(compile(haloNode, { threshold: 9, radius: 0.5, width: 0.1, dispersion: 0.9, gain: 3 }).passes)).toEqual(
      structure(compile(haloNode).passes),
    );
  });
});

describe("Lens", () => {
  it("is one pass whose uniforms are the project's LENS knobs", () => {
    const { passes } = compile(lensNode, { distortion: 0.1, zoomCentre: [0.3, 0.7], vignette: 0.8 });
    expect(passes).toHaveLength(1);
    expect(passes[0]!.uniforms).toEqual({
      zoomCentre: [0.3, 0.7],
      distortion: 0.1,
      edgeBlur: 0.012,
      swirl: 0.6,
      aberration: 0.0015,
      zoomBlur: 0,
      vignette: 0.8,
      vignetteRound: 0.75,
    });
  });
});
