import { describe, expect, it } from "vitest";

import { decodeGlb, GlbDecodeError } from "./glb.ts";
import { cubePrimitive, encodeFixtureGlb } from "./glb.fixture.ts";

/**
 * T1581b — the FRAME a selection is decoded in. A mesh that is going to be drawn at every
 * point of a pointset has to arrive in its own frame: the decoder's default bakes each
 * node's world transform in, which is right for a set and puts an instance shape ten metres
 * off every point when the file placed it ten metres from the origin.
 *
 * Every expectation is derived by hand from the fixture, never read off the decoder.
 */

const SQRT1_2 = Math.SQRT1_2;

/**
 * A rig at (0, 2, 0) that is a part ("arm"), holding a ring at (1, 0, 0) inside it turned a
 * quarter about Z, and a cap beside the ring. A loose crate elsewhere at the root.
 */
const GLB = encodeFixtureGlb({
  nodes: [
    {
      name: "rig",
      translation: [0, 2, 0],
      extras: { loom_part: "arm" },
      children: [
        { name: "ring", translation: [1, 0, 0], rotation: [0, 0, SQRT1_2, SQRT1_2], scale: [2, 1, 1], mesh: [cubePrimitive()] },
        { name: "cap", translation: [3, 0, 0], mesh: [cubePrimitive()] },
      ],
    },
    { name: "crate", translation: [10, 0, 5], mesh: [cubePrimitive()] },
    { name: "claw", translation: [-4, 0, 0], extras: { loom_part: "claw" }, mesh: [cubePrimitive()] },
  ],
});

const bounds = (mesh: ReturnType<typeof decodeGlb>): number[][] => [mesh.bounds.min.map((v) => Math.round(v * 1e6) / 1e6), mesh.bounds.max.map((v) => Math.round(v * 1e6) / 1e6)];

describe("the frame a selection is decoded in (T1581b)", () => {
  it("World is the file's placement, as it always was", () => {
    // The ring: ±1 along its own X turned onto world Y, ±0.5 on the others, at (1, 2, 0).
    const ring = decodeGlb(GLB, { select: "ring" });
    expect(bounds(ring)).toEqual([[0.5, 1, -0.5], [1.5, 3, 0.5]]);
    expect(ring.frame).toBeUndefined();
    expect(Array.from(decodeGlb(GLB, { select: "ring", frame: "world" }).positions)).toEqual(Array.from(ring.positions));
  });

  it("Object is one object's own frame: its authored vertices, exactly, wherever the file put it", () => {
    const ring = decodeGlb(GLB, { select: "ring", frame: "object" });
    // The authored unit cube: not the turn, not the ×2, not the place.
    expect(Array.from(ring.positions)).toEqual(cubePrimitive().positions);
    expect(Array.from(ring.normals)).toEqual(cubePrimitive().normals);
    // The file's placement is not lost: the frame node and where it stands in the world.
    expect(ring.frame?.node).toBe("ring");
    expect(ring.frame?.origin.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 2, 0]);
    // The crate, ten metres away in the file, is the same cube about its own origin.
    expect(Array.from(decodeGlb(GLB, { select: "crate", frame: "object" }).positions)).toEqual(cubePrimitive().positions);
  });

  it("Object over several objects is the lowest node that holds them all", () => {
    // Ring and cap share the rig: relative to it the ring is at (1, 0, 0) and the cap at (3, 0, 0).
    const pair = decodeGlb(GLB, { select: "ring cap", frame: "object" });
    expect(pair.frame?.node).toBe("rig");
    expect(bounds(pair)).toEqual([[0.5, -1, -0.5], [3.5, 1, 0.5]]);
    // Nothing holds the ring and the crate together but the scene itself: the world, and it says so.
    const apart = decodeGlb(GLB, { select: "ring crate", frame: "object" });
    expect(apart.frame).toBeUndefined();
    expect(apart.warnings.some((warning) => warning.includes("Frame: Object") && warning.includes("rig") && warning.includes("crate"))).toBe(true);
    expect(Array.from(apart.positions)).toEqual(Array.from(decodeGlb(GLB, { select: "ring crate" }).positions));
  });

  it("Part is the part's frame: its pivot is the origin", () => {
    // The ring alone, in its part's frame: where it sits inside the arm, the rig's own place removed.
    const ring = decodeGlb(GLB, { select: "ring", frame: "part" });
    expect(ring.frame?.node).toBe("rig");
    expect(ring.frame?.origin).toEqual([0, 2, 0]);
    expect(bounds(ring)).toEqual([[0.5, -1, -0.5], [1.5, 1, 0.5]]);
    // The whole part by its name.
    expect(bounds(decodeGlb(GLB, { select: "part:arm", frame: "part" }))).toEqual([[0.5, -1, -0.5], [3.5, 1, 0.5]]);
  });

  it("Part refuses a selection that is not inside one part, and NAMES what it found", () => {
    // A glob over parts hits two of them: both are named.
    expect(() => decodeGlb(GLB, { select: "part:*", frame: "part" })).toThrowError(/it lies in 2 parts: arm, claw\. Narrow Select to one part/);
    // No part at all.
    expect(() => decodeGlb(GLB, { select: "crate", frame: "part" })).toThrowError(/it lies in object crate in no part/);
    // A part and something loose.
    expect(() => decodeGlb(GLB, { select: "ring crate", frame: "part" })).toThrowError(/it lies in part arm, and object crate in no part/);
    expect(() => decodeGlb(GLB, { select: "crate", frame: "part" })).toThrowError(GlbDecodeError);
  });
});
