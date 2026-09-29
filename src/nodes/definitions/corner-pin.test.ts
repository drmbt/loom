import { describe, expect, it } from "vitest";

import { validateNodeDefinition } from "../registry/registry.ts";
import {
  IDENTITY_QUAD,
  applyHomography,
  cornerPinNode,
  invertMat3,
  outputToSquare,
  quadDegeneracy,
  squareToQuad,
} from "./corner-pin.ts";
import type { Mat3, Quad } from "./corner-pin.ts";
import { compileContext, readNodePlan } from "./test-support.ts";

/**
 * Corner Pin's homography (T1491b), against cases derived BY HAND in the comments — not by
 * running the solver and pasting what it printed. The pixels are the Dawn test's claim
 * (`corner-pin.gpu.test.ts`); this file pins the arithmetic they rest on.
 */

/** A symmetric keystone: the top edge pulled in to the middle half. */
const KEYSTONE: Quad = [
  [0, 0],
  [1, 0],
  [0.75, 1],
  [0.25, 1],
];

function compile(parameters: Record<string, unknown>) {
  const options = { inputs: ["input"], parameters } as const;
  const compiled = cornerPinNode.compile(compileContext(options as never));
  const read = readNodePlan(compiled.passes, options as never);
  expect(read.ok).toBe(true);
  const pass = read.passes[0];
  if (pass?.kind !== "effect") throw new Error("cornerPin did not emit an effect pass");
  return { pass, diagnostics: compiled.diagnostics ?? [] };
}

