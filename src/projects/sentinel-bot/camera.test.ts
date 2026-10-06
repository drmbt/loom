import { describe, expect, it } from "vitest";
import { PACK } from "./document.ts";
import { ZERO_FRAME, frameFromClock } from "../../domain/types/frame.ts";
import { valueExpressionNode } from "../../nodes/definitions/value-structure-nodes.ts";
import { CAMERA_DEFAULTS, CAMERA_STATEMENTS, FIELD_ORDER, PACK_ORDER, SHOTS, SHOT_TABLE, SWIMMING_ORDER, WALKING_ORDER, shotAtTurn, type Shot } from "./camera.ts";
import { FIELD } from "./field.ts";
import { CHAMBERS } from "./path.ts";
import { FIELD_BERTH } from "./rig.ts";

/**
 * T1561b — the camera rig, run through the Expression node that runs it in the document.
 */
function rig(inputs: Record<string, number>, seconds: number): Record<string, number> {
  const evaluate = valueExpressionNode.valueEvaluate;
  if (evaluate === undefined) throw new Error("the Expression node has no evaluator");
  const frame = frameFromClock({ timeSeconds: seconds, deltaSeconds: 1 / 60, frameIndex: Math.round(seconds * 60), mode: ZERO_FRAME.mode, randomSeed: 0, fps: 60 });
  return evaluate({ inputs: { in: inputs }, values: { expressions: CAMERA_STATEMENTS, defaults: CAMERA_DEFAULTS }, frame, state: {} } as never) as Record<string, number>;
}

/**
 * Bodies seen through a shot's own camera: all in the frame, and no two nearer each other ACROSS the picture
 * than a body is wide (0.85 m, at the distance of the nearer one), so neither hides the other. (A first
 * version asked only for a tenth of the frame between centres, and passed a shot in which one robot stood
 * behind another.)
 */
