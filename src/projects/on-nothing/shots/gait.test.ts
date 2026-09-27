import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../../../domain/expressions/evaluate.ts";
import type { Bone } from "../scene-facts.ts";
import { NORMAL_WALK, armPose, boneNamed, keyedExpression, keyedValue, posePoint, walkExpressions, type Pose, type Vec3 } from "./gait.ts";

/**
 * T1407b (cyc) — the walk is only worth its machinery if a planted shoe STAYS planted and the
 * figure never floats or sinks: a sliding foot is the tell of a procedural walk. These run the
 * EMITTED expressions through the real expression evaluator and the kernel's kinematics, so a
 * sign slip in the fit, the root solve or the expression text fails here, not in a render.
 */

/** The MPFB human's joint table as the GLB carries it (glTF metres, facing +Z). */
const BONES: Bone[] = [
  ["pelvis", -1, [0, 0.962, 0.005]], ["spine", 0, [0, 1.051, -0.028]], ["chest", 1, [0, 1.186, -0.026]],
  ["neck", 2, [0, 1.538, 0.013]], ["head", 3, [0, 1.637, 0.047]],
  ["shoulder.L", 2, [0.023, 1.462, 0.026]], ["upperarm.L", 5, [0.191, 1.432, 0.02]], ["forearm.L", 6, [0.363, 1.234, 0.018]], ["hand.L", 7, [0.5, 1.103, 0.213]],
  ["shoulder.R", 2, [-0.023, 1.462, 0.026]], ["upperarm.R", 9, [-0.191, 1.432, 0.02]], ["forearm.R", 10, [-0.363, 1.234, 0.018]], ["hand.R", 11, [-0.5, 1.103, 0.213]],
  ["thigh.L", 0, [0.111, 0.956, -0.006]], ["shin.L", 13, [0.155, 0.517, 0.029]], ["foot.L", 14, [0.202, 0.074, 0.015]],
  ["thigh.R", 0, [-0.111, 0.956, -0.006]], ["shin.R", 16, [-0.155, 0.517, 0.029]], ["foot.R", 17, [-0.202, 0.074, 0.015]],
].map(([name, parent, head], index) => ({ index, name: name as string, parent: parent as number, head: head as [number, number, number] }));

const evaluate = (source: string, t: number): number => {
  const result = evaluateExpression(source, { abstime: t });
  if (!result.ok) throw new Error(`${result.reason} in ${source.slice(0, 80)}`);
  return result.value;
};

/** Pose and root at time t, read back from the emitted expressions only. */
function sampleWalk(walk: ReturnType<typeof walkExpressions>, t: number): { pose: Pose; root: Vec3 } {
  const pose: Record<string, [number, number, number]> = {};
  for (const [key, source] of Object.entries(walk.knobs)) {
    const [bone, axis] = key.split(".") as [string, "x" | "y" | "z"];
    pose[bone] ??= [0, 0, 0];
    pose[bone]![{ x: 0, y: 1, z: 2 }[axis]] = evaluate(source, t);
  }
  return { pose, root: [evaluate(walk.root.x, t), evaluate(walk.root.y, t), evaluate(walk.root.z, t)] };
}