describe("the square-to-quad homography (T1491b)", () => {
  it("is the identity, exactly, for the unit square — a fresh node moves nothing", () => {
    expect(squareToQuad(IDENTITY_QUAD)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(outputToSquare(IDENTITY_QUAD)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("is the affine map for a parallelogram: the square doubled and moved by (1, 1)", () => {
    // x = 2u + 1, y = 2v + 1, no perspective row.
    const quad: Quad = [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ];
    expect(squareToQuad(quad)).toEqual([2, 0, 1, 0, 2, 1, 0, 0, 1]);
  });

  it("solves the keystone by hand: x = (u + v/2) / (1 + v), y = 2v / (1 + v)", () => {
    /*
     * Heckbert with the keystone's corners: dx1 = 0.25, dx2 = -0.5, dx3 = -0.5, dy1 = -1,
     * dy2 = 0, dy3 = 0; den = 0.25·0 - (-0.5)(-1) = -0.5; g = 0 / -0.5 = 0;
     * h = (0.25·0 - (-0.5)(-1)) / -0.5 = 1; a = 1, b = 0.25 + 0.25 = 0.5, c = 0, d = 0,
     * e = 1 + 1 = 2, f = 0.
     */
    expect(squareToQuad(KEYSTONE)).toEqual([1, 0.5, 0, 0, 2, 0, 0, 1, 1]);
  });

  it("sends the square's centre to where the quad's DIAGONALS cross — perspective, not bilinear", () => {
    /*
     * A projective map keeps incidence, so the square's centre (where ITS diagonals cross)
     * lands where the quad's diagonals cross. Keystone: (0.75t, t) = (1 - 0.75t, t) gives
     * t = 2/3, so (0.5, 2/3). A two-triangle or bilinear warp puts it at (0.5, 0.5).
     */
    const centre = applyHomography(squareToQuad(KEYSTONE), [0.5, 0.5]);
    expect(centre[0]).toBeCloseTo(0.5, 12);
    expect(centre[1]).toBeCloseTo(2 / 3, 12);
    const back = applyHomography(outputToSquare(KEYSTONE) as Mat3, [0.5, 2 / 3]);
    expect(back[0]).toBeCloseTo(0.5, 12);
    expect(back[1]).toBeCloseTo(0.5, 12);
  });

  it("maps every corner back to its unit-square corner through the inverse", () => {
    const quad: Quad = [
      [0.1, 0.05],
      [0.95, 0.2],
      [0.8, 0.9],
      [0.2, 0.7],
    ];
    const inverse = outputToSquare(quad) as Mat3;
    quad.forEach((corner, index) => {
      const [u, v] = applyHomography(inverse, corner);
      const [eu, ev] = IDENTITY_QUAD[index] as readonly [number, number];
      expect(u).toBeCloseTo(eu, 12);
      expect(v).toBeCloseTo(ev, 12);
    });
  });

  it("signs the inverse so w is positive on the surface, for either winding", () => {
    // Mirrored (rear projection): the quad wound clockwise.
    const mirrored: Quad = [
      [1, 0],
      [0, 0],
      [0.25, 1],
      [0.75, 1],
    ];
    for (const quad of [KEYSTONE, mirrored]) {
      const inverse = outputToSquare(quad) as Mat3;
      const w = inverse[6] * 0.5 + inverse[7] * 0.5 + inverse[8];
      expect(w).toBeGreaterThan(0);
    }
  });

  it("inverts by the adjugate and refuses a singular matrix", () => {
    expect(invertMat3([2, 0, 0, 0, 4, 0, 0, 0, 1])).toEqual([0.5, 0, 0, 0, 0.25, 0, 0, 0, 1]);
    expect(invertMat3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
  });
});

describe("a quad that cannot be pinned (T1491b)", () => {
  it("accepts every strictly convex quad, in either winding", () => {
    expect(quadDegeneracy(IDENTITY_QUAD)).toBeNull();
    expect(quadDegeneracy(KEYSTONE)).toBeNull();
    expect(quadDegeneracy([IDENTITY_QUAD[1], IDENTITY_QUAD[0], IDENTITY_QUAD[3], IDENTITY_QUAD[2]])).toBeNull();
  });

  it("names three corners in a line (zero area)", () => {
    expect(quadDegeneracy([[0, 0], [0.5, 0], [1, 0], [0, 1]])).toMatch(/in a line/);
    expect(quadDegeneracy([[0, 0], [0, 0], [1, 1], [0, 1]])).toMatch(/in a line/);
  });

  it("names a bow-tie (two corners swapped) and a dent (one corner pushed inside)", () => {
    expect(quadDegeneracy([[0, 0], [1, 0], [0, 1], [1, 1]])).toMatch(/self-intersecting or concave/);
    expect(quadDegeneracy([[0, 0], [1, 0], [0.3, 0.3], [0, 1]])).toMatch(/self-intersecting or concave/);
  });
});

describe("the Corner Pin node's plan (T1491b)", () => {
  it("registers cleanly, and a fresh node is the identity with every corner at its default", () => {
    expect(validateNodeDefinition(cornerPinNode)).toEqual([]);
    const { pass, diagnostics } = compile({});
    expect(diagnostics).toEqual([]);
    expect(pass.uniforms).toMatchObject({
      pin0: [1, 0, 0, 0],
      pin1: [0, 1, 0, 0],
      pin2: [0, 0, 1, 0],
      ext0: [1, 0, 0, 0],
      ext1: [0, 1, 0, 0],
      ext2: [0, 0, 1, 0],
      extend: 3,
      valid: 1,
    });
  });

  it("carries the pin quad's inverse and the extract quad's forward map", () => {
    const { pass } = compile({
      pinbl: KEYSTONE[0],
      pinbr: KEYSTONE[1],
      pintr: KEYSTONE[2],
      pintl: KEYSTONE[3],
      extractbl: [0.25, 0.25],
      extractbr: [0.75, 0.25],
      extracttr: [0.75, 0.75],
      extracttl: [0.25, 0.75],
    });
    // Extract: u' = 0.25 + 0.5u, v' = 0.25 + 0.5v, by hand.
    expect(pass.uniforms).toMatchObject({ ext0: [0.5, 0, 0.25, 0], ext1: [0, 0.5, 0.25, 0], ext2: [0, 0, 1, 0] });
    // The keystone's inverse, as the three rows the shader dots with (x, y, 1).
    const rows = ["pin0", "pin1", "pin2"].map((key) => pass.uniforms?.[key] as number[]);
    const inverse = rows.flatMap((row) => row.slice(0, 3)) as unknown as Mat3;
    const [u, v] = applyHomography(inverse, [0.5, 2 / 3]);
    expect(u).toBeCloseTo(0.5, 12);
    expect(v).toBeCloseTo(0.5, 12);
  });

  it("refuses a degenerate pin quad: transparent (valid 0), finite uniforms, a named diagnostic", () => {
    const { pass, diagnostics } = compile({ pinbl: [0, 0], pinbr: [1, 0], pintr: [0, 1], pintl: [1, 1] });
    expect(pass.uniforms?.["valid"]).toBe(0);
    for (const value of Object.values(pass.uniforms ?? {})) {
      for (const entry of [value].flat()) expect(Number.isFinite(entry)).toBe(true);
    }
    expect(diagnostics.map((d) => [d.severity, d.code])).toEqual([["warning", "cornerPin.pin.degenerate"]]);
    expect(diagnostics[0]?.message).toMatch(/self-intersecting or concave/);
  });

  it("refuses a degenerate extract quad by its own code", () => {
    const { pass, diagnostics } = compile({ extracttr: [1, 0] });
    expect(pass.uniforms?.["valid"]).toBe(0);
    expect(diagnostics.map((d) => d.code)).toEqual(["cornerPin.extract.degenerate"]);
  });

  it("puts a picture handle on the four pins and on nothing else", () => {
    const handled = Object.entries(cornerPinNode.parameters)
      .filter(([, definition]) => definition.type === "vector" && definition.handle === "picture")
      .map(([key]) => key);
    expect(handled).toEqual(["pinbl", "pinbr", "pintr", "pintl"]);
  });

  it("marks Feather inactive unless Outside is Transparent (it fades to transparent)", () => {
    const feather = cornerPinNode.parameters["feather"];
    expect(feather?.inactiveWhen?.({ extend: "zero" })).toBeNull();
    expect(feather?.inactiveWhen?.({ extend: "repeat" })).toMatch(/Transparent/);
  });
});
