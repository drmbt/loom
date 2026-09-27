import type { StoredParameter } from "../../../domain/types/parameters.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { boneParam } from "../skin-kernel.ts";
import { knob } from "./plate.ts";
import { standingLegs } from "./gait.ts";

/**
 * T1407b (split/mirror) — the figure's poses for the split and mirror shots, as skin-kernel
 * knobs (see skin-kernel.ts: Euler radians about the REST axes, x = the figure's left, y = up,
 * z = the way it faces; a negative x swings a limb forward). Every bone gets a knob, so no
 * knob of a stock performance survives into these shots.
 */
function pose(facts: OnNothingFacts, values: Record<string, string | number>): Record<string, StoredParameter> {
  const known = new Set(facts.bones.map(boneParam));
  const out: Record<string, StoredParameter> = {};
  for (const bone of known) out[bone] = [0, 0, 0];
  for (const [key, value] of Object.entries(values)) {
    const [bone, axis] = key.split(".");
    if (bone === undefined || !known.has(bone) || axis === undefined) throw new Error(`poses: no bone knob "${key}".`);
    out[key] = knob(value);
  }
  return out;
}

/**
 * The split's floor plate (0:27.6): standing square to the lens, feet together, arms down. The
 * right foot (screen left) SHUFFLES: it slides out and toward the lens over the reference's
 * 1.3 s, lifting a few centimetres mid-slide, and back over the next 1.3 s, on and on — the
 * plate never freezes, however long the clip. The weight rolls onto the planted left leg and
 * the planted foot's heel rocks with it, so the shadows keep moving.
 */
export function standingPose(facts: OnNothingFacts): Record<string, StoredParameter> {
  const period = 2.6;
  const w = (2 * Math.PI / period).toFixed(4);
  const slide = `(0.5 - 0.5 * cos(abstime * ${w}))`;
  const lift = `(sin(abstime * ${w}) ^ 2)`;
  const rock = `sin(abstime * ${w} - 0.6)`;
  // The base: the cyc's standing legs (shots/gait.ts) — ankles 9 cm off the midline, the feet
  // kept FLAT under the hips (the rest A-pose splays them), the weight on the left leg.
  const legs = standingLegs(facts.bones, 0.09, 0.3, 10);
  const at = (bone: string, axis: 0 | 1 | 2): number => legs[bone]?.[axis] ?? 0;
  const plus = (bone: string, axis: 0 | 1 | 2, delta: string): string => `${at(bone, axis).toFixed(4)} + ${delta}`;
  const values: Record<string, string | number> = {
    "upperarmL.z": -0.62,
    "upperarmR.z": 0.62,
    "forearmL.x": -0.12,
    "forearmR.x": -0.12,
  };
  for (const [bone, angles] of Object.entries(legs)) angles.forEach((value, axis) => { values[`${bone}.${"xyz"[axis]}`] = value; });
  // the right foot's shuffle, on top: out, toward the lens, lifting mid-slide, and back
  values["thighR.z"] = plus("thighR", 2, `-0.14 * ${slide}`);
  values["thighR.x"] = plus("thighR", 0, `-0.1 * ${slide} - 0.18 * ${lift}`);
  values["shinR.x"] = plus("shinR", 0, `0.06 * ${slide} + 0.3 * ${lift}`);
  values["footR.x"] = plus("footR", 0, `0.04 * ${slide} - 0.1 * ${lift}`);
  values["footR.z"] = plus("footR", 2, `0.14 * ${slide}`);
  values["footR.y"] = plus("footR", 1, `-0.3 * ${slide}`);
  values["footL.x"] = plus("footL", 0, `0.04 * ${rock}`);
  values["pelvis.z"] = plus("pelvis", 2, `0.03 * ${slide}`);
  values["pelvis.y"] = plus("pelvis", 1, `0.05 * ${rock}`);
  return pose(facts, values);
}

/**
 * The mirror plate (1:23): the left fist raised before the mouth, the pyramid ring square to
 * the lens, the thumb out. The arm is SOLVED against the GLB's rest hand (elbow and wrist
 * places, the stone's normal toward the lens; the solver lives in the session's scratchpad,
 * its result is these numbers). The wrist rolls and the forearm breathes on a 1.9 s cycle, so
 * the thumbs open and close at the seam and a clip of any length keeps moving.
 */
export function handUpPose(facts: OnNothingFacts): Record<string, StoredParameter> {
  const breathe = "(sin(abstime * 3.3) * 0.035 + sin(abstime * 1.3 + 0.7) * 0.02)";
  return pose(facts, {
    "upperarmR.z": 0.62,
    "upperarmL.x": -0.559,
    "upperarmL.y": -1.356,
    "upperarmL.z": 0.576,
    "forearmL.x": `-1.37 - ${breathe}`,
    "forearmL.y": 0.122,
    "forearmL.z": 0.565,
    "handL.x": 0.337,
    "handL.y": 1.131,
    "handL.z": `0.252 + ${breathe}`,
    "neck.x": 0.05,
  });
}
