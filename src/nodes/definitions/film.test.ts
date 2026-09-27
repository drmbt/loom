import { describe, expect, it } from "vitest";

import type { ParameterValue } from "../../domain/types/parameters.ts";
import { passStructureKey } from "../../runtime/backend/plan.ts";
import type { PassDescriptor } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { crtNode, filmGradeNode, filmNodes } from "./film.ts";
import { compileContext, readNodePlan } from "./test-support.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";

/**
 * Film Grade and CRT on the plan (T1402b). Pixels: `film.gpu.test.ts`. Here: both are one
 * pass that binds the shared frame block (their noise moves per frame, so the idle skip
 * must not freeze them), and no knob is structural (§V5).
 */

type Values = Readonly<Record<string, ParameterValue>>;

function pass(definition: NodeDefinition, parameters: Values = {}) {
  const compiled = definition.compile(compileContext({ inputs: ["input"], parameters }));
  const read = readNodePlan(compiled.passes, { inputs: ["input"], parameters });
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(read.ok).toBe(true);
  expect(compiled.passes).toHaveLength(1);
  return compiled.passes[0] as PassDescriptor & { uniforms?: Record<string, unknown>; sharedBinding?: string };
}

describe("film nodes (T1402b)", () => {
  it("register together with no manifest diagnostics", () => {
    for (const definition of filmNodes) expect(validateNodeDefinition(definition)).toEqual([]);
    expect(createNodeRegistry(filmNodes).list().map((d) => d.type)).toEqual(["crt", "filmGrade"]);
  });

  it("both bind the shared frame block, so a plan holding one is never idle-skipped", () => {
    expect(pass(filmGradeNode).sharedBinding).toBe("frameU");
    expect(pass(crtNode).sharedBinding).toBe("frameU");
  });

  it("Film Grade defaults to the On Nothing look, knob for knob", () => {
    expect(pass(filmGradeNode).uniforms).toEqual({
      highlightTint: [1, 1, 1, 1],
      shadowTint: [1, 1, 1, 1],
      exposure: 0,
      black: 0.035,
      contrast: 1.25,
      saturation: 0.28,
      keepWarm: 0.5,
      bleach: 0.35,
      split: 0.5,
      lift: 0,
      grain: 0.03,
      grainSize: 1.3,
    });
  });

  it("no knob on either is structural (§V5)", () => {
    const grade = {
      exposure: 1,
      black: 0.1,
      contrast: 2,
      saturation: 1,
      keepWarm: 0,
      bleach: 1,
      highlightTint: [0.5, 1, 1.5, 1],
      shadowTint: [1, 0.5, 1, 1],
      split: 1,
      lift: 0.2,
      grain: 0,
      grainSize: 4,
    };
    expect(passStructureKey(pass(filmGradeNode, grade))).toBe(passStructureKey(pass(filmGradeNode)));
    const crt = { amount: 0, lines: 100, curvature: 0.5, mask: 1, maskPitch: 6, glow: 2, jitter: 0, gain: 2 };
    expect(passStructureKey(pass(crtNode, crt))).toBe(passStructureKey(pass(crtNode)));
  });
});
