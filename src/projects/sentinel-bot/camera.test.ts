import { describe, expect, it } from "vitest";
import { ZERO_FRAME, frameFromClock } from "../../domain/types/frame.ts";
import { valueExpressionNode } from "../../nodes/definitions/value-structure-nodes.ts";
import { CAMERA_DEFAULTS, CAMERA_STATEMENTS, SHOTS, SHOT_TABLE, shotAtTurn } from "./camera.ts";

/**
 * T1561b — the camera rig, run through the Expression node that runs it in the document.
 */
function rig(inputs: Record<string, number>, seconds: number): Record<string, number> {
  const evaluate = valueExpressionNode.valueEvaluate;
  if (evaluate === undefined) throw new Error("the Expression node has no evaluator");
  const frame = frameFromClock({ timeSeconds: seconds, deltaSeconds: 1 / 60, frameIndex: Math.round(seconds * 60), mode: ZERO_FRAME.mode, randomSeed: 0, fps: 60 });
  return evaluate({ inputs: { in: inputs }, values: { expressions: CAMERA_STATEMENTS, defaults: CAMERA_DEFAULTS }, frame, state: {} } as never) as Record<string, number>;
}

describe("the sentinel camera", () => {
  /** The bore's narrowest: the ribs' crests at the default radius (tunnel.ts), and the deck below the axis. */
  const RIB_CREST = 2.6 - 0.12;
  const DECK = 2.6 * 0.74;

  it("holds the shot the slider names, and every shot keeps inside the bore and above the deck", () => {
    for (let shot = 0; shot < SHOTS.length; shot += 1) {
      for (let seconds = 0; seconds < 60; seconds += 0.37) {
        const out = rig({ value: seconds * 3.2, shot, cuts: 0, distance: 7.5, viewX: 1.1, viewY: 0.6, bar: 99 }, seconds);
        expect(out["pick"]).toBe(shot);
        // 0.3 m of air between the lens and the nearest steel.
        expect(Math.hypot(out["right"] as number, out["up"] as number)).toBeLessThan(RIB_CREST - 0.3);
        expect(out["up"] as number).toBeGreaterThan(-DECK + 0.3);
      }
    }
  });

  it("circles: that shot rides round the robot with the clock", () => {
    const early = rig({ value: 0, shot: 4, cuts: 0 }, 1);
    const later = rig({ value: 0, shot: 4, cuts: 0 }, 6);
    // 1.5 rad of a 0.3 rad/s circle apart: on the far side of the bore, not parked.
    expect(Math.hypot((later["right"] as number) - (early["right"] as number), (later["up"] as number) - (early["up"] as number))).toBeGreaterThan(1.5);
  });

  it("cuts on every second bar when Cuts is on, visits every shot, and never cuts from a close one to a close one", () => {
    const order: number[] = [];
    for (let bar = 0; bar < 2 * SHOTS.length; bar += 1) {
      const out = rig({ value: 0, shot: 0, cuts: 1, bar }, 0);
      // The pick is the pair of bars it falls in: bars 0 and 1 share a shot, bar 2 is the next.
      expect(out["pick"]).toBe(shotAtTurn(Math.floor(bar / 2)));
      if (bar % 2 === 0) order.push(out["pick"] as number);
    }
    expect(new Set(order).size).toBe(SHOTS.length);
    // A close shot is one that rides with the robot (it would lose it otherwise). Round the whole cycle, wrap included.
    const close = order.map((pick) => (SHOT_TABLE[pick] as (typeof SHOT_TABLE)[number]).ride >= 0.6);
    expect(close.filter(Boolean).length).toBe(4);
    for (let index = 0; index < close.length; index += 1) expect(close[index] === true && close[(index + 1) % close.length] === true).toBe(false);
  });

  it("looks where the shot says: down the tunnel past the robot from behind it, at the robot from anywhere else", () => {
    for (const [index, shot] of SHOT_TABLE.entries()) {
      const out = rig({ value: 10, shot: index, cuts: 0, distance: 7.5 }, 3);
      expect([shot.name, out["aim"], out["ride"], out["lens"]]).toEqual([shot.name, shot.aim, shot.ride, shot.lens]);
      // Behind the robot it looks past it; ahead of it or beside it, back at it.
      if ((out["ahead"] as number) < -1) expect(shot.aim).toBeGreaterThan(3);
      else expect(shot.aim).toBeLessThan(1);
    }
  });

  it("plants the post shot: the camera's place does not move while the robot travels one station's length", () => {
    const places = [0.5, 8, 16, 25].map((travel) => rig({ value: travel, shot: 3, cuts: 0 }, travel)["z"]);
    expect(new Set(places).size).toBe(1);
    // …and the robot does pass it: it starts ahead of the robot and ends behind.
    expect(rig({ value: 0.5, shot: 3, cuts: 0 }, 0)["ahead"] as number).toBeGreaterThan(0);
    expect(rig({ value: 25, shot: 3, cuts: 0 }, 0)["ahead"] as number).toBeLessThan(0);
  });
});