describe("the walk", () => {
  const walk = walkExpressions(BONES, NORMAL_WALK);
  const period = NORMAL_WALK.period / NORMAL_WALK.rate;
  const shoe = (side: "L" | "R"): Vec3[] => {
    const ankle = boneNamed(BONES, `foot.${side}`).head;
    return [[ankle[0], 0, ankle[2] - 0.06], [ankle[0], 0, ankle[2] + 0.12]];
  };
  const steps = 240;
  const track = Array.from({ length: steps + 1 }, (_, i) => {
    const t = (i / steps) * period;
    const { pose, root } = sampleWalk(walk, t);
    const at = (side: "L" | "R"): [number, number, number][] =>
      shoe(side).map((p) => {
        const q = posePoint(BONES, pose, boneNamed(BONES, `foot.${side}`).index, p);
        return [q[0] + root[0], q[1] + root[1], q[2] + root[2]];
      });
    return { L: at("L"), R: at("R") };
  });

  it("strides like a person: 1.1–1.6 m a stride at the normal cadence", () => {
    expect(walk.strideLength).toBeGreaterThan(1.1);
    expect(walk.strideLength).toBeLessThan(1.6);
  });

  it("keeps a shoe on the floor all the time, and never through it", () => {
    for (const frame of track) {
      const lowest = Math.min(...[...frame.L, ...frame.R].map((p) => p[1]));
      expect(Math.abs(lowest)).toBeLessThan(0.012);
    }
  });

  it("does not skate a planted shoe", () => {
    // A heel lands with some speed and settles within a centimetre or two, as a real heel
    // does; after that a shoe point on the floor stays where it touched down until it lifts
    // (to the fit's ripple: under 2 mm a 240th of a stride, a pixel in the leg close-up).
    const anchor = new Map<string, { at: readonly number[]; since: number }>();
    let locked = 0;
    track.forEach((frame, i) => {
      for (const side of ["L", "R"] as const) {
        frame[side].forEach((p, k) => {
          const key = `${side}${k}`;
          if (p[1] >= 0.001) {
            anchor.delete(key);
            return;
          }
          const first = anchor.get(key) ?? { at: p, since: i };
          anchor.set(key, first);
          const drift = Math.hypot(p[0] - first.at[0]!, p[2] - first.at[2]!);
          expect(drift).toBeLessThan(0.02);
          if (i - first.since > steps * 0.04) {
            locked++;
            const q = track[i - 1]![side][k]!;
            expect(Math.hypot(p[0] - q[0], p[2] - q[2])).toBeLessThan(0.002);
          }
        });
      }
    });
    // …and it is not vacuous: shoes are locked to the floor through most of the stride.
    expect(locked).toBeGreaterThan(steps * 0.6);
  });
});

describe("arms are aimed, not guessed", () => {
  const hand = (pose: Pose, side: "L" | "R"): [number, number, number] => posePoint(BONES, pose, boneNamed(BONES, `forearm.${side}`).index, boneNamed(BONES, `hand.${side}`).head);
  const elbow = (pose: Pose, side: "L" | "R"): [number, number, number] => posePoint(BONES, pose, boneNamed(BONES, `upperarm.${side}`).index, boneNamed(BONES, `forearm.${side}`).head);
  const shoulder = boneNamed(BONES, "upperarm.R").head;

  it("hangs at the side with no flex, swings ahead at 90, points up at 180", () => {
    const down = elbow(armPose(BONES, "R", { flex: 0, out: 0, elbow: 0 }), "R");
    expect(down[1]).toBeLessThan(shoulder[1] - 0.25);
    expect(Math.abs(down[2] - shoulder[2])).toBeLessThan(0.02);
    const ahead = elbow(armPose(BONES, "R", { flex: 90, out: 0, elbow: 0 }), "R");
    expect(ahead[2]).toBeGreaterThan(shoulder[2] + 0.25);
    expect(Math.abs(ahead[1] - shoulder[1])).toBeLessThan(0.03);
    const up = elbow(armPose(BONES, "R", { flex: 180, out: 0, elbow: 0 }), "R");
    expect(up[1]).toBeGreaterThan(shoulder[1] + 0.25);
  });

  it("bends the forearm across the chest with inward rotation, for either arm", () => {
    for (const [side, across] of [["R", 1], ["L", -1]] as const) {
      const pose = armPose(BONES, side, { flex: 60, out: 0, elbow: 90, inward: 90 });
      const e = elbow(pose, side);
      const h = hand(pose, side);
      // the hand is toward the OTHER side of the body than the elbow
      expect((h[0] - e[0]) * across).toBeGreaterThan(0.15);
    }
  });
});

describe("keyed performance curves", () => {
  it("pass through every key, hold outside them, and the expression agrees with the TypeScript", () => {
    const keys = [[0, 0.2], [0.4, 1], [0.9, -0.3], [1.5, 0.5]] as const;
    const source = keyedExpression(keys);
    for (const [t, v] of keys) expect(evaluate(source, t)).toBeCloseTo(v, 4);
    expect(evaluate(source, -1)).toBeCloseTo(0.2, 4);
    expect(evaluate(source, 3)).toBeCloseTo(0.5, 4);
    for (let t = 0; t <= 1.5; t += 0.05) expect(evaluate(source, t)).toBeCloseTo(keyedValue(keys, t), 4);
  });
});
