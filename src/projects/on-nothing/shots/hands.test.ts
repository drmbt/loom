import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../../../domain/expressions/evaluate.ts";
import type { Bone } from "../scene-facts.ts";
import { fingerTurns, handPose, restPalm, skinKernel } from "../skin-kernel.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { axisAngle, apply } from "./gait.ts";
import { handAxes, solveArm, wristOf } from "./hands.ts";

/**
 * T1419b — the hands are only posable if a positive CURL closes a finger toward its own palm
 * (not the back of the hand), SPREAD fans the index and the little finger apart, and an old
 * 19-bone rig still gets the kernel it had. T1407b (hands) — a shot's arm is only stageable if
 * the solver puts the wrist where the take says with the palm the way it says.
 */

type V = [number, number, number];
const L: [string, string | null, V][] = [
  ["shoulder", "chest", [0.0234, 1.4616, 0.0258]], ["upperarm", "shoulder", [0.1906, 1.4317, 0.0196]],
  ["forearm", "upperarm", [0.3632, 1.2339, 0.0184]], ["hand", "forearm", [0.5003, 1.1029, 0.2135]],
  ["thumb1", "hand", [0.5017, 1.0961, 0.2636]], ["thumb2", "thumb1", [0.4782, 1.0871, 0.2875]], ["thumb3", "thumb2", [0.464, 1.073, 0.3235]],
  ["index1", "hand", [0.5313, 1.0611, 0.3216]], ["index2", "index1", [0.5349, 1.0449, 0.3456]], ["index3", "index2", [0.5344, 1.0271, 0.3649]],
  ["middle1", "hand", [0.5497, 1.0479, 0.3023]], ["middle2", "middle1", [0.5578, 1.0195, 0.3264]], ["middle3", "middle2", [0.5608, 0.9963, 0.3464]],
  ["ring1", "hand", [0.5583, 1.0389, 0.2831]], ["ring2", "ring1", [0.5686, 1.0117, 0.3]], ["ring3", "ring2", [0.5736, 0.9888, 0.3152]],
  ["pinky1", "hand", [0.5598, 1.0281, 0.2615]], ["pinky2", "pinky1", [0.5665, 1.007, 0.2709]], ["pinky3", "pinky2", [0.5686, 0.9911, 0.278]],
];

/** The MPFB human's joint table with fingers, as the GLB carries it (glTF metres, facing +Z; measured from the build). */
function rig(fingers = true): Bone[] {
  const rows: [string, string | null, V][] = [["pelvis", null, [0, 0.962, 0.005]], ["spine", "pelvis", [0, 1.051, -0.028]], ["chest", "spine", [0, 1.186, -0.026]], ["neck", "chest", [0, 1.538, 0.013]], ["head", "neck", [0, 1.637, 0.047]]];
  for (const [side, sx] of [["L", 1], ["R", -1]] as const) {
    for (const [name, parent, head] of L) {
      if (!fingers && /\d$/.test(name)) continue;
      rows.push([`${name}.${side}`, parent === "chest" ? "chest" : `${parent}.${side}`, [head[0] * sx, head[1], head[2]]]);
    }
  }
  const index = new Map(rows.map(([name], i) => [name, i]));
  return rows.map(([name, parent, head], i) => ({ index: i, name, parent: parent === null ? -1 : index.get(parent)!, head }));
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const unit = (a: V): V => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

describe("T1419b: the finger knobs", () => {
  const bones = rig();
  const named = (name: string): Bone => bones.find((b) => b.name === name)!;
  const turns = fingerTurns(bones);

  it("the palm faces the thigh at rest (the A-pose's palms face the midline)", () => {
    expect(restPalm(bones, "L")[0]).toBeLessThan(-0.5);
    expect(restPalm(bones, "R")[0]).toBeGreaterThan(0.5);
  });

  for (const side of ["L", "R"] as const) {
    it(`a positive curl closes every long finger of ${side} toward its palm, never the back of the hand`, () => {
      const palm = restPalm(bones, side);
      for (const finger of ["index", "middle", "ring", "pinky"]) {
        const bone = named(`${finger}1.${side}`);
        const curl = turns.get(bone.index)!.find((turn) => turn.knob.startsWith("curl"))!;
        const d = unit(sub(named(`${finger}2.${side}`).head, bone.head));
        const bent = apply(axisAngle(curl.axis, 0.8 * curl.share), d);
        expect(dot(bent, palm)).toBeGreaterThan(dot(d, palm) + 0.3);
      }
    });

    it(`spread fans ${side}'s index and little finger apart`, () => {
      const across = sub(named(`index1.${side}`).head, named(`pinky1.${side}`).head);
      const moved = (finger: string): number => {
        const bone = named(`${finger}1.${side}`);
        const spread = turns.get(bone.index)!.find((turn) => turn.knob.startsWith("spread"))!;
        const d = unit(sub(named(`${finger}2.${side}`).head, bone.head));
        return dot(sub(apply(axisAngle(spread.axis, 0.3 * spread.share), d), d), across);
      };
      expect(moved("index")).toBeGreaterThan(0);
      expect(moved("pinky")).toBeLessThan(0);
    });
  }

  it("the kernel walks the ten-deep finger chain and declares the hand knobs; a rig without fingers keeps its old kernel", () => {
    const facts = { bones } as unknown as OnNothingFacts;
    const kernel = skinKernel(facts);
    expect(kernel).toContain("level < 12u");
    for (const knob of ["curlL: vec4f", "spreadR: f32", "thumbL: vec2f", "fingerTurn(u32(j), ctx)"]) expect(kernel).toContain(knob);
    const old = skinKernel({ bones: rig(false) } as unknown as OnNothingFacts);
    expect(old).not.toContain("curlL");
    expect(old).not.toContain("fingerTurn");
  });

  it("handPose's point straightens the index out of the curl and leaves the others curled", () => {
    const pose = handPose("R", { curl: 1.4, point: 1 });
    const value = (source: string): number => {
      const result = evaluateExpression(source, { abstime: 0 });
      if (!result.ok) throw new Error(result.reason);
      return result.value;
    };
    expect(value(pose["curlR.x"]!)).toBe(0);
    expect(value(pose["curlR.y"]!)).toBeCloseTo(1.4, 9);
    expect(value(pose["curlR.w"]!)).toBeCloseTo(1.4, 9);
  });
});

describe("T1407b (hands): the arm solver", () => {
  const bones = rig();
  const at = { place: [-60, 0, 0] as const, yaw: 0.9 };
  const toWorld = (p: V): V => [at.place[0] + Math.cos(at.yaw) * p[0] + Math.sin(at.yaw) * p[2], p[1], -Math.sin(at.yaw) * p[0] + Math.cos(at.yaw) * p[2]];

  it("puts a reachable wrist on its goal with the palm the way the take asks — and the palm, not the back of the hand", () => {
    const goal = { wrist: toWorld([-0.1, 1.45, 0.2]), point: [0, 1, 0] as V, palm: toWorld([1, 0, 0]).map((v, i) => v - [at.place[0], 0, 0][i]!) as V };
    const pose = solveArm(bones, "R", goal, at);
    const wrist = wristOf(bones, "R", pose, at);
    expect(Math.hypot(...sub(wrist, goal.wrist))).toBeLessThan(0.01);
    const axes = handAxes(bones, "R", pose, at);
    expect(dot(axes.palm, unit(goal.palm))).toBeGreaterThan(0.85);
    expect(dot(axes.point, goal.point)).toBeGreaterThan(0.85);
  });
});