function expectAllSeenApart(shot: Shot, out: Record<string, number>, bodies: ReadonlyArray<readonly [number, number, number]>): void {
  const eye = [out["right"] as number, out["up"] as number, out["ahead"] as number] as const;
  const forward = [0 - eye[0], 0 - eye[1], shot.aim - eye[2]] as const;
  const length = Math.hypot(...forward);
  const f = forward.map((value) => value / length) as [number, number, number];
  // Camera right and up from the world's up, as the Camera node builds them.
  const flat = Math.hypot(f[0], f[2]);
  const r = [f[2] / flat, 0, -f[0] / flat] as const;
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]] as const;
  const half = Math.tan(((shot.lens / 2) * Math.PI) / 180);
  const seen = bodies.map((body) => {
    const to = [body[0] - eye[0], body[1] - eye[1], body[2] - eye[2]] as const;
    const depth = to[0] * f[0] + to[1] * f[1] + to[2] * f[2];
    return { depth, across: to[0] * r[0] + to[2] * r[2], up: to[0] * u[0] + to[1] * u[1] + to[2] * u[2] };
  });
  for (const body of seen) {
    expect([shot.name, body.depth > 0.5]).toEqual([shot.name, true]);
    expect([shot.name, Math.abs(body.across) < 0.92 * body.depth * half * (16 / 9) && Math.abs(body.up) < 0.92 * body.depth * half]).toEqual([shot.name, true]);
  }
  for (let a = 0; a < seen.length; a += 1) {
    for (let b = a + 1; b < seen.length; b += 1) {
      const [one, other] = [seen[a]!, seen[b]!];
      const near = Math.min(one.depth, other.depth);
      // Where each stands in the picture, as metres at the nearer one's distance.
      const apart = Math.hypot((one.across / one.depth - other.across / other.depth) * near, (one.up / one.depth - other.up / other.depth) * near);
      expect([shot.name, a, b, apart > 0.85]).toEqual([shot.name, a, b, true]);
    }
  }
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
        // A shot of the fields is taken where there is no bore: it has the avenue to keep to instead (below).
        if (SHOT_TABLE[shot]?.subject === "field") continue;
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

  it("cuts on every second bar when Cuts is on: walking, through the nine shots of the robot, never from a close one to a close one", () => {
    const order: number[] = [];
    for (let bar = 0; bar < 2 * WALKING_ORDER.length; bar += 1) {
      const out = rig({ value: 0, shot: 0, cuts: 1, bar, swim: 0 }, 0);
      // The pick is the pair of bars it falls in: bars 0 and 1 share a shot, bar 2 is the next.
      expect(out["pick"]).toBe(shotAtTurn(Math.floor(bar / 2)));
      if (bar % 2 === 0) order.push(out["pick"] as number);
    }
    expect(order).toEqual([...WALKING_ORDER]);
    expect(new Set(order).size).toBe(9);
    // Every one is a shot of the robot: the tail's are for when it swims, the pack's for when there is one.
    expect(order.every((pick) => (SHOT_TABLE[pick] as (typeof SHOT_TABLE)[number]).subject === "robot")).toBe(true);
    // A close shot is one that rides with the robot (it would lose it otherwise). Round the whole cycle, wrap included.
    const close = order.map((pick) => (SHOT_TABLE[pick] as (typeof SHOT_TABLE)[number]).ride >= 0.6);
    expect(close.filter(Boolean).length).toBe(4);
    for (let index = 0; index < close.length; index += 1) expect(close[index] === true && close[(index + 1) % close.length] === true).toBe(false);
  });

  it("swimming, cuts through every shot of the tail, and cuts the moment it lets go of the wall", () => {
    const order: number[] = [];
    for (let bar = 0; bar < 2 * SWIMMING_ORDER.length; bar += 2) order.push(rig({ value: 0, shot: 0, cuts: 1, bar, swim: 1 }, 0)["pick"] as number);
    expect(order).toEqual([...SWIMMING_ORDER]);
    const tails = SHOT_TABLE.map((shot, at) => ({ shot, at })).filter(({ shot }) => shot.subject === "tail");
    expect(tails.length).toBe(6);
    for (const { at } of tails) expect(order).toContain(at);
    // The same bar, walking and swimming, is two different shots: letting go is a cut, and to the tail.
    const walking = rig({ value: 0, shot: 0, cuts: 1, bar: 0, swim: 0.4 }, 0)["pick"] as number;
    const swimming = rig({ value: 0, shot: 0, cuts: 1, bar: 0, swim: 0.6 }, 0)["pick"] as number;
    expect([SHOT_TABLE[walking]?.name, SHOT_TABLE[swimming]?.name]).toEqual(["chase", "tail"]);
    // With Cuts off the slider holds any of them, whatever it is doing.
    expect(rig({ value: 0, shot: 12, cuts: 0, bar: 7, swim: 1 }, 0)["pick"]).toBe(12);
  });

  it("with more than one of the pack out, cuts through the four shots of the pack, each placed to hold all three apart in its frame", () => {
    const order: number[] = [];
    for (let bar = 0; bar < 2 * PACK_ORDER.length; bar += 2) order.push(rig({ value: 0, shot: 0, cuts: 1, bar, swim: 1, pack: 3 }, 0)["pick"] as number);
    expect(order).toEqual([...PACK_ORDER]);
    const ofThePack = SHOT_TABLE.map((shot, at) => ({ shot, at })).filter(({ shot }) => shot.subject === "pack");
    expect(ofThePack.map(({ shot }) => shot.name)).toEqual(["packfront", "packquarter", "packrear", "packunder"]);
    for (const { at } of ofThePack) expect(order).toContain(at);
    // One robot out: the pack's shots are not in the cut at all, swimming or walking.
    for (let bar = 0; bar < 40; bar += 2) for (const swim of [0, 1]) expect(SHOT_TABLE[rig({ value: 0, shot: 0, cuts: 1, bar, swim, pack: 1 }, 0)["pick"] as number]?.subject).not.toBe("pack");
    // The formation the pack flies in (document.ts, PACK), seen through each of its shots.
    for (const { shot, at } of ofThePack) expectAllSeenApart(shot, rig({ value: 0, shot: at, cuts: 0, pack: 3 }, 0), PACK);
  });

  it("in the fields, cuts through the place's own four shots between the tails and the long chase; each keeps inside the avenue and holds all three", () => {
    const order: number[] = [];
    for (let bar = 0; bar < 2 * FIELD_ORDER.length; bar += 2) order.push(rig({ value: 0, shot: 0, cuts: 1, bar, swim: 1, pack: 3, place: 1 }, 0)["pick"] as number);
    expect(order).toEqual([...FIELD_ORDER]);
    for (const [turn, pick] of order.entries()) expect(pick).toBe(shotAtTurn(turn, true, true, true));
    const ofTheFields = SHOT_TABLE.map((shot, at) => ({ shot, at })).filter(({ shot }) => shot.subject === "field");
    expect(ofTheFields.map(({ shot }) => shot.name)).toEqual(["fieldwide", "fieldside", "fieldlow", "fieldhigh"]);
    for (const { at } of ofTheFields) expect(order).toContain(at);
    // Never two of the place's wide shots running: between any two, a shot of the robots.
    for (let turn = 0; turn < order.length; turn += 1) {
      const [here, next] = [SHOT_TABLE[order[turn] as number], SHOT_TABLE[order[(turn + 1) % order.length] as number]];
      expect(here?.subject === "field" && next?.subject === "field").toBe(false);
    }
    // In the tunnel none of them is ever in the cut, however it is going.
    for (let bar = 0; bar < 40; bar += 2) for (const swim of [0, 1]) for (const pack of [1, 3]) expect(SHOT_TABLE[rig({ value: 0, shot: 0, cuts: 1, bar, swim, pack, place: 0 }, 0)["pick"] as number]?.subject).not.toBe("field");
    // Out there the pack flies wider apart, below the line as well as above it (rig.ts, FIELD_BERTH).
    const wider = 1 + CHAMBERS.swell * FIELD_BERTH;
    const afield = PACK.map((body) => [body[0] * wider, body[1] * wider, body[2]] as const);
    for (const { shot, at } of ofTheFields) {
      for (let seconds = 0; seconds < 60; seconds += 1.7) {
        const out = rig({ value: seconds * 3.2, shot: at, cuts: 0, pack: 3, place: 1 }, seconds);
        // No tower's trunk comes within a metre of the avenue's edge (field.gpu.test.ts): the lens keeps another metre inside that.
        expect([shot.name, Math.abs(out["right"] as number) < FIELD.avenue - 2]).toEqual([shot.name, true]);
        // …and within the heights that test looks at.
        expect([shot.name, Math.abs(out["up"] as number) < 30]).toEqual([shot.name, true]);
        expectAllSeenApart(shot, out, afield);
      }
    }
  });

  it("looks where the shot says: past the robot down the tunnel, at the robot, at its tail, or at the pack", () => {
    for (const [index, shot] of SHOT_TABLE.entries()) {
      const out = rig({ value: 10, shot: index, cuts: 0, distance: 7.5 }, 3);
      expect([shot.name, out["aim"], out["ride"], out["lens"]]).toEqual([shot.name, shot.aim, shot.ride, shot.lens]);
      const ahead = out["ahead"] as number;
      if (shot.subject === "tail") {
        // Behind the robot's middle, looking at a point no further forward than that middle, from close
        // (the furthest is the long lens, 4.3 m off what it looks at), and riding with the robot.
        expect(ahead).toBeLessThan(-1.2);
        expect(shot.aim).toBeLessThanOrEqual(0);
        expect(Math.hypot(ahead - shot.aim, out["right"] as number, out["up"] as number)).toBeLessThan(4.5);
        expect(shot.ride).toBe(1);
      } else if (shot.subject === "pack" || shot.subject === "field") {
        // At the middle of the echelon, which is some five metres behind the leader.
        expect(shot.aim).toBeLessThan(-1);
        expect(shot.aim).toBeGreaterThan(-8);
      } else if (ahead < -1) {
        // Behind the robot and not a tail shot: it looks past it, down the tunnel.
        expect(shot.aim).toBeGreaterThan(3);
      } else {
        expect(shot.aim).toBeLessThan(1);
      }
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
