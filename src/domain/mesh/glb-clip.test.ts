import { describe, expect, it } from "vitest";

import { decodeGlb, type DecodedPose } from "./glb.ts";
import { cubePrimitive, encodeFixtureGlb, type FixtureAnimation, type FixtureScene } from "./glb.fixture.ts";

/**
 * T1410b — glTF ANIMATION CLIPS baked into per-joint poses by the decoder. Every expected
 * number is the glTF definition worked by hand: a pose is the joint's animated world times
 * its rest world's inverse, so applying it to a rest-placed vertex is where glTF skinning
 * puts that vertex at that time.
 */

const Q90Z = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

/** An armature node over two joints: `root` at the origin, `arm` 0.5 m out along +x; a bound cube. */
function rig(animations: ReadonlyArray<FixtureAnimation>): FixtureScene {
  const count = cubePrimitive(0).positions.length / 3;
  return {
    materials: [{ name: "grey" }],
    skins: [{ joints: ["root", "arm"], inverseBindMatrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, 0, 0, 1]] }],
    nodes: [
      { name: "armature", children: [{ name: "root", children: [{ name: "arm", translation: [0.5, 0, 0] }] }] },
      {
        name: "body",
        skin: 0,
        mesh: [{ ...cubePrimitive(0), joints: Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), weights: Array.from({ length: count }, () => [1, 0, 0, 0]).flat() }],
      },
    ],
    animations,
  };
}

/** The delta of table joint `joint` at `frame`, applied to point p. */
function apply(pose: DecodedPose, frame: number, joint: number, joints: number, p: readonly [number, number, number]): number[] {
  const at = (frame * joints + joint) * 12;
  return [0, 1, 2].map((row) => {
    const r = pose.table.subarray(at + row * 4, at + row * 4 + 4);
    return Math.round(((r[0] as number) * p[0] + (r[1] as number) * p[1] + (r[2] as number) * p[2] + (r[3] as number)) * 1e5) / 1e5 + 0;
  });
}

const WAVE: FixtureAnimation = {
  name: "wave",
  channels: [{ node: "arm", path: "rotation", times: [0, 1], values: [0, 0, 0, 1, ...Q90Z] }],
};

describe("decodeGlb animation clips (T1410b)", () => {
  it("lists the file's clips, and bakes the named one at the asked rate, keys held past the ends", () => {
    const glb = encodeFixtureGlb(rig([WAVE, { name: "idle", channels: [{ node: "root", path: "translation", times: [0], values: [0, 0, 0] }] }]));
    expect(decodeGlb(glb).clips).toEqual(["wave", "idle"]);
    expect(decodeGlb(glb).skin?.pose).toBeUndefined();
    const pose = decodeGlb(glb, { clip: "wave", clipRate: 4 }).skin!.pose!;
    expect([pose.clip, pose.rate, pose.frames, pose.duration]).toEqual(["wave", 4, 5, 1]);
    expect(pose.table.length).toBe(5 * 2 * 12);
  });

  it("slerps a LINEAR rotation: the arm turns about its own head, 45 degrees at half time, and the root stays put", () => {
    const pose = decodeGlb(encodeFixtureGlb(rig([WAVE])), { clip: "wave", clipRate: 4 }).skin!.pose!;
    // (2, 0, 0) is 1.5 m out from the arm's head at (0.5, 0, 0).
    expect(apply(pose, 0, 1, 2, [2, 0, 0])).toEqual([2, 0, 0]);
    const c = Math.round((0.5 + 1.5 * Math.SQRT1_2) * 1e5) / 1e5;
    const s = Math.round(1.5 * Math.SQRT1_2 * 1e5) / 1e5;
    expect(apply(pose, 2, 1, 2, [2, 0, 0])).toEqual([c, s, 0]);
    expect(apply(pose, 4, 1, 2, [2, 0, 0])).toEqual([0.5, 1.5, 0]);
    // The head itself does not move, and the unanimated root is the identity at every frame.
    expect(apply(pose, 3, 1, 2, [0.5, 0, 0])).toEqual([0.5, 0, 0]);
    for (let frame = 0; frame < 5; frame += 1) expect(apply(pose, frame, 0, 2, [2, 3, 4])).toEqual([2, 3, 4]);
  });

  it("holds a STEP key, and runs a CUBICSPLINE translation through its Hermite form", () => {
    const step = decodeGlb(encodeFixtureGlb(rig([{ name: "hop", channels: [{ node: "root", path: "translation", times: [0, 1], values: [0, 0, 0, 0, 1, 0], interpolation: "STEP" }] }])), { clip: "hop", clipRate: 4 }).skin!.pose!;
    expect([0, 1, 2, 3, 4].map((frame) => apply(step, frame, 0, 2, [0, 0, 0])[1])).toEqual([0, 0, 0, 0, 1]);
    // Zero tangents: the value at u is p0 + (3u² − 2u³)(p1 − p0); at u = 0.25 that is 0.15625.
    const cubic = decodeGlb(
      encodeFixtureGlb(rig([{ name: "rise", channels: [{ node: "root", path: "translation", times: [0, 1], values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], interpolation: "CUBICSPLINE" }] }])),
      { clip: "rise", clipRate: 4 },
    ).skin!.pose!;
    expect([0, 1, 2, 3, 4].map((frame) => apply(cubic, frame, 0, 2, [0, 0, 0])[1])).toEqual([0, 0.15625, 0.5, 0.84375, 1]);
  });

  it("moves the joints under an animated node that is not a joint (the armature object)", () => {
    const pose = decodeGlb(encodeFixtureGlb(rig([{ name: "slide", channels: [{ node: "armature", path: "translation", times: [0, 1], values: [0, 0, 0, 2, 0, 0] }] }])), { clip: "slide", clipRate: 2 }).skin!.pose!;
    expect(apply(pose, 1, 0, 2, [0, 0, 0])).toEqual([1, 0, 0]);
    expect(apply(pose, 2, 1, 2, [2, 0, 0])).toEqual([4, 0, 0]);
  });

  it("refuses a clip the file does not have, naming the ones it does, and a clip over an unskinned selection", () => {
    const glb = encodeFixtureGlb(rig([WAVE]));
    expect(() => decodeGlb(glb, { clip: "run" })).toThrowError(/no animation "run"; it holds "wave"/);
    const plain = encodeFixtureGlb({ nodes: [{ name: "box", mesh: [cubePrimitive()] }, { name: "spinner" }], animations: [{ name: "spin", channels: [{ node: "spinner", path: "rotation", times: [0], values: [0, 0, 0, 1] }] }] });
    expect(() => decodeGlb(plain, { clip: "spin" })).toThrowError(/selection holds nothing skinned/);
  });
});
